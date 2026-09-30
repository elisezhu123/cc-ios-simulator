/**
 * `server.js --panel-proxy`: the process Claude Code desktop's preview pane
 * starts (from `.claude/launch.json`) to show the live panel. It listens on
 * the port the preview assigns and forwards every request and the control
 * WebSocket to the panel the MCP server runs, whose port it reads from the
 * panel's state file on each request (the panel may restart elsewhere).
 *
 * The proxy applies the panel's own fence to its own port (loopback peer,
 * loopback Host, our Origin for changes), then rewrites Host and Origin to
 * the panel's, so the panel's fence still holds end to end.
 * @module ios-simulator/panel/panel-proxy
 */

import { readFileSync } from 'node:fs'
import { createServer, request, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'
import { checkRequest, type FenceKind } from './fence.js'

/** What the panel writes when it starts listening. */
export interface PanelState {
  url: string
  port: number
  pid: number
}

export function readPanelState(stateFile: string): PanelState | undefined {
  try {
    const state = JSON.parse(readFileSync(stateFile, 'utf8')) as Partial<PanelState>
    return typeof state.port === 'number' && typeof state.url === 'string' && typeof state.pid === 'number'
      ? { url: state.url, port: state.port, pid: state.pid }
      : undefined
  } catch {
    return undefined
  }
}

const WAITING_PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="3">
<title>iOS Simulator</title></head><body style="font:15px -apple-system,BlinkMacSystemFont,sans-serif;color:#6e6e73;
display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center">
<p>The iOS Simulator panel is not running yet.<br>Ask Claude to boot a simulator (ios_sim_boot) or open the panel (ios_sim_panel).<br>
This page retries every 3 seconds.</p></body></html>`

/** The request headers with Host (and Origin, when sent) pointing at the panel. */
export function rewriteHeaders(headers: IncomingHttpHeaders, panelPort: number): IncomingHttpHeaders {
  const rewritten: IncomingHttpHeaders = { ...headers, host: `127.0.0.1:${panelPort}` }
  if (headers.origin !== undefined) rewritten.origin = `http://127.0.0.1:${panelPort}`
  return rewritten
}

function fenceKind(req: IncomingMessage): FenceKind {
  return req.method === 'GET' || req.method === 'HEAD' ? 'read' : 'mutate'
}

export interface PanelProxy {
  readonly port: number
  close(): Promise<void>
}

export async function startPanelProxy(options: { port: number; stateFile: string; host?: string }): Promise<PanelProxy> {
  let ownPort = 0
  const allowed = (req: IncomingMessage, kind: FenceKind): boolean =>
    checkRequest({ remoteAddress: req.socket.remoteAddress, headers: req.headers }, ownPort, kind).ok

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (!allowed(req, fenceKind(req))) {
      res.writeHead(403, { 'content-type': 'text/plain' }).end('forbidden')
      return
    }
    const state = readPanelState(options.stateFile)
    const waiting = (): void => {
      if (res.headersSent) {
        res.destroy()
        return
      }
      res.writeHead(503, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(WAITING_PAGE)
    }
    if (state === undefined) return waiting()
    const upstream = request({
      host: '127.0.0.1',
      port: state.port,
      method: req.method,
      path: req.url,
      headers: rewriteHeaders(req.headers, state.port),
    }, response => {
      res.writeHead(response.statusCode ?? 502, response.headers)
      response.pipe(res)
    })
    upstream.on('error', waiting)
    res.on('close', () => upstream.destroy())
    req.pipe(upstream)
  })

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on('error', () => socket.destroy())
    const state = readPanelState(options.stateFile)
    if (!allowed(req, 'upgrade') || state === undefined) {
      socket.end(`HTTP/1.1 ${state === undefined ? '503 Service Unavailable' : '403 Forbidden'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
      return
    }
    const upstream = request({
      host: '127.0.0.1',
      port: state.port,
      method: req.method,
      path: req.url,
      headers: rewriteHeaders(req.headers, state.port),
    })
    upstream.on('upgrade', (response, upstreamSocket, upstreamHead) => {
      const lines = [`HTTP/1.1 ${response.statusCode ?? 101} ${response.statusMessage ?? 'Switching Protocols'}`]
      for (let index = 0; index < response.rawHeaders.length; index += 2) {
        lines.push(`${response.rawHeaders[index]}: ${response.rawHeaders[index + 1]}`)
      }
      socket.write(`${lines.join('\r\n')}\r\n\r\n`)
      if (upstreamHead.length > 0) socket.write(upstreamHead)
      if (head.length > 0) upstreamSocket.write(head)
      upstreamSocket.on('error', () => socket.destroy())
      socket.on('close', () => upstreamSocket.destroy())
      upstreamSocket.on('close', () => socket.destroy())
      upstreamSocket.pipe(socket).pipe(upstreamSocket)
    })
    upstream.on('response', response => {
      socket.end(`HTTP/1.1 ${response.statusCode ?? 502} ${response.statusMessage ?? ''}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
      response.resume()
    })
    upstream.on('error', () => socket.destroy())
    upstream.end()
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port, options.host ?? '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  ownPort = (server.address() as AddressInfo).port
  return {
    port: ownPort,
    close: () => new Promise(resolve => {
      server.closeAllConnections()
      server.close(() => resolve())
    }),
  }
}
