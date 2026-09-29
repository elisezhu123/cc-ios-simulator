/**
 * Test doubles for the host-facing seams: a serve-sim host here, plus a
 * recordVideo spawner (Task 9) and a simctl API (Task 10) appended later.
 */
import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { readFileSync, writeFileSync } from 'node:fs'
import { PassThrough } from 'node:stream'
import type { SimHostController, SimHostStatus, SimStreamInfo } from '../../src/sim-host.js'
import type { SimctlApi } from '../../src/deps.js'
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
