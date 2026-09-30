import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, writeFileSync } from 'node:fs'
import type { RunOptions, RunOutcome } from '../src/devtools.js'
import { logPredicate, registerDebugTools } from '../src/tools/debug.js'
import { fakeDevtools } from './helpers/fakes.js'
import { textOf, toolHarness, type Harness } from './helpers/harness.js'

const LAUNCHCTL = [
  'PID\tStatus\tLabel',
  '1200\t0\tUIKitApplication:com.example.MyApp[1c2d][rb-legacy]',
  '4321\t0\tUIKitApplication:com.apple.Preferences[3a1f][rb-legacy]',
].join('\n')

type FakeOptions = Parameters<typeof fakeDevtools>[0]

async function debugHarness(options: FakeOptions = {}): Promise<Harness & ReturnType<typeof fakeDevtools>> {
  const fake = fakeDevtools({
    ...options,
    simctl: { 'spawn BBB launchctl list': LAUNCHCTL, ...options?.simctl },
  })
  const h = await toolHarness((server, deps) => {
    deps.devtools = fake.api
    registerDebugTools(server, deps)
  }, { host: { device: 'BBB' } })
  return { ...h, ...fake }
}

test('logPredicate: an explicit predicate wins, bundle_id matches subsystem or process', () => {
  assert.equal(logPredicate({ predicate: ' process == "X" ', bundle_id: 'a.b' }), 'process == "X"')
  assert.equal(logPredicate({ bundle_id: 'com.example.My"App' }), 'subsystem == "com.example.My\\"App" OR process == "My\\"App"')
  assert.equal(logPredicate({}), undefined)
})

test('ios_sim_logs snapshot runs log show with the filters and returns the tail', async () => {
  const h = await debugHarness({ run: { xcrun: { stdout: 'Timestamp               Ty Process[PID:TID]\nA error one\nB fine\nC error two\n' } } })
  const body = h.json(await h.call('ios_sim_logs', { bundle_id: 'com.example.MyApp', level: 'debug', grep: 'error', duration: '30s' })) as { window: string; lines: string[]; lineCount: number; predicate: string }
  assert.deepEqual(h.runs[0]!.args, ['simctl', 'spawn', 'BBB', 'log', 'show', '--last', '30s', '--style', 'compact', '--info', '--debug',
    '--predicate', 'subsystem == "com.example.MyApp" OR process == "MyApp"'])
  assert.equal(h.runs[0]!.windowMs, undefined)
  assert.equal(body.window, 'last 30s')
  assert.deepEqual(body.lines, ['A error one', 'C error two'])
  await h.close()
})

test('ios_sim_logs follow closes the capture window and treats that as success', async () => {
  const h = await debugHarness({ run: { xcrun: { stdout: 'tick\n', killed: true, code: null } } })
  const body = h.json(await h.call('ios_sim_logs', { mode: 'follow', duration_seconds: 3, level: 'info' })) as { window: string; lines: string[] }
  assert.deepEqual(h.runs[0]!.args.slice(4), ['stream', '--style', 'compact', '--level', 'info'])
  assert.equal(h.runs[0]!.windowMs, 3000)
  assert.deepEqual([body.window, body.lines], ['follow 3s', ['tick']])
  await h.close()
})

test('ios_sim_logs reports a failing log command and rejects a bad grep before running', async () => {
  const h = await debugHarness({ run: { xcrun: { code: 64, stderr: 'log: Invalid predicate\n' } } })
  assert.match(textOf(await h.call('ios_sim_logs', { predicate: 'nonsense ==' })), /log show failed \(exit 64\): log: Invalid predicate/)
  assert.match(textOf(await h.call('ios_sim_logs', { grep: '(' })), /grep is not a valid regular expression/)
  assert.equal(h.runs.length, 1)
  await h.close()
})

test('ios_sim_processes lists and filters the simulator app processes', async () => {
  const h = await debugHarness()
  const body = h.json(await h.call('ios_sim_processes', { filter: 'pref' })) as { count: number; processes: unknown[] }
  assert.deepEqual(body.processes, [{ pid: 4321, name: 'Preferences', bundleId: 'com.apple.Preferences' }])
  await h.close()
})

const LLDB_OUT = `* thread #1, queue = 'com.apple.main-thread'
  * frame #0: 0x1 libsystem_kernel.dylib\`mach_msg2_trap + 8
  thread #2
    frame #0: 0x2 libsystem_kernel.dylib\`__workq_kernreturn + 8`

test('ios_sim_backtrace attaches lldb in batch mode and verifies the app is running again', async () => {
  const h = await debugHarness({ run: { lldb: { stdout: LLDB_OUT } } })
  const body = h.json(await h.call('ios_sim_backtrace', { bundle_id: 'com.example.MyApp' })) as { pid: number; engine: string; threadCount: number; resumed: boolean; lines: string[] }
  assert.deepEqual(h.runs[0]!.args, ['-b', '-o', 'attach 1200', '-o', 'thread backtrace all', '-o', 'detach'])
  assert.equal(h.runs[0]!.resumePid, 1200)
  assert.deepEqual([body.pid, body.engine, body.threadCount, body.resumed], [1200, 'lldb', 2, true])
  assert.deepEqual(h.resumeChecks, [1200])
  await h.close()
})

test('ios_sim_backtrace falls back to sample when lldb may not attach, and names the fix', async () => {
  const h = await debugHarness({
    run: {
      lldb: { stderr: 'error: attach failed: not allowed to attach to process', code: 1 },
      sample: (run: RunOptions): Partial<RunOutcome> => {
        const file = run.args[run.args.indexOf('-file') + 1]!
        writeFileSync(file, 'Call graph:\n    1 Thread_1   DispatchQueue_1: com.apple.main-thread\n    + 1 start\n')
        return {}
      },
    },
  })
  const body = h.json(await h.call('ios_sim_backtrace', { pid: 1200 })) as { engine: string; note: string; reportPath: string; lines: string[] }
  assert.equal(body.engine, 'sample')
  assert.match(body.note, /not allowed to attach.*DevToolsSecurity -enable/)
  assert.equal(existsSync(body.reportPath), true)
  assert.equal(body.lines.length, 2)
  await h.close()
})

test('the debug tools never target a pid outside the simulator\'s app processes', async () => {
  const h = await debugHarness()
  assert.match(textOf(await h.call('ios_sim_backtrace', { pid: 1 })), /pid 1 is not a running app process on iPhone 17 Pro/)
  assert.match(textOf(await h.call('ios_sim_leaks', { bundle_id: 'com.example.Other' })), /no running process for "com.example.Other"/)
  assert.match(textOf(await h.call('ios_sim_leaks', {})), /pass pid or bundle_id/)
  assert.equal(h.runs.length, 0)
  await h.close()
})

test('ios_sim_leaks summarizes leaks and suggests MallocStackLogging', async () => {
  const h = await debugHarness({
    run: { leaks: { stdout: 'Process 1200: 1 leak for 48 total leaked bytes.\n    1 (48 bytes) ROOT LEAK: <MyApp.Cache 0x6000> [48]\n', code: 1 } },
  })
  const body = h.json(await h.call('ios_sim_leaks', { pid: 1200 })) as { leaks: number; topTypes: unknown[]; resumed: boolean; note: string }
  assert.deepEqual(h.runs[0]!.args, ['--nostacks', '1200'])
  assert.deepEqual([body.leaks, body.topTypes, body.resumed], [1, [{ type: 'MyApp.Cache', count: 1, bytes: 48 }], true])
  assert.match(body.note, /MallocStackLogging/)
  await h.close()
})

test('real Mac output: lldb denied without Developer Mode falls back to sample; the leaks line parses', async () => {
  // Captured on a Mac against Settings (pid 57643 there), Developer Mode off.
  const h = await debugHarness({
    run: {
      lldb: {
        stdout: '(lldb) process attach --pid 1200\n',
        stderr: 'error: attach failed: attach failed (Not allowed to attach to process.  Look in the console messages (Console.app), near the debugserver entries, when the attach failed.  The subsystem that denied the attach permission will likely have logged an informative message about why it was denied.)\n',
        code: 1,
      },
      sample: (run: RunOptions): Partial<RunOutcome> => {
        writeFileSync(run.args[run.args.indexOf('-file') + 1]!, 'Call graph:\n    1 Thread_1   DispatchQueue_1: com.apple.main-thread\n    + 1 start\n')
        return {}
      },
      leaks: { stdout: 'Process 1200: 73 leaks for 2336 total leaked bytes.\n', code: 1 },
    },
  })
  const trace = h.json(await h.call('ios_sim_backtrace', { bundle_id: 'com.example.MyApp' })) as { engine: string; note: string }
  assert.equal(trace.engine, 'sample')
  assert.match(trace.note, /Not allowed to attach.*sudo DevToolsSecurity -enable/)
  const leaks = h.json(await h.call('ios_sim_leaks', { bundle_id: 'com.example.MyApp' })) as { leaks: number; leakedBytes: number }
  assert.deepEqual([leaks.leaks, leaks.leakedBytes], [73, 2336])
  await h.close()
})

test('ios_sim_leaks memgraph writes the artifact; a fatal leaks line names Developer Mode', async () => {
  const h = await debugHarness({
    run: {
      leaks: (run: RunOptions): Partial<RunOutcome> => {
        const arg = run.args.find(entry => entry.startsWith('--outputGraph='))
        if (arg !== undefined) writeFileSync(arg.slice('--outputGraph='.length), Buffer.alloc(1024))
        return {}
      },
    },
  })
  const body = h.json(await h.call('ios_sim_leaks', { pid: 1200, mode: 'memgraph' })) as { path: string; bytes: number }
  assert.match(body.path, /leaks-MyApp-1200-\d+\.memgraph$/)
  assert.equal(body.bytes, 1024)
  await h.close()
  const denied = await debugHarness({ run: { leaks: { stderr: 'leaks[9]: [fatal] Failed to get DYLD info for task' } } })
  assert.match(textOf(await denied.call('ios_sim_leaks', { pid: 1200 })), /\[fatal\].*DevToolsSecurity -enable/)
  await denied.close()
})

test('ios_sim_app_info reads appinfo, and a missing app points at ios_sim_list_apps', async () => {
  const h = await debugHarness({
    simctl: {
      'appinfo BBB com.example.MyApp': '{\n    CFBundleDisplayName = "My App";\n    CFBundleShortVersionString = "1.2";\n    Path = "/sim/Bundle/MyApp.app";\n}\n',
      'get_app_container BBB com.example.MyApp data': '/sim/Data/42\n',
      'appinfo BBB com.example.Nope': '{\n    CFBundleIdentifier = "com.example.Nope";\n}\n',
    },
  })
  const info = h.json(await h.call('ios_sim_app_info', { bundle_id: 'com.example.MyApp' })) as Record<string, unknown>
  assert.deepEqual([info.installed, info.appPath, info.dataPath, info.displayName, info.shortVersion], [true, '/sim/Bundle/MyApp.app', '/sim/Data/42', 'My App', '1.2'])
  const missing = h.json(await h.call('ios_sim_app_info', { bundle_id: 'com.example.Nope' })) as { installed: boolean; note: string }
  assert.equal(missing.installed, false)
  assert.match(missing.note, /ios_sim_list_apps/)
  await h.close()
})
