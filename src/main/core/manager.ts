import { ChildProcess, spawn, exec } from 'child_process'
import { promisify } from 'util'
import { dataDir, coreLogPath, mihomoCorePath, mihomoWorkConfigPath } from '../utils/dirs'
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
  mihomoGroups,
  mihomoReloadConfig
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
import { appendAppLog, appendAppLogJson, createLogWritable, setMihomoLogSource } from '../utils/log'
import { createCoreHookWaiter, createCoreStartupHook } from './startupHook'
import { stopChildProcess, type StopChildProcessResult } from './process-control'
import {
  recoverDNS,
  setPublicDNS,
  startNetworkDetection as startNetworkDetectionWithCore,
  stopNetworkDetection as stopNetworkDetectionController
} from './network'
import { checkProfile } from './profile-check'
import { startService } from '../service/manager'
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

/**
 * Signal that the system is in a resume-from-sleep cycle.
 * When set, handleServiceCoreEventStreamState will skip triggering
 * resumeServiceCoreAfterReconnect(), because the resume handler in
 * index.ts will take care of starting the core after a network settle delay.
 */
export function setSystemIsResuming(v: boolean): void {
  systemIsResuming = v
}

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
/** Flag: system is currently in resume-from-sleep cycle.
 *  Set by index.ts resume handler BEFORE its 2s network settle delay,
 *  so that WebSocket reconnection during that window does NOT trigger
 *  a redundant resumeServiceCoreAfterReconnect → startCore() call. */
let systemIsResuming = false
/** Flag: set to true when controller_ready WebSocket event is received */
let controllerReadyReceived = false
/** Resolver for the controller_ready event promise, used in service mode startup */
let controllerReadyResolve: (() => void) | null = null
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
  appendAppLogJson({
    timestamp: new Date().toISOString(),
    level: 'info',
    module: 'Manager',
    message: `Core state transition: ${oldState} -> ${newState}`,
    data: { seq, oldState, newState, triggeredBy: stackLine }
  }).catch(() => { })
}

// Mutex for restartCore to prevent concurrent restart attempts
let isRestarting = false

// Mutex for startCore to prevent concurrent start attempts
let isStarting = false

// Mutex for hotReloadCore to prevent concurrent hot-reload attempts
let isReloading = false

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
  await appendAppLog(
    `[Manager]: Starting Mihomo API streams (traffic, connections, logs, memory)\n`
  )
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
        await appendAppLog(
          `[Manager]: waitForMihomoReady succeeded after ${i} retries, elapsed: ${elapsed}ms\n`
        )
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
  const initialErrorStr =
    initialError instanceof Error
      ? `${initialError.message}\n${initialError.stack}`
      : String(initialError)
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

  const lastErrorStr =
    lastError instanceof Error ? `${lastError.message}\n${lastError.stack}` : String(lastError)
  await appendAppLog(
    `[Manager]: Service still unavailable after ${serviceConnectionRetryTimeout}ms, last error: ${lastErrorStr}\n`
  )
  return { reachable: false, running: false, error: lastError }
}

export async function startCore(detached = false): Promise<Promise<void>[]> {
  const reqId = Math.random().toString(36).substring(7)
  console.trace(`[startCore:${reqId}] ENTER - detached=${detached}, currentState=${coreState}`)
  await appendAppLog(
    `[startCore:${reqId}] ENTER - detached=${detached}, currentState=${coreState}\n`
  )

  // Mutex: prevent concurrent startCore attempts (except detached mode)
  if (!detached) {
    if (isStarting) {
      await appendAppLog(
        `[startCore:${reqId}] BLOCKED - startCore already in progress, waiting...\n`
      )
      // Wait for the current start to finish, then return empty (caller should re-check)
      while (isStarting) {
        await new Promise((r) => setTimeout(r, 100))
      }
      await appendAppLog(
        `[startCore:${reqId}] BLOCKED - previous startCore completed, returning empty\n`
      )
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
    await appendAppLog(
      `[startCore:${reqId}] EXIT - state=${coreState}, elapsed=${Date.now() - startCoreStartedAt}ms\n`
    )
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
  startCoreStartedAt: number,
  skipServiceMode = false
): Promise<Promise<void>[]> {
  // Global timeout guard for startCore (not applied to detached mode)
  let globalTimeout: NodeJS.Timeout | null = null
  const globalTimeoutPromise = !detached
    ? new Promise<never>((_, reject) => {
      globalTimeout = setTimeout(() => {
        const elapsed = Date.now() - startCoreStartedAt
        reject(
          new Error(`内核启动超时 (${elapsed}ms)，已超过 ${START_CORE_GLOBAL_TIMEOUT}ms 限制`)
        )
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
    safePaths: configuredSafePaths = []
  } = await getAppConfig()
  // Always include dataDir() in SAFE_PATHS so that config files generated inside
  // the work directory (e.g., config.yaml) can be hot-reloaded via PUT /configs
  // even when they reside on a different drive/partition than the mihomo binary.
  const safePaths = [...new Set([...configuredSafePaths, dataDir()])]
  await appendAppLog(
    `[Manager]: Config: corePermissionMode=${corePermissionMode}, coreStartupMode=${coreStartupMode}, core=${core}, diffWorkDir=${diffWorkDir}\n`
  )

  const controlledMihomoConfig = await getControledMihomoConfig()
  const { 'log-level': logLevel, tun } = controlledMihomoConfig
  const { current } = await getProfileConfig()
  const useServiceCore = corePermissionMode === 'service' && !detached && !skipServiceMode
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
    await appendAppLog(
      `[Manager]: Profile check FAILED, elapsed: ${Date.now() - tCheck}ms, error: ${errorStr}\n`
    )
    throw error
  }

  let serviceCoreRunning = false
  if (useServiceCore) {
    await appendAppLog(`[Manager]: Checking service core status...\n`)
    const tStatus = Date.now()
    try {
      await getCoreStatus()
      serviceCoreRunning = true
      await appendAppLog(
        `[Manager]: Service core is already running, elapsed: ${Date.now() - tStatus}ms\n`
      )
    } catch (error) {
      const errorStr = error instanceof Error ? `${error.message}\n${error.stack}` : String(error)
      await appendAppLog(
        `[Manager]: Service core status check failed, elapsed: ${Date.now() - tStatus}ms, error: ${errorStr}\n`
      )
      if (isServiceConnectionError(error)) {
        // Try to start the Windows service process before waiting/fallback
        // This handles the case where the service was stopped/paused after reinstall
        await appendAppLog(
          `[Manager]: Service not reachable, attempting to start service process...\n`
        )
        try {
          await startService()
          await appendAppLog(
            `[Manager]: Service start initiated successfully, waiting for connection...\n`
          )
        } catch (startErr) {
          await appendAppLog(
            `[Manager]: Service start attempt failed (will continue with wait/fallback): ${startErr}\n`
          )
        }
        const probe = await waitForServiceCoreConnection(error)
        if (!probe.reachable) {
          return fallbackToElevatedCore(detached, probe.error)
        }
        serviceCoreRunning = probe.running
      } else {
        // Non-connection error (e.g., "进程未运行", "核心未运行") means service IS reachable
        // but core is not running yet. This is NOT a failure - proceed to start core.
        await appendAppLog(
          `[Manager]: Service core is reachable but not running, will start core\n`
        )
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

  // 当 TUN 启用且 auto-detect-interface 未显式禁用时，强制关闭回环检测器。
  // 原因：auto-detect-interface 在物理网络切换（如以太网断连→WLAN）期间，
  // mihomo 的 FindInterfaceName() 会返回 "<invalid>" 作为接口名，
  // 导致所有出站连接绑定到不存在的接口而全部 i/o timeout。
  // 此时回环检测器如果开启，会进一步误判流量死循环而激进丢包，延长黑洞时间。
  const effectiveDisableLoopbackDetector =
    tun?.enable && tun['auto-detect-interface'] !== false
      ? true // TUN + auto-detect 模式下必须关闭回环检测
      : disableLoopbackDetector
  const env = createCoreEnvironment({
    disableLoopbackDetector: effectiveDisableLoopbackDetector,
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
    // Reset controller_ready tracking before starting core
    controllerReadyReceived = false
    controllerReadyResolve = null
    try {
      const tWs = Date.now()
      await appendAppLog(`[Manager]: Starting service core event stream...\n`)
      await startServiceCoreEventStream()
      await appendAppLog(
        `[Manager]: Service core event stream started, elapsed: ${Date.now() - tWs}ms\n`
      )

      if (!serviceCoreRunning) {
        const tStart = Date.now()
        await appendAppLog(`[Manager]: Calling startServiceCore (POST /core/start)...\n`)
        try {
          await startServiceCore(serviceProfile)
          await appendAppLog(
            `[Manager]: startServiceCore succeeded, elapsed: ${Date.now() - tStart}ms\n`
          )
        } catch (startError) {
          const startErrorStr =
            startError instanceof Error
              ? `${startError.message}\n${startError.stack}`
              : String(startError)
          await appendAppLog(
            `[Manager]: startServiceCore FAILED, elapsed: ${Date.now() - tStart}ms, error: ${startErrorStr}\n`
          )
          throw startError
        }
      }
    } catch (error) {
      const errorStr = error instanceof Error ? `${error.message}\n${error.stack}` : String(error)
      await appendAppLog(`[Manager]: Service core start error: ${errorStr}\n`)
      if (isServiceConnectionError(error)) {
        await appendAppLog(`[Manager]: Connection error, attempting to restart service...\n`)
        try {
          await startService()
          await appendAppLog(`[Manager]: Service restart initiated, waiting for connection...\n`)
        } catch (startErr) {
          await appendAppLog(
            `[Manager]: Service restart attempt failed (will continue with fallback): ${startErr}\n`
          )
        }
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
          await appendAppLog(
            `[Manager]: startServiceCore retry succeeded, elapsed: ${Date.now() - tRetry}ms\n`
          )
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
    await appendAppLog(
      `[Manager]: ===== startCore (service mode) completed, total: ${Date.now() - startCoreStartedAt}ms =====\n`
    )

    // Event-driven controller readiness detection:
    // - New Go backend: POST returns ~2ms, WebSocket sends controller_ready ~1s later
    // - If controller_ready already received (flag set during POST blocking), proceed immediately
    // - If not received within 10s grace period, fall back to waitForMihomoReady polling
    // - Always use waitForMihomoReady() as final safety net
    // 5s grace period: if controller_ready doesn't arrive by then (old Go backend),
    // fall back to polling. With new async Go backend, event arrives ~1s after POST.
    const controllerReadyGracePeriod = 5000
    const controllerReadyTimer = setTimeout(() => {
      if (!controllerReadyReceived && controllerReadyResolve) {
        controllerReadyResolve()
        controllerReadyResolve = null
        appendAppLog(
          `[Manager]: controller_ready not received within ${controllerReadyGracePeriod}ms grace period, falling back to polling\n`
        ).catch(() => { })
      }
    }, controllerReadyGracePeriod)

    return [
      (async (): Promise<void> => {
        if (controllerReadyReceived) {
          await appendAppLog(
            `[Manager]: Controller already ready (event received during POST), proceeding to initialization\n`
          )
          clearTimeout(controllerReadyTimer)
        } else if (controllerReadyResolve === null) {
          // Set up resolver for the controller_ready event
          await appendAppLog(
            `[Manager]: Waiting for controller_ready event (grace period: ${controllerReadyGracePeriod}ms)...\n`
          )
          await new Promise<void>((resolve) => {
            controllerReadyResolve = resolve
          })
          clearTimeout(controllerReadyTimer)
        }
        // Safety net: waitForMihomoReady is instant if controller is already ready
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
  await appendAppLog(
    `[Manager]: Core spawned (pid: ${child.pid}), elapsed: ${Date.now() - tSpawn}ms\n`
  )
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
    await appendAppLog(
      `[Manager]: ===== startCore (detached) completed, total: ${Date.now() - startCoreStartedAt}ms =====\n`
    )
    return new Promise((resolve) => {
      resolve([new Promise(() => { })])
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

  // Track retry count for controller listen errors (port conflict)
  let controllerListenRetryCount = 0
  const MAX_CONTROLLER_LISTEN_RETRIES = 3

  const handleCoreOutput = async (
    str: string,
    reject: (reason?: unknown) => void
  ): Promise<void> => {
    if (isControllerListenError(str)) {
      await appendAppLog(`[Manager]: Controller listen error detected: ${str}\n`)

      if (controllerListenRetryCount < MAX_CONTROLLER_LISTEN_RETRIES) {
        controllerListenRetryCount++
        await appendAppLog(
          `[Manager]: Port conflict detected, retrying (${controllerListenRetryCount}/${MAX_CONTROLLER_LISTEN_RETRIES})...\n`
        )
        // Wait for port to be released before retrying
        await waitForPortRelease(9090, '127.0.0.2', 3000)
        // Kill the current child (which failed to bind) and restart
        if (child && !child.killed) {
          stopChildProcess(child).catch(() => { })
        }
        // Trigger restart via the restartCore path
        try {
          await restartCore()
        } catch (e) {
          const errorStr = e instanceof Error ? `${e.message}\n${e.stack}` : String(e)
          await appendAppLog(`[Manager]: Core restart after port conflict failed: ${errorStr}\n`)
          reject(`控制器监听错误（重试 ${controllerListenRetryCount} 次后仍失败）:\n${str}`)
        }
      } else {
        reject(`控制器监听错误（已重试 ${MAX_CONTROLLER_LISTEN_RETRIES} 次）:\n${str}`)
      }
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
          await appendAppLog(
            `[Manager]: Controller ready log received, elapsed: ${Date.now() - logReadyStartedAt}ms\n`
          )
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
                  await appendAppLog(
                    `[Manager]: Provider initialization complete, waiting for Mihomo ready...\n`
                  )
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
          const errorStr =
            error instanceof Error ? `${error.message}\n${error.stack}` : String(error)
          appendAppLog(`[Manager]: Core ready by hook failed: ${errorStr}\n`)
          reject(error)
        })
    })
  }

  await appendAppLog(`[Manager]: Waiting for core ready (mode: ${coreStartupMode})...\n`)
  const readyPromise =
    coreStartupMode === 'post-up' ? waitForCoreReadyByHook() : waitForCoreReadyByLog()

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
          stopChildProcess(child).catch(() => { })
          child = undefined as unknown as ChildProcess
        }
        throw error
      })
  }

  return readyPromise
}

export async function stopCore(force = false): Promise<StopChildProcessResult> {
  const reqId = Math.random().toString(36).substring(7)
  console.trace(`[stopCore:${reqId}] ENTER - force=${force}, currentState=${coreState}`)
  await appendAppLog(`[stopCore:${reqId}] ENTER - force=${force}, currentState=${coreState}\n`)

  // State machine: if already IDLE or STOPPING, skip
  if (coreState === 'IDLE') {
    await appendAppLog(`[stopCore:${reqId}] SKIP - core already IDLE\n`)
    return { wasDeadlocked: false, finalSignal: null }
  }
  if (coreState === 'STOPPING') {
    await appendAppLog(`[stopCore:${reqId}] SKIP - already STOPPING\n`)
    return { wasDeadlocked: false, finalSignal: null }
  }

  logCoreStateTransition('STOPPING')
  const stopCoreStartedAt = Date.now()
  let stopResult: StopChildProcessResult = { wasDeadlocked: false, finalSignal: null }

  try {
    if (!force) {
      await appendAppLog(`[Manager]: Recovering DNS...\n`)
      await recoverDNS()
    }
  } catch (error) {
    await appendAppLog(
      `[Manager]: recover dns failed, ${error instanceof Error ? error.message : String(error)}\n`
    )
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
    // 先快速探测 service 是否可达，避免在 service 未运行时无谓地连接管道
    // 产生 ENOENT 错误日志（普通模式回退场景下 service 管道不存在是预期行为）
    let serviceReachable = false
    try {
      const { test } = await import('../service/api')
      await test()
      serviceReachable = true
    } catch {
      // service 不可达（ENOENT/ECONNREFUSED），跳过 service 停止逻辑
    }

    if (serviceReachable) {
      await appendAppLog(`[Manager]: Stopping service core (POST /core/stop)...\n`)
      const t0 = Date.now()
      try {
        await stopServiceCore()
        await appendAppLog(`[Manager]: Service core stopped, elapsed: ${Date.now() - t0}ms\n`)
      } catch (error) {
        const errorStr = error instanceof Error ? `${error.message}\n${error.stack}` : String(error)
        await appendAppLog(
          `[Manager]: stop service core failed, elapsed: ${Date.now() - t0}ms, error: ${errorStr}\n`
        )
        // 如果 service 连接失败（ENOENT/ECONNREFUSED），说明 service 进程未运行，
        // 此时应继续尝试停止可能存在的子进程（从 elevated 模式 fallback 过来的），
        // 而不是跳过子进程停止逻辑。
      }
    } else {
      await appendAppLog(`[Manager]: Service not reachable, skipping service core stop\n`)
    }

    stopServiceCoreEventStream()
    releaseServiceCoreEventHandler()
    await appendAppLog(`[Manager]: Service core event stream released\n`)
  }

  // 无论 service 模式是否成功停止，都尝试停止子进程。
  // 在以下场景中 child 可能存在：
  // 1. 从 elevated 模式 fallback 到 service 模式时，child 被赋值
  // 2. 用户从 service 模式切换回 elevated 模式后，child 被赋值
  // 3. service 模式启动失败后 fallbackToElevatedCore 创建了子进程
  if (child && !child.killed) {
    await appendAppLog(`[Manager]: Stopping child process (pid: ${child.pid})...\n`)
    const t1 = Date.now()

    // stopChildProcess has internal Stage 4 (10s total timeout) that guarantees
    // the Promise will resolve even if the process is a zombie that doesn't
    // emit close/exit events. No additional timeout wrapper needed here —
    // adding one would cause stopCore() to throw, breaking restartCore() flow
    // (e.g., when toggling TUN, restartCore calls stopCore then startCore).
    stopResult = await stopChildProcess(child)

    await appendAppLog(
      `[Manager]: Child process stopped, elapsed: ${Date.now() - t1}ms, ` +
      `wasDeadlocked=${stopResult.wasDeadlocked}, finalSignal=${stopResult.finalSignal}\n`
    )
    child = undefined as unknown as ChildProcess

    // 如果进程是被强制终止的（NDIS 死锁），清理残留的 TUN 虚拟网卡
    if (stopResult.wasDeadlocked) {
      await forceReleaseGhostTun()
    }
  } else if (corePermissionMode === 'service') {
    // 安全网：service 模式下没有子进程可停止（service 未运行且从未 fallback 到 elevated），
    // 尝试通过 taskkill 强制终止所有 mihomo 进程，确保核心被停止。
    try {
      const { execSync } = await import('child_process')
      execSync('taskkill /F /IM mihomo*.exe', { windowsHide: true, timeout: 5000 })
      await appendAppLog(`[Manager]: Safety net: taskkill /F /IM mihomo*.exe executed\n`)
    } catch {
      // taskkill 失败忽略（可能进程已不存在或无权限）
    }
  }

  // ===== NDIS Breathing Room =====
  // After the process has exited, the Windows TCP/IP stack (tcpip.sys) and
  // TUN driver (WinTun) may still have pending completion callbacks for
  // NetBufferLists that were in-flight at the time of process termination.
  // A 1000ms sleep gives the kernel enough time to drain these callbacks
  // and release the associated network handles (including TCP ports in
  // TIME_WAIT state).
  await appendAppLog(`[Manager]: NDIS breathing room: waiting 1000ms for network stack cleanup...\n`)
  await new Promise((resolve) => setTimeout(resolve, 1000))

  const t2 = Date.now()
  await getAxios(true).catch(() => { })
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
    await rm(path.join(dataDir(), 'core.pid')).catch(() => { })
    await appendAppLog(`[Manager]: core.pid cleaned up\n`)
  }

  logCoreStateTransition('IDLE')
  await appendAppLog(`[stopCore:${reqId}] EXIT - elapsed=${Date.now() - stopCoreStartedAt}ms\n`)

  return stopResult
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
      await getAxios(true).catch(() => { })
      mainWindow?.webContents.send('core-started', event)
      mainWindow?.webContents.send('groupsUpdated')
      mainWindow?.webContents.send('rulesUpdated')
      ipcMain.emit('updateTrayMenu')
      void ensureServiceCoreStreamsStarted().catch((error) => {
        const errorStr = error instanceof Error ? `${error.message}\n${error.stack}` : String(error)
        appendAppLog(`[Manager]: start service core streams failed: ${errorStr}\n`).catch(() => { })
      })
      break
    case 'controller_ready':
      await appendAppLog(`[Manager]: Controller ready event received\n`)
      controllerReadyReceived = true
      if (controllerReadyResolve) {
        controllerReadyResolve()
        controllerReadyResolve = null
      }
      break
    case 'takeover':
    case 'ready':
      await getAxios(true).catch(() => { })
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
      // 同步状态机到 FAILED，防止后续 hotReloadCore 等操作错误地
      // 认为核心仍在运行而进入重启循环（如 post-up 超时后继续重试）
      if (coreState === 'RUNNING') {
        logCoreStateTransition('FAILED')
      }
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
  // 系统正在从休眠中恢复：resume 处理器（index.ts）将在网络稳定后
  // 主动调 startCore()，此处跳过 resumeServiceCoreAfterReconnect 以避免
  // 两路并行 startCore 竞争导致连接混乱。
  if (serviceCoreStartupActive || serviceCoreReconnectResumePromise || systemIsResuming) {
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
    await appendAppLog(
      `[Manager]: resumeServiceCoreAfterReconnect skipped, coreState=${coreState}\n`
    )
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
      appendAppLog(`[Manager]: restart service core streams failed, ${error}\n`).catch(() => { })
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
  await appendAppLog(
    `[Manager]: ensureServiceCoreStreamsStarted (active=${serviceCoreStreamsActive}, starting=${!!serviceCoreStreamsStarting})\n`
  )

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
    await getAxios(true).catch(() => { })
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
  await appendAppLog(
    `[Manager]: Service unavailable, fallback to elevated core, reason: ${reasonStr}\n`
  )
  stopServiceCoreEventStream()
  releaseServiceCoreEventHandler()
  // 不持久化修改 corePermissionMode 配置，保留用户设置的 'service' 模式
  // 这样下次应用重启时仍会尝试使用服务模式，避免重装后配置被意外覆盖
  await appendAppLog(
    `[Manager]: Keeping corePermissionMode='service' in config, will retry on next startup\n`
  )
  mainWindow?.webContents.send('appConfigUpdated')
  floatingWindow?.webContents.send('appConfigUpdated')
  // Use startCoreImpl directly to avoid deadlock on isStarting mutex
  // (we're already inside startCoreImpl's call chain)
  // skipServiceMode=true 防止递归调用时再次触发服务模式检测导致无限循环
  return startCoreImpl(detached, 'fallback', Date.now(), true)
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

const execAsync = promisify(exec)

/**
 * Force-disable ghost WinTun network adapters via PowerShell.
 *
 * When the mihomo process is killed (especially after a timeout/deadlock),
 * the WinTun virtual adapter may remain in a dangling state in the NDIS stack,
 * holding kernel locks (tcpip.sys) and preventing the next mihomo instance
 * from binding to the same port (127.0.0.2:9090).
 *
 * This function runs a PowerShell command to find and disable any adapter
 * whose interface description contains "Wintun" or whose name contains
 * "mihomo" (case-insensitive). Disabling the adapter at the NDIS layer
 * forces the kernel to release the orphaned network handles.
 *
 * NOTE: This requires the Sparkle process to have administrator privileges.
 * If elevation is not available, the command will fail silently.
 */
async function forceReleaseGhostTun(): Promise<void> {
  await appendAppLog(
    `[Manager]: ⚠️ [Rescue] Detected possible NDIS deadlock, initiating ghost TUN adapter cleanup...\n`
  )

  // PowerShell command: find all Wintun or mihomo adapters and disable them.
  // Disable-NetAdapter forces NDIS to tear down the device object, which
  // breaks any lingering kernel-level wait chains in tcpip.sys.
  const psCommand = [
    'powershell.exe',
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    'Get-NetAdapter',
    '|',
    'Where-Object',
    '{',
    '$_.InterfaceDescription -match "Wintun" -or $_.Name -match "mihomo"',
    '}',
    '|',
    'Disable-NetAdapter',
    '-Confirm:$false'
  ].join(' ')

  try {
    await execAsync(psCommand, { windowsHide: true, timeout: 10000 })
    await appendAppLog(
      `[Manager]: ✅ [Rescue] Ghost TUN adapters disabled, kernel locks released.\n`
    )

    // Brief pause to let NDIS settle after the adapter teardown
    await new Promise((resolve) => setTimeout(resolve, 500))
  } catch (error) {
    const errorStr = error instanceof Error ? error.message : String(error)
    await appendAppLog(
      `[Manager]: ❌ [Rescue] Ghost TUN cleanup failed (may need admin privileges): ${errorStr}\n`
    )
  }
}

/**
 * Wait for a TCP port to become free (not in TIME_WAIT state).
 *
 * After a process exits, the OS may hold the port in TIME_WAIT for up to
 * 2*MSL (~120s on Windows). This function polls `netstat` to check if the
 * port is still in use, with a configurable timeout.
 *
 * @param port - The port number to check (e.g., 9090)
 * @param address - The IP address to check (e.g., '127.0.0.2')
 * @param timeoutMs - Maximum time to wait in milliseconds (default: 5000)
 * @returns true if the port became free, false if timeout
 */
async function waitForPortRelease(
  port: number,
  address: string,
  timeoutMs = 5000
): Promise<boolean> {
  if (process.platform !== 'win32') {
    // Non-Windows platforms don't have the same TIME_WAIT issue
    return true
  }

  const startedAt = Date.now()
  const pollInterval = 200

  while (Date.now() - startedAt < timeoutMs) {
    try {
      // Use netstat to check if the port is in use
      const { stdout } = await execAsync(
        `netstat -ano | findstr "${address}:${port}"`,
        { windowsHide: true, timeout: 3000 }
      )

      if (!stdout.trim()) {
        // Port is free
        const elapsed = Date.now() - startedAt
        if (elapsed > 0) {
          await appendAppLog(
            `[Manager]: Port ${address}:${port} released after ${elapsed}ms\n`
          )
        }
        return true
      }

      // Check if all entries are TIME_WAIT (will resolve soon)
      const lines = stdout.trim().split('\n')
      const allTimeWait = lines.every((line) =>
        line.includes('TIME_WAIT')
      )
      if (allTimeWait && lines.length <= 2) {
        // Only TIME_WAIT entries, likely to resolve quickly
        await appendAppLog(
          `[Manager]: Port ${address}:${port} in TIME_WAIT (${lines.length} entries), waiting...\n`
        )
      }
    } catch {
      // netstat command failed, port is likely free
      return true
    }

    await new Promise((resolve) => setTimeout(resolve, pollInterval))
  }

  await appendAppLog(
    `[Manager]: ⚠️ Port ${address}:${port} still in use after ${timeoutMs}ms timeout, proceeding anyway\n`
  )
  return false
}

/**
 * Read the current profile's disabledRules and re-apply them to the running
 * Mihomo kernel. This is called after hotReloadCore() and restartCore()
 * to ensure persistently disabled rules remain effective after config reload.
 */
/**
 * Hot-reload the Mihomo configuration via PUT /configs?force=true API.
 *
 * This is the preferred path for "switching subscriptions" or "updating profiles".
 * Unlike restartCore(), it does NOT kill the mihomo process, so the Wintun adapter
 * and system route table remain intact — resulting in near-zero downtime.
 *
 * Hot reload is only attempted when the core is in RUNNING state.
 * If the core is not running, or if the API call fails, this function
 * falls back gracefully to the full restartCore() path.
 */
export async function hotReloadCore(): Promise<void> {
  const reqId = Math.random().toString(36).substring(7)
  console.trace(`[hotReloadCore:${reqId}] ENTER - currentState=${coreState}`)
  await appendAppLog(`[hotReloadCore:${reqId}] ENTER - currentState=${coreState}\n`)

  // Mutex: prevent concurrent hot-reload attempts (which would cause file write contention)
  if (isReloading) {
    await appendAppLog(
      `[hotReloadCore:${reqId}] BLOCKED - another reload in progress, waiting...\n`
    )
    while (isReloading) {
      await new Promise((r) => setTimeout(r, 100))
    }
    // After waiting, re-check core state and proceed (don't silently drop the request)
    await appendAppLog(`[hotReloadCore:${reqId}] Previous reload completed, proceeding...\n`)
  }
  isReloading = true

  try {
    // 核心已明确失败（如 post-up 超时导致内核退出），
    // 此时不应继续尝试 restartCore，否则会陷入「失败→重试→再失败」的死循环。
    // 直接抛出错误，让调用方（如 changeCurrentProfile）回滚配置变更并展示错误。
    if (coreState === 'FAILED') {
      await appendAppLog(
        `[hotReloadCore:${reqId}] Core state is FAILED, throwing immediately to prevent restart loop\n`
      )
      throw new Error('核心已因启动失败而停止，请检查物理网络连接后手动重启内核')
    }

    // Only hot-reload if core is running; otherwise fall back to full restart
    if (coreState !== 'RUNNING') {
      await appendAppLog(
        `[hotReloadCore:${reqId}] Core not RUNNING (state=${coreState}), falling back to restartCore\n`
      )
      return restartCore()
    }

    const t0 = Date.now()
    // 1. Generate the new profile and write config.yaml to disk
    await appendAppLog(`[hotReloadCore:${reqId}] Generating profile...\n`)
    await generateProfile()
    await appendAppLog(
      `[hotReloadCore:${reqId}] Profile generated, elapsed: ${Date.now() - t0}ms\n`
    )

    // 2. Resolve the config file path
    const { diffWorkDir = false } = await getAppConfig()
    const { current } = await getProfileConfig()
    const configPath = mihomoWorkConfigPath(diffWorkDir ? current : 'work')
    await appendAppLog(`[hotReloadCore:${reqId}] Config path: ${configPath}\n`)

    // 3. Send PUT /configs?force=true to Mihomo controller
    await appendAppLog(`[hotReloadCore:${reqId}] Sending hot-reload request...\n`)
    await mihomoReloadConfig(configPath)
    const elapsed = Date.now() - t0
    await appendAppLog(`[hotReloadCore:${reqId}] Hot reload SUCCESS, elapsed: ${elapsed}ms\n`)

    // 4. Notify frontend to refresh groups, rules, profile config and tray menu
    mainWindow?.webContents.send('profileConfigUpdated')
    mainWindow?.webContents.send('groupsUpdated')
    mainWindow?.webContents.send('rulesUpdated')
    ipcMain.emit('updateTrayMenu')
  } catch (error) {
    const errorStr = error instanceof Error ? `${error.message}\n${error.stack}` : String(error)
    await appendAppLog(
      `[hotReloadCore:${reqId}] FAILED: ${errorStr}, falling back to restartCore\n`
    )
    // Fall back to the full restart path
    return restartCore()
  } finally {
    isReloading = false
  }
}

export async function restartCore(): Promise<void> {
  const reqId = Math.random().toString(36).substring(7)
  console.trace(`[restartCore:${reqId}] ENTER - currentState=${coreState}`)
  await appendAppLog(`[restartCore:${reqId}] ENTER - currentState=${coreState}\n`)

  // Mutex: prevent concurrent restart attempts
  if (isRestarting) {
    await appendAppLog(`[restartCore:${reqId}] BLOCKED - already in progress, ignoring\n`)
    return
  }
  isRestarting = true

  const restartTimingLabel = `restartCore`
  console.time(restartTimingLabel)

  try {
    const t0 = Date.now()
    await appendAppLog(`[restartCore:${reqId}] stopping core...\n`)

    // Step 1: Stop the core (with NDIS breathing room built into stopCore)
    const stopResult = await stopCore()
    await appendAppLog(
      `[restartCore:${reqId}] stopCore completed, elapsed: ${Date.now() - t0}ms, ` +
      `wasDeadlocked=${stopResult.wasDeadlocked}\n`
    )

    // Step 2: If the process was force-killed (deadlock detected), run ghost TUN cleanup
    if (stopResult.wasDeadlocked) {
      await appendAppLog(
        `[restartCore:${reqId}] ⚠️ Deadlock detected during stop, running ghost TUN cleanup...\n`
      )
      await forceReleaseGhostTun()
    }

    // Step 3: Wait for the controller port (127.0.0.2:9090) to be released
    // This prevents the "Only one usage of each socket address" error that occurs
    // when the new mihomo process tries to bind before the old port is fully released
    // from TIME_WAIT state.
    await appendAppLog(
      `[restartCore:${reqId}] Waiting for controller port (127.0.0.2:9090) to be released...\n`
    )
    await waitForPortRelease(9090, '127.0.0.2', 5000)

    const t1 = Date.now()
    await appendAppLog(`[restartCore:${reqId}] starting core...\n`)
    const promises = await startCore()
    await appendAppLog(
      `[restartCore:${reqId}] startCore completed, elapsed: ${Date.now() - t1}ms\n`
    )

    await appendAppLog(`[restartCore:${reqId}] waiting for initialization promises...\n`)
    await Promise.all(promises)
    await appendAppLog(`[restartCore:${reqId}] initialization completed\n`)

    console.timeEnd(restartTimingLabel)
    await appendAppLog(`[restartCore:${reqId}] EXIT - success, total: ${Date.now() - t0}ms\n`)
  } catch (e) {
    console.timeEnd(restartTimingLabel)
    const errorStr = e instanceof Error ? `${e.message}\n${e.stack}` : String(e)
    await appendAppLog(`[restartCore:${reqId}] FAILED\n`)
    await appendAppLog(`[Manager]: Error with stack trace: ${errorStr}\n`)
    dialog.showErrorBox(
      '内核启动出错',
      `错误: ${e instanceof Error ? e.message : String(e)}\n\n完整堆栈已记录到日志文件:\n${errorStr}`
    )
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
    stopCore: async () => {
      await stopCore()
    }
  })
}

export const stopNetworkDetection = stopNetworkDetectionController
