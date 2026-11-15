import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerManageTools } from '../src/tools/manage.js'
import { textOf, toolHarness } from './helpers/harness.js'

const IPHONE_17 = 'com.apple.CoreSimulator.SimDeviceType.iPhone-17'
const IOS_26 = 'com.apple.CoreSimulator.SimRuntime.iOS-26-0'

test('ios_sim_create resolves the device type by name and defaults to the newest runtime that runs it', async () => {
  const h = await toolHarness(registerManageTools)
  const body = h.json(await h.call('ios_sim_create', { deviceType: 'iphone 17' })) as { created: boolean; device: { udid: string; name: string; runtime: string; state: string } }
  assert.equal(body.created, true)
  assert.deepEqual([body.device.name, body.device.runtime, body.device.state], ['iPhone 17', IOS_26, 'Shutdown'])
  // iOS 9.3 sorts after 26.0 as text; the newest by version is 26.0.
  await h.call('ios_sim_create', { deviceType: 'iPad Air', name: 'Test pad' })
  await h.call('ios_sim_create', { deviceType: 'iPad Air', runtime: '18.0' })
  assert.deepEqual(h.simctlCalls, [
    ['create', 'iPhone 17', IPHONE_17, IOS_26],
    ['create', 'Test pad', 'com.apple.CoreSimulator.SimDeviceType.iPad-Air', IOS_26],
    ['create', 'iPad Air', 'com.apple.CoreSimulator.SimDeviceType.iPad-Air', 'com.apple.CoreSimulator.SimRuntime.iOS-18-0'],
  ])
  await h.close()
})

test('ios_sim_create names what it could not find, and a runtime that cannot run the device', async () => {
  const h = await toolHarness(registerManageTools)
  assert.match(textOf(await h.call('ios_sim_create', { deviceType: 'iPhone 99' })), /unknown device type "iPhone 99".*iPhone 17 Pro, iPhone 17/s)
  assert.match(textOf(await h.call('ios_sim_create', { deviceType: 'iPhone 17', runtime: 'iOS 99' })), /unknown runtime "iOS 99".*iOS 26\.0/s)
  assert.match(textOf(await h.call('ios_sim_create', { deviceType: 'iPhone 17', runtime: 'iOS 18.0' })), /iOS 18\.0 cannot run iPhone 17/)
  assert.deepEqual(h.simctlCalls, [])
  await h.close()
})

test('ios_sim_delete only previews until confirm:true, takes an exact udid, and never deletes a booted device', async () => {
  const h = await toolHarness(registerManageTools)
  const preview = h.json(await h.call('ios_sim_delete', { udid: 'CCC' })) as { deleted: boolean; wouldDelete: Array<{ udid: string; name: string }>; confirm: string }
  assert.equal(preview.deleted, false)
  assert.deepEqual(preview.wouldDelete.map(device => [device.udid, device.name]), [['CCC', 'iPad Air']])
  assert.match(preview.confirm, /confirm: true/)
  assert.deepEqual(h.simctlCalls, [], 'a preview deletes nothing')

  assert.match(textOf(await h.call('ios_sim_delete', { udid: 'iPad Air', confirm: true })), /exact udid/)
  assert.match(textOf(await h.call('ios_sim_delete', { udid: 'BBB', confirm: true })), /iPhone 17 Pro is Booted.*ios_sim_shutdown/s)
  assert.match(textOf(await h.call('ios_sim_delete', { confirm: true })), /udid.*or unavailable: true/s)
  assert.match(textOf(await h.call('ios_sim_delete', { udid: 'CCC', unavailable: true, confirm: true })), /either a udid or unavailable/)
  assert.deepEqual(h.simctlCalls, [])

  const done = h.json(await h.call('ios_sim_delete', { udid: 'CCC', confirm: true })) as { deleted: boolean; devices: Array<{ udid: string }> }
  assert.deepEqual([done.deleted, done.devices.map(device => device.udid)], [true, ['CCC']])
  assert.deepEqual(h.simctlCalls, [['delete', 'CCC']])
  await h.close()
})

test('ios_sim_delete unavailable:true lists the unusable devices, then removes exactly those', async () => {
  const h = await toolHarness(registerManageTools)
  const preview = h.json(await h.call('ios_sim_delete', { unavailable: true })) as { deleted: boolean; wouldDelete: Array<{ udid: string; reason?: string }> }
  assert.deepEqual([preview.deleted, preview.wouldDelete.map(device => device.udid)], [false, ['GONE-1']])
  assert.equal(preview.wouldDelete[0]?.reason, 'runtime profile not found')
  const done = h.json(await h.call('ios_sim_delete', { unavailable: true, confirm: true })) as { deleted: boolean; devices: unknown[] }
  assert.deepEqual([done.deleted, done.devices.length], [true, 1])
  assert.deepEqual(h.simctlCalls, [['delete-unavailable']])
  const none = h.json(await h.call('ios_sim_delete', { unavailable: true, confirm: true })) as { deleted: boolean; devices: unknown[] }
  assert.deepEqual([none.deleted, none.devices.length], [false, 0])
  await h.close()
})

test('ios_sim_erase previews, then erases a shut-down device only', async () => {
  const h = await toolHarness(registerManageTools)
  const preview = h.json(await h.call('ios_sim_erase', { udid: 'CCC' })) as { erased: boolean; wouldErase: { udid: string } }
  assert.deepEqual([preview.erased, preview.wouldErase.udid], [false, 'CCC'])
  assert.match(textOf(await h.call('ios_sim_erase', { udid: 'BBB', confirm: true })), /is Booted.*ios_sim_shutdown/s)
  assert.match(textOf(await h.call('ios_sim_erase', { udid: 'nope', confirm: true })), /exact udid/)
  assert.deepEqual(h.simctlCalls, [])
  assert.equal((h.json(await h.call('ios_sim_erase', { udid: 'CCC', confirm: true })) as { erased: boolean }).erased, true)
  assert.deepEqual(h.simctlCalls, [['erase', 'CCC']])
  await h.close()
})
