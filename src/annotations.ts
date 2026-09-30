/**
 * Screenshots the user annotated in the live panel ("Add to chat"). The panel
 * is a separate web page and cannot type into Claude's chat, so annotations
 * land here and `ios_sim_annotation` hands them to Claude as images. Each one
 * is a PNG plus a JSON sidecar; the newest `keep` are kept.
 * @module ios-simulator/annotations
 */

import { mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface AnnotationRecord {
  /** `annotation-<n>` — also the file stem. */
  id: string
  path: string
  bytes: number
  width?: number
  height?: number
  createdAt: string
  /** The device shown in the panel when it was annotated. */
  device?: { udid: string; name: string }
  /** Whether ios_sim_annotation has returned it already. */
  seen: boolean
}

const FILE_PATTERN = /^annotation-(\d+)\.png$/u
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
/** Largest annotated PNG accepted (a full-resolution iPad screenshot fits comfortably). */
export const MAX_ANNOTATION_BYTES = 24 * 1024 * 1024

export function isAnnotationFileName(name: string): boolean {
  return FILE_PATTERN.test(name)
}

function pngSize(png: Buffer): { width: number; height: number } | undefined {
  if (png.length < 24 || png.readUInt32BE(12) !== 0x49484452) return undefined
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) }
}

export class AnnotationStore {
  readonly dir: string
  readonly #keep: number
  #next: number | undefined

  constructor(options: { dir: string; keep?: number }) {
    this.dir = options.dir
    this.#keep = options.keep ?? 30
  }

  /** Store one annotated PNG (throws on anything that is not a PNG, or too large). */
  save(png: Buffer, device?: { udid: string; name: string }): AnnotationRecord {
    if (png.length > MAX_ANNOTATION_BYTES) throw new Error(`the annotated image is larger than ${MAX_ANNOTATION_BYTES / 1024 / 1024} MB`)
    if (png.length < PNG_SIGNATURE.length || !png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
      throw new Error('the annotated image is not a PNG')
    }
    mkdirSync(this.dir, { recursive: true })
    this.#next ??= Math.max(0, ...this.#indexes().map(index => index + 1))
    const index = this.#next
    this.#next += 1
    const id = `annotation-${index}`
    const path = join(this.dir, `${id}.png`)
    writeFileSync(path, png)
    const size = pngSize(png)
    const record: AnnotationRecord = {
      id,
      path,
      bytes: png.length,
      ...(size === undefined ? {} : size),
      createdAt: new Date().toISOString(),
      ...(device === undefined ? {} : { device }),
      seen: false,
    }
    writeFileSync(join(this.dir, `${id}.json`), JSON.stringify(record))
    this.#prune()
    return record
  }

  /** Newest first. */
  list(): AnnotationRecord[] {
    return this.#indexes()
      .sort((a, b) => b - a)
      .map(index => this.#read(index))
      .filter(record => record !== undefined)
  }

  /** Mark records as returned to Claude. */
  markSeen(ids: readonly string[]): void {
    for (const record of this.list()) {
      if (!ids.includes(record.id) || record.seen) continue
      writeFileSync(join(this.dir, `${record.id}.json`), JSON.stringify({ ...record, seen: true }))
    }
  }

  unseenCount(): number {
    return this.list().filter(record => !record.seen).length
  }

  #indexes(): number[] {
    let names: string[]
    try {
      names = readdirSync(this.dir)
    } catch {
      return []
    }
    return names.map(name => FILE_PATTERN.exec(name)?.[1]).filter(index => index !== undefined).map(Number)
  }

  #read(index: number): AnnotationRecord | undefined {
    const id = `annotation-${index}`
    const path = join(this.dir, `${id}.png`)
    try {
      const record = JSON.parse(readFileSync(join(this.dir, `${id}.json`), 'utf8')) as AnnotationRecord
      return { ...record, id, path }
    } catch {
      // A PNG without its sidecar (written by hand, or the sidecar was lost): describe it from the file.
      try {
        const stat = statSync(path)
        return { id, path, bytes: stat.size, createdAt: stat.mtime.toISOString(), seen: false }
      } catch {
        return undefined
      }
    }
  }

  #prune(): void {
    for (const index of this.#indexes().sort((a, b) => b - a).slice(this.#keep)) {
      for (const suffix of ['.png', '.json']) {
        try {
          unlinkSync(join(this.dir, `annotation-${index}${suffix}`))
        } catch {
          // best effort
        }
      }
    }
  }
}
