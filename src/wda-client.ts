// Ported from dsh-ios (MIT, © 2026 ZSeven—W) @ d9a9731 — src/wda-host.ts (WdaClient and failure classification)
/**
 * HTTP client for a WebDriverAgent (WDA) server reached through a USB
 * tunnel, plus the classification of WDA launch failures.
 *
 * The client owns one WDA session (created lazily, reused, recreated once
 * on an invalid-session error) and a busy gate: WDA serves requests
 * serially and a client-side timeout does not cancel the command on the
 * device, so after one request times out new requests fail fast for a
 * cooldown instead of queueing behind it. Idempotent GETs are retried once
 * on a transport reset; POSTs never are (a retried tap taps twice).
 * Coordinates are absolute device POINTS.
 * @module ios-simulator/wda-client
 */

import { request as httpRequest } from 'node:http'
import { usbmuxTunnelFailureDetail } from './usbmux.js'
import { pngDimensionsFromBase64, type StreamScreenshot } from './stream-source.js'

/** Discriminated failure classification surfaced through `status()`. */
export type WdaFailureReason =
  /** Device is locked: `deviceprep Code=-3 "Unlock … to Continue"` — WDA recovers by itself. */
  | 'device-locked'
  /** `Developer App Certificate is not trusted` — trust it once in Settings. */
  | 'cert-untrusted'
  /** Free-team provisioning profile expired (7-day lifetime) — re-run the build. */
  | 'profile-expired'
  /** No matching/available device over USB. */
  | 'device-unplugged'
  /** xcodebuild failed (`** TEST BUILD FAILED **` / testing failed / …). */
  | 'build-failed'
  /** No `ServerURLHere` within the startup window. */
  | 'launch-timeout'
  /** iproxy could not forward the WDA ports. */
  | 'tunnel-failed'
  /** WDA answered but `GET /status` never became ready. */
  | 'wda-not-ready'
  /** Host tooling (xcodebuild / iproxy / WDA checkout) missing. */
  | 'unavailable'
  /** A foreign WDA answered on the control port and adoption was disabled. */
  | 'wda-already-running'

/** Error carrying a classified failure reason (plus the original cause). */
export class WdaError extends Error {
  constructor(
    readonly reason: WdaFailureReason,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message)
    this.name = 'WdaError'
  }
}

/** HTTP error from a WDA request; body/value preserved for classification. */
export class WdaHttpError extends Error {
  constructor(
    message: string,
    readonly status: number | undefined,
    readonly body: string | undefined,
    readonly value: unknown,
  ) {
    super(message)
    this.name = 'WdaHttpError'
  }
}

/** Parsed `GET /status` health view. */
export interface WdaHealth {
  ready: boolean
  state?: string
  device?: string
  ip?: string
  message?: string
}

export interface WdaDrag {
  fromX: number
  fromY: number
  toX: number
  toY: number
  /** Gesture duration in seconds. */
  duration: number
}

/** Parsed `GET /wda/activeAppInfo` payload. */
export interface WdaActiveAppInfo {
  pid?: number
  bundleId?: string
  name?: string
  [key: string]: unknown
}

/**
 * Default `snapshotMaxDepth` pushed into WDA before every real-device tree
 * walk. Measured on an iPhone 17 Pro with a busy list app frontmost, on the SAME
 * screen: WDA's default 50 → 32.6 s / 751 KB, 15 → 1.9 s / 12 KB, 8 → 0.15 s
 * / 3 KB. 15 (not 8) because 8 is faster still but starts dropping real
 * controls in deep hierarchies, while 15 keeps the walk under ~2 s without
 * losing the controls the agent taps. WDA serves requests SERIALLY, so the
 * old uncapped snapshot blocked every tap/find_text/ui_tree queued behind it.
 */
export const WDA_DEFAULT_SNAPSHOT_DEPTH = 15

/** Absolute-POINT WDA control surface exposed by `WdaController.control`. */
export interface WdaControl {
  pressButton(name: string): Promise<void>
  /** Tap at absolute POINT coordinates (WDA `/wda/tap` `{x, y}`). */
  tap(x: number, y: number): Promise<void>
  /** Drag between absolute POINT coordinates over `duration` seconds. */
  dragFromToForDuration(drag: WdaDrag): Promise<void>
  typeText(text: string): Promise<void>
  /** Lock the device screen (`POST /wda/lock`). */
  lock(): Promise<void>
  /** Dismiss the lock screen (`POST /wda/unlock`; no passcode entry). */
  unlock(): Promise<void>
  /** Bring up Siri (`POST /wda/siri/activate`, optional utterance). */
  activateSiri(text?: string): Promise<void>
  /** Active/frontmost app as reported by WDA (`GET /wda/activeAppInfo`). */
  activeAppInfo(): Promise<WdaActiveAppInfo>
  screenshot(): Promise<StreamScreenshot>
  /** Accessibility tree (XML). */
  source(): Promise<string>
  /** Push `snapshotMaxDepth` into WDA so `/source` stops early instead of
   * walking the whole hierarchy (see WDA_DEFAULT_SNAPSHOT_DEPTH). */
  setSnapshotDepth(depth: number): Promise<void>
  getOrientation(): Promise<string>
  setOrientation(orientation: string): Promise<void>
  /** Active application size in POINTS (the WDA gesture coordinate space). */
  windowSize(): Promise<{ width: number; height: number }>
}

export interface WdaClientOptions {
  requestTimeoutMs?: number
  /**
   * Timeout for the cheap session-scoped GETs (window/size, orientation).
   * These answer in ~250 ms on a healthy device, so a 30 s budget would only
   * ever be spent waiting on a WDA whose dispatcher is stuck behind a slow
   * command (exactly what happens while the device plays video) — and while
   * we wait, the gesture the value was meant for queues ANOTHER command
   * behind the same stuck one. Failing fast here keeps a busy device from
   * being flooded by requests that can only time out.
   * Default WDA_FAST_TIMEOUT_MS.
   */
  shortTimeoutMs?: number
  /**
   * After any request TIMES OUT, reject new requests for this long with a
   * busy error instead of sending them into the same stuck dispatcher.
   * WDA serves requests serially and a client-side timeout does NOT cancel
   * the command on the device, so every request issued during a stall only
   * queues for its own full timeout behind the stuck one — the reported
   * "window/size 持续超时" is exactly that queue burning down. The cooldown
   * turns it into "fail this one fast, retry shortly", and bounds the
   * in-flight pile-up at the ONE request that already timed out.
   * Default WDA_BUSY_COOLDOWN_MS.
   */
  busyCooldownMs?: number
  /** @internal Test seam: monotonic clock (defaults to Date.now). */
  now?: () => number
  maxBodyBytes?: number
  /** Invoked once for every successful WDA HTTP response (2xx, parsed). */
  onSuccess?: () => void
}

const REQUEST_TIMEOUT_MS = 30_000
/** Budget of the cheap GETs (window size, orientation): ~300 ms when healthy, so a stall fails fast. */
export const WDA_FAST_TIMEOUT_MS = 5_000
/** After a timeout, new requests fail fast for this long while the stuck command drains on the device. */
export const WDA_BUSY_COOLDOWN_MS = 10_000
/** How long a read window size is reused (it changes only on rotation or an app switch). */
export const WDA_WINDOW_SIZE_CACHE_TTL_MS = 3_000
/** Delay before the single retry of a transport-reset GET (~250 ms). */
const TRANSIENT_RETRY_DELAY_MS = 250
const MAX_BODY_BYTES = 64 * 1024 * 1024

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

/**
 * Lock signatures — the "device is locked" family. A locked device makes
 * xcodebuild print `** TEST BUILD FAILED **` around a deviceprep "Unlock …
 * to Continue" / "waiting for the destination to become ready" error, so this
 * family MUST be tested before the build family below: device-locked is
 * SELF-HEALING (the launch recovers once the user unlocks), while build-failed
 * is terminal and makes the agent either give up or retry a build that was
 * never broken. Measured on the attached iPhone 17 Pro: locked →
 * `reason: build-failed`, then the same command succeeded unchanged the
 * moment the device was unlocked.
 */
const WDA_LOCKED_PATTERN = /deviceprep\s+code\s*=\s*-3|unlock[^\n]*to continue|waiting for the destination to become ready/i

/**
 * Classify xcodebuild/devicectl/iproxy output into one actionable failure
 * reason. The signatures quoted here were observed upstream on a real device:
 * - locked: `Error Domain=com.apple.dt.deviceprep Code=-3 "Unlock … to
 *   Continue"` followed by `Waiting for the destination to become ready`
 *   (recovers by itself once unlocked);
 * - cert: `The application could not be launched because the Developer App
 *   Certificate is not trusted`;
 * - profile: free-team profiles expire after 7 days.
 */
export function classifyWdaFailure(text: string): WdaFailureReason | undefined {
  // Locked WINS over every later family: one capture can carry BOTH a lock
  // signature and `** TEST BUILD FAILED **` (the locked device is what made
  // the build fail), and the self-healing reading must never lose to the
  // terminal one.
  if (WDA_LOCKED_PATTERN.test(text)) return 'device-locked'
  if (/developer app certificate is not trusted/i.test(text)) return 'cert-untrusted'
  if (/provisioning profile[^\n]{0,120}expired|profile[^\n]{0,80}has expired|has expired[^\n]{0,80}provisioning profile/i.test(text)) {
    return 'profile-expired'
  }
  if (/unable to find a destination matching|no connected physical device matches|is not available \(state|could not find the requested device|requested device could not be found|device [^\n]{0,60}was disconnected|unplug/i.test(text)) {
    return 'device-unplugged'
  }
  if (/\*\* test build failed \*\*|\*\* build failed \*\*|testing failed|test execute failed|xcodebuild: error|command phasescriptexecution failed/i.test(text)) {
    return 'build-failed'
  }
  return undefined
}

/** Actionable UI text for a classified failure. */
export function wdaFailureDetail(reason: WdaFailureReason, deviceName: string, startTimeoutMs: number): string {
  switch (reason) {
    case 'device-locked':
      return `unlock "${deviceName}" — WDA keeps waiting and recovers by itself once the device is unlocked`
    case 'cert-untrusted':
      return `trust the Developer App certificate once in Settings → General → VPN & Device Management on "${deviceName}", then re-run`
    case 'profile-expired':
      return 'the free-team provisioning profile expired (7-day lifetime) — re-run so xcodebuild re-issues it'
    case 'device-unplugged':
      return `connect "${deviceName}" over USB, then re-run`
    case 'build-failed':
      return 'the WebDriverAgentRunner build failed — fix the error and re-run'
    case 'launch-timeout':
      return `no ServerURLHere within ${Math.round(startTimeoutMs / 1000)} s — re-run (a cold build can take minutes)`
    case 'tunnel-failed':
      // The specific sub-case (USB up / Wi-Fi only / absent) is set at the
      // failure site; this fallback covers the generic "we tried to forward".
      return usbmuxTunnelFailureDetail('usb-link-up')
    case 'wda-not-ready':
      return 'WDA answered but did not become ready — re-run'
    case 'unavailable':
      return 'WDA tooling is unavailable on this host'
    case 'wda-already-running':
      return 'a foreign WDA is already running on the control port — stop it or explicitly allow adoption'
  }
}

/**
 * Extract the readiness URL from xcodebuild output:
 * `ServerURLHere->http://<device-ip>:8100<-ServerURLHere`.
 */
export function parseServerUrlHere(text: string): string | undefined {
  const match = /ServerURLHere->(https?:\/\/[^\s<]+)<-ServerURLHere/.exec(text)
  return match?.[1]
}

/** True when an error is a stale WDA session (404 / `invalid session id`). */
export function isInvalidSessionError(error: unknown): boolean {
  if (!(error instanceof WdaHttpError)) return false
  const text = String(error.body ?? '')
  if (/invalid session|session does not exist|no such driver/i.test(text)) return true
  if (error.status === 404 && /session/i.test(text)) return true
  if (typeof error.value === 'object' && error.value !== null) {
    const value = error.value as Record<string, unknown>
    if (typeof value.error === 'string' && /invalid session/i.test(value.error)) return true
  }
  return false
}

/**
 * True when an error is a transport reset WDA drops under load — a dropped
 * READ, not a real failure, so an idempotent GET is safe to retry once.
 * Matches `ECONNRESET`, `socket hang up`, and `EPIPE`; `ECONNREFUSED` is
 * deliberately NOT transient (the tunnel/port is gone, not overloaded) and
 * neither is an HTTP 4xx/5xx `WdaHttpError` (the server answered).
 */
export function isTransientWdaTransportError(error: unknown): boolean {
  const text = errorMessage(error)
  if (/\bECONNREFUSED\b/i.test(text)) return false
  return /\bECONNRESET\b/i.test(text)
    || /\bsocket hang up\b/i.test(text)
    || /\bEPIPE\b/i.test(text)
}

/**
 * True when an error is the busy fast-fail the client answers during its
 * post-timeout cooldown: the device is answering too slowly, so new requests
 * are refused at once instead of queueing behind the stuck command. Callers
 * surface it as "the device is busy — retry shortly" rather than a hang.
 */
export function isWdaBusyError(error: unknown): boolean {
  return /\[wda-busy\]/i.test(errorMessage(error))
}

/** Idempotent GETs — retried once on a transport reset. POSTs are excluded
 * because a retried tap/drag/type would double-fire. `getOrientation` is a
 * GET too but deliberately left out: it is cheap and never blocks the queue
 * the way a snapshot/screenshot does. */
function isIdempotentWdaGet(method: string, path: string): boolean {
  return method === 'GET'
    && (path === '/status'
      || path.endsWith('/source')
      || path.endsWith('/screenshot')
      || path.endsWith('/window/size'))
}

/**
 * The cheap session-scoped GETs whose answer never needs the full 30 s
 * budget: they cost 210–370 ms on a healthy device, so the only way they
 * come close to the general timeout is a dispatcher stuck behind a slow
 * command (video playback is the observed case). They get
 * {@link WdaClientOptions.shortTimeoutMs} so a busy device fails them fast
 * instead of parking their callers for half a minute each.
 */
function isFastWdaPath(method: string, path: string): boolean {
  return method === 'GET' && (path.endsWith('/window/size') || path.endsWith('/orientation'))
}

/**
 * HTTP client for one running WDA instance (through the USB tunnel).
 * Owns the session: created lazily on first use, reused across calls, and
 * recreated exactly once when a call hits a 404 / `invalid session` error.
 */
export class WdaClient {
  readonly controlUrl: string
  #options: Required<WdaClientOptions>
  #sessionId: string | undefined
  #sessionPromise: Promise<string> | undefined
  /** Clock time until which new requests fail fast with a busy error. */
  #busyUntil = 0
  /** Cached active-app point size (windowSize); dropped on rotation/session. */
  #sizeCache: { size: { width: number; height: number }; at: number } | undefined

  constructor(controlUrl: string, options: WdaClientOptions = {}) {
    this.controlUrl = controlUrl.replace(/\/+$/, '')
    this.#options = {
      requestTimeoutMs: options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS,
      shortTimeoutMs: options.shortTimeoutMs ?? WDA_FAST_TIMEOUT_MS,
      busyCooldownMs: options.busyCooldownMs ?? WDA_BUSY_COOLDOWN_MS,
      now: options.now ?? Date.now,
      maxBodyBytes: options.maxBodyBytes ?? MAX_BODY_BYTES,
      onSuccess: options.onSuccess ?? (() => {}),
    }
  }

  get sessionId(): string | undefined {
    return this.#sessionId
  }

  /** Drop the cached session so the next call recreates it. */
  invalidateSession(): void {
    this.#sessionId = undefined
    this.#sizeCache = undefined
  }

  /** `GET /status` health view. */
  async health(): Promise<WdaHealth> {
    const doc = await this.#raw('GET', '/status')
    const value = typeof doc === 'object' && doc !== null ? (doc as Record<string, unknown>).value : undefined
    const record = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
    const ios = typeof record.ios === 'object' && record.ios !== null ? record.ios as Record<string, unknown> : {}
    return {
      ready: record.ready === true,
      ...(typeof record.state === 'string' ? { state: record.state } : {}),
      ...(typeof record.device === 'string' ? { device: record.device } : {}),
      ...(typeof ios.ip === 'string' ? { ip: ios.ip } : {}),
      ...(typeof record.message === 'string' ? { message: record.message } : {}),
    }
  }

  /** Create the session lazily and reuse it; concurrent callers share one POST. */
  async ensureSession(): Promise<string> {
    if (this.#sessionId !== undefined) return this.#sessionId
    if (this.#sessionPromise !== undefined) return this.#sessionPromise
    this.#sessionPromise = this.#createSession()
    try {
      return await this.#sessionPromise
    } finally {
      this.#sessionPromise = undefined
    }
  }

  /** Raw request returning the parsed `value` of the WDA response envelope. */
  async request(method: string, path: string, body?: unknown): Promise<unknown> {
    return this.#requestValue(method, path, body)
  }

  /**
   * `POST /wda/pressButton` `{name}` — verified: really moves the phone.
   *
   * `home` takes WDA's SESSIONLESS `/wda/homescreen` instead, measured on an
   * iPhone 17 Pro at ~30 ms against ~470 ms for the session-scoped press —
   * same effect (the springboard), a fifteenth of the wait, and Home is the
   * button pressed most. Any failure falls back to the
   * session route, so an older WDA without that endpoint still works.
   */
  async pressButton(name: string): Promise<void> {
    if (typeof name !== 'string' || name === '') throw new TypeError('ios-simulator: pressButton requires a button name')
    if (name === 'home') {
      try {
        await this.#requestValue('POST', '/wda/homescreen', {})
        return
      } catch {
        // Fall through to the session-scoped press below.
      }
    }
    await this.#withSession('POST', '/wda/pressButton', { name })
  }

  /** `POST /wda/tap` `{x, y}` — absolute POINT coordinates of the active app. */
  async tap(x: number, y: number): Promise<void> {
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0) {
      throw new RangeError('ios-simulator: tap requires non-negative point coordinates')
    }
    await this.#withSession('POST', '/wda/tap', { x, y })
  }

  /** `POST /wda/dragfromtoforduration` `{fromX, fromY, toX, toY, duration}`. */
  async dragFromToForDuration(drag: WdaDrag): Promise<void> {
    const { fromX, fromY, toX, toY, duration } = drag
    if (![fromX, fromY, toX, toY, duration].every(value => Number.isFinite(value)) || duration < 0) {
      throw new RangeError('ios-simulator: dragFromToForDuration requires finite coordinates and a non-negative duration')
    }
    await this.#withSession('POST', '/wda/dragfromtoforduration', { fromX, fromY, toX, toY, duration })
  }

  /** `POST /wda/keys` `{value: [text]}` (the handler joins the value array). */
  async typeText(text: string): Promise<void> {
    if (typeof text !== 'string' || text === '') throw new TypeError('ios-simulator: typeText requires a non-empty text')
    await this.#withSession('POST', '/wda/keys', { value: [text] })
  }

  /** `POST /wda/lock` — lock the device screen. */
  async lock(): Promise<void> {
    await this.#withSession('POST', '/wda/lock', {})
  }

  /** `POST /wda/unlock` — dismiss the lock screen (no passcode entry). */
  async unlock(): Promise<void> {
    await this.#withSession('POST', '/wda/unlock', {})
  }

  /** `POST /wda/siri/activate` `{text}` — bring up Siri (optionally with an
   * utterance). */
  async activateSiri(text = ''): Promise<void> {
    await this.#withSession('POST', '/wda/siri/activate', { text })
  }

  /** `GET /wda/activeAppInfo` → frontmost app identity as WDA reports it. */
  async activeAppInfo(): Promise<WdaActiveAppInfo> {
    const value = await this.#withSession<unknown>('GET', '/wda/activeAppInfo')
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? value as WdaActiveAppInfo
      : {}
  }

  /** `GET /screenshot` → base64 PNG (1206×2622 pixels on this device). */
  async screenshot(): Promise<StreamScreenshot> {
    const value = await this.#withSession<unknown>('GET', '/screenshot')
    if (typeof value !== 'string' || value === '') {
      throw new WdaHttpError('WDA /screenshot returned no image data', undefined, undefined, value)
    }
    const size = pngDimensionsFromBase64(value)
    return { pngBase64: value, ...(size === undefined ? {} : size) }
  }

  /** `GET /source` → accessibility tree (XML by default). */
  async source(): Promise<string> {
    const value = await this.#withSession<unknown>('GET', '/source')
    return typeof value === 'string' ? value : JSON.stringify(value)
  }

  /** `POST /session/<sid>/appium/settings` `{settings: {snapshotMaxDepth}}` —
   * caps the accessibility-tree walk WDA performs for `/source` so a busy
   * app is snapshotted in ~2 s instead of ~33 s. */
  async setSnapshotDepth(depth: number): Promise<void> {
    if (!Number.isSafeInteger(depth) || depth < 0) {
      throw new RangeError('ios-simulator: setSnapshotDepth requires a non-negative integer')
    }
    await this.#withSession('POST', '/appium/settings', { settings: { snapshotMaxDepth: depth } })
  }

  /** `GET /orientation` → e.g. `PORTRAIT`. */
  async getOrientation(): Promise<string> {
    const value = await this.#withSession<unknown>('GET', '/orientation')
    if (typeof value !== 'string' || value === '') {
      throw new WdaHttpError('WDA /orientation returned no value', undefined, undefined, value)
    }
    return value
  }

  /** `POST /orientation` `{orientation}` (PORTRAIT, LANDSCAPELEFT, …). */
  async setOrientation(orientation: string): Promise<void> {
    if (typeof orientation !== 'string' || orientation === '') throw new TypeError('ios-simulator: setOrientation requires an orientation name')
    await this.#withSession('POST', '/orientation', { orientation })
    // Width and height just swapped: never hand a pre-rotation size out.
    this.#sizeCache = undefined
  }

  /**
   * `GET /window/size` → active app size in POINTS (the gesture space).
   * Reused across callers for {@link WDA_WINDOW_SIZE_CACHE_TTL_MS}: the value
   * only changes on rotation (invalidated here and by setOrientation) or a
   * foreground-app switch (bounded by the TTL), and each skipped round trip
   * is one less request queued behind a stuck command while the device is
   * busy (video playback is the observed worst case).
   */
  async windowSize(): Promise<{ width: number; height: number }> {
    const cached = this.#sizeCache
    if (cached !== undefined && this.#options.now() - cached.at < WDA_WINDOW_SIZE_CACHE_TTL_MS) {
      return cached.size
    }
    const value = await this.#withSession<unknown>('GET', '/window/size')
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new WdaHttpError('WDA /window/size returned an invalid value', undefined, undefined, value)
    }
    const record = value as Record<string, unknown>
    const width = record.width
    const height = record.height
    if (typeof width !== 'number' || typeof height !== 'number' || width <= 0 || height <= 0) {
      throw new WdaHttpError('WDA /window/size returned an invalid size', undefined, undefined, value)
    }
    const size = { width, height }
    this.#sizeCache = { size, at: this.#options.now() }
    return size
  }

  async #createSession(): Promise<string> {
    const { doc, value } = await this.#request('POST', '/session', {
      capabilities: { alwaysMatch: { platformName: 'iOS' } },
    })
    const valueRecord = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
    const sid = typeof doc.sessionId === 'string' && doc.sessionId !== ''
      ? doc.sessionId
      : typeof valueRecord.sessionId === 'string' && valueRecord.sessionId !== ''
        ? valueRecord.sessionId
        : undefined
    if (sid === undefined) {
      throw new WdaHttpError('WDA created a session without a sessionId', undefined, JSON.stringify(doc), value)
    }
    this.#sessionId = sid
    // A fresh session may serve a different device state: re-read the size.
    this.#sizeCache = undefined
    return sid
  }

  async #withSession<T>(method: string, path: string, body?: unknown): Promise<T> {
    let sid = await this.ensureSession()
    try {
      return await this.#requestValue<T>(method, `/session/${sid}${path}`, body)
    } catch (error) {
      if (!isInvalidSessionError(error)) throw error
      // Stale session (WDA was restarted, runner rebuilt, …): recreate once.
      this.#sessionId = undefined
      sid = await this.ensureSession()
      return this.#requestValue<T>(method, `/session/${sid}${path}`, body)
    }
  }

  async #requestValue<T>(method: string, path: string, body?: unknown): Promise<T> {
    const { value } = await this.#request(method, path, body)
    return value as T
  }

  async #request(method: string, path: string, body?: unknown): Promise<{ doc: Record<string, unknown>; value: unknown }> {
    const raw = await this.#raw(method, path, body)
    const doc = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw as Record<string, unknown> : {}
    const value = doc.value
    if (typeof value === 'object' && value !== null) {
      const error = (value as Record<string, unknown>).error
      if (typeof error === 'string' && error !== '') {
        const message = (value as Record<string, unknown>).message
        throw new WdaHttpError(
          `WDA ${method} ${path} failed: ${error}${typeof message === 'string' && message !== '' ? ` — ${message}` : ''}`,
          undefined,
          JSON.stringify(doc),
          value,
        )
      }
    }
    return { doc, value }
  }

  /**
   * The busy gate plus the single transport-reset retry. While the cooldown
   * after a timeout lasts, EVERY request fails fast with a busy error: WDA
   * serves requests serially and a client-side timeout does not cancel the
   * command on the device, so anything sent now would only queue behind the
   * stuck command and burn its own timeout (the reported timeout cascade).
   * The gate bounds that pile-up at the one request that already timed out.
   *
   * A transport reset (ECONNRESET / socket hang up / EPIPE) is then retried
   * exactly once, and only for idempotent GETs: WDA drops connections under
   * load, so a dropped snapshot/screenshot read is not a real failure. POSTs
   * are never retried (a retried tap taps twice).
   */
  async #raw(method: string, path: string, body?: unknown): Promise<unknown> {
    if (this.#options.now() < this.#busyUntil) {
      throw new WdaHttpError(
        'WDA ' + method + ' ' + path + ' rejected while the device is busy: a recent request timed out and its command is still draining on the device — retry shortly [wda-busy]',
        undefined,
        undefined,
        undefined,
      )
    }
    const timeoutMs = isFastWdaPath(method, path)
      ? this.#options.shortTimeoutMs
      : this.#options.requestTimeoutMs
    try {
      return await this.#rawOnce(method, path, body, timeoutMs)
    } catch (error) {
      if (!isIdempotentWdaGet(method, path) || !isTransientWdaTransportError(error)) throw error
      await sleep(TRANSIENT_RETRY_DELAY_MS)
      return this.#rawOnce(method, path, body, timeoutMs)
    }
  }

  #rawOnce(method: string, path: string, body: unknown | undefined, timeoutMs: number): Promise<unknown> {
    const url = `${this.controlUrl}${path}`
    return new Promise((resolve, reject) => {
      let settled = false
      const failWith = (error: unknown): void => {
        // A timeout means the device is busy: arm the cooldown so the next
        // callers fail fast instead of queueing behind the stuck command.
        // Other failures (reset, refused, HTTP errors) are not a busy signal.
        if (error instanceof WdaHttpError && /timed out after/i.test(error.message)) {
          this.#busyUntil = this.#options.now() + this.#options.busyCooldownMs
        }
        reject(error)
      }
      const finish = (done: () => void): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        done()
      }
      const payload = body === undefined ? undefined : JSON.stringify(body)
      const req = httpRequest(url, {
        method,
        timeout: timeoutMs,
        ...(payload === undefined
          ? {}
          : { headers: { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(payload)) } }),
      }, res => {
        const chunks: Buffer[] = []
        let total = 0
        res.on('data', (chunk: Buffer) => {
          total += chunk.length
          if (total > this.#options.maxBodyBytes) {
            res.destroy()
            finish(() => failWith(new WdaHttpError(
              `WDA ${method} ${path} response exceeded ${this.#options.maxBodyBytes} bytes`,
              res.statusCode,
              undefined,
              undefined,
            )))
            return
          }
          chunks.push(chunk)
        })
        res.on('error', error => {
          finish(() => failWith(new WdaHttpError(
            `WDA ${method} ${path} connection error: ${errorMessage(error)}`,
            res.statusCode,
            undefined,
            undefined,
          )))
        })
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let doc: unknown
          try {
            doc = text === '' ? undefined : JSON.parse(text)
          } catch {
            doc = undefined
          }
          if (res.statusCode === undefined || res.statusCode >= 400) {
            const value = typeof doc === 'object' && doc !== null ? (doc as Record<string, unknown>).value : undefined
            const detail = typeof value === 'object' && value !== null
              ? `${String((value as Record<string, unknown>).error ?? '')}${(value as Record<string, unknown>).message === undefined ? '' : ` — ${(value as Record<string, unknown>).message}`}`.trim()
              : text.slice(0, 400)
            finish(() => failWith(new WdaHttpError(
              `WDA ${method} ${path} returned HTTP ${res.statusCode}${detail === '' ? '' : `: ${detail}`}`,
              res.statusCode,
              text,
              value,
            )))
            return
          }
          // Liveness bookkeeping must never fail a successful call.
          try {
            this.#options.onSuccess()
          } catch {
            // Ignore: the response itself succeeded.
          }
          finish(() => resolve(doc))
        })
      })
      req.on('error', error => {
        finish(() => failWith(new WdaHttpError(`WDA ${method} ${path} request failed: ${errorMessage(error)}`, undefined, undefined, undefined)))
      })
      req.on('timeout', () => {
        req.destroy()
        finish(() => failWith(new WdaHttpError(`WDA ${method} ${path} timed out after ${timeoutMs} ms`, undefined, undefined, undefined)))
      })
      const timer = setTimeout(() => {
        req.destroy()
        finish(() => failWith(new WdaHttpError(`WDA ${method} ${path} timed out after ${timeoutMs} ms`, undefined, undefined, undefined)))
      }, timeoutMs)
      timer.unref?.()
      if (payload !== undefined) req.write(payload)
      req.end()
    })
  }
}
