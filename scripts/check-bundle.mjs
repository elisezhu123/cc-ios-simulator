// Smoke-checks the committed bundle: starts dist/server.js over stdio, lists its tools,
// and makes sure the panel assets sit next to it.
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
for (const file of ['server.js', 'panel/index.html', 'panel/main.js', 'panel/styles.css']) {
  if (!existsSync(join(root, 'dist', file))) {
    console.error(`missing dist/${file} — run npm run build`)
    process.exit(1)
  }
}
const env = Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined))
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(root, 'dist/server.js')],
  cwd: root,
  env: { ...env, IOS_SIM_CACHE_DIR: mkdtempSync(join(tmpdir(), 'ios-sim-bundle-')), IOS_SIM_PANEL_PORT: '3557' },
  stderr: 'inherit',
})
const client = new Client({ name: 'check-bundle', version: '0.0.0' })
await client.connect(transport)
const { tools } = await client.listTools()
await client.close()
if (tools.length !== 16) {
  console.error(`expected 16 tools, got ${tools.length}: ${tools.map(tool => tool.name).join(', ')}`)
  process.exit(1)
}
console.log(`bundle OK: ${tools.length} tools`)
