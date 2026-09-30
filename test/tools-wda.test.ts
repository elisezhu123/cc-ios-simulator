import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ToolDeps } from '../src/deps.js'
import type { OcrItem } from '../src/ocr-backend.js'
import { ScreenshotStore } from '../src/screenshot.js'
import { registerCoreTools } from '../src/tools/core.js'
import { registerUiTools } from '../src/tools/ui.js'
import { fakeAxe, fakeOcr, fakeRealDevices, fakeWda, IPHONE } from './helpers/fakes.js'
import { textOf, toolHarness } from './helpers/harness.js'

/** A Settings screen as WDA's /source returns it (points; the app window is 402×874). */
const SETTINGS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<XCUIElementTypeApplication type="XCUIElementTypeApplication" name="Settings" label="Settings" enabled="true" visible="true" x="0" y="0" width="402" height="874">
  <XCUIElementTypeCell type="XCUIElementTypeCell" name="com.apple.settings.general" label="General" enabled="true" visible="true" x="16" y="300" width="370" height="52"/>
  <XCUIElementTypeCell type="XCUIElementTypeCell" name="com.apple.settings.privacy" label="Privacy &amp; Security" enabled="true" visible="true" x="16" y="352" width="370" height="52"/>
</XCUIElementTypeApplication>`

async function wdaHarness(options: { sources?: string[]; ocr?: OcrItem[][]; notRunning?: string } = {}) {
  const wda = fakeWda({ sources: options.sources ?? [SETTINGS_XML], ...(options.notRunning === undefined ? {} : { notRunning: options.notRunning }) })
  const axe = fakeAxe()
  const ocr = fakeOcr(options.ocr ?? [[]])
  const register = (server: McpServer, deps: ToolDeps): void => {
    // sips is macOS-only: keep the real store, fake the model JPEG.
    const store = deps.screenshots as ScreenshotStore
    const screenshots: ToolDeps['screenshots'] = {
      dir: store.dir,
      capture: (udid, signal) => store.capture(udid, signal),
      save: (udid, png) => store.save(udid, png),
      toModelImage: async capture => ({ data: 'SlBFRw==', mimeType: 'image/jpeg', width: Math.round((capture.width ?? 0) / 2.5), height: Math.round((capture.height ?? 0) / 2.5) }),
    }
    Object.assign(deps, { screenshots, axe: axe.api, ocr: ocr.api })
    registerCoreTools(server, deps)
    registerUiTools(server, deps)
  }
  const h = await toolHarness(register, { deps: { platform: 'darwin', realDevices: fakeRealDevices({ devices: [IPHONE] }).api, wda: wda.api } })
  return { ...h, wdaCalls: wda.calls, axeTaps: axe.taps }
}

test('ios_real_start_wda starts WDA on an iPhone, refuses a simulator, and reports status and stop', async () => {
  const h = await wdaHarness()
  const started = h.json(await h.call('ios_real_start_wda', { udid: 'Test iPhone' })) as { phase: string; device: { udid: string } }
  assert.deepEqual([started.phase, started.device.udid], ['running', IPHONE.udid])
  assert.deepEqual(h.wdaCalls, [`start ${IPHONE.udid}`])
  assert.equal((h.json(await h.call('ios_real_start_wda', { action: 'status' })) as { phase: string }).phase, 'running')
  assert.deepEqual(h.json(await h.call('ios_real_start_wda', { action: 'stop' })), { stopped: true, device: { udid: IPHONE.udid, name: 'Test iPhone' } })
  assert.match(textOf(await h.call('ios_real_start_wda', { udid: 'iPhone 17 Pro' })), /is a simulator — simulators need no WebDriverAgent/)
  assert.match(textOf(await h.call('ios_real_start_wda', {})), /pass udid/)
  await h.close()
})

test('ios_sim_screenshot on an iPhone saves the WDA screenshot and returns the image', async () => {
  const h = await wdaHarness()
  const result = await h.call('ios_sim_screenshot', { udid: IPHONE.hardwareUdid! })
  const body = h.json(result) as { path: string; width: number; height: number; image: { width: number }; device: { udid: string; runtime: string } }
  assert.deepEqual([body.width, body.height, body.image.width], [1206, 2622, 482])
  assert.match(body.path, /screenshot-.*\.png$/)
  assert.deepEqual([body.device.udid, body.device.runtime], [IPHONE.udid, 'iOS 26.0'])
  assert.equal(result.content[1]?.type, 'image')
  await h.close()
})

test('ios_sim_interact on an iPhone taps in window points, types any text and maps buttons', async () => {
  const h = await wdaHarness()
  const tap = h.json(await h.call('ios_sim_interact', { udid: 'Test iPhone', action: 'tap', x: 0.5, y: 0.5, screenshot: false })) as { points: { x: number; y: number } }
  assert.deepEqual(tap.points, { x: 201, y: 437 })
  await h.call('ios_sim_interact', { udid: 'Test iPhone', action: 'type', text: '你好', screenshot: false })
  await h.call('ios_sim_interact', { udid: 'Test iPhone', action: 'button', name: 'volume-down', screenshot: false })
  await h.call('ios_sim_interact', { udid: 'Test iPhone', action: 'device_action', name: 'unlock', screenshot: false })
  await h.call('ios_sim_interact', { udid: 'Test iPhone', action: 'rotate', orientation: 'landscape_left', screenshot: false })
  assert.deepEqual(h.wdaCalls, ['tap 201,437', 'type 你好', 'button volumeDown', 'unlock', 'orientation LANDSCAPE'])
  assert.match(textOf(await h.call('ios_sim_interact', { udid: 'Test iPhone', action: 'device_action', name: 'shake' })), /^ios_sim_interact: on a real device device_action supports lock, unlock, siri/)
  const withShot = await h.call('ios_sim_interact', { udid: 'Test iPhone', action: 'scroll', direction: 'down' })
  assert.equal(withShot.content[1]?.type, 'image')
  assert.match(h.wdaCalls.at(-2)!, /^drag 201,[\d.]+ -> 201,[\d.]+ 0\.3s$/)
  assert.equal(h.wdaCalls.at(-1), 'screenshot')
  await h.close()
})

test('the UI tools read the WDA tree and tap elements and rows on an iPhone, never through AXe', async () => {
  const h = await wdaHarness()
  const tree = h.json(await h.call('ios_sim_ui_tree', { udid: 'Test iPhone' })) as { snapshotDepth: number; tree: Array<{ children?: Array<{ label: string }> }> }
  assert.equal(tree.snapshotDepth, 15)
  assert.deepEqual(tree.tree[0]!.children!.map(child => child.label), ['General', 'Privacy & Security'])
  const tapped = h.json(await h.call('ios_sim_tap_element', { udid: 'Test iPhone', label: 'General', screenshot: false })) as { center: { x: number; y: number } }
  assert.deepEqual(tapped.center, { x: 201, y: 326 })
  assert.ok(h.wdaCalls.includes('tap 201,326'))
  await h.call('ios_sim_ui_rows', { udid: 'Test iPhone' })
  assert.ok(h.wdaCalls.includes('depth 60'), 'rows read WDA 60 levels deep')
  assert.deepEqual(h.axeTaps, [])
  await h.close()
})

test('OCR tools on an iPhone report points from the WDA window size and tap through WDA', async () => {
  // WDA screenshots are 1206×2622 px for a 402×874 pt window: 3 px per point.
  const item: OcrItem = { text: '继续', confidence: 0.9, rect: { x: 300, y: 1500, w: 300, h: 90 } }
  const h = await wdaHarness({ ocr: [[item]] })
  const found = h.json(await h.call('ios_sim_find_text', { udid: 'Test iPhone' })) as { size: { width: number }; items: Array<{ rect: unknown }> }
  assert.equal(found.size.width, 402)
  assert.deepEqual(found.items[0]!.rect, { x: 100, y: 500, w: 100, h: 30 })
  const tapped = h.json(await h.call('ios_sim_tap_text', { udid: 'Test iPhone', query: '继续', screenshot: false })) as { center: { x: number; y: number } }
  assert.deepEqual(tapped.center, { x: 150, y: 515 })
  assert.ok(h.wdaCalls.includes('tap 150,515'))
  await h.close()
})

test('without a running WDA the real-device tools say to run ios_real_start_wda', async () => {
  const h = await wdaHarness({ notRunning: 'WebDriverAgent is not running on "Test iPhone" — run ios_real_start_wda first (a cold build can take minutes)' })
  for (const tool of ['ios_sim_screenshot', 'ios_sim_find_text', 'ios_sim_tap_row'] as const) {
    const args = tool === 'ios_sim_tap_row' ? { udid: 'Test iPhone', row: 0 } : { udid: 'Test iPhone' }
    assert.match(textOf(await h.call(tool, args)), new RegExp(`^${tool}: WebDriverAgent is not running.*ios_real_start_wda first`))
  }
  await h.close()
})

test('ios_sim_panel shows an iPhone once WDA runs on it, and says to start WDA before that', async () => {
  const h = await wdaHarness()
  assert.match(textOf(await h.call('ios_sim_panel', { udid: 'Test iPhone' })), /^ios_sim_panel: WebDriverAgent is not running on "Test iPhone" — run ios_real_start_wda first/)
  await h.call('ios_real_start_wda', { udid: 'Test iPhone' })
  const body = h.json(await h.call('ios_sim_panel', { udid: 'Test iPhone' })) as { panelUrl: string; device: { udid: string }; hint: string }
  assert.deepEqual([body.panelUrl, body.device.udid], ['http://127.0.0.1:3999/', IPHONE.udid])
  assert.match(body.hint, /taps and drags in it go to the phone/)
  await h.close()
})
