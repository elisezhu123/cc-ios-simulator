/**
 * The dependency seams the MCP tools and the panel are written against, so
 * tests drive them with fakes and src/server.ts wires the real modules.
 * @module ios-simulator/deps
 */

import type { InstalledApp } from './app-list.js'
import type { BuildRunOptions, BuildRunResult, ProjectTarget } from './build-run.js'
import type { OcrItem } from './ocr-backend.js'
import type { RecordingInfo, RecordingResult } from './recorder.js'
import type { ModelImage, ScreenshotCapture } from './screenshot.js'
import type { SimHostController } from './sim-host.js'
import type { SimulatorDevice } from './simctl.js'
import type { StreamSource } from './stream-source.js'
import type { AxeBinary, AxeElement } from './uitree-backend.js'

/** The public slice of SimHostController that the tools and the panel use. */
export type StreamHost = Pick<SimHostController, 'binary' | 'streamInfo' | 'status' | 'ensureRunning' | 'stop' | 'acquire' | 'control'>

/** The simctl operations the tools use (the src/simctl.ts module satisfies it). */
export interface SimctlApi {
  listDevices(): Promise<SimulatorDevice[]>
  getDevice(reference: string): Promise<SimulatorDevice>
  bootDevice(udid: string): Promise<void>
  shutdownDevice(udid: string): Promise<void>
  takeScreenshot(udid: string, filePath: string, signal?: AbortSignal): Promise<void>
  installApp(udid: string, appPath: string, signal?: AbortSignal): Promise<void>
  uninstallApp(udid: string, bundleId: string, signal?: AbortSignal): Promise<void>
  launchApp(udid: string, bundleId: string, signal?: AbortSignal): Promise<string>
  terminateApp(udid: string, bundleId: string, signal?: AbortSignal): Promise<string>
  openUrl(udid: string, url: string, signal?: AbortSignal): Promise<void>
  sendPush(udid: string, bundleId: string, payloadPath: string, signal?: AbortSignal): Promise<void>
  setLocation(udid: string, latitude: number, longitude: number, signal?: AbortSignal): Promise<void>
  clearLocation(udid: string, signal?: AbortSignal): Promise<void>
  setAppearance(udid: string, appearance: 'light' | 'dark', signal?: AbortSignal): Promise<void>
}

export interface ScreenshotService {
  readonly dir: string
  capture(udid: string, signal?: AbortSignal): Promise<ScreenshotCapture>
  toModelImage(capture: ScreenshotCapture): Promise<ModelImage>
}

/** Starts the live panel once and reports its URL. */
export interface PanelHandle {
  ensureStarted(): Promise<string>
}

export interface RecorderApi {
  active(udid: string): RecordingInfo | undefined
  start(udid: string, outputPath?: string): Promise<RecordingInfo>
  stop(udid: string): Promise<RecordingResult>
}

export interface BuilderApi {
  detectProject(projectPath: string): ProjectTarget
  buildRun(options: BuildRunOptions): Promise<BuildRunResult>
  readBundleIdentifier(appPath: string, signal?: AbortSignal): Promise<string>
}

/** The AXe accessibility helper (src/uitree-backend.ts AxeHelper satisfies it). */
export interface AxeApi {
  /** Resolve without downloading (cheap; used for best-effort probes). */
  resolve(): AxeBinary
  describeUi(udid: string, signal?: AbortSignal): Promise<AxeElement[]>
  /** HID tap at device-point coordinates. */
  tap(udid: string, x: number, y: number, signal?: AbortSignal): Promise<void>
}

/** The Vision OCR helper (src/ocr-backend.ts OcrHelper satisfies it). */
export interface OcrApi {
  /** Recognized text of one PNG, boxes in image pixels, confidence-sorted. */
  recognize(imagePath: string, signal?: AbortSignal): Promise<OcrItem[]>
}

export interface ToolDeps {
  host: StreamHost
  stream: StreamSource
  simctl: SimctlApi
  screenshots: ScreenshotService
  panel: PanelHandle
  recorder: RecorderApi
  builder: BuilderApi
  listApps(udid: string, signal?: AbortSignal): Promise<InstalledApp[]>
  axe: AxeApi
  ocr: OcrApi
  cacheRoot: string
  platform: NodeJS.Platform
  /** Delay before the effect screenshot of ios_sim_interact and the tap tools, ms. */
  settleMs: number
  /** Poll interval of ios_sim_wait_for and the tap tools' expect_text / expect_gone, ms. */
  pollIntervalMs: number
  /** Delay before ios_sim_tap_row re-reads the row to verify expect_count, ms. */
  rowSettleMs: number
}
