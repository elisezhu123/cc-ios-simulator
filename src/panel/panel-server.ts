// Ported from dsh-ios (MIT, © 2026 ZSeven—W) @ d9a9731 — src/stream-routes.ts (MJPEG proxy, control-socket relay)
/**
 * The live panel's loopback HTTP + WebSocket server. It replaces dsh-ios's
 * signed DSH webserver routes (src/stream-routes.ts) with a dedicated
 * 127.0.0.1 origin: the MJPEG proxy and the control-socket relay are ported;
 * the HMAC capability layer is unnecessary on a dedicated origin (spec §8.1).
 * @module ios-simulator/panel/panel-server
 */

import { createReadStream, lstatSync, realpathSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createServer, get as httpGet, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { basename, join, sep } from 'node:path'
import { pipeline, type Duplex } from 'node:stream'
import { WebSocket, WebSocketServer, type RawData } from 'ws'
import { PANEL_PORT_ATTEMPTS, PLUGIN_NAME } from '../config.js'
import type { ScreenshotService, SimctlApi, StreamHost } from '../deps.js'
import { isDeviceAction } from '../device-actions.js'
import { isScreenshotFileName } from '../screenshot.js'
import type { SimulatorDevice } from '../simctl.js'
import type { StreamSource } from '../stream-source.js'
import { pickPreferred, sortDevices } from '../target.js'
import { checkRequest, type FenceKind } from './fence.js'

export interface PanelServerOptions {
  /** Directory holding index.html, main.js and styles.css. */
  staticDir: string
  preferredPort: number
  /** Ports tried: preferredPort .. preferredPort + attempts - 1 (default 21). */
  attempts?: number
  host: StreamHost
  stream: StreamSource
  simctl: Pick<SimctlApi, 'listDevices' | 'getDevice' | 'bootDevice'>
  screenshots: Pick<ScreenshotService, 'capture' | 'dir'>
}

const STATIC_FILES: Readonly<Record<string, { file: string; type: string }>> = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/main.js': { file: 'main.js', type: 'text/javascript; charset=utf-8' },
  '/styles.css': { file: 'styles.css', type: 'text/css; charset=utf-8' },
}
const MAX_BODY_BYTES = 16 * 1024
const MAX_PENDING_WS_FRAMES = 64
const WEBSOCKET_KEY_PATTERN = /^[A-Za-z0-9+/]{22}==$/u
const STATUS_TEXT: Readonly<Record<number, string>> = {
  400: 'Bad Request',
  403: 'Forbidden',
  404: 'Not Found',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(body)
}

function rejectUpgrade(socket: Duplex, status: number): void {
  if (socket.destroyed) return
  socket.write(`HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? 'Error'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
  socket.destroy()
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data
  if (Array.isArray(data)) return Buffer.concat(data)
  return Buffer.from(data)
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'request body too large')
    chunks.push(buffer)
  }
  if (size === 0) return {}
  let value: unknown
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HttpError(400, 'request body is not JSON')
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HttpError(400, 'request body must be a JSON object')
  }
  return value as Record<string, unknown>
}

export class PanelServer {
  readonly #options: PanelServerOptions
  readonly #wss = new WebSocketServer({ noServer: true, perMessageDeflate: false })
  readonly #teardowns = new Set<() => void>()
  #server: Server | undefined
  #port = 0
  #starting: Promise<string> | undefined
  #disposed = false

  constructor(options: PanelServerOptions) {
    this.#options = options
  }

  /** The panel URL once started. */
  get url(): string | undefined {
    return this.#server === undefined ? undefined : `http://127.0.0.1:${this.#port}/`
  }

  /** Start listening (once) and resolve the panel URL. */
  ensureStarted(): Promise<string> {
    if (this.#disposed) return Promise.reject(new Error('the panel server is disposed'))
    this.#starting ??= this.#listen().catch((error: unknown) => {
      this.#starting = undefined
      throw error
    })
    return this.#starting
  }

  /** Close every stream proxy and relay, then the listener. */
  async dispose(): Promise<void> {
    this.#disposed = true
    for (const teardown of [...this.#teardowns]) teardown()
    this.#wss.close()
    const server = this.#server
    this.#server = undefined
    if (server !== undefined) {
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  }

  async #listen(): Promise<string> {
    const attempts = this.#options.attempts ?? PANEL_PORT_ATTEMPTS
    let lastError: unknown
    for (let offset = 0; offset < attempts; offset += 1) {
      const port = this.#options.preferredPort + offset
      if (port > 65535) break
      const server = createServer((req, res) => { void this.#handle(req, res) })
      server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => { void this.#handleUpgrade(req, socket, head) })
      try {
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject)
          server.listen(port, '127.0.0.1', () => {
            server.off('error', reject)
            resolve()
          })
        })
      } catch (error) {
        lastError = error
        if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') continue
        break
      }
      // A listening server still emits 'error' (e.g. accept() failing with EMFILE). Unhandled, that is an
      // uncaught exception that kills the MCP server and orphans serve-sim: log it and keep serving.
      server.on('error', error => {
        process.stderr.write(`${PLUGIN_NAME}: panel server error (still serving): ${errorMessage(error)}\n`)
      })
      this.#server = server
      this.#port = (server.address() as AddressInfo).port
      return `http://127.0.0.1:${this.#port}/`
    }
    throw new Error(`could not start the panel server on 127.0.0.1:${this.#options.preferredPort}+: ${errorMessage(lastError)}`)
  }

  #allowed(req: IncomingMessage, kind: FenceKind): boolean {
    return checkRequest({ remoteAddress: req.socket.remoteAddress, headers: req.headers }, this.#port, kind).ok
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const method = req.method ?? 'GET'
      if (!this.#allowed(req, method === 'GET' || method === 'HEAD' ? 'read' : 'mutate')) {
        sendJson(res, 403, { ok: false, error: 'forbidden' })
        return
      }
      const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
      const staticFile = STATIC_FILES[path]
      if (method === 'GET' && staticFile !== undefined) return await this.#serveStatic(res, staticFile)
      if (method === 'GET' && path === '/stream') return await this.#serveStream(res)
      if (method === 'GET' && path.startsWith('/shots/')) return this.#serveShot(res, path.slice('/shots/'.length))
      if (method === 'GET' && path === '/api/status') return sendJson(res, 200, await this.#status())
      if (method === 'GET' && path === '/api/devices') return sendJson(res, 200, await this.#devices())
      if (method === 'POST' && path === '/api/switch-device') {
        return sendJson(res, 200, await this.#switchDevice(await readJsonBody(req)))
      }
      if (method === 'POST' && path === '/api/capture') {
        await readJsonBody(req)
        return sendJson(res, 200, await this.#capture())
      }
      if (method === 'POST' && path === '/api/device-action') {
        return sendJson(res, 200, await this.#deviceAction(await readJsonBody(req)))
      }
      sendJson(res, 404, { ok: false, error: 'not found' })
    } catch (error) {
      if (res.headersSent) {
        res.destroy()
        return
      }
      sendJson(res, error instanceof HttpError ? error.status : 500, { ok: false, error: errorMessage(error) })
    }
  }

  async #serveStatic(res: ServerResponse, entry: { file: string; type: string }): Promise<void> {
    const body = await readFile(join(this.#options.staticDir, entry.file))
    const port = this.#port
    res.writeHead(200, {
      'content-type': entry.type,
      'content-length': body.length,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'content-security-policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; "
        + `connect-src 'self' ws://127.0.0.1:${port} ws://localhost:${port}`,
    })
    res.end(body)
  }

  /** The streamed device, else the preferred booted one (never boots anything). */
  async #currentDevice(): Promise<SimulatorDevice | undefined> {
    const status = this.#options.host.status()
    if (status.running && status.device !== undefined) {
      try {
        return await this.#options.simctl.getDevice(status.device)
      } catch {
        // fall through to the booted devices
      }
    }
    const booted = (await this.#options.simctl.listDevices()).filter(device => device.state === 'Booted')
    return booted.length === 0 ? undefined : pickPreferred(booted)
  }

  /** Only streams the device already running; never boots or switches one (spec §8.1: GET routes are side-effect free). */
  async #serveStream(res: ServerResponse): Promise<void> {
    const status = this.#options.host.status()
    if (!status.running || status.device === undefined) {
      throw new HttpError(503, 'no simulator is streaming — boot one with ios_sim_boot')
    }
    const release = this.#options.host.acquire()
    let streamUrl: string
    try {
      streamUrl = (await this.#options.host.ensureRunning({ udid: status.device })).streamUrl
    } catch (error) {
      release()
      throw new HttpError(502, `the simulator stream failed to start: ${errorMessage(error)}`)
    }
    if (this.#disposed || res.destroyed) {
      release()
      return
    }
    this.#proxy(streamUrl, res, release)
  }

  /** Pipe serve-sim's multipart body through unchanged; hold one consumer while open. */
  #proxy(streamUrl: string, res: ServerResponse, release: () => void): void {
    let closed = false
    const upstream = httpGet(streamUrl)
    const teardown = (): void => {
      if (closed) return
      closed = true
      this.#teardowns.delete(teardown)
      upstream.destroy()
      if (!res.writableEnded) res.destroy()
      release()
    }
    this.#teardowns.add(teardown)
    res.on('close', teardown)
    res.on('error', teardown)
    upstream.on('error', teardown)
    upstream.on('response', response => {
      if (closed) {
        response.destroy()
        return
      }
      if (response.statusCode !== 200) {
        response.resume()
        sendJson(res, 502, { ok: false, error: `serve-sim stream returned HTTP ${String(response.statusCode)}` })
        teardown()
        return
      }
      // serve-sim's own `Access-Control-Allow-Origin: *` is deliberately NOT forwarded.
      res.writeHead(200, {
        'content-type': response.headers['content-type'] ?? 'multipart/x-mixed-replace; boundary=frame',
        'cache-control': 'no-cache, no-store',
        'x-content-type-options': 'nosniff',
        'cross-origin-resource-policy': 'same-origin',
        'referrer-policy': 'no-referrer',
      })
      response.on('error', teardown)
      response.pipe(res)
    })
  }

  #serveShot(res: ServerResponse, name: string): void {
    if (!isScreenshotFileName(name)) throw new HttpError(404, 'not found')
    const dir = this.#options.screenshots.dir
    let real: string
    try {
      const path = join(dir, name)
      const stat = lstatSync(path)
      if (stat.isSymbolicLink() || !stat.isFile()) throw new HttpError(404, 'not found')
      real = realpathSync(path)
      if (!real.startsWith(realpathSync(dir) + sep)) throw new HttpError(404, 'not found')
    } catch (error) {
      throw error instanceof HttpError ? error : new HttpError(404, 'not found')
    }
    res.writeHead(200, {
      'content-type': 'image/png',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'cross-origin-resource-policy': 'same-origin',
    })
    // pipeline (unlike .pipe()) forwards a source read error instead of leaving it uncaught —
    // e.g. the file vanishing between the checks above and the actual read (screenshot pruning).
    pipeline(createReadStream(real), res, () => {})
  }

  async #status(): Promise<Record<string, unknown>> {
    const status = this.#options.host.status()
    let deviceName: string | undefined
    if (status.device !== undefined) {
      try {
        deviceName = (await this.#options.simctl.getDevice(status.device)).name
      } catch {
        deviceName = undefined
      }
    }
    return {
      running: status.running,
      available: this.#options.host.binary.available,
      ...(status.device === undefined ? {} : { device: status.device }),
      ...(deviceName === undefined ? {} : { deviceName }),
      panelUrl: `http://127.0.0.1:${this.#port}/`,
    }
  }

  async #devices(): Promise<Record<string, unknown>> {
    const devices = sortDevices(await this.#options.simctl.listDevices()).slice(0, 50)
    const status = this.#options.host.status()
    return {
      devices: devices.map(device => ({ udid: device.udid, name: device.name, runtime: device.runtime, state: device.state })),
      ...(status.running && status.device !== undefined ? { streaming: status.device } : {}),
    }
  }

  /** Picking a device in the panel is an explicit user gesture, so it may boot it. */
  async #switchDevice(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const udid = typeof body.udid === 'string' ? body.udid.trim() : ''
    if (udid === '') throw new HttpError(400, 'udid is required')
    let device: SimulatorDevice
    try {
      device = await this.#options.simctl.getDevice(udid)
    } catch (error) {
      throw new HttpError(409, errorMessage(error))
    }
    if (device.state !== 'Booted') await this.#options.simctl.bootDevice(device.udid)
    await this.#options.host.ensureRunning({ udid: device.udid })
    return { ok: true, device: { udid: device.udid, name: device.name, runtime: device.runtime, state: 'Booted' } }
  }

  async #capture(): Promise<Record<string, unknown>> {
    const device = await this.#currentDevice()
    if (device === undefined) throw new HttpError(409, 'no booted simulator to capture')
    const shot = await this.#options.screenshots.capture(device.udid)
    return {
      ok: true,
      url: `/shots/${basename(shot.path)}`,
      ...(shot.width === undefined ? {} : { width: shot.width, height: shot.height }),
    }
  }

  async #deviceAction(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const action = body.action
    if (!isDeviceAction(action)) throw new HttpError(400, 'unknown device action')
    const device = await this.#currentDevice()
    if (device === undefined) throw new HttpError(409, 'no booted simulator')
    await this.#options.host.ensureRunning({ udid: device.udid })
    const run = this.#options.stream.control.deviceAction
    if (run === undefined) throw new HttpError(501, 'device actions are not supported by this backend')
    await run(action)
    return { ok: true, action }
  }

  async #handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    // Node hands us this socket raw; until a listener is attached, any error on it
    // (e.g. the client resetting the connection) is an uncaught exception.
    socket.on('error', () => socket.destroy())
    try {
      // The fence gates every route (spec §8.1): check it before even the path,
      // so a foreign-Origin upgrade to an unknown path is still a 403, not a 404.
      if (!this.#allowed(req, 'upgrade')) return rejectUpgrade(socket, 403)
      if (new URL(req.url ?? '/', 'http://127.0.0.1').pathname !== '/ws') return rejectUpgrade(socket, 404)
      const key = req.headers['sec-websocket-key']
      if (typeof key !== 'string' || !WEBSOCKET_KEY_PATTERN.test(key)) return rejectUpgrade(socket, 400)
      const status = this.#options.host.status()
      if (!status.running || status.device === undefined) return rejectUpgrade(socket, 503)
      const release = this.#options.host.acquire()
      let wsUrl: string
      try {
        wsUrl = (await this.#options.host.ensureRunning({ udid: status.device })).wsUrl
      } catch {
        release()
        return rejectUpgrade(socket, 502)
      }
      if (this.#disposed) {
        release()
        return rejectUpgrade(socket, 503)
      }
      this.#relay(req, socket, head, wsUrl, release)
    } catch {
      rejectUpgrade(socket, 502)
    }
  }

  /** Relay binary HID frames between the panel and serve-sim's control socket. */
  #relay(req: IncomingMessage, socket: Duplex, head: Buffer, wsUrl: string, release: () => void): void {
    let browser: WebSocket | undefined
    let upstream: WebSocket | undefined
    let finished = false
    const teardown = (): void => {
      if (finished) return
      finished = true
      this.#teardowns.delete(teardown)
      browser?.terminate()
      upstream?.terminate()
      socket.destroy()
      release()
    }
    this.#teardowns.add(teardown)
    socket.on('error', teardown)
    socket.on('close', () => {
      if (browser === undefined) teardown()
    })
    this.#wss.handleUpgrade(req, socket, head, client => {
      if (finished) {
        client.terminate()
        return
      }
      browser = client
      const target = new WebSocket(wsUrl, { perMessageDeflate: false })
      upstream = target
      const pending: Array<{ data: Buffer; binary: boolean }> = []
      client.on('error', teardown)
      client.on('close', teardown)
      target.on('error', teardown)
      target.on('close', teardown)
      target.on('open', () => {
        for (const frame of pending) target.send(frame.data, { binary: frame.binary })
        pending.length = 0
      })
      client.on('message', (data: RawData, isBinary: boolean) => {
        const frame = { data: toBuffer(data), binary: isBinary }
        if (target.readyState === WebSocket.OPEN) target.send(frame.data, { binary: frame.binary })
        else if (pending.length < MAX_PENDING_WS_FRAMES) pending.push(frame)
      })
      target.on('message', (data: RawData, isBinary: boolean) => {
        if (client.readyState === WebSocket.OPEN) client.send(toBuffer(data), { binary: isBinary })
      })
    })
  }
}
