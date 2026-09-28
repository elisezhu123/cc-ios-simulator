import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  SimctlError,
  bootDevice,
  clearLocation,
  getDevice,
  locationSetArgs,
  openUrl,
  parseDeviceList,
  sendPush,
  setAppearance,
  setLocation,
  setSimctlRunnerForTests,
  shutdownDevice,
} from '../src/simctl.js'

const LIST_JSON = JSON.stringify({
  devices: {
    'com.apple.CoreSimulator.SimRuntime.iOS-18-0': [
      { udid: 'AAA', name: 'iPhone 16', state: 'Shutdown', isAvailable: true, deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-16' },
    ],
    'com.apple.CoreSimulator.SimRuntime.iOS-26-0': [
      { udid: 'BBB', name: 'iPhone 16', state: 'Booted', isAvailable: true },
      { udid: 'CCC', name: 'iPad Air', state: 'Shutdown', isAvailable: true },
      { udid: 'DDD', name: 'Broken', state: 'Shutdown', isAvailable: false },
    ],
  },
})

/** Route simctl through a fake keyed by subcommand; records every call. */
function fakeRunner(responses: Record<string, string | Error> = {}): string[][] {
  const calls: string[][] = []
  setSimctlRunnerForTests(async args => {
    calls.push([...args])
    const reply = responses[args[0] ?? '']
    if (reply instanceof Error) throw reply
    return reply ?? ''
  })
  return calls
}

afterEach(() => setSimctlRunnerForTests())

test('parseDeviceList keeps available devices with their runtime and device type', () => {
  const devices = parseDeviceList(LIST_JSON)
  assert.deepEqual(devices.map(device => device.udid), ['AAA', 'BBB', 'CCC'])
  assert.equal(devices[0]?.runtime, 'com.apple.CoreSimulator.SimRuntime.iOS-18-0')
  assert.equal(devices[0]?.deviceType, 'com.apple.CoreSimulator.SimDeviceType.iPhone-16')
  assert.equal(devices[1]?.deviceType, undefined)
})

test('parseDeviceList rejects output that is not JSON', () => {
  assert.throws(() => parseDeviceList('oops'), SimctlError)
})

test('getDevice resolves a udid first, then a name preferring the booted device', async () => {
  fakeRunner({ list: LIST_JSON })
  assert.equal((await getDevice('CCC')).name, 'iPad Air')
  assert.equal((await getDevice('iphone 16')).udid, 'BBB')
  await assert.rejects(getDevice('Nope'), /unknown simulator "Nope".*ios_sim_devices/)
})

test('bootDevice tolerates an already-booted device and waits for bootstatus', async () => {
  const calls = fakeRunner({ boot: new SimctlError('boot failed', 'Unable to boot device in current state: Booted') })
  await bootDevice('BBB')
  assert.deepEqual(calls, [['boot', 'BBB'], ['bootstatus', 'BBB', '-b']])
})

test('shutdownDevice tolerates an already-shutdown device', async () => {
  fakeRunner({ shutdown: new SimctlError('shutdown failed', 'Unable to shutdown device in current state: Shutdown') })
  await shutdownDevice('AAA')
})

test('locationSetArgs joins latitude and longitude into ONE argument', () => {
  assert.deepEqual(locationSetArgs('BBB', 37.7749, -122.4194), ['location', 'BBB', 'set', '37.7749,-122.4194'])
  assert.throws(() => locationSetArgs('BBB', 91, 0), /latitude/)
  assert.throws(() => locationSetArgs('BBB', 0, -181), /longitude/)
})

test('the new wrappers hand argument arrays straight to simctl', async () => {
  const calls = fakeRunner()
  await openUrl('BBB', 'myapp://x?y=1 2')
  await sendPush('BBB', 'com.example.app', '/tmp/p.json')
  await setLocation('BBB', 1.5, 2.5)
  await clearLocation('BBB')
  await setAppearance('BBB', 'dark')
  assert.deepEqual(calls, [
    ['openurl', 'BBB', 'myapp://x?y=1 2'],
    ['push', 'BBB', 'com.example.app', '/tmp/p.json'],
    ['location', 'BBB', 'set', '1.5,2.5'],
    ['location', 'BBB', 'clear'],
    ['ui', 'BBB', 'appearance', 'dark'],
  ])
})
