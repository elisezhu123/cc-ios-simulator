import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerCoreTools } from '../src/tools/core.js'
import { textOf, toolHarness } from './helpers/harness.js'

test('ios_sim_devices lists booted-first and names the streamed device', async () => {
  const h = await toolHarness(registerCoreTools, { host: { device: 'BBB' } })
  const body = h.json(await h.call('ios_sim_devices')) as { devices: { udid: string; deviceType?: string }[]; booted: string[]; streaming: string }
  assert.deepEqual(body.devices.map((device: { udid: string }) => device.udid), ['BBB', 'EEE', 'CCC', 'AAA'])
  assert.deepEqual(body.booted, ['BBB', 'EEE'])
  assert.equal(body.streaming, 'BBB')
  assert.equal(body.devices[0].deviceType, 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro')
  const filtered = h.json(await h.call('ios_sim_devices', { query: 'ipad' })) as { devices: { udid: string }[] }
  assert.deepEqual(filtered.devices.map((device: { udid: string }) => device.udid), ['CCC'])
  await h.close()
})

test('ios_sim_boot starts the stream and returns the panel url', async () => {
  const h = await toolHarness(registerCoreTools)
  const body = h.json(await h.call('ios_sim_boot', { udid: 'iPad Air' })) as { device: { udid: string; state: string }; streaming: boolean; panelUrl: string }
  assert.equal(body.device.udid, 'CCC')
  assert.equal(body.device.state, 'Booted')
  assert.equal(body.streaming, true)
  assert.equal(body.panelUrl, 'http://127.0.0.1:3999/')
  assert.deepEqual(h.hostCalls, [['ensureRunning', 'CCC']])
  await h.close()
})

test('ios_sim_boot degrades to a plain boot when serve-sim is unavailable', async () => {
  const h = await toolHarness(registerCoreTools, { host: { available: false } })
  const body = h.json(await h.call('ios_sim_boot', { udid: 'CCC' })) as { streaming: boolean; note: string }
  assert.equal(body.streaming, false)
  assert.match(body.note, /serve-sim is unavailable/)
  assert.deepEqual(h.simctlCalls, [['boot', 'CCC']])
  await h.close()
})

test('ios_sim_shutdown stops the stream of the streamed device first', async () => {
  const h = await toolHarness(registerCoreTools, { host: { device: 'BBB' } })
  const body = h.json(await h.call('ios_sim_shutdown', { udid: 'BBB' })) as { state: string }
  assert.equal(body.state, 'shutdown')
  assert.deepEqual(h.hostCalls, [['stop']])
  assert.deepEqual(h.simctlCalls, [['shutdown', 'BBB']])
  await h.close()
})

test('ios_sim_panel refuses a shut-down device instead of booting it', async () => {
  const h = await toolHarness(registerCoreTools)
  const result = await h.call('ios_sim_panel', { udid: 'CCC' })
  assert.equal(result.isError, true)
  assert.match(textOf(result), /^ios_sim_panel: iPad Air is Shutdown — boot it first with ios_sim_boot/)
  assert.deepEqual(h.hostCalls, [])
  const ok = h.json(await h.call('ios_sim_panel')) as { panelUrl: string; device: { udid: string } }
  assert.equal(ok.panelUrl, 'http://127.0.0.1:3999/')
  assert.equal(ok.device.udid, 'BBB')
  await h.close()
})

test('ios_sim_screenshot returns a JPEG image block plus the summary', async () => {
  const h = await toolHarness(registerCoreTools)
  const result = await h.call('ios_sim_screenshot')
  const image = result.content.find(block => block.type === 'image')
  assert.ok(image !== undefined && image.type === 'image')
  assert.equal(image.mimeType, 'image/jpeg')
  const body = h.json(result) as { device: { udid: string }; width: number; image: { width: number; height: number } }
  assert.equal(body.device.udid, 'BBB')
  assert.equal(body.width, 1206)
  assert.deepEqual(body.image, { width: 471, height: 1024 })
  await h.close()
})

test('ios_sim_interact taps through serve-sim and returns the effect screenshot', async () => {
  const h = await toolHarness(registerCoreTools, { host: { device: 'BBB' } })
  const result = await h.call('ios_sim_interact', { action: 'tap', x: 0.5, y: 0.25 })
  assert.equal(result.isError, undefined)
  assert.ok(h.hostCalls.some(call => call.join(' ') === 'control tap -d BBB 0.5 0.25'))
  assert.ok(result.content.some(block => block.type === 'image'))
  assert.equal((h.json(result) as { delivery: { channel: string } }).delivery.channel, 'cli')
  await h.close()
})

test('ios_sim_interact rotate and device_action go through the stream source', async () => {
  const h = await toolHarness(registerCoreTools, { host: { device: 'BBB' } })
  await h.call('ios_sim_interact', { action: 'rotate', orientation: 'landscape_left', screenshot: false })
  await h.call('ios_sim_interact', { action: 'device_action', name: 'lock', screenshot: false })
  const controls = h.hostCalls.filter(call => call[0] === 'control').map(call => call.slice(1).join(' '))
  assert.deepEqual(controls, ['rotate landscape_left -d BBB', 'button lock -d BBB'])
  await h.close()
})

test('ios_sim_interact explains bad arguments, a missing serve-sim and a non-Mac host', async () => {
  const h = await toolHarness(registerCoreTools, { host: { device: 'BBB' } })
  assert.match(textOf(await h.call('ios_sim_interact', { action: 'rotate' })), /requires orientation/)
  assert.match(textOf(await h.call('ios_sim_interact', { action: 'device_action', name: 'reboot' })), /requires name — one of app-switcher/)
  assert.match(textOf(await h.call('ios_sim_interact', { action: 'type', text: '中文' })), /US-keyboard ASCII/)
  await h.close()
  const noServeSim = await toolHarness(registerCoreTools, { host: { available: false } })
  assert.match(textOf(await noServeSim.call('ios_sim_interact', { action: 'tap', x: 0.5, y: 0.5 })), /serve-sim is unavailable/)
  await noServeSim.close()
  const linux = await toolHarness(registerCoreTools, { deps: { platform: 'linux' } })
  assert.match(textOf(await linux.call('ios_sim_devices')), /iOS Simulator requires macOS with Xcode/)
  await linux.close()
})
