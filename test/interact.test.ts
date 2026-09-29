import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WebSocketServer } from 'ws'
import { interactControlArgs, performSimInteract, scrollRequestOf, type SimInteractArgs } from '../src/interact.js'
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

test('interactControlArgs rejects bad input with actionable errors', () => {
  assert.throws(() => interactControlArgs({ action: 'tap', x: 0.5 }), /requires numeric x and y/)
  assert.throws(() => interactControlArgs({ action: 'type', text: '你好' }), /US-keyboard ASCII/)
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
