import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

const EXPECTED_TOOLS = [
  'ios_sim_appearance',
  'ios_sim_boot',
  'ios_sim_build_run',
  'ios_sim_devices',
  'ios_sim_find_text',
  'ios_sim_install_app',
  'ios_sim_interact',
  'ios_sim_launch_app',
  'ios_sim_list_apps',
  'ios_sim_location',
  'ios_sim_open_url',
  'ios_sim_panel',
  'ios_sim_push',
  'ios_sim_record',
  'ios_sim_screenshot',
  'ios_sim_shutdown',
  'ios_sim_tap_element',
  'ios_sim_tap_row',
  'ios_sim_tap_text',
  'ios_sim_ui_rows',
  'ios_sim_ui_tree',
  'ios_sim_uninstall_app',
  'ios_sim_wait_for',
]

function childEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value
  }
  env.IOS_SIM_CACHE_DIR = mkdtempSync(join(tmpdir(), 'ios-sim-proto-'))
  env.IOS_SIM_PANEL_PORT = '3556'
  return env
}

test('the stdio MCP server lists the 23 ios_sim tools and answers calls', async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', join(ROOT, 'src/server.ts')],
    cwd: ROOT,
    env: childEnv(),
    stderr: 'pipe',
  })
  const client = new Client({ name: 'protocol-test', version: '0.0.0' })
  await client.connect(transport)
  try {
    const { tools } = await client.listTools()
    assert.deepEqual(tools.map(tool => tool.name).sort(), EXPECTED_TOOLS)
    const devices = (await client.callTool({ name: 'ios_sim_devices', arguments: {} })) as CallToolResult
    assert.notEqual(devices.isError, true)
    const invalid = (await client.callTool({ name: 'ios_sim_interact', arguments: { action: 'explode' } })) as CallToolResult
    assert.equal(invalid.isError, true)
  } finally {
    await client.close()
  }
})

test('the server shuts down cleanly on SIGHUP (its terminal or session went away)', async () => {
  const child = spawn(process.execPath, ['--import', 'tsx', join(ROOT, 'src/server.ts')], { cwd: ROOT, env: childEnv(), stdio: ['pipe', 'pipe', 'pipe'] })
  let stderr = ''
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`the server never became ready: ${stderr}`)), 20_000)
    child.stderr.on('data', chunk => {
      stderr += String(chunk)
      if (!stderr.includes('MCP server ready')) return
      clearTimeout(timer)
      resolve()
    })
  })
  const exited = once(child, 'exit') as Promise<[number | null, NodeJS.Signals | null]>
  child.kill('SIGHUP')
  const [code, signal] = await exited
  assert.deepEqual({ code, signal }, { code: 0, signal: null })
})
