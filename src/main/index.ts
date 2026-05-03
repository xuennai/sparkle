import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { registerIpcMainHandlers } from './utils/ipc'
import windowStateKeeper from 'electron-window-state'
import {
  app,
  shell,
  BrowserWindow,
  Menu,
  dialog,
  Notification,
  powerMonitor,
  ipcMain
} from 'electron'
import { addOverrideItem, addProfileItem, getAppConfig, patchControledMihomoConfig } from './config'
import { quitWithoutCore, setSystemIsResuming, startCore, stopCore } from './core/manager'
import { disableSysProxySync, triggerSysProxy } from './sys/sysproxy'
import icon from '../../resources/icon.png?asset'
import { createTray } from './resolve/tray'
import { createApplicationMenu } from './resolve/menu'
import { init } from './utils/init'
import { join } from 'path'
import { appendFileSync } from 'fs'
import { initShortcut } from './resolve/shortcut'
import { spawn } from 'child_process'
import { initProfileUpdater } from './core/profileUpdater'
import { exePath } from './utils/dirs'
import { startMonitor } from './resolve/trafficMonitor'
import { showFloatingWindow } from './resolve/floatingWindow'
import { getAppConfigSync } from './config/app'
import { getUserAgent } from './utils/userAgent'
import { appendAppLogJson } from './utils/log'

let quitTimeout: NodeJS.Timeout | null = null
export let mainWindow: BrowserWindow | null = null
let isCreatingWindow = false
let windowShown = false
let createWindowPromiseResolve: (() => void) | null = null
let createWindowPromise: Promise<void> | null = null

async function scheduleLightweightMode(): Promise<void> {
  const {
    autoLightweight = false,
    autoLightweightDelay = 60,
    autoLightweightMode = 'core'
  } = await getAppConfig()

  if (!autoLightweight) return

  if (quitTimeout) {
    clearTimeout(quitTimeout)
  }

  const enterLightweightMode = async (): Promise<void> => {
    if (autoLightweightMode === 'core') {
      await quitWithoutCore()
    } else if (autoLightweightMode === 'tray') {
      if (mainWindow && !mainWindow.isVisible()) {
        mainWindow.destroy()
        if (process.platform === 'darwin' && app.dock) {
          app.dock.hide()
        }
      }
    }
  }

  quitTimeout = setTimeout(enterLightweightMode, autoLightweightDelay * 1000)
}

const syncConfig = getAppConfigSync()

function exitApp(): void {
  disableSysProxySync()
  app.exit()
}

const shouldDisableTunInDev = process.platform === 'win32' && is.dev

const gotTheLock = app.requestSingleInstanceLock()

if (!gotTheLock) {
  app.quit()
}

export function customRelaunch(): void {
  const script = `while kill -0 ${process.pid} 2>/dev/null; do
  sleep 0.1
done
${process.argv.join(' ')} & disown
exit
`
  spawn('sh', ['-c', `"${script}"`], {
    shell: true,
    detached: true,
    stdio: 'ignore'
  })
}

if (process.platform === 'linux') {
  app.relaunch = customRelaunch
}

const electronMajor = parseInt(process.versions.electron.split('.')[0], 10) || 0

if (process.platform === 'win32' && !exePath().startsWith('C') && electronMajor < 38) {
  // https://github.com/electron/electron/issues/43278
  // https://github.com/electron/electron/issues/36698
  app.commandLine.appendSwitch('in-process-gpu')
}

const initPromise = init()

if (syncConfig.disableGPU) {
  app.disableHardwareAcceleration()
}

app.on('second-instance', async (_event, commandline) => {
  showMainWindow()
  const url = commandline.pop()
  if (url) {
    await handleDeepLink(url)
  }
})

app.on('open-url', async (_event, url) => {
  showMainWindow()
  await handleDeepLink(url)
})

let isQuitting = false,
  notQuitDialog = false

let lastQuitAttempt = 0

export function setNotQuitDialog(): void {
  notQuitDialog = true
}

function showWindow(): number {
  if (mainWindow) {
    if (mainWindow.isMinimized()) {
      mainWindow.restore()
    } else if (!mainWindow.isVisible()) {
      mainWindow.show()
    }
    mainWindow.focusOnWebView()
    mainWindow.setAlwaysOnTop(true, 'pop-up-menu')
    mainWindow.focus()
    mainWindow.setAlwaysOnTop(false)

    if (!mainWindow.isMinimized()) {
      return 100
    }
  }
  return 500
}

function showQuitConfirmDialog(): Promise<boolean> {
  return new Promise((resolve) => {
    if (!mainWindow) {
      resolve(true)
      return
    }

    const delay = showWindow()
    setTimeout(() => {
      mainWindow?.webContents.send('show-quit-confirm')
      const handleQuitConfirm = (_event: Electron.IpcMainEvent, confirmed: boolean): void => {
        ipcMain.off('quit-confirm-result', handleQuitConfirm)
        resolve(confirmed)
      }
      ipcMain.once('quit-confirm-result', handleQuitConfirm)
    }, delay)
  })
}

app.on('window-all-closed', () => {
  // Don't quit app when all windows are closed
})

app.on('before-quit', async (e) => {
  if (!isQuitting && !notQuitDialog) {
    e.preventDefault()

    const now = Date.now()
    if (now - lastQuitAttempt < 500) {
      isQuitting = true
      if (quitTimeout) {
        clearTimeout(quitTimeout)
        quitTimeout = null
      }
      await triggerSysProxy(false, false)
      await stopCore()
      exitApp()
      return
    }
    lastQuitAttempt = now

    const confirmed = await showQuitConfirmDialog()

    if (confirmed) {
      isQuitting = true
      if (quitTimeout) {
        clearTimeout(quitTimeout)
        quitTimeout = null
      }
      await triggerSysProxy(false, false)
      await stopCore()
      exitApp()
    }
  } else if (notQuitDialog) {
    isQuitting = true
    if (quitTimeout) {
      clearTimeout(quitTimeout)
      quitTimeout = null
    }
    await triggerSysProxy(false, false)
    await stopCore()
    exitApp()
  }
})

powerMonitor.on('shutdown', async () => {
  if (quitTimeout) {
    clearTimeout(quitTimeout)
    quitTimeout = null
  }
  await appendAppLogJson({
    timestamp: new Date().toISOString(),
    level: 'info',
    module: 'Main',
    message: 'System shutdown signal received, stopping core and proxy'
  })
  await triggerSysProxy(false, false, true)
  await stopCore()
  exitApp()
})

// 防抖定时器：用于区分真实 suspend 和硬件/驱动误发的假信号。
// 某些老旧硬件（如 ThinkPad E450）的电源管理芯片或网卡驱动会在高负载场景下
// 误发 suspend 广播，但系统内核并未真正进入低功耗状态（SleepStudy 无记录）。
// 收到信号后进入观察期：若期间收到 resume 则取消操作；
// 若观察期结束进程仍在运行，说明是假信号，也取消操作。
let suspendDebounceTimer: NodeJS.Timeout | null = null
const SUSPEND_DEBOUNCE_MS = 3000

powerMonitor.on('suspend', async () => {
  if (quitTimeout) {
    clearTimeout(quitTimeout)
    quitTimeout = null
  }

  // 清除上一次未触发的防抖定时器
  if (suspendDebounceTimer) {
    clearTimeout(suspendDebounceTimer)
    suspendDebounceTimer = null
  }

  const suspendTimestamp = new Date().toISOString()
  await appendAppLogJson({
    timestamp: suspendTimestamp,
    level: 'info',
    module: 'Main',
    message: 'Suspend signal received, entering debounce window',
    data: { debounceMs: SUSPEND_DEBOUNCE_MS }
  })

  // 捕获 powercfg /requests 快照，帮助诊断是谁/什么驱动触发了休眠
  try {
    const { exec } = await import('child_process')
    const { promisify } = await import('util')
    const execAsync = promisify(exec)
    const { stdout } = await execAsync('powercfg /requests', { timeout: 5000 })
    await appendAppLogJson({
      timestamp: new Date().toISOString(),
      level: 'info',
      module: 'Main',
      message: 'Powercfg requests snapshot at suspend',
      data: { powercfgRequests: stdout }
    })
  } catch (e) {
    await appendAppLogJson({
      timestamp: new Date().toISOString(),
      level: 'warn',
      module: 'Main',
      message: 'Failed to capture powercfg /requests during suspend',
      error: e instanceof Error ? e.message : String(e)
    })
  }

  // 防抖：延迟执行 stopCore，给 resume 事件一个取消的机会
  suspendDebounceTimer = setTimeout(async () => {
    suspendDebounceTimer = null
    await appendAppLogJson({
      timestamp: new Date().toISOString(),
      level: 'info',
      module: 'Main',
      message: 'Debounce window elapsed, system is truly suspending, stopping core and proxy'
    })
    await triggerSysProxy(false, false, true)
    await stopCore()
  }, SUSPEND_DEBOUNCE_MS)
})

// 系统唤醒后重建命名管道连接并重启核心。
// 同时用于取消 suspend 防抖：如果在观察期内收到 resume，说明是假信号。
// 等待网络栈稳定（2s）后再操作，避免 WLAN 接口尚未就绪导致 post-up 超时。
powerMonitor.on('resume', async () => {
  // 如果防抖定时器还在，说明是假 suspend 信号，取消 stopCore
  if (suspendDebounceTimer) {
    clearTimeout(suspendDebounceTimer)
    suspendDebounceTimer = null
    await appendAppLogJson({
      timestamp: new Date().toISOString(),
      level: 'info',
      module: 'Main',
      message: 'False suspend detected: resume received within debounce window, core stop cancelled'
    })
    return
  }

  await appendAppLogJson({
    timestamp: new Date().toISOString(),
    level: 'info',
    module: 'Main',
    message: 'System resumed, restarting core after network settles'
  })
  // 设置系统唤醒标志，防止 WebSocket 重连在等待期间触发多余的
  // resumeServiceCoreAfterReconnect → startCore() 调用，导致两路并行启动竞争。
  setSystemIsResuming(true)
  // 给网络栈和 WLAN 接口一点恢复时间
  await new Promise((resolve) => setTimeout(resolve, 2000))
  try {
    const promises = await startCore()
    await Promise.all(promises)
    await appendAppLogJson({
      timestamp: new Date().toISOString(),
      level: 'info',
      module: 'Main',
      message: 'Core restarted successfully after resume'
    })
  } catch (e) {
    await appendAppLogJson({
      timestamp: new Date().toISOString(),
      level: 'error',
      module: 'Main',
      message: 'Core restart after resume failed',
      error: e instanceof Error ? e.message : String(e),
      stack: e instanceof Error ? e.stack : undefined
    })
    dialog.showErrorBox('内核启动出错', `系统唤醒后内核启动失败：${e instanceof Error ? e.message : String(e)}`)
  } finally {
    setSystemIsResuming(false)
  }
})

app.on('will-quit', () => {
  disableSysProxySync()
})

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(async () => {
  // Set app user model id for windows
  electronApp.setAppUserModelId('sparkle.app')
  try {
    await initPromise
    if (shouldDisableTunInDev) {
      await patchControledMihomoConfig({ tun: { enable: false } })
    }
  } catch (e) {
    dialog.showErrorBox('应用初始化失败', `${e}`)
    app.quit()
    return
  }

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })
  const appConfig = await getAppConfig()
  const { showFloatingWindow: showFloating = false, disableTray = false } = appConfig
  registerIpcMainHandlers()

  const createWindowPromise = createWindow(appConfig)

  let coreStarted = false

  const coreStartPromise = (async (): Promise<void> => {
    try {
      const [startPromise] = await startCore()
      startPromise.then(async () => {
        await initProfileUpdater()
      })
      coreStarted = true
    } catch (e) {
      dialog.showErrorBox('内核启动出错', `${e}`)
    }
  })()

  const monitorPromise = (async (): Promise<void> => {
    try {
      await startMonitor()
    } catch {
      // ignore
    }
  })()

  // 网络接口变化监控（仅 Windows）：监听 TUN 虚拟网卡和物理网卡的状态变化，
  // 帮助诊断断流是否由网络接口闪断引起。
  // 日志写入 userData/network_evidence.log
  if (process.platform === 'win32') {
    const networkEvidencePath = join(app.getPath('userData'), 'network_evidence.log')

    // 启动一个后台 PowerShell 进程，通过 WMI 监听网络接口状态变化
    const psScript = `
      $logPath = '${networkEvidencePath.replace(/'/g, "''")}'
      Register-WmiEvent -Query "SELECT * FROM __InstanceModificationEvent WITHIN 2 WHERE TargetInstance ISA 'Win32_NetworkAdapter' AND TargetInstance.NetConnectionStatus != PreviousInstance.NetConnectionStatus" -Action {
        $adapter = $Event.SourceEventArgs.NewEvent.TargetInstance
        $status = if ($adapter.NetConnectionStatus -eq 2) { "Connected" } else { "Disconnected/Error: $($adapter.NetConnectionStatus)" }
        $time = Get-Date -Format "yyyy-MM-dd HH:mm:ss.fff"
        $msg = "[$time] NETWORK_ADAPTER_CHANGE: $($adapter.Name) (${'$'}{$adapter.DeviceID}) -> $status"
        Add-Content -Path $logPath -Value $msg
      } | Out-Null
      # Keep process alive
      while($true) { Start-Sleep -Seconds 10 }
    `
    const psProcess = spawn('powershell', ['-NoProfile', '-Command', psScript], {
      detached: true,
      stdio: 'ignore'
    })
    psProcess.unref()
    appendAppLogJson({
      timestamp: new Date().toISOString(),
      level: 'info',
      module: 'Main',
      message: 'Network adapter change monitor started (WMI)',
      data: { pid: psProcess.pid, logPath: networkEvidencePath }
    }).catch(() => { })
  }

  await createWindowPromise

  const uiTasks: Promise<void>[] = [initShortcut()]

  if (showFloating) {
    uiTasks.push(Promise.resolve(showFloatingWindow()))
  }
  if (!disableTray) {
    uiTasks.push(createTray())
  }

  await Promise.all(uiTasks)

  await Promise.all([coreStartPromise, monitorPromise])

  if (coreStarted) {
    mainWindow?.webContents.send('core-started')
  }

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    showMainWindow()
  })
})

async function handleDeepLink(url: string): Promise<void> {
  if (!url.startsWith('clash://') && !url.startsWith('mihomo://') && !url.startsWith('sparkle://'))
    return

  const urlObj = new URL(url)
  switch (urlObj.host) {
    case 'install-config': {
      try {
        const profileUrl = urlObj.searchParams.get('url')
        const profileName = urlObj.searchParams.get('name')
        if (!profileUrl) {
          throw new Error('缺少参数 url')
        }

        const confirmed = await showProfileInstallConfirm(profileUrl, profileName)

        if (confirmed) {
          await addProfileItem({
            type: 'remote',
            name: profileName ?? undefined,
            url: profileUrl
          })
          mainWindow?.webContents.send('profileConfigUpdated')
          new Notification({ title: '订阅导入成功' }).show()
        }
      } catch (e) {
        dialog.showErrorBox('订阅导入失败', `${url}\n${e}`)
      }
      break
    }
    case 'install-override': {
      try {
        const urlParam = urlObj.searchParams.get('url')
        const profileName = urlObj.searchParams.get('name')
        if (!urlParam) {
          throw new Error('缺少参数 url')
        }

        const confirmed = await showOverrideInstallConfirm(urlParam, profileName)

        if (confirmed) {
          const url = new URL(urlParam)
          const name = url.pathname.split('/').pop()
          await addOverrideItem({
            type: 'remote',
            name: profileName ?? (name ? decodeURIComponent(name) : undefined),
            url: urlParam,
            ext: url.pathname.endsWith('.js') ? 'js' : 'yaml'
          })
          mainWindow?.webContents.send('overrideConfigUpdated')
          new Notification({ title: '覆写导入成功' }).show()
        }
      } catch (e) {
        dialog.showErrorBox('覆写导入失败', `${url}\n${e}`)
      }
      break
    }
  }
}

async function showProfileInstallConfirm(url: string, name?: string | null): Promise<boolean> {
  if (!mainWindow) {
    await createWindow()
  }
  let extractedName = name

  if (!extractedName) {
    try {
      const axios = (await import('axios')).default
      const response = await axios.head(url, {
        headers: {
          'User-Agent': await getUserAgent()
        },
        timeout: 5000
      })

      if (response.headers['content-disposition']) {
        extractedName = parseFilename(response.headers['content-disposition'])
      }
    } catch (error) {
      // ignore
    }
  }

  return new Promise((resolve) => {
    const delay = showWindow()
    setTimeout(() => {
      mainWindow?.webContents.send('show-profile-install-confirm', {
        url,
        name: extractedName || name
      })
      const handleConfirm = (_event: Electron.IpcMainEvent, confirmed: boolean): void => {
        ipcMain.off('profile-install-confirm-result', handleConfirm)
        resolve(confirmed)
      }
      ipcMain.once('profile-install-confirm-result', handleConfirm)
    }, delay)
  })
}

function parseFilename(str: string): string {
  if (str.match(/filename\*=.*''/)) {
    const filename = decodeURIComponent(str.split(/filename\*=.*''/)[1])
    return filename
  } else {
    const filename = str.split('filename=')[1]
    return filename?.replace(/"/g, '') || ''
  }
}

async function showOverrideInstallConfirm(url: string, name?: string | null): Promise<boolean> {
  if (!mainWindow) {
    await createWindow()
  }
  return new Promise((resolve) => {
    let finalName = name
    if (!finalName) {
      const urlObj = new URL(url)
      const pathName = urlObj.pathname.split('/').pop()
      finalName = pathName ? decodeURIComponent(pathName) : undefined
    }

    const delay = showWindow()
    setTimeout(() => {
      mainWindow?.webContents.send('show-override-install-confirm', {
        url,
        name: finalName
      })
      const handleConfirm = (_event: Electron.IpcMainEvent, confirmed: boolean): void => {
        ipcMain.off('override-install-confirm-result', handleConfirm)
        resolve(confirmed)
      }
      ipcMain.once('override-install-confirm-result', handleConfirm)
    }, delay)
  })
}

export async function createWindow(appConfig?: AppConfig): Promise<void> {
  if (isCreatingWindow) {
    if (createWindowPromise) {
      await createWindowPromise
    }
    return
  }
  isCreatingWindow = true
  createWindowPromise = new Promise<void>((resolve) => {
    createWindowPromiseResolve = resolve
  })
  try {
    const config = appConfig ?? (await getAppConfig())
    const { useWindowFrame = false } = config

    const [mainWindowState] = await Promise.all([
      Promise.resolve(
        windowStateKeeper({
          defaultWidth: 800,
          defaultHeight: 700,
          file: 'window-state.json'
        })
      ),
      process.platform === 'darwin'
        ? createApplicationMenu()
        : Promise.resolve(Menu.setApplicationMenu(null))
    ])
    mainWindow = new BrowserWindow({
      minWidth: 800,
      minHeight: 600,
      width: mainWindowState.width,
      height: mainWindowState.height,
      x: mainWindowState.x,
      y: mainWindowState.y,
      show: false,
      frame: useWindowFrame,
      fullscreenable: false,
      titleBarStyle: useWindowFrame ? 'default' : 'hidden',
      titleBarOverlay: useWindowFrame
        ? false
        : {
          height: 49
        },
      autoHideMenuBar: true,
      ...(process.platform === 'linux' ? { icon: icon } : {}),
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        spellcheck: false,
        sandbox: false,
        ...(is.dev ? { webSecurity: false } : {})
      }
    })
    mainWindowState.manage(mainWindow)

    // 底层 Windows 电源广播钩子 (WM_POWERBROADCAST = 0x0218)
    // 用于捕获原始电源事件，与 Electron powerMonitor 对比验证。
    // 日志写入 userData/power_evidence.log，不依赖 app 日志系统。
    const powerEvidencePath = join(app.getPath('userData'), 'power_evidence.log')
    const wmPowerbroadcast = 0x0218
    const PBT_APMSUSPEND = 0x0004
    const PBT_APMRESUMEAUTOMATIC = 0x0012
    const PBT_APMPOWERSTATUSCHANGE = 0x000A
    const PBT_APMRESUMESUSPEND = 0x0007
    const PBT_APMQUERYSUSPEND = 0x0000
    const PBT_APMQUERYSUSPENDFAILED = 0x0002

    mainWindow.hookWindowMessage(wmPowerbroadcast, (wParam, _lParam) => {
      const wp = wParam.readUInt32LE(0)
      let eventName = 'UNKNOWN'
      switch (wp) {
        case PBT_APMSUSPEND:
          eventName = 'PBT_APMSUSPEND (system suspending)'
          break
        case PBT_APMRESUMEAUTOMATIC:
          eventName = 'PBT_APMRESUMEAUTOMATIC (system resumed)'
          break
        case PBT_APMRESUMESUSPEND:
          eventName = 'PBT_APMRESUMESUSPEND (system resumed after suspend)'
          break
        case PBT_APMPOWERSTATUSCHANGE:
          eventName = 'PBT_APMPOWERSTATUSCHANGE (power status changed)'
          break
        case PBT_APMQUERYSUSPEND:
          eventName = 'PBT_APMQUERYSUSPEND (system querying suspend)'
          break
        case PBT_APMQUERYSUSPENDFAILED:
          eventName = 'PBT_APMQUERYSUSPENDFAILED (suspend query denied)'
          break
      }
      const logLine = `[${new Date().toISOString()}] WM_POWERBROADCAST wParam=0x${wp.toString(16)} -> ${eventName}\n`
      try {
        appendFileSync(powerEvidencePath, logLine)
      } catch {
        // ignore write errors
      }
    })

    mainWindow.on('ready-to-show', async () => {
      const { silentStart = false } = await getAppConfig()
      if (!silentStart) {
        if (quitTimeout) {
          clearTimeout(quitTimeout)
        }
        windowShown = true
        mainWindow?.show()
        mainWindow?.focusOnWebView()
      } else {
        await scheduleLightweightMode()
      }
    })
    // did-fail-load 重试保护：避免因代理核心启动修改系统代理导致无限重载循环
    // 当 mihomo 核心启动时，系统代理变更会使 Chromium 触发 ERR_NETWORK_CHANGED，
    // 导致页面加载失败。这里限制最大重试次数，避免无限循环。
    let failLoadRetryCount = 0
    const MAX_FAIL_LOAD_RETRIES = 3
    mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
      if (failLoadRetryCount < MAX_FAIL_LOAD_RETRIES) {
        failLoadRetryCount++
        mainWindow?.webContents.reload()
      } else {
        appendAppLogJson({
          timestamp: new Date().toISOString(),
          level: 'error',
          module: 'Main',
          message: 'did-fail-load exceeded max retries',
          data: { errorCode, errorDescription, maxRetries: MAX_FAIL_LOAD_RETRIES }
        }).catch(() => { })
      }
    })
    // 页面加载成功后重置重试计数
    mainWindow.webContents.on('did-finish-load', () => {
      failLoadRetryCount = 0
    })

    mainWindow.on('close', async (event) => {
      event.preventDefault()
      mainWindow?.hide()
      if (windowShown) {
        await scheduleLightweightMode()
      }
    })

    mainWindow.on('closed', () => {
      mainWindow = null
    })

    mainWindow.on('resized', () => {
      if (mainWindow) mainWindowState.saveState(mainWindow)
    })

    mainWindow.on('unmaximize', () => {
      if (mainWindow) mainWindowState.saveState(mainWindow)
    })

    mainWindow.on('move', () => {
      if (mainWindow) mainWindowState.saveState(mainWindow)
    })

    mainWindow.on('session-end', async () => {
      await triggerSysProxy(false, false, true)
      await stopCore()
    })

    mainWindow.webContents.setWindowOpenHandler((details) => {
      shell.openExternal(details.url)
      return { action: 'deny' }
    })
    // HMR for renderer base on electron-vite cli.
    // Load the remote URL for development or the local html file for production.
    if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
      mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
    } else {
      mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
    }
  } finally {
    isCreatingWindow = false
    if (createWindowPromiseResolve) {
      createWindowPromiseResolve()
      createWindowPromiseResolve = null
    }
    createWindowPromise = null
  }
}

export async function triggerMainWindow(): Promise<void> {
  if (mainWindow && mainWindow.isVisible()) {
    closeMainWindow()
  } else {
    await showMainWindow()
  }
}

export async function showMainWindow(): Promise<void> {
  if (quitTimeout) {
    clearTimeout(quitTimeout)
  }
  if (process.platform === 'darwin' && app.dock) {
    const { useDockIcon = true } = await getAppConfig()
    if (!useDockIcon) {
      app.dock.hide()
    }
  }
  if (mainWindow) {
    windowShown = true
    mainWindow.show()
    mainWindow.focusOnWebView()
  } else {
    await createWindow()
    if (mainWindow !== null) {
      windowShown = true
        ; (mainWindow as BrowserWindow).show()
        ; (mainWindow as BrowserWindow).focusOnWebView()
    }
  }
}

export function closeMainWindow(): void {
  if (mainWindow) {
    mainWindow.close()
  }
}
