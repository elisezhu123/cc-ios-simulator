import { test } from 'node:test'
import assert from 'node:assert/strict'
import { copyFor } from '../src/panel/client/copy.js'
import {
  framebufferPoint,
  frameStyleOf,
  orientationLayout,
  screenRadius,
  screenWidthFor,
  sizeModeId,
  sizeModeOf,
} from '../src/panel/client/layout.js'
import {
  encodeSimControlFrame,
  nextSimRotateOrientation,
  normalizePointerPoint,
  parseSimConfigFrame,
  simButtonFrame,
  simRotateFrame,
  simTouchFrame,
} from '../src/panel/client/protocol.js'

test('control frames are [tag][json]; config frames parse defensively', () => {
  const touch = simTouchFrame('move', 2, -1)
  assert.equal(touch[0], 3)
  assert.deepEqual(JSON.parse(new TextDecoder().decode(touch.subarray(1))), { type: 'move', x: 1, y: 0 })
  assert.equal(simButtonFrame('home')[0], 4)
  assert.equal(simRotateFrame('portrait')[0], 7)
  const config = encodeSimControlFrame(130, { width: 1206, height: 2622, orientation: 'landscape_left' })
  assert.deepEqual(parseSimConfigFrame(config.buffer), { width: 1206, height: 2622, orientation: 'landscape_left' })
  assert.equal(parseSimConfigFrame(simButtonFrame('home')), undefined)
  assert.equal(parseSimConfigFrame(new Uint8Array([130, 123])), undefined)
})

test('rotation cycles clockwise from portrait and pointer points normalize to the box', () => {
  assert.equal(nextSimRotateOrientation(undefined), 'landscape_left')
  assert.equal(nextSimRotateOrientation('landscape_right'), 'portrait')
  assert.deepEqual(normalizePointerPoint({ clientX: 150, clientY: 50 }, { left: 100, top: 0, width: 200, height: 100 }), { x: 0.25, y: 0.5 })
})

test('landscape swaps the displayed axes and pointer points map back to the framebuffer', () => {
  assert.deepEqual(orientationLayout('landscape_left', 1206, 2622), { rotationDeg: 90, displayW: 2622, displayH: 1206 })
  assert.deepEqual(orientationLayout('landscape_right', 1206, 2622), { rotationDeg: -90, displayW: 2622, displayH: 1206 })
  assert.deepEqual(orientationLayout('garbage', 1206, 2622), { rotationDeg: 0, displayW: 1206, displayH: 2622 })
  assert.deepEqual(framebufferPoint('landscape_left', { x: 0.25, y: 0.75 }), { x: 0.75, y: 0.75 })
  assert.deepEqual(framebufferPoint('landscape_right', { x: 0.25, y: 0.75 }), { x: 0.25, y: 0.25 })
  assert.deepEqual(framebufferPoint('portrait_upside_down', { x: 0.25, y: 0.75 }), { x: 0.75, y: 0.25 })
  assert.deepEqual(framebufferPoint(undefined, { x: 0.25, y: 0.75 }), { x: 0.25, y: 0.75 })
})

test('fit contains the screen in the stage; percent and presets follow the device', () => {
  const portrait = orientationLayout('portrait', 1206, 2622)
  assert.equal(screenWidthFor({ kind: 'fit' }, portrait, { width: 1000, height: 600 }, 'none'), 275)
  assert.equal(screenWidthFor({ kind: 'fit' }, portrait, { width: 300, height: 2000 }, 'bezel'), 286)
  assert.equal(screenWidthFor({ kind: 'percent', value: 100 }, portrait, { width: 1, height: 1 }, 'none'), 402)
  assert.equal(screenWidthFor({ kind: 'preset', width: 240 }, portrait, { width: 1, height: 1 }, 'none'), 240)
  const landscape = orientationLayout('landscape_left', 1206, 2622)
  assert.equal(screenWidthFor({ kind: 'preset', width: 240 }, landscape, { width: 1, height: 1 }, 'none'), 522)
})

test('size and frame ids round-trip and fall back safely; copy follows the language', () => {
  assert.deepEqual(sizeModeOf('percent-75'), { kind: 'percent', value: 75 })
  assert.equal(sizeModeId({ kind: 'preset', width: 320 }), 'preset-M')
  assert.deepEqual(sizeModeOf('bogus'), { kind: 'fit' })
  assert.equal(frameStyleOf('device'), 'device')
  assert.equal(frameStyleOf(null), 'device', 'the device frame is the default, like the desktop simulator')
  assert.equal(screenRadius(402, 874), 57)
  assert.equal(copyFor('zh-CN').home, '回到桌面')
  assert.equal(copyFor('en-US').home, 'Home')
})
