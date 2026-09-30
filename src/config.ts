/**
 * Plugin-wide constants and environment-driven settings.
 * @module ios-simulator/config
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

export const PLUGIN_NAME = 'ios-simulator'
/** Error prefix on hosts that cannot run the simulator (non-macOS, or no usable Xcode). */
export const SIMULATOR_UNAVAILABLE = 'iOS Simulator requires macOS with Xcode'
export const SERVER_VERSION = '0.1.0'
/** serve-sim version pinned for the npx fallback (package.json pins the same). */
export const SERVE_SIM_VERSION = '0.1.47'
export const DEFAULT_PANEL_PORT = 3456
/** Ports tried for the panel: preferred .. preferred + 20. */
export const PANEL_PORT_ATTEMPTS = 21
/** Settle delay after an interaction, before the effect screenshot. */
export const INTERACT_SETTLE_MS = 300
/** How long `ios_sim_record stop` waits for simctl to finish the movie. */
export const RECORD_STOP_TIMEOUT_MS = 10_000
/** How long `ios_sim_record start` waits for simctl's "Recording started". */
export const RECORD_START_TIMEOUT_MS = 15_000
/** Poll interval of ios_sim_wait_for and the tap tools' expect_text / expect_gone. */
export const OCR_POLL_INTERVAL_MS = 600
/** Poll budget of a tap tool's expect_text / expect_gone assertion. */
export const TAP_EXPECTATION_BUDGET_MS = 4000
/** Settle delay before ios_sim_tap_row re-reads the row to verify expect_count. */
export const ROW_VERIFY_SETTLE_MS = 800
/** Full-resolution screenshots kept in the cache (oldest pruned first). */
export const SCREENSHOT_KEEP = 100
/** Long edge of the JPEG handed to the model. */
export const MODEL_IMAGE_MAX_EDGE = 1024
export const MODEL_IMAGE_JPEG_QUALITY = 80

export type Env = Readonly<Record<string, string | undefined>>

/** Cache root: `IOS_SIM_CACHE_DIR`, else `~/Library/Caches/ios-simulator`. */
export function cacheRoot(env: Env = process.env): string {
  const override = env.IOS_SIM_CACHE_DIR?.trim()
  return override !== undefined && override !== ''
    ? override
    : join(homedir(), 'Library', 'Caches', 'ios-simulator')
}

/** Preferred panel port: `IOS_SIM_PANEL_PORT` when it is a valid port, else 3456. */
export function preferredPanelPort(env: Env = process.env): number {
  const raw = env.IOS_SIM_PANEL_PORT?.trim()
  if (raw === undefined || raw === '') return DEFAULT_PANEL_PORT
  const port = Number(raw)
  return Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : DEFAULT_PANEL_PORT
}

/** Explicit serve-sim binary (`IOS_SIM_SERVE_SIM_BIN`), when set. */
export function serveSimBinOverride(env: Env = process.env): string | undefined {
  const raw = env.IOS_SIM_SERVE_SIM_BIN?.trim()
  return raw === undefined || raw === '' ? undefined : raw
}
