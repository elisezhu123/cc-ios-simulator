import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  filterInstalledApps,
  localizeSimApps,
  lprojCandidates,
  parseSimctlListApps,
  resolveAppByName,
  type InstalledApp,
} from '../src/app-list.js'

const LISTAPPS = `{
    "com.apple.mobilecal" =     {
        ApplicationType = System;
        Bundle = "file:///Applications/Xcode.app/MobileCal.app/";
        CFBundleDisplayName = Calendar;
        CFBundleIdentifier = "com.apple.mobilecal";
        CFBundleName = MobileCal;
        CFBundleVersion = "1.0";
        GroupContainers =         {
            "group.com.apple.calendar" = "file:///tmp/AppGroup/";
        };
        Path = "/Applications/Xcode.app/MobileCal.app";
        SBAppTags =         (
        );
    };
    "com.example.demo" =     {
        ApplicationType = User;
        CFBundleDisplayName = "\\U793a\\U4f8b";
        CFBundleIdentifier = "com.example.demo";
        CFBundleShortVersionString = "2.1";
        Path = "/tmp/Demo.app";
    };
}`

test('parseSimctlListApps decodes escaped CJK names and classifies system apps', () => {
  assert.deepEqual(parseSimctlListApps(LISTAPPS), [
    { bundleId: 'com.apple.mobilecal', name: 'Calendar', version: '1.0', system: true },
    { bundleId: 'com.example.demo', name: '示例', version: '2.1', system: false },
  ])
})

test('parseSimctlListApps throws on output that is not a plist', () => {
  assert.throws(() => parseSimctlListApps('An error was encountered'), /listing FAILED/)
})

test('lprojCandidates maps zh-Hans-US to the on-disk zh_CN form', () => {
  assert.deepEqual(lprojCandidates('zh-Hans-US'), ['zh-Hans-US', 'zh-Hans', 'zh_CN', 'Base', 'en'])
})

test('localizeSimApps reads InfoPlist.strings in language order', async () => {
  const reads: string[] = []
  const localized = await localizeSimApps(
    [{ bundleId: 'com.apple.mobilecal', name: 'Calendar', system: true, appPath: '/A/MobileCal.app' }],
    'zh-Hans-US',
    async path => {
      reads.push(path)
      return path.includes('/zh_CN.lproj/') ? { CFBundleDisplayName: '日历' } : {} as Record<string, string>
    },
  )
  assert.deepEqual(localized, [{ bundleId: 'com.apple.mobilecal', name: '日历', baseName: 'Calendar', system: true }])
  assert.deepEqual(reads.slice(0, 3), [
    '/A/MobileCal.app/zh-Hans-US.lproj/InfoPlist.strings',
    '/A/MobileCal.app/zh-Hans.lproj/InfoPlist.strings',
    '/A/MobileCal.app/zh_CN.lproj/InfoPlist.strings',
  ])
})

const APPS: InstalledApp[] = [
  { bundleId: 'com.apple.mobilecal', name: '日历', baseName: 'Calendar', system: true },
  { bundleId: 'com.example.notes', name: 'Notes Pro', system: false },
  { bundleId: 'com.example.notes2', name: 'Notes', system: false },
]

test('filterInstalledApps hides system apps unless asked and matches base names', () => {
  assert.deepEqual(filterInstalledApps(APPS).map(app => app.bundleId), ['com.example.notes2', 'com.example.notes'])
  assert.deepEqual(
    filterInstalledApps(APPS, { query: 'calendar', includeSystem: true }).map(app => app.bundleId),
    ['com.apple.mobilecal'],
  )
})

test('resolveAppByName prefers an exact name among several matches', () => {
  assert.equal(resolveAppByName('t', APPS, 'notes', 'iPhone').bundleId, 'com.example.notes2')
})

test('resolveAppByName lists candidates when ambiguous and points at the listing when missing', () => {
  const apps: InstalledApp[] = [
    { bundleId: 'a.one', name: 'Foo One', system: false },
    { bundleId: 'a.two', name: 'Foo Two', system: false },
  ]
  assert.throws(() => resolveAppByName('ios_sim_launch_app', apps, 'foo', 'iPhone'), /2 installed apps match "foo"[\s\S]*Foo One — a\.one/)
  assert.throws(() => resolveAppByName('ios_sim_launch_app', apps, 'bar', 'iPhone'), /no installed app matches "bar"[\s\S]*ios_sim_list_apps/)
})
