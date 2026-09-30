import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import {
  attachBundleIds,
  classifyDevicectlFailure,
  Devicectl,
  devicectlRunner,
  parseDevicectlApps,
  parseDevicectlDevices,
  parseDevicectlProcesses,
  type DevicectlResult,
} from '../src/devicectl.js'

const DEVICES_JSON = {
  info: { outcome: 'success' },
  result: {
    devices: [
      {
        identifier: '11111111-2222-3333-4444-555555555555',
        deviceProperties: { name: 'Test iPhone', osVersionNumber: '26.0', developerModeStatus: 'enabled', bootState: 'booted' },
        hardwareProperties: { udid: '00008150-000A1B2C3D4E5F6G', marketingName: 'iPhone 17 Pro', productType: 'iPhone18,1', platform: 'iOS', reality: 'physical' },
        connectionProperties: { pairingState: 'paired', tunnelState: 'connected', transportType: 'wired' },
      },
      // An offline iPad reports almost nothing, not even a reality: it stays.
      { identifier: 'AAAAAAAA-0000-0000-0000-000000000000', deviceProperties: { name: 'Old iPad' } },
      { identifier: 'SIM', deviceProperties: { name: 'iPhone 17' }, hardwareProperties: { reality: 'simulated' } },
    ],
  },
}

test('parseDevicectlDevices keeps physical devices, drops explicit simulators, derives the state', () => {
  const devices = parseDevicectlDevices(DEVICES_JSON)
  assert.deepEqual(devices.map(device => [device.name, device.state, device.connection, device.developerMode]), [
    ['Test iPhone', 'available (paired)', 'wired', 'enabled'],
    ['Old iPad', 'unavailable', 'unknown', 'unknown'],
  ])
  assert.equal(devices[0]!.hardwareUdid, '00008150-000A1B2C3D4E5F6G')
  assert.equal('osVersion' in devices[1]!, false)
  assert.deepEqual(parseDevicectlDevices({}), [])
})

test('parseDevicectlApps tells "no apps" from "nothing was listed"; processes get bundle ids from app paths', () => {
  const apps = parseDevicectlApps({ result: { apps: [
    { bundleIdentifier: 'com.apple.Preferences', name: 'Settings', defaultApp: true, url: 'file:///Applications/Preferences.app/' },
    { bundleIdentifier: 'com.example.MyApp', name: 'My App', version: '1.2', appType: 'User', url: 'file:///private/var/containers/Bundle/Application/7/My%20App.app/' },
  ] } })!
  assert.equal(apps[1]!.path, '/private/var/containers/Bundle/Application/7/My App.app/')
  assert.deepEqual(parseDevicectlApps({ result: { apps: [] } }), [])
  assert.equal(parseDevicectlApps({ result: {} }), undefined)
  const processes = parseDevicectlProcesses({ result: { runningProcesses: [
    { processIdentifier: 912, executable: 'file:///private/var/containers/Bundle/Application/7/My%20App.app/MyApp' },
    { processIdentifier: 44, executable: 'file:///usr/libexec/lockdownd' },
    { processIdentifier: 'x', executable: 'bad' },
  ] } })!
  assert.deepEqual(attachBundleIds(processes, apps), [
    { pid: 44, executable: '/usr/libexec/lockdownd', name: 'lockdownd' },
    { pid: 912, executable: '/private/var/containers/Bundle/Application/7/My App.app/MyApp', name: 'My App', bundleId: 'com.example.MyApp' },
  ])
})

test('classifyDevicectlFailure turns CoreDevice errors into what to do', () => {
  const failure = (reason: string): DevicectlResult => ({
    stdout: '', stderr: '', code: 1,
    json: { info: { outcome: 'failed' }, error: { userInfo: { NSLocalizedFailureReason: { string: reason } } } },
  })
  assert.match(classifyDevicectlFailure('launch', failure('The device is locked.')).message, /device is locked — unlock the iPhone/)
  assert.match(classifyDevicectlFailure('launch', failure('Developer Mode is disabled')).message, /Developer Mode is off/)
  assert.match(classifyDevicectlFailure('apps', failure('CoreDeviceService was unable to locate a device matching the requested device identifier.')).message,
    /not reachable by CoreDevice.*this is not the app being missing/)
  assert.match(classifyDevicectlFailure('x', { stdout: '', stderr: 'boom', code: 3 }).message, /x failed \(exit 3\): boom/)
})

/** A devicectl runner answering by the joined arguments. */
function scripted(answers: Record<string, DevicectlResult>): { run: (args: readonly string[]) => Promise<DevicectlResult>; calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    run: async args => {
      const key = args.join(' ')
      calls.push(key)
      const answer = answers[key]
      if (answer === undefined) throw new Error(`no scripted answer for devicectl ${key}`)
      return answer
    },
  }
}

const ok = (result: unknown): DevicectlResult => ({ stdout: '', stderr: '', code: 0, json: { info: { outcome: 'success' }, result } })
const UDID = '11111111-2222-3333-4444-555555555555'
const APPS_ARGS = `device info apps --device ${UDID} --include-default-apps --include-app-clips --include-removable-apps`

test('Devicectl resolves devices by udid, hardware udid or name, and lists nothing off macOS', async () => {
  const devicectl = new Devicectl({ run: scripted({ 'list devices': { stdout: '', stderr: '', code: 0, json: DEVICES_JSON } }).run, platform: 'darwin' })
  assert.equal((await devicectl.getDevice('00008150-000A1B2C3D4E5F6G')).name, 'Test iPhone')
  assert.equal((await devicectl.getDevice('test iphone')).udid, UDID)
  await assert.rejects(devicectl.getDevice('Nope'), /no connected iPhone or iPad matches "Nope"; connected: Test iPhone/)
  assert.equal(await devicectl.matches('Nope'), false)
  assert.deepEqual(await new Devicectl({ run: async () => { throw new Error('never') }, platform: 'linux' }).listDevices(), [])
})

test('Devicectl requires success in the JSON too, and a listing without apps is an error', async () => {
  const exitZeroButFailed: DevicectlResult = { stdout: '', stderr: '', code: 0, json: { info: { outcome: 'failed' }, error: { userInfo: { NSLocalizedDescription: { string: 'The device is locked.' } } } } }
  const devicectl = new Devicectl({ run: scripted({ [`device process launch --device ${UDID} com.example.MyApp`]: exitZeroButFailed, [APPS_ARGS]: ok({}) }).run, platform: 'darwin' })
  await assert.rejects(devicectl.launchApp(UDID, 'com.example.MyApp'), /device is locked/)
  await assert.rejects(devicectl.listApps(UDID), /wrote no app list.*not the same as the device having no apps/)
})

test('Devicectl terminates every process of a bundle id by pid', async () => {
  const script = scripted({
    [`device info processes --device ${UDID}`]: ok({ runningProcesses: [
      { processIdentifier: 912, executable: 'file:///var/Bundle/7/MyApp.app/MyApp' },
      { processIdentifier: 913, executable: 'file:///var/Bundle/7/MyApp.app/PlugIns/Widget.appex/Widget' },
    ] }),
    [APPS_ARGS]: ok({ apps: [{ bundleIdentifier: 'com.example.MyApp', name: 'My App', url: 'file:///var/Bundle/7/MyApp.app/' }] }),
    [`device process terminate --device ${UDID} --pid 912`]: ok({}),
    [`device process launch --device ${UDID} com.example.MyApp`]: ok({ process: { processIdentifier: 1001 } }),
  })
  const devicectl = new Devicectl({ run: script.run, platform: 'darwin' })
  assert.deepEqual(await devicectl.terminateApp(UDID, 'com.example.MyApp'), { pids: [912] })
  await assert.rejects(devicectl.terminateApp(UDID, 'com.example.Other'), /no running process of "com.example.Other"/)
  assert.deepEqual(await devicectl.launchApp(UDID, 'com.example.MyApp'), { pid: 1001 })
})

test('devicectlRunner passes --timeout and --json-output, reads the JSON, and removes the file', async () => {
  let seen: readonly string[] = []
  const run = devicectlRunner(async options => {
    seen = options.args
    const jsonPath = options.args[options.args.indexOf('--json-output') + 1]!
    writeFileSync(jsonPath, JSON.stringify({ info: { outcome: 'success' }, result: { devices: [] } }))
    return { stdout: '', stderr: '', code: 0, killed: false }
  })
  const result = await run(['list', 'devices'], 30_000)
  assert.deepEqual(seen.slice(0, 3), ['devicectl', '--timeout', '30'])
  assert.deepEqual(seen.slice(-2), ['list', 'devices'])
  assert.deepEqual(result.json, { info: { outcome: 'success' }, result: { devices: [] } })
  const stuck = devicectlRunner(async () => { throw new Error('devicectl list devices exceeded its 35000 ms deadline and was killed') })
  await assert.rejects(stuck(['list', 'devices'], 30_000), /deadline.*the device tunnel may be stuck/)
})
