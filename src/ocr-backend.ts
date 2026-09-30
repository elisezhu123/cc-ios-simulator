// Ported from dsh-ios (MIT, © 2026 ZSeven—W) @ d9a9731 — src/ocr-backend.ts
/**
 * Vision OCR helper: resolution, compile-on-first-use, execution, output
 * parsing and the pixel ↔ point ↔ normalized conversions behind
 * `ios_sim_find_text`, `ios_sim_tap_text` and `ios_sim_wait_for`.
 *
 * The helper is the plugin's own Swift source (`assets/ocr.swift`, Vision's
 * VNRecognizeTextRequest, accurate, zh-Hans + en-US), compiled with swiftc
 * into `<cache>/bin/ocr/<sha256(source)[0..16]>/ocr`. The slot is keyed by the
 * source hash, so an edited helper recompiles into a fresh slot; the compiled
 * binary's digest is recorded next to it and re-checked on every resolution,
 * so a corrupted artifact is rebuilt.
 *
 * COORDINATE SPACES: the helper emits boxes in IMAGE PIXELS (origin top-left).
 * The conversions go through the screenshot's own pixel size and the
 * device's point size — never a fixed 3× scale.
 * @module ios-simulator/ocr-backend
 */

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Env } from './config.js'

/** Install hint appended to every helper-unavailable tool error. */
export const OCR_INSTALL_HINT = 'the plugin compiles its bundled Vision OCR helper with swiftc on first use — '
  + 'install Xcode (or the Command Line Tools: run "xcode-select --install") so ios_sim_find_text / '
  + 'ios_sim_tap_text / ios_sim_wait_for can run'

/** Well-known swiftc locations, probed even with a trimmed PATH. */
const SWIFTC_CANDIDATES = ['/usr/bin/swiftc', '/usr/local/bin/swiftc']
const OCR_COMPILE_TIMEOUT_MS = 5 * 60 * 1000
const OCR_EXEC_TIMEOUT_MS = 120_000
const OCR_MAX_BUFFER_BYTES = 8 * 1024 * 1024
const DIGEST_FILE = '.ios-simulator-ocr.sha256'

/** One resolved OCR helper binary. */
export interface OcrBinary {
  available: boolean
  /** Absolute path of the executable (when available). */
  command?: string
  /** Why resolution failed (when unavailable). */
  reason?: string
  /** True when everything needed to compile the bundled helper exists. */
  compilable?: boolean
}

/** One OCR box: image pixels, origin top-left. */
export interface OcrRect {
  x: number
  y: number
  w: number
  h: number
}

/** One recognized text item (box in image pixels). */
export interface OcrItem {
  text: string
  confidence: number
  rect: OcrRect
}

/** A size in pixels or points (never mixed inside one computation). */
export interface PixelSize {
  width: number
  height: number
}

export interface OcrHelperOptions {
  /** Cache base; the compiled helper lands in `<cacheDir>/<hash>/ocr`. */
  cacheDir: string
  platform?: NodeJS.Platform
  env?: Env
  /** The Swift source; default `assets/ocr.swift` next to the bundle / src dir. */
  sourcePath?: string
}

function isExecutableFile(path: string): boolean {
  try {
    const info = statSync(path)
    return info.isFile() && (info.mode & 0o111) !== 0
  } catch {
    return false
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
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
    execFile(command, [...args], { timeout: timeoutMs, maxBuffer: OCR_MAX_BUFFER_BYTES, signal }, (error, stdout, stderr) => {
      if (error !== null) {
        reject(Object.assign(error, { stdout, stderr }))
        return
      }
      resolve({ stdout, stderr })
    })
  })
}

/**
 * `assets/ocr.swift` relative to this module: `dist/server.js` and
 * `src/ocr-backend.ts` both sit one level below the plugin root.
 */
export function defaultOcrSourcePath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'ocr.swift')
}

export class OcrHelper {
  readonly #cacheDir: string
  readonly #platform: NodeJS.Platform
  readonly #env: Env
  readonly #sourcePath: string
  #compiling: Promise<string> | undefined

  constructor(options: OcrHelperOptions) {
    this.#cacheDir = options.cacheDir
    this.#platform = options.platform ?? process.platform
    this.#env = options.env ?? process.env
    this.#sourcePath = options.sourcePath ?? defaultOcrSourcePath()
  }

  /** The swiftc to use: `IOS_SIM_SWIFTC` → PATH → well-known locations. */
  #swiftc(): { command?: string; reason?: string } {
    const explicit = this.#env.IOS_SIM_SWIFTC?.trim()
    if (explicit !== undefined && explicit !== '') {
      if (isExecutableFile(explicit)) return { command: explicit }
      return { reason: `IOS_SIM_SWIFTC points at a missing or non-executable file: ${explicit}` }
    }
    const onPath = findOnPath('swiftc', this.#env)
    if (onPath !== undefined) return { command: onPath }
    const known = SWIFTC_CANDIDATES.find(isExecutableFile)
    if (known !== undefined) return { command: known }
    return { reason: 'swiftc (the Swift compiler) was not found on PATH — install Xcode or the Command Line Tools' }
  }

  #slot(sourceSha256: string): string {
    return join(this.#cacheDir, sourceSha256.slice(0, 16))
  }

  /** A cached compile whose recorded digest still matches the binary's bytes. */
  #validCached(sourceSha256: string): string | undefined {
    const binary = join(this.#slot(sourceSha256), 'ocr')
    if (!isExecutableFile(binary)) return undefined
    try {
      const recorded = readFileSync(join(this.#slot(sourceSha256), DIGEST_FILE), 'utf8').trim().toLowerCase()
      if (!/^[0-9a-f]{64}$/u.test(recorded)) return undefined
      return recorded === sha256File(binary) ? binary : undefined
    } catch {
      return undefined
    }
  }

  /** Resolve without compiling: source + swiftc probe + cache validation. */
  resolve(): OcrBinary {
    if (this.#platform !== 'darwin') return { available: false, reason: 'Vision OCR only runs on macOS with Xcode' }
    if (!isFile(this.#sourcePath)) {
      return { available: false, reason: `the bundled OCR Swift source was not found at ${this.#sourcePath}` }
    }
    const cached = this.#validCached(sha256File(this.#sourcePath))
    if (cached !== undefined) return { available: true, command: cached }
    const swiftc = this.#swiftc()
    if (swiftc.command === undefined) return { available: false, reason: swiftc.reason }
    return {
      available: false,
      reason: 'the OCR helper has not been compiled into the plugin cache yet (compiled on first use)',
      compilable: true,
    }
  }

  /** Resolve, compiling the bundled source on first use. Never throws. */
  async ensure(): Promise<OcrBinary> {
    const resolved = this.resolve()
    if (resolved.available || resolved.compilable !== true) return resolved
    if (this.#compiling === undefined) {
      this.#compiling = this.#compile().finally(() => {
        this.#compiling = undefined
      })
    }
    try {
      await this.#compiling
    } catch (error) {
      return { available: false, reason: `OCR helper compilation failed (${error instanceof Error ? error.message : String(error)})` }
    }
    return this.resolve()
  }

  /**
   * swiftc -O into a temp file, sanity-launch it (no arguments → usage, exit
   * 2), then move it into its slot and record its digest.
   */
  async #compile(): Promise<string> {
    const swiftc = this.#swiftc()
    if (swiftc.command === undefined) throw new Error(swiftc.reason)
    const sourceSha256 = sha256File(this.#sourcePath)
    const cached = this.#validCached(sourceSha256)
    if (cached !== undefined) return cached
    const slot = this.#slot(sourceSha256)
    mkdirSync(slot, { recursive: true })
    const tmp = join(this.#cacheDir, `.ocr-${sourceSha256.slice(0, 16)}-${process.pid}-${Date.now()}.tmp`)
    try {
      try {
        await run(swiftc.command, ['-O', this.#sourcePath, '-o', tmp], OCR_COMPILE_TIMEOUT_MS)
      } catch (error) {
        const detail = (error as { stderr?: string }).stderr?.trim()
        throw new Error(`swiftc -O ${this.#sourcePath} failed${detail === undefined || detail === '' ? '' : `: ${detail}`}`)
      }
      try {
        await run(tmp, [], 60_000)
      } catch (error) {
        if ((error as { code?: unknown }).code !== 2) {
          throw new Error(`the compiled OCR helper failed its sanity launch: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      const binary = join(slot, 'ocr')
      renameSync(tmp, binary)
      writeFileSync(join(slot, DIGEST_FILE), `${sha256File(binary)}\n`, 'utf8')
      return binary
    } finally {
      rmSync(tmp, { force: true })
    }
  }

  /** OCR one PNG: ensure the helper, run it, parse its JSON. */
  async recognize(imagePath: string, signal?: AbortSignal): Promise<OcrItem[]> {
    const binary = await this.ensure()
    if (!binary.available || binary.command === undefined) {
      throw new Error(`the Vision OCR helper is unavailable${binary.reason === undefined ? '' : ` (${binary.reason})`}; ${OCR_INSTALL_HINT}`)
    }
    let stdout: string
    try {
      stdout = (await run(binary.command, [imagePath], OCR_EXEC_TIMEOUT_MS, signal)).stdout
    } catch (error) {
      const { stdout: out, stderr } = error as { stdout?: string; stderr?: string }
      const detail = stderr?.trim() || out?.trim() || (error instanceof Error ? error.message : String(error))
      throw new Error(`the OCR helper failed: ${detail}`)
    }
    return parseOcrOutput(stdout)
  }
}

/** Parse the helper's JSON payload into sanitized items (confidence-sorted). */
export function parseOcrOutput(stdout: string): OcrItem[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch (error) {
    throw new Error(`the OCR helper returned non-JSON output: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('the OCR helper returned an unexpected payload (expected an object with an items array)')
  }
  const record = parsed as Record<string, unknown>
  if (!Array.isArray(record.items)) {
    throw new Error('the OCR helper returned an unexpected payload (missing items array)')
  }
  const finite = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined
  const seen = new Set<string>()
  const items: OcrItem[] = []
  for (const entry of record.items) {
    if (typeof entry !== 'object' || entry === null) continue
    const raw = entry as Record<string, unknown>
    const text = typeof raw.text === 'string' ? raw.text.trim() : ''
    const confidence = finite(raw.confidence)
    const x = finite(raw.x)
    const y = finite(raw.y)
    const w = finite(raw.w)
    const h = finite(raw.h)
    if (text === '' || confidence === undefined || x === undefined || y === undefined || w === undefined || h === undefined) continue
    if (confidence < 0 || confidence > 1 || x < 0 || y < 0 || w < 0 || h < 0) continue
    // Exact-duplicate observations (same text at the same box) collapse.
    const key = `${text}\u0000${x}\u0000${y}\u0000${w}\u0000${h}`
    if (seen.has(key)) continue
    seen.add(key)
    items.push({ text, confidence, rect: { x, y, w, h } })
  }
  // Highest confidence first (stable: equal confidence keeps Vision order).
  items.sort((a, b) => b.confidence - a.confidence)
  return items
}

/** Case-insensitive substring on the query plus a minimum-confidence floor. */
export function filterOcrItems(items: readonly OcrItem[], query?: string, minConfidence = 0): OcrItem[] {
  const needle = query !== undefined && query.trim() !== '' ? query.trim().toLowerCase() : undefined
  return items.filter(item =>
    (needle === undefined || item.text.toLowerCase().includes(needle))
    && item.confidence >= minConfidence)
}

function requireSize(size: PixelSize, what: string): void {
  if (!Number.isFinite(size.width) || !Number.isFinite(size.height) || size.width <= 0 || size.height <= 0) {
    throw new RangeError(`${what} must be a finite positive size, got ${size.width}x${size.height}`)
  }
}

/** Pixel box → device-point box, per axis through both sizes (never a fixed scale). */
export function pixelRectToPoints(rect: OcrRect, pixelSize: PixelSize, pointSize: PixelSize): OcrRect {
  requireSize(pixelSize, 'pixelSize')
  requireSize(pointSize, 'pointSize')
  const scaleX = pointSize.width / pixelSize.width
  const scaleY = pointSize.height / pixelSize.height
  return { x: rect.x * scaleX, y: rect.y * scaleY, w: rect.w * scaleX, h: rect.h * scaleY }
}

/** Center of a box (any space; the unit carries through). */
export function rectCenter(rect: OcrRect): { x: number; y: number } {
  return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 }
}

/** Pixel box center → normalized 0..1 tap coordinates (serve-sim control). */
export function pixelRectToNormalizedCenter(rect: OcrRect, pixelSize: PixelSize): { x: number; y: number } {
  requireSize(pixelSize, 'pixelSize')
  const center = rectCenter(rect)
  return { x: center.x / pixelSize.width, y: center.y / pixelSize.height }
}
