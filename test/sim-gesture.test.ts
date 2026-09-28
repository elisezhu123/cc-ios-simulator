import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WebSocketServer } from 'ws'
import {
  encodeSimButtonFrame,
  encodeSimTouchFrame,
  sendSimGesture,
  simDragPath,
  simDragRequestOf,
  simScrollPath,
  SIM_GESTURE_BAND_MAX,
  SIM_GESTURE_BAND_MIN,
} from '../src/sim-gesture.js'

test('touch and button frames are [tag][json] with clamped coordinates', () => {
  const touch = encodeSimTouchFrame('begin', 1.5, -0.2)
  assert.equal(touch[0], 3)
  assert.deepEqual(JSON.parse(touch.subarray(1).toString('utf8')), { type: 'begin', x: 1, y: 0 })
  const button = encodeSimButtonFrame('home')
  assert.equal(button[0], 4)
  assert.deepEqual(JSON.parse(button.subarray(1).toString('utf8')), { button: 'home' })
})

test('scroll "down" moves the finger up and never leaves the 8–92% band', () => {
  const path = simScrollPath({ direction: 'down', amount: 0.9, anchorX: 0.5, anchorY: 0.99 })
  assert.equal(path.length, 19)
  assert.ok((path[0]?.y ?? 0) > (path[path.length - 1]?.y ?? 1))
  for (const point of path) {
    assert.ok(point.y >= SIM_GESTURE_BAND_MIN && point.y <= SIM_GESTURE_BAND_MAX)
    assert.equal(point.x, 0.5)
  }
})

test('a drag duration sets the number of 16 ms frames; raw frames are not drags', () => {
  assert.equal(simDragPath({ fromX: 0.1, fromY: 0.5, toX: 0.9, toY: 0.5, duration: 0.3 }).length, 20)
  assert.equal(simDragRequestOf({ type: 'begin', x: 0.5, y: 0.5 }), undefined)
  assert.deepEqual(simDragRequestOf({ fromX: 0.1, fromY: 0.2, toX: 0.3, toY: 0.4 }), { fromX: 0.1, fromY: 0.2, toX: 0.3, toY: 0.4 })
})

test('sendSimGesture writes begin, moves and end over one socket', async () => {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise<void>(resolve => wss.once('listening', () => resolve()))
  const port = (wss.address() as { port: number }).port
  const frames: Array<{ type: string }> = []
  wss.on('connection', socket => socket.on('message', data => {
    const bytes = data as Buffer
    frames.push(JSON.parse(bytes.subarray(1).toString('utf8')) as { type: string })
  }))
  const report = await sendSimGesture(`ws://127.0.0.1:${port}`, [{ x: 0.5, y: 0.8 }, { x: 0.5, y: 0.5 }, { x: 0.5, y: 0.2 }], { stepMs: 0 })
  await new Promise(resolve => setTimeout(resolve, 50))
  wss.close()
  assert.equal(report.frames, 4)
  assert.deepEqual(frames.map(frame => frame.type), ['begin', 'move', 'move', 'end'])
})

test('sendSimGesture rejects without a control-socket url', async () => {
  await assert.rejects(sendSimGesture('', [{ x: 0, y: 0 }, { x: 1, y: 1 }]), /gesture channel/)
})
