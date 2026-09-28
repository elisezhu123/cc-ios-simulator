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
import { filterInstalledApps, noMatchCandidateLines, noMatchListingHint, resolveAppByName } from '../app-list.js'
import type { ToolDeps } from '../deps.js'
import { assertMac, ensureStreamFor, requireBooted, resolveTargetDevice } from '../target.js'
import { deviceSummary, jsonResult, runTool, UDID_PARAM } from './result.js'

export function registerAppTools(server: McpServer, deps: ToolDeps): void {
  server.registerTool('ios_sim_list_apps', {
    title: 'List installed apps',
    description: 'List the apps INSTALLED on a booted simulator: bundle id, display name (localized to the simulator '
      + 'language, e.g. 日历 rather than Calendar), version and a system flag. Run it before opening a third-party app '
      + '— never guess a bundle id. query matches the name, the base name and the bundle id (case-insensitive, CJK '
      + 'works); include_system adds the stock Apple apps. A failed listing is an error, so count 0 means no match.',
    inputSchema: {
      udid: UDID_PARAM,
      query: z.string().optional(),
      include_system: z.boolean().optional().describe('Include stock Apple apps (default false)'),
    },
    annotations: { readOnlyHint: true },
  }, async (args, extra) => runTool('ios_sim_list_apps', async () => {
    assertMac(deps.platform)
    const device = await resolveTargetDevice(deps, args.udid)
    requireBooted('ios_sim_list_apps', device)
    const apps = await deps.listApps(device.udid, extra.signal)
    const query = args.query?.trim() ?? ''
    const filtered = filterInstalledApps(apps, { ...(query === '' ? {} : { query }), includeSystem: args.include_system === true })
    const noMatch = filtered.length === 0 && query !== ''
    const candidates = noMatch ? noMatchCandidateLines(apps) : []
    return jsonResult({
      device: deviceSummary(device),
      count: filtered.length,
      apps: filtered,
      ...(noMatch ? { hint: noMatchListingHint('simulator', apps.length) } : {}),
      ...(candidates.length > 0 ? { candidates } : {}),
    })
  }))

  server.registerTool('ios_sim_launch_app', {
    title: 'Launch an installed app',
    description: 'Launch an installed app on a booted simulator. Pass EITHER bundleId OR name (exactly one): name is a '
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
    assertMac(deps.platform)
    const device = await resolveTargetDevice(deps, args.udid)
    requireBooted('ios_sim_launch_app', device)
    const resolved = requestedName === ''
      ? undefined
      : resolveAppByName('ios_sim_launch_app', await deps.listApps(device.udid, extra.signal), requestedName, device.name)
    const bundleId = resolved?.bundleId ?? requestedId
    if (args.relaunch === true) {
      await deps.simctl.terminateApp(device.udid, bundleId, extra.signal).catch(() => undefined)
    }
    let stdout: string
    try {
      stdout = await deps.simctl.launchApp(device.udid, bundleId, extra.signal)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`could not launch ${bundleId} on ${device.name}: ${message} — the app may not be installed, or `
        + 'the bundle id may be wrong (a third-party bundle id cannot be guessed); run ios_sim_list_apps to see what is installed')
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
      scheme: z.string().optional(),
      configuration: z.string().optional().describe('Build configuration (default Debug)'),
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
      + 'bundle id. To build from source use ios_sim_build_run.',
    inputSchema: { appPath: z.string().min(1), udid: UDID_PARAM },
  }, async (args, extra) => runTool('ios_sim_install_app', async () => {
    assertMac(deps.platform)
    const appPath = resolve(args.appPath)
    if (!existsSync(join(appPath, 'Info.plist'))) {
      throw new Error(`appPath must be a built .app bundle directory containing Info.plist: ${args.appPath}`)
    }
    const device = await resolveTargetDevice(deps, args.udid)
    requireBooted('ios_sim_install_app', device)
    await deps.simctl.installApp(device.udid, appPath, extra.signal)
    const bundleId = await deps.builder.readBundleIdentifier(appPath, extra.signal)
    return jsonResult({ device: deviceSummary(device), appPath, bundleId, installed: true })
  }))

  server.registerTool('ios_sim_uninstall_app', {
    title: 'Uninstall an app',
    description: 'Uninstall an app (and its data container) from a booted simulator by bundle id.',
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
