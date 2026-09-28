import { test } from 'node:test'
import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { cacheRoot, DEFAULT_PANEL_PORT, preferredPanelPort, serveSimBinOverride } from '../src/config.js'

const DEFAULT_CACHE = join(homedir(), 'Library', 'Caches', 'ios-simulator')

test('cacheRoot defaults to ~/Library/Caches/ios-simulator', () => {
  assert.equal(cacheRoot({}), DEFAULT_CACHE)
})

test('cacheRoot honours IOS_SIM_CACHE_DIR and ignores blanks', () => {
  assert.equal(cacheRoot({ IOS_SIM_CACHE_DIR: '/tmp/ios-sim-cache' }), '/tmp/ios-sim-cache')
  assert.equal(cacheRoot({ IOS_SIM_CACHE_DIR: '   ' }), DEFAULT_CACHE)
})

test('preferredPanelPort accepts valid ports and falls back to 3456', () => {
  assert.equal(preferredPanelPort({}), DEFAULT_PANEL_PORT)
  assert.equal(preferredPanelPort({ IOS_SIM_PANEL_PORT: '4000' }), 4000)
  for (const bad of ['abc', '80', '70000', '3456.5']) {
    assert.equal(preferredPanelPort({ IOS_SIM_PANEL_PORT: bad }), DEFAULT_PANEL_PORT, bad)
  }
})

test('serveSimBinOverride trims and ignores empty values', () => {
  assert.equal(serveSimBinOverride({}), undefined)
  assert.equal(serveSimBinOverride({ IOS_SIM_SERVE_SIM_BIN: '  /opt/serve-sim  ' }), '/opt/serve-sim')
})
