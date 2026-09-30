// Ported from dsh-ios (MIT, © 2026 ZSeven—W) @ d9a9731 — src/tool-logs.ts, src/tool-debug.ts (simulator branch)
/**
 * Log and debugging tools: ios_sim_logs (unified log, bounded snapshot or
 * follow window), ios_sim_processes (running app pids from the simulator's
 * launchd), ios_sim_backtrace (batch LLDB, `sample` fallback),
 * ios_sim_leaks (leaks summary or .memgraph) and ios_sim_app_info
 * (containers and Info.plist facts). backtrace and leaks only ever target
 * this simulator's app processes, and always leave them running.
 * @module ios-simulator/tools/debug
 */

import { mkdirSync, statSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { ToolDeps } from '../deps.js'
import {
  capThreadLines,
  firstDiagnostic,
  leaksFatalDiagnostic,
  orderThreads,
  parseLaunchctlApps,
  parseLeaksSummary,
  parseLldbThreads,
  parseOpenStepPlist,
  parseSampleThreads,
  tailDiagnostic,
  tailLogLines,
  type SimAppProcess,
  type ThreadSection,
} from '../devtools.js'
import type { SimulatorDevice } from '../simctl.js'
import { assertMac, realDeviceSummary, requireBooted, resolveTargetDevice, resolveToolTarget } from '../target.js'
import { deviceSummary, jsonResult, runTool, UDID_PARAM } from './result.js'

const MAX_LOG_LINES = 300
const MAX_LOG_BYTES = 30 * 1024
const SNAPSHOT_TIMEOUT_MS = 8 * 60 * 1000
const FOLLOW_GRACE_MS = 30_000
const MAX_BACKTRACE_LINES = 200
const BACKTRACE_TIMEOUT_MS = 30_000
const LEAKS_TIMEOUT_MS = 120_000

const LOG_TRUNCATION_HINT = '[ios-simulator: output capped at 300 lines / 30 KB — narrow with predicate, bundle_id, grep, or a shorter window]'
const BACKTRACE_TRUNCATION_HINT = '[ios-simulator: backtrace capped at ~200 lines — pass all_threads:false for just the main thread]'
const DEVELOPER_MODE_HINT = 'macOS Developer Mode is required for full task inspection — run `sudo DevToolsSecurity -enable` once, then retry'
const MALLOC_STACK_LOGGING_HINT = 'the app was not launched with MallocStackLogging, so allocation backtraces are unavailable — relaunch it '
  + 'with SIMCTL_CHILD_MallocStackLogging=1 xcrun simctl launch <udid> <bundle_id>, then re-run'
const APP_LIST_HINT = 'run ios_sim_list_apps to see what is installed'

const PROCESS_TARGET = {
  pid: z.number().int().min(1).optional().describe('Pid of the app from ios_sim_processes (the most precise target)'),
  bundle_id: z.string().optional().describe('Bundle id of the running app, e.g. com.apple.Preferences (used when pid is not given)'),
}

/** Escape backslashes and double quotes inside an NSPredicate string literal. */
function predicateString(value: string): string {
  return `"${value.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"')}"`
}

/** An explicit predicate wins; else bundle_id → subsystem == id OR process == its last component. */
export function logPredicate(args: { predicate?: string; bundle_id?: string }): string | undefined {
  const predicate = args.predicate?.trim()
  if (predicate !== undefined && predicate !== '') return predicate
  const bundleId = args.bundle_id?.trim()
  if (bundleId === undefined || bundleId === '') return undefined
  const processName = bundleId.split('.').pop() ?? bundleId
  return `subsystem == ${predicateString(bundleId)} OR process == ${predicateString(processName)}`
}

function slug(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/gu, '_').slice(0, 64)
}

export function registerDebugTools(server: McpServer, deps: ToolDeps): void {
  const bootedTarget = async (tool: string, udid: string | undefined): Promise<SimulatorDevice> => {
    assertMac(deps.platform)
    const device = await resolveTargetDevice(deps, udid)
    requireBooted(tool, device)
    return device
  }

  const listProcesses = async (device: SimulatorDevice, signal?: AbortSignal): Promise<SimAppProcess[]> =>
    parseLaunchctlApps(await deps.devtools.simctl(['spawn', device.udid, 'launchctl', 'list'], signal))

  /**
   * The app process a debug tool targets. A pid must be one of THIS
   * simulator's app processes — host processes are never attached.
   */
  const targetProcess = async (device: SimulatorDevice, pid: number | undefined, bundleId: string | undefined, signal?: AbortSignal): Promise<SimAppProcess> => {
    const processes = await listProcesses(device, signal)
    if (pid !== undefined) {
      const found = processes.find(entry => entry.pid === pid)
      if (found === undefined) {
        throw new Error(`pid ${pid} is not a running app process on ${device.name} — only this simulator's app processes `
          + 'can be inspected (host processes are never attached); run ios_sim_processes to list them')
      }
      return found
    }
    const wanted = bundleId?.trim().toLowerCase() ?? ''
    if (wanted === '') throw new Error('pass pid or bundle_id (a pid from ios_sim_processes is the most precise)')
    const found = processes.find(entry => entry.bundleId?.toLowerCase() === wanted || entry.name.toLowerCase() === wanted)
    if (found === undefined) {
      throw new Error(`no running process for "${bundleId?.trim()}" on ${device.name} — launch the app first `
        + '(ios_sim_launch_app or ios_sim_build_run), then retry; ios_sim_processes lists what runs')
    }
    return found
  }

  const processSummary = (entry: SimAppProcess): Record<string, unknown> => ({
    pid: entry.pid,
    name: entry.name,
    ...(entry.bundleId === undefined ? {} : { bundleId: entry.bundleId }),
  })

  server.registerTool('ios_sim_logs', {
    title: 'Read the simulator log',
    description: 'Read what apps on a booted simulator print, from its unified log. Two bounded modes: "snapshot" '
      + '(default) reads the recent persisted log (`log show --last <duration>`, default 2m); "follow" captures '
      + 'live output for duration_seconds (default 10, max 60) and returns it when the window closes — never an '
      + 'endless stream. Filter with bundle_id (subsystem or process name), a raw NSPredicate (predicate, e.g. '
      + 'process == "MyApp"), a level, and a client-side grep regex. Output keeps the last ~300 lines / 30 KB; '
      + 'truncated:true says the cap bit. To catch what an action logs, start a follow capture, then act.',
    inputSchema: {
      udid: UDID_PARAM,
      mode: z.enum(['snapshot', 'follow']).optional(),
      duration: z.string().regex(/^\d{1,4}[smh]$/u, 'duration must look like "2m", "30s" or "1h"').optional()
        .describe('Snapshot window for log show --last, e.g. "30s", "2m", "1h" (default "2m")'),
      duration_seconds: z.number().int().min(1).max(60).optional().describe('Follow window in seconds (default 10)'),
      bundle_id: z.string().optional()
        .describe('Only this app: subsystem == <bundle_id> OR process == <its last component>; ignored when predicate is set'),
      predicate: z.string().optional().describe('Raw NSPredicate, e.g. eventMessage CONTAINS "error"'),
      level: z.enum(['default', 'info', 'debug']).optional().describe('Include info / debug messages too'),
      grep: z.string().optional().describe('Regular expression each returned line must match'),
    },
    annotations: { readOnlyHint: true },
  }, async (args, extra) => runTool('ios_sim_logs', async () => {
    let grep: RegExp | undefined
    if (args.grep !== undefined && args.grep.trim() !== '') {
      try {
        grep = new RegExp(args.grep)
      } catch (error) {
        throw new Error(`grep is not a valid regular expression: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    const device = await bootedTarget('ios_sim_logs', args.udid)
    const mode = args.mode ?? 'snapshot'
    const predicate = logPredicate(args)
    const predicateArgs = predicate === undefined ? [] : ['--predicate', predicate]
    let logArgs: string[]
    let window: string
    let windowMs: number | undefined
    if (mode === 'follow') {
      const seconds = args.duration_seconds ?? 10
      logArgs = ['stream', '--style', 'compact', ...(args.level === undefined ? [] : ['--level', args.level]), ...predicateArgs]
      window = `follow ${seconds}s`
      windowMs = seconds * 1000
    } else {
      const duration = args.duration ?? '2m'
      // `log show` has no --level: --info / --debug raise the threshold.
      const level = args.level === 'info' ? ['--info'] : args.level === 'debug' ? ['--info', '--debug'] : []
      logArgs = ['show', '--last', duration, '--style', 'compact', ...level, ...predicateArgs]
      window = `last ${duration}`
    }
    const label = `simctl spawn ${device.udid} log ${logArgs[0]}`
    const outcome = await deps.devtools.run({
      command: 'xcrun',
      args: ['simctl', 'spawn', device.udid, 'log', ...logArgs],
      label,
      timeoutMs: windowMs === undefined ? SNAPSHOT_TIMEOUT_MS : windowMs + FOLLOW_GRACE_MS,
      ...(windowMs === undefined ? {} : { windowMs }),
      signal: extra.signal,
    })
    if (!outcome.killed && outcome.code !== 0 && outcome.code !== null) {
      const detail = tailDiagnostic(outcome.stderr, 5)
      throw new Error(`${label} failed (exit ${outcome.code})${detail === '' ? '' : `: ${detail}`}`)
    }
    const { lines, truncated } = tailLogLines(outcome.stdout, { maxLines: MAX_LOG_LINES, maxBytes: MAX_LOG_BYTES, ...(grep === undefined ? {} : { grep }) })
    return jsonResult({
      device: deviceSummary(device),
      mode,
      window,
      ...(predicate === undefined ? {} : { predicate }),
      lineCount: lines.length,
      truncated,
      lines: truncated ? [...lines, LOG_TRUNCATION_HINT] : lines,
    })
  }))

  server.registerTool('ios_sim_processes', {
    title: 'List running app processes',
    description: 'List the running app processes of a booted simulator (pid, process name, bundle id) from the '
      + 'simulator\'s own launchd. The pids are host pids and feed ios_sim_backtrace and ios_sim_leaks. On a connected '
      + 'iPhone/iPad (pass its udid or name) it lists every running process through devicectl; those pids live on the '
      + 'device, and only processes inside an installed app carry a bundle id. filter is a case-insensitive substring '
      + 'over the name and bundle id.',
    inputSchema: { udid: UDID_PARAM, filter: z.string().optional() },
    annotations: { readOnlyHint: true },
  }, async (args, extra) => runTool('ios_sim_processes', async () => {
    assertMac(deps.platform)
    const target = await resolveToolTarget(deps, args.udid)
    if (target.kind === 'simulator') requireBooted('ios_sim_processes', target.device)
    const needle = args.filter?.trim().toLowerCase() ?? ''
    const all: SimAppProcess[] = target.kind === 'real'
      ? await deps.realDevices.listProcesses(target.device.udid, extra.signal)
      : await listProcesses(target.device, extra.signal)
    const processes = all.filter(entry => needle === ''
      || entry.name.toLowerCase().includes(needle) || entry.bundleId?.toLowerCase().includes(needle) === true)
    return jsonResult({
      device: target.kind === 'real' ? realDeviceSummary(target.device) : deviceSummary(target.device),
      count: processes.length,
      processes: processes.map(processSummary),
      ...(target.kind === 'real' ? { note: 'these pids live on the device: ios_sim_backtrace and ios_sim_leaks work on simulators only' } : {}),
    })
  }))

  server.registerTool('ios_sim_backtrace', {
    title: 'Backtrace a running app',
    description: 'Capture a symbolized backtrace of a running simulator app in one shot: batch LLDB (attach → '
      + 'thread backtrace → detach), never an interactive session. The app is always detached and verified running '
      + 'afterwards, even when the capture times out. When LLDB may not attach (Developer Mode off) it falls back '
      + 'to Xcode\'s non-suspending `sample` and says how to enable LLDB. Main thread first, capped at ~200 lines; '
      + 'all_threads:false returns just the main thread. Use it when an app hangs or looks stuck.',
    inputSchema: {
      udid: UDID_PARAM,
      ...PROCESS_TARGET,
      all_threads: z.boolean().optional().describe('Backtrace every thread (default true)'),
    },
  }, async (args, extra) => runTool('ios_sim_backtrace', async () => {
    const device = await bootedTarget('ios_sim_backtrace', args.udid)
    const target = await targetProcess(device, args.pid, args.bundle_id, extra.signal)
    const allThreads = args.all_threads !== false
    let threads: ThreadSection[] | undefined
    let engine: 'lldb' | 'sample' = 'lldb'
    let reportPath: string | undefined
    let note: string | undefined
    const lldb = deps.devtools.which('lldb')
    if (lldb !== undefined) {
      const outcome = await deps.devtools.run({
        command: lldb,
        args: ['-b', '-o', `attach ${target.pid}`, '-o', allThreads ? 'thread backtrace all' : 'thread backtrace', '-o', 'detach'],
        label: `lldb backtrace of pid ${target.pid}`,
        timeoutMs: BACKTRACE_TIMEOUT_MS,
        resumePid: target.pid,
        signal: extra.signal,
      })
      const parsed = parseLldbThreads(outcome.stdout)
      if (parsed.length > 0) {
        threads = parsed
      } else {
        const detail = firstDiagnostic(outcome.stderr, outcome.stdout) ?? `lldb exited ${String(outcome.code)} without a backtrace`
        engine = 'sample'
        note = `LLDB capture failed (${detail}) and sample was used instead`
        if (/not allowed to attach|attach failed/iu.test(detail)) note += ` — ${DEVELOPER_MODE_HINT} to enable LLDB attach`
      }
    } else {
      engine = 'sample'
      note = 'Xcode\'s lldb is not installed; sample was used instead'
    }
    if (threads === undefined) {
      const sample = deps.devtools.which('sample')
      if (sample === undefined) {
        throw new Error(`LLDB capture is unavailable${note === undefined ? '' : ` (${note})`} and Xcode's sample tool is not installed — install Xcode or the Command Line Tools`)
      }
      const dir = join(deps.cacheRoot, 'samples')
      mkdirSync(dir, { recursive: true })
      reportPath = join(dir, `sample-${slug(target.name)}-${target.pid}-${Date.now()}.txt`)
      const outcome = await deps.devtools.run({
        command: sample,
        args: [String(target.pid), '1', '1', '-file', reportPath],
        label: `sample of pid ${target.pid}`,
        timeoutMs: BACKTRACE_TIMEOUT_MS,
        signal: extra.signal,
      })
      if (!existsSync(reportPath)) {
        const detail = tailDiagnostic(outcome.stderr === '' ? outcome.stdout : outcome.stderr, 3)
        throw new Error(`sample of pid ${target.pid} produced no report${detail === '' ? '' : `: ${detail}`}`)
      }
      threads = parseSampleThreads(readFileSync(reportPath, 'utf8'))
      if (threads.length === 0) throw new Error(`sample of pid ${target.pid} produced no thread sections (report: ${reportPath})`)
    }
    const kept = orderThreads(threads, allThreads)
    const { lines, truncated } = capThreadLines(kept, MAX_BACKTRACE_LINES)
    // The liveness proof: after a detach the app must be running again, never left frozen.
    const resumed = await deps.devtools.ensureRunning(target.pid)
    if (!resumed && engine === 'lldb') {
      note = `${note === undefined ? '' : `${note}; `}the app was not observed running after detach — check ios_sim_processes`
    }
    return jsonResult({
      device: deviceSummary(device),
      ...processSummary(target),
      engine,
      allThreads,
      threadCount: kept.length,
      lineCount: lines.length,
      truncated,
      lines: truncated ? [...lines, BACKTRACE_TRUNCATION_HINT] : lines,
      resumed,
      ...(reportPath === undefined ? {} : { reportPath }),
      ...(note === undefined ? {} : { note }),
    })
  }))

  server.registerTool('ios_sim_leaks', {
    title: 'Find memory leaks in a running app',
    description: 'Analyze a running simulator app with Xcode\'s leaks tool. "summary" (default) returns the leak '
      + 'count, total leaked bytes and the top ~30 leaked types; "memgraph" writes a .memgraph for Xcode '
      + 'Instruments and returns its path and size. leaks suspends the app while it scans; the app is always '
      + 'verified running afterwards, even on a timeout. Without Developer Mode leaks may not inspect the app '
      + '(the error says how to enable it); without MallocStackLogging counts work but allocation stacks do not.',
    inputSchema: {
      udid: UDID_PARAM,
      ...PROCESS_TARGET,
      mode: z.enum(['summary', 'memgraph']).optional(),
    },
  }, async (args, extra) => runTool('ios_sim_leaks', async () => {
    const leaks = deps.devtools.which('leaks')
    const device = await bootedTarget('ios_sim_leaks', args.udid)
    if (leaks === undefined) throw new Error('Xcode\'s leaks tool is not installed — install Xcode or the Command Line Tools, then retry')
    const target = await targetProcess(device, args.pid, args.bundle_id, extra.signal)
    const mode = args.mode ?? 'summary'
    const unavailable = (fatal: string): Error => new Error(`leaks could not analyze pid ${target.pid}: ${fatal} — ${DEVELOPER_MODE_HINT}`)
    const base = { device: deviceSummary(device), ...processSummary(target), mode }
    if (mode === 'memgraph') {
      const dir = join(deps.cacheRoot, 'memgraphs')
      mkdirSync(dir, { recursive: true })
      const path = join(dir, `leaks-${slug(target.name)}-${target.pid}-${Date.now()}.memgraph`)
      const outcome = await deps.devtools.run({
        command: leaks,
        args: [`--outputGraph=${path}`, String(target.pid)],
        label: `leaks memgraph of pid ${target.pid}`,
        timeoutMs: LEAKS_TIMEOUT_MS,
        resumePid: target.pid,
        signal: extra.signal,
      })
      const fatal = leaksFatalDiagnostic(outcome.stderr, outcome.stdout)
      if (fatal !== undefined) throw unavailable(fatal)
      if (!existsSync(path)) {
        const detail = tailDiagnostic(outcome.stderr === '' ? outcome.stdout : outcome.stderr, 3)
        throw new Error(`leaks wrote no memgraph${detail === '' ? '' : `: ${detail}`}`)
      }
      const resumed = await deps.devtools.ensureRunning(target.pid)
      return jsonResult({
        ...base,
        path,
        bytes: statSync(path).size,
        resumed,
        ...(resumed ? {} : { note: 'the app was not observed running after the capture — check ios_sim_processes' }),
      })
    }
    const outcome = await deps.devtools.run({
      command: leaks,
      args: ['--nostacks', String(target.pid)],
      label: `leaks summary of pid ${target.pid}`,
      timeoutMs: LEAKS_TIMEOUT_MS,
      resumePid: target.pid,
      signal: extra.signal,
    })
    const fatal = leaksFatalDiagnostic(outcome.stderr, outcome.stdout)
    if (fatal !== undefined) throw unavailable(fatal)
    const summary = parseLeaksSummary(outcome.stdout)
    if (summary === undefined) {
      const detail = tailDiagnostic(outcome.stderr === '' ? outcome.stdout : outcome.stderr, 3)
      throw new Error(`leaks produced no parseable summary for pid ${target.pid}${detail === '' ? '' : `: ${detail}`}`)
    }
    const notes: string[] = []
    if (/not debuggable|restricted processes/iu.test(outcome.stderr)) notes.push(`restricted inspection mode (${DEVELOPER_MODE_HINT})`)
    if (summary.leaks > 0 && !/multi-line stacks/iu.test(outcome.stdout)) notes.push(MALLOC_STACK_LOGGING_HINT)
    const resumed = await deps.devtools.ensureRunning(target.pid)
    if (!resumed) notes.push('the app was not observed running after the analysis — check ios_sim_processes')
    return jsonResult({ ...base, ...summary, resumed, ...(notes.length === 0 ? {} : { note: notes.join('. ') }) })
  }))

  server.registerTool('ios_sim_app_info', {
    title: 'Show an installed app\'s paths and Info.plist',
    description: 'Installed-app facts for one bundle id on a booted simulator: the .app path, the writable data '
      + 'container (Documents, Library, …), and Info.plist values (display name, executable, version), via simctl '
      + 'appinfo with a get_app_container fallback. On a connected iPhone/iPad (pass its udid or name) it reports the '
      + 'on-device .app path, name, version and whether it is a system app (containers are not exposed there). A '
      + 'bundle id that is not installed returns installed:false with a note — list the apps instead of guessing ids.',
    inputSchema: {
      udid: UDID_PARAM,
      bundle_id: z.string().trim().min(1).describe('Bundle id of the installed app, e.g. com.apple.Preferences'),
    },
    annotations: { readOnlyHint: true },
  }, async (args, extra) => runTool('ios_sim_app_info', async () => {
    assertMac(deps.platform)
    const target = await resolveToolTarget(deps, args.udid)
    const bundleId = args.bundle_id
    if (target.kind === 'real') {
      const summary = realDeviceSummary(target.device)
      const app = await deps.realDevices.getApp(target.device.udid, bundleId, extra.signal)
      if (app === undefined) return jsonResult({ device: summary, bundleId, installed: false, note: `${bundleId} is not installed on ${target.device.name} — ${APP_LIST_HINT}` })
      return jsonResult({
        device: summary,
        bundleId,
        installed: true,
        ...(app.path === undefined ? {} : { appPath: app.path }),
        name: app.name,
        ...(app.bundleVersion === undefined ? {} : { version: app.bundleVersion }),
        ...(app.version === undefined ? {} : { shortVersion: app.version }),
        applicationType: app.defaultApp === true || (app.appType ?? '').toLowerCase() === 'system' ? 'System' : 'User',
      })
    }
    requireBooted('ios_sim_app_info', target.device)
    const device = target.device
    const container = async (kind: 'app' | 'data'): Promise<string | undefined> => {
      try {
        const path = (await deps.devtools.simctl(['get_app_container', device.udid, bundleId, kind], extra.signal)).trim()
        return path === '' || path === '(null)' ? undefined : path
      } catch {
        return undefined
      }
    }
    const fields = parseOpenStepPlist(await deps.devtools.simctl(['appinfo', device.udid, bundleId], extra.signal))
    // appinfo never fails for a missing app — it only echoes the bundle id back.
    let appPath: string | undefined = fields.Path
    if (appPath === undefined && fields.Bundle === undefined) appPath = await container('app')
    const installed = appPath !== undefined || fields.Bundle !== undefined
    const dataPath = fields.DataContainer ?? (installed ? await container('data') : undefined)
    const optional = (key: string, value: string | undefined): Record<string, string> => value === undefined ? {} : { [key]: value }
    return jsonResult({
      device: deviceSummary(device),
      bundleId,
      installed,
      ...optional('appPath', appPath),
      ...optional('dataPath', dataPath),
      ...optional('bundleContainer', fields.BundleContainer ?? fields.Bundle),
      ...optional('displayName', fields.CFBundleDisplayName),
      ...optional('executable', fields.CFBundleExecutable),
      ...optional('name', fields.CFBundleName),
      ...optional('version', fields.CFBundleVersion),
      ...optional('shortVersion', fields.CFBundleShortVersionString),
      ...optional('applicationType', fields.ApplicationType),
      ...(installed ? {} : { note: `${bundleId} is not installed on ${device.name} — ${APP_LIST_HINT}` }),
    })
  }))
}
