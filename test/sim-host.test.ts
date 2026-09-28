import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseServeSimHandshake, resolveServeSimBinary, SimHostController } from '../src/sim-host.js'

test('resolveServeSimBinary refuses non-macOS and non-arm64 hosts', () => {
  assert.equal(resolveServeSimBinary({ platform: 'linux', arch: 'arm64' }).available, false)
  const intel = resolveServeSimBinary({ platform: 'darwin', arch: 'x64', override: undefined })
  assert.equal(intel.available, false)
  assert.match(intel.reason ?? '', /arm64/)
})

test('resolveServeSimBinary honours an executable IOS_SIM_SERVE_SIM_BIN', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ios-sim-bin-'))
  const bin = join(dir, 'serve-sim')
  writeFileSync(bin, '#!/bin/sh\n')
  chmodSync(bin, 0o755)
  assert.deepEqual(
    resolveServeSimBinary({ platform: 'darwin', arch: 'arm64', override: bin }),
    { available: true, source: 'package-bin', command: bin, args: [] },
  )
  const missing = resolveServeSimBinary({ platform: 'darwin', arch: 'arm64', override: join(dir, 'nope') })
  assert.equal(missing.available, false)
  assert.match(missing.reason ?? '', /IOS_SIM_SERVE_SIM_BIN/)
})

test('resolveServeSimBinary falls back to a pinned npx serve-sim', () => {
  assert.deepEqual(
    resolveServeSimBinary({ platform: 'darwin', arch: 'arm64', override: undefined, packageBin: () => undefined, findNpx: () => '/usr/local/bin/npx' }),
    { available: true, source: 'npx', command: '/usr/local/bin/npx', args: ['-y', 'serve-sim@0.1.47'] },
  )
})

test('resolveServeSimBinary finds the serve-sim installed in this repo', () => {
  const binary = resolveServeSimBinary({ platform: 'darwin', arch: 'arm64', override: undefined })
  assert.equal(binary.source, 'package-bin')
  assert.match(binary.command ?? '', /node_modules\/serve-sim\/dist\/serve-sim\.js$/)
})

test('parseServeSimHandshake validates the JSON handshake', () => {
  const info = parseServeSimHandshake(JSON.stringify({
    url: 'http://127.0.0.1:3181',
    streamUrl: 'http://127.0.0.1:3181/stream.mjpeg',
    wsUrl: 'ws://127.0.0.1:3181/ws',
    port: 3181,
    device: 'BBB',
  }))
  assert.equal(info.port, 3181)
  assert.equal(info.device, 'BBB')
  assert.throws(() => parseServeSimHandshake('not json'), /non-JSON/)
  assert.throws(() => parseServeSimHandshake(JSON.stringify({ url: 'http://x' })), /incomplete/)
})

test('SimHostController with an unavailable binary refuses control and counts consumers', async () => {
  const host = new SimHostController({ binary: { available: false, source: 'unavailable', args: [], reason: 'test' } })
  assert.equal(host.available, false)
  assert.equal(host.status().running, false)
  assert.equal(host.streamInfo, undefined)
  await assert.rejects(host.control(['tap', '0.5', '0.5']), /serve-sim is unavailable \(test\)/)
  const release = host.acquire()
  assert.equal(host.status().consumers, 1)
  release()
  release()
  assert.equal(host.status().consumers, 0)
  await host.dispose()
})
