// Ported from dsh-ios (MIT, © 2026 ZSeven—W) @ d9a9731 — src/tools.ts (core tool behaviour)
/**
 * Core `ios_sim_*` tools: devices, boot, shutdown, panel, screenshot and
 * interact. Behaviour follows dsh-ios src/tools.ts; screenshots come back as
 * image blocks because Claude reads images (dsh-ios served text-only models).
 * @module ios-simulator/tools/core
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { ToolDeps } from '../deps.js'
import { DEVICE_ACTIONS, isDeviceAction } from '../device-actions.js'
import { interactControlArgs, performSimInteract, type SimInteractArgs, type SimInteractDelivery } from '../interact.js'
import { isLandscape, readSimScreenConfig, toFramebufferArgs, type Landscape } from '../orientation.js'
import { assertMac, assertStreamAvailable, ensureStreamFor, requireBooted, resolveTargetDevice, sortDevices } from '../target.js'
import { deviceSummary, jsonResult, runTool, sleep, UDID_PARAM } from './result.js'

export const ROTATE_ORIENTATIONS = ['portrait', 'landscape_left', 'portrait_upside_down', 'landscape_right'] as const

const XCODE27_TYPE_HINT = ' — with Xcode 27, keyboard input needs Device Hub running with this simulator visible and '
  + 'frontmost, and the app that launched Claude enabled under System Settings ▸ Privacy & Security ▸ Accessibility; '
  + 'if input stays dead, `serve-sim repair-input -d <udid>` repairs it (it restarts SpringBoard and closes apps)'

/** The interact actions whose arguments carry screen coordinates. */
const COORDINATE_ACTIONS: ReadonlySet<string> = new Set(['tap', 'scroll', 'gesture'])

const LOST_ORIENTATION_WARNING = 'the screen looks landscape, but the live stream does not know its orientation (the '
  + 'device was rotated outside these tools, or the stream restarted), so taps, scrolls and gestures go out without '
  + 'the landscape mapping and can miss — send ios_sim_interact {action: "rotate", orientation: "landscape_left" or '
  + '"landscape_right"} matching the screen, then retry'

/** The capture came back, but re-sending the remembered landscape orientation to the stream failed. */
function resyncFailedWarning(orientation: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return `the screen looks landscape, but its orientation could not be resynced with the live stream (${message}); `
    + 'taps, scrolls and gestures retry the resync first and fail while it keeps failing — send ios_sim_interact '
    + `{action: "rotate", orientation: "${orientation}"} (or the landscape orientation the screen shows), then retry`
}

export function registerCoreTools(server: McpServer, deps: ToolDeps): void {
  /**
   * udid → whether the last model image returned for it was wider than tall.
   * Captures are upright in the INTERFACE orientation, so a landscape device
   * whose interface is still portrait (an app launching, a portrait-only app)
   * yields a portrait image whose coordinates already match the framebuffer.
   */
  const lastImageLandscape = new Map<string, boolean>()
  /**
   * udid → the landscape orientation last sent through `rotate` or read from
   * serve-sim (a rotate to a portrait orientation forgets it).
   */
  const rememberedLandscape = new Map<string, Landscape>()
  /** serve-sim's orientation for a streamed device; portrait when unknown. Landscape readings are remembered. */
  const orientationOf = async (udid: string): Promise<string> => {
    const info = deps.host.streamInfo
    if (info === undefined || info.device !== udid) return 'portrait'
    const orientation = (await readSimScreenConfig(info.wsUrl))?.orientation ?? 'portrait'
    if (isLandscape(orientation)) rememberedLandscape.set(udid, orientation)
    return orientation
  }
  /**
   * The orientation coordinates are mapped with and screenshots report.
   * serve-sim keeps it per stream session, starting at portrait and learning
   * only the rotates sent through that session, so a new session (idle stop,
   * device switch, crash restart) or a rotation made in Simulator.app reads
   * portrait while the interface stays landscape. When the last image was
   * landscape-shaped, a remembered landscape orientation is re-sent the way
   * `rotate` sends it (a no-op on the device that resyncs serve-sim and the
   * panel) and used; with none remembered, a warning says what to do.
   * A failed resync throws for `interact` (a mis-mapped tap is worse than an
   * error) but only warns for a screenshot, whose capture already succeeded.
   */
  const effectiveOrientation = async (
    udid: string,
    onResyncFailure: 'throw' | 'warn' = 'throw',
  ): Promise<{ orientation: string; warning?: string }> => {
    const reported = await orientationOf(udid)
    if (isLandscape(reported) || lastImageLandscape.get(udid) !== true) return { orientation: reported }
    const remembered = rememberedLandscape.get(udid)
    if (remembered === undefined) return { orientation: reported, warning: LOST_ORIENTATION_WARNING }
    // The rotate path drives the streamed device: resync only when that is this device.
    if (deps.host.streamInfo?.device === udid) {
      try {
        await deps.stream.control.rotate?.(remembered)
      } catch (error) {
        if (onResyncFailure === 'throw') throw error
        return { orientation: remembered, warning: resyncFailedWarning(remembered, error) }
      }
    }
    return { orientation: remembered }
  }

  server.registerTool('ios_sim_devices', {
    title: 'List iOS simulators',
    description: 'List the iOS Simulator devices on this Mac (udid, name, runtime, state, deviceType): booted first, '
      + 'then newest runtime. Use it to find the udid or name the other ios_sim_* tools take; `streaming` names the '
      + 'device the live panel shows. Connected iPhones and iPads are listed under `realDevices` (devicectl); pass one '
      + 'of their udids or names to the tools that support real devices.',
    inputSchema: { query: z.string().optional().describe('Case-insensitive substring over name, udid and runtime') },
    annotations: { readOnlyHint: true },
  }, async ({ query }, extra) => runTool('ios_sim_devices', async () => {
    assertMac(deps.platform)
    const all = await deps.simctl.listDevices()
    const needle = (query ?? '').trim().toLowerCase()
    const devices = sortDevices(all).filter(device => needle === ''
      || device.name.toLowerCase().includes(needle)
      || device.udid.toLowerCase().includes(needle)
      || device.runtime.toLowerCase().includes(needle))
    const status = deps.host.status()
    // Real devices are best effort: a devicectl hiccup must not hide the simulators.
    let real: { realDevices: unknown[] } | { realDevicesError: string }
    try {
      real = { realDevices: await deps.realDevices.listDevices(extra.signal) }
    } catch (error) {
      real = { realDevicesError: error instanceof Error ? error.message : String(error) }
    }
    return jsonResult({
      devices: devices.map(device => ({
        ...deviceSummary(device),
        ...(device.deviceType === undefined ? {} : { deviceType: device.deviceType }),
      })),
      count: devices.length,
      booted: all.filter(device => device.state === 'Booted').map(device => device.udid),
      ...(status.running && status.device !== undefined ? { streaming: status.device } : {}),
      ...real,
    })
  }))

  server.registerTool('ios_sim_boot', {
    title: 'Boot a simulator',
    description: 'Boot an iOS Simulator and start its live serve-sim stream. Returns panelUrl: open it in the browser '
      + 'pane (preview_start with that url) so the user can watch and tap the simulator live. Find a udid or name '
      + '(e.g. "iPhone 17 Pro") with ios_sim_devices.',
    inputSchema: { udid: z.string().min(1).describe('Simulator udid or device name, e.g. "iPhone 17 Pro"') },
  }, async ({ udid }) => runTool('ios_sim_boot', async () => {
    assertMac(deps.platform)
    const device = await deps.simctl.getDevice(udid)
    if (!deps.host.binary.available) {
      await deps.simctl.bootDevice(device.udid)
      return jsonResult({
        device: deviceSummary(device, 'Booted'),
        state: 'booted',
        streaming: false,
        note: `booted without a live stream: serve-sim is unavailable (${deps.host.binary.reason ?? 'unknown reason'})`,
      })
    }
    await deps.host.ensureRunning({ udid: device.udid })
    // Booted and streaming already: a panel that cannot start (no free port, say) must not fail the boot.
    let panel: { panelUrl: string } | { note: string }
    try {
      panel = { panelUrl: await deps.panel.ensureStarted() }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      panel = { note: `booted and streaming, but the live panel could not start (${message}) — ios_sim_panel retries it` }
    }
    return jsonResult({ device: deviceSummary(device, 'Booted'), state: 'booted', streaming: true, ...panel })
  }))

  server.registerTool('ios_sim_shutdown', {
    title: 'Shut down a simulator',
    description: 'Shut down an iOS Simulator. Stops its recording and its live stream first when they target it.',
    inputSchema: { udid: z.string().min(1).describe('Simulator udid or device name') },
    annotations: { destructiveHint: true },
  }, async ({ udid }) => runTool('ios_sim_shutdown', async () => {
    assertMac(deps.platform)
    const device = await deps.simctl.getDevice(udid)
    if (deps.recorder.active(device.udid) !== undefined) {
      await deps.recorder.stop(device.udid).catch(() => undefined)
    }
    if (deps.host.status().device === device.udid) await deps.host.stop()
    await deps.simctl.shutdownDevice(device.udid)
    return jsonResult({ device: deviceSummary(device, 'Shutdown'), state: 'shutdown', streaming: false })
  }))

  server.registerTool('ios_sim_panel', {
    title: 'Open the live panel',
    description: 'Make sure the live stream runs for a booted simulator and return panelUrl, the live panel (video, '
      + 'tap/drag, Home, rotate, screenshot). Open it with preview_start {url: panelUrl} in the browser pane; in a '
      + 'terminal-only session give the URL to the user. Never boots a device.',
    inputSchema: { udid: UDID_PARAM },
  }, async ({ udid }) => runTool('ios_sim_panel', async () => {
    assertMac(deps.platform)
    assertStreamAvailable(deps.host)
    const device = await resolveTargetDevice(deps, udid)
    requireBooted('ios_sim_panel', device)
    await ensureStreamFor(deps.host, device)
    const panelUrl = await deps.panel.ensureStarted()
    return jsonResult({
      panelUrl,
      device: deviceSummary(device),
      hint: 'Open panelUrl in the browser pane (preview_start with this url); in a terminal-only session give the URL to the user.',
    })
  }))

  server.registerTool('ios_sim_screenshot', {
    title: 'Screenshot the simulator',
    description: 'Capture the screen of a booted simulator. Returns the image (JPEG, long edge at most 1024 px) so you '
      + 'can read the screen, plus JSON with the full-resolution PNG path and sizes. To tap something you see, '
      + 'normalize its pixel position by image.width / image.height.',
    inputSchema: { udid: UDID_PARAM },
    annotations: { readOnlyHint: true },
  }, async ({ udid }, extra) => runTool('ios_sim_screenshot', async () => {
    assertMac(deps.platform)
    const device = await resolveTargetDevice(deps, udid)
    requireBooted('ios_sim_screenshot', device)
    const capture = await deps.screenshots.capture(device.udid, extra.signal)
    const image = await deps.screenshots.toModelImage(capture)
    lastImageLandscape.set(device.udid, image.width > image.height)
    const { orientation, warning } = await effectiveOrientation(device.udid, 'warn')
    return jsonResult({
      orientation,
      ...(warning === undefined ? {} : { warning }),
      path: capture.path,
      bytes: capture.bytes,
      ...(capture.width === undefined ? {} : { width: capture.width, height: capture.height }),
      image: { width: image.width, height: image.height },
      device: deviceSummary(device),
    }, image)
  }))

  server.registerTool('ios_sim_interact', {
    title: 'Interact with the simulator',
    description: 'Drive a booted simulator through serve-sim: tap at normalized 0..1 coordinates (x = pixel x / '
      + 'screenshot image width, y = pixel y / image height), type US-keyboard text, press a hardware button (home, '
      + 'lock, …), send a gesture, scroll (direction names the CONTENT), rotate, or run a device action (app-switcher, '
      + 'lock, unlock, shake, siri, action-button, re-center; all but lock drive Simulator.app and need the '
      + 'Accessibility permission). Starts the live stream when needed but never boots a device. About 300 ms after '
      + 'the action a screenshot of the result comes back as an image; pass screenshot:false when chaining actions.',
    inputSchema: {
      action: z.enum(['tap', 'type', 'button', 'gesture', 'scroll', 'rotate', 'device_action']),
      udid: UDID_PARAM,
      x: z.number().min(0).max(1).optional().describe('Normalized x (tap: required; scroll: start anchor, default 0.5)'),
      y: z.number().min(0).max(1).optional().describe('Normalized y (tap: required; scroll: start anchor, default 0.5)'),
      text: z.string().optional().describe('Text for "type" (US-keyboard ASCII only)'),
      name: z.string().optional()
        .describe('Button for "button" (home, lock, siri, volume-up, …; an unknown name fails with the full list) or the action for "device_action"'),
      json: z.record(z.string(), z.unknown()).optional()
        .describe('Gesture for "gesture": a drag {"fromX":0.1,"fromY":0.5,"toX":0.9,"toY":0.5,"duration":0.3} or one raw frame {"type":"begin","x":0.5,"y":0.5}'),
      direction: z.enum(['up', 'down', 'left', 'right']).optional()
        .describe('Scroll direction named by the CONTENT: "down" reveals content further down (the finger moves up)'),
      amount: z.number().min(0).max(1).optional().describe('Fraction of the screen a scroll travels (default 0.6)'),
      orientation: z.enum(ROTATE_ORIENTATIONS).optional().describe('Target orientation for "rotate"'),
      screenshot: z.boolean().optional().describe('Return a screenshot of the result (default true)'),
    },
  }, async (args, extra) => runTool('ios_sim_interact', async () => {
    assertMac(deps.platform)
    assertStreamAvailable(deps.host)
    const device = await resolveTargetDevice(deps, args.udid)
    requireBooted('ios_sim_interact', device)
    await ensureStreamFor(deps.host, device)
    let delivery: SimInteractDelivery | undefined
    let warning: string | undefined
    if (args.action === 'rotate') {
      if (args.orientation === undefined) {
        throw new Error(`action "rotate" requires orientation: ${ROTATE_ORIENTATIONS.join(', ')}`)
      }
      const rotate = deps.stream.control.rotate
      if (rotate === undefined) throw new Error('this stream backend cannot rotate the device')
      await rotate(args.orientation)
      if (isLandscape(args.orientation)) rememberedLandscape.set(device.udid, args.orientation)
      else rememberedLandscape.delete(device.udid)
    } else if (args.action === 'device_action') {
      const action = args.name
      if (!isDeviceAction(action)) {
        throw new Error(`action "device_action" requires name — one of ${DEVICE_ACTIONS.join(', ')}`)
      }
      const run = deps.stream.control.deviceAction
      if (run === undefined) throw new Error('this stream backend has no device actions')
      await run(action)
    } else {
      const simArgs: SimInteractArgs = {
        action: args.action,
        x: args.x,
        y: args.y,
        text: args.text,
        name: args.name,
        json: args.json,
        direction: args.direction,
        amount: args.amount,
      }
      let framebufferArgs = simArgs
      if (COORDINATE_ACTIONS.has(args.action)) {
        // Coordinates refer to the image the model was given: map them to the portrait
        // framebuffer only while that image shows a landscape interface (no image yet: trust serve-sim).
        const view = await effectiveOrientation(device.udid)
        warning = view.warning
        if (isLandscape(view.orientation) && (lastImageLandscape.get(device.udid) ?? true)) {
          framebufferArgs = toFramebufferArgs(view.orientation, simArgs)
        }
      }
      const payloads = interactControlArgs(framebufferArgs)
      try {
        delivery = await performSimInteract(deps.host, device.udid, framebufferArgs, payloads)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        throw new Error(`serve-sim ${args.action} failed: ${message}${args.action === 'type' ? XCODE27_TYPE_HINT : ''}`)
      }
    }
    const result = {
      action: args.action,
      device: deviceSummary(device),
      ...(delivery === undefined ? {} : { delivery }),
      ...(warning === undefined ? {} : { warning }),
    }
    if (args.screenshot === false) return jsonResult(result)
    await sleep(deps.settleMs)
    const capture = await deps.screenshots.capture(device.udid, extra.signal)
    const image = await deps.screenshots.toModelImage(capture)
    lastImageLandscape.set(device.udid, image.width > image.height)
    return jsonResult({
      ...result,
      screenshot: {
        path: capture.path,
        ...(capture.width === undefined ? {} : { width: capture.width, height: capture.height }),
        image: { width: image.width, height: image.height },
      },
    }, image)
  }))
}
