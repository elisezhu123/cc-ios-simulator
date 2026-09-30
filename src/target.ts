// Ported from dsh-ios (MIT, © 2026 ZSeven—W) @ d9a9731 — src/tools.ts (resolveTargetDevice)
/**
 * Which simulator a tool call targets, and the guards every tool shares.
 * The resolution order is ported from dsh-ios src/tools.ts
 * (resolveTargetDevice): explicit udid/name → streamed device → booted
 * device (iPhones, newest runtime first) → optional boot fallback.
 * @module ios-simulator/target
 */

import { SIMULATOR_UNAVAILABLE } from './config.js'
import type { SimctlApi, StreamHost } from './deps.js'
import type { RealDevice, RealDeviceApi } from './devicectl.js'
import type { SimStreamInfo } from './sim-host.js'
import { compareRuntimesDesc, type SimulatorDevice } from './simctl.js'

// Defined in config.ts, where simctl.ts can share it without an import cycle.
export { SIMULATOR_UNAVAILABLE }

export function assertMac(platform: NodeJS.Platform): void {
  if (platform !== 'darwin') {
    throw new Error(`${SIMULATOR_UNAVAILABLE} — this host runs ${platform}, so no simulator tools can run here`)
  }
}

/** Touch input and the live panel need serve-sim; say so, and what still works. */
export function assertStreamAvailable(host: StreamHost): void {
  if (!host.binary.available) {
    throw new Error(
      `serve-sim is unavailable (${host.binary.reason ?? 'unknown reason'}) — touch input and the live panel need it; `
      + 'the simctl-only tools (ios_sim_screenshot, ios_sim_list_apps, ios_sim_launch_app, ios_sim_open_url, '
      + 'ios_sim_push, ios_sim_location, ios_sim_appearance, ios_sim_record) still work, and so do the AXe and OCR '
      + 'tools (ios_sim_ui_tree, ios_sim_tap_element, ios_sim_ui_rows, ios_sim_tap_row, ios_sim_find_text, ios_sim_wait_for)',
    )
  }
}

/** Booted first, then the newest runtime, then the name. */
export function sortDevices(devices: readonly SimulatorDevice[]): SimulatorDevice[] {
  return [...devices].sort((a, b) => {
    const booted = Number(b.state === 'Booted') - Number(a.state === 'Booted')
    if (booted !== 0) return booted
    const runtime = compareRuntimesDesc(a.runtime, b.runtime)
    return runtime !== 0 ? runtime : a.name.localeCompare(b.name)
  })
}

/** Prefer iPhones, then the newest runtime. `devices` must be non-empty. */
export function pickPreferred(devices: readonly SimulatorDevice[]): SimulatorDevice {
  const iphones = devices.filter(device => device.name.toLowerCase().startsWith('iphone'))
  const pool = [...(iphones.length > 0 ? iphones : devices)]
  const picked = pool.sort((a, b) => compareRuntimesDesc(a.runtime, b.runtime))[0]
  if (picked === undefined) throw new Error('No simulator devices are installed — install an iOS Simulator runtime in Xcode, then retry')
  return picked
}

/** The tools that also work on a connected iPhone or iPad (through devicectl). */
export const REAL_DEVICE_TOOLS = 'ios_sim_list_apps, ios_sim_launch_app, ios_sim_install_app, ios_sim_processes and ios_sim_app_info'

export async function resolveTargetDevice(
  deps: { simctl: SimctlApi; host: StreamHost; realDevices?: RealDeviceApi },
  reference?: string,
  options: { bootFallback?: boolean } = {},
): Promise<SimulatorDevice> {
  if (reference !== undefined && reference.trim() !== '') {
    try {
      return await deps.simctl.getDevice(reference)
    } catch (error) {
      if (deps.realDevices !== undefined && await deps.realDevices.matches(reference)) {
        throw new Error(`"${reference.trim()}" is a connected iPhone/iPad, and this tool works on simulators only — on a `
          + `real device use ${REAL_DEVICE_TOOLS} (screen, touch and UI tools need WebDriverAgent, which is not supported yet)`)
      }
      throw error
    }
  }
  const status = deps.host.status()
  if (status.running && status.device !== undefined) {
    try {
      return await deps.simctl.getDevice(status.device)
    } catch {
      // The streamed device vanished from simctl; fall through to booted devices.
    }
  }
  const devices = await deps.simctl.listDevices()
  const booted = devices.filter(device => device.state === 'Booted')
  if (booted.length > 0) return pickPreferred(booted)
  if (options.bootFallback === true) {
    const picked = pickPreferred(devices)
    await deps.simctl.bootDevice(picked.udid)
    return { ...picked, state: 'Booted' }
  }
  throw new Error('No booted simulator and no live stream — call ios_sim_boot first, then retry')
}

/** Tools that act on a device never boot it implicitly. */
export function requireBooted(tool: string, device: SimulatorDevice): void {
  if (device.state !== 'Booted') {
    throw new Error(`${tool}: ${device.name} is ${device.state} — boot it first with ios_sim_boot (this tool never boots a device)`)
  }
}

/** Make sure the live stream serves `device` (it must already be booted). */
export async function ensureStreamFor(host: StreamHost, device: SimulatorDevice): Promise<SimStreamInfo> {
  assertStreamAvailable(host)
  const info = host.streamInfo
  if (info !== undefined && info.device === device.udid) return info
  return host.ensureRunning({ udid: device.udid })
}

export type ToolTarget = { kind: 'simulator'; device: SimulatorDevice } | { kind: 'real'; device: RealDevice }

/**
 * For the tools that work on both: an explicit reference that no simulator
 * matches is looked up among the connected iPhones and iPads. Without a
 * reference the target is always a simulator.
 */
export async function resolveToolTarget(
  deps: { simctl: SimctlApi; host: StreamHost; realDevices: RealDeviceApi },
  reference?: string,
): Promise<ToolTarget> {
  if (reference === undefined || reference.trim() === '') return { kind: 'simulator', device: await resolveTargetDevice(deps, reference) }
  let simulatorError: unknown
  try {
    return { kind: 'simulator', device: await deps.simctl.getDevice(reference) }
  } catch (error) {
    simulatorError = error
  }
  let device: RealDevice
  try {
    device = await deps.realDevices.getDevice(reference)
  } catch {
    throw simulatorError
  }
  if (device.pairingState !== 'paired' || device.state === 'unavailable') {
    throw new Error(`${device.name} is not available (${device.state}) — connect it over USB, unlock it, tap "Trust This `
      + 'Computer", and check `xcrun devicectl list devices`')
  }
  return { kind: 'real', device }
}

/** A real device in the shape every tool result's `device` carries. */
export function realDeviceSummary(device: RealDevice): { udid: string; name: string; runtime: string; state: string } {
  return { udid: device.udid, name: device.name, runtime: device.osVersion === undefined ? 'iOS' : `iOS ${device.osVersion}`, state: device.state }
}
