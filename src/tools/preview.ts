// Ported from dsh-ios (MIT, © 2026 ZSeven—W) @ d9a9731 — src/tool-preview.ts
/**
 * `ios_sim_preview`: SwiftUI previews of a Swift package, live in the
 * simulator with hot reload (start / status / stop), on
 * src/preview-host.ts. Start also brings up the live stream and returns
 * the panel URL when serve-sim is available.
 * @module ios-simulator/tools/preview
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { ToolDeps } from '../deps.js'
import { assertMac, ensureStreamFor, resolveTargetDevice } from '../target.js'
import { deviceSummary, jsonResult, runTool, UDID_PARAM } from './result.js'

export function registerPreviewTools(server: McpServer, deps: ToolDeps): void {
  server.registerTool('ios_sim_preview', {
    title: 'Live SwiftUI previews with hot reload',
    description: 'Show the SwiftUI previews of a Swift package LIVE in the simulator, with hot reload. action "start" '
      + '(default) builds a disposable preview host app in the plugin cache (never inside the package), builds the '
      + 'package into a dylib for the simulator, installs and launches the host, then watches the package: every '
      + 'saved edit is rebuilt and hot-swapped into the running host without relaunching (a few seconds). A compile '
      + 'error never ends the session — the last good preview stays up and action "status" shows the error tail. '
      + 'Finds #Preview { … } and struct X: PreviewProvider in the library targets; several previews can be paged in '
      + 'the host, or narrowed with previewFilter. One session at a time; action "stop" removes the host app. The '
      + 'first start builds the package and can take a minute. Returns panelUrl when the live stream is available.',
    inputSchema: {
      action: z.enum(['start', 'status', 'stop']).optional(),
      packagePath: z.string().optional().describe('Absolute path to the Swift package directory (required for start)'),
      udid: UDID_PARAM,
      previewFilter: z.string().optional().describe('Only previews whose name contains this (case-insensitive)'),
    },
  }, async (args, extra) => runTool('ios_sim_preview', async () => {
    const action = args.action ?? 'start'
    if (action === 'status') return jsonResult(deps.preview.status())
    assertMac(deps.platform)
    if (action === 'stop') {
      const stopped = await deps.preview.stop(extra.signal)
      return jsonResult(stopped.device === undefined
        ? { stopped: false, note: 'no preview session was running' }
        : { stopped: true, device: deviceSummary(stopped.device), reloads: stopped.reloads })
    }
    const packagePath = args.packagePath?.trim() ?? ''
    if (packagePath === '') throw new Error('packagePath is required for action "start": the Swift package directory (it contains Package.swift)')
    const device = await resolveTargetDevice(deps, args.udid, { bootFallback: true })
    if (device.state !== 'Booted') await deps.simctl.bootDevice(device.udid)
    const booted = { ...device, state: 'Booted' }
    const status = await deps.preview.start({
      packagePath,
      device: booted,
      ...(args.previewFilter === undefined ? {} : { previewFilter: args.previewFilter }),
      signal: extra.signal,
    })
    let panel: { panelUrl: string } | { note: string }
    if (deps.host.binary.available) {
      try {
        await ensureStreamFor(deps.host, booted)
        panel = { panelUrl: await deps.panel.ensureStarted() }
      } catch (error) {
        panel = { note: `the preview runs, but the live panel could not start (${error instanceof Error ? error.message : String(error)})` }
      }
    } else {
      panel = { note: 'the preview runs in Simulator.app; the live panel needs serve-sim, which is unavailable here' }
    }
    return jsonResult({ ...status, ...panel })
  }))
}
