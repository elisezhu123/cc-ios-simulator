import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AxeHelper, parseDescribeUi, sanitizeAxeNode } from '../src/uitree-backend.js'

/** An executable `axe` stand-in: a shell script that prints `stdout` and exits with `code`. */
function fakeAxeBinary(stdout: string, code = 0): { dir: string; command: string; log: string } {
  const dir = mkdtempSync(join(tmpdir(), 'ios-sim-axe-'))
  const command = join(dir, 'axe')
  const log = join(dir, 'args.log')
  writeFileSync(command, `#!/bin/sh\necho "$@" >> '${log}'\ncat <<'JSON'\n${stdout}\nJSON\nexit ${code}\n`)
  chmodSync(command, 0o755)
  return { dir, command, log }
}

test('sanitizeAxeNode normalizes AXe fields, flattens -0 and keeps flags only when reported', () => {
  const element = sanitizeAxeNode({
    type: 'TextField',
    AXLabel: ' Password ',
    AXUniqueId: '',
    subrole: 'AXSecureTextField',
    enabled: true,
    selected: null,
    frame: { x: -0, y: 10, width: 300, height: 44 },
    children: [{ type: 'Button', AXLabel: 'Show', frame: { x: 1, y: 2, width: 3, height: 4 } }, 'junk'],
  })
  assert.equal(Object.is(element.frame.x, -0), false)
  assert.deepEqual(element.frame, { x: 0, y: 10, w: 300, h: 44 })
  assert.equal(element.label, 'Password')
  assert.equal(element.identifier, undefined)
  assert.equal(element.secure, true)
  assert.equal(element.enabled, true)
  assert.equal('selected' in element, false)
  assert.equal(element.children.length, 1)
  assert.equal(sanitizeAxeNode({ type: 'TextField' }).secure, undefined)
  assert.deepEqual(sanitizeAxeNode(element), element)
})

test('parseDescribeUi rejects non-JSON, non-array and empty payloads', () => {
  assert.equal(parseDescribeUi('[{"type":"Application","frame":{"x":0,"y":0,"width":402,"height":874}}]')[0]!.frame.w, 402)
  assert.throws(() => parseDescribeUi('Booting…'), /non-JSON/)
  assert.throws(() => parseDescribeUi('{}'), /expected a JSON array/)
  assert.throws(() => parseDescribeUi('[]'), /empty element tree/)
})

test('AxeHelper is unavailable off macOS and never downloads there', async () => {
  const helper = new AxeHelper({ cacheDir: mkdtempSync(join(tmpdir(), 'ios-sim-axe-cache-')), platform: 'linux', env: {} })
  assert.match(helper.resolve().reason ?? '', /only runs on macOS/)
  assert.equal((await helper.ensure()).available, false)
  await assert.rejects(helper.describeUi('BBB'), /AXe accessibility helper is unavailable.*brew install cameroncooke\/axe\/axe/)
})

test('AxeHelper honours IOS_SIM_AXE_BIN, and a bad override fails instead of falling through', async () => {
  const fake = fakeAxeBinary('[{"type":"Application","AXLabel":"Settings","frame":{"x":0,"y":0,"width":402,"height":874}}]')
  const cacheDir = mkdtempSync(join(tmpdir(), 'ios-sim-axe-cache-'))
  const helper = new AxeHelper({ cacheDir, platform: 'darwin', env: { IOS_SIM_AXE_BIN: fake.command, PATH: '' } })
  assert.deepEqual(helper.resolve(), { available: true, source: 'path', command: fake.command })
  const roots = await helper.describeUi('BBB')
  assert.equal(roots[0]!.label, 'Settings')
  await helper.tap('BBB', 201, 226)
  assert.deepEqual(readFileSync(fake.log, 'utf8').trim().split('\n'), ['describe-ui --udid BBB', 'tap -x 201 -y 226 --udid BBB'])

  const bad = new AxeHelper({ cacheDir, platform: 'darwin', env: { IOS_SIM_AXE_BIN: join(fake.dir, 'missing'), PATH: '' } })
  assert.match(bad.resolve().reason ?? '', /IOS_SIM_AXE_BIN points at a missing or non-executable file/)
  assert.equal((await bad.ensure()).available, false)
})

test('AxeHelper finds axe on PATH and reports its errors, including an "Error:" stdout with exit 0', async () => {
  const failing = fakeAxeBinary('Error: Simulator BBB is not booted', 1)
  const helper = new AxeHelper({ cacheDir: mkdtempSync(join(tmpdir(), 'ios-sim-axe-cache-')), platform: 'darwin', env: { PATH: failing.dir } })
  assert.equal(helper.resolve().command, failing.command)
  await assert.rejects(helper.describeUi('BBB'), /axe describe-ui --udid BBB failed: Error: Simulator BBB is not booted/)
  const quiet = fakeAxeBinary('Error: no such element')
  const quietHelper = new AxeHelper({ cacheDir: mkdtempSync(join(tmpdir(), 'ios-sim-axe-cache-')), platform: 'darwin', env: { PATH: quiet.dir } })
  await assert.rejects(quietHelper.tap('BBB', 1, 2), /failed: Error: no such element/)
})

test('AxeHelper with IOS_SIM_AXE_OFFLINE=1 reports the missing helper without downloading', async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), 'ios-sim-axe-cache-'))
  const helper = new AxeHelper({ cacheDir, platform: 'darwin', env: { PATH: '', IOS_SIM_AXE_OFFLINE: '1' } })
  const binary = await helper.ensure()
  // Homebrew prefixes are probed too; on a machine without them the cache is the last stop.
  if (!binary.available) assert.match(binary.reason ?? '', /no axe binary found/)
})

/** An `axe` stand-in that prints `failure` (exit 1) on its first `failures` runs, then a tree. */
function flakyAxeBinary(failure: string, failures: number): { command: string; runs(): number } {
  const dir = mkdtempSync(join(tmpdir(), 'ios-sim-axe-'))
  const command = join(dir, 'axe')
  const counter = join(dir, 'runs')
  writeFileSync(counter, '')
  writeFileSync(command, `#!/bin/sh
echo x >> '${counter}'
if [ "$(wc -l < '${counter}')" -le ${failures} ]; then echo '${failure}'; exit 1; fi
echo '[{"type":"Application","AXLabel":"Settings","frame":{"x":0,"y":0,"width":402,"height":874}}]'
`)
  chmodSync(command, 0o755)
  return { command, runs: () => readFileSync(counter, 'utf8').split('\n').filter(line => line !== '').length }
}

test('describeUi waits out a simulator that is still starting: the automation session errors are retried', async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), 'ios-sim-axe-cache-'))
  const starting = flakyAxeBinary('Error: Timed out creating the simulator remote automation session', 2)
  const helper = new AxeHelper({ cacheDir, platform: 'darwin', env: { IOS_SIM_AXE_BIN: starting.command, PATH: '' }, startupRetry: { budgetMs: 5_000, delayMs: 10 } })
  assert.equal((await helper.describeUi('BBB'))[0]!.label, 'Settings')
  assert.equal(starting.runs(), 3)

  const translation = flakyAxeBinary('Error: No translation object returned for simulator. This means you have likely specified a point onscreen that is invalid', 1)
  const second = new AxeHelper({ cacheDir, platform: 'darwin', env: { IOS_SIM_AXE_BIN: translation.command, PATH: '' }, startupRetry: { budgetMs: 5_000, delayMs: 10 } })
  assert.equal((await second.describeUi('BBB'))[0]!.label, 'Settings')
  assert.equal(translation.runs(), 2)
})

test('describeUi gives up when the budget runs out, and never retries another error', async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), 'ios-sim-axe-cache-'))
  const stuck = flakyAxeBinary('Error: Timed out creating the simulator remote automation session', 1_000)
  const helper = new AxeHelper({ cacheDir, platform: 'darwin', env: { IOS_SIM_AXE_BIN: stuck.command, PATH: '' }, startupRetry: { budgetMs: 1_200, delayMs: 20 } })
  await assert.rejects(helper.describeUi('BBB'), /Timed out creating the simulator remote automation session.*still starting/s)
  assert.ok(stuck.runs() >= 2, 'it tried again before giving up')

  const notBooted = flakyAxeBinary('Error: Simulator BBB is not booted', 1_000)
  const other = new AxeHelper({ cacheDir, platform: 'darwin', env: { IOS_SIM_AXE_BIN: notBooted.command, PATH: '' }, startupRetry: { budgetMs: 5_000, delayMs: 10 } })
  await assert.rejects(other.describeUi('BBB'), /not booted/)
  assert.equal(notBooted.runs(), 1)
})
