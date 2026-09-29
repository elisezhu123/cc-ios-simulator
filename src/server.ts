/**
 * MCP entry point: wires the real modules into the ios_sim_* tools and the
 * live panel, serves them over stdio, and tears everything down on exit
 * (recordings are finalized, the serve-sim process group is killed).
 * @module ios-simulator/server
 */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { listSimulatorApps } from './app-list.js'
import { buildRun, detectProject, readBundleIdentifier } from './build-run.js'
import { cacheRoot, INTERACT_SETTLE_MS, PLUGIN_NAME, preferredPanelPort, SERVER_VERSION } from './config.js'
import type { ToolDeps } from './deps.js'
import { PanelServer } from './panel/panel-server.js'
import { Recorder } from './recorder.js'
import { ScreenshotStore } from './screenshot.js'
import { SimHostController } from './sim-host.js'
import * as simctl from './simctl.js'
import { SimStreamSource } from './stream-source.js'
import { registerAppTools } from './tools/apps.js'
import { registerCoreTools } from './tools/core.js'
import { registerEnvTools } from './tools/env.js'

async function main(): Promise<void> {
  const root = cacheRoot()
  const host = new SimHostController()
  host.startKeepAlive()
  const stream = new SimStreamSource(host)
  const screenshots = new ScreenshotStore({ dir: join(root, 'screenshots'), takeScreenshot: simctl.takeScreenshot })
  const recorder = new Recorder({ dir: join(root, 'recordings') })
  const panel = new PanelServer({
    // In the bundle this resolves to dist/panel (built by scripts/build.mjs).
    staticDir: join(dirname(fileURLToPath(import.meta.url)), 'panel'),
    preferredPort: preferredPanelPort(),
    host,
    stream,
    simctl,
    screenshots,
  })
  const deps: ToolDeps = {
    host,
    stream,
    simctl,
    screenshots,
    panel,
    recorder,
    builder: { detectProject, buildRun, readBundleIdentifier },
    listApps: listSimulatorApps,
    cacheRoot: root,
    platform: process.platform,
    settleMs: INTERACT_SETTLE_MS,
  }
  const server = new McpServer({ name: PLUGIN_NAME, version: SERVER_VERSION })
  registerCoreTools(server, deps)
  registerAppTools(server, deps)
  registerEnvTools(server, deps)

  let shuttingDown = false
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    await recorder.stopAll().catch(() => undefined)
    await host.dispose().catch(() => undefined)
    await panel.dispose().catch(() => undefined)
    process.exit(0)
  }
  process.stdin.on('end', () => { void shutdown() })
  process.stdin.on('close', () => { void shutdown() })
  process.on('SIGTERM', () => { void shutdown() })
  process.on('SIGINT', () => { void shutdown() })
  server.server.onclose = () => { void shutdown() }

  await server.connect(new StdioServerTransport())
  process.stderr.write(`${PLUGIN_NAME} MCP server ready (serve-sim: ${host.status().serveSimSource})\n`)
}

main().catch((error: unknown) => {
  process.stderr.write(`${PLUGIN_NAME}: fatal: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`)
  process.exit(1)
})
