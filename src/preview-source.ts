// Ported from dsh-ios (MIT, © 2026 ZSeven—W) @ d9a9731 — src/preview-host.ts (manifest, preview scan, generated sources)
/**
 * The pure half of the SwiftUI preview hot reload: read Package.swift,
 * find the package's previews (`#Preview { … }` and
 * `struct X_Previews: PreviewProvider`), and generate the Swift sources of
 * the disposable host package and the hot-swapped preview dylib.
 * @module ios-simulator/preview-source
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'

/** Bundle id of the generated host app (stable across sessions). */
export const PREVIEW_HOST_BUNDLE_ID = 'dev.ios-simulator.preview-host'
export const HOST_TARGET_NAME = 'IosSimPreviewHost'
export const DYLIB_TARGET_NAME = 'IosSimPreviewDylib'
export const DYLIB_LIBRARY_NAME = `lib${DYLIB_TARGET_NAME}.dylib`
/** The directory inside the host's Documents it polls for new dylibs. */
export const DROP_DIR_NAME = 'ios-sim-preview-drop'
/** Oldest iOS the generated packages target (the #Preview macro needs 17). */
export const DEFAULT_IOS_PLATFORM_VERSION = 17
const ERROR_TAIL_LINES = 40

/** Source directories never scanned or watched. */
export const IGNORED_DIRS: ReadonlySet<string> = new Set(['.build', '.git', '.swiftpm', 'DerivedData', 'node_modules', 'xcuserdata'])

export interface PackageManifest {
  name: string
  /** Regular `.target(...)` names (test and executable targets excluded). */
  libraryTargets: string[]
  /** Declared library products, else the targets (SwiftPM synthesizes one each). */
  productNames: string[]
  /** Target name → absolute source directory. */
  targetDirs: Map<string, string>
  iosVersion?: number
}

export interface ScannedPreview {
  kind: 'macro' | 'provider'
  name: string
  /** Macro closure body, spliced into a @ViewBuilder wrapper. */
  body?: string
  /** Provider expression, e.g. `Module.Foo_Previews.previews`. */
  ref?: string
}

/** One preview as the tool reports it. */
export interface PreviewEntry {
  id: string
  name: string
  kind: 'macro' | 'provider'
}

/** Swift string literal (JSON escaping is a safe subset). */
export function swiftStringLiteral(value: string): string {
  return JSON.stringify(value)
}

/** The balanced `( … )` contents of every `.<selector>(` call. */
function extractCallArguments(text: string, selector: string): string[] {
  const found: string[] = []
  const needle = `.${selector}`
  let searchFrom = 0
  for (;;) {
    const index = text.indexOf(needle, searchFrom)
    if (index < 0) break
    searchFrom = index + needle.length
    const previous = text[index - 1]
    if (previous !== undefined && /[\w$]/u.test(previous)) continue
    let cursor = index + needle.length
    while (cursor < text.length && /\s/u.test(text[cursor]!)) cursor += 1
    if (text[cursor] !== '(') continue
    const close = findClosingDelimiter(text, cursor, '(', ')')
    if (close < 0) break
    found.push(text.slice(cursor + 1, close))
    searchFrom = close + 1
  }
  return found
}

/** Parse Package.swift into the bits the generated packages need. */
export function readPackageManifest(packageDir: string): PackageManifest {
  const manifestPath = join(packageDir, 'Package.swift')
  if (!existsSync(manifestPath)) throw new Error(`no Package.swift found in ${packageDir}`)
  const text = stripStringsAndComments(readFileSync(manifestPath, 'utf8'), { keepStrings: true })
  // The first `name:` in a manifest is the package's (targets and products come later).
  const name = /name\s*:\s*"([^"]+)"/u.exec(text)?.[1] ?? 'Package'
  const iosVersionMatch = /\.iOS\(\s*\.v(\d+)/u.exec(text)
  const libraryTargets: string[] = []
  const targetDirs = new Map<string, string>()
  for (const args of extractCallArguments(text, 'target')) {
    const targetName = /name\s*:\s*"([^"]+)"/u.exec(args)?.[1]
    // `.target(name: "X")` also appears inside dependency lists; count each target once.
    if (targetName === undefined || targetDirs.has(targetName)) continue
    const path = /path\s*:\s*"([^"]+)"/u.exec(args)?.[1]
    libraryTargets.push(targetName)
    targetDirs.set(targetName, path === undefined ? join(packageDir, 'Sources', targetName) : resolve(packageDir, path))
  }
  const productNames = extractCallArguments(text, 'library').flatMap(args => /name\s*:\s*"([^"]+)"/u.exec(args)?.slice(1) ?? [])
  return {
    name,
    libraryTargets,
    productNames: productNames.length > 0 ? productNames : libraryTargets,
    targetDirs,
    ...(iosVersionMatch === null ? {} : { iosVersion: Number(iosVersionMatch[1]) }),
  }
}

/**
 * Blank out comment contents (and, unless kept, string contents) with
 * spaces, preserving every position and newline, so brace scanning can
 * ignore them. String delimiters stay visible.
 */
export function stripStringsAndComments(text: string, options: { keepStrings?: boolean } = {}): string {
  const chars = [...text]
  const out = chars.slice()
  const blank = (index: number): void => {
    if (out[index] !== '\n') out[index] = ' '
  }
  let index = 0
  while (index < chars.length) {
    const char = chars[index]
    if (char === '/' && chars[index + 1] === '/') {
      while (index < chars.length && chars[index] !== '\n') blank(index++)
      continue
    }
    if (char === '/' && chars[index + 1] === '*') {
      while (index < chars.length && !(chars[index] === '*' && chars[index + 1] === '/')) blank(index++)
      if (index < chars.length) {
        blank(index)
        blank(index + 1)
        index += 2
      }
      continue
    }
    if (char === '"') {
      const triple = chars[index + 1] === '"' && chars[index + 2] === '"'
      index += triple ? 3 : 1
      while (index < chars.length) {
        if (triple ? chars[index] === '"' && chars[index + 1] === '"' && chars[index + 2] === '"' : chars[index] === '"') break
        if (!triple && chars[index] === '\n') break
        if (chars[index] === '\\') {
          if (options.keepStrings !== true) blank(index)
          index += 1
        }
        if (index < chars.length && options.keepStrings !== true) blank(index)
        index += 1
      }
      index += triple ? 3 : 1
      continue
    }
    index += 1
  }
  return out.join('')
}

/** Index of the delimiter closing the one at `openIndex`, or -1. */
export function findClosingDelimiter(text: string, openIndex: number, open: string, close: string): number {
  let depth = 0
  for (let index = openIndex; index < text.length; index += 1) {
    if (text[index] === open) depth += 1
    else if (text[index] === close) {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}

/** `#Preview { … }` / `#Preview("Name", traits: …) { … }` declarations of one file. */
export function scanMacroPreviews(original: string): Array<{ name: string; body: string }> {
  const sanitized = stripStringsAndComments(original)
  const found: Array<{ name: string; body: string }> = []
  const pattern = /#Preview\b/gu
  let match: RegExpExecArray | null
  while ((match = pattern.exec(sanitized)) !== null) {
    let cursor = match.index + match[0].length
    while (cursor < sanitized.length && /\s/u.test(sanitized[cursor]!)) cursor += 1
    let label: string | undefined
    if (sanitized[cursor] === '(') {
      const close = findClosingDelimiter(sanitized, cursor, '(', ')')
      if (close < 0) continue
      const quoted = /"((?:[^"\\]|\\.)*)"/u.exec(original.slice(cursor + 1, close))
      label = quoted?.[1]?.replace(/\\(["\\])/gu, '$1')
      cursor = close + 1
    }
    while (cursor < sanitized.length && /\s/u.test(sanitized[cursor]!)) cursor += 1
    // Only the trailing-closure form can be spliced into a wrapper.
    if (sanitized[cursor] !== '{') continue
    const close = findClosingDelimiter(sanitized, cursor, '{', '}')
    if (close < 0) continue
    found.push({ name: label !== undefined && label !== '' ? label : `#Preview ${found.length + 1}`, body: original.slice(cursor + 1, close).trim() })
    pattern.lastIndex = close + 1
  }
  return found
}

/** `struct X: PreviewProvider` declarations of one file. */
export function scanProviderPreviews(original: string): string[] {
  const sanitized = stripStringsAndComments(original)
  return [...sanitized.matchAll(/struct\s+([A-Za-z_]\w*)\s*:\s*(?:[\w.]+\s*,\s*)*PreviewProvider\b/gu)].map(match => match[1]!)
}

function walkSwiftFiles(root: string, depth = 0): string[] {
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return []
  }
  const files: string[] = []
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) {
      if (depth < 12 && !IGNORED_DIRS.has(entry.name)) files.push(...walkSwiftFiles(path, depth + 1))
    } else if (entry.isFile() && entry.name.endsWith('.swift') && !entry.name.startsWith('.')) {
      files.push(path)
    }
  }
  return files
}

/** Every preview of the package's library targets, in file order. */
export function scanPackagePreviews(manifest: PackageManifest): ScannedPreview[] {
  const previews: ScannedPreview[] = []
  for (const [module, dir] of manifest.targetDirs) {
    for (const file of walkSwiftFiles(dir)) {
      let text: string
      try {
        text = readFileSync(file, 'utf8')
      } catch {
        continue
      }
      for (const macro of scanMacroPreviews(text)) previews.push({ kind: 'macro', name: macro.name, body: macro.body })
      for (const provider of scanProviderPreviews(text)) previews.push({ kind: 'provider', name: provider, ref: `${module}.${provider}.previews` })
    }
  }
  return previews
}

/** Keep the previews whose name contains `filter` (case-insensitive). */
export function filterPreviews(previews: readonly ScannedPreview[], filter: string | undefined): ScannedPreview[] {
  const needle = filter?.trim().toLowerCase() ?? ''
  return needle === '' ? [...previews] : previews.filter(preview => preview.name.toLowerCase().includes(needle))
}

export function toPreviewEntries(previews: readonly ScannedPreview[]): PreviewEntry[] {
  return previews.map((preview, index) => ({ id: `p${index}`, name: preview.name, kind: preview.kind }))
}

/** True when a watched path (relative to the package) should trigger a rebuild. */
export function isWatchedChange(relativePath: string): boolean {
  const top = relativePath.split(sep)[0] ?? ''
  return !IGNORED_DIRS.has(top)
}

export function generateHostPackageSwift(platformVersion: number): string {
  return `// swift-tools-version: 5.9
import PackageDescription
let package = Package(
  name: ${swiftStringLiteral(HOST_TARGET_NAME)},
  platforms: [.iOS(.v${platformVersion})],
  targets: [.executableTarget(name: ${swiftStringLiteral(HOST_TARGET_NAME)})]
)
`
}

export function generateDylibPackageSwift(packagePath: string, packageName: string, productNames: readonly string[], platformVersion: number): string {
  const dependencies = productNames
    .map(product => `.product(name: ${swiftStringLiteral(product)}, package: ${swiftStringLiteral(packageName)})`)
    .join(', ')
  return `// swift-tools-version: 5.9
import PackageDescription
let package = Package(
  name: ${swiftStringLiteral(DYLIB_TARGET_NAME)},
  platforms: [.iOS(.v${platformVersion})],
  products: [
    .library(name: ${swiftStringLiteral(DYLIB_TARGET_NAME)}, type: .dynamic, targets: ["PreviewEntry"])
  ],
  dependencies: [
    .package(path: ${swiftStringLiteral(packagePath)})
  ],
  targets: [
    .target(name: "PreviewEntry", dependencies: [${dependencies}])
  ]
)
`
}

/**
 * The hot-swap entry file: a preview registry behind three @_cdecl symbols
 * the host resolves with dlsym. `#Preview` bodies go into a @ViewBuilder
 * wrapper; PreviewProvider structs are referenced directly. The package's
 * modules are imported @testable (SwiftPM debug builds enable testing), so
 * previews may use internal types.
 */
export function generateEntrySwift(previews: readonly ScannedPreview[], modules: readonly string[]): string {
  const lines = [
    '// Generated by the ios-simulator plugin: hot-swapped SwiftUI preview entry points.',
    '// Regenerated on every package edit; do not edit by hand.',
    'import SwiftUI',
    ...modules.map(module => `@testable import ${module}`),
    '',
    'private final class ViewBox {',
    '  let view: AnyView',
    '  init(_ view: AnyView) { self.view = view }',
    '}',
    '',
    '@ViewBuilder',
    'private func iossimBuild<Content: View>(@ViewBuilder _ content: () -> Content) -> Content {',
    '  content()',
    '}',
    '',
  ]
  const cases: string[] = []
  const names: string[] = []
  let macroIndex = 0
  previews.forEach((preview, index) => {
    names.push(`private let iossimName${index} = ${swiftStringLiteral(preview.name)}.utf8CString`)
    if (preview.kind === 'macro') {
      const structName = `IosSimPreview${macroIndex}`
      macroIndex += 1
      lines.push(`private struct ${structName}: View {`, '  var body: some View {', '    iossimBuild {')
      for (const bodyLine of (preview.body ?? '').split('\n')) lines.push(`      ${bodyLine}`)
      lines.push('    }', '  }', '}')
      cases.push(`  case ${index}: return AnyView(${structName}())`)
    } else {
      cases.push(`  case ${index}: return AnyView(${preview.ref ?? 'EmptyView()'})`)
    }
  })
  lines.push('', 'private func iossimItem(_ index: Int) -> AnyView {', '  switch index {', ...cases,
    '  default: return AnyView(EmptyView())', '  }', '}')
  if (names.length > 0) lines.push('', ...names)
  lines.push(
    '',
    '@_cdecl("iossim_preview_count")',
    'public func iossimPreviewCount() -> Int {',
    `  return ${previews.length}`,
    '}',
    '',
    '@_cdecl("iossim_preview_name")',
    'public func iossimPreviewName(_ index: Int) -> UnsafePointer<CChar>? {',
    '  switch index {',
    ...previews.map((_, index) => `  case ${index}: return iossimName${index}.withUnsafeBufferPointer { $0.baseAddress }`),
    '  default: return nil',
    '  }',
    '}',
    '',
    '@_cdecl("iossim_preview_make_view")',
    'public func iossimPreviewMakeView(_ index: Int) -> UnsafeMutableRawPointer {',
    '  Unmanaged.passRetained(ViewBox(iossimItem(index))).toOpaque()',
    '}',
  )
  return `${lines.join('\n')}\n`
}

export function generateInfoPlist(platformVersion: number): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleDisplayName</key>
	<string>SwiftUI Preview</string>
	<key>CFBundleExecutable</key>
	<string>${HOST_TARGET_NAME}</string>
	<key>CFBundleIdentifier</key>
	<string>${PREVIEW_HOST_BUNDLE_ID}</string>
	<key>CFBundleName</key>
	<string>SwiftUI Preview</string>
	<key>CFBundlePackageType</key>
	<string>APPL</string>
	<key>CFBundleShortVersionString</key>
	<string>1.0</string>
	<key>CFBundleVersion</key>
	<string>1</string>
	<key>LSRequiresIPhoneOS</key>
	<true/>
	<key>MinimumOSVersion</key>
	<string>${platformVersion}.0</string>
	<key>UIApplicationSceneManifest</key>
	<dict>
		<key>UIApplicationSupportsMultipleScenes</key>
		<false/>
	</dict>
	<key>UIDeviceFamily</key>
	<array>
		<integer>1</integer>
		<integer>2</integer>
	</array>
</dict>
</plist>
`
}

/** The actionable tail of `swift build` output (progress lines dropped). */
export function filterSwiftBuildErrors(lines: readonly string[]): string[] {
  return lines
    .filter(line => line.trim() !== '')
    .filter(line => !/^\[\d+\/\d+\] /u.test(line))
    .filter(line => !/^(Build complete!|Planning build|Building for debugging\.\.\.|Fetching |Updating |Resolving |Computing version)/u.test(line))
    .slice(-ERROR_TAIL_LINES)
}
