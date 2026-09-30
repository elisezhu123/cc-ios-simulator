import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  capThreadLines,
  DevTools,
  leaksFatalDiagnostic,
  orderThreads,
  parseLaunchctlApps,
  parseLeaksSummary,
  parseLldbThreads,
  parseOpenStepPlist,
  parseSampleThreads,
  tailLogLines,
} from '../src/devtools.js'

test('parseLaunchctlApps keeps the UIKitApplication rows, sorted by pid', () => {
  const stdout = [
    'PID\tStatus\tLabel',
    '4321\t0\tUIKitApplication:com.apple.Preferences[3a1f][rb-legacy]',
    '-\t0\tUIKitApplication:com.apple.mobilecal[99ab]',
    '1200\t0\tUIKitApplication:com.example.MyApp[1c2d][rb-legacy]',
    '88\t0\tcom.apple.backboardd',
  ].join('\n')
  assert.deepEqual(parseLaunchctlApps(stdout), [
    { pid: 1200, name: 'MyApp', bundleId: 'com.example.MyApp' },
    { pid: 4321, name: 'Preferences', bundleId: 'com.apple.Preferences' },
  ])
})

const LLDB_OUTPUT = `(lldb) process attach --pid 1200
Process 1200 stopped
* thread #1, queue = 'com.apple.main-thread', stop reason = signal SIGSTOP
    frame #0: 0x0000000180a2c3f4 libsystem_kernel.dylib\`mach_msg2_trap + 8
(lldb) thread backtrace all
  thread #2
    frame #0: 0x0000000180a2e1d8 libsystem_kernel.dylib\`__workq_kernreturn + 8
* thread #1, queue = 'com.apple.main-thread', stop reason = signal SIGSTOP
  * frame #0: 0x0000000180a2c3f4 libsystem_kernel.dylib\`mach_msg2_trap + 8
    frame #1: 0x0000000100a1b2c4 MyApp\`ViewController.load() + 44
(lldb) detach
Process 1200 detached`

test('parseLldbThreads splits thread sections and orderThreads puts the main thread first', () => {
  const threads = parseLldbThreads(LLDB_OUTPUT)
  // The attach banner's stop line is a header of its own, then the real backtrace.
  assert.equal(threads.length, 3)
  const ordered = orderThreads(threads.slice(1), true)
  assert.match(ordered[0]!.header, /main-thread/)
  assert.match(ordered[0]!.lines[1]!, /ViewController\.load/)
  assert.equal(orderThreads(threads.slice(1), false).length, 1)
  const capped = capThreadLines(ordered, 4)
  assert.equal(capped.truncated, true)
  assert.equal(capped.lines.length, 4)
})

test('parseSampleThreads reads the call graph of a sample report', () => {
  const report = [
    'Analysis of sampling MyApp (pid 1200) every 1 millisecond',
    'Call graph:',
    '    1 Thread_1234   DispatchQueue_1: com.apple.main-thread  (serial)',
    '    + 1 start  (in dyld) + 6076  [0x180696b4c]',
    '    1 Thread_1240',
    '    + 1 start_wqthread  (in libsystem_pthread.dylib) + 8',
    '',
    'Total number in stack (recursive counted multiple, when >=5):',
  ].join('\n')
  const threads = parseSampleThreads(report)
  assert.deepEqual(threads.map(thread => thread.lines.length), [1, 1])
  assert.match(orderThreads(threads, false)[0]!.header, /main-thread/)
})

test('parseLeaksSummary aggregates root leaks by type; fatal lines are recognized', () => {
  const stdout = [
    'Process 1200: 5021 nodes malloced for 1204 KB',
    'Process 1200: 3 leaks for 144 total leaked bytes.',
    '',
    '    2 (96 bytes) ROOT LEAK: <MyApp.Cache 0x600000c1c000> [48]',
    '    1 (48 bytes) ROOT LEAK: <NSMutableArray 0x600000c1d000> [48]',
    '    1 (48 bytes) ROOT LEAK: <MyApp.Cache 0x600000c1e000> [48]',
  ].join('\n')
  assert.deepEqual(parseLeaksSummary(stdout), {
    leaks: 3,
    leakedBytes: 144,
    nodes: 5021,
    nodesBytes: '1204 KB',
    topTypes: [{ type: 'MyApp.Cache', count: 3, bytes: 96 }, { type: 'NSMutableArray', count: 1, bytes: 48 }],
  })
  assert.equal(parseLeaksSummary('garbage'), undefined)
  assert.match(leaksFatalDiagnostic('leaks[1]: [fatal] unable to examine process', '') ?? '', /\[fatal\]/)
  assert.equal(leaksFatalDiagnostic('', 'Process 1200: 0 leaks for 0 total leaked bytes.'), undefined)
})

test('parseOpenStepPlist reads scalar fields and turns file URLs into paths', () => {
  const fields = parseOpenStepPlist([
    '{',
    '    ApplicationType = User;',
    '    CFBundleDisplayName = "My App";',
    '    DataContainer = "file:///Users/me/Library/Developer/CoreSimulator/Devices/BBB/data/Containers/Data/Application/42/";',
    '    Path = "/Users/me/Library/Developer/CoreSimulator/Devices/BBB/data/Containers/Bundle/Application/7/MyApp.app";',
    '    GroupContainers = { };',
    '}',
  ].join('\n'))
  assert.equal(fields.CFBundleDisplayName, 'My App')
  assert.equal(fields.DataContainer, '/Users/me/Library/Developer/CoreSimulator/Devices/BBB/data/Containers/Data/Application/42')
  assert.equal(fields.GroupContainers, undefined)
})

test('tailLogLines strips banners and ANSI, applies grep, and keeps the tail under the caps', () => {
  const text = [
    'Filtering the log data using "process == \\"MyApp\\""',
    'Timestamp               Ty Process[PID:TID]',
    '\u001b[31m2026-09-30 10:00:00.000 E  MyApp[1200:1] boom\u001b[0m',
    ...Array.from({ length: 20 }, (_, index) => `2026-09-30 10:00:01.${index} Df MyApp[1200:1] line ${index}`),
  ].join('\n')
  const errors = tailLogLines(text, { maxLines: 300, maxBytes: 30_000, grep: /boom/ })
  assert.deepEqual(errors, { lines: ['2026-09-30 10:00:00.000 E  MyApp[1200:1] boom'], truncated: false })
  const tail = tailLogLines(text, { maxLines: 5, maxBytes: 30_000 })
  assert.equal(tail.truncated, true)
  assert.deepEqual(tail.lines.map(line => line.split(' ').pop()), ['15', '16', '17', '18', '19'])
})

test('DevTools.run closes a capture window successfully with what was printed', async () => {
  const devtools = new DevTools({ platform: 'linux', env: {} })
  const outcome = await devtools.run({
    command: process.execPath,
    args: ['-e', 'console.log("first"); setInterval(() => {}, 1000)'],
    label: 'fake log stream',
    timeoutMs: 10_000,
    windowMs: 400,
  })
  assert.equal(outcome.killed, true)
  assert.equal(outcome.stdout.trim(), 'first')
})

test('DevTools.run reports exit codes, deadlines and aborts', async () => {
  const devtools = new DevTools({ platform: 'linux', env: {} })
  const failed = await devtools.run({ command: process.execPath, args: ['-e', 'console.error("nope"); process.exit(3)'], label: 'x', timeoutMs: 10_000 })
  assert.deepEqual([failed.code, failed.killed, failed.stderr.trim()], [3, false, 'nope'])
  await assert.rejects(
    devtools.run({ command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], label: 'lldb backtrace of pid 1', timeoutMs: 300 }),
    /lldb backtrace of pid 1 exceeded its 300 ms deadline and was killed/,
  )
  const controller = new AbortController()
  const pending = devtools.run({ command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], label: 'leaks summary', timeoutMs: 10_000, signal: controller.signal })
  setTimeout(() => controller.abort(), 200)
  await assert.rejects(pending, /leaks summary aborted/)
  await assert.rejects(devtools.run({ command: '/nonexistent/lldb', args: [], label: 'lldb', timeoutMs: 1000 }), /lldb failed to start/)
})

test('DevTools.ensureRunning SIGCONTs a stopped target and reports a vanished one', async () => {
  const stats = ['T', 'T', 'S']
  const devtools = new DevTools({ platform: 'linux', env: {}, processStat: () => stats.shift() })
  // Signal our own process: SIGCONT is harmless to a running process.
  assert.equal(await devtools.ensureRunning(process.pid), true)
  const gone = new DevTools({ platform: 'linux', env: {}, processStat: () => undefined })
  assert.equal(await gone.ensureRunning(999_999), false)
  assert.equal(new DevTools({ platform: 'linux', env: {} }).which('lldb'), undefined)
})
