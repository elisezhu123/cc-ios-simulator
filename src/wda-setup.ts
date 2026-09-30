// Ported from dsh-ios (MIT, © 2026 ZSeven—W) @ d9a9731 — src/devicectl.ts (signing team), src/wda-physical-stage.ts
/**
 * What a WebDriverAgent build needs before xcodebuild runs:
 *
 * - a signing team, chosen like Xcode's automatic provisioning would:
 *   explicit setting → IOS_SIM_TEAM_ID → an Xcode account team that has an
 *   Apple Development identity in the keychain → the free personal team →
 *   the first Xcode team → the team of a keychain identity. There is no
 *   built-in fallback team: without one the error says how to add it;
 * - a runner bundle id (IOS_SIM_WDA_BUNDLE_ID, else derived from the team so
 *   free teams do not collide);
 * - a PRIVATE, safety-patched copy of the WDA checkout. Stock WDA binds its
 *   HTTP server and its MJPEG broadcaster to every device interface, which
 *   would let anyone on the phone's network drive it; the patches bind both
 *   to the device's loopback, reached only through the USB tunnel. The
 *   checkout itself is never modified, and staging fails closed when a patch
 *   anchor no longer matches.
 * @module ios-simulator/wda-setup
 */

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, lstat, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'

export interface SigningIdentity {
  hash: string
  /** e.g. `Apple Development: Jane Doe (ABCDE12345)`. */
  name: string
  teamId?: string
}

export interface XcodeProvisioningTeam {
  teamId: string
  teamName?: string
  teamType?: string
  isFree: boolean
}

export interface SigningTeamResolution {
  teamId?: string
  source: 'option' | 'env' | 'xcode-account' | 'identity' | 'none'
  detail: string
}

/** `security find-identity -v -p codesigning` → the Apple Development identities. */
export function parseSigningIdentities(stdout: string): SigningIdentity[] {
  const identities: SigningIdentity[] = []
  for (const match of stdout.matchAll(/^\s*\d+\)\s+([0-9A-Fa-f]{40})\s+"(Apple Development(?:[^"]*))"/gmu)) {
    const name = match[2]!.trim()
    const teamId = /\(([0-9A-Z]{10})\)\s*$/u.exec(name)?.[1]
    identities.push({ hash: match[1]!, name, ...(teamId === undefined ? {} : { teamId }) })
  }
  return identities
}

/** `IDEProvisioningTeams` (JSON, keyed by Apple ID) → teams, deduplicated. */
export function parseXcodeTeams(json: string): XcodeProvisioningTeam[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return []
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return []
  const teams: XcodeProvisioningTeam[] = []
  const seen = new Set<string>()
  for (const entries of Object.values(parsed)) {
    if (!Array.isArray(entries)) continue
    for (const entry of entries) {
      if (typeof entry !== 'object' || entry === null) continue
      const record = entry as Record<string, unknown>
      const teamId = typeof record.teamID === 'string' ? record.teamID.trim() : ''
      if (teamId === '' || seen.has(teamId)) continue
      seen.add(teamId)
      teams.push({
        teamId,
        ...(typeof record.teamName === 'string' ? { teamName: record.teamName.trim() } : {}),
        ...(typeof record.teamType === 'string' ? { teamType: record.teamType.trim() } : {}),
        isFree: record.isFreeProvisioningTeam === true,
      })
    }
  }
  return teams
}

/** Pick a signing team from gathered evidence (pure). */
export function chooseSigningTeam(options: {
  explicit?: string
  env?: string
  xcodeTeams?: readonly XcodeProvisioningTeam[]
  identities?: readonly SigningIdentity[]
}): SigningTeamResolution {
  const explicit = options.explicit?.trim() ?? ''
  if (explicit !== '') return { teamId: explicit, source: 'option', detail: 'the teamId argument' }
  const env = options.env?.trim() ?? ''
  if (env !== '') return { teamId: env, source: 'env', detail: 'IOS_SIM_TEAM_ID' }
  const teams = options.xcodeTeams ?? []
  const identities = options.identities ?? []
  const identityTeams = new Set(identities.map(identity => identity.teamId?.toUpperCase()).filter(id => id !== undefined))
  const label = (team: XcodeProvisioningTeam): string => team.teamName || team.teamId
  const matching = teams.find(team => identityTeams.has(team.teamId.toUpperCase()))
  if (matching !== undefined) {
    return { teamId: matching.teamId, source: 'xcode-account', detail: `Xcode team "${label(matching)}" (it has an Apple Development certificate in the keychain)` }
  }
  const free = teams.find(team => team.isFree || team.teamType?.toLowerCase() === 'personal team')
  if (free !== undefined) return { teamId: free.teamId, source: 'xcode-account', detail: `Xcode personal team "${label(free)}"` }
  if (teams[0] !== undefined) return { teamId: teams[0].teamId, source: 'xcode-account', detail: `Xcode team "${label(teams[0])}"` }
  const identity = identities.find(candidate => candidate.teamId !== undefined)
  if (identity?.teamId !== undefined) return { teamId: identity.teamId, source: 'identity', detail: `keychain identity "${identity.name}"` }
  return {
    source: 'none',
    detail: 'no signing team found — sign in to your Apple ID in Xcode ▸ Settings ▸ Accounts (a free personal team works), '
      + 'or set IOS_SIM_TEAM_ID to your 10-character team id',
  }
}

function run(command: string, args: readonly string[], signal?: AbortSignal): Promise<string> {
  return new Promise((resolveRun, reject) => {
    execFile(command, [...args], { timeout: 30_000, maxBuffer: 4 * 1024 * 1024, signal }, (error, stdout, stderr) => {
      if (error !== null) reject(new Error(`${command} failed${stderr.trim() === '' ? '' : `: ${stderr.trim()}`}`))
      else resolveRun(stdout)
    })
  })
}

/** Resolve the signing team from the machine: Xcode's accounts and the login keychain. */
export async function resolveSigningTeam(options: { explicit?: string; env?: string; home: string; signal?: AbortSignal }): Promise<SigningTeamResolution> {
  if ((options.explicit?.trim() ?? '') !== '' || (options.env?.trim() ?? '') !== '') return chooseSigningTeam(options)
  const xcodeTeams = await run('plutil', ['-extract', 'IDEProvisioningTeams', 'json', '-o', '-',
    join(options.home, 'Library', 'Preferences', 'com.apple.dt.Xcode.plist')], options.signal).then(parseXcodeTeams, () => [])
  const identities = await run('security', ['find-identity', '-v', '-p', 'codesigning'], options.signal).then(parseSigningIdentities, () => [])
  return chooseSigningTeam({ xcodeTeams, identities })
}

/** IOS_SIM_WDA_BUNDLE_ID, else one derived from the team (free teams need a bundle id of their own). */
export function wdaBundleId(teamId: string, override?: string): string {
  const explicit = override?.trim() ?? ''
  return explicit !== '' ? explicit : `dev.ios-simulator.wda.t${teamId.toLowerCase().replace(/[^a-z0-9]/gu, '')}`
}

// ---------------------------------------------------------------- source staging

export interface WdaSafetyPatch {
  id: string
  /** Path inside the checkout. */
  file: string
  /** Exact text that must occur exactly once. */
  oldText: string
  newText: string
}

/** Reviewed patches (anchors match appium/WebDriverAgent at the revision dsh-ios verified, 6e2b5c0). */
export const WDA_SAFETY_PATCHES: readonly WdaSafetyPatch[] = [
  {
    id: 'http-loopback-only',
    file: 'WebDriverAgentLib/Utilities/FBConfiguration.m',
    oldText: '- (NSString *)bindingIPAddress\n{\n  // Existence of USE_IP in the environment allows specifying which interface to bind to\n  if (NSProcessInfo.processInfo.environment[@"USE_IP"] &&\n      [NSProcessInfo.processInfo.environment[@"USE_IP"] length] > 0) {\n    return NSProcessInfo.processInfo.environment[@"USE_IP"];\n  }\n\n  return nil;\n}',
    newText: '- (NSString *)bindingIPAddress\n{\n  // ios-simulator safety patch: HTTP binds to device loopback only, reached\n  // through the USB tunnel. The environment cannot turn this off.\n  return @"127.0.0.1";\n}',
  },
  {
    id: 'mjpeg-loopback-only',
    file: 'WebDriverAgentLib/Routing/FBWebServer.m',
    oldText: '  self.screenshotsBroadcaster = [[FBTCPSocket alloc]\n                                 initWithPort:(uint16_t)FBConfiguration.sharedInstance.mjpegServerPort];',
    newText: '  self.screenshotsBroadcaster = [[FBTCPSocket alloc]\n                                 initWithPort:(uint16_t)FBConfiguration.sharedInstance.mjpegServerPort];\n  // ios-simulator safety patch: the MJPEG broadcaster binds to device\n  // loopback only (nil would expose the video stream on the device LAN).\n  self.screenshotsBroadcaster.interface = @"127.0.0.1";',
  },
]

const SKIPPED = new Set(['.git', 'DerivedData', 'node_modules', '.DS_Store', 'build'])
const MANIFEST = 'ios-simulator-wda-stage.json'

async function copyTree(source: string, destination: string): Promise<void> {
  await mkdir(destination, { recursive: true })
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (SKIPPED.has(entry.name)) continue
    const from = join(source, entry.name)
    const to = join(destination, entry.name)
    const info = await lstat(from)
    if (info.isSymbolicLink()) throw new Error(`symbolic links are not allowed in the WDA checkout: ${relative(source, from)}`)
    if (info.isDirectory()) await copyTree(from, to)
    else if (info.isFile()) {
      await writeFile(to, await readFile(from))
      if ((info.mode & 0o111) !== 0) await chmod(to, 0o755)
    }
  }
}

async function treeDigest(root: string): Promise<string> {
  const hash = createHash('sha256')
  const walk = async (dir: string): Promise<void> => {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (SKIPPED.has(entry.name) || entry.name === MANIFEST) continue
      const path = join(dir, entry.name)
      const info = await lstat(path)
      if (info.isSymbolicLink()) throw new Error(`symbolic links are not allowed in the WDA checkout: ${relative(root, path)}`)
      if (info.isDirectory()) {
        hash.update(`D\0${relative(root, path)}\0`)
        await walk(path)
      } else if (info.isFile()) {
        hash.update(`F\0${relative(root, path)}\0`).update(await readFile(path)).update('\0')
      }
    }
  }
  await walk(root)
  return hash.digest('hex')
}

/**
 * The patched private copy of `sourceDir` under `stateDir/<digest>`, built
 * once per source + patch set and reused while its recorded digest matches.
 */
export async function stageWdaSource(sourceDir: string, stateDir: string, patches: readonly WdaSafetyPatch[] = WDA_SAFETY_PATCHES): Promise<string> {
  const source = resolve(sourceDir)
  if (!existsSync(join(source, 'WebDriverAgent.xcodeproj'))) {
    throw new Error(`no WebDriverAgent checkout at ${source} — clone it there first: git clone https://github.com/appium/WebDriverAgent.git "${source}" `
      + '(or set IOS_SIM_WDA_DIR to an existing checkout)')
  }
  const sourceDigest = await treeDigest(source)
  const patchDigest = createHash('sha256').update(JSON.stringify(patches)).digest('hex')
  const staged = join(resolve(stateDir), `wda-${sourceDigest.slice(0, 12)}-${patchDigest.slice(0, 12)}`)
  try {
    const manifest = JSON.parse(await readFile(join(staged, MANIFEST), 'utf8')) as { stagedDigest?: string }
    if (manifest.stagedDigest === await treeDigest(staged)) return staged
  } catch {
    // Missing or stale: rebuild below.
  }
  const temporary = `${staged}.tmp-${process.pid}-${Date.now()}`
  try {
    await copyTree(source, temporary)
    for (const patch of patches) {
      const file = join(temporary, ...patch.file.split('/'))
      const text = await readFile(file, 'utf8').catch(() => {
        throw new Error(`the WDA checkout has no ${patch.file} — this WebDriverAgent version is not supported (safety patch ${patch.id})`)
      })
      const occurrences = text.split(patch.oldText).length - 1
      if (occurrences !== 1) {
        throw new Error(`safety patch ${patch.id} does not apply to ${patch.file} (anchor found ${occurrences} times) — this `
          + 'WebDriverAgent version is not supported; refusing to build a WDA that would listen on every network interface')
      }
      await writeFile(file, text.replace(patch.oldText, patch.newText), 'utf8')
    }
    await writeFile(join(temporary, MANIFEST), JSON.stringify({ sourceDir: source, patches: patches.map(patch => patch.id), stagedDigest: await treeDigest(temporary) }, null, 2))
    await rm(staged, { recursive: true, force: true })
    await rename(temporary, staged)
    return staged
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}
