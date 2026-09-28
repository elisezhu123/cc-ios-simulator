import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deviceSummary, errorResult, jsonResult, runTool } from '../src/tools/result.js'

test('jsonResult carries JSON text and an optional image block', () => {
  const result = jsonResult({ ok: true }, { data: 'AAAA', mimeType: 'image/jpeg', width: 1, height: 2 })
  assert.deepEqual(result.content, [
    { type: 'text', text: '{\n  "ok": true\n}' },
    { type: 'image', data: 'AAAA', mimeType: 'image/jpeg' },
  ])
})

test('errorResult prefixes the tool name once', () => {
  assert.deepEqual(errorResult('ios_sim_x', new Error('boom')), { content: [{ type: 'text', text: 'ios_sim_x: boom' }], isError: true })
  assert.equal((errorResult('ios_sim_x', new Error('ios_sim_x: boom')).content[0] as { text: string }).text, 'ios_sim_x: boom')
})

test('runTool turns throws into error results; deviceSummary can override state', async () => {
  const result = await runTool('ios_sim_x', async () => { throw new Error('nope') })
  assert.equal(result.isError, true)
  assert.deepEqual(deviceSummary({ udid: 'A', name: 'n', runtime: 'r', state: 'Shutdown' }, 'Booted'), { udid: 'A', name: 'n', runtime: 'r', state: 'Booted' })
})
