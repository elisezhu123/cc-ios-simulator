import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { streamFrameDigest } from '../src/stream-frame.js'

const JPEG = (body: string): Buffer => Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.from(body), Buffer.from([0xff, 0xd9])])

/** An MJPEG endpoint like serve-sim's: the current frame at once, then nothing until the screen changes. */
async function mjpegServer(t: TestContext, frame: () => Buffer | undefined, status = 200): Promise<{ url: string; requests(): number }> {
  let requests = 0
  const server = createServer((_req, res) => {
    requests += 1
    if (status !== 200) {
      res.writeHead(status).end()
      return
    }
    res.writeHead(200, { 'content-type': 'multipart/x-mixed-replace; boundary=frame' })
    const body = frame()
    if (body === undefined) return
    res.write('--frame\r\nContent-Type: image/jpeg\r\n\r\n')
    // Split mid-frame: a frame arrives in several chunks on a real socket.
    res.write(body.subarray(0, 3))
    res.write(body.subarray(3))
    res.write('\r\n')
  })
  t.after(() => { server.closeAllConnections(); server.close() })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/stream.mjpeg`, requests: () => requests }
}

test('streamFrameDigest identifies the frame the stream shows: equal frames, equal digests', async t => {
  let screen = 'settings'
  const server = await mjpegServer(t, () => JPEG(screen))
  const first = await streamFrameDigest(server.url)
  assert.match(first ?? '', /^[0-9a-f]{40}$/u)
  assert.equal(await streamFrameDigest(server.url), first)
  screen = 'general'
  assert.notEqual(await streamFrameDigest(server.url), first)
  assert.equal(server.requests(), 3)
})

test('streamFrameDigest answers undefined, never throws, when there is no frame to read', async t => {
  assert.equal(await streamFrameDigest((await mjpegServer(t, () => undefined)).url, 80), undefined, 'a stream that stays silent')
  assert.equal(await streamFrameDigest((await mjpegServer(t, () => JPEG('x'), 404)).url), undefined, 'not a stream')
  assert.equal(await streamFrameDigest('http://127.0.0.1:9/stream.mjpeg'), undefined, 'nothing listening')
  assert.equal(await streamFrameDigest('not a url'), undefined)
})
