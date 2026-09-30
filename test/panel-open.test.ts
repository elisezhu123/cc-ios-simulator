import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import { browserOpenCommand, PanelOpener, panelOpenMode, PREVIEW_CONFIGURATION } from '../src/panel-open.js'
import { rewriteHeaders, startPanelProxy } from '../src/panel/panel-proxy.js'
import { PanelServer } from '../src/panel/panel-server.js'
import { ScreenshotStore } from '../src/screenshot.js'
import { SimStreamSource } from '../src/stream-source.js'
import { fakeHost, fakeRealDevices, fakeSimctl, fakeWda, IPHONE } from './helpers/fakes.js'

test('the panel opens in the browser from the terminal and in the preview pane from Claude Code desktop', () => {
  assert.equal(panelOpenMode({}), 'browser')
  assert.equal(panelOpenMode({ CLAUDE_CODE_ENTRYPOINT: 'cli' }), 'browser')
  assert.equal(panelOpenMode({ CLAUDE_CODE_ENTRYPOINT: 'claude-desktop' }), 'preview')
  assert.equal(panelOpenMode({ CLAUDE_CODE_ENTRYPOINT: 'claude-desktop', IOS_SIM_OPEN_PANEL: 'none' }), 'none')
  assert.equal(panelOpenMode({ IOS_SIM_OPEN_PANEL: 'Preview' }), 'preview')
  assert.deepEqual(browserOpenCommand('darwin', 'http://127.0.0.1:3456/'), ['open', ['http://127.0.0.1:3456/']])
  assert.deepEqual(browserOpenCommand('linux', 'http://x/'), ['xdg-open', ['http://x/']])
  assert.equal(browserOpenCommand('aix', 'http://x/'), undefined)
})

test('PanelOpener opens the browser once; in the preview pane it hands Claude the launch configuration', () => {
  const runs: string[] = []
  const browser = new PanelOpener({ mode: 'browser', platform: 'darwin', serverScript: '/p/dist/server.js', stateFile: '/c/panel.json', run: (command, args) => runs.push(`${command} ${args.join(' ')}`) })
  assert.deepEqual(browser.hint('http://127.0.0.1:3456/'), {}, 'nothing opened yet')
  browser.afterStart('http://127.0.0.1:3456/')
  browser.afterStart('http://127.0.0.1:3456/')
  assert.deepEqual(runs, ['open http://127.0.0.1:3456/'])
  assert.match(String(browser.hint('http://127.0.0.1:3456/').opened), /default browser/)
  const preview = new PanelOpener({ mode: 'preview', platform: 'darwin', serverScript: '/p/dist/server.js', stateFile: '/c/panel.json', run: () => runs.push('unexpected') })
  preview.afterStart('http://127.0.0.1:3456/')
  assert.equal(runs.length, 1, 'the preview pane is never opened by launching a browser')
  const hint = preview.hint('http://127.0.0.1:3456/').openInClaude as { how: string; launchConfiguration: Record<string, unknown> }
  assert.match(hint.how, new RegExp(`preview_start with "${PREVIEW_CONFIGURATION}".*never stop the process that owns 127\\.0\\.0\\.1:3456`))
  assert.deepEqual(hint.launchConfiguration, {
    name: PREVIEW_CONFIGURATION,
    runtimeExecutable: 'node',
    runtimeArgs: ['/p/dist/server.js', '--panel-proxy', '--state', '/c/panel.json'],
    port: 3457,
    autoPort: true,
  })
  assert.deepEqual(new PanelOpener({ mode: 'none', platform: 'darwin', serverScript: '', stateFile: '' }).hint('http://x/'), {})
})

test('rewriteHeaders points Host, and Origin when sent, at the panel', () => {
  assert.deepEqual(rewriteHeaders({ host: 'localhost:51000', origin: 'http://localhost:51000', accept: '*/*' }, 3456),
    { host: '127.0.0.1:3456', origin: 'http://127.0.0.1:3456', accept: '*/*' })
  assert.equal(rewriteHeaders({ host: 'localhost:51000' }, 3456).origin, undefined)
})

test('the proxy serves the panel on its own port, fenced, and carries touches over the WebSocket', async () => {
  const stateFile = join(mkdtempSync(join(tmpdir(), 'ios-sim-state-')), 'panel.json')
  const proxy = await startPanelProxy({ port: 0, stateFile })
  const base = `http://localhost:${proxy.port}`
  // No panel yet: a waiting page that retries.
  const waiting = await fetch(`${base}/`)
  assert.equal(waiting.status, 503)
  assert.match(await waiting.text(), /not running yet.*ios_sim_panel/s)

  const wda = fakeWda({ running: IPHONE })
  const { host } = fakeHost({ device: 'BBB' })
  const { api: simctl } = fakeSimctl()
  const staticDir = mkdtempSync(join(tmpdir(), 'ios-sim-static-'))
  writeFileSync(join(staticDir, 'index.html'), '<!doctype html><title>panel</title>')
  for (const file of ['main.js', 'styles.css']) writeFileSync(join(staticDir, file), '')
  const panel = new PanelServer({
    staticDir,
    preferredPort: 0,
    attempts: 1,
    host,
    stream: new SimStreamSource(host),
    simctl,
    screenshots: new ScreenshotStore({ dir: mkdtempSync(join(tmpdir(), 'ios-sim-shots-')), takeScreenshot: simctl.takeScreenshot }),
    wda: wda.api,
    realDevices: fakeRealDevices({ devices: [IPHONE] }).api,
    stateFile,
  })
  try {
    const panelUrl = await panel.showRealDevice(IPHONE)
    assert.equal((JSON.parse(readFileSync(stateFile, 'utf8')) as { url: string }).url, panelUrl)
    const page = await fetch(`${base}/`)
    assert.equal(page.status, 200)
    assert.match(await page.text(), /<title>panel<\/title>/)
    const status = await (await fetch(`${base}/api/status`)).json() as { kind: string; deviceName: string }
    assert.deepEqual([status.kind, status.deviceName], ['real', 'Test iPhone'])
    const mutate = (origin: string): Promise<Response> => fetch(`${base}/api/device-action`, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'lock' }),
    })
    assert.equal((await mutate(base)).status, 200, 'our own origin is rewritten to the panel\'s')
    assert.equal((await mutate('http://evil.example')).status, 403, 'a foreign origin is refused by the proxy')
    // fetch cannot override Host; a DNS-rebinding request is made with node:http.
    const rebinding = await new Promise<number>((resolve, reject) => {
      request({ host: '127.0.0.1', port: proxy.port, path: '/', headers: { host: 'evil.example' } }, response => {
        response.resume()
        resolve(response.statusCode ?? 0)
      }).on('error', reject).end()
    })
    assert.equal(rebinding, 403)

    const socket = new WebSocket(`ws://localhost:${proxy.port}/ws`, { origin: base })
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve())
      socket.once('error', reject)
    })
    socket.send(Buffer.concat([Buffer.from([3]), Buffer.from(JSON.stringify({ type: 'begin', x: 0.5, y: 0.5 }))]))
    socket.send(Buffer.concat([Buffer.from([3]), Buffer.from(JSON.stringify({ type: 'end', x: 0.5, y: 0.5 }))]))
    await new Promise(resolve => setTimeout(resolve, 150))
    socket.close()
    assert.ok(wda.calls.includes('tap 201,437'), wda.calls.join(' | '))
    const refused = await new Promise<number>(resolve => {
      const foreign = new WebSocket(`ws://localhost:${proxy.port}/ws`, { origin: 'http://evil.example' })
      foreign.on('unexpected-response', (_request, response) => resolve(response.statusCode ?? 0))
      foreign.on('error', () => resolve(-1))
    })
    assert.equal(refused, 403)
  } finally {
    await panel.dispose()
    await proxy.close()
  }
  assert.equal(existsSync(stateFile), false, 'the state file goes away with the panel')
})
