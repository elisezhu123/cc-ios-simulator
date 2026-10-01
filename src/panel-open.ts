/**
 * Showing the live panel to the user when it first starts.
 *
 * - In the terminal (Claude Code CLI) the panel opens in the default browser.
 * - In Claude Code desktop the panel belongs in the built-in browser pane,
 *   which Claude opens with `preview_start` from a `.claude/launch.json`
 *   configuration. An MCP server cannot drive that pane, so the tool results
 *   carry the configuration and the steps: a small proxy
 *   (`server.js --panel-proxy`) listens on the port the preview assigns and
 *   forwards to the running panel, so the preview never has to take the
 *   panel's own port away from it.
 *
 * `IOS_SIM_OPEN_PANEL` (`browser` | `preview` | `none`) overrides the choice.
 * @module ios-simulator/panel-open
 */

import { execFile, execFileSync } from 'node:child_process'

export type PanelOpenMode = 'browser' | 'preview' | 'none'

/** The launch.json configuration name the preview pane starts. */
export const PREVIEW_CONFIGURATION = 'ios-simulator-panel'

/** The macOS app a process runs under (inherited by every child): the Claude desktop app's is com.anthropic.*. */
const DESKTOP_BUNDLE = /^com\.anthropic\./iu
/** The Claude desktop app's bundle, as it shows in an ancestor's command line. */
const DESKTOP_APP_PATH = /\/Claude\.app\/|Application Support\/Claude\/claude-code/u

/** Command lines of this process's ancestors, nearest first (macOS / Linux `ps`; empty when unavailable). */
export function ancestorCommands(start: number = process.ppid, depth = 8): string[] {
  const commands: string[] = []
  let pid = start
  for (let level = 0; level < depth && pid > 1; level += 1) {
    let line: string
    try {
      line = execFileSync('ps', ['-o', 'ppid=,command=', '-p', String(pid)], { encoding: 'utf8', timeout: 2_000 }).trim()
    } catch {
      break
    }
    const match = /^(\d+)\s+(.*)$/su.exec(line)
    if (match === null) break
    commands.push(match[2]!)
    pid = Number(match[1])
  }
  return commands
}

/** Why the panel opens where it does (shown in tool results, so a wrong guess is easy to spot). */
export interface PanelOpenDecision {
  mode: PanelOpenMode
  reason: string
}

/**
 * Explicit setting first; Claude Code desktop gets the built-in browser and
 * never the system one; everything else the default browser. The desktop app
 * is recognized by the entrypoint Claude Code reports, else by the macOS app
 * the MCP server runs under, else by the Claude app among its ancestors (the
 * entrypoint does not always reach MCP servers).
 */
export function decidePanelOpen(env: NodeJS.ProcessEnv = process.env, ancestors: () => string[] = () => ancestorCommands()): PanelOpenDecision {
  const explicit = env.IOS_SIM_OPEN_PANEL?.trim().toLowerCase()
  if (explicit === 'browser' || explicit === 'preview' || explicit === 'none') return { mode: explicit, reason: 'IOS_SIM_OPEN_PANEL' }
  if (/desktop/iu.test(env.CLAUDE_CODE_ENTRYPOINT ?? '')) return { mode: 'preview', reason: `CLAUDE_CODE_ENTRYPOINT=${env.CLAUDE_CODE_ENTRYPOINT}` }
  const bundle = env.__CFBundleIdentifier ?? ''
  if (DESKTOP_BUNDLE.test(bundle)) return { mode: 'preview', reason: `running under ${bundle}` }
  if (ancestors().some(command => DESKTOP_APP_PATH.test(command))) return { mode: 'preview', reason: 'started by the Claude desktop app' }
  return { mode: 'browser', reason: bundle === '' ? 'not the Claude desktop app' : `running under ${bundle}, not the Claude desktop app` }
}

/** The mode alone (see decidePanelOpen). */
export function panelOpenMode(env: NodeJS.ProcessEnv = process.env, ancestors?: () => string[]): PanelOpenMode {
  return decidePanelOpen(env, ancestors).mode
}

/** The platform's "open this URL" command. */
export function browserOpenCommand(platform: NodeJS.Platform, url: string): [string, string[]] | undefined {
  if (platform === 'darwin') return ['open', [url]]
  if (platform === 'linux') return ['xdg-open', [url]]
  if (platform === 'win32') return ['cmd', ['/c', 'start', '', url]]
  return undefined
}

/** The `.claude/launch.json` entry that serves the panel in the preview pane. */
export function previewLaunchConfiguration(serverScript: string, stateFile: string): Record<string, unknown> {
  return {
    name: PREVIEW_CONFIGURATION,
    runtimeExecutable: 'node',
    runtimeArgs: [serverScript, '--panel-proxy', '--state', stateFile],
    port: 3457,
    autoPort: true,
  }
}

export interface PanelOpenerOptions {
  mode: PanelOpenMode
  /** Why this mode was chosen (reported with the hint). */
  reason?: string
  platform: NodeJS.Platform
  serverScript: string
  stateFile: string
  /** Launch a detached command (tests record it). */
  run?: (command: string, args: string[]) => void
}

export class PanelOpener {
  readonly #options: PanelOpenerOptions
  #opened = false

  constructor(options: PanelOpenerOptions) {
    this.#options = options
  }

  get mode(): PanelOpenMode {
    return this.#options.mode
  }

  /** After the panel starts: open it in the browser, once per server process. */
  afterStart(url: string): void {
    if (this.#opened || this.#options.mode !== 'browser') return
    const command = browserOpenCommand(this.#options.platform, url)
    if (command === undefined) return
    this.#opened = true
    const run = this.#options.run ?? ((file: string, args: string[]) => {
      execFile(file, args, { timeout: 10_000 }, () => {})
    })
    run(command[0], command[1])
  }

  /** What a tool result adds so the user gets to see the panel. */
  hint(url: string): Record<string, unknown> {
    switch (this.#options.mode) {
      case 'browser':
        return this.#opened
          ? { opened: `the panel opened in the default browser when it first started (${this.#options.reason ?? 'default'}; in Claude Code desktop set IOS_SIM_OPEN_PANEL=preview)` }
          : {}
      case 'none':
        return {}
      case 'preview':
        return {
          openInClaude: {
            detectedBy: this.#options.reason ?? 'default',
            how: 'Show panelUrl in Claude Code\'s built-in browser pane: make sure .claude/launch.json has the configuration '
              + `below (add it to "configurations" if missing, keep the others), then call preview_start with "${PREVIEW_CONFIGURATION}". `
              + 'It runs a small proxy on the port the preview assigns (autoPort) and forwards to the panel, so never stop the '
              + `process that owns ${new URL(url).host} — that is this MCP server.`,
            launchConfiguration: previewLaunchConfiguration(this.#options.serverScript, this.#options.stateFile),
          },
        }
    }
  }
}
