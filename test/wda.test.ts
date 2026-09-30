import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { planWdaInteract, runWdaInteract, wdaTree } from '../src/real-ui.js'
import { decodeUsbmuxHeader, encodeUsbmuxHeader, pickUsbDeviceId, swapPortByteOrder } from '../src/usbmux.js'
import { classifyWdaFailure, parseServerUrlHere, WdaClient, WdaError } from '../src/wda-client.js'
import { WdaController, xcodebuildTestArgs, type WdaChild, type WdaHostSeams, type WdaSessionClient, type WdaTunnel } from '../src/wda-host.js'
import {
  chooseSigningTeam,
  parseSigningIdentities,
  parseXcodeTeams,
  stageWdaSource,
  WDA_SAFETY_PATCHES,
  wdaBundleId,
} from '../src/wda-setup.js'
import { wdaSourceToElements } from '../src/wda-uitree.js'
import { fakeWda, IPHONE } from './helpers/fakes.js'

test('usbmux header round-trips and ports are byte-swapped; only a USB record is forwarded', () => {
  const header = { totalLength: 300, version: 1, messageType: 8, tag: 7 }
  assert.deepEqual(decodeUsbmuxHeader(encodeUsbmuxHeader(header)), header)
  assert.equal(swapPortByteOrder(8100), 0xa41f)
  assert.equal(swapPortByteOrder(9100), 0x8c23)
  const devices = [{ deviceId: 3, udid: 'HW', connection: 'network' as const }, { deviceId: 4, udid: 'HW', connection: 'usb' as const }]
  assert.equal(pickUsbDeviceId(devices, 'HW'), 4)
  assert.equal(pickUsbDeviceId(devices.slice(0, 1), 'HW'), undefined)
})

test('signing: identities and Xcode teams are parsed, and the team is chosen without any built-in default', () => {
  const identities = parseSigningIdentities([
    '  1) 0123456789ABCDEF0123456789ABCDEF01234567 "Apple Development: Test User (ABCDE12345)"',
    '  2) FEDCBA9876543210FEDCBA9876543210FEDCBA98 "Developer ID Application: Other (ZZZZZ99999)"',
    '     2 valid identities found',
  ].join('\n'))
  assert.deepEqual(identities.map(identity => identity.teamId), ['ABCDE12345'])
  const teams = parseXcodeTeams(JSON.stringify({
    'test@example.com': [
      { teamID: 'FREE000001', teamName: 'Test User (Personal Team)', teamType: 'Personal Team', isFreeProvisioningTeam: true },
      { teamID: 'ORG0000002', teamName: 'Org', teamType: 'Company' },
    ],
  }))
  assert.deepEqual(teams.map(team => team.teamId), ['FREE000001', 'ORG0000002'])
  assert.equal(parseXcodeTeams('not json').length, 0)
  assert.deepEqual(chooseSigningTeam({ explicit: 'OPT0000001', env: 'ENV0000001' }).source, 'option')
  assert.equal(chooseSigningTeam({ env: 'ENV0000001', xcodeTeams: teams }).teamId, 'ENV0000001')
  assert.equal(chooseSigningTeam({ xcodeTeams: teams }).teamId, 'FREE000001')
  assert.equal(chooseSigningTeam({ identities }).teamId, 'ABCDE12345')
  const none = chooseSigningTeam({})
  assert.equal(none.teamId, undefined)
  assert.match(none.detail, /Xcode ▸ Settings ▸ Accounts.*IOS_SIM_TEAM_ID/)
  assert.equal(wdaBundleId('ABCDE12345'), 'dev.ios-simulator.wda.tabcde12345')
  assert.equal(wdaBundleId('ABCDE12345', ' com.example.wda '), 'com.example.wda')
})

/** A minimal WDA checkout whose two patched files carry the anchors. */
function fakeCheckout(): string {
  const root = mkdtempSync(join(tmpdir(), 'ios-sim-wda-src-'))
  mkdirSync(join(root, 'WebDriverAgent.xcodeproj'))
  writeFileSync(join(root, 'WebDriverAgent.xcodeproj', 'project.pbxproj'), '// project')
  for (const patch of WDA_SAFETY_PATCHES) {
    mkdirSync(join(root, ...patch.file.split('/').slice(0, -1)), { recursive: true })
    writeFileSync(join(root, ...patch.file.split('/')), `// header\n${patch.oldText}\n// footer\n`)
  }
  return root
}

test('stageWdaSource patches a private copy to loopback-only, reuses it, and fails closed', async () => {
  const source = fakeCheckout()
  const state = mkdtempSync(join(tmpdir(), 'ios-sim-wda-state-'))
  const staged = await stageWdaSource(source, state)
  const configuration = readFileSync(join(staged, 'WebDriverAgentLib/Utilities/FBConfiguration.m'), 'utf8')
  assert.match(configuration, /return @"127\.0\.0\.1";/)
  assert.match(readFileSync(join(staged, 'WebDriverAgentLib/Routing/FBWebServer.m'), 'utf8'), /interface = @"127\.0\.0\.1"/)
  // The checkout itself is untouched, and a second stage reuses the copy.
  assert.doesNotMatch(readFileSync(join(source, 'WebDriverAgentLib/Utilities/FBConfiguration.m'), 'utf8'), /safety patch/)
  assert.equal(await stageWdaSource(source, state), staged)
  // A WDA version whose anchor moved is refused instead of built unpatched.
  writeFileSync(join(source, 'WebDriverAgentLib/Routing/FBWebServer.m'), '// rewritten upstream\n')
  await assert.rejects(stageWdaSource(source, state), /mjpeg-loopback-only does not apply.*refusing to build/)
  await assert.rejects(stageWdaSource(join(state, 'nope'), state), /no WebDriverAgent checkout.*git clone https:\/\/github\.com\/appium\/WebDriverAgent\.git/)
})

test('WDA XML becomes the simulator tree shape, with same-frame wrappers collapsed', () => {
  const roots = wdaSourceToElements(`<?xml version="1.0" encoding="UTF-8"?>
<AppiumAUT>
  <XCUIElementTypeApplication type="XCUIElementTypeApplication" name="Settings" label="Settings" enabled="true" visible="true" x="0" y="0" width="402" height="874">
    <XCUIElementTypeOther type="XCUIElementTypeOther" enabled="true" visible="true" x="0" y="0" width="402" height="874">
      <XCUIElementTypeButton type="XCUIElementTypeButton" name="com.apple.settings.general" label="General" enabled="true" visible="true" x="16" y="300" width="370" height="52"/>
      <XCUIElementTypeStaticText type="XCUIElementTypeStaticText" name="Wi-Fi" label="Wi-Fi" value="Wi-Fi" enabled="true" visible="false" x="16" y="900" width="370" height="52"/>
    </XCUIElementTypeOther>
  </XCUIElementTypeApplication>
</AppiumAUT>`)
  const app = roots[0]!
  assert.equal(app.type, 'Application')
  const [general, wifi] = app.children
  assert.deepEqual([general!.type, general!.label, general!.identifier], ['Button', 'General', 'com.apple.settings.general'])
  assert.deepEqual([wifi!.label, wifi!.value, wifi!.visible], ['Wi-Fi', undefined, false])
})

test('launch output is classified, locked first; ServerURLHere is read', () => {
  assert.equal(classifyWdaFailure('** TEST BUILD FAILED **\nError Domain=com.apple.dt.deviceprep Code=-3 "Unlock iPhone to Continue"'), 'device-locked')
  assert.equal(classifyWdaFailure('The application could not be launched because the Developer App Certificate is not trusted.'), 'cert-untrusted')
  assert.equal(classifyWdaFailure('** TEST BUILD FAILED **'), 'build-failed')
  assert.equal(parseServerUrlHere('noise ServerURLHere->http://10.0.0.5:8100<-ServerURLHere more'), 'http://10.0.0.5:8100')
  assert.deepEqual(xcodebuildTestArgs('HW-1', 'ABCDE12345', 'dev.x'), [
    '-project', 'WebDriverAgent.xcodeproj', '-scheme', 'WebDriverAgentRunner', '-destination', 'id=HW-1',
    '-allowProvisioningUpdates', 'DEVELOPMENT_TEAM=ABCDE12345', 'CODE_SIGN_STYLE=Automatic', 'PRODUCT_BUNDLE_IDENTIFIER=dev.x', 'test',
  ])
})

/** A WDA HTTP stand-in: one session, recorded requests, an optional stale-session reply. */
async function wdaServer(): Promise<{ url: string; requests: string[]; expireSession(): void; close(): Promise<void> }> {
  const requests: string[] = []
  let session = 1
  let expired = false
  const reply = (response: ServerResponse, doc: unknown, status = 200): void => {
    response.writeHead(status, { 'content-type': 'application/json' })
    response.end(JSON.stringify(doc))
  }
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let body = ''
    request.on('data', chunk => { body += String(chunk) })
    request.on('end', () => {
      requests.push(`${request.method} ${request.url}${body === '' ? '' : ` ${body}`}`)
      const url = request.url ?? ''
      if (url === '/status') return reply(response, { value: { ready: true, state: 'success' } })
      if (url === '/session' && request.method === 'POST') {
        session += 1
        return reply(response, { sessionId: `s${session}`, value: { sessionId: `s${session}` } })
      }
      if (expired && url.startsWith('/session/s2/')) {
        expired = false
        return reply(response, { value: { error: 'invalid session id', message: 'Session does not exist' } }, 404)
      }
      if (url.endsWith('/window/size')) return reply(response, { value: { width: 402, height: 874 } })
      return reply(response, { value: null })
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    expireSession: () => { expired = true },
    close: () => new Promise(resolve => server.close(() => resolve())),
  }
}

test('WdaClient reuses one session, recreates it once when it goes stale, and taps in points', async () => {
  const wda = await wdaServer()
  try {
    const client = new WdaClient(wda.url)
    assert.equal((await client.health()).ready, true)
    await client.tap(201, 437)
    assert.deepEqual(await client.windowSize(), { width: 402, height: 874 })
    wda.expireSession()
    await client.typeText('你好')
    const posts = wda.requests.filter(line => line.startsWith('POST'))
    assert.deepEqual(posts.map(line => line.split(' ').slice(0, 2).join(' ')), [
      'POST /session', 'POST /session/s2/wda/tap', 'POST /session/s2/wda/keys', 'POST /session', 'POST /session/s3/wda/keys',
    ])
    assert.match(posts[1]!, /"x":201,"y":437/)
    assert.match(posts[4]!, /"value":\["你好"\]/)
  } finally {
    await wda.close()
  }
})

test('planWdaInteract validates arguments and maps names; runWdaInteract scales to window points', async () => {
  assert.deepEqual(planWdaInteract('button', { name: 'volume-up' }), { kind: 'button', name: 'volumeUp' })
  assert.deepEqual(planWdaInteract('button', { name: 'lock' }), { kind: 'lock' })
  assert.throws(() => planWdaInteract('button', { name: 'action' }), /home, lock, volume-up and volume-down/)
  assert.deepEqual(planWdaInteract('rotate', { orientation: 'landscape_right' }), { kind: 'rotate', orientation: 'UIA_DEVICE_ORIENTATION_LANDSCAPERIGHT' })
  assert.throws(() => planWdaInteract('device_action', { name: 'app-switcher' }), /lock, unlock, siri/)
  assert.throws(() => planWdaInteract('gesture', { json: { type: 'begin', x: 0.5, y: 0.5 } }), /single touch frames are simulator-only/)
  assert.throws(() => planWdaInteract('tap', { x: 1.5, y: 0.5 }), /tap x must be a number within 0\.\.1/)
  const scroll = planWdaInteract('scroll', { direction: 'down' })
  assert.equal(scroll.kind, 'drag')
  if (scroll.kind === 'drag') assert.ok(scroll.fromY > scroll.toY, 'content down = finger up')
  const fake = fakeWda()
  assert.deepEqual(await runWdaInteract(fake.client, planWdaInteract('tap', { x: 0.5, y: 0.25 })), { points: { x: 201, y: 218.5 } })
  await runWdaInteract(fake.client, planWdaInteract('gesture', { json: { fromX: 0, fromY: 1, toX: 1, toY: 0 } }))
  assert.deepEqual(fake.calls, ['tap 201,218.5', 'drag 0,874 -> 402,0 0.3s'])
})

test('wdaTree caps the snapshot depth and deepens once when the capped read has no labels', async () => {
  const bare = '<XCUIElementTypeApplication type="XCUIElementTypeApplication" x="0" y="0" width="402" height="874"/>'
  const labeled = '<XCUIElementTypeApplication type="XCUIElementTypeApplication" name="Settings" label="Settings" x="0" y="0" width="402" height="874"/>'
  const deep = fakeWda({ sources: [bare, labeled] })
  const sample = await wdaTree(deep.client, 'Test iPhone')
  assert.deepEqual([sample.sampledDepth, sample.deepened], [40, true])
  assert.deepEqual(deep.calls, ['depth 15', 'source', 'depth 40', 'source'])
  const explicit = fakeWda({ sources: [bare] })
  assert.deepEqual((await wdaTree(explicit.client, 'Test iPhone', 60)).sampledDepth, 60)
  assert.deepEqual(explicit.calls, ['depth 60', 'source'])
})

/** WdaHostSeams over scripted parts; `runner.emit` feeds xcodebuild output. */
function controllerSeams(options: { adoptReady?: boolean; teamId?: string; exitWith?: { output: string; code: number } } = {}) {
  const events: string[] = []
  let exit: (code: number | null) => void = () => {}
  const listeners: Array<(text: string) => void> = []
  const runner: WdaChild & { emit(text: string): void } = {
    onOutput: listener => { listeners.push(listener) },
    exited: new Promise(resolve => { exit = resolve }),
    kill: () => { events.push('kill runner'); exit(null) },
    emit: text => { for (const listener of listeners) listener(text) },
  }
  let launched = false
  const client = (): WdaSessionClient => ({
    ...fakeWda().client,
    health: async () => ({ ready: launched || options.adoptReady === true }),
  })
  const seams: WdaHostSeams = {
    platform: 'darwin',
    resolveTeam: async () => options.teamId === undefined
      ? { source: 'none', detail: 'no signing team found — sign in to Xcode' }
      : { teamId: options.teamId, source: 'env', detail: 'IOS_SIM_TEAM_ID' },
    stageSource: async () => '/staged/wda',
    bundleId: teamId => `dev.test.wda.${teamId}`,
    spawnRunner: (args, cwd) => {
      events.push(`xcodebuild ${args.join(' ')} in ${cwd}`)
      queueMicrotask(() => {
        if (options.exitWith !== undefined) {
          runner.emit(options.exitWith.output)
          exit(options.exitWith.code)
          return
        }
        launched = true
        runner.emit('Test Case started\nServerURLHere->http://127.0.0.1:8100<-ServerURLHere\n')
      })
      return runner
    },
    openTunnel: async (udid, port): Promise<WdaTunnel> => {
      events.push(`tunnel ${udid}:${port}`)
      return { localPort: 50100, kind: 'usbmux', close: async () => { events.push('close tunnel') } }
    },
    createClient: () => client(),
    sleep: async () => {},
    now: Date.now,
  }
  return { seams, events, runner }
}

test('WdaController adopts a WDA that already answers, without building', async () => {
  const { seams, events } = controllerSeams({ adoptReady: true, teamId: 'ABCDE12345' })
  const controller = new WdaController(seams)
  const status = await controller.start(IPHONE)
  assert.deepEqual([status.phase, status.adopted, status.controlPort], ['running', true, 50100])
  assert.deepEqual(events, [`tunnel ${IPHONE.hardwareUdid}:8100`])
  assert.ok(await controller.control(IPHONE))
  assert.deepEqual(await controller.stop(), { stopped: true, device: { udid: IPHONE.udid, name: IPHONE.name } })
})

test('WdaController builds and launches the runner when nothing answers, then stops it', async () => {
  const { seams, events } = controllerSeams({ teamId: 'ABCDE12345' })
  const controller = new WdaController(seams)
  const status = await controller.start(IPHONE)
  assert.deepEqual([status.phase, status.adopted, status.signingTeam], ['running', false, 'ABCDE12345 (env)'])
  assert.ok(events.some(line => line.startsWith(`xcodebuild -project WebDriverAgent.xcodeproj`) && line.includes(`id=${IPHONE.hardwareUdid}`)
    && line.includes('PRODUCT_BUNDLE_IDENTIFIER=dev.test.wda.ABCDE12345') && line.endsWith('in /staged/wda')))
  await controller.stop()
  assert.deepEqual(events.slice(-2), ['kill runner', 'close tunnel'])
})

test('WdaController classifies a failed launch, keeps it in status, and control() names ios_real_start_wda', async () => {
  const { seams } = controllerSeams({ teamId: 'ABCDE12345', exitWith: { output: 'The application could not be launched because the Developer App Certificate is not trusted.', code: 65 } })
  const controller = new WdaController(seams)
  await assert.rejects(controller.start(IPHONE), (error: unknown) => error instanceof WdaError && error.reason === 'cert-untrusted'
    && /trust the Developer App certificate/.test(error.message))
  assert.deepEqual([controller.status().phase, controller.status().reason], ['failed', 'cert-untrusted'])
  await assert.rejects(controller.control(IPHONE), /run ios_real_start_wda first.*last start failed/)
})

test('WdaController without a signing team says how to add one; off macOS it refuses', async () => {
  const { seams } = controllerSeams()
  await assert.rejects(new WdaController(seams).start(IPHONE), /no signing team for WebDriverAgent — no signing team found/)
  await assert.rejects(new WdaController({ ...seams, platform: 'linux' }).start(IPHONE), /needs macOS/)
})
