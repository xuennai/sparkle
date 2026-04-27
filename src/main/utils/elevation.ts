import { execFile, execSync } from 'child_process'
import { app } from 'electron'
import { promisify } from 'util'

const execFilePromise = promisify(execFile)

let isAdminCached: boolean | null = null

async function isRunningAsAdmin(): Promise<boolean> {
  if (isAdminCached !== null) {
    return isAdminCached
  }

  try {
    await execFilePromise('net', ['session'], { timeout: 2000 })
    isAdminCached = true
    return true
  } catch {
    isAdminCached = false
    return false
  }
}

export { isRunningAsAdmin }

/**
 * Synchronously check if the current process is running with administrator
 * privileges on Windows. Uses `net session` which requires elevation.
 * On non-Windows platforms, always returns true.
 */
export function isRunningAsAdminSync(): boolean {
  if (process.platform !== 'win32') return true
  try {
    execSync('net session', { timeout: 2000, stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

/**
 * Relaunch the current application with administrator privileges on Windows.
 * Uses PowerShell `Start-Process -Verb RunAs` to trigger the UAC prompt.
 *
 * The relaunched process will include `--admin-relaunch` in its argv so the
 * new instance can detect it was spawned with admin rights.
 *
 * On non-Windows platforms, this function does nothing (returns immediately).
 */
export async function relaunchAsAdmin(): Promise<void> {
  if (process.platform !== 'win32') return

  const execPath = app.getPath('exe')
  // Collect original CLI args, stripping any previous admin-relaunch flag
  const originalArgs = process.argv
    .slice(1)
    .filter((a) => a !== '--admin-relaunch')
  // Mark this as an admin relaunch so the new process can detect it
  const args = [...originalArgs, '--admin-relaunch']

  // Build a safe PowerShell command: use single quotes with escaping
  const escapedExe = execPath.replace(/'/g, "''")
  const psArgs = args
    .map((arg) => {
      const escaped = arg.replace(/'/g, "''")
      return `'${escaped}'`
    })
    .join(',')

  // Start a new elevated process (caller will exit shortly after)
  await execFilePromise('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    `Start-Process -FilePath '${escapedExe}' -ArgumentList @(${psArgs}) -Verb RunAs -WindowStyle Normal`
  ])
}

function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`
}

function appleScriptQuote(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

export async function execWithElevation(command: string, args: string[]): Promise<void> {
  if (process.platform === 'win32') {
    try {
      if (await isRunningAsAdmin()) {
        await execFilePromise(command, args, { timeout: 30000 })
      } else {
        const escapedCommand = command.replace(/'/g, "''")
        const psArgs = args
          .map((arg) => {
            const escaped = arg.replace(/'/g, "''")
            return `'${escaped}'`
          })
          .join(',')
        await execFilePromise(
          'powershell.exe',
          [
            '-NoProfile',
            '-ExecutionPolicy',
            'Bypass',
            '-Command',
            `& { $p = Start-Process -FilePath '${escapedCommand}' -ArgumentList @(${psArgs}) -Verb RunAs -WindowStyle Hidden -PassThru -Wait; exit $p.ExitCode }`
          ],
          { timeout: 30000 }
        )
      }
    } catch (error) {
      throw new Error(
        `Windows 提权执行失败：${error instanceof Error ? error.message : String(error)}`
      )
    }
  } else if (process.platform === 'linux') {
    try {
      await execFilePromise('pkexec', [command, ...args])
    } catch (error) {
      throw new Error(
        `Linux 提权执行失败：${error instanceof Error ? error.message : String(error)}`
      )
    }
  } else if (process.platform === 'darwin') {
    const cmd = [command, ...args].map(shellQuote).join(' ')
    try {
      await execFilePromise('osascript', [
        '-e',
        `do shell script "${appleScriptQuote(cmd)}" with administrator privileges`
      ])
    } catch (error) {
      throw new Error(
        `macOS 提权执行失败：${error instanceof Error ? error.message : String(error)}`
      )
    }
  }
}
