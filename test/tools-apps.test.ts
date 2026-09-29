import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerAppTools } from '../src/tools/apps.js'
import { DEVICES } from './helpers/fakes.js'
import { textOf, toolHarness } from './helpers/harness.js'

test('ios_sim_list_apps shows user apps and explains a miss', async () => {
  const h = await toolHarness(registerAppTools)
  assert.deepEqual((h.json(await h.call('ios_sim_list_apps')) as { apps: { bundleId: string }[] }).apps.map((app: { bundleId: string }) => app.bundleId), ['com.example.notes'])
  assert.equal((h.json(await h.call('ios_sim_list_apps', { query: 'calendar', include_system: true })) as { apps: { name: string }[] }).apps[0].name, '日历')
  const miss = h.json(await h.call('ios_sim_list_apps', { query: 'zzz' })) as { count: number; hint: string; candidates: unknown[] }
  assert.equal(miss.count, 0)
  assert.match(miss.hint, /no installed app matches/)
  assert.ok(miss.candidates.length > 0)
  await h.close()
})

test('ios_sim_launch_app resolves a localized name, relaunches and reports the pid', async () => {
  const h = await toolHarness(registerAppTools)
  const body = h.json(await h.call('ios_sim_launch_app', { name: '日历', relaunch: true })) as { bundleId: string; pid: number; relaunched: boolean }
  assert.equal(body.bundleId, 'com.apple.mobilecal')
  assert.equal(body.pid, 4242)
  assert.equal(body.relaunched, true)
  assert.deepEqual(h.simctlCalls, [['terminate', 'BBB', 'com.apple.mobilecal'], ['launch', 'BBB', 'com.apple.mobilecal']])
  await h.close()
})

test('ios_sim_launch_app wants exactly one of bundleId and name', async () => {
  const h = await toolHarness(registerAppTools)
  assert.match(textOf(await h.call('ios_sim_launch_app', {})), /bundleId is required/)
  assert.match(textOf(await h.call('ios_sim_launch_app', { bundleId: 'a', name: 'b' })), /either bundleId or name/)
  await h.close()
})

test('ios_sim_build_run boots the fallback iPhone, builds and returns the panel url', async () => {
  const h = await toolHarness(registerAppTools, { devices: DEVICES.map(device => ({ ...device, state: 'Shutdown' })) })
  const body = h.json(await h.call('ios_sim_build_run', { projectPath: '/p/App.xcodeproj' })) as { state: string; device: { udid: string }; configuration: string; panelUrl: string; durationMs: number }
  assert.equal(body.state, 'launched')
  assert.equal(body.device.udid, 'BBB')
  assert.equal(body.configuration, 'Debug')
  assert.equal(body.panelUrl, 'http://127.0.0.1:3999/')
  assert.equal(typeof body.durationMs, 'number')
  await h.close()
})

// xcodebuild honours some flags even as an option's value: `-scheme -version` prints the Xcode version.
test('ios_sim_build_run refuses a scheme that xcodebuild would read as an option, before touching a device', async () => {
  const h = await toolHarness(registerAppTools)
  const refused = await h.call('ios_sim_build_run', { projectPath: '/p/App.xcodeproj', scheme: '-version' })
  assert.equal(refused.isError, true)
  assert.match(textOf(refused), /scheme must not start with "-"/)
  assert.deepEqual(h.simctlCalls, [])
  const dashInside = h.json(await h.call('ios_sim_build_run', { projectPath: '/p/App.xcodeproj', scheme: 'My-App' })) as { scheme: string }
  assert.equal(dashInside.scheme, 'My-App')
  await h.close()
})

test('ios_sim_build_run refuses a configuration that xcodebuild would read as an option, before touching a device', async () => {
  const h = await toolHarness(registerAppTools)
  const refused = await h.call('ios_sim_build_run', { projectPath: '/p/App.xcodeproj', configuration: ' -version' })
  assert.equal(refused.isError, true)
  assert.match(textOf(refused), /configuration must not start with "-"/)
  assert.deepEqual(h.simctlCalls, [])
  await h.close()
})

test('ios_sim_install_app needs a real .app bundle and reports its bundle id', async () => {
  const h = await toolHarness(registerAppTools)
  assert.match(textOf(await h.call('ios_sim_install_app', { appPath: '/nope/App.app' })), /containing Info\.plist/)
  const app = join(mkdtempSync(join(tmpdir(), 'ios-sim-app-')), 'Demo.app')
  mkdirSync(app)
  writeFileSync(join(app, 'Info.plist'), '')
  const body = h.json(await h.call('ios_sim_install_app', { appPath: app })) as { bundleId: string }
  assert.equal(body.bundleId, 'com.example.App')
  assert.deepEqual(h.simctlCalls, [['install', 'BBB', app]])
  await h.close()
})

test('ios_sim_uninstall_app uninstalls by bundle id; app tools refuse a shut-down device', async () => {
  const h = await toolHarness(registerAppTools)
  assert.equal((h.json(await h.call('ios_sim_uninstall_app', { bundleId: ' com.example.notes ' })) as { bundleId: string }).bundleId, 'com.example.notes')
  assert.deepEqual(h.simctlCalls, [['uninstall', 'BBB', 'com.example.notes']])
  assert.match(textOf(await h.call('ios_sim_list_apps', { udid: 'CCC' })), /is Shutdown — boot it first/)
  await h.close()
})
