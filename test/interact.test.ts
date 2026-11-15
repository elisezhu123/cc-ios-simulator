import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WebSocketServer } from 'ws'
import { interactControlArgs, performSimInteract, scrollRequestOf, simTextSegments, type SimInteractArgs } from '../src/interact.js'
import { fakeHost } from './helpers/fakes.js'

test('interactControlArgs maps each action to serve-sim CLI arguments', () => {
  assert.deepEqual(interactControlArgs({ action: 'tap', x: 0.1, y: 0.2 }), [['tap', '0.1', '0.2']])
  assert.deepEqual(interactControlArgs({ action: 'type', text: 'hello' }), [['type', 'hello']])
  assert.deepEqual(interactControlArgs({ action: 'button', name: ' home ' }), [['button', 'home']])
  assert.deepEqual(
    interactControlArgs({ action: 'gesture', json: { type: 'begin', x: 0.5, y: 0.5 } }),
    [['gesture', '{"type":"begin","x":0.5,"y":0.5}']],
  )
  assert.equal(interactControlArgs({ action: 'scroll', direction: 'down' }).length, 3)
})

test('button names are checked against the ones serve-sim 0.1.47 acts on', () => {
  // HIDInjector.sendButton's switch, then the CLI's HID usage table (node_modules/serve-sim).
  const supported = [
    'home', 'lock', 'siri', 'side_button', 'swipe_home', 'app_switcher',
    'power', 'volume-up', 'volume-down', 'action', 'side-button', 'digital-crown', 'left-side-button',
  ]
  for (const name of supported) assert.deepEqual(interactControlArgs({ action: 'button', name }), [['button', name]])
  assert.throws(
    () => interactControlArgs({ action: 'button', name: 'reboot' }),
    new RegExp(`unknown button "reboot" — serve-sim supports ${supported.join(', ')}`),
  )
  assert.throws(() => interactControlArgs({ action: 'button', name: 'Home' }), /unknown button "Home"/)
})

test('interactControlArgs rejects bad input with actionable errors', () => {
  assert.throws(() => interactControlArgs({ action: 'tap', x: 0.5 }), /requires numeric x and y/)
  assert.throws(() => interactControlArgs({ action: 'type', text: '' }), /non-empty text/)
  assert.throws(() => interactControlArgs({ action: 'scroll' }), /requires direction/)
  assert.throws(() => scrollRequestOf({ action: 'scroll', direction: 'up', amount: 2 }), /amount/)
})

test('every serve-sim CLI call ends its options with --, so typed text cannot become an option', async () => {
  const { host, calls } = fakeHost({ device: 'BBB' })
  const actions: SimInteractArgs[] = [
    { action: 'type', text: '--file=x' },
    { action: 'tap', x: 0.5, y: 0.25 },
    { action: 'button', name: 'home' },
    { action: 'gesture', json: { type: 'begin', x: 0.5, y: 0.5 } },
  ]
  for (const args of actions) await performSimInteract(host, 'BBB', args, interactControlArgs(args))
  assert.deepEqual(calls, [
    ['control', 'type', '-d', 'BBB', '--', '--file=x'],
    ['control', 'tap', '-d', 'BBB', '--', '0.5', '0.25'],
    ['control', 'button', '-d', 'BBB', '--', 'home'],
    ['control', 'gesture', '-d', 'BBB', '--', '{"type":"begin","x":0.5,"y":0.5}'],
  ])
})

test('performSimInteract falls back to the CLI when no control socket is known', async () => {
  const { host, calls } = fakeHost({ device: 'BBB' })
  const args: SimInteractArgs = { action: 'scroll', direction: 'down' }
  const delivery = await performSimInteract(host, 'BBB', args, interactControlArgs(args))
  assert.equal(delivery.channel, 'cli')
  assert.match(delivery.wsError ?? '', /control-socket url/)
  assert.deepEqual(calls.map(call => call[1]), ['gesture', 'gesture', 'gesture'])
})

test('performSimInteract traces a scroll over the stream socket when it is live', async () => {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise<void>(resolve => wss.once('listening', () => resolve()))
  const port = (wss.address() as { port: number }).port
  let received = 0
  wss.on('connection', socket => socket.on('message', () => { received += 1 }))
  const { host, calls } = fakeHost({ device: 'BBB', wsUrl: `ws://127.0.0.1:${port}`, exposeStreamInfo: true })
  const args: SimInteractArgs = { action: 'scroll', direction: 'up' }
  const delivery = await performSimInteract(host, 'BBB', args, interactControlArgs(args), { stepMs: 0 })
  await new Promise(resolve => setTimeout(resolve, 50))
  wss.close()
  assert.equal(delivery.channel, 'ws')
  assert.equal(delivery.frames, 20)
  assert.equal(received, 20)
  assert.deepEqual(calls, [])
})

test('performSimInteract taps over the stream socket when it is live, without a serve-sim process', async () => {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise<void>(resolve => wss.once('listening', () => resolve()))
  const port = (wss.address() as { port: number }).port
  const types: string[] = []
  wss.on('connection', socket => socket.on('message', data => {
    types.push((JSON.parse((data as Buffer).subarray(1).toString('utf8')) as { type: string }).type)
  }))
  const { host, calls } = fakeHost({ device: 'BBB', wsUrl: `ws://127.0.0.1:${port}`, exposeStreamInfo: true })
  const args: SimInteractArgs = { action: 'tap', x: 0.4, y: 0.6 }
  const delivery = await performSimInteract(host, 'BBB', args, interactControlArgs(args), { tapHoldMs: 0 })
  await new Promise(resolve => setTimeout(resolve, 50))
  wss.close()
  assert.equal(delivery.channel, 'ws')
  assert.equal(delivery.frames, 2)
  assert.deepEqual(types, ['begin', 'end'])
  assert.deepEqual(calls, [])
})

test('a tap falls back to the serve-sim CLI when the socket refuses, and never goes to another device\'s socket', async () => {
  const refused = fakeHost({ device: 'BBB', wsUrl: 'ws://127.0.0.1:1', exposeStreamInfo: true })
  const args: SimInteractArgs = { action: 'tap', x: 0.4, y: 0.6 }
  const delivery = await performSimInteract(refused.host, 'BBB', args, interactControlArgs(args))
  assert.equal(delivery.channel, 'cli')
  assert.match(delivery.wsError ?? '', /gesture channel/)
  assert.deepEqual(refused.calls, [['control', 'tap', '-d', 'BBB', '--', '0.4', '0.6']])
  const other = fakeHost({ device: 'AAA', wsUrl: 'ws://127.0.0.1:1', exposeStreamInfo: true })
  const elsewhere = await performSimInteract(other.host, 'BBB', args, interactControlArgs(args))
  assert.equal(elsewhere.channel, 'cli')
  assert.deepEqual(other.calls, [['control', 'tap', '-d', 'BBB', '--', '0.4', '0.6']])
})

test('simTextSegments splits text into US-keyboard runs and runs that must be pasted', () => {
  assert.deepEqual(simTextSegments('hello'), [{ kind: 'keys', text: 'hello' }])
  assert.deepEqual(simTextSegments('你好🎉'), [{ kind: 'paste', text: '你好🎉' }])
  assert.deepEqual(simTextSegments('hi 你好, ok\n'), [
    { kind: 'keys', text: 'hi ' },
    { kind: 'paste', text: '你好' },
    { kind: 'keys', text: ', ok\n' },
  ])
})

test('performSimInteract pastes Chinese and emoji through the pasteboard and ⌘V, and types the ASCII around it', async () => {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise<void>(resolve => wss.once('listening', () => resolve()))
  const port = (wss.address() as { port: number }).port
  const events: string[] = []
  wss.on('connection', socket => socket.on('message', data => {
    const frame = JSON.parse((data as Buffer).subarray(1).toString('utf8')) as { type: string; usage: number }
    events.push(`key ${frame.type} ${frame.usage}`)
  }))
  const { host, calls } = fakeHost({ device: 'BBB', wsUrl: `ws://127.0.0.1:${port}`, exposeStreamInfo: true })
  const control = host.control.bind(host)
  host.control = async (args, options) => {
    events.push(`type ${args[args.length - 1] ?? ''}`)
    return control(args, options)
  }
  const args: SimInteractArgs = { action: 'type', text: 'hi 你好🎉!' }
  const delivery = await performSimInteract(host, 'BBB', args, interactControlArgs(args), {
    setPasteboard: async (udid, text) => {
      // Let the socket's frames from an earlier paste land before recording the next step.
      await new Promise(resolve => setTimeout(resolve, 30))
      events.push(`pbcopy ${udid} ${text}`)
    },
    pasteHoldMs: 0,
    pasteSettleMs: 30,
    charGapMs: 0,
  })
  await new Promise(resolve => setTimeout(resolve, 50))
  wss.close()
  assert.deepEqual(events, [
    // "hi " as keys: h, i, space.
    'key down 11', 'key up 11', 'key down 12', 'key up 12', 'key down 44', 'key up 44',
    'pbcopy BBB 你好🎉',
    'key down 227', 'key down 25', 'key up 25', 'key up 227',
    // "!" is Shift + 1.
    'key down 225', 'key down 30', 'key up 30', 'key up 225',
  ])
  assert.deepEqual(calls, [], 'no serve-sim process at all')
  assert.deepEqual(delivery, { channel: 'ws', pasted: 1 })
})

test('pasting needs the stream control socket and a pasteboard: without them the error says so', async () => {
  const args: SimInteractArgs = { action: 'type', text: '你好' }
  const offline = fakeHost({ device: 'BBB' })
  await assert.rejects(
    performSimInteract(offline.host, 'BBB', args, interactControlArgs(args), { setPasteboard: async () => {} }),
    /Chinese, emoji.*pasted with ⌘V over the stream's control socket/s,
  )
  const live = fakeHost({ device: 'BBB', wsUrl: 'ws://127.0.0.1:9', exposeStreamInfo: true })
  await assert.rejects(performSimInteract(live.host, 'BBB', args, interactControlArgs(args)), /pasteboard/)
  assert.deepEqual([...offline.calls, ...live.calls], [])
})

test('a shortcut goes over the control socket only: no CLI call, and a clear error without a stream', async () => {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise<void>(resolve => wss.once('listening', () => resolve()))
  const port = (wss.address() as { port: number }).port
  const usages: number[] = []
  wss.on('connection', socket => socket.on('message', data => {
    usages.push((JSON.parse((data as Buffer).subarray(1).toString('utf8')) as { usage: number }).usage)
  }))
  const { host, calls } = fakeHost({ device: 'BBB', wsUrl: `ws://127.0.0.1:${port}`, exposeStreamInfo: true })
  const args: SimInteractArgs = { action: 'shortcut', name: 'select-all' }
  assert.deepEqual(interactControlArgs(args), [])
  const delivery = await performSimInteract(host, 'BBB', args, [], { shortcutHoldMs: 0 })
  await new Promise(resolve => setTimeout(resolve, 50))
  wss.close()
  assert.deepEqual([delivery.channel, delivery.frames], ['ws', 4])
  assert.deepEqual(usages, [227, 4, 4, 227])
  assert.deepEqual(calls, [])
  assert.throws(() => interactControlArgs({ action: 'shortcut', name: 'quit' }), /requires name — one of copy, paste, cut, select-all, undo, redo/)
  const offline = fakeHost({ device: 'BBB' })
  await assert.rejects(performSimInteract(offline.host, 'BBB', args, []), /shortcut.*control socket/s)
})

test('typing goes over the control socket when the stream is live, and through the serve-sim CLI when it is not', async () => {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise<void>(resolve => wss.once('listening', () => resolve()))
  const port = (wss.address() as { port: number }).port
  const usages: number[] = []
  wss.on('connection', socket => socket.on('message', data => {
    usages.push((JSON.parse((data as Buffer).subarray(1).toString('utf8')) as { usage: number }).usage)
  }))
  const live = fakeHost({ device: 'BBB', wsUrl: `ws://127.0.0.1:${port}`, exposeStreamInfo: true })
  const args: SimInteractArgs = { action: 'type', text: 'ok' }
  const delivery = await performSimInteract(live.host, 'BBB', args, interactControlArgs(args), { charGapMs: 0 })
  await new Promise(resolve => setTimeout(resolve, 50))
  wss.close()
  assert.deepEqual([delivery.channel, delivery.frames], ['ws', 4])
  assert.deepEqual(usages, [18, 18, 14, 14])
  assert.deepEqual(live.calls, [])

  // A socket that never opens typed nothing: the CLI can safely type the whole text.
  const refused = fakeHost({ device: 'BBB', wsUrl: 'ws://127.0.0.1:9', exposeStreamInfo: true })
  const fallback = await performSimInteract(refused.host, 'BBB', args, interactControlArgs(args))
  assert.equal(fallback.channel, 'cli')
  assert.match(fallback.wsError ?? '', /control socket/)
  assert.deepEqual(refused.calls, [['control', 'type', '-d', 'BBB', '--', 'ok']])
})
