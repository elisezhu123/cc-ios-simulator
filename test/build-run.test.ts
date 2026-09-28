import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  assembleBuildArgs,
  detectProject,
  filterBuildOutput,
  findBuiltApp,
  projectSlug,
  resolveScheme,
} from '../src/build-run.js'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'ios-sim-build-'))
}

test('detectProject recognises xcodeproj, xcworkspace and Swift packages', () => {
  const root = tempDir()
  mkdirSync(join(root, 'App.xcodeproj'))
  mkdirSync(join(root, 'App.xcworkspace'))
  mkdirSync(join(root, 'Pkg'))
  writeFileSync(join(root, 'Pkg', 'Package.swift'), 'let package = Package(name: "Pkg")')
  assert.equal(detectProject(join(root, 'App.xcodeproj')).kind, 'xcodeproj')
  assert.equal(detectProject(join(root, 'App.xcworkspace')).kind, 'xcworkspace')
  assert.deepEqual(detectProject(join(root, 'Pkg')), { kind: 'package', root: join(root, 'Pkg'), location: join(root, 'Pkg') })
  assert.throws(() => detectProject(join(root, 'missing.xcodeproj')), /does not exist/)
  assert.throws(() => detectProject(root), /must be an absolute path/)
})

test('assembleBuildArgs targets the iOS Simulator destination only', () => {
  const args = assembleBuildArgs({
    target: { kind: 'xcodeproj', root: '/p', location: '/p/App.xcodeproj' },
    scheme: 'App',
    configuration: 'Debug',
    udid: 'BBB',
    derivedDataPath: '/c/DD',
  })
  assert.deepEqual(args, [
    '-project', '/p/App.xcodeproj', '-scheme', 'App', '-configuration', 'Debug',
    '-destination', 'platform=iOS Simulator,id=BBB', '-derivedDataPath', '/c/DD', 'build',
  ])
})

test('assembleBuildArgs omits -project/-workspace for packages', () => {
  const args = assembleBuildArgs({
    target: { kind: 'package', root: '/pkg', location: '/pkg' },
    configuration: 'Release',
    udid: 'X',
    derivedDataPath: '/dd',
  })
  assert.deepEqual(args, ['-configuration', 'Release', '-destination', 'platform=iOS Simulator,id=X', '-derivedDataPath', '/dd', 'build'])
})

test('resolveScheme prefers the explicit scheme, then the package manifest name', async () => {
  const root = tempDir()
  writeFileSync(join(root, 'Package.swift'), '// swift-tools-version:5.9\nlet package = Package(\n    name: "Demo",\n)\n')
  const target = { kind: 'package' as const, root, location: root }
  assert.equal(await resolveScheme(target, ' Explicit '), 'Explicit')
  assert.equal(await resolveScheme(target, undefined), 'Demo')
})

test('filterBuildOutput drops xcodebuild noise and keeps diagnostics', () => {
  const lines = [
    'CompileSwift normal arm64 /x.swift',
    '',
    '/x.swift:3:5: error: cannot find foo in scope',
    '    foo()',
    'note: Building targets in dependency order',
    '** BUILD FAILED **',
  ]
  assert.deepEqual(filterBuildOutput(lines), ['/x.swift:3:5: error: cannot find foo in scope', '    foo()', '** BUILD FAILED **'])
})

test('findBuiltApp picks the scheme-named .app under the simulator products', () => {
  const derived = tempDir()
  const products = join(derived, 'Build', 'Products', 'Debug-iphonesimulator')
  for (const name of ['Other.app', 'App.app']) {
    mkdirSync(join(products, name), { recursive: true })
    writeFileSync(join(products, name, 'Info.plist'), '')
  }
  assert.equal(findBuiltApp(derived, 'Debug', 'App'), join(products, 'App.app'))
  assert.equal(findBuiltApp(derived, 'Release', 'App'), undefined)
})

test('projectSlug is path-safe', () => {
  assert.equal(projectSlug('/x/My App.xcodeproj'), 'My_App')
})
