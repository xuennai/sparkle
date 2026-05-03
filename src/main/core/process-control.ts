import type { ChildProcess } from 'child_process'
import { appendAppLog } from '../utils/log'

/**
 * Gracefully stop a child process with a three-stage timeout:
 * 1. SIGINT  (3s) – allow graceful shutdown
 * 2. SIGTERM (3s) – escalate
 * 3. SIGKILL (6s) – force kill
 *
 * After the process exits, waits an additional 1000ms to allow the OS
 * (especially Windows NDIS / WinTun stack) to release network handles
 * and free TCP ports from TIME_WAIT state.
 *
 * Returns the exit info: { wasDeadlocked, signal } so callers can decide
 * whether to trigger ghost-TUN cleanup.
 */
export interface StopChildProcessResult {
  /** true if the process had to be SIGKILL'd (possible NDIS deadlock) */
  wasDeadlocked: boolean
  /** The signal that finally terminated the process, or null if exited cleanly */
  finalSignal: string | null
}

export async function stopChildProcess(
  process: ChildProcess
): Promise<StopChildProcessResult> {
  // Default result: clean exit
  const result: StopChildProcessResult = {
    wasDeadlocked: false,
    finalSignal: null
  }

  if (!process || process.killed) {
    return result
  }

  const pid = process.pid
  if (!pid) {
    return result
  }

  return new Promise<StopChildProcessResult>((resolve) => {
    let isResolved = false
    const timers: NodeJS.Timeout[] = []

    const resolveOnce = (deadlocked: boolean, signal: string | null): void => {
      if (!isResolved) {
        isResolved = true
        timers.forEach((timer) => clearTimeout(timer))
        result.wasDeadlocked = deadlocked
        result.finalSignal = signal
        resolve(result)
      }
    }

    // Register exit listeners BEFORE any cleanup to avoid race conditions
    process.once('close', () => {
      resolveOnce(false, null)
    })
    process.once('exit', () => {
      resolveOnce(false, null)
    })

    try {
      // Stage 1: SIGINT – graceful shutdown
      process.kill('SIGINT')

      // Stage 2: after 3s, escalate to SIGTERM
      const timer1 = setTimeout(async () => {
        if (!process.killed && !isResolved) {
          try {
            if (pid) {
              globalThis.process.kill(pid, 0)
              process.kill('SIGTERM')
            }
          } catch {
            resolveOnce(false, null)
          }
        }
      }, 3000)
      timers.push(timer1)

      // Stage 3: after 6s total, force SIGKILL (deadlock detected)
      const timer2 = setTimeout(async () => {
        if (!process.killed && !isResolved) {
          try {
            if (pid) {
              globalThis.process.kill(pid, 0)
              process.kill('SIGKILL')
              await appendAppLog(
                `[Manager]: Force killed process ${pid} with SIGKILL (possible NDIS deadlock)\n`
              )
              // Mark as deadlocked so caller can trigger ghost-TUN cleanup
              resolveOnce(true, 'SIGKILL')
            }
          } catch {
            resolveOnce(false, null)
          }
        }
      }, 6000)
      timers.push(timer2)

      // Stage 4: after 10s total, force resolve even if process is a zombie
      // that doesn't emit close/exit events. This prevents the caller from
      // hanging forever when the mihomo kernel becomes a zombie process
      // after a deadlock (signals are accepted by the zombie PID but the
      // process has already exited, so close/exit events never fire).
      const timer3 = setTimeout(async () => {
        if (!isResolved) {
          await appendAppLog(
            `[Manager]: ⚠️ [Rescue] Process ${pid} did not emit close/exit within 10s ` +
            `(possible zombie), force-resolving with deadlock=true\n`
          )
          // Last resort: use Windows taskkill /F to forcefully terminate
          // the zombie process, since signals (SIGINT/SIGTERM/SIGKILL) are
          // accepted by the zombie PID but have no effect.
          if (globalThis.process.platform === 'win32') {
            try {
              const { execSync } = await import('child_process')
              execSync(`taskkill /F /PID ${pid}`, { windowsHide: true, timeout: 5000 })
              await appendAppLog(
                `[Manager]: ✅ [Rescue] taskkill /F succeeded for zombie pid ${pid}\n`
              )
            } catch (killError) {
              await appendAppLog(
                `[Manager]: ❌ [Rescue] taskkill /F failed for zombie pid ${pid}: ${killError}\n`
              )
            }
          }
          resolveOnce(true, 'SIGKILL')
        }
      }, 10000)
      timers.push(timer3)
    } catch (error) {
      resolveOnce(false, null)
    }
  })
}
