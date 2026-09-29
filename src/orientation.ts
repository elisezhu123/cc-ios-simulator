/**
 * Orientation-aware coordinates. serve-sim touches are normalized to the
 * PORTRAIT framebuffer, while `simctl io screenshot` already returns captures
 * upright in the interface orientation, so the tools never rotate images: in
 * landscape they only map the model's image coordinates back to the
 * framebuffer, with the same inverse the panel uses (src/panel/client/layout.ts).
 * @module ios-simulator/orientation
 */

import { WebSocket } from 'ws'
import type { SimInteractArgs } from './interact.js'
import { framebufferPoint } from './panel/client/layout.js'
import { parseSimConfigFrame, type SimScreenConfig } from './panel/client/protocol.js'
import { simDragRequestOf } from './sim-gesture.js'

type Direction = 'up' | 'down' | 'left' | 'right'
type Landscape = 'landscape_left' | 'landscape_right'

export function isLandscape(orientation: string): orientation is Landscape {
  return orientation === 'landscape_left' || orientation === 'landscape_right'
}

/**
 * Timed-out reads in a row per control socket. serve-sim greets a socket with
 * its config only once the stream's capture session has a first frame, and a
 * stream's first control connection may be what starts that session (the
 * greeting then took 1.1 s on a live simulator), so one timeout is not
 * silence. A socket silent on two reads in a row is not asked again: a
 * serve-sim that never sends a config costs two waits, not one per screenshot.
 */
const silentReads = new Map<string, number>()
const SILENT_AFTER_READS = 2

/** Read serve-sim's current screen config (tag 130) from its control socket. */
export function readSimScreenConfig(wsUrl: string, timeoutMs = 800): Promise<SimScreenConfig | undefined> {
  if ((silentReads.get(wsUrl) ?? 0) >= SILENT_AFTER_READS) return Promise.resolve(undefined)
  return new Promise(resolve => {
    let settled = false
    const socket = new WebSocket(wsUrl, { perMessageDeflate: false })
    const finish = (config: SimScreenConfig | undefined): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.terminate()
      resolve(config)
    }
    const timer = setTimeout(() => {
      silentReads.set(wsUrl, (silentReads.get(wsUrl) ?? 0) + 1)
      finish(undefined)
    }, timeoutMs)
    socket.on('message', data => {
      const config = parseSimConfigFrame(data)
      if (config === undefined) return
      silentReads.delete(wsUrl)
      finish(config)
    })
    socket.on('error', () => finish(undefined))
    socket.on('close', () => finish(undefined))
  })
}

/** Content direction in upright space → content direction in framebuffer space. */
const SCROLL_DIRECTIONS: Readonly<Record<Landscape, Readonly<Record<Direction, Direction>>>> = {
  landscape_left: { down: 'right', up: 'left', right: 'up', left: 'down' },
  landscape_right: { down: 'left', up: 'right', right: 'down', left: 'up' },
}

/** Map interact args given in UPRIGHT-image coordinates to framebuffer coordinates. */
export function toFramebufferArgs(orientation: string, args: SimInteractArgs): SimInteractArgs {
  if (!isLandscape(orientation)) return args
  const map = (x: number, y: number): { x: number; y: number } => framebufferPoint(orientation, { x, y })
  switch (args.action) {
    case 'tap': {
      if (typeof args.x !== 'number' || typeof args.y !== 'number') return args
      const point = map(args.x, args.y)
      return { ...args, x: point.x, y: point.y }
    }
    case 'scroll': {
      const anchor = map(args.x ?? 0.5, args.y ?? 0.5)
      const direction = args.direction === undefined ? undefined : SCROLL_DIRECTIONS[orientation][args.direction]
      return { ...args, x: anchor.x, y: anchor.y, ...(direction === undefined ? {} : { direction }) }
    }
    case 'gesture': {
      const json = args.json
      if (typeof json !== 'object' || json === null || Array.isArray(json)) return args
      const record = json as Record<string, unknown>
      const drag = simDragRequestOf(record)
      if (drag !== undefined) {
        const from = map(drag.fromX, drag.fromY)
        const to = map(drag.toX, drag.toY)
        return { ...args, json: { ...record, fromX: from.x, fromY: from.y, toX: to.x, toY: to.y } }
      }
      if (typeof record.x === 'number' && typeof record.y === 'number') {
        const point = map(record.x, record.y)
        return { ...args, json: { ...record, x: point.x, y: point.y } }
      }
      return args
    }
    default:
      return args
  }
}
