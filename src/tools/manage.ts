/**
 * Creating, erasing and deleting simulators.
 *
 * Erase and delete cannot be undone, so they are built to be hard to do by
 * accident: a device is named by its exact udid (several devices share a
 * name), a call without `confirm: true` only reports what it WOULD do, and a
 * booted device is refused — `simctl delete` itself removes a running
 * simulator without complaint. There is no "delete everything"; the one bulk
 * form removes the devices simctl already marks unusable.
 * @module ios-simulator/tools/manage
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { ToolDeps } from '../deps.js'
import { compareRuntimesDesc, type SimulatorDevice, type SimulatorDeviceType, type SimulatorRuntime } from '../simctl.js'
import { assertMac } from '../target.js'
import { deviceSummary, jsonResult, runTool } from './result.js'

const CONFIRM_PARAM = z.boolean().optional()
  .describe('Leave it out to see what would happen without doing it; pass true — after the user agreed — to really do it')

/** The few names an error lists: iPhones first, then the newest-looking. */
function sample(names: readonly string[], count = 10): string {
  const phoneFirst = (name: string): number => (name.startsWith('iPhone') ? 0 : 1)
  return [...names]
    .sort((a, b) => phoneFirst(a) - phoneFirst(b) || b.localeCompare(a, undefined, { numeric: true }))
    .slice(0, count)
    .join(', ')
}

function resolveDeviceType(types: readonly SimulatorDeviceType[], wanted: string): SimulatorDeviceType {
  const text = wanted.trim()
  const found = types.find(type => type.identifier === text) ?? types.find(type => type.name.toLowerCase() === text.toLowerCase())
  if (found !== undefined) return found
  const near = types.filter(type => type.name.toLowerCase().includes(text.toLowerCase()))
  throw new Error(`unknown device type ${JSON.stringify(text)} — ${near.length > 0 ? 'did you mean' : 'some of the installed ones'}: `
    + sample((near.length > 0 ? near : types).map(type => type.name)))
}

function resolveRuntime(runtimes: readonly SimulatorRuntime[], type: SimulatorDeviceType, wanted: string | undefined): SimulatorRuntime {
  const able = runtimes.filter(runtime => runtime.deviceTypes.includes(type.identifier))
  if (wanted === undefined || wanted.trim() === '') {
    const newest = [...able].sort((a, b) => compareRuntimesDesc(a.version, b.version))[0]
    if (newest === undefined) throw new Error(`no installed runtime can run ${type.name} — install one in Xcode ▸ Settings ▸ Components`)
    return newest
  }
  const text = wanted.trim().toLowerCase()
  const found = runtimes.find(runtime => runtime.identifier.toLowerCase() === text || runtime.name.toLowerCase() === text || runtime.version === text)
  if (found === undefined) {
    throw new Error(`unknown runtime ${JSON.stringify(wanted.trim())} — installed: ${sample(runtimes.map(runtime => runtime.name))}`)
  }
  if (!found.deviceTypes.includes(type.identifier)) {
    throw new Error(`${found.name} cannot run ${type.name}${able.length === 0 ? '' : ` — runtimes that can: ${sample(able.map(runtime => runtime.name))}`}`)
  }
  return found
}

export function registerManageTools(server: McpServer, deps: ToolDeps): void {
  /** The device with exactly this udid, from a fresh listing — a name is never enough to erase or delete by. */
  const deviceByUdid = async (udid: string): Promise<SimulatorDevice> => {
    const wanted = udid.trim()
    const device = (await deps.simctl.listDevices()).find(candidate => candidate.udid.toLowerCase() === wanted.toLowerCase())
    if (device === undefined) {
      throw new Error(`this needs the exact udid of an existing simulator, and ${JSON.stringify(wanted)} is not one — `
        + 'several simulators can share a name, so a name is not accepted; ios_sim_devices lists the udids')
    }
    return device
  }

  const requireShutdown = (what: string, device: SimulatorDevice): void => {
    if (device.state !== 'Shutdown') {
      throw new Error(`${device.name} is ${device.state} — a running simulator is not ${what}; shut it down first with ios_sim_shutdown`)
    }
  }

  server.registerTool('ios_sim_create', {
    title: 'Create a simulator',
    description: 'Create a new iOS Simulator device. deviceType is a device name ("iPhone 17 Pro") or type identifier; runtime '
      + '("iOS 27.2", "27.2" or an identifier) defaults to the newest installed one that can run it; name defaults to the device '
      + 'type\'s name. The new device is shut down: boot it with ios_sim_boot.',
    inputSchema: {
      deviceType: z.string().min(1).describe('Device name or type identifier, e.g. "iPhone 17 Pro"'),
      runtime: z.string().optional().describe('Runtime name, version or identifier, e.g. "iOS 27.2" (default: the newest that runs the device)'),
      name: z.string().optional().describe('Name of the new simulator (default: the device type\'s name)'),
    },
  }, async (args, extra) => runTool('ios_sim_create', async () => {
    assertMac(deps.platform)
    const catalog = await deps.simctl.listCatalog(extra.signal)
    const type = resolveDeviceType(catalog.deviceTypes, args.deviceType)
    const runtime = resolveRuntime(catalog.runtimes, type, args.runtime)
    const name = args.name?.trim() || type.name
    const udid = await deps.simctl.createDevice(name, type.identifier, runtime.identifier, extra.signal)
    return jsonResult({
      created: true,
      device: { udid, name, runtime: runtime.identifier, state: 'Shutdown' },
      deviceType: type.name,
      runtimeName: runtime.name,
    })
  }))

  server.registerTool('ios_sim_erase', {
    title: 'Erase a simulator',
    description: 'Erase all content and settings of ONE simulator (apps, data, accounts) — it cannot be undone. Takes the exact '
      + 'udid; the device must be shut down. Without confirm:true nothing is erased and the answer says what would be: ask '
      + 'the user, then call again with confirm:true.',
    inputSchema: { udid: z.string().min(1).describe('Exact simulator udid (a name is not accepted)'), confirm: CONFIRM_PARAM },
    annotations: { destructiveHint: true },
  }, async (args, extra) => runTool('ios_sim_erase', async () => {
    assertMac(deps.platform)
    const device = await deviceByUdid(args.udid)
    requireShutdown('erased', device)
    if (args.confirm !== true) {
      return jsonResult({
        erased: false,
        wouldErase: deviceSummary(device),
        confirm: 'nothing was erased — this removes every app and all data on that simulator and cannot be undone; after the '
          + 'user agrees, call ios_sim_erase again with the same udid and confirm: true',
      })
    }
    await deps.simctl.eraseDevice(device.udid, extra.signal)
    return jsonResult({ erased: true, device: deviceSummary(device) })
  }))

  server.registerTool('ios_sim_delete', {
    title: 'Delete a simulator',
    description: 'Delete ONE simulator for good, by its exact udid (it must be shut down) — or, with unavailable:true, every '
      + 'device simctl marks unusable (its runtime was removed). It cannot be undone and there is no way to delete all '
      + 'simulators at once. Without confirm:true nothing is deleted and the answer lists what would be: ask the user, then '
      + 'call again with confirm:true.',
    inputSchema: {
      udid: z.string().optional().describe('Exact udid of the simulator to delete (a name is not accepted)'),
      unavailable: z.boolean().optional().describe('true: delete the devices whose runtime is no longer installed, instead of one udid'),
      confirm: CONFIRM_PARAM,
    },
    annotations: { destructiveHint: true },
  }, async (args, extra) => runTool('ios_sim_delete', async () => {
    assertMac(deps.platform)
    const udid = args.udid?.trim() ?? ''
    if (udid !== '' && args.unavailable === true) throw new Error('pass either a udid or unavailable: true, not both')
    if (args.unavailable === true) {
      const gone = await deps.simctl.listUnavailableDevices(extra.signal)
      if (gone.length === 0) return jsonResult({ deleted: false, devices: [], note: 'there are no unavailable simulators to delete' })
      if (args.confirm !== true) {
        return jsonResult({
          deleted: false,
          wouldDelete: gone,
          confirm: `nothing was deleted — ${gone.length} unusable simulator${gone.length === 1 ? '' : 's'} would be removed for good; `
            + 'after the user agrees, call ios_sim_delete again with unavailable: true and confirm: true',
        })
      }
      await deps.simctl.deleteUnavailableDevices(extra.signal)
      return jsonResult({ deleted: true, devices: gone })
    }
    if (udid === '') throw new Error('ios_sim_delete needs the udid of the simulator to delete, or unavailable: true')
    const device = await deviceByUdid(udid)
    requireShutdown('deleted', device)
    if (args.confirm !== true) {
      return jsonResult({
        deleted: false,
        wouldDelete: [deviceSummary(device)],
        confirm: 'nothing was deleted — this removes that simulator with its apps and data and cannot be undone; after the '
          + 'user agrees, call ios_sim_delete again with the same udid and confirm: true',
      })
    }
    // Its recording and stream are gone with it; a shut-down device has neither, but never leave one behind.
    if (deps.recorder.active(device.udid) !== undefined) await deps.recorder.stop(device.udid).catch(() => undefined)
    if (deps.host.status().device === device.udid) await deps.host.stop()
    await deps.simctl.deleteDevice(device.udid, extra.signal)
    return jsonResult({ deleted: true, devices: [deviceSummary(device)] })
  }))
}
