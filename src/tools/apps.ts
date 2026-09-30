// Ported from dsh-ios (MIT, © 2026 ZSeven—W) @ d9a9731 — src/tools.ts (app tool behaviour)
/**
 * App tools: list, launch (by bundle id or display name), build & run,
 * install and uninstall. Listing and launch rules are ported from dsh-ios
 * src/tools.ts: a failed listing is an error, and bundle ids are never guessed.
 * @module ios-simulator/tools/apps
 */

import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { filterInstalledApps, noMatchCandidateLines, noMatchListingHint, resolveAppByName, type InstalledApp } from '../app-list.js'
import type { ToolDeps } from '../deps.js'
import type { RealApp } from '../devicectl.js'
import { assertMac, ensureStreamFor, realDeviceSummary, requireBooted, resolveTargetDevice, resolveToolTarget, type ToolTarget } from '../target.js'
import { deviceSummary, jsonResult, runTool, UDID_PARAM } from './result.js'

/**
 * xcodebuild honours some flags even where an option's value belongs
 * (`-scheme -version` prints the Xcode version and exits 0), so a scheme or
 * configuration must not start with "-".
 */
const NOT_AN_OPTION = /^(?!\s*-)/u

/** One devicectl app in the listing shape shared with simulators (names are devicectl's, not localized). */
export function installedAppFromRealApp(app: RealApp): InstalledApp {
  // devicectl reports either marker depending on the Xcode version.
  const system = app.defaultApp === true || (app.appType ?? '').toLowerCase() === 'system'
  return { bundleId: app.bundleId, name: app.name === '' ? app.bundleId : app.name, ...(app.version === undefined ? {} : { version: app.version }), system }
}

export function registerAppTools(server: McpServer, deps: ToolDeps): void {
  /** The target of a tool that also works on a connected iPhone/iPad. */
  const targetOf = async (tool: string, udid: string | undefined): Promise<ToolTarget> => {
    assertMac(deps.platform)
    const resolved = await resolveToolTarget(deps, udid)
    if (resolved.kind === 'simulator') requireBooted(tool, resolved.device)
    return resolved
  }
  const summaryOf = (resolved: ToolTarget): ReturnType<typeof deviceSummary> =>
    resolved.kind === 'real' ? realDeviceSummary(resolved.device) : deviceSummary(resolved.device)
  const appsOf = async (resolved: ToolTarget, signal?: AbortSignal): Promise<InstalledApp[]> => resolved.kind === 'real'
    ? (await deps.realDevices.listApps(resolved.device.udid, signal)).map(installedAppFromRealApp)
    : deps.listApps(resolved.device.udid, signal)

  server.registerTool('ios_sim_list_apps', {
    title: 'List installed apps',
    description: 'List the apps INSTALLED on a booted simulator, or on a connected iPhone/iPad (pass its udid or name '
      + 'from ios_sim_devices.realDevices): bundle id, display name (on a simulator localized to its language, e.g. 日历 '
      + 'rather than Calendar; on a real device devicectl\'s base name), version and a system flag. Run it before opening a third-party app '
      + '— never guess a bundle id. query matches the name, the base name and the bundle id (case-insensitive, CJK '
      + 'works); include_system adds the stock Apple apps. A failed listing is an error, so count 0 means no match.',
    inputSchema: {
      udid: UDID_PARAM,
      query: z.string().optional(),
      include_system: z.boolean().optional().describe('Include stock Apple apps (default false)'),
    },
    annotations: { readOnlyHint: true },
  }, async (args, extra) => runTool('ios_sim_list_apps', async () => {
    const resolved = await targetOf('ios_sim_list_apps', args.udid)
    const apps = await appsOf(resolved, extra.signal)
    const query = args.query?.trim() ?? ''
    const filtered = filterInstalledApps(apps, { ...(query === '' ? {} : { query }), includeSystem: args.include_system === true })
    const noMatch = filtered.length === 0 && query !== ''
    const candidates = noMatch ? noMatchCandidateLines(apps) : []
    return jsonResult({
      device: summaryOf(resolved),
      count: filtered.length,
      apps: filtered,
      ...(noMatch ? { hint: noMatchListingHint(resolved.kind, apps.length) } : {}),
      ...(candidates.length > 0 ? { candidates } : {}),
    })
  }))

  server.registerTool('ios_sim_launch_app', {
    title: 'Launch an installed app',
    description: 'Launch an installed app on a booted simulator, or on a connected iPhone/iPad (pass its udid or name). '
      + 'Pass EITHER bundleId OR name (exactly one): name is a '
      + 'case-insensitive display-name substring (localized names work), resolved against the installed apps. '
      + 'Third-party bundle ids cannot be guessed — use name or ios_sim_list_apps. Stable Apple ids: Calendar '
      + 'com.apple.mobilecal, Safari com.apple.mobilesafari, Settings com.apple.Preferences, Photos '
      + 'com.apple.mobileslideshow, Messages com.apple.MobileSMS, Maps com.apple.Maps, Notes com.apple.mobilenotes. '
      + 'relaunch terminates a running instance first. To build from source use ios_sim_build_run.',
    inputSchema: {
      bundleId: z.string().optional(),
      name: z.string().optional(),
      udid: UDID_PARAM,
      relaunch: z.boolean().optional(),
    },
  }, async (args, extra) => runTool('ios_sim_launch_app', async () => {
    const requestedId = args.bundleId?.trim() ?? ''
    const requestedName = args.name?.trim() ?? ''
    if (requestedId !== '' && requestedName !== '') {
      throw new Error(`pass either bundleId or name, not both (bundleId="${requestedId}", name="${requestedName}")`)
    }
    if (requestedId === '' && requestedName === '') {
      throw new Error('bundleId is required, e.g. "com.apple.mobilecal" — or pass name to resolve one by display name; '
        + 'run ios_sim_list_apps to see what is installed')
    }
    const target = await targetOf('ios_sim_launch_app', args.udid)
    const resolved = requestedName === ''
      ? undefined
      : resolveAppByName('ios_sim_launch_app', await appsOf(target, extra.signal), requestedName, target.device.name, { physical: target.kind === 'real' })
    const bundleId = resolved?.bundleId ?? requestedId
    const notLaunched = (error: unknown): Error => new Error(`could not launch ${bundleId} on ${target.device.name}: `
      + `${error instanceof Error ? error.message : String(error)} — the app may not be installed, or the bundle id may be `
      + 'wrong (a third-party bundle id cannot be guessed); run ios_sim_list_apps to see what is installed')
    if (target.kind === 'real') {
      if (args.relaunch === true) await deps.realDevices.terminateApp(target.device.udid, bundleId, extra.signal).catch(() => undefined)
      let launched: { pid?: number }
      try {
        launched = await deps.realDevices.launchApp(target.device.udid, bundleId, extra.signal)
      } catch (error) {
        throw notLaunched(error)
      }
      return jsonResult({
        device: realDeviceSummary(target.device),
        bundleId,
        ...(resolved === undefined ? {} : { name: resolved.name }),
        launched: true,
        ...(launched.pid === undefined ? {} : { pid: launched.pid }),
        ...(args.relaunch === true ? { relaunched: true } : {}),
      })
    }
    const device = target.device
    if (args.relaunch === true) {
      await deps.simctl.terminateApp(device.udid, bundleId, extra.signal).catch(() => undefined)
    }
    let stdout: string
    try {
      stdout = await deps.simctl.launchApp(device.udid, bundleId, extra.signal)
    } catch (error) {
      throw notLaunched(error)
    }
    const pid = Number.parseInt(stdout.split(':').pop()?.trim() ?? '', 10)
    return jsonResult({
      device: deviceSummary(device),
      bundleId,
      ...(resolved === undefined ? {} : { name: resolved.name }),
      launched: true,
      ...(Number.isSafeInteger(pid) && pid > 0 ? { pid } : {}),
      ...(args.relaunch === true ? { relaunched: true } : {}),
    })
  }))

  server.registerTool('ios_sim_build_run', {
    title: 'Build and run on the simulator',
    description: 'Build an Xcode project (.xcodeproj), workspace (.xcworkspace) or Swift package directory for the iOS '
      + 'Simulator, install the .app and launch it. Device: udid/name, else the streamed device, else a booted '
      + 'simulator, else the newest-runtime iPhone (booted for you). On failure the error carries the filtered '
      + 'xcodebuild tail with the compiler errors. A full build takes minutes — do not retry it in a loop.',
    inputSchema: {
      projectPath: z.string().min(1).describe('Absolute path to a .xcodeproj, a .xcworkspace, or a Swift package directory'),
      scheme: z.string().regex(NOT_AN_OPTION, 'scheme must not start with "-"').optional(),
      configuration: z.string().regex(NOT_AN_OPTION, 'configuration must not start with "-"').optional()
        .describe('Build configuration (default Debug)'),
      udid: UDID_PARAM,
    },
  }, async (args, extra) => runTool('ios_sim_build_run', async () => {
    assertMac(deps.platform)
    const target = deps.builder.detectProject(args.projectPath)
    const configuration = args.configuration?.trim() || 'Debug'
    const device = await resolveTargetDevice(deps, args.udid, { bootFallback: true })
    await deps.simctl.bootDevice(device.udid)
    const booted = { ...device, state: 'Booted' }
    const started = Date.now()
    const result = await deps.builder.buildRun({
      target,
      ...(args.scheme === undefined ? {} : { scheme: args.scheme }),
      configuration,
      device: booted,
      cacheDir: deps.cacheRoot,
      signal: extra.signal,
    })
    let panelUrl: string | undefined
    if (deps.host.binary.available) {
      try {
        await ensureStreamFor(deps.host, booted)
        panelUrl = await deps.panel.ensureStarted()
      } catch {
        panelUrl = undefined // the build succeeded; the live view is optional here
      }
    }
    return jsonResult({ ...result, durationMs: Date.now() - started, ...(panelUrl === undefined ? {} : { panelUrl }) })
  }))

  server.registerTool('ios_sim_install_app', {
    title: 'Install a built app',
    description: 'Install a built .app bundle (a directory containing Info.plist) on a booted simulator and report its '
      + 'bundle id. It also installs on a connected iPhone/iPad (pass its udid or name), where the .app must be built '
      + 'for iphoneos and signed for that device. To build for a simulator from source use ios_sim_build_run.',
    inputSchema: { appPath: z.string().min(1), udid: UDID_PARAM },
  }, async (args, extra) => runTool('ios_sim_install_app', async () => {
    assertMac(deps.platform)
    const appPath = resolve(args.appPath)
    if (!existsSync(join(appPath, 'Info.plist'))) {
      throw new Error(`appPath must be a built .app bundle directory containing Info.plist: ${args.appPath}`)
    }
    const target = await targetOf('ios_sim_install_app', args.udid)
    if (target.kind === 'real') await deps.realDevices.installApp(target.device.udid, appPath, extra.signal)
    else await deps.simctl.installApp(target.device.udid, appPath, extra.signal)
    const bundleId = await deps.builder.readBundleIdentifier(appPath, extra.signal)
    return jsonResult({ device: summaryOf(target), appPath, bundleId, installed: true })
  }))

  server.registerTool('ios_sim_uninstall_app', {
    title: 'Uninstall an app',
    description: 'Uninstall an app (and its data container) from a booted simulator by bundle id. Simulators only: on a '
      + 'real iPhone/iPad the app\'s data cannot be recovered, so uninstall it on the device yourself.',
    inputSchema: { bundleId: z.string().min(1), udid: UDID_PARAM },
    annotations: { destructiveHint: true },
  }, async (args, extra) => runTool('ios_sim_uninstall_app', async () => {
    assertMac(deps.platform)
    const bundleId = args.bundleId.trim()
    const device = await resolveTargetDevice(deps, args.udid)
    requireBooted('ios_sim_uninstall_app', device)
    await deps.simctl.uninstallApp(device.udid, bundleId, extra.signal)
    return jsonResult({ device: deviceSummary(device), bundleId, uninstalled: true })
  }))
}
