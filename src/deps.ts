/**
 * The dependency seams the MCP tools and the panel are written against, so
 * tests drive them with fakes and src/server.ts wires the real modules.
 * @module ios-simulator/deps
 */

import type { InstalledApp } from './app-list.js'
import type { BuildRunOptions, BuildRunResult, ProjectTarget } from './build-run.js'
import type { RealDevice, RealDeviceApi } from './devicectl.js'
import type { DevToolsApi } from './devtools.js'
import type { OcrItem } from './ocr-backend.js'
import type { PreviewStatus } from './preview-host.js'
import type { RecordingInfo, RecordingResult } from './recorder.js'
import type { ModelImage, ScreenshotCapture } from './screenshot.js'
import type { SimHostController } from './sim-host.js'
import type { SimulatorDevice } from './simctl.js'
import type { StreamSource } from './stream-source.js'
import type { AxeBinary, AxeElement } from './uitree-backend.js'
import type { WdaSessionClient, WdaStatus } from './wda-host.js'

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
  /** The app's data container (holds Documents/). */
  getAppContainer(udid: string, bundleId: string, signal?: AbortSignal): Promise<string>
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
  /** Store a PNG taken elsewhere (a real device's WebDriverAgent) in the same cache. */
  save(udid: string, png: Buffer): ScreenshotCapture
  toModelImage(capture: ScreenshotCapture): Promise<ModelImage>
}

/** Starts the live panel once and reports its URL. */
export interface PanelHandle {
  ensureStarted(): Promise<string>
  /** Show a connected iPhone/iPad (WebDriverAgent running on it) and resolve the panel URL. */
  showRealDevice(device: RealDevice): Promise<string>
  /** Show simulators again. */
  showSimulator(): void
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

/** The SwiftUI preview session (src/preview-host.ts PreviewHostController satisfies it). */
export interface PreviewApi {
  start(options: { packagePath: string; device: SimulatorDevice; previewFilter?: string; signal?: AbortSignal }): Promise<PreviewStatus>
  status(): PreviewStatus
  stop(signal?: AbortSignal): Promise<{ stopped: boolean; device?: SimulatorDevice; reloads?: number }>
}

/** WebDriverAgent on a connected iPhone or iPad (src/wda-host.ts WdaController satisfies it). */
export interface WdaApi {
  status(): WdaStatus
  /** Adopt or build + launch WDA; minutes on a cold build. */
  start(device: RealDevice, signal?: AbortSignal): Promise<WdaStatus>
  /** The running client, or an adopted one; never builds. */
  control(device: RealDevice): Promise<WdaSessionClient>
  stop(): Promise<{ stopped: boolean; device?: { udid: string; name: string } }>
  /** Local URL of the running device's MJPEG stream (the panel's live view). */
  mjpegUrl(device: RealDevice): Promise<string>
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
  /** simctl / lldb / leaks / sample / log runner for the log and debug tools. */
  devtools: DevToolsApi
  preview: PreviewApi
  /** Connected iPhones and iPads (devicectl). */
  realDevices: RealDeviceApi
  /** WebDriverAgent for the real-device screen, touch and UI tools. */
  wda: WdaApi
  cacheRoot: string
  platform: NodeJS.Platform
  /** Delay before the effect screenshot of ios_sim_interact and the tap tools, ms. */
  settleMs: number
  /** Poll interval of ios_sim_wait_for and the tap tools' expect_text / expect_gone, ms. */
  pollIntervalMs: number
  /** Delay before ios_sim_tap_row re-reads the row to verify expect_count, ms. */
  rowSettleMs: number
}
