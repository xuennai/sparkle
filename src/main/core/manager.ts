import { ChildProcess, spawn } from 'child_process'
import { dataDir, coreLogPath, mihomoCorePath } from '../utils/dirs'
import { generateProfile, getRuntimeConfig } from './factory'
import {
  getAppConfig,
  getControledMihomoConfig,
  getProfileConfig,
  patchAppConfig,
  patchControledMihomoConfig
} from '../config'
import { app, dialog, ipcMain } from 'electron'
import {
  startMihomoTraffic,
  startMihomoConnections,
  startMihomoLogs,
  startMihomoMemory,
  stopMihomoConnections,
  stopMihomoTraffic,
  stopMihomoLogs,
  stopMihomoMemory,
  patchMihomoConfig,
  mihomoGroups
} from './mihomoApi'
import { readFile, rm, writeFile } from 'fs/promises'
import { mainWindow } from '..'
import path from 'path'
import os from 'os'
import { existsSync } from 'fs'
import { uploadRuntimeConfig } from '../resolve/gistApi'
import { startMonitor } from '../resolve/trafficMonitor'
import { floatingWindow } from '../resolve/floatingWindow'
import { getAxios } from './mihomoApi'
import {
  getCoreStatus,
  startCore as startServiceCore,
  stopCore as stopServiceCore,
  startServiceCoreEventStream,
  stopServiceCoreEventStream,
  subscribeServiceCoreEvents,
  subscribeServiceCoreEventStream,
  type ServiceCoreEvent,
  type ServiceCoreLaunchProfile
} from '../service/api'
import { appendAppLog, createLogWritable, setMihomoLogSource } from '../utils/log'
import { createCoreHookWaiter, createCoreStartupHook } from './startupHook'
import { stopChildProcess } from './process-control'
import {
  recoverDNS,
  setPublicDNS,
  startNetworkDetection as startNetworkDetectionWithCore,
  stopNetworkDetection as stopNetworkDetectionController
} from './network'
import { checkProfile } from './profile-check'
import {
  createCoreEnvironment,
  createCoreSpawnArgs,
  createProviderInitializationTracker,
  isControllerListenError,
  isControllerReadyLog,
  isTunPermissionError,
  isUpdaterFinishedLog
} from './startup-chain'
export {
  checkCorePermission,
  checkCorePermissionSync,
  manualGrantCorePermition,
  revokeCorePermission
} from './permission'
export { getDefaultDevice } from './network'

const ctlParam = process.platform === 'win32' ? '-ext-ctl-pipe' : '-ext-ctl-unix'

let child: ChildProcess
let retry = 10
let serviceCoreStreamsRestartTimer: NodeJS.Timeout | null = null
let unsubscribeServiceCoreEvents: (() => void) | null = null
let unsubscribeServiceCoreEventStream: (() => void) | null = null
let serviceCoreStreamsActive = false
let serviceCoreStreamsStarting: Promise<void> | null = null
let lastServiceCoreEventKey = ''
let serviceCoreStartupActive = false
let serviceCoreReconnectResumePromise: Promise<void> | null = null
const serviceConnectionRetryTimeout = 10000
const serviceConnectionRetryInterval = 500

// ===== Core State Machine =====
// Tracks the lifecycle state of the core to prevent concurrent operations
type CoreState = 'IDLE' | 'STOPPING' | 'STARTING' | 'RUNNING' | 'FAILED'
let coreState: CoreState = 'IDLE'
let coreStateChangeSeq = 0

function logCoreStateTransition(newState: CoreState): void {
  const seq = ++coreStateChangeSeq
  const oldState = coreState
  coreState = newState
  const stackLine = new Error().stack?.split('\n')[3]?.trim() || 'unknown'
  appendAppLog(`[STATE:${seq}] 🟢 ${oldState} -> 🔴 ${newState} | Triggered by: ${stackLine}\n`).catch(() => {})
}

// Mutex for restartCore to prevent concurrent restart attempts
let isRestarting = false

// Mutex for startCore to prevent concurrent start attempts
let isStarting = false

// Global timeout for startCore
// Increased to accommodate service-mode core startup which may take longer
// (e.g., POST /core/start has a per-request timeout of 60s)
const START_CORE_GLOBAL_TIMEOUT = 65000

type ServiceCoreConnectionProbe = {
  reachable: boolean
  running: boolean
  error: unknown
}

async function startMihomoApiStreams(): Promise<void> {
  await appendAppLog(`[Manager]: Starting Mihomo API streams (traffic, connections, logs, memory)\n`)
  await startMihomoTraffic()
  await startMihomoConnections()
  await startMihomoLogs()
  await startMihomoMemory()
  retry = 10
  await appendAppLog(`[Manager]: Mihomo API streams started\n`)
}

async function completeCoreInitialization(logLevel?: LogLevel): Promise<void> {
  const tasks: Promise<unknown>[] = [
    new Promise<void>((resolve) => setTimeout(resolve, 100)).then(() => {
      mainWindow?.webContents.send('groupsUpdated')
      mainWindow?.webContents.send('rulesUpdated')
    }),
    uploadRuntimeConfig()
  ]

  if (logLevel) {
    tasks.push(
      new Promise<void>((resolve) => setTimeout(resolve, 100)).then(() =>
        patchMihomoConfig({ 'log-level': logLevel })
      )
    )
  }

  await Promise.all(tasks)
  setMihomoLogSource('ws')
}

async function waitForMihomoReady(): Promise<void> {
  // Total wait time: 300 retries × 200ms = 60 seconds
  // This needs to be generous because:
  //   - Remote proxy providers can take 20-30s to fetch
  //   - During provider fetch, mihomo controller returns "核心控制器未初始化"
  //   - TUN adapter creation can also add delay (retry 1/3)
  const maxRetries = 300
  const retryInterval = 200
  const startedAt = Date.now()

  for (let i = 0; i < maxRetries; i++) {
    try {
      await mihomoGroups()
      const elapsed = Date.now() - startedAt
      if (i > 0) {
        await appendAppLog(`[Manager]: waitForMihomoReady succeeded after ${i} retries, elapsed: ${elapsed}ms\n`)
      }
      break
    } catch {
      await new Promise((resolve) => setTimeout(resolve, retryInterval))
    }
  }

  if (Date.now() - startedAt >= maxRetries * retryInterval) {
    await appendAppLog(`[Manager]: waitForMihomoReady timed out after ${maxRetries} retries\n`)
  }
}

async function waitForServiceCoreConnection(
  initialError: unknown
): Promise<ServiceCoreConnectionProbe> {
  const initialErrorStr = initialError instanceof Error ? `${initialError.message}\n${initialError.stack}` : String(initialError)
  await appendAppLog(
    `[Manager]: Service connection failed, waiting before fallback, error: ${initialErrorStr}\n`
  )
  const startedAt = Date.now()
  let lastError = initialError

  while (Date.now() - startedAt < serviceConnectionRetryTimeout) {
    await new Promise((resolve) => setTimeout(resolve, serviceConnectionRetryInterval))

    try {
      await getCoreStatus()
      const elapsed = Date.now() - startedAt
      await appendAppLog(`[Manager]: Service became reachable after ${elapsed}ms\n`)
      return { reachable: true, running: true, error: lastError }
    } catch (error) {
      lastError = error
      if (!isServiceConnectionError(error)) {
        const errorStr = error instanceof Error ? `${error.message}\n${error.stack}` : String(error)
        await appendAppLog(`[Manager]: Service probe got non-connection error: ${errorStr}\n`)
        // Non-connection error (e.g., "核心未运行") means service IS reachable
        // but core is not running yet. This is NOT a failure - proceed to start core.
        return { reachable: true, running: false, error }
      }
    }
  }

  const lastErrorStr = lastError instanceof Error ? `${lastError.message}\n${lastError.stack}` : String(lastError)
  await appendAppLog(
    `[Manager]: Service still unavailable after ${serviceConnectionRetryTimeout}ms, last error: ${lastErrorStr}\n`
  )
  return { reachable: false, running: false, error: lastError }
}

export async function startCore(detached = false): Promise<Promise<void>[]> {
  const reqId = Math.random().toString(36).substring(7)
  await appendAppLog(`[⚙️ startCore:${reqId}] ENTER - detached=${detached}, currentState=${coreState}\n`)

  // Mutex: prevent concurrent startCore attempts (except detached mode)
  if (!detached) {
    if (isStarting) {
      await appendAppLog(`[⚙️ startCore:${reqId}] BLOCKED - startCore already in progress, waiting...\n`)
      // Wait for the current start to finish, then return empty (caller should re-check)
      while (isStarting) {
        await new Promise(r => setTimeout(r, 100))
      }
      await appendAppLog(`[⚙️ startCore:${reqId}] BLOCKED - previous startCore completed, returning empty\n`)
      return []
    }
    isStarting = true
  }

  // State machine: reject if we're in a stopping state
  if (!detached && (coreState === 'STOPPING' || coreState === 'STARTING')) {
    isStarting = false
    throw new Error(`内核状态异常：当前状态为 ${coreState}，无法启动`)
  }

  logCoreStateTransition('STARTING')
  const startCoreStartedAt = Date.now()

  try {
    return await startCoreImpl(detached, reqId, startCoreStartedAt)
  } catch (error) {
    logCoreStateTransition('FAILED')
    throw error
  } finally {
    if (!detached) {
      isStarting = false
    }
    await appendAppLog(`[⚙️ startCore:${reqId}] EXIT - state=${coreState}, elapsed=${Date.now() - startCoreStartedAt}ms\n`)
  }
}

/**
 * Inner implementation of startCore. Called by startCore() which handles
 * the mutex (isStarting) and state transitions.
 * IMPORTANT: Do NOT call startCore() recursively from within this function,
 * as it would deadlock on isStarting. Use startCoreImpl directly for recursion.
 */
async function startCoreImpl(
  detached: boolean,
  reqId: string,
  startCoreStartedAt: number
): Promise<Promise<void>[]> {
  // Global timeout guard for startCore (not applied to detached mode)
  let globalTimeout: NodeJS.Timeout | null = null
  const globalTimeoutPromise = !detached
    ? new Promise<never>((_, reject) => {
        globalTimeout = setTimeout(() => {
          const elapsed = Date.now() - startCoreStartedAt
          reject(new Error(`内核启动超时 (${elapsed}ms)，已超过 ${START_CORE_GLOBAL_TIMEOUT}ms 限制`))
        }, START_CORE_GLOBAL_TIMEOUT)
      })
    : null

  const {
    core = 'mihomo',
    corePermissionMode = 'elevated',
    coreStartupMode = 'post-up',
    autoSetDNSMode = 'none',
    diffWorkDir = false,
    mihomoCpuPriority = 'PRIORITY_NORMAL',
    saveLogs = true,
    maxLogFileSizeMB = 20,
    disableLoopbackDetector = false,
    disableEmbedCA = false,
    disableSystemCA = false,
    disableNftables = false,
    safePaths = []
  } = await getAppConfig()
  await appendAppLog(`[Manager]: Config: corePermissionMode=${corePermissionMode}, coreStartupMode=${coreStartupMode}, core=${core}, diffWorkDir=${diffWorkDir}\n`)

  const controlledMihomoConfig = await getControledMihomoConfig()
  const { 'log-level': logLevel, tun } = controlledMihomoConfig
  const { current } = await getProfileConfig()
  const useServiceCore = corePermissionMode === 'service' && !detached
  await appendAppLog(`[Manager]: useServiceCore=${useServiceCore}, current=${current}\n`)

  let corePath: string
  try {
    corePath = mihomoCorePath(core)
    await appendAppLog(`[Manager]: corePath=${corePath}\n`)
  } catch (error) {
    if (core === 'system') {
      await patchAppConfig({ core: 'mihomo' })
      // Use startCoreImpl directly to avoid deadlock on isStarting mutex
      return startCoreImpl(detached, reqId, startCoreStartedAt)
    }
    throw error
  }

  const tGen = Date.now()
  await appendAppLog(`[Manager]: Generating profile...\n`)
  await generateProfile()
  await appendAppLog(`[Manager]: Profile generated, elapsed: ${Date.now() - tGen}ms\n`)

  const tCheck = Date.now()
  await appendAppLog(`[Manager]: Checking profile...\n`)
  try {
    await checkProfile()
    await appendAppLog(`[Manager]: Profile check passed, elapsed: ${Date.now() - tCheck}ms\n`)
  } catch (error) {
    const errorStr = error instanceof Error ? `${error.message}\n${error.stack}` : String(error)
    await appendAppLog(`[Manager]: Profile check FAILED, elapsed: ${Date.now() - tCheck}ms, error: ${errorStr}\n`)
    throw error
  }

  let serviceCoreRunning = false
  if (useServiceCore) {
    await appendAppLog(`[Manager]: Checking service core status...\n`)
    const tStatus = Date.now()
    try {
      await getCoreStatus()
      serviceCoreRunning = true
      await appendAppLog(`[Manager]: Service core is already running, elapsed: ${Date.now() - tStatus}ms\n`)
    } catch (error) {
      const errorStr = error instanceof Error ? `${error.message}\n${error.stack}` : String(error)
      await appendAppLog(`[Manager]: Service core status check failed, elapsed: ${Date.now() - tStatus}ms, error: ${errorStr}\n`)
      if (isServiceConnectionError(error)) {
        const probe = await waitForServiceCoreConnection(error)
        if (!probe.reachable) {
          return fallbackToElevatedCore(detached, probe.error)
        }
        serviceCoreRunning = probe.running
      } else {
        // Non-connection error (e.g., "进程未运行", "核心未运行") means service IS reachable
        // but core is not running yet. This is NOT a failure - proceed to start core.
        await appendAppLog(`[Manager]: Service core is reachable but not running, will start core\n`)
        serviceCoreRunning = false
      }
    }
  }
  if (!serviceCoreRunning) {
    await appendAppLog(`[Manager]: Service core not running, calling stopCore() first\n`)
    await stopCore()
  }
  setMihomoLogSource('out')
  if (tun?.enable && autoSetDNSMode !== 'none') {
    try {
      await setPublicDNS()
    } catch (error) {
      await appendAppLog(`[Manager]: set dns failed, ${error}\n`)
    }
  }
  const env = createCoreEnvironment({
    disableLoopbackDetector,
    disableEmbedCA,
    disableSystemCA,
    disableNftables,
    safePaths
  })

  let initialized = false
  const coreHook =
    !useServiceCore && !detached && coreStartupMode === 'post-up'
      ? await createCoreStartupHook()
      : undefined
  const hookWaiter = coreHook ? createCoreHookWaiter(coreHook) : undefined
  if (coreHook) {
    await appendAppLog(
      `[Manager]: Core startup mode: post-up, post-up command: ${coreHook.postUpCommand}\n`
    )
  } else if (!detached) {
    await appendAppLog(`[Manager]: Core startup mode: log\n`)
  }

  const spawnArgs = createCoreSpawnArgs({
    current,
    diffWorkDir,
    ctlParam,
    coreHook
  })

  if (useServiceCore) {
    const serviceProfile: ServiceCoreLaunchProfile = {
      core_path: corePath,
      args: spawnArgs,
      safe_paths: safePaths,
      env,
      mihomo_cpu_priority: mihomoCpuPriority,
      log_path: coreLogPath(),
      save_logs: saveLogs,
      max_log_file_size_mb: maxLogFileSizeMB
    }

    await appendAppLog(`[Manager]: Core permission mode: service, starting service core...\n`)
    ensureServiceCoreEventHandler()
    serviceCoreStartupActive = true
    try {
      const tWs = Date.now()
      await appendAppLog(`[Manager]: Starting service core event stream...\n`)
      await startServiceCoreEventStream()
      await appendAppLog(`[Manager]: Service core event stream started, elapsed: ${Date.now() - tWs}ms\n`)

      if (!serviceCoreRunning) {
        const tStart = Date.now()
        await appendAppLog(`[Manager]: Calling startServiceCore (POST /core/start)...\n`)
        try {
          await startServiceCore(serviceProfile)
          await appendAppLog(`[Manager]: startServiceCore succeeded, elapsed: ${Date.now() - tStart}ms\n`)
        } catch (startError) {
          const startErrorStr = startError instanceof Error ? `${startError.message}\n${startError.stack}` : String(startError)
          await appendAppLog(`[Manager]: startServiceCore FAILED, elapsed: ${Date.now() - tStart}ms, error: ${startErrorStr}\n`)
          throw startError
        }
      }
    } catch (error) {
      const errorStr = error instanceof Error ? `${error.message}\n${error.stack}` : String(error)
      await appendAppLog(`[Manager]: Service core start error: ${errorStr}\n`)
      if (isServiceConnectionError(error)) {
        await appendAppLog(`[Manager]: Connection error, waiting for service fallback...\n`)
        const probe = await waitForServiceCoreConnection(error)
        if (!probe.reachable) {
          return fallbackToElevatedCore(detached, probe.error)
        }
        await appendAppLog(`[Manager]: Service reachable, starting event stream...\n`)
        await startServiceCoreEventStream()
        if (!probe.running) {
          const tRetry = Date.now()
          await appendAppLog(`[Manager]: Starting service core (retry)...\n`)
          await startServiceCore(serviceProfile)
          await appendAppLog(`[Manager]: startServiceCore retry succeeded, elapsed: ${Date.now() - tRetry}ms\n`)
        }
      } else {
        await appendAppLog(`[Manager]: Non-connection error, re-throwing\n`)
        throw error
      }
    } finally {
      serviceCoreStartupActive = false
    }
    await appendAppLog(`[Manager]: Ensuring service core streams started...\n`)
    await ensureServiceCoreStreamsStarted()
    initialized = true
    logCoreStateTransition('RUNNING')
    if (globalTimeout) clearTimeout(globalTimeout)
    await appendAppLog(`[Manager]: ===== startCore (service mode) completed, total: ${Date.now() - startCoreStartedAt}ms =====\n`)
    return [
      (async (): Promise<void> => {
        await waitForMihomoReady()
        await completeCoreInitialization(logLevel)
      })()
    ]
  }

  const providerTracker = createProviderInitializationTracker(await getRuntimeConfig())
  const stdout = createLogWritable('core', 'info')
  const stderr = createLogWritable('core', 'error')

  const tSpawn = Date.now()
  await appendAppLog(`[Manager]: Spawning core process: ${corePath} ${spawnArgs.join(' ')}\n`)
  child = spawn(corePath, spawnArgs, {
    detached: detached,
    stdio: detached ? 'ignore' : undefined,
    env: env
  })
  await appendAppLog(`[Manager]: Core spawned (pid: ${child.pid}), elapsed: ${Date.now() - tSpawn}ms\n`)
  hookWaiter?.attachProcess(child)
  if (child.pid) {
    try {
      os.setPriority(child.pid, os.constants.priority[mihomoCpuPriority])
    } catch (error) {
      await appendAppLog(`[Manager]: set core priority failed, ${error}\n`)
    }
  }
  if (detached) {
    child.unref()
    if (globalTimeout) clearTimeout(globalTimeout)
    await appendAppLog(`[Manager]: ===== startCore (detached) completed, total: ${Date.now() - startCoreStartedAt}ms =====\n`)
    return new Promise((resolve) => {
      resolve([new Promise(() => {})])
    })
  }
  child.on('close', async (code, signal) => {
    await appendAppLog(`[Manager]: Core closed, code: ${code}, signal: ${signal}\n`)
    if (retry) {
      await appendAppLog(`[Manager]: Try Restart Core (retries left: ${retry})\n`)
      retry--
      await restartCore()
    } else {
      await stopCore()
    }
  })
  child.stdout?.pipe(stdout)
  child.stderr?.pipe(stderr)

  const handleCoreOutput = async (
    str: string,
    reject: (reason?: unknown) => void
  ): Promise<void> => {
    if (isControllerListenError(str)) {
      await appendAppLog(`[Manager]: Controller listen error detected: ${str}\n`)
      reject(`控制器监听错误:\n${str}`)
    }

    if (isUpdaterFinishedLog(str)) {
      await appendAppLog(`[Manager]: Updater finished, restarting core...\n`)
      try {
        await stopCore(true)
        // Use restartCore instead of direct startCore to properly go through
        // the mutex/state machine (we're inside startCoreImpl's call chain)
        await restartCore()
        await appendAppLog(`[Manager]: Core restarted after updater finished\n`)
      } catch (e) {
        const errorStr = e instanceof Error ? `${e.message}\n${e.stack}` : String(e)
        await appendAppLog(`[Manager]: Core restart after updater failed: ${errorStr}\n`)
        dialog.showErrorBox('内核启动出错', `${e}`)
      }
    }
  }

  const waitForCoreReadyByLog = (): Promise<Promise<void>[]> => {
    let controllerReady = false
    const logReadyStartedAt = Date.now()

    return new Promise((resolve, reject) => {
      child.stdout?.on('data', async (data) => {
        const str = data.toString()
        await handleCoreOutput(str, reject)

        if (!controllerReady && isControllerReadyLog(str)) {
          controllerReady = true
          await appendAppLog(`[Manager]: Controller ready log received, elapsed: ${Date.now() - logReadyStartedAt}ms\n`)
          resolve([
            new Promise((resolve, reject) => {
              const handleProviderInitialization = async (logLine: string): Promise<void> => {
                providerTracker.track(logLine)

                if (isTunPermissionError(logLine)) {
                  patchControledMihomoConfig({ tun: { enable: false } })
                  mainWindow?.webContents.send('controledMihomoConfigUpdated')
                  ipcMain.emit('updateTrayMenu')
                  reject('虚拟网卡启动失败，前往内核设置页尝试手动授予内核权限')
                }

                if (providerTracker.isReady(logLine)) {
                  await appendAppLog(`[Manager]: Provider initialization complete, waiting for Mihomo ready...\n`)
                  await waitForMihomoReady()
                  initialized = true
                  logCoreStateTransition('RUNNING')
                  completeCoreInitialization(logLevel)
                    .then(() => {
                      appendAppLog(`[Manager]: Core initialization completed\n`)
                      resolve()
                    })
                    .catch(reject)
                }
              }

              child.stdout?.on('data', (data) => {
                if (!initialized) {
                  handleProviderInitialization(data.toString()).catch(reject)
                }
              })
            })
          ])
          await startMihomoApiStreams()
        }
      })
    })
  }

  const waitForCoreReadyByHook = (): Promise<Promise<void>[]> => {
    if (!hookWaiter) return waitForCoreReadyByLog()

    return new Promise((resolve, reject) => {
      child.stdout?.on('data', (data) => {
        handleCoreOutput(data.toString(), reject).catch(reject)
      })

      hookWaiter.promise
        .then(async () => {
          await appendAppLog(`[Manager]: Core ready by hook\n`)
          initialized = true
          logCoreStateTransition('RUNNING')
          await startMihomoApiStreams()
          resolve([completeCoreInitialization(logLevel)])
        })
        .catch((error) => {
          const errorStr = error instanceof Error ? `${error.message}\n${error.stack}` : String(error)
          appendAppLog(`[Manager]: Core ready by hook failed: ${errorStr}\n`)
          reject(error)
        })
    })
  }

  await appendAppLog(`[Manager]: Waiting for core ready (mode: ${coreStartupMode})...\n`)
  const readyPromise = coreStartupMode === 'post-up' ? waitForCoreReadyByHook() : waitForCoreReadyByLog()

  // Race the core ready promise against the global timeout
  if (globalTimeoutPromise) {
    return Promise.race([readyPromise, globalTimeoutPromise])
      .then((result) => {
        if (globalTimeout) clearTimeout(globalTimeout)
        return result
      })
      .catch((error) => {
        if (globalTimeout) clearTimeout(globalTimeout)
        // If timeout triggered, kill the child process to prevent orphan
        if (child && !child.killed) {
          stopChildProcess(child).catch(() => {})
          child = undefined as unknown as ChildProcess
        }
        throw error
      })
  }

  return readyPromise
}

export async function stopCore(force = false): Promise<void> {
  const reqId = Math.random().toString(36).substring(7)
  await appendAppLog(`[⚙️ stopCore:${reqId}] ENTER - force=${force}, currentState=${coreState}\n`)

  // State machine: if already IDLE or STOPPING, skip
  if (coreState === 'IDLE') {
    await appendAppLog(`[⚙️ stopCore:${reqId}] SKIP - core already IDLE\n`)
    return
  }
  if (coreState === 'STOPPING') {
    await appendAppLog(`[⚙️ stopCore:${reqId}] SKIP - already STOPPING\n`)
    return
  }

  logCoreStateTransition('STOPPING')
  const stopCoreStartedAt = Date.now()

  try {
    if (!force) {
      await appendAppLog(`[Manager]: Recovering DNS...\n`)
      await recoverDNS()
    }
  } catch (error) {
    await appendAppLog(`[Manager]: recover dns failed, ${error instanceof Error ? error.message : String(error)}\n`)
  }

  stopMihomoTraffic()
  stopMihomoConnections()
  stopMihomoLogs()
  stopMihomoMemory()
  await appendAppLog(`[Manager]: Mihomo API streams stopped\n`)
  serviceCoreStreamsActive = false
  if (serviceCoreStreamsRestartTimer) {
    clearTimeout(serviceCoreStreamsRestartTimer)
    serviceCoreStreamsRestartTimer = null
  }

  const { corePermissionMode = 'elevated' } = await getAppConfig()
  if (corePermissionMode === 'service') {
    await appendAppLog(`[Manager]: Stopping service core (POST /core/stop)...\n`)
    const t0 = Date.now()
    try {
      await stopServiceCore()
      await appendAppLog(`[Manager]: Service core stopped, elapsed: ${Date.now() - t0}ms\n`)
    } catch (error) {
      const errorStr = error instanceof Error ? `${error.message}\n${error.stack}` : String(error)
      await appendAppLog(`[Manager]: stop service core failed, elapsed: ${Date.now() - t0}ms, error: ${errorStr}\n`)
    } finally {
      stopServiceCoreEventStream()
      releaseServiceCoreEventHandler()
      await appendAppLog(`[Manager]: Service core event stream released\n`)
    }
  }

  if (child && !child.killed) {
    await appendAppLog(`[Manager]: Stopping child process (pid: ${child.pid})...\n`)
    const t1 = Date.now()
    await stopChildProcess(child)
    await appendAppLog(`[Manager]: Child process stopped, elapsed: ${Date.now() - t1}ms\n`)
    child = undefined as unknown as ChildProcess
  }

  const t2 = Date.now()
  await getAxios(true).catch(() => {})
  await appendAppLog(`[Manager]: Axios connection reset, elapsed: ${Date.now() - t2}ms\n`)

  if (existsSync(path.join(dataDir(), 'core.pid'))) {
    const pidString = await readFile(path.join(dataDir(), 'core.pid'), 'utf-8')
    const pid = parseInt(pidString.trim())
    if (!isNaN(pid)) {
      await appendAppLog(`[Manager]: Cleaning up stale core.pid (pid: ${pid})\n`)
      try {
        process.kill(pid, 0)
        process.kill(pid, 'SIGINT')
        await new Promise((resolve) => setTimeout(resolve, 1000))
        try {
          process.kill(pid, 0)
          process.kill(pid, 'SIGKILL')
        } catch {
          // ignore
        }
      } catch {
        // ignore
      }
    }
    await rm(path.join(dataDir(), 'core.pid')).catch(() => {})
    await appendAppLog(`[Manager]: core.pid cleaned up\n`)
  }

  logCoreStateTransition('IDLE')
  await appendAppLog(`[⚙️ stopCore:${reqId}] EXIT - elapsed=${Date.now() - stopCoreStartedAt}ms\n`)
}

function ensureServiceCoreEventHandler(): void {
  if (!unsubscribeServiceCoreEvents) {
    unsubscribeServiceCoreEvents = subscribeServiceCoreEvents((event) =>
      handleServiceCoreEvent(event)
    )
  }
  if (!unsubscribeServiceCoreEventStream) {
    unsubscribeServiceCoreEventStream = subscribeServiceCoreEventStream((state) =>
      handleServiceCoreEventStreamState(state)
    )
  }
}

function releaseServiceCoreEventHandler(): void {
  if (unsubscribeServiceCoreEvents) {
    unsubscribeServiceCoreEvents()
    unsubscribeServiceCoreEvents = null
  }
  if (unsubscribeServiceCoreEventStream) {
    unsubscribeServiceCoreEventStream()
    unsubscribeServiceCoreEventStream = null
  }
}

async function handleServiceCoreEvent(event: ServiceCoreEvent): Promise<void> {
  if (isDuplicateServiceCoreEvent(event)) {
    return
  }

  await appendAppLog(
    `[Manager]: Service core event: ${event.type}${event.pid ? `, pid: ${event.pid}` : ''}${event.error ? `, error: ${event.error}` : ''}\n`
  )

  mainWindow?.webContents.send('core-status-changed', event)

  switch (event.type) {
    case 'started':
      await getAxios(true).catch(() => {})
      mainWindow?.webContents.send('core-started', event)
      mainWindow?.webContents.send('groupsUpdated')
      mainWindow?.webContents.send('rulesUpdated')
      ipcMain.emit('updateTrayMenu')
      void ensureServiceCoreStreamsStarted().catch((error) => {
        const errorStr = error instanceof Error ? `${error.message}\n${error.stack}` : String(error)
        appendAppLog(`[Manager]: start service core streams failed: ${errorStr}\n`).catch(() => {})
      })
      break
    case 'takeover':
    case 'ready':
      await getAxios(true).catch(() => {})
      mainWindow?.webContents.send('core-started', event)
      mainWindow?.webContents.send('groupsUpdated')
      mainWindow?.webContents.send('rulesUpdated')
      ipcMain.emit('updateTrayMenu')
      scheduleServiceCoreStreamsRestart()
      break
    case 'exited':
    case 'failed':
    case 'restart_failed':
      stopMihomoTraffic()
      stopMihomoConnections()
      stopMihomoLogs()
      stopMihomoMemory()
      serviceCoreStreamsActive = false
      setMihomoLogSource('out')
      mainWindow?.webContents.send('core-stopped', event)
      if (event.type === 'restart_failed') {
        mainWindow?.webContents.reload()
      }
      break
    case 'stopped':
      serviceCoreStreamsActive = false
      mainWindow?.webContents.send('core-stopped', event)
      break
  }
}

async function handleServiceCoreEventStreamState(
  state: 'connected' | 'disconnected'
): Promise<void> {
  await appendAppLog(`[Manager]: Service core event stream ${state}\n`)
  if (state !== 'connected') {
    return
  }
  if (serviceCoreStartupActive || serviceCoreReconnectResumePromise) {
    return
  }

  serviceCoreReconnectResumePromise = resumeServiceCoreAfterReconnect()
  try {
    await serviceCoreReconnectResumePromise
  } finally {
    serviceCoreReconnectResumePromise = null
  }
}

async function resumeServiceCoreAfterReconnect(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 500))
  if (serviceCoreStartupActive) {
    return
  }

  // State machine guard: don't start if already starting/running
  if (coreState === 'STARTING' || coreState === 'RUNNING') {
    await appendAppLog(`[Manager]: resumeServiceCoreAfterReconnect skipped, coreState=${coreState}\n`)
    return
  }

  const { corePermissionMode = 'elevated' } = await getAppConfig()
  if (corePermissionMode !== 'service') {
    return
  }

  try {
    await getCoreStatus()
    return
  } catch (error) {
    if (isServiceConnectionError(error)) {
      return
    }
  }

  await appendAppLog(`[Manager]: Service reconnected without running core, starting core\n`)
  const promises = await startCore()
  await Promise.all(promises)
  mainWindow?.webContents.send('core-started')
}

function isDuplicateServiceCoreEvent(event: ServiceCoreEvent): boolean {
  const key =
    event.seq !== undefined
      ? `seq:${event.seq}`
      : [event.type, event.time, event.pid ?? '', event.old_pid ?? '', event.error ?? ''].join('|')
  if (key === lastServiceCoreEventKey) {
    return true
  }
  lastServiceCoreEventKey = key
  return false
}

function scheduleServiceCoreStreamsRestart(): void {
  if (serviceCoreStreamsRestartTimer) {
    clearTimeout(serviceCoreStreamsRestartTimer)
  }

  serviceCoreStreamsRestartTimer = setTimeout(() => {
    serviceCoreStreamsRestartTimer = null
    restartServiceCoreStreams().catch((error) => {
      appendAppLog(`[Manager]: restart service core streams failed, ${error}\n`).catch(() => {})
    })
  }, 300)
}

async function restartServiceCoreStreams(): Promise<void> {
  stopMihomoTraffic()
  stopMihomoConnections()
  stopMihomoLogs()
  stopMihomoMemory()
  serviceCoreStreamsActive = false
  await ensureServiceCoreStreamsStarted()
}

async function ensureServiceCoreStreamsStarted(): Promise<void> {
  await appendAppLog(`[Manager]: ensureServiceCoreStreamsStarted (active=${serviceCoreStreamsActive}, starting=${!!serviceCoreStreamsStarting})\n`)

  if (serviceCoreStreamsRestartTimer) {
    clearTimeout(serviceCoreStreamsRestartTimer)
    serviceCoreStreamsRestartTimer = null
  }
  if (serviceCoreStreamsActive) {
    await appendAppLog(`[Manager]: Service core streams already active\n`)
    return
  }
  if (serviceCoreStreamsStarting) {
    await appendAppLog(`[Manager]: Waiting for existing service core streams start...\n`)
    return serviceCoreStreamsStarting
  }

  serviceCoreStreamsStarting = (async () => {
    const t0 = Date.now()
    await appendAppLog(`[Manager]: Service core streams: resetting axios connection...\n`)
    await getAxios(true).catch(() => {})
    await appendAppLog(`[Manager]: Service core streams: starting traffic...\n`)
    await startMihomoTraffic()
    await appendAppLog(`[Manager]: Service core streams: starting connections...\n`)
    await startMihomoConnections()
    await appendAppLog(`[Manager]: Service core streams: starting logs...\n`)
    await startMihomoLogs()
    await appendAppLog(`[Manager]: Service core streams: starting memory...\n`)
    await startMihomoMemory()
    setMihomoLogSource('ws')
    retry = 10
    serviceCoreStreamsActive = true
    await appendAppLog(`[Manager]: Service core streams started, elapsed: ${Date.now() - t0}ms\n`)
  })()

  try {
    await serviceCoreStreamsStarting
  } finally {
    serviceCoreStreamsStarting = null
  }
}

async function fallbackToElevatedCore(
  detached: boolean,
  reason: unknown
): Promise<Promise<void>[]> {
  const reasonStr = reason instanceof Error ? `${reason.message}\n${reason.stack}` : String(reason)
  await appendAppLog(`[Manager]: Service unavailable, fallback to elevated core, reason: ${reasonStr}\n`)
  stopServiceCoreEventStream()
  releaseServiceCoreEventHandler()
  await patchAppConfig({ corePermissionMode: 'elevated' })
  mainWindow?.webContents.send('appConfigUpdated')
  floatingWindow?.webContents.send('appConfigUpdated')
  // Use startCoreImpl directly to avoid deadlock on isStarting mutex
  // (we're already inside startCoreImpl's call chain)
  return startCoreImpl(detached, 'fallback', Date.now())
}

function isServiceConnectionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return [
    'ECONNREFUSED',
    'ECONNRESET',
    'ENOENT',
    'EPIPE',
    'ETIMEDOUT',
    'socket hang up',
    'connect ',
    'no such file'
  ].some((fragment) => message.toLowerCase().includes(fragment.toLowerCase()))
}

export async function restartCore(): Promise<void> {
  const reqId = Math.random().toString(36).substring(7)
  await appendAppLog(`[⚙️ restartCore:${reqId}] ENTER - currentState=${coreState}\n`)

  // Mutex: prevent concurrent restart attempts
  if (isRestarting) {
    await appendAppLog(`[⚙️ restartCore:${reqId}] BLOCKED - already in progress, ignoring\n`)
    console.warn('[Manager] restartCore already in progress, ignoring duplicate request.')
    return
  }
  isRestarting = true

  const restartTimingLabel = `restartCore`
  console.time(restartTimingLabel)

  try {
    const t0 = Date.now()
    await appendAppLog(`[⚙️ restartCore:${reqId}] stopping core...\n`)
    await stopCore()
    await appendAppLog(`[⚙️ restartCore:${reqId}] stopCore completed, elapsed: ${Date.now() - t0}ms\n`)

    const t1 = Date.now()
    await appendAppLog(`[⚙️ restartCore:${reqId}] starting core...\n`)
    const promises = await startCore()
    await appendAppLog(`[⚙️ restartCore:${reqId}] startCore completed, elapsed: ${Date.now() - t1}ms\n`)

    await appendAppLog(`[⚙️ restartCore:${reqId}] waiting for initialization promises...\n`)
    await Promise.all(promises)
    await appendAppLog(`[⚙️ restartCore:${reqId}] initialization completed\n`)

    console.timeEnd(restartTimingLabel)
    await appendAppLog(`[⚙️ restartCore:${reqId}] EXIT - success, total: ${Date.now() - t0}ms\n`)
  } catch (e) {
    console.timeEnd(restartTimingLabel)
    const errorStr = e instanceof Error ? `${e.message}\n${e.stack}` : String(e)
    await appendAppLog(`[⚙️ restartCore:${reqId}] FAILED\n`)
    await appendAppLog(`[Manager]: Error with stack trace: ${errorStr}\n`)
    dialog.showErrorBox('内核启动出错', `错误: ${e instanceof Error ? e.message : String(e)}\n\n完整堆栈已记录到日志文件:\n${errorStr}`)
  } finally {
    isRestarting = false
  }
}

export async function keepCoreAlive(): Promise<void> {
  try {
    const { corePermissionMode = 'elevated' } = await getAppConfig()
    if (corePermissionMode === 'service') {
      return
    }

    await startCore(true)
    if (child && child.pid) {
      await writeFile(path.join(dataDir(), 'core.pid'), child.pid.toString())
    }
  } catch (e) {
    const errorStr = e instanceof Error ? `${e.message}\n${e.stack}` : String(e)
    await appendAppLog(`[Manager]: keepCoreAlive failed: ${errorStr}\n`)
    dialog.showErrorBox('内核启动出错', `${e}`)
  }
}

export async function quitWithoutCore(): Promise<void> {
  await keepCoreAlive()
  await startMonitor(true)
  app.exit()
}

export async function startNetworkDetection(): Promise<void> {
  await startNetworkDetectionWithCore({
    shouldStartCore: (networkDownHandled) =>
      (networkDownHandled && !child) || Boolean(child?.killed),
    startCore: async () => {
      const promises = await startCore()
      await Promise.all(promises)
    },
    stopCore
  })
}

export const stopNetworkDetection = stopNetworkDetectionController
