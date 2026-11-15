// Ported from dsh-ios (MIT, © 2026 ZSeven—W) @ d9a9731 — src/tools.ts (interaction mapping)
/**
 * Maps one `ios_sim_interact` call onto serve-sim input: CLI argument vectors
 * for single events, and the stream's WebSocket control channel for
 * multi-event gestures (sim-gesture.ts), with the CLI as the fallback.
 * @module ios-simulator/interact
 */

import { serveSimControlArgs, type SimStreamInfo } from './sim-host.js'
import {
  isSimShortcut,
  sendSimGesture,
  sendSimPaste,
  sendSimShortcut,
  sendSimTap,
  sendSimText,
  SIM_SHORTCUTS,
  simDragPath,
  simDragRequestOf,
  simScrollPath,
  SIM_GESTURE_STEP_MS,
  type SimGesturePoint,
  type SimScrollRequest,
} from './sim-gesture.js'

/** The serve-sim input actions (rotate / device_action are handled by the tool). */
export type SimInteractAction = 'tap' | 'type' | 'button' | 'gesture' | 'scroll' | 'shortcut'

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

/** Runs of US-keyboard characters, or runs of anything else. */
const TEXT_RUNS = /[\x20-\x7E\t\n]+|[^\x20-\x7E\t\n]+/gu

/**
 * How long to wait after ⌘V before the next keys: the paste is applied by the
 * app asynchronously, and keys typed too early land in front of it.
 */
const PASTE_SETTLE_MS = 250

/** One stretch of typed text and how it reaches the simulator. */
export interface SimTextSegment {
  /** `keys`: typed on the US hardware keyboard. `paste`: put on the pasteboard and pasted with ⌘V. */
  kind: 'keys' | 'paste'
  text: string
}

/**
 * Split text into what the US keyboard can type and what it cannot (Chinese,
 * emoji, accents, …). Order is kept, so "hi 你好\n" still ends by pressing Return.
 */
export function simTextSegments(text: string): SimTextSegment[] {
  return (text.match(TEXT_RUNS) ?? []).map(run => ({ kind: US_KEYBOARD_TEXT.test(run) ? 'keys' : 'paste', text: run }))
}

/**
 * The button names serve-sim 0.1.47 acts on: its helper's HIDInjector.sendButton
 * switch (home … app_switcher) and its CLI's HID usage table (power …
 * left-side-button). Any other name is sent, ignored by the helper, and still
 * reported as a success.
 */
export const SERVE_SIM_BUTTONS = [
  'home', 'lock', 'siri', 'side_button', 'swipe_home', 'app_switcher',
  'power', 'volume-up', 'volume-down', 'action', 'side-button', 'digital-crown', 'left-side-button',
] as const

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
      // Text the US keyboard cannot type is pasted by performSimInteract, not sent to the CLI.
      return simTextSegments(args.text).filter(segment => segment.kind === 'keys').map(segment => ['type', segment.text])
    }
    case 'button': {
      if (typeof args.name !== 'string' || args.name.trim() === '') {
        throw new Error('ios_sim_interact: action "button" requires a button name, e.g. "home"')
      }
      const name = args.name.trim()
      if (!(SERVE_SIM_BUTTONS as readonly string[]).includes(name)) {
        throw new Error(`ios_sim_interact: unknown button ${JSON.stringify(name)} — serve-sim supports ${SERVE_SIM_BUTTONS.join(', ')}`)
      }
      return [['button', name]]
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
    case 'shortcut':
      if (!isSimShortcut(args.name)) {
        throw new Error(`ios_sim_interact: action "shortcut" requires name — one of ${Object.keys(SIM_SHORTCUTS).join(', ')}`)
      }
      // A key combination has no serve-sim CLI form: performSimInteract sends it over the control socket.
      return []
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
    const [command, ...positionals] = payload
    if (command === undefined) continue
    await host.control(serveSimControlArgs(command, deviceUdid, positionals))
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
  /** Frames written when the WS channel carried it (1 begin + moves + 1 end; a tap is begin + end). */
  frames?: number
  /** Measured wall time of the traced gesture, ms. */
  elapsedMs?: number
  /** Why the WS channel was skipped or refused; the CLI carried it instead. */
  wsError?: string
  /** Stretches of typed text that went in through the simulator pasteboard and ⌘V (it now holds the last one). */
  pasted?: number
}

export interface SimInteractOptions {
  stepMs?: number
  tapHoldMs?: number
  /** Replace the simulator pasteboard — needed to type text the US keyboard cannot. */
  setPasteboard?: (udid: string, text: string) => Promise<void>
  /** Delay between the ⌘V key frames (default `SIM_PASTE_HOLD_MS`). */
  pasteHoldMs?: number
  /** Wait after a paste before typing on (default 250 ms). */
  pasteSettleMs?: number
  /** Delay between the key frames of a shortcut (default `SIM_PASTE_HOLD_MS`). */
  shortcutHoldMs?: number
  /** Pause before each typed character (default `SIM_TYPE_CHAR_GAP_MS`). */
  charGapMs?: number
}

/**
 * Type US-keyboard text: as key frames over the stream's control socket when
 * there is one (73 characters in ~0.3 s, against ~1 s for the serve-sim CLI,
 * which starts a process and types about 10 ms a character), through the CLI
 * otherwise. A socket that never opened typed nothing, so the CLI types the
 * whole text; one that broke after opening may have typed part of it, and
 * typing it again would duplicate that part — it fails instead.
 */
async function typeKeys(
  host: SimGestureHostLike,
  deviceUdid: string,
  text: string,
  wsUrl: string | undefined,
  options: SimInteractOptions,
): Promise<SimInteractDelivery> {
  let wsError: string | undefined
  if (wsUrl !== undefined) {
    let opened = false
    try {
      const report = await sendSimText(wsUrl, text, {
        ...(options.charGapMs === undefined ? {} : { charGapMs: options.charGapMs }),
        onOpen: () => { opened = true },
      })
      return { channel: 'ws', frames: report.frames, elapsedMs: report.elapsedMs }
    } catch (error) {
      if (opened) {
        throw new Error(`typing stopped part-way through (${errorMessage(error)}) — some of the text may be in the field; `
          + 'check it (ios_sim_screenshot) before typing again')
      }
      wsError = errorMessage(error)
    }
  }
  await host.control(serveSimControlArgs('type', deviceUdid, [text]))
  return { channel: 'cli', ...(wsError === undefined ? {} : { wsError }) }
}

/**
 * Type text that needs the pasteboard: US-keyboard runs go through the
 * serve-sim CLI as before, every other run is copied to the simulator
 * pasteboard and pasted with ⌘V over the control socket. Both requirements
 * are checked before the first key, so a failure never leaves half a text typed.
 */
async function typeWithPaste(
  host: SimGestureHostLike,
  deviceUdid: string,
  segments: readonly SimTextSegment[],
  wsUrl: string | undefined,
  options: SimInteractOptions,
): Promise<SimInteractDelivery> {
  const reason = 'ios_sim_interact: action "type" got text the US keyboard cannot type (Chinese, emoji, …), which is '
    + 'copied to the simulator pasteboard and pasted with ⌘V over the stream\'s control socket'
  const setPasteboard = options.setPasteboard
  if (setPasteboard === undefined) throw new Error(`${reason} — this caller has no access to the simulator pasteboard`)
  if (wsUrl === undefined) {
    throw new Error(`${reason} — no live serve-sim stream reports a control socket for ${deviceUdid}; start it with ios_sim_boot and retry`)
  }
  let pasted = 0
  let typedThroughCli = false
  for (const segment of segments) {
    if (segment.kind === 'keys') {
      if ((await typeKeys(host, deviceUdid, segment.text, wsUrl, options)).channel === 'cli') typedThroughCli = true
      continue
    }
    await setPasteboard(deviceUdid, segment.text)
    await sendSimPaste(wsUrl, options.pasteHoldMs === undefined ? {} : { holdMs: options.pasteHoldMs })
    await sleep(options.pasteSettleMs ?? PASTE_SETTLE_MS)
    pasted += 1
  }
  return { channel: typedThroughCli ? 'cli' : 'ws', pasted }
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
 * Deliver one simulator interaction. Taps and multi-event gestures go over
 * serve-sim's WebSocket control channel (a tap is the same begin → 40 ms → end
 * the `serve-sim tap` CLI sends, without spawning a Node process per tap;
 * gestures run at ~16 ms per frame, which iOS reads as a real flick); the CLI
 * is the fallback when no live stream reports a control socket for this
 * device or the socket refuses. Typing, buttons and raw frames use the CLI —
 * except typed text the US keyboard cannot produce, which is pasted (see
 * `typeWithPaste`).
 */
export async function performSimInteract(
  host: SimGestureHostLike,
  deviceUdid: string,
  args: SimInteractArgs,
  payloads: string[][],
  options: SimInteractOptions = {},
): Promise<SimInteractDelivery> {
  const points = simInteractGesturePath(args)
  const tap = args.action === 'tap' && typeof args.x === 'number' && typeof args.y === 'number'
    ? { x: args.x, y: args.y }
    : undefined
  const info = host.streamInfo
  // The control socket belongs to the ONE streamed device; never send this
  // device's gesture to a socket that streams another one.
  const wsUrl = info !== undefined && info.device === deviceUdid && typeof info.wsUrl === 'string'
    ? info.wsUrl
    : undefined
  if (args.action === 'type' && typeof args.text === 'string') {
    const segments = simTextSegments(args.text)
    if (segments.some(segment => segment.kind === 'paste')) return typeWithPaste(host, deviceUdid, segments, wsUrl, options)
    return typeKeys(host, deviceUdid, args.text, wsUrl, options)
  }
  if (args.action === 'shortcut' && isSimShortcut(args.name)) {
    if (wsUrl === undefined) {
      throw new Error(`ios_sim_interact: action "shortcut" presses a key combination over the stream's control socket, and no live `
        + `serve-sim stream reports one for ${deviceUdid}; start it with ios_sim_boot and retry`)
    }
    const report = await sendSimShortcut(wsUrl, args.name, options.shortcutHoldMs === undefined ? {} : { holdMs: options.shortcutHoldMs })
    return { channel: 'ws', frames: report.frames, elapsedMs: report.elapsedMs }
  }
  let wsError: string | undefined
  if (points !== undefined || tap !== undefined) {
    if (wsUrl === undefined) {
      wsError = `no live serve-sim stream reports a control-socket url for ${deviceUdid} `
        + '— the gesture went through the serve-sim CLI instead (one process per touch event)'
    } else {
      try {
        const report = tap !== undefined
          ? await sendSimTap(wsUrl, tap, options.tapHoldMs === undefined ? {} : { holdMs: options.tapHoldMs })
          : await sendSimGesture(wsUrl, points!, { stepMs: options.stepMs ?? SIM_GESTURE_STEP_MS })
        return { channel: 'ws', frames: report.frames, elapsedMs: report.elapsedMs }
      } catch (error) {
        wsError = errorMessage(error)
      }
    }
  }
  await performSimInteractControl(host, deviceUdid, payloads)
  return { channel: 'cli', ...(wsError === undefined ? {} : { wsError }) }
}
