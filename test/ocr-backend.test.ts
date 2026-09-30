import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  defaultOcrSourcePath,
  filterOcrItems,
  OcrHelper,
  parseOcrOutput,
  pixelRectToNormalizedCenter,
  pixelRectToPoints,
} from '../src/ocr-backend.js'

test('the bundled Swift helper sits where the backend looks for it', () => {
  assert.equal(existsSync(defaultOcrSourcePath()), true)
  assert.match(readFileSync(defaultOcrSourcePath(), 'utf8'), /VNRecognizeTextRequest/)
})

test('parseOcrOutput drops invalid items, collapses exact duplicates and sorts by confidence', () => {
  const items = parseOcrOutput(JSON.stringify({
    count: 6,
    items: [
      { text: '设置', confidence: 0.45, x: 10, y: 20, w: 60, h: 30 },
      { text: 'General', confidence: 0.98, x: 60, y: 214, w: 120, h: 24 },
      { text: 'General', confidence: 0.98, x: 60, y: 214, w: 120, h: 24 },
      { text: '  ', confidence: 0.9, x: 0, y: 0, w: 1, h: 1 },
      { text: 'Bad', confidence: 1.4, x: 0, y: 0, w: 1, h: 1 },
      { text: 'Neg', confidence: 0.9, x: -1, y: 0, w: 1, h: 1 },
    ],
  }))
  assert.deepEqual(items.map(item => item.text), ['General', '设置'])
  assert.throws(() => parseOcrOutput('oops'), /non-JSON/)
  assert.throws(() => parseOcrOutput('{"count":0}'), /missing items array/)
  assert.deepEqual(filterOcrItems(items, 'gen', 0.5).map(item => item.text), ['General'])
  assert.deepEqual(filterOcrItems(items, undefined, 0.5).map(item => item.text), ['General'])
})

test('pixel boxes convert to points per axis and to a normalized center', () => {
  const pixels = { width: 1206, height: 2622 }
  const points = { width: 402, height: 874 }
  assert.deepEqual(pixelRectToPoints({ x: 60, y: 600, w: 300, h: 90 }, pixels, points), { x: 20, y: 200, w: 100, h: 30 })
  assert.deepEqual(pixelRectToNormalizedCenter({ x: 0, y: 0, w: 1206, h: 2622 }, pixels), { x: 0.5, y: 0.5 })
  assert.throws(() => pixelRectToPoints({ x: 0, y: 0, w: 1, h: 1 }, { width: 0, height: 1 }, points), /finite positive size/)
})

test('OcrHelper is unavailable off macOS', async () => {
  const helper = new OcrHelper({ cacheDir: mkdtempSync(join(tmpdir(), 'ios-sim-ocr-')), platform: 'linux', env: {} })
  assert.match(helper.resolve().reason ?? '', /only runs on macOS/)
  await assert.rejects(helper.recognize('/tmp/x.png'), /Vision OCR helper is unavailable.*xcode-select --install/)
})

test('OcrHelper without swiftc says how to get it; a bad IOS_SIM_SWIFTC fails loudly', () => {
  const cacheDir = mkdtempSync(join(tmpdir(), 'ios-sim-ocr-'))
  const bare = new OcrHelper({ cacheDir, platform: 'darwin', env: { PATH: '' } }).resolve()
  if (!bare.available && bare.compilable !== true) assert.match(bare.reason ?? '', /swiftc/)
  const bad = new OcrHelper({ cacheDir, platform: 'darwin', env: { PATH: '', IOS_SIM_SWIFTC: '/nope/swiftc' } }).resolve()
  assert.match(bad.reason ?? '', /IOS_SIM_SWIFTC points at a missing or non-executable file/)
})

test('OcrHelper compiles once into a source-keyed slot, records its digest, and runs the helper', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ios-sim-ocr-'))
  const cacheDir = join(dir, 'cache')
  // A swiftc stand-in: "compiles" by writing a helper script to the -o path.
  const swiftc = join(dir, 'swiftc')
  const compiles = join(dir, 'compiles.log')
  const helperScript = [
    '#!/bin/sh',
    'if [ "$#" -eq 0 ]; then echo "usage" >&2; exit 2; fi',
    'echo \'{"count":1,"items":[{"text":"Continue","confidence":0.91,"x":100,"y":2000,"w":300,"h":60}]}\'',
  ].join('\n')
  writeFileSync(swiftc, [
    '#!/bin/sh',
    `echo compiled >> '${compiles}'`,
    'out=""; while [ "$#" -gt 0 ]; do if [ "$1" = "-o" ]; then out="$2"; fi; shift; done',
    `cat > "$out" <<'SCRIPT'\n${helperScript}\nSCRIPT`,
    'chmod +x "$out"',
  ].join('\n'))
  chmodSync(swiftc, 0o755)
  const helper = new OcrHelper({ cacheDir, platform: 'darwin', env: { PATH: '', IOS_SIM_SWIFTC: swiftc } })
  assert.equal(helper.resolve().compilable, true)
  const [a, b] = await Promise.all([helper.recognize(join(dir, 'shot.png')), helper.recognize(join(dir, 'shot.png'))])
  assert.deepEqual(a, [{ text: 'Continue', confidence: 0.91, rect: { x: 100, y: 2000, w: 300, h: 60 } }])
  assert.deepEqual(b, a)
  assert.equal(readFileSync(compiles, 'utf8').trim().split('\n').length, 1)
  const [slot] = readdirSync(cacheDir).filter(name => !name.startsWith('.'))
  assert.match(slot ?? '', /^[0-9a-f]{16}$/)
  assert.equal(existsSync(join(cacheDir, slot!, '.ios-simulator-ocr.sha256')), true)
  assert.equal(helper.resolve().available, true)

  // A corrupted artifact fails its digest check and is rebuilt.
  writeFileSync(join(cacheDir, slot!, 'ocr'), '#!/bin/sh\necho tampered\n')
  assert.equal(helper.resolve().available, false)
  await helper.recognize(join(dir, 'shot.png'))
  assert.equal(readFileSync(compiles, 'utf8').trim().split('\n').length, 2)
})
