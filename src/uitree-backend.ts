// Ported from dsh-ios (MIT, © 2026 ZSeven—W) @ d9a9731 — src/uitree-backend.ts
/**
 * AXe helper resolution and execution for the accessibility-tree tools.
 *
 * `ios_sim_ui_tree`, `ios_sim_tap_element`, `ios_sim_ui_rows` and
 * `ios_sim_tap_row` are built on the open-source AXe CLI
 * (github.com/cameroncooke/AXe, MIT): `describe-ui` dumps the accessibility
 * tree as JSON and `tap` drives the simulator through Apple HID.
 *
 * Resolution order (never a system-wide install):
 *   1. `IOS_SIM_AXE_BIN` (explicit override; a bad path fails, it does not fall through);
 *   2. an `axe` on PATH or in a Homebrew prefix;
 *   3. the plugin cache `<cache>/bin/axe/<version>/`, filled on demand from the
 *      pinned GitHub release. The archive's SHA-256 is pinned in source and
 *      verified after the download; the extracted binary's digest is recorded
 *      and re-checked on every later resolution.
 * `IOS_SIM_AXE_OFFLINE=1` disables the download.
 * @module ios-simulator/uitree-backend
 */

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import type { Env } from './config.js'

/** AXe release this plugin pins (supports Xcode 26 and 27). */
export const AXE_VERSION = '1.8.0'

/** Pinned release archive URL (universal binary: arm64 + x86_64). */
export const AXE_RELEASE_URL = 'https://github.com/cameroncooke/AXe/releases/download/v1.8.0/AXe-macOS-v1.8.0-universal.tar.gz'

/**
 * SHA-256 of the pinned archive (8 432 118 bytes), carried over from dsh-ios.
 * AXe publishes no official checksums, so this digest is the trust anchor.
 */
export const AXE_RELEASE_SHA256 = '7b76340b72e90d0f211bc7c4636f15009076eff07acef2f2b632b175debd8834'

/** Install hint appended to every helper-unavailable tool error. */
export const AXE_INSTALL_HINT = 'install the AXe accessibility CLI with "brew install cameroncooke/axe/axe", or let the '
  + 'plugin download the pinned release into its cache (needs network access to github.com); set IOS_SIM_AXE_BIN '
  + 'to an existing axe executable to override resolution'

const AXE_DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000
const AXE_EXEC_TIMEOUT_MS = 60_000
const AXE_MAX_BUFFER_BYTES = 32 * 1024 * 1024
const DIGEST_FILE = '.ios-simulator-axe.sha256'
/** Well-known Homebrew install locations, probed even with a trimmed PATH. */
const BREW_BIN_CANDIDATES = ['/opt/homebrew/bin/axe', '/usr/local/bin/axe']

/** One resolved AXe helper binary. */
export interface AxeBinary {
  available: boolean
  source: 'path' | 'cache' | 'unavailable'
  /** Absolute path of the executable (when available). */
  command?: string
  /** Why resolution failed (when unavailable). */
  reason?: string
}

/** One raw node of the `axe describe-ui` JSON payload. */
export interface RawAxeNode {
  type?: unknown
  AXLabel?: unknown
  AXUniqueId?: unknown
  AXValue?: unknown
  subrole?: unknown
  role?: unknown
  pid?: unknown
  focused?: unknown
  frame?: unknown
  children?: unknown
  /** AXe emits `enabled` as a JSON boolean (absent/null when unreported). */
  enabled?: unknown
  visible?: unknown
  selected?: unknown
  secure?: unknown
  // Sanitized-shape aliases make re-sanitizing a sanitized node idempotent.
  label?: unknown
  identifier?: unknown
  value?: unknown
}

/** One sanitized accessibility element (frame in device points). */
export interface AxeElement {
  type: string
  label?: string
  identifier?: string
  value?: string
  /** Flags the backend reported; absent stays undefined, never invented. */
  enabled?: boolean
  visible?: boolean
  selected?: boolean
  /** Positive-only secure-text classification. */
  secure?: boolean
  focused?: boolean
  pid?: number
  frame: { x: number; y: number; w: number; h: number }
  children: AxeElement[]
}

export interface AxeHelperOptions {
  /** Cache base; the downloaded release lands in `<cacheDir>/<version>/`. */
  cacheDir: string
  platform?: NodeJS.Platform
  env?: Env
}

function isExecutableFile(path: string): boolean {
  try {
    const info = statSync(path)
    return info.isFile() && (info.mode & 0o111) !== 0
  } catch {
    return false
  }
}

function findOnPath(command: string, env: Env): string | undefined {
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (dir === '') continue
    const candidate = join(dir, command)
    if (isExecutableFile(candidate)) return candidate
  }
  return undefined
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function run(command: string, args: readonly string[], timeoutMs: number, signal?: AbortSignal): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(command, [...args], { timeout: timeoutMs, maxBuffer: AXE_MAX_BUFFER_BYTES, signal }, (error, stdout, stderr) => {
      if (error !== null) {
        reject(Object.assign(error, { stdout, stderr }))
        return
      }
      resolve({ stdout, stderr })
    })
  })
}

export class AxeHelper {
  readonly #cacheDir: string
  readonly #platform: NodeJS.Platform
  readonly #env: Env
  #downloading: Promise<string> | undefined

  constructor(options: AxeHelperOptions) {
    this.#cacheDir = options.cacheDir
    this.#platform = options.platform ?? process.platform
    this.#env = options.env ?? process.env
  }

  #installDir(): string {
    return join(this.#cacheDir, AXE_VERSION)
  }

  #validCached(): string | undefined {
    const binary = join(this.#installDir(), 'axe')
    if (!isExecutableFile(binary)) return undefined
    try {
      const expected = readFileSync(join(this.#installDir(), DIGEST_FILE), 'utf8').trim().toLowerCase()
      if (!/^[0-9a-f]{64}$/u.test(expected)) return undefined
      return sha256File(binary) === expected ? binary : undefined
    } catch {
      return undefined
    }
  }

  /** Resolve without network access: env override → PATH → Homebrew → cache. */
  resolve(): AxeBinary {
    if (this.#platform !== 'darwin') {
      return { available: false, source: 'unavailable', reason: 'AXe only runs on macOS with Xcode' }
    }
    const explicit = this.#env.IOS_SIM_AXE_BIN?.trim()
    if (explicit !== undefined && explicit !== '') {
      if (isExecutableFile(explicit)) return { available: true, source: 'path', command: explicit }
      return {
        available: false,
        source: 'unavailable',
        reason: `IOS_SIM_AXE_BIN points at a missing or non-executable file: ${explicit}`,
      }
    }
    const onPath = findOnPath('axe', this.#env) ?? BREW_BIN_CANDIDATES.find(isExecutableFile)
    if (onPath !== undefined) return { available: true, source: 'path', command: onPath }
    const cached = this.#validCached()
    if (cached !== undefined) return { available: true, source: 'cache', command: cached }
    if (existsSync(this.#installDir())) {
      return {
        available: false,
        source: 'unavailable',
        reason: `the cached axe install under ${this.#installDir()} failed integrity verification`,
      }
    }
    return { available: false, source: 'unavailable', reason: 'no axe binary found on PATH, in Homebrew, or in the plugin cache' }
  }

  /** Resolve, downloading the pinned release when absent. Never throws. */
  async ensure(): Promise<AxeBinary> {
    const resolved = this.resolve()
    if (resolved.available || this.#platform !== 'darwin') return resolved
    if (this.#env.IOS_SIM_AXE_OFFLINE === '1') return resolved
    if (this.#env.IOS_SIM_AXE_BIN?.trim()) return resolved // a bad override is the user's to fix
    if (this.#downloading === undefined) {
      this.#downloading = this.#download().finally(() => {
        this.#downloading = undefined
      })
    }
    try {
      await this.#downloading
    } catch (error) {
      return {
        available: false,
        source: 'unavailable',
        reason: `axe download failed (${error instanceof Error ? error.message : String(error)})`,
      }
    }
    return this.resolve()
  }

  /**
   * curl the pinned tarball (system curl, so proxy variables apply), verify
   * its SHA-256, extract it, sanity-check `axe --version`, record the digest.
   */
  async #download(): Promise<string> {
    const installDir = this.#installDir()
    mkdirSync(this.#cacheDir, { recursive: true })
    const archive = join(this.#cacheDir, `.axe-${AXE_VERSION}-${process.pid}-${Date.now()}.tar.gz.tmp`)
    try {
      try {
        await run('curl', ['-fsSL', '--retry', '3', '--retry-delay', '1', '--connect-timeout', '30', '--max-time', '240',
          '-o', archive, AXE_RELEASE_URL], AXE_DOWNLOAD_TIMEOUT_MS)
      } catch (error) {
        throw new Error(`curl download failed (${error instanceof Error && error.message.includes('ETIMEDOUT') ? 'timeout' : 'HTTP or network error'})`)
      }
      const digest = sha256File(archive)
      if (digest !== AXE_RELEASE_SHA256) {
        throw new Error(`download integrity check failed: expected sha256 ${AXE_RELEASE_SHA256} but got ${digest}`)
      }
      // The tarball holds `axe`, `Frameworks/` and `AXe_AXe.bundle/`, which must stay together.
      rmSync(installDir, { recursive: true, force: true })
      mkdirSync(installDir, { recursive: true })
      await run('tar', ['-xzf', archive, '-C', installDir], AXE_DOWNLOAD_TIMEOUT_MS)
      const binary = join(installDir, 'axe')
      if (!isExecutableFile(binary)) chmodSync(binary, 0o755)
      const version = await run(binary, ['--version'], AXE_EXEC_TIMEOUT_MS)
      if (!version.stdout.includes(AXE_VERSION)) {
        throw new Error(`downloaded axe reports an unexpected version: ${version.stdout.trim()}`)
      }
      writeFileSync(join(installDir, DIGEST_FILE), `${sha256File(binary)}\n`, 'utf8')
      return binary
    } finally {
      rmSync(archive, { force: true })
    }
  }

  async #require(): Promise<AxeBinary & { command: string }> {
    const binary = await this.ensure()
    if (!binary.available || binary.command === undefined) {
      throw new Error(`the AXe accessibility helper is unavailable${binary.reason === undefined ? '' : ` (${binary.reason})`}; ${AXE_INSTALL_HINT}`)
    }
    return { ...binary, command: binary.command }
  }

  /**
   * Run one axe subcommand. A non-zero exit raises with the tool output (axe
   * prints its errors on stdout), as does an "Error:" prefix on stdout.
   */
  async exec(args: readonly string[], signal?: AbortSignal): Promise<string> {
    const binary = await this.#require()
    let stdout: string
    try {
      stdout = (await run(binary.command, args, AXE_EXEC_TIMEOUT_MS, signal)).stdout
    } catch (error) {
      const { stdout: out, stderr } = error as { stdout?: string; stderr?: string }
      const detail = out?.trim() || stderr?.trim() || ''
      throw new Error(`axe ${args.join(' ')} failed${detail === '' ? '' : `: ${detail}`}`)
    }
    if (stdout.trimStart().startsWith('Error:')) throw new Error(`axe ${args.join(' ')} failed: ${stdout.trim()}`)
    return stdout
  }

  /** The sanitized accessibility tree of a booted simulator. */
  async describeUi(udid: string, signal?: AbortSignal): Promise<AxeElement[]> {
    return parseDescribeUi(await this.exec(['describe-ui', '--udid', udid], signal))
  }

  /** HID tap at device-point coordinates. */
  async tap(udid: string, x: number, y: number, signal?: AbortSignal): Promise<void> {
    await this.exec(['tap', '-x', String(x), '-y', String(y), '--udid', udid], signal)
  }
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  // AXe reports off-screen-left frames as -0; flatten it so JSON round-trips.
  return value === 0 ? 0 : value
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/** Sanitize one raw AXe node into the plugin's element shape (idempotent). */
export function sanitizeAxeNode(raw: RawAxeNode): AxeElement {
  const rawFrame = raw.frame as { x?: unknown; y?: unknown; width?: unknown; height?: unknown; w?: unknown; h?: unknown } | undefined
  const children: AxeElement[] = []
  if (Array.isArray(raw.children)) {
    for (const child of raw.children) {
      if (typeof child === 'object' && child !== null) children.push(sanitizeAxeNode(child as RawAxeNode))
    }
  }
  const node: AxeElement = {
    type: typeof raw.type === 'string' && raw.type !== '' ? raw.type : 'Element',
    frame: {
      x: finiteNumber(rawFrame?.x) ?? 0,
      y: finiteNumber(rawFrame?.y) ?? 0,
      w: finiteNumber(rawFrame?.width ?? rawFrame?.w) ?? 0,
      h: finiteNumber(rawFrame?.height ?? rawFrame?.h) ?? 0,
    },
    children,
  }
  const label = optionalString(raw.AXLabel ?? raw.label)
  const identifier = optionalString(raw.AXUniqueId ?? raw.identifier)
  const value = optionalString(raw.AXValue ?? raw.value)
  if (label !== undefined) node.label = label
  if (identifier !== undefined) node.identifier = identifier
  if (value !== undefined) node.value = value
  // Booleans from the backend are facts; anything else stays unreported.
  if (typeof raw.enabled === 'boolean') node.enabled = raw.enabled
  if (typeof raw.visible === 'boolean') node.visible = raw.visible
  if (typeof raw.selected === 'boolean') node.selected = raw.selected
  // Secure is positive-only: a missing subrole never asserts "not secure".
  if (raw.secure === true) node.secure = true
  else if (raw.subrole === 'AXSecureTextField' || raw.role === 'AXSecureTextField') node.secure = true
  else if (typeof raw.type === 'string' && raw.type.includes('Secure')) node.secure = true
  if (typeof raw.focused === 'boolean') node.focused = raw.focused
  const pid = finiteNumber(raw.pid)
  if (pid !== undefined && Number.isSafeInteger(pid) && pid >= 0) node.pid = pid
  return node
}

/** Parse `axe describe-ui` stdout: a JSON array with one root per on-screen app. */
export function parseDescribeUi(stdout: string): AxeElement[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch (error) {
    throw new Error(`axe describe-ui returned non-JSON output: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!Array.isArray(parsed)) {
    throw new Error('axe describe-ui returned an unexpected payload (expected a JSON array of application roots)')
  }
  const roots: AxeElement[] = []
  for (const entry of parsed) {
    if (typeof entry === 'object' && entry !== null) roots.push(sanitizeAxeNode(entry as RawAxeNode))
  }
  if (roots.length === 0) throw new Error('axe describe-ui returned an empty element tree')
  return roots
}
