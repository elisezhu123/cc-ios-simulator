import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { ToolDeps } from '../src/deps.js'
import type { OcrItem } from '../src/ocr-backend.js'
import { ScreenshotStore } from '../src/screenshot.js'
import { registerUiTools } from '../src/tools/ui.js'
import type { AxeElement } from '../src/uitree-backend.js'
import { fakeAxe, fakeOcr } from './helpers/fakes.js'
import { textOf, toolHarness, type Harness, type HarnessOptions } from './helpers/harness.js'
import { feedTree, settingsTree } from './helpers/ui-fixtures.js'

/** Screenshots are 1206×2622 px and the fixtures 402×874 pt: 3 px per point. */
const ocrItem = (text: string, confidence: number, pointRect: { x: number; y: number; w: number; h: number }): OcrItem => ({
  text,
  confidence,
  rect: { x: pointRect.x * 3, y: pointRect.y * 3, w: pointRect.w * 3, h: pointRect.h * 3 },
})

interface UiHarness extends Harness {
  taps: Array<{ udid: string; x: number; y: number }>
  axeReads(): number
  ocrPaths: string[]
}

async function uiHarness(
  options: { trees?: AxeElement[][]; ocr?: OcrItem[][]; axeAvailable?: boolean } & HarnessOptions = {},
): Promise<UiHarness> {
  const axe = fakeAxe(options.trees ?? [settingsTree()], { available: options.axeAvailable })
  const ocr = fakeOcr(options.ocr ?? [[]])
  let store: ScreenshotStore | undefined
  const h = await toolHarness((server, deps) => {
    // sips is macOS-only: keep the real capture, fake the model JPEG.
    store = deps.screenshots as ScreenshotStore
    const screenshots: ToolDeps['screenshots'] = {
      dir: store.dir,
      capture: (udid, signal) => store!.capture(udid, signal),
      toModelImage: async capture => ({ data: 'SlBFRw==', mimeType: 'image/jpeg', width: Math.round((capture.width ?? 0) / 2.5), height: Math.round((capture.height ?? 0) / 2.5) }),
    }
    Object.assign(deps, { axe: axe.api, ocr: ocr.api, screenshots })
    registerUiTools(server, deps)
  }, options)
  return { ...h, taps: axe.taps, axeReads: axe.reads, ocrPaths: ocr.paths }
}

const imageCount = (result: CallToolResult): number => result.content.filter(block => block.type === 'image').length

test('ios_sim_ui_tree returns the compact tree with the device and the off-screen count', async () => {
  const h = await uiHarness()
  const body = h.json(await h.call('ios_sim_ui_tree')) as { device: { udid: string }; size: object; omittedOffscreen: number; nodeCount: number; tree: Array<{ label: string }> }
  assert.equal(body.device.udid, 'BBB')
  assert.deepEqual(body.size, { width: 402, height: 874 })
  assert.equal(body.omittedOffscreen, 2)
  assert.equal(body.tree[0]!.label, 'Settings')
  const filtered = h.json(await h.call('ios_sim_ui_tree', { filter: 'general' })) as { nodeCount: number }
  assert.equal(filtered.nodeCount, 3) // the app root, the General cell and its text; General Info is off-screen
  await h.close()
})

test('the UI tools never act on a device that is not booted', async () => {
  const h = await uiHarness()
  const result = await h.call('ios_sim_ui_tree', { udid: 'AAA' })
  assert.equal(result.isError, true)
  assert.match(textOf(result), /^ios_sim_ui_tree: iPhone 16 is Shutdown — boot it first/)
  await h.close()
})

test('ios_sim_tap_element taps the element center in points and returns the effect screenshot', async () => {
  const h = await uiHarness({ host: { device: 'BBB' } })
  const result = await h.call('ios_sim_tap_element', { label: 'General' })
  assert.equal(result.isError, undefined)
  assert.deepEqual(h.taps, [{ udid: 'BBB', x: 201, y: 226 }])
  const body = h.json(result) as { element: { type: string; identifier: string }; matchedBy: string; screenshot: { width: number; image: { width: number } } }
  assert.equal(body.element.type, 'Cell')
  assert.equal(body.element.identifier, 'com.apple.settings.general')
  assert.equal(body.matchedBy, 'exact')
  assert.equal(body.screenshot.width, 1206)
  assert.equal(imageCount(result), 1)
  await h.close()
})

test('ios_sim_tap_element confirms the outcome with expect_text and skips the image on screenshot:false', async () => {
  const h = await uiHarness({ host: { device: 'BBB' }, ocr: [[], [ocrItem('About', 0.95, { x: 20, y: 200, w: 80, h: 20 })]] })
  const result = await h.call('ios_sim_tap_element', { label: 'General', expect_text: 'About', screenshot: false })
  const body = h.json(result) as { expected: { text: string; mode: string; matched: boolean } }
  assert.deepEqual([body.expected.text, body.expected.mode, body.expected.matched], ['About', 'appear', true])
  assert.equal(h.ocrPaths.length, 2)
  assert.equal(imageCount(result), 0)
  await h.close()
})

test('ios_sim_tap_element reports ambiguity and refusals as tool errors without tapping', async () => {
  const h = await uiHarness({ host: { device: 'BBB' } })
  const ambiguous = await h.call('ios_sim_tap_element', { label: 'edit' })
  assert.equal(ambiguous.isError, true)
  assert.match(textOf(ambiguous), /^ios_sim_tap_element: 2 elements match label "edit"/)
  const disabled = await h.call('ios_sim_tap_element', { label: 'Privacy & Security' })
  assert.match(textOf(disabled), /disabled/)
  const both = await h.call('ios_sim_tap_element', { label: 'General', expect_text: 'a', expect_gone: 'b' })
  assert.match(textOf(both), /not both/)
  assert.deepEqual(h.taps, [])
  await h.close()
})

test('ios_sim_find_text returns rects in points and caches the point size per device', async () => {
  const h = await uiHarness({
    host: { device: 'BBB' },
    ocr: [[ocrItem('General', 0.98, { x: 60, y: 214, w: 120, h: 24 }), ocrItem('设置', 0.4, { x: 16, y: 60, w: 60, h: 30 }), ocrItem('noise', 0.1, { x: 0, y: 0, w: 5, h: 5 })]],
  })
  const body = h.json(await h.call('ios_sim_find_text')) as { size: object; count: number; items: Array<{ text: string; rect: object }>; note?: string }
  assert.deepEqual(body.size, { width: 402, height: 874 })
  assert.deepEqual(body.items.map(item => item.text), ['General', '设置'])
  assert.deepEqual(body.items[0]!.rect, { x: 60, y: 214, w: 120, h: 24 })
  assert.equal(body.note, undefined)
  const filtered = h.json(await h.call('ios_sim_find_text', { query: '设' })) as { count: number }
  assert.equal(filtered.count, 1)
  assert.equal(h.axeReads(), 1)
  await h.close()
})

test('ios_sim_find_text still works without AXe, in image pixels with a note', async () => {
  const h = await uiHarness({ host: { device: 'BBB' }, axeAvailable: false, ocr: [[ocrItem('OK', 0.9, { x: 10, y: 10, w: 10, h: 10 })]] })
  const body = h.json(await h.call('ios_sim_find_text')) as { size: object; items: Array<{ rect: object }>; note: string }
  assert.deepEqual(body.size, { width: 1206, height: 2622 })
  assert.deepEqual(body.items[0]!.rect, { x: 30, y: 30, w: 30, h: 30 })
  assert.match(body.note, /image pixels instead of points/)
  await h.close()
})

test('ios_sim_wait_for answers a timeout with matched:false and a match with the item in points', async () => {
  const h = await uiHarness({ host: { device: 'BBB' }, ocr: [[], [], [ocrItem('Done', 0.9, { x: 100, y: 400, w: 60, h: 20 })]] })
  const done = h.json(await h.call('ios_sim_wait_for', { text: 'done' })) as { matched: boolean; item: { text: string; rect: object } }
  assert.equal(done.matched, true)
  assert.deepEqual(done.item, { text: 'Done', confidence: 0.9, rect: { x: 100, y: 400, w: 60, h: 20 } })
  const never = h.json(await h.call('ios_sim_wait_for', { text: 'Spinner', mode: 'appear', timeout_ms: 0 })) as { matched: boolean; item?: unknown }
  assert.deepEqual([never.matched, never.item], [false, undefined])
  await h.close()
})

test('ios_sim_tap_text taps the normalized text center through serve-sim', async () => {
  const h = await uiHarness({ host: { device: 'BBB' }, ocr: [[ocrItem('Continue', 0.9, { x: 101, y: 700, w: 200, h: 44 })]] })
  const result = await h.call('ios_sim_tap_text', { query: 'Continue', screenshot: false })
  assert.equal(result.isError, undefined)
  const body = h.json(result) as { text: string; rect: object; center: object; tap: { x: number; y: number } }
  assert.deepEqual(body.rect, { x: 101, y: 700, w: 200, h: 44 })
  assert.deepEqual(body.center, { x: 201, y: 722 })
  assert.deepEqual(body.tap, { x: 0.5, y: 0.8261 })
  assert.deepEqual(h.hostCalls.filter(call => call[0] === 'control').map(call => call.join(' ')), ['control tap -d BBB -- 0.5 0.8261'])
  await h.close()
})

test('ios_sim_tap_text names a below-threshold match and needs serve-sim', async () => {
  const h = await uiHarness({ host: { device: 'BBB' }, ocr: [[ocrItem('继续', 0.35, { x: 10, y: 10, w: 40, h: 20 })]] })
  const low = await h.call('ios_sim_tap_text', { query: '继续', min_confidence: 0.5 })
  assert.match(textOf(low), /IS on the current screen, but its OCR confidence 0.35/)
  await h.close()
  const noStream = await uiHarness({ host: { available: false } })
  assert.match(textOf(await noStream.call('ios_sim_tap_text', { query: 'x' })), /serve-sim is unavailable/)
  await noStream.close()
})

test('ios_sim_ui_rows lists rows with parsed counters, and explains an empty result', async () => {
  const h = await uiHarness({ trees: [feedTree()] })
  const body = h.json(await h.call('ios_sim_ui_rows')) as { rowCount: number; rows: Array<{ index: number; counts: Array<{ key: string; value: number }> }> }
  assert.equal(body.rowCount, 3)
  assert.deepEqual(body.rows[2]!.counts, [{ key: '回复', value: 1200 }, { key: '喜欢', value: 32000 }])
  await h.close()
  const empty = await uiHarness({ trees: [settingsTree().map(root => ({ ...root, children: root.children.filter(child => child.type !== 'Cell') }))] })
  const none = empty.json(await empty.call('ios_sim_ui_rows')) as { rowCount: number; hint: string }
  assert.equal(none.rowCount, 0)
  assert.match(none.hint, /No repeated rows detected/)
  await empty.close()
})

test('ios_sim_tap_row taps inside the row and verifies the counter moved by delta', async () => {
  const h = await uiHarness({ trees: [feedTree([[57, 18], [3, 1]]), feedTree([[57, 19], [3, 1]])] })
  const result = await h.call('ios_sim_tap_row', { row: 0, x: 0.9, expect_count: { key: '喜欢', delta: 1 }, screenshot: false })
  const body = h.json(result) as { tap: object; countCheck: { verified: boolean; before: number; after: number } }
  assert.deepEqual(h.taps, [{ udid: 'BBB', x: 361.8, y: 175 }])
  assert.deepEqual(body.tap, { x: 361.8, y: 175 })
  assert.deepEqual([body.countCheck.verified, body.countCheck.before, body.countCheck.after], [true, 18, 19])
  await h.close()
})

test('ios_sim_tap_row refuses an unknown counter key and an out-of-range row before tapping', async () => {
  const h = await uiHarness({ trees: [feedTree()] })
  assert.match(textOf(await h.call('ios_sim_tap_row', { row: 0, expect_count: { key: 'likes', delta: 1 } })), /cannot verify a "likes" change/)
  assert.match(textOf(await h.call('ios_sim_tap_row', { row: 7 })), /row 7 does not exist/)
  assert.match(textOf(await h.call('ios_sim_tap_row', { row: 0, expect_count: { key: '喜欢', delta: 2 } })), /\+1 or -1/)
  assert.deepEqual(h.taps, [])
  await h.close()
})
