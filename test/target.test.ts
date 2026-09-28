import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assertMac, ensureStreamFor, requireBooted, resolveTargetDevice, sortDevices } from '../src/target.js'
import { DEVICES, fakeHost, fakeSimctl } from './helpers/fakes.js'

test('an explicit reference wins', async () => {
  const { api } = fakeSimctl()
  const { host } = fakeHost()
  assert.equal((await resolveTargetDevice({ simctl: api, host }, 'iPad Air')).udid, 'CCC')
})

test('the streamed device comes before other booted devices', async () => {
  const { api } = fakeSimctl()
  const { host } = fakeHost({ device: 'EEE' })
  assert.equal((await resolveTargetDevice({ simctl: api, host }, undefined)).udid, 'EEE')
})

test('without a stream the newest-runtime booted iPhone is picked', async () => {
  const { api } = fakeSimctl()
  const { host } = fakeHost()
  assert.equal((await resolveTargetDevice({ simctl: api, host }, '  ')).udid, 'BBB')
})

test('bootFallback boots the newest-runtime iPhone when nothing is booted', async () => {
  const { api, calls } = fakeSimctl(DEVICES.map(device => ({ ...device, state: 'Shutdown' })))
  const { host } = fakeHost()
  const device = await resolveTargetDevice({ simctl: api, host }, undefined, { bootFallback: true })
  assert.equal(device.udid, 'BBB')
  assert.equal(device.state, 'Booted')
  assert.deepEqual(calls, [['boot', 'BBB']])
})

test('no booted device and no fallback is an actionable error', async () => {
  const { api } = fakeSimctl(DEVICES.map(device => ({ ...device, state: 'Shutdown' })))
  const { host } = fakeHost()
  await assert.rejects(resolveTargetDevice({ simctl: api, host }, undefined), /call ios_sim_boot first/)
})

test('sortDevices puts booted first, then the newest runtime, then the name', () => {
  assert.deepEqual(sortDevices(DEVICES).map(device => device.udid), ['BBB', 'EEE', 'CCC', 'AAA'])
})

test('requireBooted, assertMac and ensureStreamFor guard their preconditions', async () => {
  assert.throws(() => requireBooted('ios_sim_panel', { udid: 'CCC', name: 'iPad Air', runtime: 'r', state: 'Shutdown' }), /iPad Air is Shutdown — boot it first with ios_sim_boot/)
  assert.throws(() => assertMac('linux'), /iOS Simulator requires macOS with Xcode/)
  const unavailable = fakeHost({ available: false })
  await assert.rejects(ensureStreamFor(unavailable.host, { udid: 'BBB', name: 'x', runtime: 'r', state: 'Booted' }), /serve-sim is unavailable/)
  const available = fakeHost()
  const info = await ensureStreamFor(available.host, { udid: 'BBB', name: 'x', runtime: 'r', state: 'Booted' })
  assert.equal(info.device, 'BBB')
  assert.deepEqual(available.calls, [['ensureRunning', 'BBB']])
})
