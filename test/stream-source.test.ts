import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pngDimensionsFromBase64, SimStreamSource } from '../src/stream-source.js'
import { fakeHost } from './helpers/fakes.js'
import { tinyPng } from './helpers/png.js'

test('SimStreamSource routes control through serve-sim for the streamed device, positionals after --', async () => {
  const { host, calls } = fakeHost({ device: 'BBB' })
  const source = new SimStreamSource(host)
  await source.control.tap(0.25, 0.75)
  await source.control.button()
  await source.control.rotate?.('landscape_left')
  await source.control.deviceAction?.('lock')
  await source.control.type('--file=x')
  await source.control.drag({ fromX: 0.1, fromY: 0.2, toX: 0.3, toY: 0.4, duration: 0 })
  assert.deepEqual(calls.filter(call => call[0] === 'control'), [
    ['control', 'tap', '-d', 'BBB', '--', '0.25', '0.75'],
    ['control', 'button', '-d', 'BBB', '--', 'home'],
    ['control', 'rotate', '-d', 'BBB', '--', 'landscape_left'],
    ['control', 'button', '-d', 'BBB', '--', 'lock'],
    ['control', 'type', '-d', 'BBB', '--', '--file=x'],
    ['control', 'gesture', '-d', 'BBB', '--', '{"type":"begin","x":0.1,"y":0.2}'],
    ['control', 'gesture', '-d', 'BBB', '--', '{"type":"move","x":0.3,"y":0.4}'],
    ['control', 'gesture', '-d', 'BBB', '--', '{"type":"end","x":0.3,"y":0.4}'],
  ])
  await assert.rejects(source.control.tap(2, 0), /normalized 0\.\.1/)
})

test('pngDimensionsFromBase64 reads the IHDR size', () => {
  assert.deepEqual(pngDimensionsFromBase64(tinyPng(3, 7).toString('base64')), { width: 3, height: 7 })
})
