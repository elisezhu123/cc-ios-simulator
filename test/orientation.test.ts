import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { WebSocketServer } from 'ws'
import { readSimScreenConfig, toFramebufferArgs } from '../src/orientation.js'

test('toFramebufferArgs maps taps, drags and scrolls from upright-image space', () => {
  assert.deepEqual(toFramebufferArgs('portrait', { action: 'tap', x: 0.25, y: 0.75 }), { action: 'tap', x: 0.25, y: 0.75 })
  assert.deepEqual(toFramebufferArgs('landscape_left', { action: 'tap', x: 0.25, y: 0.75 }), { action: 'tap', x: 0.75, y: 0.75 })
  assert.deepEqual(toFramebufferArgs('landscape_right', { action: 'tap', x: 0.25, y: 0.75 }), { action: 'tap', x: 0.25, y: 0.25 })
  assert.deepEqual(
    toFramebufferArgs('landscape_left', { action: 'scroll', direction: 'down' }),
    { action: 'scroll', direction: 'right', x: 0.5, y: 0.5 },
  )
  assert.deepEqual(
    toFramebufferArgs('landscape_right', { action: 'scroll', direction: 'right', x: 0.25, y: 0.5 }),
    { action: 'scroll', direction: 'down', x: 0.5, y: 0.25 },
  )
  // Values exactly representable in binary: 1 - 0.9 !== 0.1 in JS, 1 - 0.75 === 0.25.
  assert.deepEqual(
    toFramebufferArgs('landscape_left', { action: 'gesture', json: { fromX: 0.25, fromY: 0.5, toX: 0.75, toY: 0.5, duration: 0.3 } }),
    { action: 'gesture', json: { fromX: 0.5, fromY: 0.75, toX: 0.5, toY: 0.25, duration: 0.3 } },
  )
  assert.deepEqual(toFramebufferArgs('landscape_left', { action: 'type', text: 'a' }), { action: 'type', text: 'a' })
})

test('readSimScreenConfig returns the first tag-130 frame, or undefined on silence', async () => {
  const talkative = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  talkative.on('connection', socket => {
    socket.send(Buffer.from([4, 123, 125]))
    socket.send(Buffer.concat([Buffer.from([130]), Buffer.from('{"width":1206,"height":2622,"orientation":"landscape_left"}')]))
  })
  await new Promise<void>(resolve => talkative.once('listening', () => resolve()))
  const config = await readSimScreenConfig(`ws://127.0.0.1:${(talkative.address() as { port: number }).port}`)
  assert.deepEqual(config, { width: 1206, height: 2622, orientation: 'landscape_left' })
  talkative.close()

  const silent = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise<void>(resolve => silent.once('listening', () => resolve()))
  assert.equal(await readSimScreenConfig(`ws://127.0.0.1:${(silent.address() as { port: number }).port}`, 100), undefined)
  silent.close()
})

/** A stand-in control socket, closed after the test, that greets the connections `greet` picks with a landscape_left config frame. */
async function configSocket(t: TestContext, greet: (connection: number) => boolean): Promise<{ url: string; connections(): number }> {
  let connections = 0
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  t.after(() => wss.close())
  wss.on('connection', socket => {
    connections += 1
    if (greet(connections)) {
      socket.send(Buffer.concat([Buffer.from([130]), Buffer.from('{"width":1206,"height":2622,"orientation":"landscape_left"}')]))
    }
  })
  await new Promise<void>(resolve => wss.once('listening', () => resolve()))
  return { url: `ws://127.0.0.1:${(wss.address() as { port: number }).port}`, connections: () => connections }
}

test('readSimScreenConfig asks a cold stream again, but not a socket silent twice in a row', async t => {
  // serve-sim greets only once the stream's capture session has a first frame, and the
  // stream's first control connection may be what starts that session.
  const cold = await configSocket(t, connection => connection > 1)
  assert.equal(await readSimScreenConfig(cold.url, 100), undefined)
  assert.deepEqual(await readSimScreenConfig(cold.url, 100), { width: 1206, height: 2622, orientation: 'landscape_left' })

  const silent = await configSocket(t, () => false)
  assert.equal(await readSimScreenConfig(silent.url, 100), undefined)
  assert.equal(await readSimScreenConfig(silent.url, 100), undefined)
  assert.equal(await readSimScreenConfig(silent.url, 100), undefined)
  assert.equal(silent.connections(), 2)
})

test('readSimScreenConfig asks a socket it gave up on again after a minute', async t => {
  let clock = 0
  const now = (): number => clock
  const wakes = await configSocket(t, connection => connection > 2)
  assert.equal(await readSimScreenConfig(wakes.url, 50, now), undefined)
  assert.equal(await readSimScreenConfig(wakes.url, 50, now), undefined)
  clock = 59_999
  assert.equal(await readSimScreenConfig(wakes.url, 50, now), undefined)
  assert.equal(wakes.connections(), 2)
  clock = 60_000
  assert.deepEqual(await readSimScreenConfig(wakes.url, 50, now), { width: 1206, height: 2622, orientation: 'landscape_left' })
  assert.equal(wakes.connections(), 3)
})
