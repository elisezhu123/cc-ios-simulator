/**
 * Test doubles for the host-facing seams: a serve-sim host here, plus a
 * recordVideo spawner (Task 9) and a simctl API (Task 10) appended later.
 */
import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import type { ServeSimBinary, SimHostController, SimHostStatus, SimStreamInfo } from '../../src/sim-host.js'
import type { AxeApi, OcrApi, SimctlApi } from '../../src/deps.js'
import type { DebugToolName, DevToolsApi, RunOptions, RunOutcome } from '../../src/devtools.js'
import type { OcrItem } from '../../src/ocr-backend.js'
import type { AxeElement } from '../../src/uitree-backend.js'
import type { SimulatorDevice } from '../../src/simctl.js'
import { tinyPng } from './png.js'

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

export interface FakeServeSim {
  /** Launches this fake through the real SimHostController spawn path. */
  binary: ServeSimBinary
  /** Pids of every launch so far, in order. */
  pids(): number[]
  /** SIGKILL every launch that is still running (test cleanup, or a crash). */
  killAll(): void
}

/** True while `pid` is a running process. */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * A serve-sim stand-in script for SimHostController: logs its pid, then either
 * prints the handshake serve-sim prints (for the requested port and device) or
 * never does (a hung helper, a slow npx download), and runs until killed.
 */
export function fakeServeSimBinary(options: { handshake: boolean }): FakeServeSim {
  const dir = mkdtempSync(join(tmpdir(), 'ios-sim-fake-serve-sim-'))
  const pidFile = join(dir, 'pids')
  const script = join(dir, 'serve-sim.mjs')
  writeFileSync(script, [
    "import { appendFileSync } from 'node:fs'",
    `appendFileSync(${JSON.stringify(pidFile)}, process.pid + '\\n')`,
    'const argv = process.argv.slice(2)',
    "const port = Number(argv[argv.indexOf('--port') + 1])",
    'const device = argv[argv.length - 1]',
    `if (${String(options.handshake)}) {`,
    "  const url = 'http://127.0.0.1:' + port",
    "  process.stdout.write(JSON.stringify({ url, streamUrl: url + '/stream.mjpeg', wsUrl: 'ws://127.0.0.1:' + port + '/ws', port, device }) + '\\n')",
    '}',
    'setInterval(() => {}, 1 << 30)',
  ].join('\n'))
  const pids = (): number[] => existsSync(pidFile)
    ? readFileSync(pidFile, 'utf8').split('\n').filter(line => line !== '').map(Number)
    : []
  return {
    binary: { available: true, source: 'package-bin', command: process.execPath, args: [script] },
    pids,
    killAll: () => {
      for (const pid of pids()) {
        if (isAlive(pid)) process.kill(pid, 'SIGKILL')
      }
    },
  }
}

export interface FakeRecording {
  udid: string
  path: string
  signals: string[]
  /** recordVideo ending on its own (device shut down, simctl crash), optionally after writing `bytes`. */
  exit(code: number | null, bytes?: number): void
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
    const stderr = new PassThrough()
    const emitter = new EventEmitter()
    const record: FakeRecording = {
      udid,
      path,
      signals: [],
      exit: (code, bytes = 0) => {
        if (bytes > 0) writeFileSync(path, Buffer.alloc(bytes, 1))
        emitter.emit('exit', code)
      },
    }
    spawned.push(record)
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

/** Four simulators: two booted iPhones on different runtimes, two shut down. */
export const DEVICES: readonly SimulatorDevice[] = [
  { udid: 'AAA', name: 'iPhone 16', runtime: 'com.apple.CoreSimulator.SimRuntime.iOS-18-0', state: 'Shutdown' },
  {
    udid: 'BBB',
    name: 'iPhone 17 Pro',
    runtime: 'com.apple.CoreSimulator.SimRuntime.iOS-26-0',
    state: 'Booted',
    deviceType: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro',
  },
  { udid: 'CCC', name: 'iPad Air', runtime: 'com.apple.CoreSimulator.SimRuntime.iOS-26-0', state: 'Shutdown' },
  { udid: 'EEE', name: 'iPhone 15', runtime: 'com.apple.CoreSimulator.SimRuntime.iOS-18-0', state: 'Booted' },
]

/** A simctl stand-in over a mutable device list; records every side effect. */
export function fakeSimctl(
  devices: SimulatorDevice[] = DEVICES.map(device => ({ ...device })),
  options: { screenshotSize?: { width: number; height: number } } = {},
): {
  api: SimctlApi
  calls: unknown[][]
  devices: SimulatorDevice[]
} {
  const calls: unknown[][] = []
  const screenshotSize = options.screenshotSize ?? { width: 1206, height: 2622 }
  const find = (reference: string): SimulatorDevice => {
    const wanted = reference.trim()
    const device = devices.find(candidate => candidate.udid === wanted)
      ?? devices.find(candidate => candidate.name.toLowerCase() === wanted.toLowerCase())
    if (device === undefined) throw new Error(`unknown simulator "${wanted}" — run ios_sim_devices to list available devices`)
    return device
  }
  const setState = (udid: string, state: string): void => {
    const device = devices.find(candidate => candidate.udid === udid)
    if (device !== undefined) device.state = state
  }
  const api: SimctlApi = {
    listDevices: async () => devices.map(device => ({ ...device })),
    getDevice: async reference => ({ ...find(reference) }),
    bootDevice: async udid => { calls.push(['boot', udid]); setState(udid, 'Booted') },
    shutdownDevice: async udid => { calls.push(['shutdown', udid]); setState(udid, 'Shutdown') },
    takeScreenshot: async (udid, filePath) => {
      calls.push(['screenshot', udid])
      writeFileSync(filePath, tinyPng(screenshotSize.width, screenshotSize.height))
    },
    installApp: async (udid, appPath) => { calls.push(['install', udid, appPath]) },
    uninstallApp: async (udid, bundleId) => { calls.push(['uninstall', udid, bundleId]) },
    launchApp: async (udid, bundleId) => { calls.push(['launch', udid, bundleId]); return `${bundleId}: 4242\n` },
    terminateApp: async (udid, bundleId) => { calls.push(['terminate', udid, bundleId]); return '' },
    openUrl: async (udid, url) => { calls.push(['openurl', udid, url]) },
    sendPush: async (udid, bundleId, payloadPath) => {
      calls.push(['push', udid, bundleId, JSON.parse(readFileSync(payloadPath, 'utf8')) as unknown])
    },
    setLocation: async (udid, latitude, longitude) => { calls.push(['location', udid, latitude, longitude]) },
    clearLocation: async udid => { calls.push(['location-clear', udid]) },
    setAppearance: async (udid, appearance) => { calls.push(['appearance', udid, appearance]) },
  }
  return { api, calls, devices }
}

/**
 * An AXe stand-in: `trees` are the describe-ui reads in order (the last one
 * repeats); every tap is recorded.
 */
export function fakeAxe(trees: AxeElement[][] = [], options: { available?: boolean } = {}): {
  api: AxeApi
  taps: Array<{ udid: string; x: number; y: number }>
  reads(): number
} {
  const taps: Array<{ udid: string; x: number; y: number }> = []
  const available = options.available ?? true
  let reads = 0
  const api: AxeApi = {
    resolve: () => available
      ? { available: true, source: 'path', command: '/fake/axe' }
      : { available: false, source: 'unavailable', reason: 'test: axe unavailable' },
    describeUi: async () => {
      if (!available) throw new Error('the AXe accessibility helper is unavailable (test: axe unavailable)')
      const tree = trees[Math.min(reads, trees.length - 1)]
      reads += 1
      if (tree === undefined) throw new Error('fakeAxe: no tree configured')
      return structuredClone(tree)
    },
    tap: async (udid, x, y) => { taps.push({ udid, x, y }) },
  }
  return { api, taps, reads: () => reads }
}

/** An OCR stand-in: `reads` are the recognitions in order (the last one repeats). */
export function fakeOcr(reads: OcrItem[][] = [[]]): { api: OcrApi; paths: string[] } {
  const paths: string[] = []
  const api: OcrApi = {
    recognize: async path => {
      const items = reads[Math.min(paths.length, reads.length - 1)] ?? []
      paths.push(path)
      return structuredClone(items)
    },
  }
  return { api, paths }
}

/**
 * A DevTools stand-in: `simctl` answers by the joined argument string (a
 * missing key rejects), `run` answers by command basename; every call is
 * recorded.
 */
export function fakeDevtools(options: {
  simctl?: Record<string, string>
  run?: Record<string, Partial<RunOutcome> | ((run: RunOptions) => Partial<RunOutcome>)>
  which?: Partial<Record<DebugToolName, string>>
  running?: boolean
} = {}): { api: DevToolsApi; simctlCalls: string[]; runs: RunOptions[]; resumeChecks: number[] } {
  const simctlCalls: string[] = []
  const runs: RunOptions[] = []
  const resumeChecks: number[] = []
  const api: DevToolsApi = {
    simctl: async args => {
      const key = args.join(' ')
      simctlCalls.push(key)
      const out = options.simctl?.[key]
      if (out === undefined) throw new Error(`simctl ${key} failed: fake has no answer`)
      return out
    },
    run: async run => {
      runs.push(run)
      const name = run.command.split('/').pop() ?? run.command
      const answer = options.run?.[name]
      const outcome = typeof answer === 'function' ? answer(run) : answer ?? {}
      return { stdout: '', stderr: '', code: 0, killed: false, ...outcome }
    },
    which: name => options.which === undefined ? `/xcode/${name}` : options.which[name],
    ensureRunning: async pid => {
      resumeChecks.push(pid)
      return options.running ?? true
    },
  }
  return { api, simctlCalls, runs, resumeChecks }
}
