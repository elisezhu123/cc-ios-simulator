import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pngDimensionsFromBase64, SimStreamSource } from '../src/stream-source.js'
import { fakeHost } from './helpers/fakes.js'
import { tinyPng } from './helpers/png.js'

test('SimStreamSource routes control through serve-sim for the streamed device', async () => {
  const { host, calls } = fakeHost({ device: 'BBB' })
  const source = new SimStreamSource(host)
  await source.control.tap(0.25, 0.75)
  await source.control.button()
  await source.control.rotate?.('landscape_left')
  await source.control.deviceAction?.('lock')
  assert.deepEqual(calls.filter(call => call[0] === 'control'), [
    ['control', 'tap', '0.25', '0.75', '-d', 'BBB'],
    ['control', 'button', 'home', '-d', 'BBB'],
    ['control', 'rotate', 'landscape_left', '-d', 'BBB'],
    ['control', 'button', 'lock', '-d', 'BBB'],
  ])
  await assert.rejects(source.control.tap(2, 0), /normalized 0\.\.1/)
})

test('pngDimensionsFromBase64 reads the IHDR size', () => {
  assert.deepEqual(pngDimensionsFromBase64(tinyPng(3, 7).toString('base64')), { width: 3, height: 7 })
})
