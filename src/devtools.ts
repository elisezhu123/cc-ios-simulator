// Ported from dsh-ios (MIT, © 2026 ZSeven—W) @ d9a9731 — src/tool-debug.ts, src/tool-logs.ts (runners and parsers)
/**
 * Process plumbing and output parsers behind the log and debug tools.
 *
 * `DevTools.run` spawns one child as its own process-group leader, captures
 * its output (tail-capped), and always reaps the whole group — when a
 * capture window closes (log stream), on the hard deadline, and on abort. A
 * child that may have suspended a target (lldb attach, leaks) gets that
 * target verified running afterwards, with SIGCONT when it is still stopped:
 * a killed debugger must never leave the app frozen.
 *
 * The parsers are pure: launchctl app rows, lldb and `sample` thread
 * sections, the `leaks` summary, `simctl appinfo`'s OpenStep plist, and the
 * log line ring.
 * @module ios-simulator/devtools
 */

import { execFile, execFileSync, spawn } from 'node:child_process'
import { statSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import type { Env } from './config.js'

/** Raw stdout/stderr kept per child (tail). */
const MAX_CHILD_CAPTURE_BYTES = 2 * 1024 * 1024
/** SIGTERM → SIGKILL grace when reaping a child's process group. */
const KILL_GRACE_MS = 2_000
const RESUME_POLL_MS = 300
const SIMCTL_CALL_TIMEOUT_MS = 30_000
const DIAGNOSTIC_LINE_MAX_CHARS = 240

export interface RunOptions {
  command: string
  args: readonly string[]
  /** Names the child in every error message. */
  label: string
  /** Hard deadline: the group is killed and the call fails. */
  timeoutMs: number
  /** Capture window: the group is killed and the call SUCCEEDS with what was captured (log stream). */
  windowMs?: number
  /** Pid to verify running (SIGCONT if stopped) after the child was killed. */
  resumePid?: number
  signal?: AbortSignal
}

export interface RunOutcome {
  stdout: string
  stderr: string
  code: number | null
  /** True when the child was ended by us (window close, abort, deadline). */
  killed: boolean
  /** Set when a resume check ran after a kill. */
  resumed?: boolean
}

export type DebugToolName = 'lldb' | 'leaks' | 'sample'

/** The seam the log/debug tools run through (DevTools satisfies it; tests fake it). */
export interface DevToolsApi {
  /** `xcrun simctl <args>` stdout; rejects with simctl's stderr. */
  simctl(args: readonly string[], signal?: AbortSignal): Promise<string>
  run(options: RunOptions): Promise<RunOutcome>
  /** Absolute path of an Xcode developer tool, when installed. */
  which(name: DebugToolName): string | undefined
  /** True when `pid` exists and is not stopped (SIGCONT-ing it when it is). */
  ensureRunning(pid: number): Promise<boolean>
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

function signalGroup(pid: number | undefined, kill: (signal: NodeJS.Signals) => void, signal: NodeJS.Signals): void {
  if (pid === undefined) {
    kill(signal)
    return
  }
  try {
    process.kill(-pid, signal)
  } catch {
    kill(signal)
  }
}

export interface DevToolsOptions {
  platform?: NodeJS.Platform
  env?: Env
  /** `ps -o stat=` for one pid (undefined when gone); injectable for tests. */
  processStat?: (pid: number) => string | undefined
}

export class DevTools implements DevToolsApi {
  readonly #platform: NodeJS.Platform
  readonly #env: Env
  readonly #processStat: (pid: number) => string | undefined
  readonly #children = new Set<{ pid?: number; kill(signal: NodeJS.Signals): boolean }>()
  readonly #which = new Map<DebugToolName, string | undefined>()

  constructor(options: DevToolsOptions = {}) {
    this.#platform = options.platform ?? process.platform
    this.#env = options.env ?? process.env
    this.#processStat = options.processStat ?? defaultProcessStat
  }

  simctl(args: readonly string[], signal?: AbortSignal): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile('xcrun', ['simctl', ...args], { timeout: SIMCTL_CALL_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, signal }, (error, stdout, stderr) => {
        if (error !== null) {
          const detail = stderr.trim()
          reject(new Error(`simctl ${args.join(' ')} failed${detail === '' ? '' : `: ${detail}`}`))
          return
        }
        resolve(stdout)
      })
    })
  }

  which(name: DebugToolName): string | undefined {
    if (this.#which.has(name)) return this.#which.get(name)
    let found: string | undefined
    if (this.#platform === 'darwin') {
      try {
        found = execFileSync('xcrun', ['--find', name], { encoding: 'utf8', timeout: SIMCTL_CALL_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || undefined
      } catch {
        found = findOnPath(name, this.#env)
      }
    }
    this.#which.set(name, found)
    return found
  }

  async ensureRunning(pid: number): Promise<boolean> {
    await sleep(RESUME_POLL_MS)
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const stat = this.#processStat(pid)
      if (stat === undefined || stat === '') return false
      if (!stat.includes('T')) return true
      try {
        process.kill(pid, 'SIGCONT')
      } catch {
        return false
      }
      await sleep(RESUME_POLL_MS)
    }
    const stat = this.#processStat(pid)
    return stat !== undefined && stat !== '' && !stat.includes('T')
  }

  run(options: RunOptions): Promise<RunOutcome> {
    const { command, args, label, timeoutMs, windowMs, resumePid, signal } = options
    if (signal?.aborted === true) return Promise.reject(abortError(label, signal))
    return new Promise<RunOutcome>((resolve, reject) => {
      let settled = false
      let stdout = ''
      let stderr = ''
      let timedOut = false
      let killed = false
      // Group leader, so one kill reaps xcrun → simctl → log, or lldb → debugserver.
      const child = spawn(command, [...args], { stdio: ['ignore', 'pipe', 'pipe'], detached: true })
      this.#children.add(child)
      const killTree = (): void => {
        killed = true
        signalGroup(child.pid, signal => child.kill(signal), 'SIGTERM')
        const killer = setTimeout(() => signalGroup(child.pid, signal => child.kill(signal), 'SIGKILL'), KILL_GRACE_MS)
        killer.unref?.()
      }
      const onAbort = (): void => killTree()
      signal?.addEventListener('abort', onAbort, { once: true })
      const windowTimer = windowMs === undefined ? undefined : setTimeout(killTree, windowMs)
      const deadline = setTimeout(() => {
        timedOut = true
        killTree()
      }, timeoutMs)
      const finish = (done: () => void): void => {
        if (settled) return
        settled = true
        clearTimeout(deadline)
        if (windowTimer !== undefined) clearTimeout(windowTimer)
        signal?.removeEventListener('abort', onAbort)
        this.#children.delete(child)
        done()
      }
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8')
        if (stdout.length > MAX_CHILD_CAPTURE_BYTES) stdout = stdout.slice(-MAX_CHILD_CAPTURE_BYTES)
      })
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8')
        if (stderr.length > MAX_CHILD_CAPTURE_BYTES) stderr = stderr.slice(-MAX_CHILD_CAPTURE_BYTES)
      })
      child.once('error', error => finish(() => reject(new Error(`${label} failed to start: ${errorMessage(error)}`))))
      child.once('close', code => finish(() => {
        void (async () => {
          const resumed = resumePid !== undefined && killed ? await this.ensureRunning(resumePid) : undefined
          const resumeDetail = resumePid === undefined || resumed === undefined
            ? ''
            : resumed
              ? `; the target process was verified resumed (pid ${resumePid})`
              : `; the target process was NOT found afterwards (pid ${resumePid}, it may have exited)`
          if (signal?.aborted === true) {
            reject(abortError(label, signal, resumeDetail))
            return
          }
          if (timedOut) {
            reject(new Error(`${label} exceeded its ${timeoutMs} ms deadline and was killed${resumeDetail}`))
            return
          }
          resolve({ stdout, stderr, code, killed, ...(resumed === undefined ? {} : { resumed }) })
        })()
      }))
    })
  }

  /** Kill every child still running (server shutdown). */
  dispose(): void {
    for (const child of [...this.#children]) signalGroup(child.pid, signal => child.kill(signal), 'SIGKILL')
    this.#children.clear()
  }
}

function abortError(label: string, signal: AbortSignal, detail = ''): Error {
  if (signal.reason instanceof Error && signal.reason.name !== 'AbortError') return signal.reason
  return new Error(`${label} aborted${detail}`)
}

function defaultProcessStat(pid: number): string | undefined {
  try {
    return execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return undefined
  }
}

function findOnPath(command: string, env: Env): string | undefined {
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (dir === '') continue
    const candidate = join(dir, command)
    try {
      const info = statSync(candidate)
      if (info.isFile() && (info.mode & 0o111) !== 0) return candidate
    } catch {
      // Not this one.
    }
  }
  return undefined
}

// ---------------------------------------------------------------- parsers

/** One running app process on a simulator (pid is a host pid). */
export interface SimAppProcess {
  pid: number
  /** The bundle id's last component, e.g. `Preferences`. */
  name: string
  bundleId?: string
}

/**
 * The simulator launchd's app rows: `simctl spawn <udid> launchctl list`
 * prints `<pid>\t<status>\t<label>`, and apps carry the label
 * `UIKitApplication:<bundle-id>[<instance>][...]`.
 */
export function parseLaunchctlApps(stdout: string): SimAppProcess[] {
  const processes: SimAppProcess[] = []
  for (const line of stdout.split('\n')) {
    const [pidRaw, , labelRaw] = line.split('\t')
    const label = (labelRaw ?? '').trim()
    if (!label.startsWith('UIKitApplication:')) continue
    const pid = Number(pidRaw)
    if (!Number.isInteger(pid) || pid < 1) continue
    const rest = label.slice('UIKitApplication:'.length)
    const bracket = rest.indexOf('[')
    const bundleId = (bracket >= 0 ? rest.slice(0, bracket) : rest).trim()
    const name = (bundleId === '' ? rest : bundleId).split('.').pop() ?? rest
    processes.push({ pid, name, ...(bundleId === '' ? {} : { bundleId }) })
  }
  return processes.sort((a, b) => a.pid - b.pid)
}

/** One thread of a backtrace (header + stack lines). */
export interface ThreadSection {
  header: string
  lines: string[]
}

/** `thread backtrace (all)` output → per-thread sections. */
export function parseLldbThreads(text: string): ThreadSection[] {
  const threads: ThreadSection[] = []
  let current: ThreadSection | undefined
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/u, '')
    if (/^\(lldb\)/u.test(line)) continue
    if (/^Process \d+ (stopped|resuming|detached|exited)/u.test(line)) {
      current = undefined
      continue
    }
    if (/^(\*?)\s*thread #\d+/u.test(line)) {
      current = { header: line.trim(), lines: [] }
      threads.push(current)
      continue
    }
    if (current !== undefined) {
      if (line.trim() === '' && current.lines.length === 0) continue
      current.lines.push(line)
    }
  }
  return threads
}

/** The `Call graph:` section of a `sample` report → per-thread sections. */
export function parseSampleThreads(text: string): ThreadSection[] {
  const threads: ThreadSection[] = []
  let inCallGraph = false
  let current: ThreadSection | undefined
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/u, '')
    if (!inCallGraph) {
      if (line.trim() === 'Call graph:') inCallGraph = true
      continue
    }
    if (/^\s{1,6}\d+\s+Thread_\S+/u.test(line)) {
      current = { header: line.trim(), lines: [] }
      threads.push(current)
      continue
    }
    if (line.trim() === '') {
      current = undefined
      continue
    }
    if (current !== undefined) current.lines.push(line)
  }
  return threads
}

const MAIN_THREAD = /main[- ]thread/iu

/** Main thread first; with `allThreads: false` only the main (else the selected) thread. */
export function orderThreads(threads: readonly ThreadSection[], allThreads: boolean): ThreadSection[] {
  const mainIndex = threads.findIndex(thread => MAIN_THREAD.test(thread.header))
  const ordered = mainIndex <= 0 ? [...threads] : [threads[mainIndex]!, ...threads.slice(0, mainIndex), ...threads.slice(mainIndex + 1)]
  return allThreads ? ordered : ordered.slice(0, 1)
}

/** Stack the sections into at most `maxLines` lines. */
export function capThreadLines(threads: readonly ThreadSection[], maxLines: number): { lines: string[]; truncated: boolean } {
  const lines: string[] = []
  for (const thread of threads) {
    const block = [thread.header, ...thread.lines]
    const room = maxLines - lines.length
    if (block.length <= room) {
      lines.push(...block)
      continue
    }
    lines.push(...block.slice(0, room))
    return { lines, truncated: true }
  }
  return { lines, truncated: false }
}

export interface LeakType {
  type: string
  count: number
  bytes: number
}

export interface LeaksSummary {
  leaks: number
  leakedBytes: number
  nodes?: number
  nodesBytes?: string
  topTypes: LeakType[]
}

/** The `leaks --nostacks` summary: counts, nodes line, and the top leaked types. */
export function parseLeaksSummary(stdout: string, maxTypes = 30): LeaksSummary | undefined {
  const leaksMatch = /^Process \d+: (\d+) leaks? for (\d+) total leaked bytes\./mu.exec(stdout)
  if (leaksMatch === null) return undefined
  const nodesMatch = /^Process \d+: (\d+) nodes malloced for ([0-9.]+\s+\w+)/mu.exec(stdout)
  const counts = new Map<string, { count: number; bytes: number }>()
  for (const match of stdout.matchAll(/^\s*(\d+)\s+\([^)]*\)\s+ROOT LEAK:\s+(.+?)\s*\[(\d+)\]\s*$/gmu)) {
    const raw = match[2]!.trim()
    const type = raw.startsWith('<') && raw.endsWith('>') ? raw.slice(1, -1).replace(/\s+0x[0-9a-f]+$/iu, '') : '<unknown>'
    const entry = counts.get(type) ?? { count: 0, bytes: 0 }
    entry.count += Number(match[1])
    entry.bytes += Number(match[3])
    counts.set(type, entry)
  }
  const topTypes = [...counts.entries()]
    .map(([type, entry]) => ({ type, count: entry.count, bytes: entry.bytes }))
    .sort((a, b) => b.count - a.count || b.bytes - a.bytes)
    .slice(0, maxTypes)
  return {
    leaks: Number(leaksMatch[1]),
    leakedBytes: Number(leaksMatch[2]),
    ...(nodesMatch === null ? {} : { nodes: Number(nodesMatch[1]), nodesBytes: nodesMatch[2]! }),
    topTypes,
  }
}

/** The first line saying leaks could not inspect the process at all. */
export function leaksFatalDiagnostic(stderr: string, stdout: string): string | undefined {
  for (const raw of `${stderr}\n${stdout}`.split('\n')) {
    const line = raw.trim()
    if (/\[fatal\]|Failed to get DYLD info|minimal corpse|cannot examine process|not allowed to attach/iu.test(line)) {
      return truncateLine(line)
    }
  }
  return undefined
}

/** The first non-empty diagnostic line (stderr, then stdout). */
export function firstDiagnostic(stderr: string, stdout: string): string | undefined {
  const line = `${stderr}\n${stdout}`.split('\n').map(entry => entry.trim()).find(entry => entry !== '')
  return line === undefined ? undefined : truncateLine(line)
}

/** The last `lines` non-empty lines, joined. */
export function tailDiagnostic(text: string, lines: number): string {
  return text.split('\n').map(line => line.trim()).filter(line => line !== '').slice(-lines).map(truncateLine).join(' | ')
}

function truncateLine(line: string): string {
  return line.length > DIAGNOSTIC_LINE_MAX_CHARS ? `${line.slice(0, DIAGNOSTIC_LINE_MAX_CHARS)}…` : line
}

/** Scalar `key = value;` pairs of `simctl appinfo`'s OpenStep plist (file:// URLs decoded). */
export function parseOpenStepPlist(text: string): Record<string, string> {
  const fields: Record<string, string> = {}
  for (const raw of text.split('\n')) {
    const match = /^([A-Za-z0-9_]+)\s*=\s*(.*?);\s*$/u.exec(raw.trim())
    if (match === null) continue
    let value = match[2]!.trim()
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1)
    if (value.startsWith('file://')) {
      try {
        value = decodeURIComponent(value.slice('file://'.length)).replace(/\/$/u, '')
      } catch {
        // Keep the raw URL.
      }
    }
    fields[match[1]!] = value
  }
  return fields
}

const ANSI_PATTERN = /\u001b\][^\u0007]*(?:\u0007|\u001b\\)|\u001b\[[0-9;?]*[A-Za-z]/gu
/** `log show` / `log stream` banners, not log lines. */
const BANNER_PATTERN = /^(?:Filtering the log data using |Timestamp\s+Ty\s+Process\[PID:TID\])/u

/**
 * Cleaned log lines: ANSI and banners stripped, an optional grep applied,
 * and the TAIL kept within `maxLines` / `maxBytes`.
 */
export function tailLogLines(
  text: string,
  options: { maxLines: number; maxBytes: number; grep?: RegExp },
): { lines: string[]; truncated: boolean } {
  let lines = text.split('\n')
    .map(line => line.replace(ANSI_PATTERN, '').trimEnd())
    .filter(line => line !== '' && !BANNER_PATTERN.test(line))
  if (options.grep !== undefined) {
    const grep = options.grep
    lines = lines.filter(line => line.search(grep) !== -1)
  }
  let bytes = lines.reduce((sum, line) => sum + Buffer.byteLength(line, 'utf8') + 1, 0)
  let start = 0
  while (start < lines.length && (lines.length - start > options.maxLines || bytes > options.maxBytes)) {
    bytes -= Buffer.byteLength(lines[start]!, 'utf8') + 1
    start += 1
  }
  return { lines: lines.slice(start), truncated: start > 0 }
}
