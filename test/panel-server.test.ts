import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request, type IncomingHttpHeaders } from 'node:http'
import { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket, WebSocketServer } from 'ws'
import { PanelServer } from '../src/panel/panel-server.js'
import { ScreenshotStore } from '../src/screenshot.js'
import { SimStreamSource } from '../src/stream-source.js'
import { fakeHost, fakeSimctl } from './helpers/fakes.js'

interface Upstream {
  port: number
  received: Buffer[]
  close(): void
}

/** A serve-sim stand-in: an MJPEG route plus a control socket that greets with a config frame. */
async function fakeServeSim(): Promise<Upstream> {
  const http = createServer((req, res) => {
    if (req.url === '/stream.mjpeg') {
      res.writeHead(200, { 'content-type': 'multipart/x-mixed-replace; boundary=frame', 'access-control-allow-origin': '*' })
      res.write('--frame\r\nContent-Type: image/jpeg\r\n\r\nJPEG1\r\n')
      return
    }
    res.writeHead(404).end()
  })
  const wss = new WebSocketServer({ server: http })
  const received: Buffer[] = []
  wss.on('connection', socket => {
    socket.send(Buffer.concat([Buffer.from([130]), Buffer.from(JSON.stringify({ width: 1206, height: 2622, orientation: 'portrait' }))]))
    socket.on('message', data => { received.push(data as Buffer) })
  })
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', () => resolve()))
  return {
    port: (http.address() as { port: number }).port,
    received,
    close: () => {
      wss.close()
      http.closeAllConnections()
      http.close()
    },
  }
}

interface Fixture {
  port: number
  upstream: Upstream
  hostCalls: string[][]
  simctlCalls: unknown[][]
  shotsDir: string
  consumers(): number
  close(): Promise<void>
}

async function panelFixture(): Promise<Fixture> {
  const upstream = await fakeServeSim()
  const { host, calls: hostCalls, consumers } = fakeHost({ device: 'BBB', baseUrl: `http://127.0.0.1:${upstream.port}` })
  const { api: simctl, calls: simctlCalls } = fakeSimctl()
  const staticDir = mkdtempSync(join(tmpdir(), 'ios-sim-static-'))
  writeFileSync(join(staticDir, 'index.html'), '<!doctype html><title>panel</title>')
  writeFileSync(join(staticDir, 'main.js'), '')
  writeFileSync(join(staticDir, 'styles.css'), '')
  const shotsDir = mkdtempSync(join(tmpdir(), 'ios-sim-panel-shots-'))
  const panel = new PanelServer({
    staticDir,
    preferredPort: 0,
    attempts: 1,
    host,
    stream: new SimStreamSource(host),
    simctl,
    screenshots: new ScreenshotStore({ dir: shotsDir, takeScreenshot: simctl.takeScreenshot }),
  })
  const url = await panel.ensureStarted()
  return {
    port: Number(new URL(url).port),
    upstream,
    hostCalls,
    simctlCalls,
    shotsDir,
    consumers,
    close: async () => {
      await panel.dispose()
      upstream.close()
    },
  }
}

interface Reply {
  status: number
  headers: IncomingHttpHeaders
  body: string
}

/** Plain node:http, so Host / Origin / Sec-Fetch-Site are fully under test control. */
function call(port: number, path: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: options.method ?? 'GET', headers: options.headers }, res => {
      const chunks: Buffer[] = []
      const finish = (): void => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') })
      if (String(res.headers['content-type']).startsWith('multipart/')) {
        res.once('data', chunk => {
          chunks.push(chunk as Buffer)
          finish()
          res.destroy()
        })
        return
      }
      res.on('data', chunk => chunks.push(chunk as Buffer))
      res.on('end', finish)
    })
    req.on('error', reject)
    req.end(options.body)
  })
}

function jsonHeaders(port: number): Record<string, string> {
  return { origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }
}

test('serves the panel page with a CSP and rejects DNS-rebinding hosts', async () => {
  const f = await panelFixture()
  const page = await call(f.port, '/')
  assert.equal(page.status, 200)
  assert.match(page.body, /<title>panel<\/title>/)
  assert.match(String(page.headers['content-security-policy']), /default-src 'self'/)
  assert.equal((await call(f.port, '/', { headers: { host: 'evil.example' } })).status, 403)
  assert.equal((await call(f.port, '/nope')).status, 404)
  await f.close()
})

test('proxies the MJPEG stream without upstream CORS headers and releases its consumer', async () => {
  const f = await panelFixture()
  const stream = await call(f.port, '/stream')
  assert.equal(stream.status, 200)
  assert.match(stream.body, /--frame/)
  assert.equal(stream.headers['access-control-allow-origin'], undefined)
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(f.consumers(), 0)
  await f.close()
})

test('mutations need our Origin and JSON; captures are served from /shots', async () => {
  const f = await panelFixture()
  const foreign = await call(f.port, '/api/capture', { method: 'POST', headers: { ...jsonHeaders(f.port), origin: 'http://evil.example' }, body: '{}' })
  assert.equal(foreign.status, 403)
  const plain = await call(f.port, '/api/capture', { method: 'POST', headers: { ...jsonHeaders(f.port), 'content-type': 'text/plain' }, body: '{}' })
  assert.equal(plain.status, 403)
  const captured = await call(f.port, '/api/capture', { method: 'POST', headers: jsonHeaders(f.port), body: '{}' })
  assert.equal(captured.status, 200)
  const { url } = JSON.parse(captured.body) as { url: string }
  assert.match(url, /^\/shots\/screenshot-BBB-\d+\.png$/)
  const png = await call(f.port, url)
  assert.equal(png.status, 200)
  assert.equal(png.headers['content-type'], 'image/png')
  await f.close()
})

test('/shots refuses traversal and symlinks', async () => {
  const f = await panelFixture()
  symlinkSync('/etc/hosts', join(f.shotsDir, 'screenshot-X-1.png'))
  assert.equal((await call(f.port, '/shots/..%2F..%2Fetc%2Fhosts')).status, 404)
  assert.equal((await call(f.port, '/shots/screenshot-X-1.png')).status, 404)
  await f.close()
})

test('status, devices and switch-device (which may boot the chosen device)', async () => {
  const f = await panelFixture()
  const status = JSON.parse((await call(f.port, '/api/status')).body) as { running: boolean; device: string; deviceName: string }
  assert.deepEqual([status.running, status.device, status.deviceName], [true, 'BBB', 'iPhone 17 Pro'])
  const devices = JSON.parse((await call(f.port, '/api/devices')).body) as { devices: Array<{ udid: string }>; streaming: string }
  assert.deepEqual(devices.devices.map(device => device.udid), ['BBB', 'EEE', 'CCC', 'AAA'])
  assert.equal(devices.streaming, 'BBB')
  const switched = await call(f.port, '/api/switch-device', { method: 'POST', headers: jsonHeaders(f.port), body: JSON.stringify({ udid: 'CCC' }) })
  assert.equal(switched.status, 200)
  assert.deepEqual(f.simctlCalls, [['boot', 'CCC']])
  assert.ok(f.hostCalls.some(entry => entry.join(' ') === 'ensureRunning CCC'))
  await f.close()
})

test('relays control frames both ways over /ws and refuses foreign origins', async () => {
  const f = await panelFixture()
  const client = new WebSocket(`ws://127.0.0.1:${f.port}/ws`, { origin: `http://127.0.0.1:${f.port}` })
  const firstMessage = new Promise<Buffer>(resolve => client.once('message', data => resolve(data as Buffer)))
  await new Promise<void>((resolve, reject) => {
    client.once('open', () => resolve())
    client.once('error', reject)
  })
  assert.equal((await firstMessage)[0], 130)
  client.send(Buffer.concat([Buffer.from([4]), Buffer.from('{"button":"home"}')]))
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(f.upstream.received[0]?.[0], 4)
  client.close()
  const status = await new Promise<number>(resolve => {
    const foreign = new WebSocket(`ws://127.0.0.1:${f.port}/ws`, { origin: 'http://evil.example' })
    foreign.on('unexpected-response', (_request, response) => resolve(response.statusCode ?? 0))
    foreign.on('error', () => resolve(-1))
  })
  assert.equal(status, 403)
  await f.close()
})
