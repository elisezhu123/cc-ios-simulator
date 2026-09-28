/**
 * Environment tools carried over from the old panel, rebuilt on argument
 * arrays: open a URL, send a push, set or clear the location, switch the
 * appearance, and record the screen.
 * @module ios-simulator/tools/env
 */

import { randomUUID } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { ToolDeps } from '../deps.js'
import type { SimulatorDevice } from '../simctl.js'
import { assertMac, requireBooted, resolveTargetDevice } from '../target.js'
import { deviceSummary, jsonResult, runTool, UDID_PARAM } from './result.js'

export function registerEnvTools(server: McpServer, deps: ToolDeps): void {
  const bootedDevice = async (tool: string, udid: string | undefined): Promise<SimulatorDevice> => {
    assertMac(deps.platform)
    const device = await resolveTargetDevice(deps, udid)
    requireBooted(tool, device)
    return device
  }

  server.registerTool('ios_sim_open_url', {
    title: 'Open a URL or deep link',
    description: 'Open a URL or deep link (https://…, myapp://path) on a booted simulator.',
    inputSchema: { url: z.string().min(1), udid: UDID_PARAM },
  }, async (args, extra) => runTool('ios_sim_open_url', async () => {
    const url = args.url.trim()
    if (!/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(url)) {
      throw new Error(`url needs a scheme, e.g. https://example.com or myapp://path (got "${url}")`)
    }
    const device = await bootedDevice('ios_sim_open_url', args.udid)
    await deps.simctl.openUrl(device.udid, url, extra.signal)
    return jsonResult({ device: deviceSummary(device), url, opened: true })
  }))

  server.registerTool('ios_sim_push', {
    title: 'Send a push notification',
    description: 'Send a simulated push notification to an installed app. payload is the APNs JSON and must contain '
      + 'an "aps" object, e.g. {"aps":{"alert":{"title":"Hi","body":"Test"},"badge":1,"sound":"default"}}.',
    inputSchema: { bundleId: z.string().min(1), payload: z.record(z.string(), z.unknown()), udid: UDID_PARAM },
  }, async (args, extra) => runTool('ios_sim_push', async () => {
    const aps = args.payload.aps
    if (typeof aps !== 'object' || aps === null || Array.isArray(aps)) {
      throw new Error('payload must contain an "aps" object, e.g. {"aps":{"alert":"Hello"}}')
    }
    const bundleId = args.bundleId.trim()
    const device = await bootedDevice('ios_sim_push', args.udid)
    const dir = join(deps.cacheRoot, 'tmp')
    await mkdir(dir, { recursive: true })
    const file = join(dir, `push-${randomUUID()}.json`)
    await writeFile(file, JSON.stringify(args.payload), { mode: 0o600 })
    try {
      await deps.simctl.sendPush(device.udid, bundleId, file, extra.signal)
    } finally {
      await rm(file, { force: true })
    }
    return jsonResult({ device: deviceSummary(device), bundleId, sent: true })
  }))

  server.registerTool('ios_sim_location', {
    title: 'Set the simulated location',
    description: 'Set the simulated GPS location of a booted simulator (latitude and longitude), or clear it with clear:true.',
    inputSchema: {
      latitude: z.number().min(-90).max(90).optional(),
      longitude: z.number().min(-180).max(180).optional(),
      clear: z.boolean().optional(),
      udid: UDID_PARAM,
    },
  }, async (args, extra) => runTool('ios_sim_location', async () => {
    if (args.clear !== true && (args.latitude === undefined || args.longitude === undefined)) {
      throw new Error('pass both latitude and longitude, or clear:true')
    }
    const device = await bootedDevice('ios_sim_location', args.udid)
    if (args.clear === true) {
      await deps.simctl.clearLocation(device.udid, extra.signal)
      return jsonResult({ device: deviceSummary(device), cleared: true })
    }
    const latitude = args.latitude ?? 0
    const longitude = args.longitude ?? 0
    await deps.simctl.setLocation(device.udid, latitude, longitude, extra.signal)
    return jsonResult({ device: deviceSummary(device), latitude, longitude })
  }))

  server.registerTool('ios_sim_appearance', {
    title: 'Switch light or dark mode',
    description: 'Switch a booted simulator between light and dark mode.',
    inputSchema: { appearance: z.enum(['light', 'dark']), udid: UDID_PARAM },
  }, async (args, extra) => runTool('ios_sim_appearance', async () => {
    const device = await bootedDevice('ios_sim_appearance', args.udid)
    await deps.simctl.setAppearance(device.udid, args.appearance, extra.signal)
    return jsonResult({ device: deviceSummary(device), appearance: args.appearance })
  }))

  server.registerTool('ios_sim_record', {
    title: 'Record the screen',
    description: 'Record the simulator screen. action "start" begins a recording (outputPath optional, .mov or .mp4; '
      + 'default in the plugin cache); action "stop" finishes it and returns the file path, size and duration. '
      + 'One recording per device.',
    inputSchema: { action: z.enum(['start', 'stop']), outputPath: z.string().optional(), udid: UDID_PARAM },
  }, async args => runTool('ios_sim_record', async () => {
    const device = await bootedDevice('ios_sim_record', args.udid)
    if (args.action === 'start') {
      const info = await deps.recorder.start(device.udid, args.outputPath === undefined ? undefined : resolve(args.outputPath))
      return jsonResult({ device: deviceSummary(device), recording: true, path: info.path })
    }
    const result = await deps.recorder.stop(device.udid)
    return jsonResult({
      device: deviceSummary(device),
      recording: false,
      path: result.path,
      bytes: result.bytes,
      durationMs: result.durationMs,
    })
  }))
}
