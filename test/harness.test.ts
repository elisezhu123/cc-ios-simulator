import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deviceSummary, jsonResult, runTool, UDID_PARAM } from '../src/tools/result.js'
import { toolHarness } from './helpers/harness.js'

test('the tool harness wires fakes into an in-memory MCP client', async () => {
  const harness = await toolHarness((server, deps) => {
    server.registerTool('probe', { inputSchema: { udid: UDID_PARAM } }, async ({ udid }) =>
      runTool('probe', async () => jsonResult({ device: deviceSummary(await deps.simctl.getDevice(udid ?? 'BBB')) })))
  })
  const result = harness.json(await harness.call('probe', { udid: 'CCC' })) as { device: { name: string } }
  assert.equal(result.device.name, 'iPad Air')
  await harness.close()
})
