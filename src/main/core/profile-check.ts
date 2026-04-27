import { execFile } from 'child_process'
import path from 'path'
import { promisify } from 'util'
import { createHash } from 'crypto'
import { mkdir, readFile } from 'fs/promises'
import { accessSync, existsSync, constants } from 'fs'
import { getAppConfig, getProfileConfig } from '../config'
import { mihomoCorePath, mihomoTestDir, mihomoWorkConfigPath } from '../utils/dirs'

const PROFILE_CHECK_TIMEOUT = 10000 // 10 seconds timeout for mihomo -t

// Cache for profile hash to skip redundant checks
let lastProfileHash: string | undefined
let lastProfileCheckPassed = false

/**
 * Compute SHA256 hash of the config file content.
 * Returns undefined if the file doesn't exist.
 */
async function computeProfileHash(id: string | undefined, diffWorkDir: boolean): Promise<string | undefined> {
  const configPath = diffWorkDir ? mihomoWorkConfigPath(id) : mihomoWorkConfigPath('work')
  try {
    const content = await readFile(configPath)
    return createHash('sha256').update(content).digest('hex')
  } catch {
    return undefined
  }
}

/**
 * Check profile configuration by running `mihomo -t`.
 * Uses SHA256 hash caching to skip the check if the config file hasn't changed
 * since the last successful check. Has a 10-second timeout to prevent blocking.
 */
export async function checkProfile(): Promise<void> {
  const { core = 'mihomo', diffWorkDir = false, safePaths = [] } = await getAppConfig()
  const { current } = await getProfileConfig()
  const corePath = mihomoCorePath(core)
  const execFilePromise = promisify(execFile)
  const env = {
    SAFE_PATHS: safePaths.join(path.delimiter),
    PATH: process.env.PATH
  }

  // Ensure test directory exists for mihomo -t
  const testDir = mihomoTestDir()
  await mkdir(testDir, { recursive: true }).catch(() => {})

  // Resolve config file path for the profile check
  const configPath = diffWorkDir ? mihomoWorkConfigPath(current) : mihomoWorkConfigPath('work')

  // Compute current profile hash
  const currentHash = await computeProfileHash(current, diffWorkDir)

  // If hash matches last successful check, skip the expensive mihomo -t
  if (currentHash !== undefined && lastProfileHash === currentHash && lastProfileCheckPassed) {
    return
  }

  // ── Pre-spawn environment probes ──────────────────────────────────
  // These catch permission/access issues before they become cryptic ENOENT errors.
  // On Windows, service-mode (SYSTEM) processes can lock files, causing
  // libuv to translate ERROR_ACCESS_DENIED into ENOENT.

  // Probe 1: Does the core binary exist?
  if (!existsSync(corePath)) {
    throw new Error(
      `[Env Check] 核心程序丢失: ${corePath}`
    )
  }

  // Probe 2: Does the current user have execute permission on the core binary?
  // If a SYSTEM-privilege service holds a lock, this will throw with a clear error.
  try {
    accessSync(corePath, constants.X_OK)
  } catch (accessError) {
    throw new Error(
      `[Env Check] 核心程序无执行权限或被高权限进程锁死: ${corePath}\n` +
      `       ${accessError instanceof Error ? accessError.message : String(accessError)}`
    )
  }

  // Probe 3: Does the config file exist?
  if (!existsSync(configPath)) {
    throw new Error(
      `[Env Check] 配置文件不存在，无法执行配置校验: ${configPath}`
    )
  }

  // Probe 4: Does the work directory exist?
  if (!existsSync(testDir)) {
    throw new Error(
      `[Env Check] 工作目录不存在，可能导致 spawn 失败: ${testDir}`
    )
  }

  // ── All probes passed, proceed to spawn ───────────────────────────
  try {
    await execFilePromise(
      corePath,
      ['-t', '-f', configPath, '-d', testDir],
      { env, timeout: PROFILE_CHECK_TIMEOUT }
    )

    // Cache the successful hash
    if (currentHash !== undefined) {
      lastProfileHash = currentHash
      lastProfileCheckPassed = true
    }
  } catch (error) {
    if (error instanceof Error && 'stdout' in error) {
      const execFileError = error as unknown as { stdout: string; stderr: string; code?: number | string; signal?: string | null }
      const { stdout, stderr, code, signal } = execFileError

      // Try to extract structured error lines from stdout first
      const stdoutErrorLines = stdout
        .split('\n')
        .filter((line) => line.includes('level=error'))
        .map((line) => line.split('level=error')[1])

      if (stdoutErrorLines.length > 0) {
        throw new Error(`Profile Check Failed:\n${stdoutErrorLines.join('\n')}`)
      }

      // Fall back to stderr if stdout had no level=error lines
      const stderrErrorLines = stderr
        .split('\n')
        .filter((line) => line.includes('level=error'))
        .map((line) => line.split('level=error')[1])

      if (stderrErrorLines.length > 0) {
        throw new Error(`Profile Check Failed:\n${stderrErrorLines.join('\n')}`)
      }

      // If neither had structured error lines, include the full raw output for diagnosis
      const rawOutput = [stdout, stderr]
        .filter(Boolean)
        .join('\n')
        .trim()
      if (rawOutput) {
        throw new Error(`Profile Check Failed:\n${rawOutput}`)
      }

      // No output at all — include exit code and signal for forensic diagnosis
      const exitInfo = signal
        ? `exited with code: ${code}, signal: ${signal}`
        : `exited with code: ${code}`
      throw new Error(
        `Profile Check Failed: Unknown error (mihomo -t ${exitInfo}, no error output captured)`
      )
    } else if (error instanceof Error && error.message.includes('timeout')) {
      // Timeout: log warning but don't block startup - config may still be valid
      // The core will fail to start if config is truly invalid
      console.warn(`[ProfileCheck]: mihomo -t timed out after ${PROFILE_CHECK_TIMEOUT}ms, skipping check`)
      // Don't cache on timeout - next startup will re-check
      return
    } else {
      throw error
    }
  }
}

/**
 * Reset the profile check cache. Should be called when profile config changes
 * (e.g., when switching profiles or updating profile content).
 */
export function resetProfileCheckCache(): void {
  lastProfileHash = undefined
  lastProfileCheckPassed = false
}
