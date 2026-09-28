// Ported from dsh-ios (MIT, © 2026 ZSeven—W) @ d9a9731 — src/tools.ts (interaction mapping)
/**
 * Maps one `ios_sim_interact` call onto serve-sim input: CLI argument vectors
 * for single events, and the stream's WebSocket control channel for
 * multi-event gestures (sim-gesture.ts), with the CLI as the fallback.
 * @module ios-simulator/interact
 */

import type { SimStreamInfo } from './sim-host.js'
import {
  sendSimGesture,
  simDragPath,
  simDragRequestOf,
  simScrollPath,
  SIM_GESTURE_STEP_MS,
  type SimGesturePoint,
  type SimScrollRequest,
} from './sim-gesture.js'

/** The serve-sim input actions (rotate / device_action are handled by the tool). */
export type SimInteractAction = 'tap' | 'type' | 'button' | 'gesture' | 'scroll'

export interface SimInteractArgs {
  action: SimInteractAction
  x?: number
  y?: number
  text?: string
  name?: string
  json?: unknown
  /** Scroll direction, named by the CONTENT ("down" reveals content further down). */
  direction?: 'up' | 'down' | 'left' | 'right'
  /** Fraction of the screen a scroll travels, 0..1 (default 0.6). */
  amount?: number
}

/**
 * Hold between the begin→move and move→end frames of the CLI FALLBACK path.
 * One serve-sim process per touch event measured 2.05 s for a 7-event scroll,
 * which iOS reads as press-and-drag; the WS channel is the default.
 */
const SCROLL_HOLD_MS = 175

const SCROLL_DIRECTIONS = ['up', 'down', 'left', 'right'] as const

/** serve-sim types through the US keyboard layout only. */
const US_KEYBOARD_TEXT = /^[\x20-\x7E\t\n]+$/u

function sleep(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Validate scroll args into the pure geometry request `simScrollPath` traces. */
export function scrollRequestOf(args: SimInteractArgs): SimScrollRequest {
  const direction = args.direction
  if (direction === undefined || !(SCROLL_DIRECTIONS as readonly string[]).includes(direction)) {
    throw new Error(
      'ios_sim_interact: action "scroll" requires direction "up", "down", "left" or "right"'
      + ` (got ${direction === undefined ? 'nothing' : JSON.stringify(direction)})`,
    )
  }
  const amount = args.amount ?? 0.6
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0 || amount > 1) {
    throw new Error(`ios_sim_interact: scroll amount must be a number within 0..1, got ${String(amount)}`)
  }
  const anchorX = typeof args.x === 'number' && Number.isFinite(args.x) ? args.x : 0.5
  const anchorY = typeof args.y === 'number' && Number.isFinite(args.y) ? args.y : 0.5
  if (anchorX < 0 || anchorX > 1 || anchorY < 0 || anchorY > 1) {
    throw new Error(`ios_sim_interact: scroll anchor x/y must be within 0..1, got x=${String(args.x)} y=${String(args.y)}`)
  }
  return { direction, amount, anchorX, anchorY }
}

/** One scroll's finger path endpoints in normalized 0..1 coordinates. */
interface ScrollPath {
  fromX: number
  fromY: number
  toX: number
  toY: number
}

/** The endpoints of the traced scroll (the CLI fallback consumes those). */
function scrollArgs(args: SimInteractArgs): ScrollPath {
  const points = simScrollPath(scrollRequestOf(args))
  const from = points[0]
  const to = points[points.length - 1]
  if (from === undefined || to === undefined) throw new Error('ios_sim_interact: the scroll path is empty')
  return { fromX: from.x, fromY: from.y, toX: to.x, toY: to.y }
}

/** CLI fallback for a path: begin → move → end, one `serve-sim gesture` each. */
function dragFramePayloads(path: ScrollPath): string[][] {
  return [
    ['gesture', JSON.stringify({ type: 'begin', x: path.fromX, y: path.fromY })],
    ['gesture', JSON.stringify({ type: 'move', x: path.toX, y: path.toY })],
    ['gesture', JSON.stringify({ type: 'end', x: path.toX, y: path.toY })],
  ]
}

/** Map a validated interact call to serve-sim CLI argument vectors. */
export function interactControlArgs(args: SimInteractArgs): string[][] {
  switch (args.action) {
    case 'tap': {
      if (typeof args.x !== 'number' || typeof args.y !== 'number' || !Number.isFinite(args.x) || !Number.isFinite(args.y)) {
        throw new Error('ios_sim_interact: action "tap" requires numeric x and y (normalized 0..1)')
      }
      if (args.x < 0 || args.x > 1 || args.y < 0 || args.y > 1) {
        throw new Error(`ios_sim_interact: tap x/y must be within 0..1, got x=${args.x} y=${args.y}`)
      }
      return [['tap', String(args.x), String(args.y)]]
    }
    case 'type': {
      if (typeof args.text !== 'string' || args.text === '') {
        throw new Error('ios_sim_interact: action "type" requires a non-empty text')
      }
      if (!US_KEYBOARD_TEXT.test(args.text)) {
        throw new Error(
          'ios_sim_interact: action "type" only supports US-keyboard ASCII text — for Chinese, emoji or other '
          + 'characters copy the text to the simulator pasteboard (printf "%s" "<text>" | xcrun simctl pbcopy <udid>) '
          + 'and paste it (long-press the field, then Paste)',
        )
      }
      return [['type', args.text]]
    }
    case 'button': {
      if (typeof args.name !== 'string' || args.name.trim() === '') {
        throw new Error('ios_sim_interact: action "button" requires a button name, e.g. "home"')
      }
      return [['button', args.name.trim()]]
    }
    case 'gesture': {
      if (typeof args.json !== 'object' || args.json === null || Array.isArray(args.json)) {
        throw new Error('ios_sim_interact: action "gesture" requires a json object, e.g. {"type":"begin","x":0.5,"y":0.5}')
      }
      // A normalized {fromX,fromY,toX,toY} payload is a PATH the CLI cannot
      // express: fall back to begin → move → end. A {type,x,y} frame is one event.
      const drag = simDragRequestOf(args.json)
      if (drag !== undefined) {
        return dragFramePayloads({ fromX: drag.fromX, fromY: drag.fromY, toX: drag.toX, toY: drag.toY })
      }
      return [['gesture', JSON.stringify(args.json)]]
    }
    case 'scroll':
      return dragFramePayloads(scrollArgs(args))
  }
}

/** What the gesture router needs from the sim host (SimHostController fits). */
export interface SimGestureHostLike {
  /** Live stream handshake — undefined when nothing is streaming. */
  readonly streamInfo?: SimStreamInfo | undefined
  control(args: readonly string[], options?: { timeoutMs?: number }): Promise<{ stdout: string; stderr: string }>
}

async function performSimInteractControl(host: SimGestureHostLike, deviceUdid: string, payloads: string[][]): Promise<void> {
  for (const payload of payloads) {
    const [command, ...rest] = payload
    if (command === undefined) continue
    await host.control([command, '-d', deviceUdid, ...rest])
    // Dwelling between frames is what makes serve-sim register a drag
    // instead of three independent touches.
    if (payloads.length > 1 && payload !== payloads[payloads.length - 1]) {
      await sleep(SCROLL_HOLD_MS)
    }
  }
}

/** Which channel actually carried one simulator interaction. */
export type SimGestureChannel = 'ws' | 'cli'

/** How one simulator interaction was delivered (diagnostics). */
export interface SimInteractDelivery {
  channel: SimGestureChannel
  /** Frames written when the WS channel carried it (1 begin + moves + 1 end). */
  frames?: number
  /** Measured wall time of the traced gesture, ms. */
  elapsedMs?: number
  /** Why the WS channel was skipped or refused; the CLI carried it instead. */
  wsError?: string
}

/** The traced finger path of a multi-event interaction, else undefined. */
export function simInteractGesturePath(args: SimInteractArgs): SimGesturePoint[] | undefined {
  if (args.action === 'scroll') return simScrollPath(scrollRequestOf(args))
  if (args.action === 'gesture') {
    const drag = simDragRequestOf(args.json)
    return drag === undefined ? undefined : simDragPath(drag)
  }
  return undefined
}

/**
 * Deliver one simulator interaction. Multi-event gestures go over serve-sim's
 * WebSocket control channel (~16 ms per frame, which iOS reads as a real
 * flick); the CLI is the fallback when no live stream reports a control
 * socket for this device or the socket refuses. Single events use the CLI.
 */
export async function performSimInteract(
  host: SimGestureHostLike,
  deviceUdid: string,
  args: SimInteractArgs,
  payloads: string[][],
  options: { stepMs?: number } = {},
): Promise<SimInteractDelivery> {
  const points = simInteractGesturePath(args)
  const info = host.streamInfo
  // The control socket belongs to the ONE streamed device; never send this
  // device's gesture to a socket that streams another one.
  const wsUrl = info !== undefined && info.device === deviceUdid && typeof info.wsUrl === 'string'
    ? info.wsUrl
    : undefined
  let wsError: string | undefined
  if (points !== undefined) {
    if (wsUrl === undefined) {
      wsError = `no live serve-sim stream reports a control-socket url for ${deviceUdid} `
        + '— the gesture went through the serve-sim CLI instead (one process per touch event)'
    } else {
      try {
        const report = await sendSimGesture(wsUrl, points, { stepMs: options.stepMs ?? SIM_GESTURE_STEP_MS })
        return { channel: 'ws', frames: report.frames, elapsedMs: report.elapsedMs }
      } catch (error) {
        wsError = errorMessage(error)
      }
    }
  }
  await performSimInteractControl(host, deviceUdid, payloads)
  return { channel: 'cli', ...(wsError === undefined ? {} : { wsError }) }
}
