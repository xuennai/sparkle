import { execFile } from 'child_process'
import { net } from 'electron'
import os from 'os'
import { promisify } from 'util'
import { getAppConfig, getControledMihomoConfig, patchAppConfig } from '../config'
import { setSysDns } from '../service/api'
import { triggerSysProxy } from '../sys/sysproxy'

export interface NetworkCoreController {
  shouldStartCore: (networkDownHandled: boolean) => boolean
  startCore: () => Promise<void>
  stopCore: () => Promise<void>
}

let setPublicDNSTimer: NodeJS.Timeout | null = null
let recoverDNSTimer: NodeJS.Timeout | null = null
let networkDetectionTimer: NodeJS.Timeout | null = null
let networkDownHandled = false
// 网络降级计数器：连续检测到网络不可用的次数，达到阈值后才 stopCore
// 防止物理网络切换（如以太网→WLAN）期间的短暂波动导致内核被误杀
let networkDegradedCount = 0
const NETWORK_DEGRADED_THRESHOLD = 3 // 默认 10s×3 = 30s 宽限期

/**
 * 获取当前默认路由对应的物理接口名（跨平台）。
 *
 * 用于：当 TUN auto-detect-interface 启用且用户未显式设置 interface-name 时，
 * 直接查询当前默认接口名注入到 mihomo 配置中。这样可以绕过 mihomo 的
 * cDialerInterfaceFinder.FindInterfaceName() 在物理网络切换时返回 "<invalid>"
 * 导致全局黑洞的问题。
 */
export async function getDefaultDevice(): Promise<string> {
  const execFilePromise = promisify(execFile)

  // macOS: route -n get default
  if (process.platform === 'darwin') {
    const { stdout: deviceOut } = await execFilePromise('route', ['-n', 'get', 'default'])
    let device = deviceOut.split('\n').find((s) => s.includes('interface:'))
    device = device?.trim().split(' ').slice(1).join(' ')
    if (!device) throw new Error('Get device failed')
    return device
  }

  // Windows: route print 0.0.0.0
  if (process.platform === 'win32') {
    try {
      // 1. 获取包含 0.0.0.0 的路由表
      const { stdout } = await execFilePromise('route', ['print', '0.0.0.0'])
      const lines = stdout.split('\n')

      let bestRoute: { interfaceIp: string; metric: number } | null = null

      // 2. 解析路由表，寻找跃点数最低的默认路由
      for (const line of lines) {
        const parts = line.trim().split(/\s+/)
        if (parts.length >= 5 && parts[0] === '0.0.0.0' && parts[1] === '0.0.0.0') {
          const interfaceIp = parts[3]
          const metric = parseInt(parts[4], 10)

          if (!bestRoute || metric < bestRoute.metric) {
            bestRoute = { interfaceIp, metric }
          }
        }
      }

      // 3. 拿到接口 IP 后，去系统网卡列表中匹配真正的网卡名称
      if (bestRoute) {
        const interfaces = os.networkInterfaces()
        for (const [name, ifaces] of Object.entries(interfaces)) {
          if (!ifaces) continue
          for (const iface of ifaces) {
            if (iface.family === 'IPv4' && iface.address === bestRoute.interfaceIp) {
              return name
            }
          }
        }
      }
    } catch (err) {
      // 忽略命令执行失败，直接进入下方的兜底逻辑
    }

    // 4. 兜底逻辑：找到第一个有 IPv4 的非内部接口
    const interfaces = os.networkInterfaces()
    for (const [name, ifaces] of Object.entries(interfaces)) {
      if (!ifaces) continue
      for (const iface of ifaces) {
        if (!iface.internal && iface.family === 'IPv4') {
          return name
        }
      }
    }
    throw new Error('Get device failed: no active IPv4 interface')
  }

  // Linux: ip route show default
  const { stdout } = await execFilePromise('ip', ['route', 'show', 'default'])
  const match = stdout.match(/dev\s+(\S+)/)
  if (!match?.[1]) throw new Error('Get device failed')
  return match[1]
}

async function getDefaultService(): Promise<string> {
  const execFilePromise = promisify(execFile)
  const device = await getDefaultDevice()
  const { stdout: order } = await execFilePromise('networksetup', ['-listnetworkserviceorder'])
  const block = order.split('\n\n').find((s) => s.includes(`Device: ${device}`))
  if (!block) throw new Error('Get networkservice failed')
  for (const line of block.split('\n')) {
    if (line.match(/^\(\d+\).*/)) {
      return line.trim().split(' ').slice(1).join(' ')
    }
  }
  throw new Error('Get service failed')
}

async function getOriginDNS(): Promise<void> {
  const execFilePromise = promisify(execFile)
  const service = await getDefaultService()
  const { stdout: dns } = await execFilePromise('networksetup', ['-getdnsservers', service])
  if (dns.startsWith("There aren't any DNS Servers set on")) {
    await patchAppConfig({ originDNS: 'Empty' })
  } else {
    await patchAppConfig({ originDNS: dns.trim().replace(/\n/g, ' ') })
  }
}

async function setDNS(dns: string, mode: 'none' | 'exec' | 'service'): Promise<void> {
  const service = await getDefaultService()
  const dnsServers = dns.split(' ')
  if (mode === 'exec') {
    const execFilePromise = promisify(execFile)
    await execFilePromise('networksetup', ['-setdnsservers', service, ...dnsServers])
    return
  }
  if (mode === 'service') {
    await setSysDns(service, dnsServers)
    return
  }
}

export async function setPublicDNS(): Promise<void> {
  if (process.platform !== 'darwin') return
  if (net.isOnline()) {
    const { originDNS, autoSetDNSMode = 'none' } = await getAppConfig()
    if (!originDNS) {
      await getOriginDNS()
      await setDNS('223.5.5.5', autoSetDNSMode)
    }
  } else {
    if (setPublicDNSTimer) clearTimeout(setPublicDNSTimer)
    setPublicDNSTimer = setTimeout(() => setPublicDNS(), 5000)
  }
}

export async function recoverDNS(): Promise<void> {
  if (process.platform !== 'darwin') return
  if (net.isOnline()) {
    const { originDNS, autoSetDNSMode = 'none' } = await getAppConfig()
    if (originDNS) {
      await setDNS(originDNS, autoSetDNSMode)
      await patchAppConfig({ originDNS: undefined })
    }
  } else {
    if (recoverDNSTimer) clearTimeout(recoverDNSTimer)
    recoverDNSTimer = setTimeout(() => recoverDNS(), 5000)
  }
}

export async function startNetworkDetection(controller: NetworkCoreController): Promise<void> {
  const {
    onlyActiveDevice = false,
    networkDetectionBypass = [],
    networkDetectionInterval = 10,
    sysProxy = { enable: false }
  } = await getAppConfig()
  const { tun: { device = process.platform === 'darwin' ? undefined : 'mihomo' } = {} } =
    await getControledMihomoConfig()
  if (networkDetectionTimer) {
    clearInterval(networkDetectionTimer)
  }
  const extendedBypass = networkDetectionBypass.concat(
    [device, 'lo', 'docker0', 'utun'].filter((item): item is string => item !== undefined)
  )

  networkDetectionTimer = setInterval(async () => {
    if (isAnyNetworkInterfaceUp(extendedBypass) && net.isOnline()) {
      // 网络恢复：重置降级计数器
      networkDegradedCount = 0
      if (controller.shouldStartCore(networkDownHandled)) {
        await controller.startCore()
        if (sysProxy.enable) triggerSysProxy(true, onlyActiveDevice)
        networkDownHandled = false
      }
    } else {
      networkDegradedCount++
      if (!networkDownHandled && networkDegradedCount >= NETWORK_DEGRADED_THRESHOLD) {
        // 连续多次检测到网络不可用，认为网络确实已断开
        if (sysProxy.enable) triggerSysProxy(false, onlyActiveDevice, true)
        await controller.stopCore()
        networkDownHandled = true
      }
    }
  }, networkDetectionInterval * 1000)
}

export async function stopNetworkDetection(): Promise<void> {
  if (networkDetectionTimer) {
    clearInterval(networkDetectionTimer)
    networkDetectionTimer = null
  }
  networkDegradedCount = 0
}

function isAnyNetworkInterfaceUp(excludedKeywords: string[] = []): boolean {
  const interfaces = os.networkInterfaces()
  return Object.entries(interfaces).some(([name, ifaces]) => {
    if (excludedKeywords.some((keyword) => name.includes(keyword))) return false

    return ifaces?.some((iface) => {
      return !iface.internal && (iface.family === 'IPv4' || iface.family === 'IPv6')
    })
  })
}
