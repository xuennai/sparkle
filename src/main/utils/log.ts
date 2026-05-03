import { BrowserWindow } from 'electron'
import { createWriteStream, type WriteStream } from 'fs'
import { readFile, stat, writeFile } from 'fs/promises'
import { Writable } from 'stream'
import { getAppConfig } from '../config/app'
import { appLogPath, coreLogPath, substoreLogPath } from './dirs'

type LogTarget = 'app' | 'core' | 'substore'
type MihomoLogSource = 'out' | 'ws'
type LogContent = string | Buffer
interface CachedControllerLog extends ControllerLog {
  seq: number
}

/** Structured app log entry (written as logfmt to file) */
export interface AppLogEntry {
  timestamp: string
  level: 'info' | 'warn' | 'error' | 'debug'
  module: string
  message: string
  data?: Record<string, unknown>
  error?: string
  stack?: string
}

const streamMap = new Map<LogTarget, { path: string; stream: WriteStream }>()
const consumerCount = new Map<LogTarget, number>()
const writeQueue: Record<LogTarget, Promise<void>> = {
  app: Promise.resolve(),
  core: Promise.resolve(),
  substore: Promise.resolve()
}
const cachedLogs: CachedControllerLog[] = []
const cachedLogLimit = 2000
const logFileSizeMap = new Map<LogTarget, { path: string; size: number | null }>()
let nextLogSeq = 0
let mihomoLogSource: MihomoLogSource = 'out'
const logfmtFieldPattern = /([A-Za-z0-9_.-]+)=("(?:\\.|[^"\\])*"|[^\s]+)/g
const logStreamHighWaterMark = 256 * 1024
const logTrimLowWatermarkRatio = 0.7

function resolveLogPath(target: LogTarget): string {
  switch (target) {
    case 'app':
      return appLogPath()
    case 'core':
      return coreLogPath()
    case 'substore':
      return substoreLogPath()
    default: {
      const exhaustiveTarget: never = target
      throw new Error(`Unsupported log target: ${exhaustiveTarget}`)
    }
  }
}

async function shouldSaveLogs(): Promise<boolean> {
  const { saveLogs = true } = await getAppConfig()
  return saveLogs
}

async function getMaxLogFileSizeBytes(): Promise<number> {
  const { maxLogFileSizeMB = 20 } = await getAppConfig()
  return Math.max(1, Math.floor(maxLogFileSizeMB) || 1) * 1024 * 1024
}

function getWriteStream(target: LogTarget): WriteStream {
  const nextPath = resolveLogPath(target)
  const current = streamMap.get(target)
  const sizeState = logFileSizeMap.get(target)

  if (!sizeState || sizeState.path !== nextPath) {
    logFileSizeMap.set(target, { path: nextPath, size: null })
  }

  if (current && current.path === nextPath) {
    return current.stream
  }

  if (current) {
    streamMap.delete(target)
    current.stream.end()
  }

  const stream = createWriteStream(nextPath, { flags: 'a', highWaterMark: logStreamHighWaterMark })
  streamMap.set(target, { path: nextPath, stream })
  return stream
}

async function closeWriteStream(target: LogTarget): Promise<void> {
  const current = streamMap.get(target)
  if (!current) return

  streamMap.delete(target)
  const { stream } = current

  if (stream.closed || stream.destroyed) return

  await new Promise<void>((resolve) => {
    const cleanup = (): void => {
      stream.removeListener('close', onClose)
      stream.removeListener('error', onError)
      resolve()
    }

    const onClose = (): void => {
      cleanup()
    }

    const onError = (): void => {
      cleanup()
    }

    stream.once('close', onClose)
    stream.once('error', onError)
    stream.end()
  })
}

function retainTarget(target: LogTarget): void {
  consumerCount.set(target, (consumerCount.get(target) || 0) + 1)
}

function releaseTarget(target: LogTarget): void {
  const nextCount = (consumerCount.get(target) || 1) - 1
  if (nextCount > 0) {
    consumerCount.set(target, nextCount)
    return
  }

  consumerCount.delete(target)
  void closeWriteStream(target)
}

function trimCachedLogs(): void {
  if (cachedLogs.length <= cachedLogLimit) return
  cachedLogs.splice(0, cachedLogs.length - cachedLogLimit)
}

function isEmptyLogContent(content: LogContent): boolean {
  return typeof content === 'string' ? content.length === 0 : content.byteLength === 0
}

function getLogContentSize(content: LogContent): number {
  return typeof content === 'string' ? Buffer.byteLength(content, 'utf-8') : content.byteLength
}

function normalizeLogContent(content: string): string[] {
  return content
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter((line) => line.trim().length > 0)
}

function parseFileLines(content: string): { lines: string[]; hasTrailingNewline: boolean } {
  const normalized = content.replace(/\r\n/g, '\n')
  const hasTrailingNewline = normalized.endsWith('\n')
  const lines = normalized.split('\n')

  if (hasTrailingNewline) {
    lines.pop()
  }

  return {
    lines,
    hasTrailingNewline
  }
}

async function getLogFileSize(target: LogTarget, path: string): Promise<number> {
  const state = logFileSizeMap.get(target)
  if (state?.path === path && state.size !== null) {
    return state.size
  }

  try {
    const fileStat = await stat(path)
    logFileSizeMap.set(target, { path, size: fileStat.size })
    return fileStat.size
  } catch {
    logFileSizeMap.set(target, { path, size: 0 })
    return 0
  }
}

async function trimLogFileToSize(
  target: LogTarget,
  path: string,
  targetBytes: number
): Promise<void> {
  await closeWriteStream(target)
  const content = await readFile(path, 'utf-8').catch(() => '')
  const { lines, hasTrailingNewline } = parseFileLines(content)
  const normalizedContent = content.replace(/\r\n/g, '\n')
  let currentSize = Buffer.byteLength(normalizedContent, 'utf-8')

  if (currentSize <= targetBytes) {
    logFileSizeMap.set(target, { path, size: currentSize })
    return
  }

  let startIndex = 0
  while (startIndex < lines.length && currentSize > targetBytes) {
    currentSize -= Buffer.byteLength(lines[startIndex], 'utf-8')
    if (startIndex < lines.length - 1 || hasTrailingNewline) {
      currentSize -= 1
    }
    startIndex++
  }

  const trimmedLines = lines.slice(startIndex)
  const trimmedContent =
    trimmedLines.join('\n') + (trimmedLines.length > 0 && hasTrailingNewline ? '\n' : '')

  await writeFile(path, trimmedContent, 'utf-8')
  logFileSizeMap.set(target, { path, size: Buffer.byteLength(trimmedContent, 'utf-8') })
}

async function enforceLogFileSizeLimit(
  target: LogTarget,
  path: string,
  appendedBytes: number,
  maxBytes: number
): Promise<void> {
  const nextSize = (await getLogFileSize(target, path)) + appendedBytes
  logFileSizeMap.set(target, { path, size: nextSize })

  if (nextSize <= maxBytes) return

  const trimTargetBytes = Math.max(1, Math.floor(maxBytes * logTrimLowWatermarkRatio))
  await trimLogFileToSize(target, path, trimTargetBytes)
}

function unquoteLogfmtValue(value: string): string {
  if (!(value.startsWith('"') && value.endsWith('"'))) return value

  return value
    .slice(1, -1)
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\')
}

function parseLogfmtLine(line: string): Record<string, string> {
  const fields: Record<string, string> = {}

  for (const match of line.matchAll(logfmtFieldPattern)) {
    const [, key, rawValue] = match
    fields[key] = unquoteLogfmtValue(rawValue)
  }

  return fields
}

function normalizeOutLogTime(value?: string): string | undefined {
  if (!value) return undefined

  const normalizedValue = value.replace(/(\.\d{3})\d+([+-]\d{2}:\d{2}|Z)$/, '$1$2')
  const parsedTime = new Date(normalizedValue)

  if (Number.isNaN(parsedTime.getTime())) {
    return undefined
  }

  return parsedTime.toLocaleString()
}

function normalizeOutLogLevel(level: string | undefined, fallbackType: LogLevel): LogLevel {
  switch (level) {
    case 'error':
      return 'error'
    case 'warn':
    case 'warning':
      return 'warning'
    case 'info':
      return 'info'
    case 'debug':
      return 'debug'
    default:
      return fallbackType
  }
}

function createControllerLogFromOutLine(line: string, fallbackType: LogLevel): ControllerLog {
  const fields = parseLogfmtLine(line)
  const hasStructuredFields = Boolean(fields.time || fields.level || fields.msg)

  if (!hasStructuredFields) {
    return {
      type: fallbackType,
      payload: line
    }
  }

  return {
    type: normalizeOutLogLevel(fields.level, fallbackType),
    payload: fields.msg?.trim() || line,
    time: normalizeOutLogTime(fields.time)
  }
}

function pushCachedLog(log: ControllerLog): CachedControllerLog {
  const entry: CachedControllerLog = {
    ...log,
    time: log.time || new Date().toLocaleString(),
    seq: ++nextLogSeq
  }
  cachedLogs.push(entry)
  trimCachedLogs()
  return entry
}

function broadcastLog(log: CachedControllerLog): void {
  BrowserWindow.getAllWindows().forEach((window) => {
    if (!window.isDestroyed()) {
      window.webContents.send('mihomoLogs', log)
    }
  })
}

function cacheAndBroadcastLog(log: ControllerLog): void {
  broadcastLog(pushCachedLog(log))
}

function publishTargetLogLines(content: string, type: LogLevel): void {
  normalizeLogContent(content).forEach((line) => {
    cacheAndBroadcastLog(createControllerLogFromOutLine(line, type))
  })
}

function flushCoreLogLines(lineBuffer: string, content: string, type: LogLevel): string {
  const normalized = `${lineBuffer}${content}`.replace(/\r\n/g, '\n')
  const lines = normalized.split('\n')
  const nextLineBuffer = lines.pop() || ''
  publishTargetLogLines(lines.join('\n'), type)
  return nextLineBuffer
}

function normalizeWriteChunk(chunk: string | Buffer): Buffer {
  return Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf-8')
}

async function appendLog(target: LogTarget, content: LogContent): Promise<void> {
  if (isEmptyLogContent(content) || !(await shouldSaveLogs())) return

  const path = resolveLogPath(target)
  const maxLogFileSizeBytes = await getMaxLogFileSizeBytes()
  const contentSize = getLogContentSize(content)
  const currentQueue = writeQueue[target].catch(() => { })
  writeQueue[target] = (async () => {
    await currentQueue
    try {
      await new Promise<void>((resolve, reject) => {
        const stream = getWriteStream(target)
        stream.write(content, (error) => {
          if (error) {
            reject(error)
          } else {
            resolve()
          }
        })
      })
      await enforceLogFileSizeLimit(target, path, contentSize, maxLogFileSizeBytes)
    } catch (error) {
      await closeWriteStream(target)
      throw error
    }
  })()

  await writeQueue[target]
}

export function setMihomoLogSource(source: MihomoLogSource): void {
  mihomoLogSource = source
}

// Regex to match old-style log prefixes like [Module], [startCore:abc123], [STATE:1]
const oldStyleLogPattern = /^\[([^\]]+)\]:?\s*(.*)$/s

// Emoji removal regex
const emojiPattern =
  /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{200D}\u{20E3}\u{231A}\u{231B}\u{23E9}-\u{23F3}\u{23F8}-\u{23FA}\u{25AA}\u{25AB}\u{25B6}\u{25C0}\u{25FB}-\u{25FE}]/gu

function stripEmojis(text: string): string {
  return text.replace(emojiPattern, '').trim()
}

function parseLogLevelFromMessage(message: string): 'info' | 'warn' | 'error' | 'debug' {
  const lower = message.toLowerCase()
  if (lower.includes('fail') || lower.includes('error') || lower.includes('timeout')) return 'error'
  if (lower.includes('warn')) return 'warn'
  if (lower.includes('debug')) return 'debug'
  return 'info'
}

/**
 * Format a log entry as logfmt string.
 * logfmt is a standard, human-readable log format:
 *   ts=2026-05-03T03:48:47.138Z lvl=info mod=startCore msg="ENTER - detached=false" reqId=abc123
 *
 * Values containing spaces are quoted; special chars in values are escaped.
 */
function formatLogfmt(entry: AppLogEntry): string {
  const escapeValue = (v: string): string => {
    if (/[\s"=]/.test(v)) {
      return '"' + v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n') + '"'
    }
    return v
  }

  const parts: string[] = [
    `ts=${entry.timestamp}`,
    `lvl=${entry.level}`,
    `mod=${escapeValue(entry.module)}`,
    `msg=${escapeValue(entry.message)}`
  ]

  if (entry.data) {
    for (const [key, value] of Object.entries(entry.data)) {
      const strVal = typeof value === 'object' ? JSON.stringify(value) : String(value)
      parts.push(`${key}=${escapeValue(strVal)}`)
    }
  }

  if (entry.error) {
    parts.push(`error=${escapeValue(entry.error)}`)
  }
  if (entry.stack) {
    parts.push(`stack=${escapeValue(entry.stack)}`)
  }

  return parts.join(' ') + '\n'
}

/**
 * Convert an old-style text log line to a logfmt AppLogEntry.
 * Old format: `[Module]: message here\n`
 * New format: logfmt string with ts, lvl, mod, msg fields
 */
function convertToLogfmt(content: string): string {
  const trimmed = content.replace(/\n$/, '').replace(/\r$/, '')
  const match = trimmed.match(oldStyleLogPattern)

  if (match) {
    const rawModule = match[1].trim()
    const rawMessage = match[2].trim()

    // Extract reqId if present (e.g., "startCore:abc123")
    // reqId is a 7-char alphanumeric string from Math.random().toString(36).substring(7)
    let module = rawModule
    let reqId: string | undefined
    const reqIdMatch = rawModule.match(/^(\w+):([a-z0-9]{7})$/)
    if (reqIdMatch) {
      module = reqIdMatch[1]
      reqId = reqIdMatch[2]
    }

    const cleanMessage = stripEmojis(rawMessage)
    const level = parseLogLevelFromMessage(cleanMessage)

    const entry: AppLogEntry = {
      timestamp: new Date().toISOString(),
      level,
      module,
      message: cleanMessage
    }

    if (reqId) {
      entry.data = { reqId }
    }

    return formatLogfmt(entry)
  }

  // Fallback: wrap as-is with info level
  const entry: AppLogEntry = {
    timestamp: new Date().toISOString(),
    level: 'info',
    module: 'App',
    message: stripEmojis(trimmed)
  }
  return formatLogfmt(entry)
}

export async function appendAppLog(content: string): Promise<void> {
  const logfmtContent = convertToLogfmt(content)
  await appendLog('app', logfmtContent)
}

/**
 * Write a structured log entry to the app log file in logfmt format.
 * logfmt is a standard, human-readable format:
 *   ts=2026-05-03T03:48:47.138Z lvl=info mod=Main msg="System suspend signal received"
 *
 * @param entry - The structured log entry
 */
export async function appendAppLogJson(entry: AppLogEntry): Promise<void> {
  const line = formatLogfmt(entry)
  await appendLog('app', line)
}

export function publishMihomoLog(log: ControllerLog): void {
  if (mihomoLogSource !== 'ws') return
  cacheAndBroadcastLog(log)
}

export function getCachedMihomoLogs(): CachedControllerLog[] {
  return [...cachedLogs]
}

export function clearCachedMihomoLogs(): void {
  cachedLogs.length = 0
}

export function createLogWritable(target: LogTarget, type: LogLevel = 'info'): Writable {
  retainTarget(target)

  let lineBuffer = ''
  let released = false
  const release = (): void => {
    if (released) return
    released = true
    releaseTarget(target)
  }

  return new Writable({
    write(chunk, _encoding, callback) {
      const content = normalizeWriteChunk(chunk)
      if (target === 'core' && mihomoLogSource === 'out') {
        lineBuffer = flushCoreLogLines(lineBuffer, content.toString('utf-8'), type)
      }
      void appendLog(target, content).then(
        () => callback(),
        (error) => callback(error as Error)
      )
    },
    writev(chunks, callback) {
      const content =
        chunks.length === 1
          ? normalizeWriteChunk(chunks[0].chunk as string | Buffer)
          : Buffer.concat(chunks.map(({ chunk }) => normalizeWriteChunk(chunk as string | Buffer)))
      if (target === 'core' && mihomoLogSource === 'out') {
        lineBuffer = flushCoreLogLines(lineBuffer, content.toString('utf-8'), type)
      }
      void appendLog(target, content).then(
        () => callback(),
        (error) => callback(error as Error)
      )
    },
    final(callback) {
      if (target === 'core' && mihomoLogSource === 'out' && lineBuffer.trim()) {
        publishTargetLogLines(lineBuffer.trim(), type)
      }
      lineBuffer = ''
      release()
      callback()
    },
    destroy(error, callback) {
      if (target === 'core' && mihomoLogSource === 'out' && lineBuffer.trim()) {
        publishTargetLogLines(lineBuffer.trim(), type)
      }
      lineBuffer = ''
      release()
      callback(error)
    }
  })
}
