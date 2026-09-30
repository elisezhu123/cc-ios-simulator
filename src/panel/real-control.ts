/**
 * The panel's control frames on a real device. The browser sends the same
 * serve-sim frames for both kinds (`[tag][utf-8 JSON]`: tag 3 touch
 * `{type,x,y}` 0..1, tag 4 button `{button}`, tag 7 rotate
 * `{orientation}`); WebDriverAgent has no streaming touch channel, so a
 * begin → end pair becomes one tap (the finger barely moved) or one drag
 * (with the press duration), and moves in between are dropped.
 * @module ios-simulator/panel/real-control
 */

import { WDA_ORIENTATIONS, type WdaInteractPlan } from '../real-ui.js'

const TOUCH_TAG = 3
const BUTTON_TAG = 4
const ROTATE_TAG = 7
/** Farther than this (normalized) between begin and end is a drag, not a tap. */
export const TAP_SLOP = 0.02
const MIN_DRAG_SECONDS = 0.05
const MAX_DRAG_SECONDS = 5

const BUTTONS: Readonly<Record<string, 'home' | 'volumeUp' | 'volumeDown'>> = {
  home: 'home',
  'volume-up': 'volumeUp',
  volume_up: 'volumeUp',
  'volume-down': 'volumeDown',
  volume_down: 'volumeDown',
}

function decode(frame: Uint8Array): { tag: number; payload: Record<string, unknown> } | undefined {
  if (frame.length < 2) return undefined
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(frame.subarray(1)))
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
    return { tag: frame[0]!, payload: value as Record<string, unknown> }
  } catch {
    return undefined
  }
}

function unit(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : undefined
}

/** Turns one panel connection's frames into WDA operations (one instance per socket). */
export class RealTouchTranslator {
  #begin: { x: number; y: number; at: number } | undefined

  /** The operation a frame completes, if any; `now` is in milliseconds. */
  feed(frame: Uint8Array, now: number): WdaInteractPlan | undefined {
    const decoded = decode(frame)
    if (decoded === undefined) return undefined
    const { tag, payload } = decoded
    if (tag === BUTTON_TAG) {
      if (payload.button === 'lock') return { kind: 'lock' }
      const name = typeof payload.button === 'string' ? BUTTONS[payload.button] : undefined
      return name === undefined ? undefined : { kind: 'button', name }
    }
    if (tag === ROTATE_TAG) {
      const orientation = typeof payload.orientation === 'string' ? WDA_ORIENTATIONS[payload.orientation] : undefined
      return orientation === undefined ? undefined : { kind: 'rotate', orientation }
    }
    if (tag !== TOUCH_TAG) return undefined
    const x = unit(payload.x)
    const y = unit(payload.y)
    if (x === undefined || y === undefined) return undefined
    if (payload.type === 'begin') {
      this.#begin = { x, y, at: now }
      return undefined
    }
    if (payload.type !== 'end' || this.#begin === undefined) return undefined
    const begin = this.#begin
    this.#begin = undefined
    if (Math.hypot(x - begin.x, y - begin.y) <= TAP_SLOP) return { kind: 'tap', x: begin.x, y: begin.y }
    const duration = Math.min(MAX_DRAG_SECONDS, Math.max(MIN_DRAG_SECONDS, (now - begin.at) / 1000))
    return { kind: 'drag', fromX: begin.x, fromY: begin.y, toX: x, toY: y, duration: Math.round(duration * 100) / 100 }
  }
}
