// Ported from dsh-ios (MIT, © 2026 ZSeven—W) @ d9a9731 — src/device-actions.ts
/**
 * Device-level actions that are not touches: the App Switcher, Lock/Unlock,
 * Shake, Siri, the Action button, and window re-centering.
 *
 * Each action names HOW it is delivered, because the mechanisms have very
 * different costs and were each established by experiment (last on an
 * iPhone 17 / iOS 27.2 simulator under Xcode 27, which ships no
 * Simulator.app — so anything that clicks its menus cannot run there):
 *
 * - `serve-sim` — a hardware-button frame through the stream helper. Fast and
 *   never touches macOS focus. Verified with serve-sim 0.1.47: `lock`,
 *   `app_switcher` (the switcher opens), `action` (the Dynamic Island shows
 *   the ring/silent switch) and `home` twice, which unlocks (the first press
 *   wakes the lock screen, the second leaves it). NOT `siri`: that button
 *   blacked the screen with a spinner and left the simulator dim and deaf to
 *   app launches until it was rebooted.
 * - `notify` — a Darwin notification posted inside the simulator. Shake is
 *   `com.apple.UIKit.SimulatorShake`, what Simulator.app's own menu item
 *   posts: verified, a text field with typing answered with "Undo Typing".
 * - `frame` — one bare serve-sim control frame (the software keyboard).
 * - `menu` — click an item in Simulator.app's menus. It only fires while
 *   Simulator is FRONTMOST, so the helper raises it, clicks, and hands focus
 *   straight back; it needs the Accessibility permission. What is left here
 *   has no other route: Siri (see above), Re-Center, and Slow Animations
 *   (serve-sim's `ca-debug slow-animations` was accepted and changed nothing
 *   visible).
 * - `keystroke` — a key combination delivered to the focused Simulator. No
 *   action uses it any more; the script stays for an Xcode with Simulator.app.
 *
 * DELIBERATELY ABSENT: `Restart` and `Erase All Content and Settings…`. Both
 * exist in the same menu, both are irreversible from a panel click, and
 * neither belongs one stray click away from a live session.
 *
 * @module ios-simulator/device-actions
 */

import { execFile } from 'node:child_process'

/** How long any AppleScript may take before it is killed. */
const OSASCRIPT_TIMEOUT_MS = 8_000

/** Every device action the panel and the tools may ask for. */
export const DEVICE_ACTIONS = [
  'app-switcher',
  'lock',
  'unlock',
  'shake',
  'siri',
  'action-button',
  're-center',
  'toggle-keyboard',
  'slow-animations',
] as const

export type DeviceAction = typeof DEVICE_ACTIONS[number]

export function isDeviceAction(value: unknown): value is DeviceAction {
  return typeof value === 'string' && (DEVICE_ACTIONS as readonly string[]).includes(value)
}

/** How one action reaches the simulator. */
export type DeviceActionTransport =
  /** A serve-sim hardware button, pressed `repeat` times (default once). */
  | { kind: 'serve-sim'; button: string; repeat?: number }
  /** A Darwin notification posted inside the simulator (`simctl spawn … notifyutil -p`). */
  | { kind: 'notify'; name: string }
  /** `path` is the menu bar item and any submenus above `item` (default `Device`). */
  | { kind: 'menu'; item: string; path?: readonly string[] }
  | { kind: 'keystroke'; repeat: number }
  /** One bare serve-sim control frame (its tag) over the stream's control socket. */
  | { kind: 'frame'; tag: number }

export interface DeviceActionSpec {
  action: DeviceAction
  transport: DeviceActionTransport
  /** True when the phone (WebDriverAgent) can do it too. */
  realDevice: boolean
}

/**
 * The action table. `realDevice` records what WDA can actually deliver: the
 * switcher (a dwelling drag), lock/unlock (`/wda/lock`, `/wda/unlock`) and
 * Siri (`/wda/siri/activate`). Shake, the Action button and window
 * re-centering are simulator-window concepts with no device equivalent.
 */
export const DEVICE_ACTION_SPECS: readonly DeviceActionSpec[] = [
  { action: 'app-switcher', transport: { kind: 'serve-sim', button: 'app_switcher' }, realDevice: true },
  { action: 'lock', transport: { kind: 'serve-sim', button: 'lock' }, realDevice: true },
  // The home button twice: the first press wakes the lock screen, the second leaves it.
  { action: 'unlock', transport: { kind: 'serve-sim', button: 'home', repeat: 2 }, realDevice: true },
  // What Simulator.app's Device ▸ Shake posts; UIKit turns it into a motion-shake event.
  { action: 'shake', transport: { kind: 'notify', name: 'com.apple.UIKit.SimulatorShake' }, realDevice: false },
  { action: 'siri', transport: { kind: 'menu', item: 'Siri' }, realDevice: true },
  { action: 'action-button', transport: { kind: 'serve-sim', button: 'action' }, realDevice: false },
  { action: 're-center', transport: { kind: 'menu', item: 'Re-Center Open Apps' }, realDevice: false },
  // serve-sim's native toggle (what Simulator.app's ⌘K sends): no Simulator.app window, no Accessibility permission.
  { action: 'toggle-keyboard', transport: { kind: 'frame', tag: 12 }, realDevice: false },
  // Simulator's own toggle (⌘T): slow-motion animations.
  { action: 'slow-animations', transport: { kind: 'menu', item: 'Slow Animations', path: ['Debug'] }, realDevice: false },
]

export function deviceActionSpec(action: DeviceAction): DeviceActionSpec {
  const spec = DEVICE_ACTION_SPECS.find(entry => entry.action === action)
  /* v8 ignore next -- every DeviceAction has a spec; the union guarantees it. */
  if (spec === undefined) throw new Error(`ios-simulator: unknown device action ${action}`)
  return spec
}

/** Actionable text for the failures a user can fix. */
export const DEVICE_ACTION_PERMISSION_HINT =
  'macOS needs permission to drive Simulator.app: System Settings ▸ Privacy & Security ▸ Accessibility, '
  + 'then enable the app running Claude Code (Terminal / iTerm / the Claude app)'

export const DEVICE_ACTION_SIMULATOR_HINT =
  'this action clicks a menu of Simulator.app, which is not running — Xcode 27 ships no Simulator.app (simulators run '
  + 'through Device Hub), so there it is unavailable; on an older Xcode open Simulator.app first'

/** Classify an osascript failure into something the caller can act on. */
export function deviceActionFailureHint(message: string): string {
  if (/simulator-not-running/.test(message)) return DEVICE_ACTION_SIMULATOR_HINT
  if (/not allowed assistive|osascript is not allowed|-1719|1002|assistive access/i.test(message)) {
    return DEVICE_ACTION_PERMISSION_HINT
  }
  if (/menu-item-missing/.test(message)) {
    return 'this Xcode\'s Simulator has no such menu item — the action is unavailable on this host'
  }
  if (/simulator-not-frontmost/.test(message)) {
    return 'Simulator.app would not come to the front — another app may be holding focus; try again'
  }
  return message
}

/** AppleScript literal, single-quoted safely for embedding. */
function appleScriptString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/**
 * The shared shape: remember who is frontmost, raise Simulator, do the thing,
 * hand focus back. `frontmost of process` is restored rather than `activate`d
 * so a non-scriptable window (a browser tab, a terminal) also returns.
 */
function focusedSimulatorScript(body: string): string {
  return `
tell application "System Events"
  if not (exists process "Simulator") then error "ios-simulator: simulator-not-running"
  set previousName to ""
  try
    set previousName to name of first process whose frontmost is true
  end try
  tell application "Simulator" to activate
  set raised to false
  repeat 40 times
    if frontmost of process "Simulator" then
      set raised to true
      exit repeat
    end if
    delay 0.05
  end repeat
  if not raised then error "ios-simulator: simulator-not-frontmost"
${body}
  delay 0.15
  if previousName is not "" and previousName is not "Simulator" then
    try
      set frontmost of process previousName to true
    end try
  end if
end tell
`
}

/**
 * Click one menu item by its exact English title; `path` is the menu bar
 * item then any submenus above it (default: the `Device` menu).
 */
export function simulatorMenuItemScript(item: string, path: readonly string[] = ['Device']): string {
  const [bar = 'Device', ...submenus] = path
  let menu = `menu 1 of menu bar item ${appleScriptString(bar)} of menu bar 1`
  for (const submenu of submenus) menu = `menu 1 of menu item ${appleScriptString(submenu)} of ${menu}`
  const target = `menu item ${appleScriptString(item)} of ${menu}`
  return focusedSimulatorScript(`  tell process "Simulator"
    if not (exists ${target}) then error "ios-simulator: menu-item-missing"
    click ${target}
  end tell`)
}

/** Press ⇧⌘H `repeat` times (key code 4 = H). */
export function simulatorHomeKeystrokeScript(repeat: number): string {
  const presses = Array.from({ length: Math.max(1, repeat) }, (_, index) =>
    `  key code 4 using {command down, shift down}${index + 1 < repeat ? '\n  delay 0.25' : ''}`).join('\n')
  return focusedSimulatorScript(presses)
}

/** True when a Simulator.app process exists (`pgrep -x Simulator`); true too when that cannot be asked. */
function simulatorAppRunning(): Promise<boolean> {
  return new Promise(resolve => {
    execFile('pgrep', ['-x', 'Simulator'], { timeout: 2_000 }, error => {
      // pgrep exits 1 when nothing matches; any other failure is not evidence either way.
      resolve(error === null || error.code !== 1)
    })
  })
}

function runOsascript(script: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('osascript', ['-e', script], { timeout: timeoutMs }, (error, _stdout, stderr) => {
      if (error === null) {
        resolve()
        return
      }
      const detail = `${stderr === '' ? error.message : stderr}`.trim()
      reject(new Error(detail))
    })
  })
}

/** How an action reaches the simulator; the stream source supplies them. */
export interface DeviceActionChannels {
  /** Press a serve-sim hardware button. */
  pressButton(name: string): Promise<void>
  /** Send one bare serve-sim control frame. */
  sendFrame?(tag: number): Promise<void>
  /** Post a Darwin notification inside the simulator. */
  postNotification?(name: string): Promise<void>
  /** Pause between repeated button presses (default `BUTTON_REPEAT_DELAY_MS`). */
  repeatDelayMs?: number
}

/** Between the two home presses of an unlock: the lock screen has to wake first. */
const BUTTON_REPEAT_DELAY_MS = 700

/**
 * Run one device action against the booted simulator. `pressButton` is the
 * serve-sim path, injected so the caller owns the stream helper (and so this
 * module stays testable without one).
 */
export async function runSimulatorDeviceAction(
  action: DeviceAction,
  channels: DeviceActionChannels,
  timeoutMs: number = OSASCRIPT_TIMEOUT_MS,
): Promise<void> {
  const spec = deviceActionSpec(action)
  try {
    if (spec.transport.kind === 'serve-sim') {
      const presses = spec.transport.repeat ?? 1
      for (let press = 0; press < presses; press += 1) {
        if (press > 0) await new Promise(resolve => setTimeout(resolve, channels.repeatDelayMs ?? BUTTON_REPEAT_DELAY_MS))
        await channels.pressButton(spec.transport.button)
      }
      return
    }
    if (spec.transport.kind === 'frame') {
      if (channels.sendFrame === undefined) throw new Error('this stream backend cannot send serve-sim control frames')
      await channels.sendFrame(spec.transport.tag)
      return
    }
    if (spec.transport.kind === 'notify') {
      if (channels.postNotification === undefined) throw new Error('this stream backend cannot post a notification inside the simulator')
      await channels.postNotification(spec.transport.name)
      return
    }
    // Without a Simulator.app process the AppleScript only fails after its whole timeout (8 s measured).
    if (!(await simulatorAppRunning())) throw new Error('ios-simulator: simulator-not-running')
    const script = spec.transport.kind === 'menu'
      ? simulatorMenuItemScript(spec.transport.item, spec.transport.path)
      : simulatorHomeKeystrokeScript(spec.transport.repeat)
    await runOsascript(script, timeoutMs)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`ios-simulator: the ${action} action failed — ${deviceActionFailureHint(message)}`)
  }
}
