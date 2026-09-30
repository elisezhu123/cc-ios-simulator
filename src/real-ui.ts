// Ported from dsh-ios (MIT, © 2026 ZSeven—W) @ d9a9731 — src/tool-uitree.ts (wdaTree), src/tools.ts (real-device interact)
/**
 * The real-device side of the screen, touch and UI tools, on WebDriverAgent:
 * - `wdaTree`: the accessibility tree with WDA's snapshot depth capped (an
 *   uncapped `/source` on a busy app takes ~30 s) and one automatic deeper
 *   retry when the capped read saw no labels;
 * - `captureWda`: a WDA screenshot saved into the screenshot cache;
 * - `planWdaInteract`: ios_sim_interact arguments → one WDA operation, in
 *   normalized coordinates the caller scales by `windowSize()` (points).
 * @module ios-simulator/real-ui
 */

import type { ScreenshotService } from './deps.js'
import { scrollRequestOf, type SimInteractArgs } from './interact.js'
import type { ScreenshotCapture } from './screenshot.js'
import { simScrollPath } from './sim-gesture.js'
import { hasLabeledNode } from './uitree.js'
import type { AxeElement } from './uitree-backend.js'
import { WDA_DEFAULT_SNAPSHOT_DEPTH, type WdaControl } from './wda-client.js'
import { wdaSourceToElements } from './wda-uitree.js'

/** The one deeper retry of a capped read that saw only container chrome. */
export const DEEPEN_SNAPSHOT_DEPTH = 40
/** List and feed rows only surface this deep in WDA's snapshot. */
export const ROW_SNAPSHOT_DEPTH = 60

export interface WdaTreeSample {
  roots: AxeElement[]
  sampledDepth: number
  deepened: boolean
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The normalized accessibility tree of the device's frontmost app. An
 * explicit depth is a budget and is never exceeded; the default one
 * (WDA_DEFAULT_SNAPSHOT_DEPTH) is retried once at DEEPEN_SNAPSHOT_DEPTH when
 * it returned no labeled element.
 */
export async function wdaTree(client: WdaControl, deviceName: string, depth?: number): Promise<WdaTreeSample> {
  const snapshotAt = async (snapshotDepth: number): Promise<AxeElement[]> => {
    // An older WDA without /appium/settings still answers, just uncapped.
    await client.setSnapshotDepth(snapshotDepth).catch(() => undefined)
    let xml: string
    try {
      xml = await client.source()
    } catch (error) {
      throw new Error(`the WebDriverAgent source read failed for ${deviceName}: ${errorMessage(error)}`)
    }
    try {
      return wdaSourceToElements(xml)
    } catch (error) {
      throw new Error(`could not parse the accessibility tree of ${deviceName}: ${errorMessage(error)}`)
    }
  }
  if (depth !== undefined) return { roots: await snapshotAt(depth), sampledDepth: depth, deepened: false }
  const first = await snapshotAt(WDA_DEFAULT_SNAPSHOT_DEPTH)
  if (hasLabeledNode(first)) return { roots: first, sampledDepth: WDA_DEFAULT_SNAPSHOT_DEPTH, deepened: false }
  return { roots: await snapshotAt(DEEPEN_SNAPSHOT_DEPTH), sampledDepth: DEEPEN_SNAPSHOT_DEPTH, deepened: true }
}

/** A WDA screenshot, saved like a simulator one (same cache, same pruning). */
export async function captureWda(client: WdaControl, screenshots: ScreenshotService, udid: string, deviceName: string): Promise<ScreenshotCapture> {
  let pngBase64: string
  try {
    pngBase64 = (await client.screenshot()).pngBase64
  } catch (error) {
    throw new Error(`the WebDriverAgent screenshot failed for ${deviceName}: ${errorMessage(error)}`)
  }
  return screenshots.save(udid, Buffer.from(pngBase64, 'base64'))
}

/** WDA `/orientation` values for the ios_sim_interact rotate names. */
export const WDA_ORIENTATIONS: Readonly<Record<string, string>> = {
  portrait: 'PORTRAIT',
  landscape_left: 'LANDSCAPE',
  landscape_right: 'UIA_DEVICE_ORIENTATION_LANDSCAPERIGHT',
  portrait_upside_down: 'UIA_DEVICE_ORIENTATION_PORTRAIT_UPSIDEDOWN',
}

/** Hardware buttons WDA can press (`POST /wda/pressButton`); lock goes through `/wda/lock`. */
export const WDA_BUTTONS = ['home', 'volumeUp', 'volumeDown', 'lock'] as const
/** The ios_sim_interact device actions a real device supports. */
export const WDA_DEVICE_ACTIONS = ['lock', 'unlock', 'siri'] as const

const BUTTON_ALIASES: Readonly<Record<string, (typeof WDA_BUTTONS)[number]>> = {
  home: 'home',
  lock: 'lock',
  'volume-up': 'volumeUp',
  volumeup: 'volumeUp',
  'volume-down': 'volumeDown',
  volumedown: 'volumeDown',
}

/** One WDA operation; coordinates are normalized 0..1 of the app window. */
export type WdaInteractPlan =
  | { kind: 'tap'; x: number; y: number }
  | { kind: 'drag'; fromX: number; fromY: number; toX: number; toY: number; duration: number }
  | { kind: 'type'; text: string }
  | { kind: 'button'; name: 'home' | 'volumeUp' | 'volumeDown' }
  | { kind: 'lock' }
  | { kind: 'unlock' }
  | { kind: 'siri' }
  | { kind: 'rotate'; orientation: string }

function unit(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${what} must be a number within 0..1 (normalized), got ${JSON.stringify(value)}`)
  }
  return value
}

export interface RealInteractArgs extends Omit<SimInteractArgs, 'action'> {
  orientation?: string
}

/** Validate ios_sim_interact arguments for a real device into one WDA operation. */
export function planWdaInteract(action: string, args: RealInteractArgs): WdaInteractPlan {
  switch (action) {
    case 'tap':
      return { kind: 'tap', x: unit(args.x, 'tap x'), y: unit(args.y, 'tap y') }
    case 'type':
      // WDA types through the device keyboard, so any Unicode text works (unlike the simulator path).
      if (typeof args.text !== 'string' || args.text === '') throw new Error('action "type" requires a non-empty text')
      return { kind: 'type', text: args.text }
    case 'button': {
      const button = BUTTON_ALIASES[(args.name ?? '').trim().toLowerCase()]
      if (button === undefined) {
        throw new Error(`unknown button ${JSON.stringify(args.name)} — on a real device WebDriverAgent supports home, lock, volume-up and volume-down`)
      }
      return button === 'lock' ? { kind: 'lock' } : { kind: 'button', name: button }
    }
    case 'gesture': {
      const json = (typeof args.json === 'object' && args.json !== null && !Array.isArray(args.json) ? args.json : {}) as Record<string, unknown>
      if (!['fromX', 'fromY', 'toX', 'toY'].every(key => key in json)) {
        throw new Error('on a real device action "gesture" takes a drag {"fromX","fromY","toX","toY","duration"} (normalized); single touch frames are simulator-only')
      }
      const duration = json.duration ?? 0.3
      if (typeof duration !== 'number' || !Number.isFinite(duration) || duration < 0 || duration > 10) {
        throw new Error(`gesture duration must be seconds within 0..10, got ${JSON.stringify(duration)}`)
      }
      return {
        kind: 'drag',
        fromX: unit(json.fromX, 'gesture fromX'),
        fromY: unit(json.fromY, 'gesture fromY'),
        toX: unit(json.toX, 'gesture toX'),
        toY: unit(json.toY, 'gesture toY'),
        duration,
      }
    }
    case 'scroll': {
      const points = simScrollPath(scrollRequestOf({ ...args, action: 'scroll' }))
      const from = points[0]!
      const to = points[points.length - 1]!
      return { kind: 'drag', fromX: from.x, fromY: from.y, toX: to.x, toY: to.y, duration: 0.3 }
    }
    case 'rotate': {
      const orientation = WDA_ORIENTATIONS[args.orientation ?? '']
      if (orientation === undefined) throw new Error(`action "rotate" requires orientation: ${Object.keys(WDA_ORIENTATIONS).join(', ')}`)
      return { kind: 'rotate', orientation }
    }
    case 'device_action':
      if (args.name === 'lock') return { kind: 'lock' }
      if (args.name === 'unlock') return { kind: 'unlock' }
      if (args.name === 'siri') return { kind: 'siri' }
      throw new Error(`on a real device device_action supports ${WDA_DEVICE_ACTIONS.join(', ')} (the others drive Simulator.app)`)
    default:
      throw new Error(`unknown action ${JSON.stringify(action)}`)
  }
}

/** Run a plan; normalized coordinates are scaled by the app window size in points. */
export async function runWdaInteract(client: WdaControl, plan: WdaInteractPlan): Promise<{ points?: Record<string, number> }> {
  const round = (value: number): number => Math.round(value * 100) / 100
  switch (plan.kind) {
    case 'tap': {
      const size = await client.windowSize()
      const x = round(plan.x * size.width)
      const y = round(plan.y * size.height)
      await client.tap(x, y)
      return { points: { x, y } }
    }
    case 'drag': {
      const size = await client.windowSize()
      const drag = {
        fromX: round(plan.fromX * size.width),
        fromY: round(plan.fromY * size.height),
        toX: round(plan.toX * size.width),
        toY: round(plan.toY * size.height),
        duration: plan.duration,
      }
      await client.dragFromToForDuration(drag)
      return { points: drag }
    }
    case 'type':
      await client.typeText(plan.text)
      return {}
    case 'button':
      await client.pressButton(plan.name)
      return {}
    case 'lock':
      await client.lock()
      return {}
    case 'unlock':
      await client.unlock()
      return {}
    case 'siri':
      await client.activateSiri()
      return {}
    case 'rotate':
      await client.setOrientation(plan.orientation)
      return {}
  }
}
