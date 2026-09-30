import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PreviewHostController, watchPackageTree, type PreviewStatus, type PreviewToolchain } from '../src/preview-host.js'
import { DROP_DIR_NAME, DYLIB_LIBRARY_NAME, HOST_TARGET_NAME, PREVIEW_HOST_BUNDLE_ID } from '../src/preview-source.js'
import type { SimulatorDevice } from '../src/simctl.js'
import { fixturePackage } from './helpers/swift-package.js'

const DEVICE: SimulatorDevice = { udid: 'BBB', name: 'iPhone 17 Pro', runtime: 'iOS-26-0', state: 'Booted' }

/**
 * A swift toolchain that "builds" by writing the products the controller
 * expects, and a stand-in for the host app that confirms every manifest the
 * way PreviewSession.swift does (result.json with the loaded generation).
 */
function previewWorld(t: TestContext, options: { hostResponds?: boolean } = {}) {
  const calls: string[] = []
  const container = mkdtempSync(join(tmpdir(), 'ios-sim-host-container-'))
  const dropDir = join(container, 'Documents', DROP_DIR_NAME)
  let failBuild: string | undefined
  let onChange: (() => void) | undefined
  let watcherClosed = false
  const toolchain: PreviewToolchain = {
    sdkPath: async () => '/sdk/iPhoneSimulator.sdk',
    swiftBuild: async (dir, triple) => {
      calls.push(`build ${dir.endsWith('host-package') ? 'host' : 'dylib'} ${triple}`)
      if (failBuild !== undefined && !dir.endsWith('host-package')) {
        return { exitCode: 1, lines: ['[1/3] Compiling Feature Card.swift', failBuild] }
      }
      const bin = join(dir, '.build', 'bin')
      mkdirSync(bin, { recursive: true })
      writeFileSync(join(bin, HOST_TARGET_NAME), '#!/bin/sh\n')
      writeFileSync(join(bin, DYLIB_LIBRARY_NAME), `built from:\n${existsSync(join(dir, 'Sources', 'PreviewEntry', 'Entry.swift')) ? readFileSync(join(dir, 'Sources', 'PreviewEntry', 'Entry.swift'), 'utf8') : ''}`)
      return { exitCode: 0, lines: ['Build complete!'] }
    },
    binPath: async dir => join(dir, '.build', 'bin'),
    codesign: async path => { calls.push(`codesign ${path.split('/').pop()}`) },
  }
  const hostTimer = setInterval(() => {
    if (options.hostResponds === false) return
    try {
      const manifest = JSON.parse(readFileSync(join(dropDir, 'manifest.json'), 'utf8')) as { generation: number; dylib: string }
      if (existsSync(join(dropDir, manifest.dylib))) writeFileSync(join(dropDir, 'result.json'), JSON.stringify({ generation: manifest.generation, error: '' }))
    } catch {
      // No manifest yet.
    }
  }, 5)
  t.after(() => clearInterval(hostTimer))
  const controller = new PreviewHostController({
    cacheDir: mkdtempSync(join(tmpdir(), 'ios-sim-preview-cache-')),
    simctl: {
      installApp: async (_udid, appPath) => { calls.push(`install ${appPath.split('/').pop()}`) },
      launchApp: async (_udid, bundleId) => { calls.push(`launch ${bundleId}`); return `${bundleId}: 4242\n` },
      terminateApp: async (_udid, bundleId) => { calls.push(`terminate ${bundleId}`); return '' },
      uninstallApp: async (_udid, bundleId) => { calls.push(`uninstall ${bundleId}`) },
      getAppContainer: async () => container,
    },
    toolchain,
    watch: (_root, change) => {
      onChange = change
      return { close: () => { watcherClosed = true } }
    },
    arch: 'arm64',
    timings: { debounceMs: 5, hostConfirmMs: 400, reloadConfirmMs: 400, pollMs: 5 },
  })
  return {
    controller,
    calls,
    dropDir,
    edit: (): void => onChange?.(),
    failNextBuilds: (error: string | undefined): void => { failBuild = error },
    watcherClosed: (): boolean => watcherClosed,
  }
}

async function until(read: () => PreviewStatus, done: (status: PreviewStatus) => boolean): Promise<PreviewStatus> {
  const deadline = Date.now() + 3000
  for (;;) {
    const status = read()
    if (done(status)) return status
    if (Date.now() > deadline) throw new Error(`timed out; last status: ${JSON.stringify(status)}`)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

test('start builds and launches the host, pushes generation 1 and starts watching', async t => {
  const world = previewWorld(t)
  const status = await world.controller.start({ packagePath: fixturePackage(), device: DEVICE })
  assert.equal(status.running, true)
  assert.deepEqual([status.generation, status.loadedGeneration, status.host?.pid], [1, 1, '4242'])
  assert.deepEqual(status.previews?.map(preview => preview.name), ['Badge_Previews', 'Card "light"', 'Dark'])
  assert.deepEqual(world.calls, [
    'build host arm64-apple-ios18.0-simulator',
    `codesign ${HOST_TARGET_NAME}.app`,
    `install ${HOST_TARGET_NAME}.app`,
    `launch ${PREVIEW_HOST_BUNDLE_ID}`,
    'build dylib arm64-apple-ios18.0-simulator',
    'codesign preview_1.dylib',
  ])
  assert.deepEqual(JSON.parse(readFileSync(join(world.dropDir, 'manifest.json'), 'utf8')), {
    generation: 1, dylib: 'preview_1.dylib', previews: ['Badge_Previews', 'Card "light"', 'Dark'],
  })
  await world.controller.stop()
})

test('an edit hot-swaps a new generation; a broken edit keeps the last good one and reports the error', async t => {
  const world = previewWorld(t)
  const packagePath = fixturePackage()
  await world.controller.start({ packagePath, device: DEVICE, previewFilter: 'card' })
  world.edit()
  const reloaded = await until(() => world.controller.status(), status => status.loadedGeneration === 2)
  assert.deepEqual([reloaded.reloads, reloaded.lastReload?.generation], [1, 2])
  assert.deepEqual(reloaded.previews?.map(preview => preview.name), ['Card "light"'])

  world.failNextBuilds('Card.swift:3:5: error: cannot find \'Crd\' in scope')
  world.edit()
  const broken = await until(() => world.controller.status(), status => status.lastBuildError !== undefined)
  assert.deepEqual(broken.lastBuildError, ['swift build failed (exit 1)', 'Card.swift:3:5: error: cannot find \'Crd\' in scope'])
  assert.deepEqual([broken.generation, broken.loadedGeneration], [2, 2])

  world.failNextBuilds(undefined)
  world.edit()
  const fixed = await until(() => world.controller.status(), status => status.loadedGeneration === 3)
  assert.equal(fixed.lastBuildError, undefined)
  await world.controller.stop()
})

test('old dylib generations are pruned from the drop directory', async t => {
  const world = previewWorld(t)
  await world.controller.start({ packagePath: fixturePackage(), device: DEVICE })
  for (let generation = 2; generation <= 5; generation += 1) {
    world.edit()
    await until(() => world.controller.status(), status => status.loadedGeneration === generation)
  }
  assert.deepEqual(readdirSync(world.dropDir).filter(name => name.endsWith('.dylib')).sort(), ['preview_3.dylib', 'preview_4.dylib', 'preview_5.dylib'])
  await world.controller.stop()
})

test('stop closes the watcher and removes the host app; one session at a time', async t => {
  const world = previewWorld(t)
  await world.controller.start({ packagePath: fixturePackage(), device: DEVICE })
  await assert.rejects(world.controller.start({ packagePath: fixturePackage(), device: DEVICE }), /already running.*only one at a time/)
  const stopped = await world.controller.stop()
  assert.deepEqual([stopped.stopped, world.watcherClosed()], [true, true])
  assert.deepEqual(world.calls.slice(-2), [`terminate ${PREVIEW_HOST_BUNDLE_ID}`, `uninstall ${PREVIEW_HOST_BUNDLE_ID}`])
  assert.deepEqual(world.controller.status(), { running: false })
  assert.deepEqual(await world.controller.stop(), { stopped: false })
})

test('start refuses bad packages before building, and cleans up when the host never confirms', async t => {
  const world = previewWorld(t)
  await assert.rejects(world.controller.start({ packagePath: tmpdir(), device: DEVICE }), /containing Package.swift/)
  await assert.rejects(world.controller.start({ packagePath: fixturePackage(), device: DEVICE, previewFilter: 'nope' }),
    /previewFilter "nope" matched none of the 3 previews: Badge_Previews, Card "light", Dark/)
  assert.deepEqual(world.calls, [])

  const silent = previewWorld(t, { hostResponds: false })
  await assert.rejects(silent.controller.start({ packagePath: fixturePackage(), device: DEVICE }), /did not confirm the first preview/)
  assert.deepEqual(silent.calls.slice(-2), [`terminate ${PREVIEW_HOST_BUNDLE_ID}`, `uninstall ${PREVIEW_HOST_BUNDLE_ID}`])
  assert.equal(silent.controller.running, false)
})

test('watchPackageTree reports source edits and ignores build products', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ios-sim-watch-'))
  mkdirSync(join(root, 'Sources', 'Core'), { recursive: true })
  mkdirSync(join(root, '.build', 'debug'), { recursive: true })
  let changes = 0
  const watcher = watchPackageTree(root, () => { changes += 1 })
  try {
    writeFileSync(join(root, '.build', 'debug', 'x.o'), 'object')
    await new Promise(resolve => setTimeout(resolve, 200))
    assert.equal(changes, 0)
    writeFileSync(join(root, 'Sources', 'Core', 'A.swift'), 'struct A {}')
    const deadline = Date.now() + 3000
    while (changes === 0 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20))
    assert.ok(changes > 0)
  } finally {
    watcher.close()
  }
})
