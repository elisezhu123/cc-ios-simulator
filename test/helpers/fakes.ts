/**
 * Test doubles for the host-facing seams: a serve-sim host here, plus a
 * recordVideo spawner (Task 9) and a simctl API (Task 10) appended later.
 */
import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { writeFileSync } from 'node:fs'
import { PassThrough } from 'node:stream'
import type { SimHostController, SimHostStatus, SimStreamInfo } from '../../src/sim-host.js'

/** The public slice of SimHostController that the tools and the panel use. */
export type FakeHost = Pick<SimHostController, 'binary' | 'streamInfo' | 'status' | 'ensureRunning' | 'stop' | 'acquire' | 'control'>

export interface FakeHostOptions {
  /** serve-sim resolvable (default true). */
  available?: boolean
  /** Device currently streamed; undefined means no stream. */
  device?: string
  /** Base URL of the (fake) serve-sim HTTP server (default http://127.0.0.1:3181). */
  baseUrl?: string
  /** Control-socket URL in the handshake (default: baseUrl with ws://). */
  wsUrl?: string
  /** Expose the live handshake through `streamInfo` (default false → CLI fallback). */
  exposeStreamInfo?: boolean
}

export interface FakeHostHandle {
  host: FakeHost
  calls: string[][]
  consumers(): number
}

export function fakeHost(options: FakeHostOptions = {}): FakeHostHandle {
  const calls: string[][] = []
  const available = options.available ?? true
  const baseUrl = options.baseUrl ?? 'http://127.0.0.1:3181'
  const port = Number(new URL(baseUrl).port)
  let device = options.device
  let consumers = 0
  const infoFor = (udid: string): SimStreamInfo => ({
    url: baseUrl,
    streamUrl: `${baseUrl}/stream.mjpeg`,
    wsUrl: options.wsUrl ?? baseUrl.replace(/^http/u, 'ws'),
    port,
    device: udid,
  })
  const host: FakeHost = {
    binary: available
      ? { available: true, source: 'package-bin', command: '/fake/serve-sim', args: [] }
      : { available: false, source: 'unavailable', args: [], reason: 'test: serve-sim unavailable' },
    get streamInfo() {
      return options.exposeStreamInfo === true && device !== undefined ? infoFor(device) : undefined
    },
    status(): SimHostStatus {
      return {
        available,
        running: device !== undefined,
        ...(device === undefined ? {} : { device, port }),
        restarts: 0,
        serveSimSource: available ? 'package-bin' : 'unavailable',
        consumers,
        stderr: [],
      }
    },
    async ensureRunning({ udid }) {
      calls.push(['ensureRunning', udid])
      device = udid
      return infoFor(udid)
    },
    async stop() {
      calls.push(['stop'])
      device = undefined
    },
    acquire() {
      consumers += 1
      let released = false
      return () => {
        if (released) return
        released = true
        consumers -= 1
      }
    },
    async control(args) {
      calls.push(['control', ...args])
      return { stdout: '', stderr: '' }
    },
  }
  return { host, calls, consumers: () => consumers }
}

export interface FakeRecording {
  udid: string
  path: string
  signals: string[]
}

/**
 * A `simctl io recordVideo` stand-in: prints "Recording started" (unless
 * told not to), and on SIGINT writes a 2 KB movie and exits 0.
 */
export function fakeRecordSpawn(options: { announce?: boolean; exitEarly?: boolean } = {}): {
  spawnRecord: (udid: string, path: string) => ChildProcess
  spawned: FakeRecording[]
} {
  const spawned: FakeRecording[] = []
  const spawnRecord = (udid: string, path: string): ChildProcess => {
    const record: FakeRecording = { udid, path, signals: [] }
    spawned.push(record)
    const stderr = new PassThrough()
    const emitter = new EventEmitter()
    const child = Object.assign(emitter, {
      stderr,
      kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
        record.signals.push(signal)
        if (signal === 'SIGINT') {
          writeFileSync(path, Buffer.alloc(2048, 1))
          setImmediate(() => emitter.emit('exit', 0))
        }
        return true
      },
    })
    setImmediate(() => {
      if (options.exitEarly === true) {
        stderr.write('Invalid device: booted\n')
        setTimeout(() => emitter.emit('exit', 1), 10)
        return
      }
      if (options.announce !== false) stderr.write('Recording started\n')
    })
    return child as unknown as ChildProcess
  }
  return { spawnRecord, spawned }
}
