import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  filterPreviews,
  filterSwiftBuildErrors,
  generateDylibPackageSwift,
  generateEntrySwift,
  isWatchedChange,
  readPackageManifest,
  scanMacroPreviews,
  scanPackagePreviews,
  scanProviderPreviews,
} from '../src/preview-source.js'
import { fixturePackage } from './helpers/swift-package.js'

test('readPackageManifest reads the name, targets once each, custom paths, products and the iOS version', () => {
  const dir = fixturePackage()
  const manifest = readPackageManifest(dir)
  assert.equal(manifest.name, 'Demo')
  assert.deepEqual(manifest.libraryTargets, ['Core', 'Feature'])
  assert.equal(manifest.targetDirs.get('Feature'), join(dir, 'Modules', 'Feature'))
  assert.deepEqual(manifest.productNames, ['DemoKit'])
  assert.equal(manifest.iosVersion, 18)
  assert.throws(() => readPackageManifest(tmpdir()), /no Package.swift/)
})

test('scanMacroPreviews reads labels and bodies, ignoring braces in strings and commented-out previews', () => {
  const previews = scanMacroPreviews(`#Preview("Card \\"light\\"") {
  Card()
    .padding() // a { brace
}
/* #Preview { Commented() } */
#Preview { Text("}") }
#Preview("Traits", traits: .landscapeLeft) { Card() }`)
  assert.deepEqual(previews.map(preview => preview.name), ['Card "light"', '#Preview 2', 'Traits'])
  assert.equal(previews[0]!.body, 'Card()\n    .padding() // a { brace')
  assert.equal(previews[1]!.body, 'Text("}")')
  assert.deepEqual(scanProviderPreviews('struct A_Previews: PreviewProvider {}\nstruct B: SomeProto, PreviewProvider {}\n// struct C: PreviewProvider'), ['A_Previews', 'B'])
})

test('scanPackagePreviews scans only the library targets, qualifying providers with their module', () => {
  const previews = scanPackagePreviews(readPackageManifest(fixturePackage()))
  assert.deepEqual(previews.map(preview => [preview.kind, preview.name, preview.ref]), [
    ['provider', 'Badge_Previews', 'Core.Badge_Previews.previews'],
    ['macro', 'Card "light"', undefined],
    ['macro', 'Dark', undefined],
  ])
  assert.deepEqual(filterPreviews(previews, 'DARK').map(preview => preview.name), ['Dark'])
})

test('generated sources: dylib package depends on the products; entry imports @testable and exports the C symbols', () => {
  const dir = fixturePackage()
  const manifest = readPackageManifest(dir)
  const pkg = generateDylibPackageSwift(dir, manifest.name, manifest.productNames, 18)
  assert.match(pkg, /platforms: \[\.iOS\(\.v18\)\]/)
  assert.match(pkg, /\.product\(name: "DemoKit", package: "Demo"\)/)
  const entry = generateEntrySwift(scanPackagePreviews(manifest), manifest.libraryTargets)
  assert.match(entry, /@testable import Core\n@testable import Feature/)
  assert.match(entry, /case 0: return AnyView\(Core\.Badge_Previews\.previews\)/)
  assert.match(entry, /private struct IosSimPreview0: View \{\n {2}var body: some View \{\n {4}iossimBuild \{\n {6}Card\(\)/)
  assert.match(entry, /private let iossimName1 = "Card \\"light\\"".utf8CString/)
  for (const symbol of ['iossim_preview_count', 'iossim_preview_name', 'iossim_preview_make_view']) assert.match(entry, new RegExp(`@_cdecl\\("${symbol}"\\)`))
  assert.match(entry, /return 3\n/)
})

test('build output filtering and watch filtering', () => {
  assert.deepEqual(filterSwiftBuildErrors(['Building for debugging...', '[3/7] Compiling Feature Card.swift', '', 'Card.swift:3:5: error: cannot find \'Crd\' in scope']),
    ['Card.swift:3:5: error: cannot find \'Crd\' in scope'])
  assert.equal(isWatchedChange(join('Sources', 'Core', 'Badge.swift')), true)
  assert.equal(isWatchedChange(join('.build', 'debug', 'x.o')), false)
})
