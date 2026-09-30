import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request, type IncomingHttpHeaders } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import { WdaController, type WdaHostSeams, type WdaTunnel } from '../src/wda-host.js'
import { PanelServer } from '../src/panel/panel-server.js'
import { RealTouchTranslator } from '../src/panel/real-control.js'
import { ScreenshotStore } from '../src/screenshot.js'
import { SimStreamSource } from '../src/stream-source.js'
import { fakeHost, fakeRealDevices, fakeSimctl, fakeWda, IPHONE } from './helpers/fakes.js'

const frame = (tag: number, payload: unknown): Uint8Array => Buffer.concat([Buffer.from([tag]), Buffer.from(JSON.stringify(payload))])

test('RealTouchTranslator turns begin/end into a tap or a timed drag, and maps buttons and rotation', () => {
  const touch = new RealTouchTranslator()
  assert.equal(touch.feed(frame(3, { type: 'begin', x: 0.5, y: 0.5 }), 1000), undefined)
  assert.equal(touch.feed(frame(3, { type: 'move', x: 0.505, y: 0.5 }), 1050), undefined)
  assert.deepEqual(touch.feed(frame(3, { type: 'end', x: 0.505, y: 0.5 }), 1100), { kind: 'tap', x: 0.5, y: 0.5 })
  touch.feed(frame(3, { type: 'begin', x: 0.5, y: 0.8 }), 2000)
  assert.deepEqual(touch.feed(frame(3, { type: 'end', x: 0.5, y: 0.2 }), 2400), { kind: 'drag', fromX: 0.5, fromY: 0.8, toX: 0.5, toY: 0.2, duration: 0.4 })
  assert.equal(touch.feed(frame(3, { type: 'end', x: 0.5, y: 0.2 }), 2500), undefined, 'an end without a begin is dropped')
  assert.deepEqual(touch.feed(frame(4, { button: 'home' }), 0), { kind: 'button', name: 'home' })
  assert.deepEqual(touch.feed(frame(4, { button: 'lock' }), 0), { kind: 'lock' })
  assert.equal(touch.feed(frame(4, { button: 'action' }), 0), undefined)
  assert.deepEqual(touch.feed(frame(7, { orientation: 'landscape_left' }), 0), { kind: 'rotate', orientation: 'LANDSCAPE' })
  assert.equal(touch.feed(Uint8Array.from([3, 123]), 0), undefined, 'malformed JSON is ignored')
})

test('WdaController opens the MJPEG tunnel once, on device port 9100, and closes it on stop', async () => {
  const opened: string[] = []
  const closed: string[] = []
  const client = { ...fakeWda().client, health: async () => ({ ready: true }) }
  const seams: WdaHostSeams = {
    platform: 'darwin',
    resolveTeam: async () => ({ source: 'none', detail: 'unused' }),
    stageSource: async () => '/unused',
    bundleId: () => 'unused',
    spawnRunner: () => { throw new Error('unused') },
    openTunnel: async (_udid, port): Promise<WdaTunnel> => {
      opened.push(String(port))
      return { localPort: port + 40000, kind: 'usbmux', close: async () => { closed.push(String(port)) } }
    },
    createClient: () => client,
    sleep: async () => {},
    now: Date.now,
  }
  const controller = new WdaController(seams)
  await assert.rejects(controller.mjpegUrl(IPHONE), /run ios_real_start_wda first/)
  await controller.start(IPHONE)
  assert.equal(await controller.mjpegUrl(IPHONE), 'http://127.0.0.1:49100/')
  assert.equal(await controller.mjpegUrl(IPHONE), 'http://127.0.0.1:49100/')
  assert.deepEqual(opened, ['8100', '9100'])
  await controller.stop()
  assert.deepEqual(closed.sort(), ['8100', '9100'])
})

interface Reply {
  status: number
  headers: IncomingHttpHeaders
  body: string
}

function call(port: number, path: string, options: { method?: string; body?: string } = {}): Promise<Reply> {
  const headers = options.method === 'POST'
    ? { origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }
    : {}
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: options.method ?? 'GET', headers }, res => {
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

/** A panel over a streaming simulator (BBB) and an iPhone on which WDA runs, with WDA's MJPEG served locally. */
async function realPanel() {
  const mjpeg = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'multipart/x-mixed-replace; boundary=--BoundaryString' })
    res.write('--BoundaryString\r\nContent-type: image/jpg\r\n\r\nWDAJPEG\r\n')
  })
  await new Promise<void>(resolve => mjpeg.listen(0, '127.0.0.1', () => resolve()))
  const wda = fakeWda({ running: IPHONE, mjpegUrl: `http://127.0.0.1:${(mjpeg.address() as AddressInfo).port}/` })
  const { host } = fakeHost({ device: 'BBB' })
  const { api: simctl } = fakeSimctl()
  const staticDir = mkdtempSync(join(tmpdir(), 'ios-sim-static-'))
  for (const file of ['index.html', 'main.js', 'styles.css']) writeFileSync(join(staticDir, file), '')
  const panel = new PanelServer({
    staticDir,
    preferredPort: 0,
    attempts: 1,
    host,
    stream: new SimStreamSource(host),
    simctl,
    screenshots: new ScreenshotStore({ dir: mkdtempSync(join(tmpdir(), 'ios-sim-panel-shots-')), takeScreenshot: simctl.takeScreenshot }),
    wda: wda.api,
    realDevices: fakeRealDevices({ devices: [IPHONE] }).api,
  })
  const port = Number(new URL(await panel.ensureStarted()).port)
  return {
    panel,
    port,
    wda: wda.api,
    wdaCalls: wda.calls,
    close: async () => {
      await panel.dispose()
      mjpeg.closeAllConnections()
      mjpeg.close()
    },
  }
}

test('the panel lists the iPhone, switches to it, and proxies the WDA MJPEG stream', async () => {
  const f = await realPanel()
  try {
    const devices = JSON.parse((await call(f.port, '/api/devices')).body) as { realDevices: Array<{ udid: string }>; streaming: string }
    assert.deepEqual([devices.realDevices.map(device => device.udid), devices.streaming], [[IPHONE.udid], 'BBB'])
    const switched = await call(f.port, '/api/switch-device', { method: 'POST', body: JSON.stringify({ udid: IPHONE.udid }) })
    assert.equal(switched.status, 200)
    const status = JSON.parse((await call(f.port, '/api/status')).body) as { kind: string; running: boolean; deviceName: string }
    assert.deepEqual([status.kind, status.running, status.deviceName], ['real', true, 'Test iPhone'])
    const stream = await call(f.port, '/stream')
    assert.equal(stream.status, 200)
    assert.match(stream.body, /WDAJPEG/)
    // Back to a simulator.
    await call(f.port, '/api/switch-device', { method: 'POST', body: JSON.stringify({ udid: 'BBB' }) })
    assert.equal((JSON.parse((await call(f.port, '/api/status')).body) as { kind: string }).kind, 'simulator')
  } finally {
    await f.close()
  }
})

test('on an iPhone, panel touches become WDA taps; capture and device actions go through WDA', async () => {
  const f = await realPanel()
  try {
    await f.panel.showRealDevice(IPHONE)
    const socket = new WebSocket(`ws://127.0.0.1:${f.port}/ws`, { origin: `http://127.0.0.1:${f.port}` })
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve())
      socket.once('error', reject)
    })
    socket.send(frame(3, { type: 'begin', x: 0.25, y: 0.5 }))
    socket.send(frame(3, { type: 'end', x: 0.25, y: 0.5 }))
    socket.send(frame(4, { button: 'home' }))
    await new Promise(resolve => setTimeout(resolve, 150))
    socket.close()
    assert.ok(f.wdaCalls.includes('tap 100.5,437'), f.wdaCalls.join(' | '))
    assert.ok(f.wdaCalls.includes('button home'))
    const captured = JSON.parse((await call(f.port, '/api/capture', { method: 'POST', body: '{}' })).body) as { url: string; width: number }
    assert.match(captured.url, new RegExp(`^/shots/screenshot-${IPHONE.udid}-\\d+\\.png$`))
    assert.equal(captured.width, 1206)
    assert.equal((await call(f.port, '/api/device-action', { method: 'POST', body: '{"action":"lock"}' })).status, 200)
    const shake = await call(f.port, '/api/device-action', { method: 'POST', body: '{"action":"shake"}' })
    assert.equal(shake.status, 400)
    assert.match(shake.body, /lock, unlock, siri/)
    assert.ok(f.wdaCalls.includes('lock'))
  } finally {
    await f.close()
  }
})

test('once WDA stops, the panel says to run ios_real_start_wda instead of streaming', async () => {
  const f = await realPanel()
  try {
    await f.panel.showRealDevice(IPHONE)
    await f.wda.stop()
    const status = JSON.parse((await call(f.port, '/api/status')).body) as { kind: string; running: boolean; error: string }
    assert.deepEqual([status.kind, status.running], ['real', false])
    assert.match(status.error, /run ios_real_start_wda/)
    const stream = await call(f.port, '/stream')
    assert.equal(stream.status, 409)
    assert.match(stream.body, /run ios_real_start_wda first/)
    await assert.rejects(f.panel.showRealDevice(IPHONE), /run ios_real_start_wda first/)
  } finally {
    await f.close()
  }
})
