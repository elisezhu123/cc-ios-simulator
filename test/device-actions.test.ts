import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  deviceActionFailureHint,
  deviceActionSpec,
  isDeviceAction,
  runSimulatorDeviceAction,
  simulatorMenuItemScript,
} from '../src/device-actions.js'

test('lock is a serve-sim button press; the others drive Simulator.app', async () => {
  const pressed: string[] = []
  await runSimulatorDeviceAction('lock', async name => { pressed.push(name) })
  assert.deepEqual(pressed, ['lock'])
  assert.equal(deviceActionSpec('app-switcher').transport.kind, 'menu')
  assert.equal(deviceActionSpec('unlock').transport.kind, 'keystroke')
})

test('failure hints point at the fix', () => {
  assert.match(deviceActionFailureHint('osascript is not allowed assistive access. (-1719)'), /Accessibility/)
  assert.match(deviceActionFailureHint('ios-simulator: simulator-not-running'), /ios_sim_boot/)
  assert.match(simulatorMenuItemScript('Shake'), /click menu item "Shake"/)
  assert.equal(isDeviceAction('reboot'), false)
  assert.equal(isDeviceAction('siri'), true)
})
