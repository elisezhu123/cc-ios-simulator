// Ported from dsh-ios (MIT, © 2026 ZSeven—W) @ d9a9731 — src/stream-source.ts
/**
 * Common host-facing stream contract shared by the simulator and real-device
 * hosts, so the web routes and the panel never care where pixels come from.
 *
 * Both hosts are exposed through this contract:
 * - `SimHostController` → `SimStreamSource` (serve-sim MJPEG + CLI control);
 * - `WdaController` → `WdaStreamSource` (WebDriverAgent MJPEG tunnel + REST
 *   control).
 *
 * Coordinate contract: `control.tap(x, y)` and `control.drag(...)` take
 * NORMALIZED 0..1 coordinates of the streamed frame (the panel's canvas
 * space). Each adapter maps those onto its backend's native space:
 * - serve-sim gestures are already normalized (0..1 of the simulator screen);
 * - WDA gestures take absolute POINT coordinates, so `WdaStreamSource`
 *   multiplies by the current window size (`GET /window/size`).
 *
 * The sim adapter only wraps the existing controller — `sim-host.ts` itself
 * is untouched, and every `SimStreamSource` call delegates straight through.
 * @module ios-simulator/stream-source
 */

import { readFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runSimulatorDeviceAction, type DeviceAction } from './device-actions.js'
import { takeScreenshot } from './simctl.js'
import type { SimHostController, SimStreamInfo } from './sim-host.js'

/** The slice of SimHostController this adapter uses (structural, so tests can fake it). */
export type SimStreamHost = Pick<SimHostController, 'ensureRunning' | 'status' | 'stop' | 'acquire' | 'control'>

/** Which backend a stream source fronts. */
export type StreamSourceKind = 'simulator' | 'real-device'

/** Normalized point (0..1) in the streamed frame. */
export interface StreamPoint {
  x: number
  y: number
}

/** Normalized drag gesture in the streamed frame (0..1). */
export interface StreamDrag {
  fromX: number
  fromY: number
  toX: number
  toY: number
  /** Gesture duration in seconds (default 0.3). */
  duration?: number
}

/** A captured frame: base64 PNG plus its pixel size when known. */
export interface StreamScreenshot {
  pngBase64: string
  width?: number
  height?: number
}

/** Panel-facing control surface; coordinates are normalized 0..1. */
export interface StreamControl {
  /** Tap at normalized 0..1 coordinates of the streamed frame. */
  tap(x: number, y: number): Promise<void>
  /** Drag between normalized 0..1 coordinates. */
  drag(drag: StreamDrag): Promise<void>
  /** Press a hardware button; default `home`. */
  button(name?: string): Promise<void>
  /** Type text into the focused element. */
  type(text: string): Promise<void>
  /** Set the device orientation (backend-specific value); may be absent. */
  rotate?(orientation: string): Promise<void>
  /**
   * Run a device-level action (App Switcher, lock/unlock, shake, Siri, …).
   * Optional because the two backends cover different subsets — see
   * device-actions.ts for the table and how each one is delivered.
   */
  deviceAction?(action: DeviceAction): Promise<void>
  /** Capture the current frame as base64 PNG. */
  screenshot(): Promise<StreamScreenshot>
  /** Accessibility tree snapshot (backend-specific text); may be absent. */
  uiTree?(): Promise<string>
}

/** What `ensureRunning` reports for one stream source. */
export interface StreamSourceInfo {
  udid: string
  /** MJPEG stream URL the panel proxies. */
  mjpegUrl?: string
  /** Control-plane base URL (serve-sim HTTP / WDA REST). */
  controlUrl?: string
  /** Backend session identifier (WDA sessions only). */
  sessionId?: string
  /** Hardware udid for real devices (xcodebuild/iproxy form). */
  hardwareUdid?: string
}

/** Common status view for both kinds; host-specific detail stays host-side. */
export interface StreamSourceStatus {
  kind: StreamSourceKind
  available: boolean
  running: boolean
  device?: string
  consumers: number
  lastError?: string
  mjpegUrl?: string
  controlUrl?: string
}

/**
 * The common interface both hosts satisfy (via the adapters in this module).
 * Routes/panel call `ensureRunning`, hold a consumer through `acquire()`,
 * proxy `mjpegUrl`, and drive `control` — identical shape for both kinds.
 */
export interface StreamSource {
  readonly kind: StreamSourceKind
  ensureRunning(udid: string): Promise<StreamSourceInfo>
  status(): StreamSourceStatus
  stop(): Promise<void>
  /** Hold the stream for one consumer; the returned function releases it. */
  acquire(): () => void
  /** Release the most recent `acquire()` (stack semantics). */
  release(): void
  /** Current MJPEG stream URL, when running. */
  readonly mjpegUrl: string | undefined
  readonly control: StreamControl
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

function requireNormalized(x: number, y: number): void {
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) {
    throw new RangeError('ios-simulator: tap/drag coordinates must be normalized 0..1 of the streamed frame')
  }
}

/** Pixel size of a PNG from its IHDR chunk, without decoding the image. */
export function pngDimensionsFromBase64(base64: string): { width: number; height: number } | undefined {
  const buffer = Buffer.from(base64, 'base64')
  if (buffer.length < 24) return undefined
  if (buffer.readUInt32BE(0) !== 0x89504e47) return undefined // \x89PNG
  if (buffer.readUInt32BE(12) !== 0x49484452) return undefined // 'IHDR'
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

/**
 * Thin `StreamSource` adapter over `SimHostController`. Nothing about the sim
 * host changes: launches, the refcount, keep-alive and stop semantics are all
 * delegated one-to-one, and serve-sim's own CLI is used for control.
 */
export class SimStreamSource implements StreamSource {
  readonly kind = 'simulator' as const
  #lastInfo: SimStreamInfo | undefined
  #releases: Array<() => void> = []

  constructor(private readonly host: SimStreamHost) {}

  get mjpegUrl(): string | undefined {
    if (this.#lastInfo !== undefined) return this.#lastInfo.streamUrl
    const status = this.host.status()
    if (status.running && status.port !== undefined) {
      // serve-sim helpers bind 127.0.0.1; derive the MJPEG route from the port.
      return `http://127.0.0.1:${status.port}/stream.mjpeg`
    }
    return undefined
  }

  async ensureRunning(udid: string): Promise<StreamSourceInfo> {
    const info = await this.host.ensureRunning({ udid })
    this.#lastInfo = info
    return { udid: info.device, mjpegUrl: info.streamUrl, controlUrl: info.url }
  }

  status(): StreamSourceStatus {
    const status = this.host.status()
    return {
      kind: this.kind,
      available: status.available,
      running: status.running,
      ...(status.device === undefined ? {} : { device: status.device }),
      consumers: status.consumers,
      ...(status.lastError === undefined ? {} : { lastError: status.lastError }),
      ...(this.mjpegUrl === undefined ? {} : { mjpegUrl: this.mjpegUrl }),
      ...(this.#lastInfo === undefined ? {} : { controlUrl: this.#lastInfo.url }),
    }
  }

  stop(): Promise<void> {
    return this.host.stop()
  }

  acquire(): () => void {
    const release = this.host.acquire()
    this.#releases.push(release)
    let released = false
    return () => {
      if (released) return
      released = true
      const index = this.#releases.indexOf(release)
      if (index >= 0) this.#releases.splice(index, 1)
      release()
    }
  }

  release(): void {
    this.#releases.pop()?.()
  }

  readonly control: StreamControl = {
    tap: async (x, y) => {
      requireNormalized(x, y)
      await this.#run(['tap', String(x), String(y)])
    },
    drag: async drag => {
      requireNormalized(drag.fromX, drag.fromY)
      requireNormalized(drag.toX, drag.toY)
      const holdMs = Math.min(2_000, Math.max(20, Math.round((drag.duration ?? 0.3) * 500)))
      // serve-sim's `gesture` CLI sends one WS gesture frame per call; a drag
      // is begin → move → end with the requested press duration in between.
      await this.#run(['gesture', JSON.stringify({ type: 'begin', x: drag.fromX, y: drag.fromY })])
      await sleep(holdMs)
      await this.#run(['gesture', JSON.stringify({ type: 'move', x: drag.toX, y: drag.toY })])
      await sleep(holdMs)
      await this.#run(['gesture', JSON.stringify({ type: 'end', x: drag.toX, y: drag.toY })])
    },
    button: async (name = 'home') => {
      await this.#run(['button', name])
    },
    type: async text => {
      if (typeof text !== 'string' || text === '') throw new TypeError('ios-simulator: type requires a non-empty text')
      await this.#run(['type', text])
    },
    rotate: async orientation => {
      await this.#run(['rotate', orientation])
    },
    deviceAction: action => runSimulatorDeviceAction(
      action,
      async name => { await this.#run(['button', name]) },
    ),
    screenshot: async () => {
      const udid = this.#requireDevice()
      const path = join(tmpdir(), `ios-simulator-stream-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.png`)
      try {
        await takeScreenshot(udid, path)
        const pngBase64 = readFileSync(path).toString('base64')
        const size = pngDimensionsFromBase64(pngBase64)
        return { pngBase64, ...(size === undefined ? {} : size) }
      } catch (error) {
        throw new Error(`ios-simulator: the simulator screenshot failed: ${errorMessage(error)}`)
      } finally {
        try {
          unlinkSync(path)
        } catch {
          // Temp file cleanup is best effort.
        }
      }
    },
  }

  async #run(args: readonly string[]): Promise<void> {
    const udid = this.#requireDevice()
    await this.host.control([...args, '-d', udid])
  }

  #requireDevice(): string {
    const udid = this.host.status().device ?? this.#lastInfo?.device
    if (udid === undefined) {
      throw new Error('ios-simulator: no simulator is streaming; call ensureRunning first')
    }
    return udid
  }
}
