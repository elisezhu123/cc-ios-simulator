import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { PreviewApi } from '../src/deps.js'
import type { PreviewStatus } from '../src/preview-host.js'
import type { SimulatorDevice } from '../src/simctl.js'
import { registerPreviewTools } from '../src/tools/preview.js'
import { textOf, toolHarness, type HarnessOptions } from './helpers/harness.js'

function fakePreview(): { api: PreviewApi; starts: Array<{ packagePath: string; device: SimulatorDevice; previewFilter?: string }> } {
  const starts: Array<{ packagePath: string; device: SimulatorDevice; previewFilter?: string }> = []
  let running: PreviewStatus = { running: false }
  const api: PreviewApi = {
    start: async options => {
      starts.push({ packagePath: options.packagePath, device: options.device, ...(options.previewFilter === undefined ? {} : { previewFilter: options.previewFilter }) })
      running = { running: true, device: { udid: options.device.udid, name: options.device.name }, generation: 1, loadedGeneration: 1 }
      return running
    },
    status: () => running,
    stop: async () => {
      if (!running.running) return { stopped: false }
      running = { running: false }
      return { stopped: true, device: { udid: 'BBB', name: 'iPhone 17 Pro', runtime: 'iOS-26-0', state: 'Booted' }, reloads: 4 }
    },
  }
  return { api, starts }
}

async function previewHarness(options: HarnessOptions = {}) {
  const preview = fakePreview()
  const h = await toolHarness((server, deps) => {
    deps.preview = preview.api
    registerPreviewTools(server, deps)
  }, options)
  return { ...h, starts: preview.starts }
}

test('ios_sim_preview start runs on a booted device, starts the stream and returns the panel', async () => {
  const h = await previewHarness({ host: { device: 'BBB' } })
  const body = h.json(await h.call('ios_sim_preview', { packagePath: '/p/Demo', previewFilter: 'card' })) as { running: boolean; panelUrl: string }
  assert.deepEqual(h.starts, [{ packagePath: '/p/Demo', device: { udid: 'BBB', name: 'iPhone 17 Pro', runtime: 'com.apple.CoreSimulator.SimRuntime.iOS-26-0', state: 'Booted', deviceType: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro' }, previewFilter: 'card' }])
  assert.deepEqual([body.running, body.panelUrl], [true, 'http://127.0.0.1:3999/'])
  const status = h.json(await h.call('ios_sim_preview', { action: 'status' })) as { running: boolean; generation: number }
  assert.deepEqual([status.running, status.generation], [true, 1])
  const stopped = h.json(await h.call('ios_sim_preview', { action: 'stop' })) as { stopped: boolean; reloads: number }
  assert.deepEqual([stopped.stopped, stopped.reloads], [true, 4])
  await h.close()
})

test('ios_sim_preview needs a packagePath, and still runs (without a panel) when serve-sim is unavailable', async () => {
  const h = await previewHarness()
  assert.match(textOf(await h.call('ios_sim_preview', {})), /packagePath is required/)
  assert.deepEqual(h.json(await h.call('ios_sim_preview', { action: 'stop' })), { stopped: false, note: 'no preview session was running' })
  await h.close()
  const noStream = await previewHarness({ host: { available: false } })
  const body = noStream.json(await noStream.call('ios_sim_preview', { packagePath: '/p/Demo' })) as { running: boolean; note: string }
  assert.equal(body.running, true)
  assert.match(body.note, /Simulator\.app.*serve-sim/)
  await noStream.close()
})
