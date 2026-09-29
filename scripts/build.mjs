// Bundles the MCP server into dist/server.js and the panel page into dist/panel/.
import { build } from 'esbuild'
import { cp, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { dist, panelBundle, root, serverBundle } from './bundles.mjs'

await rm(dist, { recursive: true, force: true })
await mkdir(join(dist, 'panel'), { recursive: true })

await build(serverBundle)
await build(panelBundle)
await cp(join(root, 'src/panel/client/index.html'), join(dist, 'panel/index.html'))
await cp(join(root, 'src/panel/client/styles.css'), join(dist, 'panel/styles.css'))
console.log('built dist/server.js and dist/panel/')
