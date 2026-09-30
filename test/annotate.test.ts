import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AnnotationStore } from '../src/annotations.js'
import type { ToolDeps } from '../src/deps.js'
import { PanelServer } from '../src/panel/panel-server.js'
import { ScreenshotStore } from '../src/screenshot.js'
import { SimStreamSource } from '../src/stream-source.js'
import { registerCoreTools } from '../src/tools/core.js'
import { fakeHost, fakeSimctl } from './helpers/fakes.js'
import { textOf, toolHarness } from './helpers/harness.js'
import { AnnotationDoc, arrowHead, drawShapes, isNegligible, markSizes, shapeFor, type DrawContext, type Shape } from '../src/panel/client/annotate.js'
import { tinyPng } from './helpers/png.js'

const RED = '#e5484d'

test('AnnotationDoc undoes and redoes every change, clear included; a new change drops the redo branch', () => {
  const doc = new AnnotationDoc()
  const a = shapeFor('rect', RED, 13, { x: 0, y: 0 }, { x: 10, y: 10 })
  const b = shapeFor('arrow', RED, 13, { x: 0, y: 0 }, { x: 50, y: 50 })
  doc.add(a)
  doc.add(b)
  doc.clear()
  assert.equal(doc.shapes.length, 0)
  doc.undo()
  assert.deepEqual(doc.shapes, [a, b])
  doc.undo()
  assert.deepEqual(doc.shapes, [a])
  doc.redo()
  assert.deepEqual(doc.shapes, [a, b])
  doc.undo()
  doc.add(b)
  assert.equal(doc.canRedo, false)
  doc.clear()
  doc.clear()
  doc.undo()
  assert.equal(doc.shapes.length, 2, 'clearing an empty doc adds no history step')
})

test('marks scale with the screenshot, clicks are dropped, and arrow barbs sit behind the tip', () => {
  assert.deepEqual(markSizes({ width: 1206, height: 2622 }), { stroke: 13, text: 58 })
  assert.deepEqual(markSizes({ width: 100, height: 100 }), { stroke: 2, text: 12 })
  assert.equal(isNegligible(shapeFor('line', RED, 13, { x: 5, y: 5 }, { x: 8, y: 5 }), 26), true)
  assert.equal(isNegligible(shapeFor('pen', RED, 13, { x: 5, y: 5 }, { x: 5, y: 5 }, [{ x: 5, y: 5 }]), 26), true)
  assert.equal(isNegligible({ kind: 'text', color: RED, size: 58, at: { x: 0, y: 0 }, text: '  ' }, 26), true)
  const [left, right] = arrowHead({ x: 0, y: 0 }, { x: 100, y: 0 }, 20)
  assert.ok(left.x < 100 && right.x < 100)
  assert.ok(Math.abs(left.y + right.y) < 1e-9, 'the barbs are symmetric about the shaft')
})

/** Records the drawing calls, rounded, so shapes can be checked without a canvas. */
function recorder(): { ctx: DrawContext; calls: string[] } {
  const calls: string[] = []
  const r = (value: number): number => Math.round(value * 100) / 100
  const ctx = {
    strokeStyle: '', fillStyle: '', lineWidth: 1, lineCap: 'butt', lineJoin: 'miter', font: '', textBaseline: 'alphabetic',
    save: () => {}, restore: () => {}, beginPath: () => {},
    moveTo: (x: number, y: number) => calls.push(`M ${r(x)},${r(y)}`),
    lineTo: (x: number, y: number) => calls.push(`L ${r(x)},${r(y)}`),
    stroke: () => calls.push(`stroke ${String(ctx.strokeStyle)} ${r(ctx.lineWidth)}`),
    strokeRect: (x: number, y: number, w: number, h: number) => calls.push(`rect ${r(x)},${r(y)} ${r(w)}x${r(h)}`),
    ellipse: (x: number, y: number, rx: number, ry: number) => calls.push(`ellipse ${r(x)},${r(y)} ${r(rx)}/${r(ry)}`),
    strokeText: (text: string) => calls.push(`outline ${text}`),
    fillText: (text: string, x: number, y: number) => calls.push(`text ${text} ${r(x)},${r(y)} ${ctx.font.split(' ')[1]}`),
  } as DrawContext
  return { ctx, calls }
}

test('drawShapes draws image-pixel shapes at the requested scale', () => {
  const { ctx, calls } = recorder()
  const shapes: Shape[] = [
    shapeFor('rect', RED, 10, { x: 100, y: 100 }, { x: 40, y: 20 }),
    shapeFor('ellipse', RED, 10, { x: 0, y: 0 }, { x: 200, y: 100 }),
    { kind: 'text', color: '#ffffff', size: 60, at: { x: 10, y: 20 }, text: '这里\nhere' },
  ]
  drawShapes(ctx, shapes, 0.5)
  assert.deepEqual(calls, [
    'rect 20,10 30x40',
    'ellipse 50,25 50/25',
    'stroke #e5484d 5',
    'outline 这里', 'text 这里 5,10 30px',
    'outline here', 'text here 5,46 30px',
  ])
})

test('AnnotationStore keeps PNGs with their device, newest first, tracks what Claude has seen, and prunes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ios-sim-annotations-'))
  const store = new AnnotationStore({ dir, keep: 2 })
  assert.throws(() => store.save(Buffer.from('not a png')), /not a PNG/)
  const first = store.save(tinyPng(1206, 2622), { udid: 'BBB', name: 'iPhone 17 Pro' })
  const second = store.save(tinyPng(10, 20))
  assert.deepEqual([first.id, first.width, first.height, first.device?.name], ['annotation-0', 1206, 2622, 'iPhone 17 Pro'])
  assert.deepEqual(store.list().map(record => record.id), ['annotation-1', 'annotation-0'])
  assert.equal(store.unseenCount(), 2)
  store.markSeen([second.id])
  assert.equal(store.unseenCount(), 1)
  store.save(tinyPng(10, 20))
  assert.deepEqual(store.list().map(record => record.id), ['annotation-2', 'annotation-1'])
  // A fresh store over the same folder continues the numbering and keeps the seen flags.
  const reopened = new AnnotationStore({ dir, keep: 2 })
  assert.equal(reopened.save(tinyPng(10, 20)).id, 'annotation-3')
  assert.equal(reopened.list().find(record => record.id === 'annotation-2')?.seen, false)
  writeFileSync(join(dir, 'annotation-9.png'), tinyPng(4, 4))
  assert.equal(reopened.list()[0]?.id, 'annotation-9', 'a PNG without a sidecar is still listed')
  assert.ok(readFileSync(join(dir, 'annotation-3.json'), 'utf8').includes('"seen":false'))
})

test('POST /api/annotations stores the PNG with the shown device; anything but a PNG data URL is refused', async () => {
  const { host } = fakeHost({ device: 'BBB' })
  const { api: simctl } = fakeSimctl()
  const staticDir = mkdtempSync(join(tmpdir(), 'ios-sim-static-'))
  for (const file of ['index.html', 'main.js', 'styles.css']) writeFileSync(join(staticDir, file), '')
  const annotations = new AnnotationStore({ dir: mkdtempSync(join(tmpdir(), 'ios-sim-annotations-')) })
  const panel = new PanelServer({
    staticDir,
    preferredPort: 0,
    attempts: 1,
    host,
    stream: new SimStreamSource(host),
    simctl,
    screenshots: new ScreenshotStore({ dir: mkdtempSync(join(tmpdir(), 'ios-sim-shots-')), takeScreenshot: simctl.takeScreenshot }),
    annotations,
  })
  const port = Number(new URL(await panel.ensureStarted()).port)
  const post = (body: unknown, origin = `http://127.0.0.1:${port}`): Promise<Response> => fetch(`http://127.0.0.1:${port}/api/annotations`, {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  try {
    const saved = await post({ image: `data:image/png;base64,${tinyPng(1206, 2622).toString('base64')}` })
    assert.equal(saved.status, 200)
    const body = await saved.json() as { id: string; url: string; width: number }
    assert.deepEqual([body.id, body.url, body.width], ['annotation-0', '/annotations/annotation-0.png', 1206])
    assert.deepEqual(annotations.list()[0]?.device, { udid: 'BBB', name: 'iPhone 17 Pro' })
    const served = await fetch(`http://127.0.0.1:${port}${body.url}`)
    assert.equal(served.headers.get('content-type'), 'image/png')
    assert.equal((await post({ image: 'data:image/jpeg;base64,AAAA' })).status, 400)
    assert.equal((await post({ image: `data:image/png;base64,${Buffer.from('nope').toString('base64')}` })).status, 400)
    assert.equal((await post({ image: 'x' }, 'http://evil.example')).status, 403)
    assert.equal((await fetch(`http://127.0.0.1:${port}/annotations/..%2Fx.png`)).status, 404)
  } finally {
    await panel.dispose()
  }
})

test('ios_sim_annotation returns the newest annotation as an image, marks it seen, and screenshots mention new ones', async () => {
  let annotations: AnnotationStore | undefined
  const h = await toolHarness((server, deps) => {
    annotations = deps.annotations as AnnotationStore
    // sips is macOS-only: keep the real store, fake the model JPEG.
    const store = deps.screenshots as ScreenshotStore
    const screenshots: ToolDeps['screenshots'] = {
      dir: store.dir,
      capture: (udid, signal) => store.capture(udid, signal),
      save: (udid, png) => store.save(udid, png),
      toModelImage: async () => ({ data: 'SlBFRw==', mimeType: 'image/jpeg', width: 471, height: 1024 }),
    }
    Object.assign(deps, { screenshots })
    registerCoreTools(server, deps)
  })
  assert.match(textOf(await h.call('ios_sim_annotation')), /has not annotated anything yet/)
  annotations!.save(tinyPng(1206, 2622), { udid: 'BBB', name: 'iPhone 17 Pro' })
  annotations!.save(tinyPng(10, 20))
  const shot = h.json(await h.call('ios_sim_screenshot', { udid: 'BBB' })) as { userAnnotations: string }
  assert.match(shot.userAnnotations, /2 annotated screenshots.*ios_sim_annotation/)
  const newest = await h.call('ios_sim_annotation')
  assert.equal(newest.content[1]?.type, 'image')
  const newestBody = h.json(newest) as { id: string; unseen: number }
  assert.deepEqual([newestBody.id, newestBody.unseen], ['annotation-1', 1])
  const older = h.json(await h.call('ios_sim_annotation', { index: 1 })) as { device: { name: string }; width: number; unseen: number }
  assert.deepEqual([older.device.name, older.width, older.unseen], ['iPhone 17 Pro', 1206, 0])
  const listed = h.json(await h.call('ios_sim_annotation', { list: true })) as { count: number; annotations: Array<{ seen: boolean }> }
  assert.deepEqual([listed.count, listed.annotations.every(record => record.seen)], [2, true])
  assert.match(textOf(await h.call('ios_sim_annotation', { index: 5 })), /only 2 annotations/)
  assert.equal((h.json(await h.call('ios_sim_screenshot', { udid: 'BBB' })) as { userAnnotations?: string }).userAnnotations, undefined)
  await h.close()
})
