// Bundles the MCP server into dist/server.js and the panel page into dist/panel/.
import { build } from 'esbuild'
import { cp, mkdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dist = join(root, 'dist')

await rm(dist, { recursive: true, force: true })
await mkdir(join(dist, 'panel'), { recursive: true })

await build({
  entryPoints: [join(root, 'src/server.ts')],
  outfile: join(dist, 'server.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  // ws optionally requires these native accelerators; they are not installed.
  external: ['bufferutil', 'utf-8-validate'],
  // CJS dependencies (ws) call require() for Node built-ins; give the ESM bundle one.
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  logLevel: 'warning',
})

await build({
  entryPoints: [join(root, 'src/panel/client/main.ts')],
  outfile: join(dist, 'panel/main.js'),
  bundle: true,
  platform: 'browser',
  format: 'esm',
  target: 'es2022',
  logLevel: 'warning',
})
await cp(join(root, 'src/panel/client/index.html'), join(dist, 'panel/index.html'))
await cp(join(root, 'src/panel/client/styles.css'), join(dist, 'panel/styles.css'))
console.log('built dist/server.js and dist/panel/')
