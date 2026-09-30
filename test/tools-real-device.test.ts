import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ToolDeps } from '../src/deps.js'
import type { RealApp, RealDevice } from '../src/devicectl.js'
import { registerAppTools } from '../src/tools/apps.js'
import { registerCoreTools } from '../src/tools/core.js'
import { registerDebugTools } from '../src/tools/debug.js'
import { registerUiTools } from '../src/tools/ui.js'
import { fakeRealDevices, IPHONE } from './helpers/fakes.js'
import { textOf, toolHarness } from './helpers/harness.js'

const APPS: RealApp[] = [
  { bundleId: 'com.apple.Preferences', name: 'Settings', defaultApp: true, path: '/Applications/Preferences.app' },
  { bundleId: 'com.example.MyApp', name: 'My App', version: '1.2', bundleVersion: '42', appType: 'User', path: '/var/Bundle/7/MyApp.app' },
]

async function realHarness(options: Parameters<typeof fakeRealDevices>[0] = {}) {
  const real = fakeRealDevices({ devices: [IPHONE], apps: APPS, ...options })
  const register = (server: McpServer, deps: ToolDeps): void => {
    registerCoreTools(server, deps)
    registerAppTools(server, deps)
    registerDebugTools(server, deps)
    registerUiTools(server, deps)
  }
  const h = await toolHarness(register, { deps: { realDevices: real.api } })
  return { ...h, realCalls: real.calls }
}

test('ios_sim_devices lists connected iPhones under realDevices, and survives a devicectl failure', async () => {
  const h = await realHarness()
  const body = h.json(await h.call('ios_sim_devices')) as { devices: unknown[]; realDevices: RealDevice[] }
  assert.equal(body.devices.length, 4)
  assert.deepEqual(body.realDevices.map(device => device.name), ['Test iPhone'])
  await h.close()
  const broken = await toolHarness(registerCoreTools, { deps: { realDevices: { ...fakeRealDevices().api, listDevices: async () => { throw new Error('devicectl list devices failed: xcrun: error') } } } })
  const partial = broken.json(await broken.call('ios_sim_devices')) as { devices: unknown[]; realDevicesError: string }
  assert.equal(partial.devices.length, 4)
  assert.match(partial.realDevicesError, /xcrun: error/)
  await broken.close()
})

test('ios_sim_list_apps on an iPhone uses devicectl and hints that names are base names', async () => {
  const h = await realHarness()
  const body = h.json(await h.call('ios_sim_list_apps', { udid: 'Test iPhone', include_system: true })) as { device: { udid: string; runtime: string }; apps: Array<{ bundleId: string; system: boolean }> }
  assert.deepEqual([body.device.udid, body.device.runtime], [IPHONE.udid, 'iOS 26.0'])
  assert.deepEqual(body.apps.map(app => [app.bundleId, app.system]), [['com.example.MyApp', false], ['com.apple.Preferences', true]])
  const miss = h.json(await h.call('ios_sim_list_apps', { udid: IPHONE.hardwareUdid!, query: '设置' })) as { count: number; hint: string }
  assert.equal(miss.count, 0)
  assert.match(miss.hint, /base \(usually English\) name/)
  await h.close()
})

test('ios_sim_launch_app on an iPhone resolves the name and relaunches through devicectl', async () => {
  const h = await realHarness()
  const body = h.json(await h.call('ios_sim_launch_app', { udid: 'Test iPhone', name: 'my app', relaunch: true })) as { bundleId: string; pid: number; relaunched: boolean }
  assert.deepEqual([body.bundleId, body.pid, body.relaunched], ['com.example.MyApp', 777, true])
  assert.deepEqual(h.realCalls, [`terminate ${IPHONE.udid} com.example.MyApp`, `launch ${IPHONE.udid} com.example.MyApp`])
  await h.close()
})

test('ios_sim_install_app installs on an iPhone; uninstall refuses a real device', async () => {
  const h = await realHarness()
  const appPath = join(mkdtempSync(join(tmpdir(), 'ios-sim-app-')), 'MyApp.app')
  mkdirSync(appPath)
  writeFileSync(join(appPath, 'Info.plist'), '<plist/>')
  const body = h.json(await h.call('ios_sim_install_app', { udid: 'Test iPhone', appPath })) as { installed: boolean; device: { udid: string } }
  assert.deepEqual([body.installed, body.device.udid], [true, IPHONE.udid])
  assert.deepEqual(h.realCalls, [`install ${IPHONE.udid} ${appPath}`])
  const refused = await h.call('ios_sim_uninstall_app', { udid: 'Test iPhone', bundleId: 'com.example.MyApp' })
  assert.match(textOf(refused), /is a connected iPhone\/iPad, and this tool works on simulators only/)
  await h.close()
})

test('ios_sim_processes and ios_sim_app_info read the iPhone through devicectl', async () => {
  const h = await realHarness({ processes: [{ pid: 912, executable: '/var/Bundle/7/MyApp.app/MyApp', name: 'My App', bundleId: 'com.example.MyApp' }] })
  const processes = h.json(await h.call('ios_sim_processes', { udid: 'Test iPhone' })) as { processes: unknown[]; note: string }
  assert.deepEqual(processes.processes, [{ pid: 912, name: 'My App', bundleId: 'com.example.MyApp' }])
  assert.match(processes.note, /pids live on the device/)
  const info = h.json(await h.call('ios_sim_app_info', { udid: 'Test iPhone', bundle_id: 'com.example.MyApp' })) as Record<string, unknown>
  assert.deepEqual([info.installed, info.appPath, info.version, info.shortVersion, info.applicationType], [true, '/var/Bundle/7/MyApp.app', '42', '1.2', 'User'])
  const missing = h.json(await h.call('ios_sim_app_info', { udid: 'Test iPhone', bundle_id: 'com.example.Nope' })) as { installed: boolean; note: string }
  assert.equal(missing.installed, false)
  assert.match(missing.note, /ios_sim_list_apps/)
  await h.close()
})

test('simulator-only tools name the tools that work on a real device; an unknown udid keeps the simulator error', async () => {
  const h = await realHarness()
  for (const [tool, args] of [['ios_sim_screenshot', {}], ['ios_sim_ui_tree', {}], ['ios_sim_backtrace', { pid: 1 }]] as const) {
    const result = await h.call(tool, { udid: 'Test iPhone', ...args })
    assert.match(textOf(result), /connected iPhone\/iPad.*ios_sim_list_apps, ios_sim_launch_app/)
  }
  assert.match(textOf(await h.call('ios_sim_list_apps', { udid: 'Nope' })), /unknown simulator "Nope"/)
  await h.close()
})

test('a real device that is not paired is refused with how to fix it', async () => {
  const h = await realHarness({ devices: [{ ...IPHONE, pairingState: 'unpaired', state: 'available' }] })
  assert.match(textOf(await h.call('ios_sim_list_apps', { udid: 'Test iPhone' })), /not available \(available\).*Trust This Computer/)
  await h.close()
})
