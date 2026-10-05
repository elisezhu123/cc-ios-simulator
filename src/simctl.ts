// Ported from dsh-ios (MIT, © 2026 ZSeven—W) @ d9a9731 — src/simctl.ts
/**
 * Thin typed wrappers over `xcrun simctl` for host-side simulator lifecycle.
 *
 * These helpers enumerate/boot/shutdown devices, capture screenshots, and
 * install/launch apps; every interaction with the streamed simulator UI goes
 * through `serve-sim` (see sim-host.ts).
 * @module ios-simulator/simctl
 */

import { execFile } from 'node:child_process'
import { SIMULATOR_UNAVAILABLE } from './config.js'

/** One available simulator device as reported by `simctl list devices`. */
export interface SimulatorDevice {
  udid: string
  name: string
  /** Runtime identifier, e.g. `com.apple.CoreSimulator.SimRuntime.iOS-26-4`. */
  runtime: string
  state: string
  /** Device type identifier, e.g. `com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro`. */
  deviceType?: string
}

/** Error raised when an `xcrun simctl` invocation fails. */
export class SimctlError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
    readonly code?: string | number,
  ) {
    super(message)
    this.name = 'SimctlError'
  }
}

const SIMCTL_LIST_TIMEOUT_MS = 30_000
const SIMCTL_BOOT_TIMEOUT_MS = 60_000
const SIMCTL_BOOTSTATUS_TIMEOUT_MS = 240_000
const SIMCTL_SHUTDOWN_TIMEOUT_MS = 60_000
const SIMCTL_SCREENSHOT_TIMEOUT_MS = 60_000
const SIMCTL_INSTALL_TIMEOUT_MS = 180_000
const SIMCTL_LAUNCH_TIMEOUT_MS = 60_000
const SIMCTL_CONTAINER_TIMEOUT_MS = 30_000
const SIMCTL_LISTAPPS_TIMEOUT_MS = 60_000
const SIMCTL_TERMINATE_TIMEOUT_MS = 30_000
const SIMCTL_UNINSTALL_TIMEOUT_MS = 60_000
const SIMCTL_MAX_BUFFER_BYTES = 16 * 1024 * 1024

/** Runs `xcrun simctl <args>` and resolves stdout; rejects with SimctlError. */
export type SimctlRunner = (args: readonly string[], timeoutMs: number, signal?: AbortSignal) => Promise<string>

/** Run `xcrun simctl <args>` and resolve its stdout, with a typed failure. */
function runXcrunSimctl(args: readonly string[], timeoutMs: number, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('xcrun', ['simctl', ...args], {
      timeout: timeoutMs,
      maxBuffer: SIMCTL_MAX_BUFFER_BYTES,
      signal,
    }, (error, stdout, stderr) => {
      if (error !== null) {
        const detail = stderr.trim()
        reject(new SimctlError(
          `simctl ${args.join(' ')} failed${detail === '' ? '' : `: ${detail}`}`,
          stderr,
          error.code ?? undefined,
        ))
        return
      }
      resolve(stdout)
    })
  })
}

let runner: SimctlRunner = runXcrunSimctl

/** Test seam: replace the simctl runner; call with no argument to restore it. */
export function setSimctlRunnerForTests(next?: SimctlRunner): void {
  runner = next ?? runXcrunSimctl
  forgetDeviceList()
}

/** What xcrun / xcode-select print when no full Xcode is selected (only the Command Line Tools, or none). */
const NO_XCODE_OUTPUT = /xcrun: error: (?:unable to find utility "simctl"|invalid active developer path)|xcode-select: (?:error|note):/iu

/**
 * Spec §10: without a usable Xcode every tool answers with the
 * SIMULATOR_UNAVAILABLE text instead of a raw xcrun error (ENOENT: no xcrun at all).
 */
function noXcodeError(error: unknown): SimctlError | undefined {
  if (!(error instanceof SimctlError)) return undefined
  if (error.code !== 'ENOENT' && !NO_XCODE_OUTPUT.test(error.stderr)) return undefined
  const detail = error.stderr.split('\n').map(line => line.trim()).filter(line => line !== '').pop()
  return new SimctlError(
    `${SIMULATOR_UNAVAILABLE} — xcrun cannot run simctl on this Mac${detail === undefined ? '' : ` (${detail})`}; install `
      + 'Xcode (the Command Line Tools alone have no simulator), open it once, then select it with '
      + '`sudo xcode-select -s /Applications/Xcode.app`',
    error.stderr,
    error.code,
  )
}

function execSimctl(args: readonly string[], timeoutMs: number, signal?: AbortSignal): Promise<string> {
  return runner(args, timeoutMs, signal).catch((error: unknown) => {
    throw noXcodeError(error) ?? error
  })
}

interface SimctlDeviceEntry {
  udid: string
  name: string
  state: string
  isAvailable?: boolean
  deviceTypeIdentifier?: string
}

/** True when simctl reports the device is already in the wanted boot state. */
function alreadyInState(stderr: string, state: 'Booted' | 'Shutdown'): boolean {
  return stderr.includes(`current state: ${state}`) || stderr.includes(`Unable to ${state === 'Booted' ? 'boot' : 'shutdown'} device in current state`)
}

/**
 * Parse `simctl list devices --json` into every *available* device as
 * `{ udid, name, runtime, state, deviceType? }`. Unavailable devices
 * (mismatched runtime, corrupt, …) are skipped.
 */
export function parseDeviceList(stdout: string): SimulatorDevice[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch (error) {
    throw new SimctlError(
      `simctl list devices returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      stdout,
    )
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new SimctlError('simctl list devices returned an unexpected shape', stdout)
  }
  const runtimes = (parsed as { devices?: unknown }).devices
  if (typeof runtimes !== 'object' || runtimes === null || Array.isArray(runtimes)) {
    throw new SimctlError('simctl list devices is missing its devices map', stdout)
  }
  const devices: SimulatorDevice[] = []
  for (const [runtime, entries] of Object.entries(runtimes as Record<string, unknown>)) {
    if (!Array.isArray(entries)) continue
    for (const entry of entries) {
      if (typeof entry !== 'object' || entry === null) continue
      const device = entry as unknown as SimctlDeviceEntry
      if (device.isAvailable !== true) continue
      if (typeof device.udid !== 'string' || typeof device.name !== 'string' || typeof device.state !== 'string') continue
      devices.push({
        udid: device.udid,
        name: device.name,
        runtime,
        state: device.state,
        ...(typeof device.deviceTypeIdentifier === 'string' ? { deviceType: device.deviceTypeIdentifier } : {}),
      })
    }
  }
  return devices
}

export interface DeviceListOptions {
  /**
   * Accept a listing at most this old (ms) instead of running simctl again;
   * concurrent callers share one in-flight listing. Default 0: always fresh.
   */
  maxAgeMs?: number
}

/** The last listing (or the one in flight) and when it started. */
let deviceList: { at: number; devices: Promise<SimulatorDevice[]> } | undefined

/** Drop the cached listing: boot and shutdown change device states. */
export function forgetDeviceList(): void {
  deviceList = undefined
}

/** List every *available* simulator device (see `parseDeviceList`). */
export async function listDevices(options: DeviceListOptions = {}): Promise<SimulatorDevice[]> {
  const maxAgeMs = options.maxAgeMs ?? 0
  const cached = deviceList
  if (maxAgeMs > 0 && cached !== undefined && Date.now() - cached.at <= maxAgeMs) return cached.devices
  const entry = {
    at: Date.now(),
    devices: execSimctl(['list', 'devices', '--json'], SIMCTL_LIST_TIMEOUT_MS).then(parseDeviceList),
  }
  deviceList = entry
  // A failed listing is never reused.
  entry.devices.catch(() => {
    if (deviceList === entry) deviceList = undefined
  })
  return entry.devices
}

/**
 * Boot `udid` and block until it has finished booting.
 * Tolerates a device that is already booted (boot → bootstatus returns fast).
 */
export async function bootDevice(udid: string): Promise<void> {
  forgetDeviceList()
  try {
    await execSimctl(['boot', udid], SIMCTL_BOOT_TIMEOUT_MS).catch(error => {
      if (error instanceof SimctlError && alreadyInState(error.stderr, 'Booted')) return
      throw error
    })
    await execSimctl(['bootstatus', udid, '-b'], SIMCTL_BOOTSTATUS_TIMEOUT_MS)
  } finally {
    forgetDeviceList()
  }
}

/** Shut `udid` down; tolerates a device that is already shut down. */
export async function shutdownDevice(udid: string): Promise<void> {
  forgetDeviceList()
  try {
    await execSimctl(['shutdown', udid], SIMCTL_SHUTDOWN_TIMEOUT_MS).catch(error => {
      if (error instanceof SimctlError && alreadyInState(error.stderr, 'Shutdown')) return
      throw error
    })
  } finally {
    forgetDeviceList()
  }
}

/** All available devices currently in the `Booted` state. */
export async function bootedDevices(): Promise<SimulatorDevice[]> {
  return (await listDevices()).filter(device => device.state === 'Booted')
}

/** Order runtime identifiers newest-first (numeric-aware segment compare). */
export function compareRuntimesDesc(a: string, b: string): number {
  return b.localeCompare(a, undefined, { numeric: true })
}

/**
 * Resolve a user-supplied device reference (UDID or case-insensitive device
 * name) to one available device. A name matching several runtimes prefers a
 * booted device, then the newest runtime. Unknown references fail with a
 * short list of the available devices for the model to correct itself.
 */
export async function getDevice(reference: string, options: DeviceListOptions = {}): Promise<SimulatorDevice> {
  const trimmed = reference.trim()
  if (trimmed === '') throw new SimctlError('simulator reference must be a non-empty udid or device name', '')
  const devices = await listDevices(options)
  const byUdid = devices.find(device => device.udid === trimmed)
  if (byUdid !== undefined) return byUdid
  const byName = devices.filter(device => device.name.toLowerCase() === trimmed.toLowerCase())
  if (byName.length === 1) return byName[0]
  if (byName.length > 1) {
    const booted = byName.find(device => device.state === 'Booted')
    if (booted !== undefined) return booted
    return byName.sort((a, b) => compareRuntimesDesc(a.runtime, b.runtime))[0]
  }
  const names = devices
    .sort((a, b) => compareRuntimesDesc(a.runtime, b.runtime))
    .slice(0, 8)
    .map(device => `${device.name} (${device.runtime})`)
  throw new SimctlError(
    `unknown simulator "${trimmed}" — run ios_sim_devices to list available devices`
      + (names.length === 0 ? '' : `; available include: ${names.join(', ')}`),
    '',
  )
}

/** Capture the device screen into `filePath` (`simctl io <udid> screenshot`). */
export async function takeScreenshot(udid: string, filePath: string, signal?: AbortSignal): Promise<void> {
  await execSimctl(['io', udid, 'screenshot', filePath], SIMCTL_SCREENSHOT_TIMEOUT_MS, signal)
}

/** Install a built `.app` bundle on the simulator. */
export async function installApp(udid: string, appPath: string, signal?: AbortSignal): Promise<void> {
  await execSimctl(['install', udid, appPath], SIMCTL_INSTALL_TIMEOUT_MS, signal)
}

/** Launch an installed app; resolves the `simctl launch` stdout (contains the pid). */
export async function launchApp(udid: string, bundleId: string, signal?: AbortSignal): Promise<string> {
  return execSimctl(['launch', udid, bundleId], SIMCTL_LAUNCH_TIMEOUT_MS, signal)
}

/**
 * Absolute host path of the app's data container
 * (`simctl get_app_container <udid> <bundleId> data`). The returned path is
 * on the Mac filesystem, so plugin code can read/write the app's sandbox
 * directly (used by the preview host's drop directory).
 */
export async function getAppContainer(udid: string, bundleId: string, signal?: AbortSignal): Promise<string> {
  const stdout = await execSimctl(['get_app_container', udid, bundleId, 'data'], SIMCTL_CONTAINER_TIMEOUT_MS, signal)
  const path = stdout.trim()
  if (path === '') throw new SimctlError(`simctl get_app_container returned no path for ${bundleId}`, stdout)
  return path
}

/**
 * Raw `simctl listapps <udid>` stdout — one OLD-STYLE plist keyed by bundle id
 * (parsed in app-list.ts, which is also where the CJK \Uxxxx escaping lives).
 * A device that is not booted makes simctl exit non-zero, which surfaces as a
 * SimctlError: the app-listing tool must fail loudly there, because an empty
 * listing and a failed one meant the same thing to the model once and cost a
 * whole session (WP57).
 */
export async function listAppsPlist(udid: string, signal?: AbortSignal): Promise<string> {
  return execSimctl(['listapps', udid], SIMCTL_LISTAPPS_TIMEOUT_MS, signal)
}

/** Terminate a running app; resolves `simctl terminate` stdout (contains the pid). */
export async function terminateApp(udid: string, bundleId: string, signal?: AbortSignal): Promise<string> {
  return execSimctl(['terminate', udid, bundleId], SIMCTL_TERMINATE_TIMEOUT_MS, signal)
}

/** Uninstall an app (removes its data container as well). */
export async function uninstallApp(udid: string, bundleId: string, signal?: AbortSignal): Promise<void> {
  await execSimctl(['uninstall', udid, bundleId], SIMCTL_UNINSTALL_TIMEOUT_MS, signal)
}

const SIMCTL_OPENURL_TIMEOUT_MS = 60_000
const SIMCTL_PUSH_TIMEOUT_MS = 30_000
const SIMCTL_LOCATION_TIMEOUT_MS = 30_000
const SIMCTL_UI_TIMEOUT_MS = 30_000

/** Open a URL or deep link on the device (`simctl openurl`). */
export async function openUrl(udid: string, url: string, signal?: AbortSignal): Promise<void> {
  await execSimctl(['openurl', udid, url], SIMCTL_OPENURL_TIMEOUT_MS, signal)
}

/** Deliver an APNs payload file to an installed app (`simctl push`). */
export async function sendPush(udid: string, bundleId: string, payloadPath: string, signal?: AbortSignal): Promise<void> {
  await execSimctl(['push', udid, bundleId, payloadPath], SIMCTL_PUSH_TIMEOUT_MS, signal)
}

/**
 * `simctl location <udid> set <lat>,<lon>` — the coordinate pair is ONE
 * comma-joined argument (the old panel passed two and never worked).
 */
export function locationSetArgs(udid: string, latitude: number, longitude: number): string[] {
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
    throw new RangeError(`latitude must be within -90..90, got ${String(latitude)}`)
  }
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    throw new RangeError(`longitude must be within -180..180, got ${String(longitude)}`)
  }
  return ['location', udid, 'set', `${latitude},${longitude}`]
}

/** Set the simulated GPS location. */
export async function setLocation(udid: string, latitude: number, longitude: number, signal?: AbortSignal): Promise<void> {
  await execSimctl(locationSetArgs(udid, latitude, longitude), SIMCTL_LOCATION_TIMEOUT_MS, signal)
}

/** Clear the simulated location (and stop any running scenario). */
export async function clearLocation(udid: string, signal?: AbortSignal): Promise<void> {
  await execSimctl(['location', udid, 'clear'], SIMCTL_LOCATION_TIMEOUT_MS, signal)
}

/** Switch the device between light and dark mode. */
export async function setAppearance(udid: string, appearance: 'light' | 'dark', signal?: AbortSignal): Promise<void> {
  await execSimctl(['ui', udid, 'appearance', appearance], SIMCTL_UI_TIMEOUT_MS, signal)
}
