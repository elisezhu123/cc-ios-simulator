import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseServeSimHandshake, resolveServeSimBinary, SimHostController } from '../src/sim-host.js'
import { setSimctlRunnerForTests } from '../src/simctl.js'
import { fakeServeSimBinary, isAlive } from './helpers/fakes.js'

/** simctl for the host: boot and bootstatus succeed; `list devices` reports BBB in `state`. */
function fakeSimctlRunner(): { calls: string[][]; state: string } {
  const fake = { calls: [] as string[][], state: 'Booted' }
  setSimctlRunnerForTests(async args => {
    fake.calls.push([...args])
    if (args[0] !== 'list') return ''
    return JSON.stringify({
      devices: { 'com.apple.CoreSimulator.SimRuntime.iOS-26-0': [{ udid: 'BBB', name: 'iPhone 17 Pro', state: fake.state, isAvailable: true }] },
    })
  })
  return fake
}

async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`condition not met within ${timeoutMs} ms`)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

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

test('dispose during a pending launch kills the spawned serve-sim at once instead of awaiting its handshake', async t => {
  const fake = fakeServeSimBinary({ handshake: false })
  t.after(() => fake.killAll())
  fakeSimctlRunner()
  t.after(() => setSimctlRunnerForTests())
  const host = new SimHostController({ binary: fake.binary, startTimeoutMs: 8_000, idleTimeoutMs: 0 })
  const launch = host.ensureRunning({ udid: 'BBB' }).then(() => 'launched', (error: unknown) => String(error))
  // Spawned, still waiting for its handshake (a slow npx download, a hung helper).
  await waitFor(() => fake.pids().length === 1)
  const [pid] = fake.pids()
  assert.ok(pid !== undefined)
  const started = Date.now()
  await host.dispose()
  const elapsed = Date.now() - started
  // The host's MCP client kills the server ~4 s after closing its stdin (stdin.end → 2 s → SIGTERM → 2 s → SIGKILL).
  assert.ok(elapsed < 3_000, `dispose took ${elapsed} ms`)
  assert.equal(isAlive(pid), false)
  assert.notEqual(await launch, 'launched')
})

test('the exit backstop SIGTERMs a still-running serve-sim process group synchronously, ignoring ESRCH', async t => {
  const fake = fakeServeSimBinary({ handshake: true })
  t.after(() => fake.killAll())
  fakeSimctlRunner()
  t.after(() => setSimctlRunnerForTests())
  const host = new SimHostController({ binary: fake.binary, idleTimeoutMs: 0 })
  t.after(() => host.dispose())
  await host.ensureRunning({ udid: 'BBB' })
  const [pid] = fake.pids()
  assert.ok(pid !== undefined)
  // A group that is already gone is no error in an 'exit' handler.
  assert.doesNotThrow(() => host.terminateOnExit(() => { throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' }) }))
  const sent: Array<[number, string]> = []
  host.terminateOnExit((target, signal) => {
    sent.push([target, signal])
    process.kill(target, signal)
  })
  assert.deepEqual(sent, [[-pid, 'SIGTERM']])
  await waitFor(() => !isAlive(pid))
})

test('keep-alive treats a device shut down outside the tools as an intentional stop: no restart, no boot', async t => {
  const fake = fakeServeSimBinary({ handshake: true })
  t.after(() => fake.killAll())
  const simctl = fakeSimctlRunner()
  t.after(() => setSimctlRunnerForTests())
  const host = new SimHostController({ binary: fake.binary, restartDelayMs: 50, idleTimeoutMs: 0 })
  t.after(() => host.dispose())
  await host.ensureRunning({ udid: 'BBB' })
  host.startKeepAlive()
  // Shut down in Simulator.app or with `simctl shutdown`: serve-sim exits along with the device.
  simctl.state = 'Shutdown'
  fake.killAll()
  await waitFor(() => !host.status().running)
  await sleep(1_500) // one keep-alive tick (1 s) past the restart delay
  assert.equal(fake.pids().length, 1)
  assert.deepEqual(simctl.calls.filter(call => call[0] === 'boot'), [['boot', 'BBB']])
  assert.equal(host.status().running, false)
  assert.equal(host.status().restarts, 0)
})

test('keep-alive still restarts a stream that crashed while its device stays booted', async t => {
  const fake = fakeServeSimBinary({ handshake: true })
  t.after(() => fake.killAll())
  fakeSimctlRunner()
  t.after(() => setSimctlRunnerForTests())
  const host = new SimHostController({ binary: fake.binary, restartDelayMs: 50, idleTimeoutMs: 0 })
  t.after(() => host.dispose())
  await host.ensureRunning({ udid: 'BBB' })
  host.startKeepAlive()
  fake.killAll()
  await waitFor(() => fake.pids().length === 2 && host.status().running)
  assert.equal(host.status().restarts, 1)
})
