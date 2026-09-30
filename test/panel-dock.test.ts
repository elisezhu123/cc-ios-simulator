import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deviceActionSpec, simulatorMenuItemScript } from '../src/device-actions.js'
import { PanelServer } from '../src/panel/panel-server.js'
import { Recorder } from '../src/recorder.js'
import { ScreenshotStore } from '../src/screenshot.js'
import { SimStreamSource } from '../src/stream-source.js'
import { fakeHost, fakeRealDevices, fakeRecordSpawn, fakeSimctl, fakeWda, IPHONE } from './helpers/fakes.js'

/** A panel over a streaming simulator (BBB) with a recorder and an iPhone running WDA. */
async function dockPanel() {
  const { host, calls: hostCalls } = fakeHost({ device: 'BBB' })
  const { api: simctl, calls: simctlCalls } = fakeSimctl()
  const staticDir = mkdtempSync(join(tmpdir(), 'ios-sim-static-'))
  for (const file of ['index.html', 'main.js', 'styles.css']) writeFileSync(join(staticDir, file), '')
  const panel = new PanelServer({
    staticDir,
    preferredPort: 0,
    attempts: 1,
    host,
    stream: new SimStreamSource(host),
    simctl,
    screenshots: new ScreenshotStore({ dir: mkdtempSync(join(tmpdir(), 'ios-sim-shots-')), takeScreenshot: simctl.takeScreenshot }),
    recorder: new Recorder({ dir: mkdtempSync(join(tmpdir(), 'ios-sim-rec-')), spawnRecord: fakeRecordSpawn().spawnRecord }),
    wda: fakeWda({ running: IPHONE }).api,
    realDevices: fakeRealDevices({ devices: [IPHONE] }).api,
  })
  const port = Number(new URL(await panel.ensureStarted()).port)
  const post = async (path: string, body: unknown = {}): Promise<{ status: number; body: Record<string, unknown> }> => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    return { status: response.status, body: await response.json() as Record<string, unknown> }
  }
  const status = async (): Promise<Record<string, unknown>> => await (await fetch(`http://127.0.0.1:${port}/api/status`)).json() as Record<string, unknown>
  return { panel, post, status, hostCalls, simctlCalls }
}

test('the dock records the shown simulator, sets its appearance, and refuses both on an iPhone', async () => {
  const f = await dockPanel()
  try {
    const started = await f.post('/api/record', { action: 'start' })
    assert.deepEqual([started.status, started.body.recording], [200, true])
    assert.equal((await f.status()).recording, true)
    const stopped = await f.post('/api/record', { action: 'stop' })
    assert.equal(stopped.body.recording, false)
    assert.match(String(stopped.body.path), /recording-BBB-.*\.mov$/)
    assert.equal((await f.post('/api/record', { action: 'pause' })).status, 400)
    assert.equal((await f.post('/api/appearance', { appearance: 'dark' })).status, 200)
    assert.deepEqual(f.simctlCalls, [['appearance', 'BBB', 'dark']])
    assert.equal((await f.post('/api/appearance', { appearance: 'sepia' })).status, 400)
    await f.panel.showRealDevice(IPHONE)
    const refused = await f.post('/api/record', { action: 'start' })
    assert.deepEqual([refused.status, refused.body.error], [400, 'recording works on simulators only'])
    assert.equal((await f.post('/api/shutdown')).status, 400)
  } finally {
    await f.panel.dispose()
  }
})

test('shut down stops the recording and the stream first; detach leaves the simulator running', async () => {
  const f = await dockPanel()
  try {
    await f.post('/api/record', { action: 'start' })
    const shut = await f.post('/api/shutdown')
    assert.equal(shut.status, 200)
    assert.deepEqual(f.simctlCalls, [['shutdown', 'BBB']])
    assert.ok(f.hostCalls.some(call => call[0] === 'stop'), 'the stream is stopped before the shutdown')
    const f2 = await dockPanel()
    try {
      assert.equal((await f2.post('/api/detach')).status, 200)
      assert.deepEqual(f2.simctlCalls, [], 'detach never shuts the simulator down')
      assert.ok(f2.hostCalls.some(call => call[0] === 'stop'))
      await f2.panel.showRealDevice(IPHONE)
      await f2.post('/api/detach')
      assert.equal((await f2.status()).kind, 'simulator', 'detaching an iPhone goes back to simulators')
    } finally {
      await f2.panel.dispose()
    }
  } finally {
    await f.panel.dispose()
  }
})

test('the on-screen keyboard and slow animations click Simulator menu items below Device', () => {
  assert.deepEqual(deviceActionSpec('toggle-keyboard').transport, { kind: 'menu', item: 'Toggle Software Keyboard', path: ['I/O', 'Keyboard'] })
  const keyboard = simulatorMenuItemScript('Toggle Software Keyboard', ['I/O', 'Keyboard'])
  assert.match(keyboard, /click menu item "Toggle Software Keyboard" of menu 1 of menu item "Keyboard" of menu 1 of menu bar item "I\/O" of menu bar 1/)
  assert.match(simulatorMenuItemScript('Slow Animations', ['Debug']), /click menu item "Slow Animations" of menu 1 of menu bar item "Debug" of menu bar 1/)
  assert.match(simulatorMenuItemScript('Shake'), /menu bar item "Device"/)
})
