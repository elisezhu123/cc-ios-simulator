import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WebSocketServer } from 'ws'
import {
  encodeSimButtonFrame,
  encodeSimTouchFrame,
  sendSimGesture,
  sendSimKeyboardToggle,
  sendSimPaste,
  sendSimShortcut,
  SIM_SHORTCUTS,
  sendSimTap,
  sendSimText,
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

test('sendSimTap writes begin then end at the same point over one socket, holding in between', async () => {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise<void>(resolve => wss.once('listening', () => resolve()))
  const port = (wss.address() as { port: number }).port
  const frames: Array<{ tag: number; at: number; body: { type: string; x: number; y: number } }> = []
  wss.on('connection', socket => socket.on('message', data => {
    const bytes = data as Buffer
    frames.push({ tag: bytes[0] ?? -1, at: Date.now(), body: JSON.parse(bytes.subarray(1).toString('utf8')) as { type: string; x: number; y: number } })
  }))
  const report = await sendSimTap(`ws://127.0.0.1:${port}`, { x: 0.25, y: 0.75 }, { holdMs: 30 })
  await new Promise(resolve => setTimeout(resolve, 50))
  wss.close()
  assert.equal(report.frames, 2)
  assert.deepEqual(frames.map(frame => frame.tag), [3, 3])
  assert.deepEqual(frames.map(frame => frame.body), [{ type: 'begin', x: 0.25, y: 0.75 }, { type: 'end', x: 0.25, y: 0.75 }])
  assert.ok((frames[1]?.at ?? 0) - (frames[0]?.at ?? 0) >= 25, 'the finger stays down for the hold')
})

test('sendSimTap rejects without a control-socket url or when the socket refuses', async () => {
  await assert.rejects(sendSimTap('', { x: 0.5, y: 0.5 }), /gesture channel/)
  await assert.rejects(sendSimTap('ws://127.0.0.1:1', { x: 0.5, y: 0.5 }, { connectTimeoutMs: 500 }), /gesture channel/)
})

test('sendSimPaste presses ⌘V as hardware-keyboard frames: ⌘ down, V down, V up, ⌘ up', async () => {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise<void>(resolve => wss.once('listening', () => resolve()))
  const port = (wss.address() as { port: number }).port
  const frames: unknown[] = []
  wss.on('connection', socket => socket.on('message', data => {
    const bytes = data as Buffer
    frames.push({ tag: bytes[0], ...JSON.parse(bytes.subarray(1).toString('utf8')) as Record<string, unknown> })
  }))
  const report = await sendSimPaste(`ws://127.0.0.1:${port}`, { holdMs: 0 })
  await new Promise(resolve => setTimeout(resolve, 50))
  wss.close()
  assert.equal(report.frames, 4)
  assert.deepEqual(frames, [
    { tag: 6, type: 'down', usage: 227 },
    { tag: 6, type: 'down', usage: 25 },
    { tag: 6, type: 'up', usage: 25 },
    { tag: 6, type: 'up', usage: 227 },
  ])
  await assert.rejects(sendSimPaste(''), /gesture channel/)
})

test('sendSimShortcut presses ⌘ with the key — and Shift for redo; the keyboard toggle is one bare tag-12 frame', async () => {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise<void>(resolve => wss.once('listening', () => resolve()))
  const port = (wss.address() as { port: number }).port
  const frames: string[] = []
  wss.on('connection', socket => socket.on('message', data => {
    const bytes = data as Buffer
    frames.push(bytes.length === 1 ? `tag ${bytes[0]}` : `${(JSON.parse(bytes.subarray(1).toString('utf8')) as { type: string }).type} ${(JSON.parse(bytes.subarray(1).toString('utf8')) as { usage: number }).usage}`)
  }))
  const url = `ws://127.0.0.1:${port}`
  await sendSimShortcut(url, 'copy', { holdMs: 0 })
  await sendSimShortcut(url, 'redo', { holdMs: 0 })
  await sendSimKeyboardToggle(url)
  await new Promise(resolve => setTimeout(resolve, 50))
  wss.close()
  assert.deepEqual(frames, [
    'down 227', 'down 6', 'up 6', 'up 227',
    'down 227', 'down 225', 'down 29', 'up 29', 'up 225', 'up 227',
    'tag 12',
  ])
  assert.deepEqual(Object.keys(SIM_SHORTCUTS), ['copy', 'paste', 'cut', 'select-all', 'undo', 'redo'])
  await assert.rejects(sendSimShortcut(url, 'quit' as 'copy'), /unknown shortcut "quit"/)
  await assert.rejects(sendSimKeyboardToggle(''), /gesture channel/)
})

test('sendSimText types US-keyboard text as key frames over one socket: Shift around capitals, Return for a newline', async () => {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise<void>(resolve => wss.once('listening', () => resolve()))
  const port = (wss.address() as { port: number }).port
  const keys: string[] = []
  wss.on('connection', socket => socket.on('message', data => {
    const body = JSON.parse((data as Buffer).subarray(1).toString('utf8')) as { type: string; usage: number }
    keys.push(`${body.type} ${body.usage}`)
  }))
  let opened = false
  const report = await sendSimText(`ws://127.0.0.1:${port}`, 'aB\n', { charGapMs: 0, onOpen: () => { opened = true } })
  await new Promise(resolve => setTimeout(resolve, 50))
  wss.close()
  assert.deepEqual(keys, ['down 4', 'up 4', 'down 225', 'down 5', 'up 5', 'up 225', 'down 40', 'up 40'])
  assert.deepEqual([report.frames, opened], [8, true])
  await assert.rejects(sendSimText(`ws://127.0.0.1:${port}`, '你好'), /cannot type "你"/)
  await assert.rejects(sendSimText('', 'a'), /gesture channel/)
})

test('sendSimText paces the characters so a long text is not dropped', async () => {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise<void>(resolve => wss.once('listening', () => resolve()))
  const port = (wss.address() as { port: number }).port
  const at: number[] = []
  wss.on('connection', socket => socket.on('message', () => { at.push(Date.now()) }))
  await sendSimText(`ws://127.0.0.1:${port}`, 'abcd', { charGapMs: 20 })
  await new Promise(resolve => setTimeout(resolve, 50))
  wss.close()
  // 4 characters, 8 frames: a gap before each character but the first.
  assert.equal(at.length, 8)
  assert.ok((at[7] ?? 0) - (at[0] ?? 0) >= 55, `three gaps of 20 ms, got ${(at[7] ?? 0) - (at[0] ?? 0)} ms`)
})
