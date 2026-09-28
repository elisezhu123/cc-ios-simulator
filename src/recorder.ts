/**
 * `ios_sim_record`: one tracked `simctl io recordVideo` child per device.
 * Replaces the old `pkill -f recordVideo`: stop signals exactly the child it
 * started (SIGINT, so the movie is finalized) and waits for it to exit.
 * @module ios-simulator/recorder
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { RECORD_START_TIMEOUT_MS, RECORD_STOP_TIMEOUT_MS } from './config.js'

export interface RecordingInfo {
  udid: string
  path: string
  startedAt: number
}

export interface RecordingResult {
  udid: string
  path: string
  bytes: number
  durationMs: number
}

export type SpawnRecord = (udid: string, path: string) => ChildProcess

export interface RecorderOptions {
  dir: string
  spawnRecord?: SpawnRecord
  startTimeoutMs?: number
  stopTimeoutMs?: number
  now?: () => number
}

interface ActiveRecording {
  child: ChildProcess
  info: RecordingInfo
  exited: Promise<number | null>
}

/** `xcrun simctl io <udid> recordVideo --codec=h264 --force <path>` arguments. */
export function recordVideoArgs(udid: string, path: string): string[] {
  return ['simctl', 'io', udid, 'recordVideo', '--codec=h264', '--force', path]
}

const spawnXcrunRecord: SpawnRecord = (udid, path) =>
  spawn('xcrun', recordVideoArgs(udid, path), { stdio: ['ignore', 'ignore', 'pipe'] })

function safeName(udid: string): string {
  return udid.replace(/[^A-Za-z0-9_-]/g, '_')
}

function fileSize(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

export class Recorder {
  readonly #dir: string
  readonly #spawnRecord: SpawnRecord
  readonly #startTimeoutMs: number
  readonly #stopTimeoutMs: number
  readonly #now: () => number
  readonly #active = new Map<string, ActiveRecording>()
  readonly #starting = new Set<string>()

  constructor(options: RecorderOptions) {
    this.#dir = options.dir
    this.#spawnRecord = options.spawnRecord ?? spawnXcrunRecord
    this.#startTimeoutMs = options.startTimeoutMs ?? RECORD_START_TIMEOUT_MS
    this.#stopTimeoutMs = options.stopTimeoutMs ?? RECORD_STOP_TIMEOUT_MS
    this.#now = options.now ?? Date.now
  }

  active(udid: string): RecordingInfo | undefined {
    return this.#active.get(udid)?.info
  }

  defaultPath(udid: string): string {
    const stamp = new Date(this.#now()).toISOString().replace(/[:.]/g, '-')
    return join(this.#dir, `recording-${safeName(udid)}-${stamp}.mov`)
  }

  async start(udid: string, outputPath?: string): Promise<RecordingInfo> {
    const running = this.#active.get(udid)
    if (running !== undefined) {
      throw new Error(`a recording is already running for ${udid} (${running.info.path}) — stop it first with action "stop"`)
    }
    if (this.#starting.has(udid)) {
      throw new Error(`a recording is already starting for ${udid} — wait for it to finish starting before trying again`)
    }
    // Reserved synchronously (no `await` above this line) so a second start()
    // for the same udid, called before this one finishes starting, always
    // observes the reservation instead of racing it past the check.
    this.#starting.add(udid)
    try {
      const requested = outputPath?.trim() ?? ''
      const path = requested === '' ? this.defaultPath(udid) : requested
      if (!/\.(mov|mp4)$/iu.test(path)) throw new Error(`outputPath must end with .mov or .mp4, got ${path}`)
      mkdirSync(dirname(path), { recursive: true })
      const child = this.#spawnRecord(udid, path)
      const exited = new Promise<number | null>(resolve => {
        child.once('exit', code => resolve(code))
        child.once('error', () => resolve(null))
      })
      await this.#waitForStart(child, exited)
      const info: RecordingInfo = { udid, path, startedAt: this.#now() }
      this.#active.set(udid, { child, info, exited })
      return info
    } finally {
      this.#starting.delete(udid)
    }
  }

  async stop(udid: string): Promise<RecordingResult> {
    const recording = this.#active.get(udid)
    if (recording === undefined) throw new Error(`no recording is running for ${udid} — start one with action "start"`)
    this.#active.delete(udid)
    recording.child.kill('SIGINT')
    let timer: ReturnType<typeof setTimeout> | undefined
    const outcome = await Promise.race([
      recording.exited.then(code => ({ code })),
      new Promise<'timeout'>(resolve => { timer = setTimeout(() => resolve('timeout'), this.#stopTimeoutMs) }),
    ])
    if (timer !== undefined) clearTimeout(timer)
    if (outcome === 'timeout') {
      recording.child.kill('SIGKILL')
      throw new Error(`recordVideo did not finish writing ${recording.info.path} within ${this.#stopTimeoutMs} ms`)
    }
    const bytes = fileSize(recording.info.path)
    if (bytes === 0) {
      throw new Error(`recordVideo exited (code ${String(outcome.code)}) without writing ${recording.info.path}`)
    }
    return { udid, path: recording.info.path, bytes, durationMs: this.#now() - recording.info.startedAt }
  }

  /** Finish every running recording (used on shutdown). */
  async stopAll(): Promise<void> {
    await Promise.all([...this.#active.keys()].map(udid => this.stop(udid).catch(() => undefined)))
  }

  #waitForStart(child: ChildProcess, exited: Promise<number | null>): Promise<void> {
    return new Promise((resolve, reject) => {
      let stderr = ''
      let settled = false
      const onData = (chunk: Buffer): void => {
        stderr += chunk.toString('utf8')
        if (stderr.includes('Recording started')) finish()
      }
      const finish = (error?: Error): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        child.stderr?.off('data', onData)
        if (error === undefined) resolve()
        else reject(error)
      }
      const detail = (): string => (stderr.trim() === '' ? '' : `: ${stderr.trim()}`)
      const timer = setTimeout(() => {
        child.kill('SIGINT')
        finish(new Error(`recordVideo did not report "Recording started" within ${this.#startTimeoutMs} ms${detail()}`))
      }, this.#startTimeoutMs)
      child.stderr?.on('data', onData)
      void exited.then(code => {
        finish(new Error(`recordVideo exited before recording (code ${String(code)})${detail()} — is the simulator booted?`))
      })
    })
  }
}
