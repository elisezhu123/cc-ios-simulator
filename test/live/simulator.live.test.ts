import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

const LIVE = process.env.IOS_SIM_SMOKE === '1'
const ROOT = fileURLToPath(new URL('../..', import.meta.url))

let client: Client | undefined
let udid = ''
let bootedHere = false

async function call(name: string, args: Record<string, unknown> = {}): Promise<{ result: CallToolResult; body: any }> {
  if (client === undefined) throw new Error('client not connected')
  const result = (await client.callTool({ name, arguments: args })) as CallToolResult
  const first = result.content[0]
  const text = first !== undefined && first.type === 'text' ? first.text : ''
  if (result.isError === true) throw new Error(`${name} failed: ${text}`)
  return { result, body: JSON.parse(text) }
}

before(async () => {
  if (!LIVE) return
  const env = Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined)) as Record<string, string>
  client = new Client({ name: 'live-smoke', version: '0.0.0' })
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [join(ROOT, 'dist/server.js')],
    cwd: ROOT,
    env: { ...env, IOS_SIM_CACHE_DIR: mkdtempSync(join(tmpdir(), 'ios-sim-live-')), IOS_SIM_PANEL_PORT: '3656' },
    stderr: 'inherit',
  }))
})

after(async () => {
  if (!LIVE) return
  if (bootedHere && udid !== '') await call('ios_sim_shutdown', { udid }).catch(() => undefined)
  await client?.close()
})

test('live: boot, panel, screenshot, input, rotate, record', { skip: LIVE ? false : 'set IOS_SIM_SMOKE=1 to run on a real simulator', timeout: 600_000 }, async () => {
  const { body: list } = await call('ios_sim_devices', { query: process.env.IOS_SIM_SMOKE_DEVICE ?? 'iPhone' })
  const device = list.devices[0]
  assert.ok(device !== undefined, 'no iPhone simulator found')
  udid = device.udid
  bootedHere = device.state !== 'Booted'

  const { body: boot } = await call('ios_sim_boot', { udid })
  assert.equal(boot.streaming, true)
  assert.equal((await fetch(boot.panelUrl)).status, 200)
  const status = await (await fetch(new URL('/api/status', boot.panelUrl))).json() as { running: boolean }
  assert.equal(status.running, true)

  const portrait = await call('ios_sim_screenshot', { udid })
  assert.ok(portrait.result.content.some(block => block.type === 'image'))
  console.log(`portrait screenshot: ${portrait.body.width}x${portrait.body.height}, model image ${portrait.body.image.width}x${portrait.body.image.height}`)

  await call('ios_sim_interact', { udid, action: 'button', name: 'home', screenshot: false })
  await call('ios_sim_interact', { udid, action: 'tap', x: 0.5, y: 0.5, screenshot: false })
  const scroll = await call('ios_sim_interact', { udid, action: 'scroll', direction: 'down', screenshot: false })
  assert.equal(scroll.body.delivery.channel, 'ws', `scroll fell back to the CLI: ${String(scroll.body.delivery.wsError)}`)

  await call('ios_sim_launch_app', { udid, bundleId: 'com.apple.mobilesafari' })
  await call('ios_sim_interact', { udid, action: 'rotate', orientation: 'landscape_left', screenshot: false })
  await new Promise(resolve => setTimeout(resolve, 1500))
  const landscape = await call('ios_sim_screenshot', { udid })
  console.log(`landscape screenshot: ${landscape.body.width}x${landscape.body.height}, model image ${landscape.body.image.width}x${landscape.body.image.height}`)
  await call('ios_sim_interact', { udid, action: 'rotate', orientation: 'portrait', screenshot: false })

  const started = await call('ios_sim_record', { udid, action: 'start' })
  assert.equal(started.body.recording, true)
  await new Promise(resolve => setTimeout(resolve, 2000))
  const stopped = await call('ios_sim_record', { udid, action: 'stop' })
  assert.ok(stopped.body.bytes > 0)
})
