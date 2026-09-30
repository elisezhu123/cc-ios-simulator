// Ported from dsh-ios (MIT, © 2026 ZSeven—W) @ d9a9731 — src/wda-host.ts (WdaController), simplified
/**
 * Brings WebDriverAgent (WDA) up on ONE USB-connected iPhone or iPad and
 * hands the tools a WDA client for it.
 *
 * `start` (the ios_real_start_wda tool) opens a USB tunnel to the device's
 * WDA port (usbmuxd first, `iproxy` as the fallback) and adopts a WDA that
 * already answers there. Otherwise it resolves the signing team, stages the
 * loopback-only WDA copy (src/wda-setup.ts), runs `xcodebuild … test` and
 * waits for `ServerURLHere`, then for `GET /status` to report ready.
 * Launch failures are classified (locked, untrusted certificate, expired
 * profile, unplugged, build failed, timeout) and kept in `status()`.
 *
 * `control` (every other real-device tool) never builds: it returns the
 * running client, or adopts a WDA that answers through a fresh tunnel, or
 * fails telling the caller to run ios_real_start_wda first — a cold build
 * takes minutes and must not hide inside a tap.
 *
 * Every OS-facing step goes through `WdaHostSeams`, so the flow is tested
 * without Xcode or a device.
 * @module ios-simulator/wda-host
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { connect, createServer } from 'node:net'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import type { RealDevice } from './devicectl.js'
import {
  classifyUsbmuxTunnelFailure,
  createUsbmuxForward,
  resolveUsbDeviceId,
  usbmuxAvailable,
  usbmuxTunnelFailureDetail,
} from './usbmux.js'
import {
  classifyWdaFailure,
  parseServerUrlHere,
  WDA_DEFAULT_SNAPSHOT_DEPTH,
  WdaClient,
  WdaError,
  wdaFailureDetail,
  type WdaControl,
  type WdaFailureReason,
  type WdaHealth,
} from './wda-client.js'
import { resolveSigningTeam, stageWdaSource, wdaBundleId, type SigningTeamResolution } from './wda-setup.js'

/** The WDA HTTP port on the device. */
export const WDA_DEVICE_PORT = 8100
/** How long `start` waits for `ServerURLHere` (a cold build can take minutes). */
export const WDA_START_TIMEOUT_MS = 300_000
/** How long `start` waits for `GET /status` to report ready after launch. */
export const WDA_READY_TIMEOUT_MS = 30_000
/** Budget of the adoption probe (`GET /status` through a fresh tunnel). */
const ADOPT_PROBE_TIMEOUT_MS = 3_000
const READY_POLL_MS = 1_000
/** Only the tail of xcodebuild's output is kept for the handshake and the diagnosis. */
const MAX_OUTPUT_BYTES = 64 * 1024

/** The WDA client surface the controller and the tools use (WdaClient satisfies it). */
export interface WdaSessionClient extends WdaControl {
  health(): Promise<WdaHealth>
  ensureSession(): Promise<string>
}

/** A long-running child (xcodebuild or iproxy). */
export interface WdaChild {
  onOutput(listener: (text: string) => void): void
  /** Resolves with the exit code (null when killed by a signal). */
  readonly exited: Promise<number | null>
  /** Kill the child's whole process group. */
  kill(): void
}

export interface WdaTunnel {
  readonly localPort: number
  readonly kind: 'usbmux' | 'iproxy'
  close(): Promise<void>
}

export interface WdaHostSeams {
  platform: NodeJS.Platform
  resolveTeam(signal?: AbortSignal): Promise<SigningTeamResolution>
  /** The patched private WDA copy to build in (throws with how to get a checkout). */
  stageSource(): Promise<string>
  /** Runner bundle id for a team (IOS_SIM_WDA_BUNDLE_ID wins). */
  bundleId(teamId: string): string
  spawnRunner(args: readonly string[], cwd: string): WdaChild
  openTunnel(hardwareUdid: string, devicePort: number): Promise<WdaTunnel>
  createClient(controlUrl: string, options?: { requestTimeoutMs?: number }): WdaSessionClient
  sleep(milliseconds: number): Promise<void>
  now(): number
}

export interface WdaStatus {
  /** idle: nothing started; starting: a start is in flight; running; failed: the last start failed. */
  phase: 'idle' | 'starting' | 'running' | 'failed'
  device?: { udid: string; name: string }
  controlPort?: number
  tunnel?: 'usbmux' | 'iproxy'
  /** True when an already-running WDA was adopted instead of launched. */
  adopted?: boolean
  signingTeam?: string
  reason?: WdaFailureReason
  detail?: string
}

interface Running {
  device: RealDevice
  tunnel: WdaTunnel
  client: WdaSessionClient
  runner?: WdaChild
  adopted: boolean
  signingTeam?: string
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The verified runner invocation (`xcodebuild -project WebDriverAgent.xcodeproj
 * -scheme WebDriverAgentRunner -destination id=<hardware udid>
 * -allowProvisioningUpdates DEVELOPMENT_TEAM=… CODE_SIGN_STYLE=Automatic
 * PRODUCT_BUNDLE_IDENTIFIER=… test`).
 */
export function xcodebuildTestArgs(hardwareUdid: string, teamId: string, bundleId: string): string[] {
  return [
    '-project', 'WebDriverAgent.xcodeproj',
    '-scheme', 'WebDriverAgentRunner',
    '-destination', `id=${hardwareUdid}`,
    '-allowProvisioningUpdates',
    `DEVELOPMENT_TEAM=${teamId}`,
    'CODE_SIGN_STYLE=Automatic',
    `PRODUCT_BUNDLE_IDENTIFIER=${bundleId}`,
    'test',
  ]
}

/** iproxy's argument syntax is POSITIONAL: `iproxy <local> <device> <udid>`. */
export function iproxyArgs(localPort: number, devicePort: number, udid: string): string[] {
  return [String(localPort), String(devicePort), udid]
}

export class WdaController {
  readonly #seams: WdaHostSeams
  readonly #startTimeoutMs: number
  readonly #readyTimeoutMs: number
  #running: Running | undefined
  #starting: { device: RealDevice; promise: Promise<WdaStatus> } | undefined
  #failure: { device: RealDevice; reason: WdaFailureReason; detail: string } | undefined

  constructor(seams: WdaHostSeams, options: { startTimeoutMs?: number; readyTimeoutMs?: number } = {}) {
    this.#seams = seams
    this.#startTimeoutMs = options.startTimeoutMs ?? WDA_START_TIMEOUT_MS
    this.#readyTimeoutMs = options.readyTimeoutMs ?? WDA_READY_TIMEOUT_MS
  }

  status(): WdaStatus {
    if (this.#starting !== undefined) {
      const { device } = this.#starting
      return { phase: 'starting', device: { udid: device.udid, name: device.name } }
    }
    const running = this.#running
    if (running !== undefined) {
      return {
        phase: 'running',
        device: { udid: running.device.udid, name: running.device.name },
        controlPort: running.tunnel.localPort,
        tunnel: running.tunnel.kind,
        adopted: running.adopted,
        ...(running.signingTeam === undefined ? {} : { signingTeam: running.signingTeam }),
      }
    }
    const failure = this.#failure
    if (failure !== undefined) {
      return { phase: 'failed', device: { udid: failure.device.udid, name: failure.device.name }, reason: failure.reason, detail: failure.detail }
    }
    return { phase: 'idle' }
  }

  /**
   * Adopt or launch WDA on `device`; resolves once it is ready and has a
   * session. Concurrent calls for one device share the attempt; a start for
   * another device stops the current one first (one device at a time).
   */
  async start(device: RealDevice, signal?: AbortSignal): Promise<WdaStatus> {
    if (this.#seams.platform !== 'darwin') throw new WdaError('unavailable', 'WebDriverAgent needs macOS with Xcode')
    if (this.#running?.device.udid === device.udid) return this.status()
    if (this.#starting !== undefined) {
      if (this.#starting.device.udid === device.udid) return this.#starting.promise
      throw new Error(`WebDriverAgent is still starting on "${this.#starting.device.name}"; wait for it to finish first`)
    }
    const promise = (async () => {
      await this.stop()
      this.#failure = undefined
      try {
        this.#running = await this.#launch(device, signal)
        return this.status()
      } catch (error) {
        const reason = error instanceof WdaError ? error.reason : 'build-failed'
        this.#failure = { device, reason, detail: errorMessage(error) }
        throw error
      }
    })()
    this.#starting = { device, promise }
    try {
      return await promise
    } finally {
      this.#starting = undefined
    }
  }

  /**
   * The WDA client for `device`, never building: the running one, or a WDA
   * that already answers on the device (adopted), else an error naming
   * ios_real_start_wda and, when the last start failed, why.
   */
  async control(device: RealDevice): Promise<WdaSessionClient> {
    if (this.#running?.device.udid === device.udid) return this.#running.client
    if (this.#starting?.device.udid === device.udid) {
      throw new WdaError('launch-timeout', `WebDriverAgent is still starting on "${device.name}" — wait for ios_real_start_wda to finish`)
    }
    if (this.#seams.platform === 'darwin' && this.#starting === undefined) {
      const adopted = await this.#adopt(device).catch(() => undefined)
      if (adopted !== undefined) {
        await this.stop()
        this.#running = adopted
        this.#failure = undefined
        return adopted.client
      }
    }
    const failure = this.#failure?.device.udid === device.udid ? this.#failure : undefined
    throw new WdaError(failure?.reason ?? 'wda-not-ready',
      `WebDriverAgent is not running on "${device.name}" — run ios_real_start_wda first (a cold build can take minutes)`
      + (failure === undefined ? '' : `; the last start failed: ${failure.detail}`))
  }

  /** Stop the runner this controller launched and close its tunnel. An adopted WDA keeps running on the device. */
  async stop(): Promise<{ stopped: boolean; device?: { udid: string; name: string } }> {
    const running = this.#running
    if (running === undefined) return { stopped: false }
    this.#running = undefined
    running.runner?.kill()
    await running.tunnel.close().catch(() => undefined)
    return { stopped: true, device: { udid: running.device.udid, name: running.device.name } }
  }

  async dispose(): Promise<void> {
    await this.stop()
  }

  /** Synchronous exit backstop: kill the runner this controller launched. */
  terminateOnExit(): void {
    this.#running?.runner?.kill()
  }

  async #adopt(device: RealDevice): Promise<Running | undefined> {
    const tunnel = await this.#seams.openTunnel(hardwareUdidOf(device), WDA_DEVICE_PORT)
    const client = this.#seams.createClient(`http://127.0.0.1:${tunnel.localPort}`)
    try {
      const probe = this.#seams.createClient(`http://127.0.0.1:${tunnel.localPort}`, { requestTimeoutMs: ADOPT_PROBE_TIMEOUT_MS })
      if (!(await probe.health()).ready) throw new Error('not ready')
      await client.ensureSession()
      await client.setSnapshotDepth(WDA_DEFAULT_SNAPSHOT_DEPTH).catch(() => undefined)
      return { device, tunnel, client, adopted: true }
    } catch {
      await tunnel.close().catch(() => undefined)
      return undefined
    }
  }

  async #launch(device: RealDevice, signal?: AbortSignal): Promise<Running> {
    const adopted = await this.#adopt(device).catch((error: unknown) => {
      if (error instanceof WdaError) throw error
      throw new WdaError('tunnel-failed', `no USB tunnel to "${device.name}": ${errorMessage(error)}`, error)
    })
    if (adopted !== undefined) return adopted

    const team = await this.#seams.resolveTeam(signal)
    if (team.teamId === undefined) throw new WdaError('unavailable', `no signing team for WebDriverAgent — ${team.detail}`)
    let stagedDir: string
    try {
      stagedDir = await this.#seams.stageSource()
    } catch (error) {
      throw new WdaError('unavailable', errorMessage(error), error)
    }
    const hardwareUdid = hardwareUdidOf(device)
    const runner = this.#seams.spawnRunner(xcodebuildTestArgs(hardwareUdid, team.teamId, this.#seams.bundleId(team.teamId)), stagedDir)
    let tunnel: WdaTunnel | undefined
    try {
      await this.#waitForServerUrl(runner, device, signal)
      tunnel = await this.#seams.openTunnel(hardwareUdid, WDA_DEVICE_PORT)
      const client = this.#seams.createClient(`http://127.0.0.1:${tunnel.localPort}`)
      await this.#waitForReady(client, device, signal)
      await client.ensureSession()
      await client.setSnapshotDepth(WDA_DEFAULT_SNAPSHOT_DEPTH).catch(() => undefined)
      const running: Running = { device, tunnel, client, runner, adopted: false, signingTeam: `${team.teamId} (${team.source})` }
      // The runner exiting ends the WDA server: forget it so the next call says so.
      void runner.exited.then(() => {
        if (this.#running === running) {
          this.#running = undefined
          void running.tunnel.close().catch(() => undefined)
          this.#failure = { device, reason: 'wda-not-ready', detail: 'the WebDriverAgent runner (xcodebuild) exited — run ios_real_start_wda again' }
        }
      })
      return running
    } catch (error) {
      runner.kill()
      await tunnel?.close().catch(() => undefined)
      throw error
    }
  }

  #waitForServerUrl(runner: WdaChild, device: RealDevice, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      let output = ''
      let settled = false
      const finish = (error?: Error): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        if (error === undefined) resolve()
        else reject(error)
      }
      const classified = (fallback: WdaFailureReason, what: string): WdaError => {
        const reason = classifyWdaFailure(output) ?? fallback
        const tail = output.trim().split('\n').slice(-15).join('\n')
        return new WdaError(reason, `${what} — ${wdaFailureDetail(reason, device.name, this.#startTimeoutMs)}${tail === '' ? '' : `\nxcodebuild output (tail):\n${tail}`}`)
      }
      const onAbort = (): void => finish(new Error('the WebDriverAgent start was cancelled'))
      const timer = setTimeout(() => finish(classified('launch-timeout', 'WebDriverAgent did not come up in time')), this.#startTimeoutMs)
      signal?.addEventListener('abort', onAbort, { once: true })
      if (signal?.aborted === true) onAbort()
      runner.onOutput(text => {
        output = (output + text).slice(-MAX_OUTPUT_BYTES)
        if (parseServerUrlHere(output) !== undefined) finish()
      })
      void runner.exited.then(code => finish(classified('build-failed', `xcodebuild exited (code ${String(code)}) before WebDriverAgent came up`)))
    })
  }

  async #waitForReady(client: WdaSessionClient, device: RealDevice, signal?: AbortSignal): Promise<void> {
    const deadline = this.#seams.now() + this.#readyTimeoutMs
    let last = ''
    while (this.#seams.now() < deadline) {
      if (signal?.aborted === true) throw new Error('the WebDriverAgent start was cancelled')
      try {
        const health = await client.health()
        if (health.ready) return
        last = health.message ?? health.state ?? 'not ready'
      } catch (error) {
        last = errorMessage(error)
      }
      await this.#seams.sleep(READY_POLL_MS)
    }
    throw new WdaError('wda-not-ready', `WebDriverAgent on "${device.name}" did not report ready within ${Math.round(this.#readyTimeoutMs / 1000)} s (${last}) — re-run ios_real_start_wda`)
  }
}

function hardwareUdidOf(device: RealDevice): string {
  return device.hardwareUdid ?? device.udid
}

// ---------------------------------------------------------------- real seams

function findOnPath(command: string): string | undefined {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir !== '' && existsSync(join(dir, command))) return join(dir, command)
  }
  return undefined
}

function spawnGroup(command: string, args: readonly string[], cwd?: string): WdaChild {
  const child = spawn(command, [...args], { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  const listeners: Array<(text: string) => void> = []
  const emit = (chunk: Buffer): void => {
    const text = chunk.toString('utf8')
    for (const listener of listeners) listener(text)
  }
  child.stdout.on('data', emit)
  child.stderr.on('data', emit)
  const exited = new Promise<number | null>(resolve => {
    child.once('error', () => resolve(null))
    child.once('close', code => resolve(code))
  })
  return {
    onOutput: listener => { listeners.push(listener) },
    exited,
    kill: () => {
      if (child.exitCode !== null || child.signalCode !== null) return
      try {
        if (child.pid !== undefined) process.kill(-child.pid, 'SIGTERM')
        else child.kill('SIGTERM')
      } catch {
        child.kill('SIGTERM')
      }
    },
  }
}

function freeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.once('error', reject)
    server.listen({ host: '127.0.0.1', port: 0 }, () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

function portAccepts(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = connect({ host: '127.0.0.1', port })
    socket.setTimeout(500)
    socket.once('connect', () => { socket.destroy(); resolve(true) })
    socket.once('error', () => resolve(false))
    socket.once('timeout', () => { socket.destroy(); resolve(false) })
  })
}

async function openRealTunnel(hardwareUdid: string, devicePort: number): Promise<WdaTunnel> {
  const localPort = await freeLoopbackPort()
  if (usbmuxAvailable() && await resolveUsbDeviceId(hardwareUdid).catch(() => undefined) !== undefined) {
    const forward = await createUsbmuxForward({ udid: hardwareUdid, devicePort, localPort })
    return { localPort: forward.localPort, kind: 'usbmux', close: () => forward.close() }
  }
  const iproxy = findOnPath('iproxy')
  if (iproxy === undefined) {
    const kind = usbmuxAvailable() ? await classifyUsbmuxTunnelFailure(hardwareUdid).catch(() => 'not-attached' as const) : 'not-attached'
    throw new WdaError('tunnel-failed', `${usbmuxTunnelFailureDetail(kind)} (no usbmux record for the device, and iproxy is not installed: brew install libimobiledevice)`)
  }
  const child = spawnGroup(iproxy, iproxyArgs(localPort, devicePort, hardwareUdid))
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (await portAccepts(localPort)) {
      return { localPort, kind: 'iproxy', close: async () => { child.kill() } }
    }
    await new Promise(resolve => setTimeout(resolve, 150))
  }
  child.kill()
  throw new WdaError('tunnel-failed', `iproxy did not open 127.0.0.1:${localPort} for the device`)
}

/** The macOS seams: usbmuxd / iproxy, xcodebuild, the keychain and Xcode's accounts. */
export function realWdaSeams(options: { cacheRoot: string; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform }): WdaHostSeams {
  const env = options.env ?? process.env
  const sourceDir = (env.IOS_SIM_WDA_DIR?.trim() ?? '') !== '' ? env.IOS_SIM_WDA_DIR!.trim() : join(options.cacheRoot, 'WebDriverAgent')
  return {
    platform: options.platform ?? process.platform,
    resolveTeam: signal => resolveSigningTeam({ ...(env.IOS_SIM_TEAM_ID === undefined ? {} : { env: env.IOS_SIM_TEAM_ID }), home: homedir(), ...(signal === undefined ? {} : { signal }) }),
    stageSource: () => stageWdaSource(sourceDir, join(options.cacheRoot, 'wda')),
    bundleId: teamId => wdaBundleId(teamId, env.IOS_SIM_WDA_BUNDLE_ID),
    spawnRunner: (args, cwd) => spawnGroup('xcodebuild', args, cwd),
    openTunnel: openRealTunnel,
    createClient: (url, clientOptions) => new WdaClient(url, clientOptions),
    sleep: milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
    now: Date.now,
  }
}
