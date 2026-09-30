// Ported from dsh-ios (MIT, © 2026 ZSeven—W) @ d9a9731 — src/devicectl.ts (device, app and process operations)
/**
 * Typed wrappers over `xcrun devicectl` for USB-connected iPhones and iPads,
 * the real-device counterpart of simctl.ts.
 *
 * - `--json-output <file>` is the scriptable interface; devicectl writes
 *   `{ info: { outcome }, result | error }` even on failure, so a call
 *   succeeds only with exit 0 AND `outcome === "success"`.
 * - `device info apps` lists stock apps only with the --include-* flags.
 * - `device process terminate` takes a pid, so terminating an app goes
 *   through the process list.
 * - Tunnels can hang: every call carries devicectl's own `--timeout` and a
 *   hard deadline that kills the process group (DevTools.run).
 * - Failures are classified into actionable messages (locked, Developer
 *   Mode off, not paired, not reachable) — an unreachable device must never
 *   read as "the app is not installed".
 * @module ios-simulator/devicectl
 */

import { readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RunOptions, RunOutcome } from './devtools.js'

/** One physical device from `devicectl list devices`. */
export interface RealDevice {
  /** CoreDevice identifier: the udid devicectl and the tools use. */
  udid: string
  /** Hardware udid (`00008150-…`), the form xcodebuild destinations show. */
  hardwareUdid?: string
  name: string
  osVersion?: string
  build?: string
  /** Marketing name, e.g. `iPhone 17 Pro`. */
  model?: string
  productType?: string
  platform?: string
  /** `available (paired)`, `available` or `unavailable`. */
  state: string
  connection: 'wired' | 'wireless' | 'unknown'
  pairingState: 'paired' | 'unpaired' | 'unknown'
  tunnelState?: string
  developerMode: 'enabled' | 'disabled' | 'unknown'
  bootState?: string
}

/** One installed app from `devicectl device info apps`. */
export interface RealApp {
  bundleId: string
  name: string
  version?: string
  bundleVersion?: string
  builtByDeveloper?: boolean
  defaultApp?: boolean
  /** `User` / `System`. */
  appType?: string
  hidden?: boolean
  removable?: boolean
  appClip?: boolean
  /** On-device .app path. */
  path?: string
}

/** One running process from `devicectl device info processes`. */
export interface RealProcess {
  /** On-device pid (NOT a host pid). */
  pid: number
  executable: string
  bundleId?: string
  name: string
}

export class DevicectlError extends Error {
  constructor(message: string, readonly stderr = '', readonly stdout = '', readonly code?: number | null) {
    super(message)
    this.name = 'DevicectlError'
  }
}

const LIST_TIMEOUT_MS = 30_000
const DEFAULT_TIMEOUT_MS = 60_000
const APPS_TIMEOUT_MS = 90_000
const PROCESSES_TIMEOUT_MS = 30_000
const INSTALL_TIMEOUT_MS = 180_000

/** Flags that make `device info apps` include stock apps too. */
const ALL_APPS_FLAGS = ['--include-default-apps', '--include-app-clips', '--include-removable-apps']

export interface DevicectlResult {
  stdout: string
  stderr: string
  code: number | null
  /** The `--json-output` document, when devicectl wrote one. */
  json?: unknown
}

/** Runs one devicectl command (with --json-output handled) — the seam tests replace. */
export type DevicectlRunner = (args: readonly string[], timeoutMs: number, signal?: AbortSignal) => Promise<DevicectlResult>

/** The default runner: `xcrun devicectl --timeout <s> --json-output <tmp> <args>` through a process-group runner. */
export function devicectlRunner(run: (options: RunOptions) => Promise<RunOutcome>): DevicectlRunner {
  let sequence = 0
  return async (args, timeoutMs, signal) => {
    sequence += 1
    const jsonPath = join(tmpdir(), `ios-sim-devicectl-${process.pid}-${sequence}-${Date.now()}.json`)
    try {
      const fullArgs = ['devicectl', '--timeout', String(Math.max(1, Math.ceil(timeoutMs / 1000))), '--json-output', jsonPath, ...args]
      let outcome: RunOutcome
      try {
        outcome = await run({
          command: 'xcrun',
          args: fullArgs,
          label: `devicectl ${args.join(' ')}`,
          // devicectl's own --timeout first; the hard kill a little after.
          timeoutMs: timeoutMs + 5_000,
          ...(signal === undefined ? {} : { signal }),
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        throw new DevicectlError(/deadline/u.test(message)
          ? `${message} — the device tunnel may be stuck; check the USB connection and retry`
          : message)
      }
      let json: unknown
      try {
        json = JSON.parse(readFileSync(jsonPath, 'utf8'))
      } catch {
        json = undefined
      }
      return { stdout: outcome.stdout, stderr: outcome.stderr, code: outcome.code, json }
    } finally {
      rmSync(jsonPath, { force: true })
    }
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function str(source: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = source?.[key]
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

function stripFileUrl(value: string): string {
  return value.startsWith('file://') ? decodeURIComponent(value.slice('file://'.length)) : value
}

function outcomeOf(json: unknown): 'success' | 'failed' | 'unknown' {
  const outcome = record(record(json)?.info)?.outcome
  return outcome === 'success' ? 'success' : outcome === 'failed' ? 'failed' : 'unknown'
}

/** The actionable description of a devicectl JSON `error`. */
function jsonErrorDetail(json: unknown): string | undefined {
  const userInfo = record(record(record(json)?.error)?.userInfo)
  const read = (key: string): string | undefined => str(record(userInfo?.[key]), 'string')
  return read('NSLocalizedFailureReason') ?? read('NSLocalizedDescription')
}

/** Raw failures → actionable messages. */
export function classifyDevicectlFailure(label: string, result: DevicectlResult): DevicectlError {
  const detail = jsonErrorDetail(result.json)
    ?? `${result.stderr}\n${result.stdout}`.split('\n').map(line => line.trim()).filter(line => line !== '').slice(-6).join(' | ')
  const text = `${detail}\n${result.stderr}`.toLowerCase()
  const fail = (message: string): DevicectlError => new DevicectlError(message, result.stderr, result.stdout, result.code)
  if (/locked|fbsopenapplication/u.test(text)) {
    return fail(`${label} failed because the device is locked — unlock the iPhone (and keep it unlocked), then retry`)
  }
  if (/developer mode/u.test(text)) {
    return fail(`${label} failed because Developer Mode is off on the device — turn it on in Settings ▸ Privacy & Security ▸ Developer Mode (the device restarts), then retry`)
  }
  if (/not paired|unpaired|pairing/u.test(text)) {
    return fail(`${label} failed because the device is not paired — connect it over USB, tap "Trust This Computer", and check \`xcrun devicectl list devices\``)
  }
  if (/unable to locate a device|coredeviceservice|coredeviceerror[^\d]*1011/u.test(text)) {
    return fail(`${label} failed because the device is not reachable by CoreDevice right now — reconnect it over USB and retry `
      + '(this is not the app being missing: nothing was listed at all)')
  }
  return fail(`${label} failed (exit ${String(result.code)})${detail === '' ? '' : `: ${detail}`}`)
}

/** `result.devices[]` → devices; only rows devicectl explicitly marks as simulators are dropped. */
export function parseDevicectlDevices(json: unknown): RealDevice[] {
  const entries = record(record(json)?.result)?.devices
  if (!Array.isArray(entries)) return []
  const devices: RealDevice[] = []
  for (const entry of entries) {
    const row = record(entry)
    const udid = str(row, 'identifier')
    if (row === undefined || udid === undefined) continue
    const deviceProps = record(row.deviceProperties)
    const hardware = record(row.hardwareProperties)
    const connection = record(row.connectionProperties)
    // An offline device may report no reality at all: keep everything not explicitly simulated.
    if (str(hardware, 'reality') === 'simulated' || str(record(row.properties), 'hardware.reality') === 'simulated'
      || str(row, 'visibilityClass') === 'simulators') continue
    const pairing = str(connection, 'pairingState')
    const tunnelState = str(connection, 'tunnelState')
    const transport = str(connection, 'transportType')
    const developerMode = str(deviceProps, 'developerModeStatus')
    const optional = (key: keyof RealDevice, value: string | undefined): Partial<RealDevice> => value === undefined ? {} : { [key]: value }
    devices.push({
      udid,
      ...optional('hardwareUdid', str(hardware, 'udid')),
      name: str(deviceProps, 'name') ?? udid,
      ...optional('osVersion', str(deviceProps, 'osVersionNumber')),
      ...optional('build', str(deviceProps, 'osBuildUpdate')),
      ...optional('model', str(hardware, 'marketingName')),
      ...optional('productType', str(hardware, 'productType')),
      ...optional('platform', str(hardware, 'platform')),
      state: connection === undefined || tunnelState === 'unavailable' ? 'unavailable' : pairing === 'paired' ? 'available (paired)' : 'available',
      connection: transport === 'wired' || transport === 'wireless' ? transport : 'unknown',
      pairingState: pairing === 'paired' || pairing === 'unpaired' ? pairing : 'unknown',
      ...optional('tunnelState', tunnelState),
      developerMode: developerMode === 'enabled' || developerMode === 'disabled' ? developerMode : 'unknown',
      ...optional('bootState', str(deviceProps, 'bootState')),
    })
  }
  return devices
}

/** `result.apps[]` → apps, or undefined when the document has NO apps array (nothing was listed). */
export function parseDevicectlApps(json: unknown): RealApp[] | undefined {
  const entries = record(record(json)?.result)?.apps
  if (!Array.isArray(entries)) return undefined
  const apps: RealApp[] = []
  for (const entry of entries) {
    const row = record(entry)
    const bundleId = str(row, 'bundleIdentifier')
    if (row === undefined || bundleId === undefined) continue
    const url = str(row, 'url')
    apps.push({
      bundleId,
      name: str(row, 'name') ?? bundleId,
      ...(str(row, 'version') === undefined ? {} : { version: str(row, 'version')! }),
      ...(str(row, 'bundleVersion') === undefined ? {} : { bundleVersion: str(row, 'bundleVersion')! }),
      ...(row.builtByDeveloper === true ? { builtByDeveloper: true } : {}),
      ...(row.defaultApp === true ? { defaultApp: true } : {}),
      ...(str(row, 'appType') === undefined ? {} : { appType: str(row, 'appType')! }),
      ...(row.hidden === true ? { hidden: true } : {}),
      ...(row.removable === true ? { removable: true } : {}),
      ...(row.appClip === true ? { appClip: true } : {}),
      ...(url === undefined ? {} : { path: stripFileUrl(url) }),
    })
  }
  return apps
}

/** `result.runningProcesses[]` → processes (bundle ids are added from the app list). */
export function parseDevicectlProcesses(json: unknown): RealProcess[] | undefined {
  const entries = record(record(json)?.result)?.runningProcesses
  if (!Array.isArray(entries)) return undefined
  const processes: RealProcess[] = []
  for (const entry of entries) {
    const row = record(entry)
    const pid = row?.processIdentifier
    const executable = str(row, 'executable')
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid < 1 || executable === undefined) continue
    const path = stripFileUrl(executable)
    processes.push({ pid, executable: path, name: path.split('/').pop() ?? path })
  }
  return processes
}

/** Give each process inside an installed .app its bundle id and display name. */
export function attachBundleIds(processes: RealProcess[], apps: readonly RealApp[]): RealProcess[] {
  const byPath = new Map<string, RealApp>()
  for (const app of apps) if (app.path !== undefined) byPath.set(app.path.endsWith('/') ? app.path : `${app.path}/`, app)
  for (const process of processes) {
    const app = byPath.get(`${process.executable.split('/').slice(0, -1).join('/')}/`)
    if (app !== undefined) {
      process.bundleId = app.bundleId
      process.name = app.name
    }
  }
  return processes.sort((a, b) => a.pid - b.pid)
}

/** The real-device operations the tools use (Devicectl satisfies it). */
export interface RealDeviceApi {
  listDevices(signal?: AbortSignal): Promise<RealDevice[]>
  /** Resolve a udid, hardware udid or name; throws with the connected devices. */
  getDevice(reference: string, signal?: AbortSignal): Promise<RealDevice>
  /** True when the reference names a connected device; never throws. */
  matches(reference: string, signal?: AbortSignal): Promise<boolean>
  listApps(udid: string, signal?: AbortSignal): Promise<RealApp[]>
  getApp(udid: string, bundleId: string, signal?: AbortSignal): Promise<RealApp | undefined>
  listProcesses(udid: string, signal?: AbortSignal): Promise<RealProcess[]>
  launchApp(udid: string, bundleId: string, signal?: AbortSignal): Promise<{ pid?: number }>
  terminateApp(udid: string, bundleId: string, signal?: AbortSignal): Promise<{ pids: number[] }>
  installApp(udid: string, appPath: string, signal?: AbortSignal): Promise<void>
}

export class Devicectl implements RealDeviceApi {
  readonly #run: DevicectlRunner
  readonly #platform: NodeJS.Platform

  constructor(options: { run: DevicectlRunner; platform?: NodeJS.Platform }) {
    this.#run = options.run
    this.#platform = options.platform ?? process.platform
  }

  async #successful(args: readonly string[], label: string, timeoutMs: number, signal?: AbortSignal): Promise<DevicectlResult> {
    const result = await this.#run(args, timeoutMs, signal)
    // devicectl sometimes exits 0 with a failed outcome in its JSON.
    if (result.code !== 0 || outcomeOf(result.json) === 'failed') throw classifyDevicectlFailure(label, result)
    return result
  }

  async listDevices(signal?: AbortSignal): Promise<RealDevice[]> {
    if (this.#platform !== 'darwin') return []
    const result = await this.#run(['list', 'devices'], LIST_TIMEOUT_MS, signal)
    if (result.code !== 0) throw classifyDevicectlFailure('devicectl list devices', result)
    return parseDevicectlDevices(result.json)
  }

  async getDevice(reference: string, signal?: AbortSignal): Promise<RealDevice> {
    const wanted = reference.trim()
    const devices = await this.listDevices(signal)
    const found = devices.find(device => device.udid === wanted || device.hardwareUdid === wanted)
      ?? devices.find(device => device.name.toLowerCase() === wanted.toLowerCase())
    if (found !== undefined) return found
    const names = devices.slice(0, 8).map(device => `${device.name} (${device.udid})`)
    throw new DevicectlError(`no connected iPhone or iPad matches "${wanted}"`
      + (names.length === 0 ? ' — no physical device is connected' : `; connected: ${names.join(', ')}`))
  }

  async matches(reference: string, signal?: AbortSignal): Promise<boolean> {
    if (reference.trim() === '') return false
    try {
      await this.getDevice(reference, signal)
      return true
    } catch {
      return false
    }
  }

  async listApps(udid: string, signal?: AbortSignal): Promise<RealApp[]> {
    const label = `devicectl device info apps on ${udid}`
    const result = await this.#successful(['device', 'info', 'apps', '--device', udid, ...ALL_APPS_FLAGS], label, APPS_TIMEOUT_MS, signal)
    const apps = parseDevicectlApps(result.json)
    if (apps === undefined) {
      throw new DevicectlError(`${label} reported success but wrote no app list — the listing failed (reconnect the `
        + 'device over USB and retry); this is not the same as the device having no apps', result.stderr, result.stdout, result.code)
    }
    return apps
  }

  async getApp(udid: string, bundleId: string, signal?: AbortSignal): Promise<RealApp | undefined> {
    const result = await this.#successful(['device', 'info', 'apps', '--device', udid, ...ALL_APPS_FLAGS, '--bundle-id', bundleId],
      `devicectl device info apps --bundle-id ${bundleId} on ${udid}`, APPS_TIMEOUT_MS, signal)
    return (parseDevicectlApps(result.json) ?? []).find(app => app.bundleId === bundleId)
  }

  async listProcesses(udid: string, signal?: AbortSignal): Promise<RealProcess[]> {
    const label = `devicectl device info processes on ${udid}`
    const result = await this.#successful(['device', 'info', 'processes', '--device', udid], label, PROCESSES_TIMEOUT_MS, signal)
    const processes = parseDevicectlProcesses(result.json)
    if (processes === undefined) throw new DevicectlError(`${label} returned no process list`, result.stderr, result.stdout, result.code)
    let apps: RealApp[] = []
    try {
      apps = await this.listApps(udid, signal)
    } catch {
      // Bundle ids are best effort; the pids still come back.
    }
    return attachBundleIds(processes, apps)
  }

  async launchApp(udid: string, bundleId: string, signal?: AbortSignal): Promise<{ pid?: number }> {
    const result = await this.#successful(['device', 'process', 'launch', '--device', udid, bundleId],
      `devicectl device process launch ${bundleId} on ${udid}`, DEFAULT_TIMEOUT_MS, signal)
    const pid = record(record(record(result.json)?.result)?.process)?.processIdentifier
    return typeof pid === 'number' && Number.isInteger(pid) ? { pid } : {}
  }

  /** Terminate every process of a bundle id (the app and its extensions). */
  async terminateApp(udid: string, bundleId: string, signal?: AbortSignal): Promise<{ pids: number[] }> {
    const processes = await this.listProcesses(udid, signal)
    const matching = processes.filter(process => process.bundleId === bundleId)
    if (matching.length === 0) throw new DevicectlError(`no running process of "${bundleId}" on the device`)
    const pids: number[] = []
    for (const process of matching) {
      try {
        await this.#successful(['device', 'process', 'terminate', '--device', udid, '--pid', String(process.pid)],
          `devicectl device process terminate ${process.pid} on ${udid}`, DEFAULT_TIMEOUT_MS, signal)
        pids.push(process.pid)
      } catch (error) {
        // It may have exited between the listing and the terminate.
        if (!(error instanceof DevicectlError && /not found|no such process/iu.test(error.message))) throw error
      }
    }
    return { pids }
  }

  async installApp(udid: string, appPath: string, signal?: AbortSignal): Promise<void> {
    await this.#successful(['device', 'install', 'app', '--device', udid, appPath], `devicectl device install app on ${udid}`, INSTALL_TIMEOUT_MS, signal)
  }
}
