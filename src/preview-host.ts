// Ported from dsh-ios (MIT, © 2026 ZSeven—W) @ d9a9731 — src/preview-host.ts (session controller)
/**
 * SwiftUI preview hot reload in the simulator.
 *
 *  1. A disposable host app (assets/preview-host/*.swift) is generated and
 *     built in the plugin cache — never inside the user's package — then
 *     installed and launched. It polls `Documents/ios-sim-preview-drop/`.
 *  2. The package plus a generated entry file is built into a simulator
 *     dylib exposing `iossim_preview_count / _name / _make_view`.
 *  3. On every source edit (debounced) the dylib is rebuilt, ad-hoc signed
 *     and dropped in as `preview_<n>.dylib` + `manifest.json`; the host
 *     dlopens it and swaps the view without relaunching. A failed build
 *     keeps the last good preview and its error tail shows in status().
 *  4. The host confirms each load in `result.json`, read from the Mac side
 *     of its data container.
 *
 * swift build, codesign, simctl and file watching come in through options,
 * so the whole loop runs in tests with fakes.
 * @module ios-simulator/preview-host
 */

import { execFile, spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, watch, writeFileSync, type FSWatcher } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { projectSlug } from './build-run.js'
import type { SimctlApi } from './deps.js'
import {
  DEFAULT_IOS_PLATFORM_VERSION,
  DROP_DIR_NAME,
  DYLIB_LIBRARY_NAME,
  filterPreviews,
  filterSwiftBuildErrors,
  generateDylibPackageSwift,
  generateEntrySwift,
  generateHostPackageSwift,
  generateInfoPlist,
  HOST_TARGET_NAME,
  isWatchedChange,
  IGNORED_DIRS,
  PREVIEW_HOST_BUNDLE_ID,
  readPackageManifest,
  scanPackagePreviews,
  toPreviewEntries,
  type PreviewEntry,
  type ScannedPreview,
} from './preview-source.js'
import type { SimulatorDevice } from './simctl.js'

const SWIFT_BUILD_TIMEOUT_MS = 600_000
const SWIFT_OUTPUT_RING_LINES = 1000
const KEPT_DYLIB_GENERATIONS = 3
const HOST_SOURCES = ['PreviewHostApp.swift', 'PreviewSession.swift', 'PreviewRootView.swift']

/** swift / codesign / xcrun, behind a seam. */
export interface PreviewToolchain {
  sdkPath(signal?: AbortSignal): Promise<string>
  swiftBuild(packageDir: string, triple: string, sdk: string, signal?: AbortSignal): Promise<{ exitCode: number | null; lines: string[] }>
  binPath(packageDir: string, triple: string, sdk: string, signal?: AbortSignal): Promise<string>
  codesign(path: string, signal?: AbortSignal): Promise<void>
}

export type PreviewWatch = (root: string, onChange: () => void) => { close(): void }

export interface PreviewTimings {
  debounceMs: number
  /** Wait for the host to confirm the first preview. */
  hostConfirmMs: number
  /** Wait for the host to confirm a reload. */
  reloadConfirmMs: number
  pollMs: number
}

export const DEFAULT_PREVIEW_TIMINGS: PreviewTimings = { debounceMs: 300, hostConfirmMs: 30_000, reloadConfirmMs: 15_000, pollMs: 500 }

export interface PreviewHostOptions {
  /** Cache root; sessions live in `<cacheDir>/<package slug>/`. */
  cacheDir: string
  simctl: Pick<SimctlApi, 'installApp' | 'launchApp' | 'terminateApp' | 'uninstallApp' | 'getAppContainer'>
  toolchain: PreviewToolchain
  watch?: PreviewWatch
  /** Simulator architecture (default: this Mac's). */
  arch?: 'arm64' | 'x86_64'
  timings?: Partial<PreviewTimings>
  /** Directory holding the host app's Swift sources (default assets/preview-host). */
  assetsDir?: string
  log?: (line: string) => void
}

export interface PreviewReloadInfo {
  generation: number
  buildMs: number
  /** Edit → host-confirmed swap. */
  totalMs: number
}

export interface PreviewStatus {
  running: boolean
  device?: { udid: string; name: string }
  package?: { path: string; name: string }
  host?: { bundleId: string; pid?: string }
  /** Last generation pushed to the host. */
  generation?: number
  /** Last generation the host confirmed loading. */
  loadedGeneration?: number
  previews?: PreviewEntry[]
  reloads?: number
  lastReload?: PreviewReloadInfo
  /** Tail of the failed rebuild; absent while the last build succeeded. */
  lastBuildError?: string[]
  lastRuntimeError?: string
  startedAt?: number
}

interface Session {
  packagePath: string
  packageName: string
  device: SimulatorDevice
  pid: string
  filter?: string
  dropDir: string
  dylibPackageDir: string
  triple: string
  platformVersion: number
  sdk: string
  generation: number
  loadedGeneration: number
  previews: PreviewEntry[]
  watcher: { close(): void }
  debounceTimer?: NodeJS.Timeout
  rebuildRunning: boolean
  rebuildQueued: boolean
  reloads: number
  lastReload?: PreviewReloadInfo
  lastBuildError?: string[]
  lastRuntimeError?: string
  startedAt: number
  disposed: boolean
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

function readJsonObject(path: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.tmp-${process.pid}`
  writeFileSync(temporary, JSON.stringify(value))
  renameSync(temporary, path)
}

export function defaultPreviewAssetsDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'preview-host')
}

export class PreviewHostController {
  readonly #options: PreviewHostOptions
  readonly #timings: PreviewTimings
  readonly #watch: PreviewWatch
  #session: Session | undefined
  #starting = false

  constructor(options: PreviewHostOptions) {
    this.#options = options
    this.#timings = { ...DEFAULT_PREVIEW_TIMINGS, ...options.timings }
    this.#watch = options.watch ?? watchPackageTree
  }

  #log(line: string): void {
    this.#options.log?.(`ios-simulator preview: ${line}`)
  }

  get running(): boolean {
    return this.#session !== undefined
  }

  /** Validate the package, build and launch the host, push the first preview, start watching. */
  async start(options: { packagePath: string; device: SimulatorDevice; previewFilter?: string; signal?: AbortSignal }): Promise<PreviewStatus> {
    if (this.#session !== undefined || this.#starting) {
      throw new Error(`a preview session is already running for ${this.#session?.packagePath ?? 'another package'} — only one at a `
        + 'time; stop it first (action "stop") or inspect it (action "status")')
    }
    const packagePath = resolve(options.packagePath)
    if (!existsSync(join(packagePath, 'Package.swift')) || !statSync(packagePath).isDirectory()) {
      throw new Error(`packagePath must be a Swift package directory containing Package.swift: ${packagePath}`)
    }
    const manifest = readPackageManifest(packagePath)
    if (manifest.libraryTargets.length === 0) {
      throw new Error(`${packagePath} has no library targets — previews are read from .target(...) sources`)
    }
    const filter = options.previewFilter?.trim() || undefined
    const scanned = scanPackagePreviews(manifest)
    const matching = filterPreviews(scanned, filter)
    if (matching.length === 0) {
      throw new Error(filter === undefined
        ? `no SwiftUI previews found in ${packagePath} — looked for #Preview { … } and struct X: PreviewProvider in the library targets' sources`
        : `previewFilter ${JSON.stringify(filter)} matched none of the ${scanned.length} previews${scanned.length === 0 ? '' : `: ${scanned.map(preview => preview.name).join(', ')}`}`)
    }
    this.#starting = true
    const platformVersion = Math.max(DEFAULT_IOS_PLATFORM_VERSION, manifest.iosVersion ?? DEFAULT_IOS_PLATFORM_VERSION)
    const arch = this.#options.arch ?? (process.arch === 'x64' ? 'x86_64' : 'arm64')
    const sessionDir = join(this.#options.cacheDir, projectSlug(packagePath))
    const session: Session = {
      packagePath,
      packageName: manifest.name,
      device: options.device,
      pid: '',
      ...(filter === undefined ? {} : { filter }),
      dropDir: '',
      dylibPackageDir: join(sessionDir, 'dylib-package'),
      triple: `${arch}-apple-ios${platformVersion}.0-simulator`,
      platformVersion,
      sdk: '',
      generation: 0,
      loadedGeneration: 0,
      previews: toPreviewEntries(matching),
      watcher: { close() {} },
      rebuildRunning: false,
      rebuildQueued: false,
      reloads: 0,
      startedAt: Date.now(),
      disposed: false,
    }
    try {
      session.sdk = await this.#options.toolchain.sdkPath(options.signal)
      this.#log(`building the host app for ${packagePath}`)
      const appPath = await this.#buildHostApp(sessionDir, session, platformVersion, options.signal)
      const { udid } = options.device
      await this.#options.simctl.installApp(udid, appPath, options.signal)
      const launched = await this.#options.simctl.launchApp(udid, PREVIEW_HOST_BUNDLE_ID, options.signal)
      session.pid = /:\s*(\d+)\s*$/u.exec(launched.trim())?.[1] ?? ''
      session.dropDir = join(await this.#options.simctl.getAppContainer(udid, PREVIEW_HOST_BUNDLE_ID, options.signal), 'Documents', DROP_DIR_NAME)
      this.#writeDylibPackage(session, manifest.productNames, platformVersion, matching, manifest.libraryTargets)
      const build = await this.#options.toolchain.swiftBuild(session.dylibPackageDir, session.triple, session.sdk, options.signal)
      if (build.exitCode !== 0) {
        throw new Error(`swift build failed (exit ${String(build.exitCode)}) for ${packagePath}:\n${filterSwiftBuildErrors(build.lines).join('\n')}`)
      }
      await this.#pushGeneration(session, matching, options.signal)
      if (!await this.#waitForHost(session, 1, this.#timings.hostConfirmMs)) {
        const error = this.#hostResult(session).error
        throw new Error(`the preview host did not confirm the first preview within ${this.#timings.hostConfirmMs / 1000}s`
          + `${typeof error === 'string' && error !== '' ? ` (host reports: ${error})` : ''}`)
      }
      session.loadedGeneration = 1
      session.watcher = this.#watch(packagePath, () => this.#scheduleRebuild(session))
      this.#session = session
      this.#log(`live: ${session.previews.length} preview(s) on ${options.device.name}`)
      return this.status()
    } catch (error) {
      session.disposed = true
      await this.#removeHost(session.device.udid).catch(() => undefined)
      throw error
    } finally {
      this.#starting = false
    }
  }

  /** A live snapshot; reads the host's result.json for its confirmed generation. */
  status(): PreviewStatus {
    const session = this.#session
    if (session === undefined) return { running: false }
    const live = this.#hostResult(session)
    if (typeof live.generation === 'number' && live.generation > session.loadedGeneration) session.loadedGeneration = live.generation
    const hostError = typeof live.error === 'string' && live.error !== '' ? `host: ${live.error}` : undefined
    const runtimeError = session.lastRuntimeError ?? hostError
    return {
      running: true,
      device: { udid: session.device.udid, name: session.device.name },
      package: { path: session.packagePath, name: session.packageName },
      host: { bundleId: PREVIEW_HOST_BUNDLE_ID, ...(session.pid === '' ? {} : { pid: session.pid }) },
      generation: session.generation,
      loadedGeneration: session.loadedGeneration,
      previews: session.previews,
      reloads: session.reloads,
      ...(session.lastReload === undefined ? {} : { lastReload: session.lastReload }),
      ...(session.lastBuildError === undefined ? {} : { lastBuildError: session.lastBuildError }),
      ...(runtimeError === undefined ? {} : { lastRuntimeError: runtimeError }),
      startedAt: session.startedAt,
    }
  }

  /** Stop watching, then terminate and uninstall the host app. */
  async stop(signal?: AbortSignal): Promise<{ stopped: boolean; device?: SimulatorDevice; reloads?: number }> {
    const session = this.#session
    if (session === undefined) return { stopped: false }
    session.disposed = true
    if (session.debounceTimer !== undefined) clearTimeout(session.debounceTimer)
    session.watcher.close()
    this.#session = undefined
    await this.#removeHost(session.device.udid, signal)
    this.#log(`stopped (${session.reloads} reloads)`)
    return { stopped: true, device: session.device, reloads: session.reloads }
  }

  async dispose(): Promise<void> {
    await this.stop().catch(() => undefined)
  }

  async #removeHost(udid: string, signal?: AbortSignal): Promise<void> {
    await this.#options.simctl.terminateApp(udid, PREVIEW_HOST_BUNDLE_ID, signal).catch(() => undefined)
    await this.#options.simctl.uninstallApp(udid, PREVIEW_HOST_BUNDLE_ID, signal).catch(() => undefined)
  }

  async #buildHostApp(sessionDir: string, session: Session, platformVersion: number, signal?: AbortSignal): Promise<string> {
    const packageDir = join(sessionDir, 'host-package')
    const sources = join(packageDir, 'Sources', HOST_TARGET_NAME)
    mkdirSync(sources, { recursive: true })
    const assetsDir = this.#options.assetsDir ?? defaultPreviewAssetsDir()
    for (const name of HOST_SOURCES) {
      if (!existsSync(join(assetsDir, name))) throw new Error(`the preview host sources are missing (${join(assetsDir, name)}) — reinstall the plugin`)
      copyFileSync(join(assetsDir, name), join(sources, name))
    }
    writeFileSync(join(packageDir, 'Package.swift'), generateHostPackageSwift(platformVersion))
    const build = await this.#options.toolchain.swiftBuild(packageDir, session.triple, session.sdk, signal)
    if (build.exitCode !== 0) {
      throw new Error(`swift build failed (exit ${String(build.exitCode)}) for the preview host:\n${filterSwiftBuildErrors(build.lines).join('\n')}`)
    }
    const executable = join(await this.#options.toolchain.binPath(packageDir, session.triple, session.sdk, signal), HOST_TARGET_NAME)
    if (!existsSync(executable)) throw new Error(`the built preview host executable is missing: ${executable}`)
    const appDir = join(sessionDir, `${HOST_TARGET_NAME}.app`)
    rmSync(appDir, { recursive: true, force: true })
    mkdirSync(appDir, { recursive: true })
    copyFileSync(executable, join(appDir, HOST_TARGET_NAME))
    writeFileSync(join(appDir, 'Info.plist'), generateInfoPlist(platformVersion))
    await this.#options.toolchain.codesign(appDir, signal)
    return appDir
  }

  /** Write the dylib package (kept between rebuilds so SwiftPM builds incrementally). */
  #writeDylibPackage(session: Session, productNames: string[], platformVersion: number, previews: ScannedPreview[], modules: string[]): void {
    const entryDir = join(session.dylibPackageDir, 'Sources', 'PreviewEntry')
    mkdirSync(entryDir, { recursive: true })
    const manifestPath = join(session.dylibPackageDir, 'Package.swift')
    const manifestText = generateDylibPackageSwift(session.packagePath, session.packageName, productNames, platformVersion)
    if (!existsSync(manifestPath) || readFileSync(manifestPath, 'utf8') !== manifestText) writeFileSync(manifestPath, manifestText)
    const entryPath = join(entryDir, 'Entry.swift')
    const entryText = generateEntrySwift(previews, modules)
    if (!existsSync(entryPath) || readFileSync(entryPath, 'utf8') !== entryText) writeFileSync(entryPath, entryText)
  }

  async #pushGeneration(session: Session, previews: ScannedPreview[], signal?: AbortSignal): Promise<void> {
    const dylib = join(await this.#options.toolchain.binPath(session.dylibPackageDir, session.triple, session.sdk, signal), DYLIB_LIBRARY_NAME)
    if (!existsSync(dylib)) throw new Error(`the built preview dylib is missing: ${dylib}`)
    const generation = session.generation + 1
    mkdirSync(session.dropDir, { recursive: true })
    const target = join(session.dropDir, `preview_${generation}.dylib`)
    copyFileSync(dylib, target)
    await this.#options.toolchain.codesign(target, signal)
    session.generation = generation
    writeJsonAtomic(join(session.dropDir, 'manifest.json'), {
      generation,
      dylib: `preview_${generation}.dylib`,
      previews: previews.map(preview => preview.name),
    })
    for (const entry of readdirSync(session.dropDir)) {
      const old = /^preview_(\d+)\.dylib$/u.exec(entry)
      if (old !== null && Number(old[1]) <= generation - KEPT_DYLIB_GENERATIONS) rmSync(join(session.dropDir, entry), { force: true })
    }
  }

  async #waitForHost(session: Session, generation: number, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const live = this.#hostResult(session).generation
      if (typeof live === 'number' && live >= generation) return true
      if (Date.now() >= deadline) return false
      await sleep(this.#timings.pollMs)
    }
  }

  #hostResult(session: Session): Record<string, unknown> {
    return session.dropDir === '' ? {} : readJsonObject(join(session.dropDir, 'result.json'))
  }

  #scheduleRebuild(session: Session): void {
    if (session.disposed) return
    if (session.rebuildRunning) {
      session.rebuildQueued = true
      return
    }
    if (session.debounceTimer !== undefined) clearTimeout(session.debounceTimer)
    session.debounceTimer = setTimeout(() => {
      session.debounceTimer = undefined
      void this.#rebuild(session)
    }, this.#timings.debounceMs)
  }

  /** Rescan, regenerate, rebuild, push, confirm. Never throws: failures land in status(). */
  async #rebuild(session: Session): Promise<void> {
    if (session.disposed) return
    session.rebuildRunning = true
    const startedAt = Date.now()
    try {
      const manifest = readPackageManifest(session.packagePath)
      const matching = filterPreviews(scanPackagePreviews(manifest), session.filter)
      // An empty scan still builds: a broken edit must surface its compiler error.
      session.previews = toPreviewEntries(matching)
      this.#writeDylibPackage(session, manifest.productNames, session.platformVersion, matching, manifest.libraryTargets)
      const buildStartedAt = Date.now()
      const build = await this.#options.toolchain.swiftBuild(session.dylibPackageDir, session.triple, session.sdk)
      const buildMs = Date.now() - buildStartedAt
      if (session.disposed) return
      if (build.exitCode !== 0) {
        session.lastBuildError = [`swift build failed (exit ${String(build.exitCode)})`, ...filterSwiftBuildErrors(build.lines)]
        session.lastRuntimeError = undefined
        this.#log(`rebuild failed; keeping generation ${session.loadedGeneration}`)
        return
      }
      session.lastBuildError = undefined
      await this.#pushGeneration(session, matching)
      if (await this.#waitForHost(session, session.generation, this.#timings.reloadConfirmMs)) {
        const totalMs = Date.now() - startedAt
        session.loadedGeneration = session.generation
        session.reloads += 1
        session.lastReload = { generation: session.generation, buildMs, totalMs }
        session.lastRuntimeError = undefined
        this.#log(`hot reloaded generation ${session.generation} (build ${buildMs} ms, total ${totalMs} ms)`)
      } else {
        session.lastRuntimeError = `the host did not confirm generation ${session.generation} within ${this.#timings.reloadConfirmMs / 1000}s — keeping the last good preview`
      }
    } catch (error) {
      session.lastRuntimeError = errorMessage(error)
    } finally {
      session.rebuildRunning = false
      if (session.rebuildQueued && !session.disposed) {
        session.rebuildQueued = false
        void this.#rebuild(session)
      }
    }
  }
}

/** Watch a package tree; build products and VCS dirs never trigger a rebuild. */
export function watchPackageTree(root: string, onChange: () => void): { close(): void } {
  const watchers: FSWatcher[] = []
  let closed = false
  try {
    watchers.push(watch(root, { recursive: true }, (_event, filename) => {
      if (!closed && isWatchedChange(typeof filename === 'string' ? filename : '')) onChange()
    }))
  } catch {
    // No recursive watch on this platform: one watcher per directory.
    const attach = (dir: string): void => {
      watchers.push(watch(dir, () => {
        if (!closed) onChange()
      }))
      let entries
      try {
        entries = readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        if (entry.isDirectory() && !IGNORED_DIRS.has(entry.name)) attach(join(dir, entry.name))
      }
    }
    attach(root)
  }
  return {
    close() {
      closed = true
      for (const watcher of watchers) watcher.close()
    },
  }
}

/** The real toolchain: `xcrun swift build` for the simulator, `codesign -`. */
export const xcrunToolchain: PreviewToolchain = {
  sdkPath: signal => new Promise((resolveSdk, reject) => {
    execFile('xcrun', ['--show-sdk-path', '--sdk', 'iphonesimulator'], { timeout: 30_000, signal }, (error, stdout) => {
      if (error !== null) reject(new Error(`xcrun --show-sdk-path --sdk iphonesimulator failed: ${error.message}`))
      else resolveSdk(stdout.trim())
    })
  }),
  swiftBuild: (packageDir, triple, sdk, signal) => new Promise(resolveBuild => {
    const child = spawn('xcrun', ['swift', 'build', '--sdk', sdk, '--triple', triple, '--disable-index-store'], { cwd: packageDir, stdio: ['ignore', 'pipe', 'pipe'] })
    const lines: string[] = []
    let partial = ''
    const collect = (chunk: Buffer): void => {
      const parts = (partial + chunk.toString('utf8')).split('\n')
      partial = parts.pop() ?? ''
      for (const line of parts) {
        lines.push(line.trimEnd())
        if (lines.length > SWIFT_OUTPUT_RING_LINES) lines.shift()
      }
    }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    const kill = (): void => {
      child.kill('SIGKILL')
    }
    const timer = setTimeout(kill, SWIFT_BUILD_TIMEOUT_MS)
    signal?.addEventListener('abort', kill, { once: true })
    const finish = (exitCode: number | null): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', kill)
      if (partial !== '') lines.push(partial.trimEnd())
      resolveBuild({ exitCode, lines })
    }
    child.once('error', error => {
      lines.push(`failed to start xcrun swift build: ${error.message}`)
      finish(-1)
    })
    child.once('close', finish)
  }),
  binPath: (packageDir, triple, sdk, signal) => new Promise((resolvePath, reject) => {
    execFile('xcrun', ['swift', 'build', '--sdk', sdk, '--triple', triple, '--disable-index-store', '--show-bin-path'],
      { cwd: packageDir, timeout: 60_000, maxBuffer: 1024 * 1024, signal }, (error, stdout, stderr) => {
        const path = stdout.trim()
        if (error !== null || path === '') reject(new Error(`swift build --show-bin-path failed${stderr.trim() === '' ? '' : `: ${stderr.trim()}`}`))
        else resolvePath(path)
      })
  }),
  codesign: (path, signal) => new Promise((resolveSign, reject) => {
    execFile('codesign', ['--force', '--sign', '-', path], { timeout: 120_000, signal }, (error, _stdout, stderr) => {
      if (error !== null) reject(new Error(`codesign failed for ${path}${stderr.trim() === '' ? '' : `: ${stderr.trim()}`}`))
      else resolveSign()
    })
  }),
}
