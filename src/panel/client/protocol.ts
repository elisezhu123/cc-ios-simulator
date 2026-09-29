// Ported from dsh-ios (MIT, © 2026 ZSeven—W) @ d9a9731 — src/client/protocol.ts (frame encoding)
/**
 * serve-sim control frames for the browser panel — the byte-identical twin of
 * src/sim-gesture.ts on the host. Every frame is `[tag byte][utf-8 JSON]`:
 * tag 3 touch `{type,x,y}` (0..1), tag 4 button `{button}`, tag 7 rotate
 * `{orientation}`; serve-sim broadcasts tag 130 `{width,height,orientation}`.
 * @module ios-simulator/panel/client/protocol
 */

export const SIM_TOUCH_TAG = 3
export const SIM_BUTTON_TAG = 4
export const SIM_ROTATE_TAG = 7
export const SIM_CONFIG_TAG = 130

/** Orientations serve-sim accepts, in clockwise order from portrait. */
export const SIM_ROTATE_ORIENTATIONS = ['portrait', 'landscape_left', 'portrait_upside_down', 'landscape_right'] as const
export type SimRotateOrientation = typeof SIM_ROTATE_ORIENTATIONS[number]

export interface SimPoint {
  x: number
  y: number
}

export interface SimScreenConfig {
  width: number
  height: number
  orientation: string
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function encodeSimControlFrame(tag: number, payload: unknown): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(payload))
  const frame = new Uint8Array(1 + json.length)
  frame[0] = tag
  frame.set(json, 1)
  return frame
}

export function simTouchFrame(type: 'begin' | 'move' | 'end', x: number, y: number): Uint8Array {
  return encodeSimControlFrame(SIM_TOUCH_TAG, { type, x: clamp01(x), y: clamp01(y) })
}

export function simButtonFrame(name: string): Uint8Array {
  return encodeSimControlFrame(SIM_BUTTON_TAG, { button: name })
}

export function simRotateFrame(orientation: string): Uint8Array {
  return encodeSimControlFrame(SIM_ROTATE_TAG, { orientation })
}

/** The next orientation clockwise (unknown starts from portrait). */
export function nextSimRotateOrientation(current: string | undefined): SimRotateOrientation {
  const index = (SIM_ROTATE_ORIENTATIONS as readonly string[]).indexOf(current ?? '')
  return SIM_ROTATE_ORIENTATIONS[((index < 0 ? 0 : index) + 1) % SIM_ROTATE_ORIENTATIONS.length] ?? 'portrait'
}

function messageBytes(data: unknown): Uint8Array | undefined {
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  return undefined
}

/** Parse a tag-130 config frame; anything else (or malformed) is undefined. */
export function parseSimConfigFrame(data: unknown): SimScreenConfig | undefined {
  const bytes = messageBytes(data)
  if (bytes === undefined || bytes.length < 2 || bytes[0] !== SIM_CONFIG_TAG) return undefined
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes.subarray(1)))
    if (
      isRecord(value)
      && typeof value.width === 'number' && Number.isFinite(value.width)
      && typeof value.height === 'number' && Number.isFinite(value.height)
      && typeof value.orientation === 'string' && value.orientation !== ''
    ) {
      return { width: value.width, height: value.height, orientation: value.orientation }
    }
  } catch {
    // malformed config JSON
  }
  return undefined
}

/** A pointer position normalized to an element box, clamped to 0..1. */
export function normalizePointerPoint(
  event: { clientX: number; clientY: number },
  bounds: { left: number; top: number; width: number; height: number },
): SimPoint {
  const width = bounds.width > 0 ? bounds.width : 1
  const height = bounds.height > 0 ? bounds.height : 1
  return { x: clamp01((event.clientX - bounds.left) / width), y: clamp01((event.clientY - bounds.top) / height) }
}
