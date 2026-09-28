import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isScreenshotFileName, jpegSize, readPngSize, ScreenshotStore } from '../src/screenshot.js'
import { tinyPng } from './helpers/png.js'

function newStore(keep = 100, size: [number, number] = [1206, 2622]): { store: ScreenshotStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'ios-sim-shots-'))
  const store = new ScreenshotStore({
    dir,
    keep,
    takeScreenshot: async (_udid, path) => { writeFileSync(path, tinyPng(size[0], size[1])) },
  })
  return { store, dir }
}

test('capture writes numbered PNGs per device and reports their size', async () => {
  const { store } = newStore()
  const first = await store.capture('BBB-1')
  const second = await store.capture('BBB-1')
  assert.match(first.path, /screenshot-BBB-1-0\.png$/)
  assert.match(second.path, /screenshot-BBB-1-1\.png$/)
  assert.deepEqual({ width: first.width, height: first.height }, { width: 1206, height: 2622 })
  assert.ok(first.bytes > 0)
})

test('capture prunes the oldest screenshots beyond the keep limit', async () => {
  const { store, dir } = newStore(3)
  for (let index = 0; index < 5; index += 1) await store.capture('X')
  assert.deepEqual(readdirSync(dir).filter(isScreenshotFileName).sort(), [
    'screenshot-X-2.png',
    'screenshot-X-3.png',
    'screenshot-X-4.png',
  ])
})

test('toModelImage returns a JPEG whose long edge is at most 1024 and cleans up', async () => {
  const { store } = newStore()
  const shot = await store.capture('Y')
  const image = await store.toModelImage(shot)
  assert.equal(image.mimeType, 'image/jpeg')
  assert.deepEqual({ width: image.width, height: image.height }, { width: 471, height: 1024 })
  assert.deepEqual(jpegSize(Buffer.from(image.data, 'base64')), { width: 471, height: 1024 })
  assert.equal(existsSync(shot.path.replace(/\.png$/u, '.model.jpg')), false)
})

test('toModelImage keeps small screenshots at their own size', async () => {
  const { store } = newStore(100, [300, 400])
  const image = await store.toModelImage(await store.capture('W'))
  assert.deepEqual({ width: image.width, height: image.height }, { width: 300, height: 400 })
})

test('readPngSize reads IHDR and isScreenshotFileName only accepts cache names', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ios-sim-png-'))
  const path = join(dir, 'a.png')
  writeFileSync(path, tinyPng(5, 9))
  assert.deepEqual(readPngSize(path), { width: 5, height: 9 })
  assert.equal(isScreenshotFileName('screenshot-ABC-12.png'), true)
  for (const bad of ['../x.png', 'screenshot-A-1.png/..', 'screenshot-A-1.jpg', 'x.png', 'screenshot-../a-1.png']) {
    assert.equal(isScreenshotFileName(bad), false, bad)
  }
})
