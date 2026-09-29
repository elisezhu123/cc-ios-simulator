import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { registerEnvTools } from '../src/tools/env.js'
import { textOf, toolHarness } from './helpers/harness.js'

test('ios_sim_open_url requires a scheme and forwards the url', async () => {
  const h = await toolHarness(registerEnvTools)
  assert.match(textOf(await h.call('ios_sim_open_url', { url: 'example.com' })), /needs a scheme/)
  assert.equal((h.json(await h.call('ios_sim_open_url', { url: 'myapp://profile/1' })) as { opened: boolean }).opened, true)
  assert.deepEqual(h.simctlCalls, [['openurl', 'BBB', 'myapp://profile/1']])
  await h.close()
})

test('ios_sim_push writes a private payload file and removes it afterwards', async () => {
  const h = await toolHarness(registerEnvTools)
  assert.match(textOf(await h.call('ios_sim_push', { bundleId: 'com.x', payload: { alert: 'no aps' } })), /"aps" object/)
  await h.call('ios_sim_push', { bundleId: 'com.x', payload: { aps: { alert: 'Hi' } } })
  assert.deepEqual(h.simctlCalls, [['push', 'BBB', 'com.x', { aps: { alert: 'Hi' } }]])
  assert.deepEqual(readdirSync(join(h.deps.cacheRoot, 'tmp')), [] as string[])
  await h.close()
})

test('ios_sim_location sets, clears and validates', async () => {
  const h = await toolHarness(registerEnvTools)
  await h.call('ios_sim_location', { latitude: 37.7749, longitude: -122.4194 })
  await h.call('ios_sim_location', { clear: true })
  assert.match(textOf(await h.call('ios_sim_location', { latitude: 1 })), /both latitude and longitude/)
  assert.equal((await h.call('ios_sim_location', { latitude: 100, longitude: 0 })).isError, true)
  assert.deepEqual(h.simctlCalls, [['location', 'BBB', 37.7749, -122.4194], ['location-clear', 'BBB']])
  await h.close()
})

test('ios_sim_appearance switches to dark mode', async () => {
  const h = await toolHarness(registerEnvTools)
  assert.equal((h.json(await h.call('ios_sim_appearance', { appearance: 'dark' })) as { appearance: string }).appearance, 'dark')
  assert.deepEqual(h.simctlCalls, [['appearance', 'BBB', 'dark']])
  await h.close()
})

test('ios_sim_record starts and stops one recording per device', async () => {
  const h = await toolHarness(registerEnvTools)
  const started = h.json(await h.call('ios_sim_record', { action: 'start' })) as { recording: boolean; path: string }
  assert.equal(started.recording, true)
  assert.match(started.path, /recording-BBB-/)
  const stopped = h.json(await h.call('ios_sim_record', { action: 'stop' })) as { recording: boolean; bytes: number }
  assert.equal(stopped.recording, false)
  assert.equal(stopped.bytes, 2048)
  assert.match(textOf(await h.call('ios_sim_record', { action: 'stop' })), /no recording is running/)
  await h.close()
})

test('ios_sim_record stop works after the device shut down; start still needs a booted device', async () => {
  const h = await toolHarness(registerEnvTools)
  await h.call('ios_sim_record', { action: 'start', udid: 'BBB' })
  await h.deps.simctl.shutdownDevice('BBB')
  const stopped = await h.call('ios_sim_record', { action: 'stop', udid: 'BBB' })
  assert.equal(stopped.isError, undefined)
  assert.equal((h.json(stopped) as { bytes: number }).bytes, 2048)
  assert.match(textOf(await h.call('ios_sim_record', { action: 'start', udid: 'BBB' })), /is Shutdown — boot it first/)
  await h.close()
})
