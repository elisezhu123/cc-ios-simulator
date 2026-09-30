import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { AnnotationStore } from '../../src/annotations.js'
import type { ToolDeps } from '../../src/deps.js'
import { Recorder } from '../../src/recorder.js'
import { ScreenshotStore } from '../../src/screenshot.js'
import type { SimulatorDevice } from '../../src/simctl.js'
import { SimStreamSource } from '../../src/stream-source.js'
import { fakeAxe, fakeDevtools, fakeHost, fakeOcr, fakeRealDevices,
  fakeRecordSpawn, fakeSimctl, fakeWda, type FakeHostOptions } from './fakes.js'

export interface Harness {
  deps: ToolDeps
  hostCalls: string[][]
  simctlCalls: unknown[][]
  call(name: string, args?: Record<string, unknown>): Promise<CallToolResult>
  json(result: CallToolResult): unknown
  close(): Promise<void>
}

export interface HarnessOptions {
  host?: FakeHostOptions
  devices?: SimulatorDevice[]
  /** Pixel size of the fake simctl screenshots (default 1206×2622, portrait). */
  screenshotSize?: { width: number; height: number }
  deps?: Partial<ToolDeps>
}

/** The first text block of a tool result. */
export function textOf(result: CallToolResult): string {
  const first = result.content[0]
  return first !== undefined && first.type === 'text' ? first.text : ''
}

/** A real McpServer + Client over an in-memory transport, wired to fakes. */
export async function toolHarness(
  register: (server: McpServer, deps: ToolDeps) => void,
  options: HarnessOptions = {},
): Promise<Harness> {
  const cacheRoot = mkdtempSync(join(tmpdir(), 'ios-sim-tools-'))
  const { host, calls: hostCalls } = fakeHost(options.host)
  const { api: simctl, calls: simctlCalls } = fakeSimctl(options.devices, { screenshotSize: options.screenshotSize })
  const deps: ToolDeps = {
    host,
    stream: new SimStreamSource(host),
    simctl,
    screenshots: new ScreenshotStore({ dir: join(cacheRoot, 'screenshots'), takeScreenshot: simctl.takeScreenshot }),
    panel: {
      ensureStarted: async () => 'http://127.0.0.1:3999/',
      showRealDevice: async () => 'http://127.0.0.1:3999/',
      showSimulator: () => {},
      openHint: () => ({}),
    },
    recorder: new Recorder({ dir: join(cacheRoot, 'recordings'), spawnRecord: fakeRecordSpawn().spawnRecord }),
    builder: {
      detectProject: projectPath => ({ kind: 'xcodeproj', root: '/p', location: projectPath }),
      buildRun: async build => ({
        device: { udid: build.device.udid, name: build.device.name, runtime: build.device.runtime, state: 'Booted' },
        state: 'launched',
        bundleId: 'com.example.App',
        pid: '4242',
        appPath: '/dd/App.app',
        projectPath: build.target.location,
        scheme: build.scheme ?? 'App',
        configuration: build.configuration,
      }),
      readBundleIdentifier: async () => 'com.example.App',
    },
    listApps: async () => [
      { bundleId: 'com.apple.mobilecal', name: '日历', baseName: 'Calendar', system: true },
      { bundleId: 'com.example.notes', name: 'Notes Pro', system: false },
    ],
    axe: fakeAxe().api,
    ocr: fakeOcr().api,
    devtools: fakeDevtools().api,
    realDevices: fakeRealDevices().api,
    annotations: new AnnotationStore({ dir: join(cacheRoot, 'annotations') }),
    wda: fakeWda({ notRunning: 'WebDriverAgent is not running on the device — run ios_real_start_wda first' }).api,
    preview: {
      start: async () => { throw new Error('test: no preview controller') },
      status: () => ({ running: false }),
      stop: async () => ({ stopped: false }),
    },
    cacheRoot,
    platform: 'darwin',
    settleMs: 0,
    pollIntervalMs: 0,
    rowSettleMs: 0,
    ...options.deps,
  }
  const server = new McpServer({ name: 'ios-simulator-test', version: '0.0.0' })
  register(server, deps)
  const client = new Client({ name: 'ios-simulator-test-client', version: '0.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  return {
    deps,
    hostCalls,
    simctlCalls,
    call: async (name, args = {}) => (await client.callTool({ name, arguments: args })) as CallToolResult,
    json: result => JSON.parse(textOf(result)),
    close: async () => {
      await client.close()
      await server.close()
    },
  }
}
