// Ported from dsh-ios (MIT, © 2026 ZSeven—W) @ d9a9731 — src/tools.ts (ScreenshotStore, readPngSize)
/**
 * Screenshot cache shared by the tools and the panel: numbered full-size PNGs
 * per device (the ScreenshotStore naming is ported from dsh-ios src/tools.ts),
 * pruned to the newest N, plus the downscaled JPEG handed to the model.
 * @module ios-simulator/screenshot
 */

import { execFile } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { MODEL_IMAGE_JPEG_QUALITY, MODEL_IMAGE_MAX_EDGE, SCREENSHOT_KEEP } from './config.js'

export interface ScreenshotCapture {
  path: string
  bytes: number
  width?: number
  height?: number
}

export interface ModelImage {
  /** Base64 JPEG bytes. */
  data: string
  mimeType: 'image/jpeg'
  width: number
  height: number
}

export interface ScreenshotStoreOptions {
  dir: string
  takeScreenshot(udid: string, path: string, signal?: AbortSignal): Promise<void>
  keep?: number
  maxEdge?: number
  quality?: number
}

const FILE_PATTERN = /^screenshot-[A-Za-z0-9_-]+-(\d+)\.png$/u
const SIPS_TIMEOUT_MS = 30_000

/** True for the names this store writes (the panel serves nothing else). */
export function isScreenshotFileName(name: string): boolean {
  return FILE_PATTERN.test(name)
}

/** Read PNG dimensions from the IHDR chunk (best effort, 24-byte header). */
export function readPngSize(path: string): { width: number; height: number } | undefined {
  try {
    const fd = openSync(path, 'r')
    try {
      const header = Buffer.alloc(24)
      if (readSync(fd, header, 0, 24, 0) !== 24) return undefined
      const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      const isPng = header.subarray(0, 8).equals(pngSignature)
      const isIhdr = header.subarray(12, 16).toString('ascii') === 'IHDR'
      if (!isPng || !isIhdr) return undefined
      return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) }
    } finally {
      closeSync(fd)
    }
  } catch {
    return undefined
  }
}

/** Pixel size of a JPEG from its SOF marker, without decoding. */
export function jpegSize(buffer: Buffer): { width: number; height: number } | undefined {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return undefined
  let offset = 2
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1
      continue
    }
    const marker = buffer[offset + 1] ?? 0
    if (marker === 0xff || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      offset += marker === 0xff ? 1 : 2
      continue
    }
    const length = buffer.readUInt16BE(offset + 2)
    const isStartOfFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (isStartOfFrame) {
      return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) }
    }
    offset += 2 + length
  }
  return undefined
}

function runSips(args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('sips', [...args], { timeout: SIPS_TIMEOUT_MS }, (error, _stdout, stderr) => {
      if (error === null) {
        resolve()
        return
      }
      reject(new Error(`sips failed: ${stderr.trim() === '' ? error.message : stderr.trim()}`))
    })
  })
}

export class ScreenshotStore {
  readonly dir: string
  readonly #take: ScreenshotStoreOptions['takeScreenshot']
  readonly #keep: number
  readonly #maxEdge: number
  readonly #quality: number
  readonly #next = new Map<string, number>()

  constructor(options: ScreenshotStoreOptions) {
    this.dir = options.dir
    this.#take = options.takeScreenshot
    this.#keep = options.keep ?? SCREENSHOT_KEEP
    this.#maxEdge = options.maxEdge ?? MODEL_IMAGE_MAX_EDGE
    this.#quality = options.quality ?? MODEL_IMAGE_JPEG_QUALITY
  }

  /**
   * `<dir>/screenshot-<udid>-<n>.png` with a monotonically increasing index;
   * names already on disk are skipped so concurrent writers never collide.
   */
  nextPath(udid: string): string {
    mkdirSync(this.dir, { recursive: true })
    const safe = udid.replace(/[^A-Za-z0-9_-]/g, '_')
    let next = this.#next.get(safe)
    if (next === undefined) {
      next = 0
      const prefix = `screenshot-${safe}-`
      for (const entry of readdirSync(this.dir)) {
        if (!entry.startsWith(prefix) || !entry.endsWith('.png')) continue
        const index = Number(entry.slice(prefix.length, -4))
        if (Number.isInteger(index) && index >= next) next = index + 1
      }
    }
    let path = join(this.dir, `screenshot-${safe}-${next}.png`)
    while (existsSync(path)) {
      next += 1
      path = join(this.dir, `screenshot-${safe}-${next}.png`)
    }
    this.#next.set(safe, next + 1)
    return path
  }

  /** Capture a fresh full-size PNG, then prune the cache. */
  async capture(udid: string, signal?: AbortSignal): Promise<ScreenshotCapture> {
    const path = this.nextPath(udid)
    await this.#take(udid, path, signal)
    const bytes = statSync(path).size
    const size = readPngSize(path)
    this.prune()
    return { path, bytes, ...(size === undefined ? {} : size) }
  }

  /** Keep the newest `keep` screenshots (by mtime, then index). */
  prune(): void {
    let names: string[]
    try {
      names = readdirSync(this.dir).filter(isScreenshotFileName)
    } catch {
      return
    }
    if (names.length <= this.#keep) return
    const entries = names.map(name => {
      const path = join(this.dir, name)
      let mtime = 0
      try {
        mtime = statSync(path).mtimeMs
      } catch {
        // vanished between readdir and stat
      }
      return { path, mtime, index: Number(FILE_PATTERN.exec(name)?.[1] ?? 0) }
    })
    entries.sort((a, b) => (b.mtime - a.mtime) || (b.index - a.index))
    for (const entry of entries.slice(this.#keep)) {
      try {
        unlinkSync(entry.path)
      } catch {
        // best effort
      }
    }
  }

  /** The JPEG the model sees: quality 80, long edge at most `maxEdge`. */
  async toModelImage(capture: ScreenshotCapture): Promise<ModelImage> {
    const out = capture.path.replace(/\.png$/u, '.model.jpg')
    const args = ['-s', 'format', 'jpeg', '-s', 'formatOptions', String(this.#quality)]
    const longEdge = Math.max(capture.width ?? 0, capture.height ?? 0)
    if (longEdge === 0 || longEdge > this.#maxEdge) args.push('--resampleHeightWidthMax', String(this.#maxEdge))
    args.push(capture.path, '--out', out)
    try {
      await runSips(args)
      const buffer = await readFile(out)
      const size = jpegSize(buffer)
      if (size === undefined) throw new Error(`sips produced an unreadable JPEG for ${capture.path}`)
      return { data: buffer.toString('base64'), mimeType: 'image/jpeg', ...size }
    } finally {
      await rm(out, { force: true })
    }
  }
}
