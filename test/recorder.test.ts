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
