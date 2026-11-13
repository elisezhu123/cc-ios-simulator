import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assertMac, ensureStreamFor, requireBooted, resolveTargetDevice, resolveToolTarget, sortDevices } from '../src/target.js'
import { DEVICES, fakeHost, fakeRealDevices, fakeSimctl } from './helpers/fakes.js'

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

/** A fake simctl that counts how often the device listing is consulted. */
function countingSimctl() {
  const { api, devices } = fakeSimctl()
  let lookups = 0
  const simctl = {
    ...api,
    listDevices: async () => { lookups += 1; return api.listDevices() },
    getDevice: async (reference: string) => { lookups += 1; return api.getDevice(reference) },
  }
  return { simctl, devices, lookups: () => lookups }
}

test('while a device is streamed, later calls for it skip the simctl listing — by default, by udid and by name', async () => {
  const { simctl, lookups } = countingSimctl()
  const { host } = fakeHost({ device: 'BBB' })
  const deps = { simctl, host, realDevices: fakeRealDevices().api }
  const first = await resolveTargetDevice(deps)
  assert.deepEqual([first.udid, first.state, lookups()], ['BBB', 'Booted', 1])
  assert.equal((await resolveTargetDevice(deps)).udid, 'BBB')
  assert.equal((await resolveTargetDevice(deps, 'BBB')).udid, 'BBB')
  assert.equal((await resolveTargetDevice(deps, ` ${first.name.toUpperCase()} `)).udid, 'BBB')
  assert.deepEqual(await resolveToolTarget(deps, 'BBB'), { kind: 'simulator', device: first })
  assert.equal(lookups(), 1, 'one listing for five calls')
  // Another device is still looked up, and a path that may boot always sees fresh state.
  assert.equal((await resolveTargetDevice(deps, 'CCC')).udid, 'CCC')
  await resolveTargetDevice(deps, undefined, { bootFallback: true })
  assert.equal(lookups(), 3)
})

test('the remembered device is dropped when the stream stops or moves to another device', async () => {
  const { simctl, devices, lookups } = countingSimctl()
  const { host } = fakeHost({ device: 'BBB' })
  const deps = { simctl, host }
  await resolveTargetDevice(deps)
  await host.stop()
  const shutDown = devices.find(device => device.udid === 'BBB')
  if (shutDown !== undefined) shutDown.state = 'Shutdown'
  assert.equal((await resolveTargetDevice(deps, 'BBB')).state, 'Shutdown', 'no stream: the listing is asked again')
  await host.ensureRunning({ udid: 'EEE' })
  assert.equal((await resolveTargetDevice(deps)).udid, 'EEE')
  assert.equal(lookups(), 3)
})

test('simctl is asked about the streamed device again after a minute, in case it was shut down from outside', async t => {
  t.mock.timers.enable({ apis: ['Date'] })
  const { simctl, devices, lookups } = countingSimctl()
  const { host } = fakeHost({ device: 'BBB' })
  const deps = { simctl, host }
  await resolveTargetDevice(deps)
  t.mock.timers.tick(59_000)
  await resolveTargetDevice(deps)
  assert.equal(lookups(), 1)
  const gone = devices.find(device => device.udid === 'BBB')
  if (gone !== undefined) gone.state = 'Shutdown'
  t.mock.timers.tick(2_000)
  assert.equal((await resolveTargetDevice(deps, 'BBB')).state, 'Shutdown')
  assert.equal(lookups(), 2)
})
