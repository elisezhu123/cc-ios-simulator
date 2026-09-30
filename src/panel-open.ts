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

import { execFile } from 'node:child_process'

export type PanelOpenMode = 'browser' | 'preview' | 'none'

/** The launch.json configuration name the preview pane starts. */
export const PREVIEW_CONFIGURATION = 'ios-simulator-panel'

/** Explicit setting first; Claude Code desktop gets the preview pane; everything else the browser. */
export function panelOpenMode(env: NodeJS.ProcessEnv = process.env): PanelOpenMode {
  const explicit = env.IOS_SIM_OPEN_PANEL?.trim().toLowerCase()
  if (explicit === 'browser' || explicit === 'preview' || explicit === 'none') return explicit
  return /desktop/iu.test(env.CLAUDE_CODE_ENTRYPOINT ?? '') ? 'preview' : 'browser'
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
        return this.#opened ? { opened: 'the panel opened in the default browser when it first started' } : {}
      case 'none':
        return {}
      case 'preview':
        return {
          openInClaude: {
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
