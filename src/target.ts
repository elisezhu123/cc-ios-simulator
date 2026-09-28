// Ported from dsh-ios (MIT, © 2026 ZSeven—W) @ d9a9731 — src/tools.ts (resolveTargetDevice)
/**
 * Which simulator a tool call targets, and the guards every tool shares.
 * The resolution order is ported from dsh-ios src/tools.ts
 * (resolveTargetDevice): explicit udid/name → streamed device → booted
 * device (iPhones, newest runtime first) → optional boot fallback.
 * @module ios-simulator/target
 */

import type { SimctlApi, StreamHost } from './deps.js'
import type { SimStreamInfo } from './sim-host.js'
import { compareRuntimesDesc, type SimulatorDevice } from './simctl.js'

/** Error prefix on hosts that cannot run the simulator. */
export const SIMULATOR_UNAVAILABLE = 'iOS Simulator requires macOS with Xcode'

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
      + 'ios_sim_push, ios_sim_location, ios_sim_appearance, ios_sim_record) still work',
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

export async function resolveTargetDevice(
  deps: { simctl: SimctlApi; host: StreamHost },
  reference?: string,
  options: { bootFallback?: boolean } = {},
): Promise<SimulatorDevice> {
  if (reference !== undefined && reference.trim() !== '') return deps.simctl.getDevice(reference)
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
