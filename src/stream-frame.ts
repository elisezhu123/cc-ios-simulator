/**
 * What the live stream is showing right now, as a digest.
 *
 * serve-sim answers a request for its MJPEG stream with the current frame at
 * once: 2 ms on a running stream, against ~470 ms for `simctl io screenshot`
 * (both measured on an iPhone 17 simulator). The frame is the full
 * framebuffer, it follows the screen even while no client is connected, and
 * an unchanged screen yields byte-identical frames — so the digest of one
 * frame tells cheaply whether the screen changed since the last look.
 *
 * It is only used to compare. OCR keeps reading the PNG screenshot: on the
 * JPEG frame small text read worse ("Safar" for "Safari").
 * @module ios-simulator/stream-frame
 */

import { createHash } from 'node:crypto'
import { get } from 'node:http'

const JPEG_START = Buffer.from([0xff, 0xd8])
const JPEG_END = Buffer.from([0xff, 0xd9])
/**
 * A stream whose capture session was idle takes 450–550 ms to produce its
 * first frame (measured); later frames arrive in ~2 ms.
 */
const STREAM_FRAME_TIMEOUT_MS = 700
/** A simulator frame is ~200 KB; anything far beyond that is not one. */
const MAX_FRAME_BYTES = 16 * 1024 * 1024

/**
 * The SHA-1 of the first complete JPEG frame of an MJPEG stream; undefined
 * when there is none to read in time (no stream, not a stream, a silent one).
 * Never throws: a caller without a digest simply does the full work.
 */
export function streamFrameDigest(streamUrl: string, timeoutMs = STREAM_FRAME_TIMEOUT_MS): Promise<string | undefined> {
  return new Promise(resolve => {
    let settled = false
    let request: ReturnType<typeof get> | undefined
    const finish = (digest: string | undefined): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      request?.destroy()
      resolve(digest)
    }
    const timer = setTimeout(() => finish(undefined), timeoutMs)
    try {
      request = get(streamUrl, response => {
        if (response.statusCode !== 200) {
          finish(undefined)
          return
        }
        let received = Buffer.alloc(0)
        response.on('data', (chunk: Buffer) => {
          received = Buffer.concat([received, chunk])
          const start = received.indexOf(JPEG_START)
          const end = start < 0 ? -1 : received.indexOf(JPEG_END, start + JPEG_START.length)
          if (end > start) finish(createHash('sha1').update(received.subarray(start, end + JPEG_END.length)).digest('hex'))
          else if (received.length > MAX_FRAME_BYTES) finish(undefined)
        })
        response.on('error', () => finish(undefined))
        response.on('end', () => finish(undefined))
      })
      request.on('error', () => finish(undefined))
    } catch {
      // Not a URL http can request.
      finish(undefined)
    }
  })
}
