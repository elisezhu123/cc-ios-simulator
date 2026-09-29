// Dev helper: start dist/server.js, boot a simulator and keep the live panel up until Ctrl+C.
// Usage: npm run dev:panel -- "iPhone 17 Pro"
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const query = process.argv[2] ?? 'iPhone'
const env = Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined))
const client = new Client({ name: 'dev-panel', version: '0.0.0' })
await client.connect(new StdioClientTransport({
  command: process.execPath,
  args: [join(root, 'dist/server.js')],
  cwd: root,
  env,
  stderr: 'inherit',
}))
const textOf = result => (result.content[0]?.type === 'text' ? result.content[0].text : '')
const list = JSON.parse(textOf(await client.callTool({ name: 'ios_sim_devices', arguments: { query } })))
const device = list.devices[0]
if (device === undefined) {
  console.error(`no simulator matches "${query}"`)
  await client.close()
  process.exit(1)
}
const boot = await client.callTool({ name: 'ios_sim_boot', arguments: { udid: device.udid } })
if (boot.isError === true) {
  console.error(textOf(boot))
  await client.close()
  process.exit(1)
}
console.log(`panel: ${JSON.parse(textOf(boot)).panelUrl} (${device.name}) — Ctrl+C to stop`)
const stop = async () => {
  await client.close()
  process.exit(0)
}
process.on('SIGINT', () => { void stop() })
process.on('SIGTERM', () => { void stop() })
setInterval(() => {}, 1 << 30)
