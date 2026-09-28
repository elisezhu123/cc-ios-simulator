import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Recorder, recordVideoArgs } from '../src/recorder.js'
import { fakeRecordSpawn } from './helpers/fakes.js'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'ios-sim-rec-'))
}

test('start waits for "Recording started"; stop finalizes with SIGINT', async () => {
  const { spawnRecord, spawned } = fakeRecordSpawn()
  let clock = 1_000
  const recorder = new Recorder({ dir: tempDir(), spawnRecord, now: () => clock })
  const info = await recorder.start('BBB')
  assert.match(info.path, /recording-BBB-.*\.mov$/)
  assert.equal(recorder.active('BBB')?.path, info.path)
  await assert.rejects(recorder.start('BBB'), /already running/)
  clock = 4_500
  const result = await recorder.stop('BBB')
  assert.deepEqual(spawned[0]?.signals, ['SIGINT'])
  assert.equal(result.bytes, 2048)
  assert.equal(result.durationMs, 3_500)
  assert.equal(recorder.active('BBB'), undefined)
})

test('concurrent start() calls for the same device: only one spawns, the other rejects', async () => {
  const { spawnRecord, spawned } = fakeRecordSpawn()
  const recorder = new Recorder({ dir: tempDir(), spawnRecord })
  const results = await Promise.allSettled([recorder.start('BBB'), recorder.start('BBB')])
  const fulfilled = results.filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof recorder.start>>> => r.status === 'fulfilled')
  const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
  assert.equal(fulfilled.length, 1)
  assert.equal(rejected.length, 1)
  assert.match(String(rejected[0]?.reason), /already/)
  assert.match(String(rejected[0]?.reason), new RegExp(fulfilled[0]?.value.udid ?? 'BBB'))
  assert.equal(spawned.length, 1)
  await recorder.stop('BBB')
  assert.deepEqual(spawned[0]?.signals, ['SIGINT'])
})

test('a failed start releases the reservation so a later start can proceed', async () => {
  const recorder = new Recorder({ dir: tempDir(), spawnRecord: fakeRecordSpawn({ exitEarly: true }).spawnRecord })
  await assert.rejects(recorder.start('BBB'), /exited before recording/)
  // If the reservation from the first (failed) start were never released, this
  // would reject with /already/ instead of hitting the spawner again.
  await assert.rejects(recorder.start('BBB'), /exited before recording/)
})

test('start fails loudly when recordVideo exits early', async () => {
  const recorder = new Recorder({ dir: tempDir(), spawnRecord: fakeRecordSpawn({ exitEarly: true }).spawnRecord })
  await assert.rejects(recorder.start('BBB'), /exited before recording \(code 1\): Invalid device/)
})

test('start times out without the announcement and stops the child', async () => {
  const { spawnRecord, spawned } = fakeRecordSpawn({ announce: false })
  const recorder = new Recorder({ dir: tempDir(), spawnRecord, startTimeoutMs: 50 })
  await assert.rejects(recorder.start('BBB'), /did not report "Recording started"/)
  assert.deepEqual(spawned[0]?.signals, ['SIGINT'])
})

test('stop without a recording and bad extensions are rejected', async () => {
  const recorder = new Recorder({ dir: tempDir(), spawnRecord: fakeRecordSpawn().spawnRecord })
  await assert.rejects(recorder.stop('BBB'), /no recording is running/)
  await assert.rejects(recorder.start('BBB', join(tempDir(), 'x.gif')), /\.mov or \.mp4/)
})

test('recordVideoArgs records h264 and overwrites', () => {
  assert.deepEqual(recordVideoArgs('BBB', '/tmp/a.mov'), ['simctl', 'io', 'BBB', 'recordVideo', '--codec=h264', '--force', '/tmp/a.mov'])
})
