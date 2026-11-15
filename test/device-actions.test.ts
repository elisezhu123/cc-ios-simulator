import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  deviceActionFailureHint,
  deviceActionSpec,
  isDeviceAction,
  runSimulatorDeviceAction,
  simulatorMenuItemScript,
} from '../src/device-actions.js'

test('the actions serve-sim and simctl can deliver never touch Simulator.app', async () => {
  const log: string[] = []
  const channels = {
    pressButton: async (name: string) => { log.push(`button ${name}`) },
    sendFrame: async (tag: number) => { log.push(`frame ${tag}`) },
    postNotification: async (name: string) => { log.push(`notify ${name}`) },
    repeatDelayMs: 0,
  }
  for (const action of ['lock', 'app-switcher', 'unlock', 'action-button', 'shake', 'toggle-keyboard'] as const) {
    await runSimulatorDeviceAction(action, channels)
  }
  assert.deepEqual(log, [
    'button lock',
    'button app_switcher',
    // The home button twice: the first press wakes the lock screen, the second leaves it.
    'button home', 'button home',
    'button action',
    'notify com.apple.UIKit.SimulatorShake',
    'frame 12',
  ])
  // Siri's hardware button left a simulator unresponsive, and nothing else reaches these three.
  assert.deepEqual((['siri', 're-center', 'slow-animations'] as const).map(action => deviceActionSpec(action).transport.kind), ['menu', 'menu', 'menu'])
})

test('an action whose channel is missing says so instead of doing nothing', async () => {
  await assert.rejects(runSimulatorDeviceAction('shake', { pressButton: async () => {} }), /shake action failed.*cannot post/s)
})

test('failure hints point at the fix', () => {
  assert.match(deviceActionFailureHint('osascript is not allowed assistive access. (-1719)'), /Accessibility/)
  // Xcode 27 ships no Simulator.app: say that, not "boot a simulator".
  assert.match(deviceActionFailureHint('ios-simulator: simulator-not-running'), /Simulator\.app.*Xcode 27/s)
  assert.match(simulatorMenuItemScript('Shake'), /click menu item "Shake"/)
  assert.equal(isDeviceAction('reboot'), false)
  assert.equal(isDeviceAction('siri'), true)
})
