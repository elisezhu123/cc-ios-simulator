// The esbuild options of the two committed bundles, shared by build.mjs (which writes them)
// and notices.mjs (which lists the packages they contain), so the two cannot drift apart.
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const root = join(dirname(fileURLToPath(import.meta.url)), '..')
export const dist = join(root, 'dist')

/** dist/server.js — the MCP server. */
export const serverBundle = {
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
}

/** dist/panel/main.js — the live panel page. */
export const panelBundle = {
  entryPoints: [join(root, 'src/panel/client/main.ts')],
  outfile: join(dist, 'panel/main.js'),
  bundle: true,
  platform: 'browser',
  format: 'esm',
  target: 'es2022',
  logLevel: 'warning',
}
