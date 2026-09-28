# iOS Simulator 插件 · 第 ① 期（基础）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `ios-simulator-panel` 重建为 Claude Code 插件：自带 MCP 服务（16 个 `ios_sim_*` 工具）、serve-sim 实时面板、`ios-ui-automation` skill，设计见 `docs/superpowers/specs/2026-09-28-ios-simulator-foundation-design.md`。

**Architecture:** 一个 stdio MCP 进程（esbuild 打成单文件 `dist/server.js`），内部共用一个 `SimHostController`（从 dsh-ios 移植的 serve-sim 生命周期管理）。工具层用 MCP SDK + zod 注册，依赖通过 `ToolDeps` 注入（方便用假对象测试）。面板服务是只监听 127.0.0.1 的 HTTP + WebSocket 服务，转发 serve-sim 的 MJPEG 和控制通道，页面是原生 TS。

**Tech Stack:** TypeScript 6、Node ≥20（开发机 Node 26）、@modelcontextprotocol/sdk 1.30.1、zod 4、ws 8、esbuild 0.28、tsx、node:test、serve-sim 0.1.47、xcrun simctl、sips。

## Global Constraints

- 仓库：`/Users/elise123/Tools/Claude/Projects/ios-simulator-panel`，分支 `feat/foundation`。下文所有命令都在这个目录执行。
- 参考源（只读，绝不修改）：dsh-ios @ `d9a9731`。下文用 `$DSH` 指 `/Users/elise123/Tools/Claude/Projects/dsh-ios/src`，执行前先 `export DSH=/Users/elise123/Tools/Claude/Projects/dsh-ios/src`。
- 运行环境：macOS + Apple Silicon + 完整 Xcode，`engines.node` 为 `>=20`，serve-sim 固定 `0.1.47`。
- 工具名一律 `ios_sim_` 前缀；触摸坐标一律 0..1 归一化。
- 移植文件第一行必须是 `// Ported from dsh-ios (MIT, © 2026 ZSeven—W) @ d9a9731 — src/<原文件名>`；错误信息前缀 `dsh-ios:` 全部改成 `ios-simulator:`；模块注释里的 `@zseven-w/dsh-ios/` 改成 `ios-simulator/`。
- 执行外部命令只用 `execFile` / `spawn` 传参数数组，`src/` 里禁止出现 `exec(` / `execSync(`。
- 环境变量：`IOS_SIM_CACHE_DIR`（缓存根目录，默认 `~/Library/Caches/ios-simulator`）、`IOS_SIM_PANEL_PORT`（默认 3456，被占用时递增到 +20）、`IOS_SIM_SERVE_SIM_BIN`（覆盖 serve-sim 路径）。
- 工具描述、skill 正文、代码注释用英文；README 用中文。
- `npm test` 不需要模拟器；真机测试放 `test/live/`，只在 `IOS_SIM_SMOKE=1` 时运行。
- 每次提交的信息末尾加一行 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`。
- tsconfig 开启 `strict`、`noUnusedLocals`、`noUnusedParameters`（与 dsh-ios 一致）：写完每个文件都要确认没有未使用的 import 或参数。

## 文件结构

| 文件 | 职责 | 任务 |
|---|---|---|
| `package.json` `tsconfig.json` `.gitignore` `scripts/build.mjs` | 构建与依赖 | 1 |
| `.claude-plugin/plugin.json` `.claude-plugin/marketplace.json` | 插件清单、本地 marketplace | 1 |
| `THIRD_PARTY_NOTICES.md` | 第三方许可 | 1 |
| `src/config.ts` | 常量与环境变量 | 1 |
| `src/simctl.ts` | simctl 封装（移植 + 新增） | 2 |
| `src/plist.ts` `src/app-list.ts` | plist 解析、已安装 app 列表（移植） | 3 |
| `src/build-run.ts` | xcodebuild 构建安装启动（移植，只留模拟器） | 4 |
| `src/sim-host.ts` | serve-sim 生命周期（移植） | 5 |
| `src/sim-gesture.ts` `src/device-actions.ts` `src/stream-source.ts` | WS 手势通道、设备动作、StreamSource（移植） | 6 |
| `src/interact.ts` | interact 参数映射与投递（从 tools.ts 移植） | 7 |
| `src/screenshot.ts` | 截图缓存、清理、JPEG 缩图 | 8 |
| `src/recorder.ts` | 录屏子进程管理 | 9 |
| `src/deps.ts` `src/target.ts` `src/tools/result.ts` | 依赖接口、设备选择、结果格式 | 10 |
| `src/tools/core.ts` | devices/boot/shutdown/panel/screenshot/interact | 11 |
| `src/tools/apps.ts` | list_apps/launch_app/build_run/install_app/uninstall_app | 12 |
| `src/tools/env.ts` | open_url/push/location/appearance/record | 13 |
| `src/panel/fence.ts` | 面板安全边界 | 14 |
| `src/panel/panel-server.ts` | 面板 HTTP + WS 服务 | 15 |
| `src/panel/client/*` | 面板网页 | 16 |
| `src/server.ts` | 组装与生命周期 | 17 |
| `skills/ios-ui-automation/SKILL.md` `README.md` | skill 与文档 | 18 |
| `test/live/*.test.ts` | 真机冒烟 | 19 |
| `src/orientation.ts` | 横屏下的截图方向与坐标换算 | 20 |
| `test/helpers/{png,fakes,harness}.ts` | 测试工具：生成 PNG、假依赖、MCP 测试夹具 | 6、9、10 |

---

### Task 1: 清理旧代码并搭建插件骨架

**Files:**
- Delete: `src/index.ts` `src/http-server.ts` `src/server.mjs` `src/ui/` `ARCHITECTURE.md` `COMPLETION_REPORT.md` `DEMO.md` `GATEWAY_OPTION.md` `PROJECT.txt` `QUICKSTART.md` `START_HERE.txt` `SUMMARY.md` `ios-simulator-panel/` `configure.mjs` `demo.sh` `install.sh` `start-server.js` `test-server.mjs` `ios-simulator-panel.mcpb` `ios-simulator-panel-complete.tar.gz` `manifest.json` `claude_desktop_config.example.json` `.claude/launch.json` `package-lock.json`
- Create (覆盖): `package.json` `tsconfig.json` `.gitignore`
- Create: `scripts/build.mjs` `.claude-plugin/plugin.json` `.claude-plugin/marketplace.json` `THIRD_PARTY_NOTICES.md` `src/config.ts` `test/config.test.ts`

**Interfaces:**
- Produces（`src/config.ts`）：`PLUGIN_NAME = 'ios-simulator'`、`SERVER_VERSION = '0.1.0'`、`SERVE_SIM_VERSION = '0.1.47'`、`DEFAULT_PANEL_PORT = 3456`、`PANEL_PORT_ATTEMPTS = 21`、`INTERACT_SETTLE_MS = 300`、`RECORD_STOP_TIMEOUT_MS = 10_000`、`RECORD_START_TIMEOUT_MS = 15_000`、`SCREENSHOT_KEEP = 100`、`MODEL_IMAGE_MAX_EDGE = 1024`、`MODEL_IMAGE_JPEG_QUALITY = 80`、`type Env`、`cacheRoot(env?): string`、`preferredPanelPort(env?): number`、`serveSimBinOverride(env?): string | undefined`

- [ ] **Step 1: 删除旧文件**（基线提交 `9da4e6a` 里都能找回）

```bash
git rm -q -r src/index.ts src/http-server.ts src/server.mjs src/ui \
  ARCHITECTURE.md COMPLETION_REPORT.md DEMO.md GATEWAY_OPTION.md PROJECT.txt QUICKSTART.md \
  START_HERE.txt SUMMARY.md ios-simulator-panel configure.mjs demo.sh install.sh start-server.js \
  test-server.mjs ios-simulator-panel.mcpb ios-simulator-panel-complete.tar.gz manifest.json \
  claude_desktop_config.example.json .claude/launch.json package-lock.json
rm -rf dist node_modules server.log
git status --short
```

Expected：只有 `D ` 开头的行，外加 `package.json` `tsconfig.json` `.gitignore` `README.md` `LICENSE` 仍然存在。

- [ ] **Step 2: 覆盖写 `package.json`**

```json
{
  "name": "ios-simulator-plugin",
  "version": "0.1.0",
  "private": true,
  "description": "Claude Code plugin: drive the iOS Simulator with a live stream panel. Ported from dsh-ios.",
  "license": "MIT",
  "type": "module",
  "engines": {
    "node": ">=20"
  },
  "scripts": {
    "typecheck": "tsc -p tsconfig.json",
    "build": "npm run typecheck && node scripts/build.mjs",
    "check:bundle": "node scripts/check-bundle.mjs",
    "test": "node --import tsx --test \"test/*.test.ts\"",
    "test:live": "node --import tsx --test \"test/live/*.test.ts\""
  },
  "dependencies": {
    "serve-sim": "0.1.47"
  },
  "devDependencies": {
    "@modelcontextprotocol/sdk": "1.30.1",
    "@types/node": "^22.10.0",
    "@types/ws": "^8.18.1",
    "esbuild": "^0.28.2",
    "tsx": "^4.23.15",
    "typescript": "^6.0.3",
    "ws": "^8.22.0",
    "zod": "^4.6.5"
  }
}
```

- [ ] **Step 3: 覆盖写 `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noEmit": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "types": ["node"]
  },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

- [ ] **Step 4: 覆盖写 `.gitignore`**（`dist/` 不再忽略，打包产物要提交）

```gitignore
node_modules/
*.log
.DS_Store
.vscode/
.idea/
*.swp
*~
```

- [ ] **Step 5: 安装依赖**

Run: `npm install && ls node_modules/serve-sim/dist/serve-sim.js`
Expected: 安装成功，最后一行打印 `node_modules/serve-sim/dist/serve-sim.js`。

- [ ] **Step 6: 写失败的测试 `test/config.test.ts`**

```ts
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
```

- [ ] **Step 7: 运行，确认失败**

Run: `npm test`
Expected: FAIL，报 `Cannot find module '.../src/config.js'`。

- [ ] **Step 8: 写 `src/config.ts`**

```ts
/**
 * Plugin-wide constants and environment-driven settings.
 * @module ios-simulator/config
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

export const PLUGIN_NAME = 'ios-simulator'
export const SERVER_VERSION = '0.1.0'
/** serve-sim version pinned for the npx fallback (package.json pins the same). */
export const SERVE_SIM_VERSION = '0.1.47'
export const DEFAULT_PANEL_PORT = 3456
/** Ports tried for the panel: preferred .. preferred + 20. */
export const PANEL_PORT_ATTEMPTS = 21
/** Settle delay after an interaction, before the effect screenshot. */
export const INTERACT_SETTLE_MS = 300
/** How long `ios_sim_record stop` waits for simctl to finish the movie. */
export const RECORD_STOP_TIMEOUT_MS = 10_000
/** How long `ios_sim_record start` waits for simctl's "Recording started". */
export const RECORD_START_TIMEOUT_MS = 15_000
/** Full-resolution screenshots kept in the cache (oldest pruned first). */
export const SCREENSHOT_KEEP = 100
/** Long edge of the JPEG handed to the model. */
export const MODEL_IMAGE_MAX_EDGE = 1024
export const MODEL_IMAGE_JPEG_QUALITY = 80

export type Env = Readonly<Record<string, string | undefined>>

/** Cache root: `IOS_SIM_CACHE_DIR`, else `~/Library/Caches/ios-simulator`. */
export function cacheRoot(env: Env = process.env): string {
  const override = env.IOS_SIM_CACHE_DIR?.trim()
  return override !== undefined && override !== ''
    ? override
    : join(homedir(), 'Library', 'Caches', 'ios-simulator')
}

/** Preferred panel port: `IOS_SIM_PANEL_PORT` when it is a valid port, else 3456. */
export function preferredPanelPort(env: Env = process.env): number {
  const raw = env.IOS_SIM_PANEL_PORT?.trim()
  if (raw === undefined || raw === '') return DEFAULT_PANEL_PORT
  const port = Number(raw)
  return Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : DEFAULT_PANEL_PORT
}

/** Explicit serve-sim binary (`IOS_SIM_SERVE_SIM_BIN`), when set. */
export function serveSimBinOverride(env: Env = process.env): string | undefined {
  const raw = env.IOS_SIM_SERVE_SIM_BIN?.trim()
  return raw === undefined || raw === '' ? undefined : raw
}
```

- [ ] **Step 9: 运行，确认通过**

Run: `npm test && npm run typecheck`
Expected: `# pass 4`、`# fail 0`；typecheck 无输出、退出码 0。

- [ ] **Step 10: 写 `scripts/build.mjs`**（`src/server.ts` 在 Task 17 才有，本任务不运行 build）

```js
// Bundles the MCP server into dist/server.js and the panel page into dist/panel/.
import { build } from 'esbuild'
import { cp, mkdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dist = join(root, 'dist')

await rm(dist, { recursive: true, force: true })
await mkdir(join(dist, 'panel'), { recursive: true })

await build({
  entryPoints: [join(root, 'src/server.ts')],
  outfile: join(dist, 'server.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  // ws optionally requires these native accelerators; they are not installed.
  external: ['bufferutil', 'utf-8-validate'],
  // CJS dependencies (ws) call require() for Node built-ins; give the ESM bundle one.
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  logLevel: 'warning',
})

await build({
  entryPoints: [join(root, 'src/panel/client/main.ts')],
  outfile: join(dist, 'panel/main.js'),
  bundle: true,
  platform: 'browser',
  format: 'esm',
  target: 'es2022',
  logLevel: 'warning',
})
await cp(join(root, 'src/panel/client/index.html'), join(dist, 'panel/index.html'))
await cp(join(root, 'src/panel/client/styles.css'), join(dist, 'panel/styles.css'))
console.log('built dist/server.js and dist/panel/')
```

- [ ] **Step 11: 写插件清单 `.claude-plugin/plugin.json`**

```json
{
  "name": "ios-simulator",
  "version": "0.1.0",
  "description": "Drive the iOS Simulator from Claude Code: live stream panel, taps and gestures, apps, build & run. Ported from dsh-ios.",
  "author": { "name": "elisezhu123" },
  "license": "MIT",
  "keywords": ["ios", "simulator", "xcode", "mcp"],
  "mcpServers": {
    "ios-simulator": {
      "command": "node",
      "args": ["${CLAUDE_PLUGIN_ROOT}/dist/server.js"]
    }
  }
}
```

- [ ] **Step 12: 写本地 marketplace `.claude-plugin/marketplace.json`**

```json
{
  "name": "ios-simulator-panel",
  "owner": { "name": "elisezhu123" },
  "plugins": [
    {
      "name": "ios-simulator",
      "source": "./",
      "description": "iOS Simulator tools and a live panel for Claude Code"
    }
  ]
}
```

- [ ] **Step 13: 生成 `THIRD_PARTY_NOTICES.md`**

```bash
{
  printf '# Third-party notices\n\n## dsh-ios\n\nPortions of this plugin are ported from dsh-ios (https://github.com/ZSeven-W/dsh-ios) at commit d9a9731 (0.1.0-rc.10). Every ported file names its source in its first line.\n\n~~~text\n'
  cat /Users/elise123/Tools/Claude/Projects/dsh-ios/LICENSE
  printf '~~~\n\n## serve-sim\n\nRuntime dependency installed from npm, not redistributed here: https://github.com/EvanBacon/serve-sim (Apache License 2.0, Copyright Evan Bacon).\n\n## Bundled into dist/server.js\n\n- @modelcontextprotocol/sdk (MIT)\n- zod (MIT)\n- ws (MIT)\n'
} > THIRD_PARTY_NOTICES.md
head -8 THIRD_PARTY_NOTICES.md
```

Expected: 前 8 行包含 `# Third-party notices` 和 `MIT License`。

- [ ] **Step 14: 提交**

```bash
git add -A
git commit -q -m "chore: replace the old panel with the Claude Code plugin scaffold

Removes the old MCP App code, status docs, scripts and bundles (all kept
in the baseline commit) and adds the plugin manifest, local marketplace,
build script, notices and src/config.ts.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git log --oneline -1
```

---

### Task 2: 移植 `simctl.ts` 并补充新封装

**Files:**
- Create: `src/simctl.ts`（从 `$DSH/simctl.ts` 复制后修改）
- Test: `test/simctl.test.ts`

**Interfaces:**
- Produces：`interface SimulatorDevice { udid; name; runtime; state; deviceType?: string }`、`class SimctlError(message, stderr, code?)`、`type SimctlRunner`、`setSimctlRunnerForTests(next?)`、`parseDeviceList(stdout)`、`listDevices()`、`bootDevice(udid)`、`shutdownDevice(udid)`、`bootedDevices()`、`compareRuntimesDesc(a, b)`、`getDevice(reference)`、`takeScreenshot(udid, path, signal?)`、`installApp(udid, appPath, signal?)`、`launchApp(udid, bundleId, signal?): Promise<string>`、`getAppContainer`、`listAppsPlist(udid, signal?)`、`terminateApp(udid, bundleId, signal?): Promise<string>`、`uninstallApp(udid, bundleId, signal?)`、新增 `openUrl(udid, url, signal?)`、`sendPush(udid, bundleId, payloadPath, signal?)`、`locationSetArgs(udid, lat, lon): string[]`、`setLocation(udid, lat, lon, signal?)`、`clearLocation(udid, signal?)`、`setAppearance(udid, 'light' | 'dark', signal?)`

- [ ] **Step 1: 复制源文件并统一改名**

```bash
export DSH=/Users/elise123/Tools/Claude/Projects/dsh-ios/src
{ echo '// Ported from dsh-ios (MIT, © 2026 ZSeven—W) @ d9a9731 — src/simctl.ts'; cat "$DSH/simctl.ts"; } > src/simctl.ts
sed -i '' -e 's#@zseven-w/dsh-ios/#ios-simulator/#g' -e 's/dsh-ios: /ios-simulator: /g' src/simctl.ts
head -3 src/simctl.ts
```

- [ ] **Step 2: 写失败的测试 `test/simctl.test.ts`**

```ts
import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  SimctlError,
  bootDevice,
  clearLocation,
  getDevice,
  locationSetArgs,
  openUrl,
  parseDeviceList,
  sendPush,
  setAppearance,
  setLocation,
  setSimctlRunnerForTests,
  shutdownDevice,
} from '../src/simctl.js'

const LIST_JSON = JSON.stringify({
  devices: {
    'com.apple.CoreSimulator.SimRuntime.iOS-18-0': [
      { udid: 'AAA', name: 'iPhone 16', state: 'Shutdown', isAvailable: true, deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-16' },
    ],
    'com.apple.CoreSimulator.SimRuntime.iOS-26-0': [
      { udid: 'BBB', name: 'iPhone 16', state: 'Booted', isAvailable: true },
      { udid: 'CCC', name: 'iPad Air', state: 'Shutdown', isAvailable: true },
      { udid: 'DDD', name: 'Broken', state: 'Shutdown', isAvailable: false },
    ],
  },
})

/** Route simctl through a fake keyed by subcommand; records every call. */
function fakeRunner(responses: Record<string, string | Error> = {}): string[][] {
  const calls: string[][] = []
  setSimctlRunnerForTests(async args => {
    calls.push([...args])
    const reply = responses[args[0] ?? '']
    if (reply instanceof Error) throw reply
    return reply ?? ''
  })
  return calls
}

afterEach(() => setSimctlRunnerForTests())

test('parseDeviceList keeps available devices with their runtime and device type', () => {
  const devices = parseDeviceList(LIST_JSON)
  assert.deepEqual(devices.map(device => device.udid), ['AAA', 'BBB', 'CCC'])
  assert.equal(devices[0]?.runtime, 'com.apple.CoreSimulator.SimRuntime.iOS-18-0')
  assert.equal(devices[0]?.deviceType, 'com.apple.CoreSimulator.SimDeviceType.iPhone-16')
  assert.equal(devices[1]?.deviceType, undefined)
})

test('parseDeviceList rejects output that is not JSON', () => {
  assert.throws(() => parseDeviceList('oops'), SimctlError)
})

test('getDevice resolves a udid first, then a name preferring the booted device', async () => {
  fakeRunner({ list: LIST_JSON })
  assert.equal((await getDevice('CCC')).name, 'iPad Air')
  assert.equal((await getDevice('iphone 16')).udid, 'BBB')
  await assert.rejects(getDevice('Nope'), /unknown simulator "Nope".*ios_sim_devices/)
})

test('bootDevice tolerates an already-booted device and waits for bootstatus', async () => {
  const calls = fakeRunner({ boot: new SimctlError('boot failed', 'Unable to boot device in current state: Booted') })
  await bootDevice('BBB')
  assert.deepEqual(calls, [['boot', 'BBB'], ['bootstatus', 'BBB', '-b']])
})

test('shutdownDevice tolerates an already-shutdown device', async () => {
  fakeRunner({ shutdown: new SimctlError('shutdown failed', 'Unable to shutdown device in current state: Shutdown') })
  await shutdownDevice('AAA')
})

test('locationSetArgs joins latitude and longitude into ONE argument', () => {
  assert.deepEqual(locationSetArgs('BBB', 37.7749, -122.4194), ['location', 'BBB', 'set', '37.7749,-122.4194'])
  assert.throws(() => locationSetArgs('BBB', 91, 0), /latitude/)
  assert.throws(() => locationSetArgs('BBB', 0, -181), /longitude/)
})

test('the new wrappers hand argument arrays straight to simctl', async () => {
  const calls = fakeRunner()
  await openUrl('BBB', 'myapp://x?y=1 2')
  await sendPush('BBB', 'com.example.app', '/tmp/p.json')
  await setLocation('BBB', 1.5, 2.5)
  await clearLocation('BBB')
  await setAppearance('BBB', 'dark')
  assert.deepEqual(calls, [
    ['openurl', 'BBB', 'myapp://x?y=1 2'],
    ['push', 'BBB', 'com.example.app', '/tmp/p.json'],
    ['location', 'BBB', 'set', '1.5,2.5'],
    ['location', 'BBB', 'clear'],
    ['ui', 'BBB', 'appearance', 'dark'],
  ])
})
```

- [ ] **Step 3: 运行，确认失败**

Run: `npm test`
Expected: FAIL，`setSimctlRunnerForTests` / `parseDeviceList` 等导出不存在（SyntaxError: does not provide an export named ...）。

- [ ] **Step 4: 加测试替身接口。** 用 Edit 把原来的 `execSimctl` 函数（从 `/** Run \`xcrun simctl <args>\` and resolve its stdout, with a typed failure. */` 到这个函数结束的 `}`）整段替换为：

```ts
/** Runs `xcrun simctl <args>` and resolves stdout; rejects with SimctlError. */
export type SimctlRunner = (args: readonly string[], timeoutMs: number, signal?: AbortSignal) => Promise<string>

/** Run `xcrun simctl <args>` and resolve its stdout, with a typed failure. */
function runXcrunSimctl(args: readonly string[], timeoutMs: number, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('xcrun', ['simctl', ...args], {
      timeout: timeoutMs,
      maxBuffer: SIMCTL_MAX_BUFFER_BYTES,
      signal,
    }, (error, stdout, stderr) => {
      if (error !== null) {
        const detail = stderr.trim()
        reject(new SimctlError(
          `simctl ${args.join(' ')} failed${detail === '' ? '' : `: ${detail}`}`,
          stderr,
          error.code ?? undefined,
        ))
        return
      }
      resolve(stdout)
    })
  })
}

let runner: SimctlRunner = runXcrunSimctl

/** Test seam: replace the simctl runner; call with no argument to restore it. */
export function setSimctlRunnerForTests(next?: SimctlRunner): void {
  runner = next ?? runXcrunSimctl
}

function execSimctl(args: readonly string[], timeoutMs: number, signal?: AbortSignal): Promise<string> {
  return runner(args, timeoutMs, signal)
}
```

- [ ] **Step 5: 加 `deviceType` 字段。** 在 `interface SimulatorDevice` 的 `state: string` 后面加一行：

```ts
  /** Device type identifier, e.g. `com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro`. */
  deviceType?: string
```

并在 `interface SimctlDeviceEntry` 的 `isAvailable?: boolean` 后面加一行：

```ts
  deviceTypeIdentifier?: string
```

- [ ] **Step 6: 把 `listDevices` 拆成纯解析函数。** 用 Edit 把整个 `listDevices`（从 `/**\n * List every *available* simulator device` 注释到函数结束的 `}`）替换为：

```ts
/**
 * Parse `simctl list devices --json` into every *available* device as
 * `{ udid, name, runtime, state, deviceType? }`. Unavailable devices
 * (mismatched runtime, corrupt, …) are skipped.
 */
export function parseDeviceList(stdout: string): SimulatorDevice[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch (error) {
    throw new SimctlError(
      `simctl list devices returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      stdout,
    )
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new SimctlError('simctl list devices returned an unexpected shape', stdout)
  }
  const runtimes = (parsed as { devices?: unknown }).devices
  if (typeof runtimes !== 'object' || runtimes === null || Array.isArray(runtimes)) {
    throw new SimctlError('simctl list devices is missing its devices map', stdout)
  }
  const devices: SimulatorDevice[] = []
  for (const [runtime, entries] of Object.entries(runtimes as Record<string, unknown>)) {
    if (!Array.isArray(entries)) continue
    for (const entry of entries) {
      if (typeof entry !== 'object' || entry === null) continue
      const device = entry as unknown as SimctlDeviceEntry
      if (device.isAvailable !== true) continue
      if (typeof device.udid !== 'string' || typeof device.name !== 'string' || typeof device.state !== 'string') continue
      devices.push({
        udid: device.udid,
        name: device.name,
        runtime,
        state: device.state,
        ...(typeof device.deviceTypeIdentifier === 'string' ? { deviceType: device.deviceTypeIdentifier } : {}),
      })
    }
  }
  return devices
}

/** List every *available* simulator device (see `parseDeviceList`). */
export async function listDevices(): Promise<SimulatorDevice[]> {
  return parseDeviceList(await execSimctl(['list', 'devices', '--json'], SIMCTL_LIST_TIMEOUT_MS))
}
```

- [ ] **Step 7: 在文件末尾追加新封装**

```ts
const SIMCTL_OPENURL_TIMEOUT_MS = 60_000
const SIMCTL_PUSH_TIMEOUT_MS = 30_000
const SIMCTL_LOCATION_TIMEOUT_MS = 30_000
const SIMCTL_UI_TIMEOUT_MS = 30_000

/** Open a URL or deep link on the device (`simctl openurl`). */
export async function openUrl(udid: string, url: string, signal?: AbortSignal): Promise<void> {
  await execSimctl(['openurl', udid, url], SIMCTL_OPENURL_TIMEOUT_MS, signal)
}

/** Deliver an APNs payload file to an installed app (`simctl push`). */
export async function sendPush(udid: string, bundleId: string, payloadPath: string, signal?: AbortSignal): Promise<void> {
  await execSimctl(['push', udid, bundleId, payloadPath], SIMCTL_PUSH_TIMEOUT_MS, signal)
}

/**
 * `simctl location <udid> set <lat>,<lon>` — the coordinate pair is ONE
 * comma-joined argument (the old panel passed two and never worked).
 */
export function locationSetArgs(udid: string, latitude: number, longitude: number): string[] {
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
    throw new RangeError(`latitude must be within -90..90, got ${String(latitude)}`)
  }
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    throw new RangeError(`longitude must be within -180..180, got ${String(longitude)}`)
  }
  return ['location', udid, 'set', `${latitude},${longitude}`]
}

/** Set the simulated GPS location. */
export async function setLocation(udid: string, latitude: number, longitude: number, signal?: AbortSignal): Promise<void> {
  await execSimctl(locationSetArgs(udid, latitude, longitude), SIMCTL_LOCATION_TIMEOUT_MS, signal)
}

/** Clear the simulated location (and stop any running scenario). */
export async function clearLocation(udid: string, signal?: AbortSignal): Promise<void> {
  await execSimctl(['location', udid, 'clear'], SIMCTL_LOCATION_TIMEOUT_MS, signal)
}

/** Switch the device between light and dark mode. */
export async function setAppearance(udid: string, appearance: 'light' | 'dark', signal?: AbortSignal): Promise<void> {
  await execSimctl(['ui', udid, 'appearance', appearance], SIMCTL_UI_TIMEOUT_MS, signal)
}
```

- [ ] **Step 8: 运行，确认通过**

Run: `npm test && npm run typecheck`
Expected: simctl 的 7 个测试全部 PASS，typecheck 无错误。

- [ ] **Step 9: 提交**

```bash
git add src/simctl.ts test/simctl.test.ts
git commit -q -m "feat: port simctl wrappers and add openurl/push/location/appearance

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 3: 移植 `plist.ts` 与 `app-list.ts`（只保留模拟器）

**Files:**
- Create: `src/plist.ts`（原样移植）、`src/app-list.ts`（移植后删掉真机部分）
- Test: `test/app-list.test.ts`

**Interfaces:**
- Consumes：`listAppsPlist(udid, signal?)`（Task 2）
- Produces：`interface InstalledApp { bundleId; name; baseName?; version?; system: boolean }`、`interface SimAppWithPath`、`parseSimctlListApps(stdout, device?)`、`lprojCandidates(language)`、`simulatorLanguage(udid, prefsPath?)`、`localizeSimApps(apps, language, readStringsAt?)`、`listSimulatorApps(udid, signal?): Promise<InstalledApp[]>`、`noMatchListingHint(kind, total)`、`noMatchCandidateLines(apps, limit?)`、`filterInstalledApps(apps, { query?, includeSystem? })`、`resolveAppByName(tool, apps, name, deviceName, options?)`

- [ ] **Step 1: 复制两个文件并改名**

```bash
export DSH=/Users/elise123/Tools/Claude/Projects/dsh-ios/src
for f in plist app-list; do
  { echo "// Ported from dsh-ios (MIT, © 2026 ZSeven—W) @ d9a9731 — src/$f.ts"; cat "$DSH/$f.ts"; } > "src/$f.ts"
  sed -i '' -e 's#@zseven-w/dsh-ios/#ios-simulator/#g' -e 's/dsh-ios: /ios-simulator: /g' "src/$f.ts"
done
```

- [ ] **Step 2: 删掉 app-list 里的真机代码**（devicectl 在第 ⑤ 期才移植）

```bash
node - <<'EOF'
const fs = require('node:fs')
const file = 'src/app-list.ts'
let text = fs.readFileSync(file, 'utf8')
function cut(start, end) {
  const a = text.indexOf(start)
  const b = a < 0 ? -1 : text.indexOf(end, a)
  if (a < 0 || b < 0) throw new Error(`marker not found: ${start}`)
  text = text.slice(0, a) + text.slice(b)
}
const devicectlImport = "import { listApps as devicectlListApps, type RealApp } from './devicectl.js'\n"
if (!text.includes(devicectlImport)) throw new Error('devicectl import not found')
text = text.replace(devicectlImport, '')
cut('/** Map one devicectl app record onto the shared shape. */', '/** Run `worker` over `items`')
cut('/**\n * Installed apps on a PHYSICAL device', '/**\n * WP60:')
fs.writeFileSync(file, text)
EOF
grep -n "devicectl\|RealApp\|listPhysicalDeviceApps" src/app-list.ts || echo "no real-device code left"
```

Expected：只剩注释里提到 devicectl 的行（例如 WP57 说明），没有 `import`、`RealApp`、`listPhysicalDeviceApps`。

- [ ] **Step 3: 写测试 `test/app-list.test.ts`**

```ts
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
      return path.includes('/zh_CN.lproj/') ? { CFBundleDisplayName: '日历' } : {}
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
```

- [ ] **Step 4: 运行测试和类型检查**

Run: `npm test && npm run typecheck`
Expected：app-list 的 7 个测试 PASS；typecheck 无错误（若报 `noUnusedLocals`，说明 Step 2 漏删了代码，按报错位置补删）。

- [ ] **Step 5: 提交**

```bash
git add src/plist.ts src/app-list.ts test/app-list.test.ts
git commit -q -m "feat: port plist parsing and the simulator app listing

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: 移植 `build-run.ts`（只保留模拟器路径）

**Files:**
- Create: `src/build-run.ts`
- Test: `test/build-run.test.ts`

**Interfaces:**
- Consumes：`installApp`、`launchApp`、`SimulatorDevice`（Task 2）
- Produces：`type ProjectKind`、`interface ProjectTarget { kind; root; location }`、`interface BuildInvocation { target; scheme?; configuration; udid; derivedDataPath }`、`interface BuildRunResult { device; state: 'launched'; bundleId; pid; appPath; projectPath; scheme?; configuration }`、`projectSlug`、`detectProject(path): ProjectTarget`、`assembleBuildArgs(invocation): string[]`、`packageNameFromManifest`、`listSchemes`、`resolveScheme(target, scheme?, signal?)`、`runXcodeBuild`、`filterBuildOutput(lines, limit?)`、`buildFailureDetail`、`findBuiltApp(derivedDataPath, configuration, productHint?)`、`readBundleIdentifier(appPath, signal?)`、`interface BuildRunOptions { target; scheme?; configuration; device: SimulatorDevice; cacheDir; signal }`、`buildRun(options): Promise<BuildRunResult>`

- [ ] **Step 1: 复制源文件**

```bash
export DSH=/Users/elise123/Tools/Claude/Projects/dsh-ios/src
{ echo '// Ported from dsh-ios (MIT, © 2026 ZSeven—W) @ d9a9731 — src/build-run.ts (simulator path only)'; cat "$DSH/build-run.ts"; } > src/build-run.ts
sed -i '' -e 's#@zseven-w/dsh-ios/#ios-simulator/#g' -e 's/dsh-ios: /ios-simulator: /g' src/build-run.ts
```

- [ ] **Step 2: 去掉真机、签名分支**

```bash
node - <<'EOF'
const fs = require('node:fs')
const file = 'src/build-run.ts'
let text = fs.readFileSync(file, 'utf8')
function replaceExact(oldText, newText) {
  if (!text.includes(oldText)) throw new Error(`text not found: ${oldText.slice(0, 60)}`)
  text = text.replace(oldText, newText)
}
function replaceBetween(start, end, replacement) {
  const a = text.indexOf(start)
  const b = a < 0 ? -1 : text.indexOf(end, a)
  if (a < 0 || b < 0) throw new Error(`markers not found: ${start.slice(0, 60)}`)
  text = text.slice(0, a) + replacement + text.slice(b)
}
replaceExact(`import {
  detectAppleDevelopmentIdentity,
  installApp as installAppOnDevice,
  launchApp as launchAppOnDevice,
  resolveSigningTeam,
  type RealDevice,
} from './devicectl.js'
import { pluginEnv } from './plugin-env.js'
`, '')
// BuildInvocation loses platform/signing; BuildDevice and destinationIdFor go away.
replaceBetween("  /** Build platform; defaults to 'simulator'", '/** Successful outcome of build + install + launch. */', '}\n\n')
replaceExact('  /** True when the app was installed/launched on a physical device. */\n  physicalDevice?: boolean\n', '')
replaceBetween("  const platform = invocation.platform ?? 'simulator'\n", '  return args\n}', `  const args: string[] = []
  if (target.kind === 'xcodeproj') args.push('-project', target.location)
  else if (target.kind === 'xcworkspace') args.push('-workspace', target.location)
  if (invocation.scheme !== undefined) args.push('-scheme', invocation.scheme)
  args.push(
    '-configuration', configuration,
    '-destination', \`platform=iOS Simulator,id=\${udid}\`,
    '-derivedDataPath', derivedDataPath,
    'build',
  )
`)
// Everything from BuildRunOptions on is the device-aware pipeline; replace it.
const tail = text.indexOf('export interface BuildRunOptions')
if (tail < 0) throw new Error('BuildRunOptions not found')
text = text.slice(0, tail) + `export interface BuildRunOptions {
  target: ProjectTarget
  scheme?: string
  configuration: string
  /** The (booted) simulator to install and launch onto. */
  device: SimulatorDevice
  cacheDir: string
  signal: AbortSignal
}

/**
 * Full pipeline: build → find the app → install → launch on the simulator.
 * Build failures throw with the filtered xcodebuild tail.
 */
export async function buildRun(options: BuildRunOptions): Promise<BuildRunResult> {
  const { target, configuration, device, cacheDir, signal } = options
  const derivedDataPath = join(cacheDir, 'builds', projectSlug(target.location), 'DerivedData')
  const scheme = await resolveScheme(target, options.scheme, signal)
  const { exitCode, lines } = await runXcodeBuild({
    target,
    ...(scheme === undefined ? {} : { scheme }),
    configuration,
    udid: device.udid,
    derivedDataPath,
  }, signal)
  if (exitCode !== 0) {
    throw new Error(\`xcodebuild failed (exit \${String(exitCode)}) for \${normalize(target.location)}:\\n\${buildFailureDetail(lines)}\`)
  }
  const appPath = findBuiltApp(derivedDataPath, configuration, scheme)
  if (appPath === undefined) {
    throw new Error(
      \`xcodebuild finished but no .app bundle was found under \${derivedDataPath} — \`
      + 'check the scheme/configuration produce an iOS Simulator app',
    )
  }
  const bundleId = await readBundleIdentifier(appPath, signal)
  await installApp(device.udid, appPath, signal)
  const launchOutput = await launchApp(device.udid, bundleId, signal)
  // \`simctl launch\` prints \`<bundle-id>: <pid>\`.
  const pidMatch = /:\\s*(\\d+)\\s*$/u.exec(launchOutput.trim())
  return {
    device: { udid: device.udid, name: device.name, runtime: device.runtime, state: 'Booted' },
    state: 'launched',
    bundleId,
    pid: pidMatch === null ? '' : pidMatch[1] ?? '',
    appPath,
    projectPath: target.location,
    ...(scheme === undefined ? {} : { scheme }),
    configuration,
  }
}
`
fs.writeFileSync(file, text)
EOF
grep -n "devicectl\|RealDevice\|platform ===\|physicalDevice\|DEVICE_SIGNING" src/build-run.ts || echo "simulator-only"
```

Expected：打印 `simulator-only`（或只剩注释行）。

- [ ] **Step 3: 写测试 `test/build-run.test.ts`**

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  assembleBuildArgs,
  detectProject,
  filterBuildOutput,
  findBuiltApp,
  projectSlug,
  resolveScheme,
} from '../src/build-run.js'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'ios-sim-build-'))
}

test('detectProject recognises xcodeproj, xcworkspace and Swift packages', () => {
  const root = tempDir()
  mkdirSync(join(root, 'App.xcodeproj'))
  mkdirSync(join(root, 'App.xcworkspace'))
  mkdirSync(join(root, 'Pkg'))
  writeFileSync(join(root, 'Pkg', 'Package.swift'), 'let package = Package(name: "Pkg")')
  assert.equal(detectProject(join(root, 'App.xcodeproj')).kind, 'xcodeproj')
  assert.equal(detectProject(join(root, 'App.xcworkspace')).kind, 'xcworkspace')
  assert.deepEqual(detectProject(join(root, 'Pkg')), { kind: 'package', root: join(root, 'Pkg'), location: join(root, 'Pkg') })
  assert.throws(() => detectProject(join(root, 'missing.xcodeproj')), /does not exist/)
  assert.throws(() => detectProject(root), /must be an absolute path/)
})

test('assembleBuildArgs targets the iOS Simulator destination only', () => {
  const args = assembleBuildArgs({
    target: { kind: 'xcodeproj', root: '/p', location: '/p/App.xcodeproj' },
    scheme: 'App',
    configuration: 'Debug',
    udid: 'BBB',
    derivedDataPath: '/c/DD',
  })
  assert.deepEqual(args, [
    '-project', '/p/App.xcodeproj', '-scheme', 'App', '-configuration', 'Debug',
    '-destination', 'platform=iOS Simulator,id=BBB', '-derivedDataPath', '/c/DD', 'build',
  ])
})

test('assembleBuildArgs omits -project/-workspace for packages', () => {
  const args = assembleBuildArgs({
    target: { kind: 'package', root: '/pkg', location: '/pkg' },
    configuration: 'Release',
    udid: 'X',
    derivedDataPath: '/dd',
  })
  assert.deepEqual(args, ['-configuration', 'Release', '-destination', 'platform=iOS Simulator,id=X', '-derivedDataPath', '/dd', 'build'])
})

test('resolveScheme prefers the explicit scheme, then the package manifest name', async () => {
  const root = tempDir()
  writeFileSync(join(root, 'Package.swift'), '// swift-tools-version:5.9\nlet package = Package(\n    name: "Demo",\n)\n')
  const target = { kind: 'package' as const, root, location: root }
  assert.equal(await resolveScheme(target, ' Explicit '), 'Explicit')
  assert.equal(await resolveScheme(target, undefined), 'Demo')
})

test('filterBuildOutput drops xcodebuild noise and keeps diagnostics', () => {
  const lines = [
    'CompileSwift normal arm64 /x.swift',
    '',
    '/x.swift:3:5: error: cannot find foo in scope',
    '    foo()',
    'note: Building targets in dependency order',
    '** BUILD FAILED **',
  ]
  assert.deepEqual(filterBuildOutput(lines), ['/x.swift:3:5: error: cannot find foo in scope', '    foo()', '** BUILD FAILED **'])
})

test('findBuiltApp picks the scheme-named .app under the simulator products', () => {
  const derived = tempDir()
  const products = join(derived, 'Build', 'Products', 'Debug-iphonesimulator')
  for (const name of ['Other.app', 'App.app']) {
    mkdirSync(join(products, name), { recursive: true })
    writeFileSync(join(products, name, 'Info.plist'), '')
  }
  assert.equal(findBuiltApp(derived, 'Debug', 'App'), join(products, 'App.app'))
  assert.equal(findBuiltApp(derived, 'Release', 'App'), undefined)
})

test('projectSlug is path-safe', () => {
  assert.equal(projectSlug('/x/My App.xcodeproj'), 'My_App')
})
```

- [ ] **Step 4: 运行测试和类型检查**

Run: `npm test && npm run typecheck`
Expected：build-run 的 7 个测试 PASS，typecheck 无错误。

- [ ] **Step 5: 提交**

```bash
git add src/build-run.ts test/build-run.test.ts
git commit -q -m "feat: port the xcodebuild build/install/launch pipeline (simulator only)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: 移植 `sim-host.ts`（serve-sim 生命周期）

**Files:**
- Create: `src/sim-host.ts`
- Test: `test/sim-host.test.ts`

**Interfaces:**
- Consumes：`bootDevice`（Task 2）、`SERVE_SIM_VERSION`、`serveSimBinOverride`（Task 1）
- Produces：`interface SimStreamInfo { url; streamUrl; wsUrl; port; device }`、`interface SimHostOptions { portRangeStart?; restartDelayMs?; idleTimeoutMs?; startTimeoutMs?; binary? }`、`interface SimHostStatus { available; running; device?; port?; startedAt?; restarts; lastError?; serveSimSource; serveSimCommand?; consumers; adopted?; stderr }`、`type ServeSimBinarySource`、`interface ServeSimBinary { available; source; command?; args; reason? }`、`interface ResolveServeSimOptions`、`resolveServeSimBinary(options?)`、`parseServeSimHandshake(line)`、`class SimHostController`：`binary`、`available`、`running`、`streamInfo`、`ensureRunning({ udid })`（会先 boot 设备）、`startKeepAlive()`、`stopKeepAlive()`、`stop()`、`restart(udid?)`、`status()`、`control(args, { timeoutMs? })`、`acquire(): () => void`、`dispose()`

- [ ] **Step 1: 复制源文件**

```bash
export DSH=/Users/elise123/Tools/Claude/Projects/dsh-ios/src
{ echo '// Ported from dsh-ios (MIT, © 2026 ZSeven—W) @ d9a9731 — src/sim-host.ts'; cat "$DSH/sim-host.ts"; } > src/sim-host.ts
sed -i '' -e 's#@zseven-w/dsh-ios/#ios-simulator/#g' -e 's/dsh-ios: /ios-simulator: /g' src/sim-host.ts
```

- [ ] **Step 2: 写失败的测试 `test/sim-host.test.ts`**

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseServeSimHandshake, resolveServeSimBinary, SimHostController } from '../src/sim-host.js'

test('resolveServeSimBinary refuses non-macOS and non-arm64 hosts', () => {
  assert.equal(resolveServeSimBinary({ platform: 'linux', arch: 'arm64' }).available, false)
  const intel = resolveServeSimBinary({ platform: 'darwin', arch: 'x64', override: undefined })
  assert.equal(intel.available, false)
  assert.match(intel.reason ?? '', /arm64/)
})

test('resolveServeSimBinary honours an executable IOS_SIM_SERVE_SIM_BIN', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ios-sim-bin-'))
  const bin = join(dir, 'serve-sim')
  writeFileSync(bin, '#!/bin/sh\n')
  chmodSync(bin, 0o755)
  assert.deepEqual(
    resolveServeSimBinary({ platform: 'darwin', arch: 'arm64', override: bin }),
    { available: true, source: 'package-bin', command: bin, args: [] },
  )
  const missing = resolveServeSimBinary({ platform: 'darwin', arch: 'arm64', override: join(dir, 'nope') })
  assert.equal(missing.available, false)
  assert.match(missing.reason ?? '', /IOS_SIM_SERVE_SIM_BIN/)
})

test('resolveServeSimBinary falls back to a pinned npx serve-sim', () => {
  assert.deepEqual(
    resolveServeSimBinary({ platform: 'darwin', arch: 'arm64', override: undefined, packageBin: () => undefined, findNpx: () => '/usr/local/bin/npx' }),
    { available: true, source: 'npx', command: '/usr/local/bin/npx', args: ['-y', 'serve-sim@0.1.47'] },
  )
})

test('resolveServeSimBinary finds the serve-sim installed in this repo', () => {
  const binary = resolveServeSimBinary({ platform: 'darwin', arch: 'arm64', override: undefined })
  assert.equal(binary.source, 'package-bin')
  assert.match(binary.command ?? '', /node_modules\/serve-sim\/dist\/serve-sim\.js$/)
})

test('parseServeSimHandshake validates the JSON handshake', () => {
  const info = parseServeSimHandshake(JSON.stringify({
    url: 'http://127.0.0.1:3181',
    streamUrl: 'http://127.0.0.1:3181/stream.mjpeg',
    wsUrl: 'ws://127.0.0.1:3181/ws',
    port: 3181,
    device: 'BBB',
  }))
  assert.equal(info.port, 3181)
  assert.equal(info.device, 'BBB')
  assert.throws(() => parseServeSimHandshake('not json'), /non-JSON/)
  assert.throws(() => parseServeSimHandshake(JSON.stringify({ url: 'http://x' })), /incomplete/)
})

test('SimHostController with an unavailable binary refuses control and counts consumers', async () => {
  const host = new SimHostController({ binary: { available: false, source: 'unavailable', args: [], reason: 'test' } })
  assert.equal(host.available, false)
  assert.equal(host.status().running, false)
  assert.equal(host.streamInfo, undefined)
  await assert.rejects(host.control(['tap', '0.5', '0.5']), /serve-sim is unavailable \(test\)/)
  const release = host.acquire()
  assert.equal(host.status().consumers, 1)
  release()
  release()
  assert.equal(host.status().consumers, 0)
  await host.dispose()
})
```

- [ ] **Step 3: 运行，确认失败**

Run: `npm test`
Expected: FAIL，`parseServeSimHandshake` 没有导出，`resolveServeSimBinary` 不接受选项。

- [ ] **Step 4: 修改 sim-host**

```bash
node - <<'EOF'
const fs = require('node:fs')
const file = 'src/sim-host.ts'
let text = fs.readFileSync(file, 'utf8')
function replaceExact(oldText, newText) {
  if (!text.includes(oldText)) throw new Error(`text not found: ${oldText.slice(0, 60)}`)
  text = text.replace(oldText, newText)
}
function replaceBetween(start, end, replacement) {
  const a = text.indexOf(start)
  const b = a < 0 ? -1 : text.indexOf(end, a)
  if (a < 0 || b < 0) throw new Error(`markers not found: ${start.slice(0, 60)}`)
  text = text.slice(0, a) + replacement + text.slice(b)
}
replaceExact("import { bootDevice } from './simctl.js'\n",
  "import { bootDevice } from './simctl.js'\nimport { SERVE_SIM_VERSION, serveSimBinOverride } from './config.js'\n")
replaceExact('  startTimeoutMs?: number\n}',
  '  startTimeoutMs?: number\n  /** Pre-resolved serve-sim launcher (tests); default resolveServeSimBinary(). */\n  binary?: ServeSimBinary\n}')
replaceExact('readonly #options: Required<SimHostOptions>', "readonly #options: Required<Omit<SimHostOptions, 'binary'>>")
replaceExact('this.binary = resolveServeSimBinary()', 'this.binary = options.binary ?? resolveServeSimBinary()')
replaceExact('function parseServeSimHandshake(', 'export function parseServeSimHandshake(')
replaceBetween('/**\n * Resolve how to launch serve-sim:', '/**\n * Parse the JSON handshake printed by', `/** Overrides for \`resolveServeSimBinary\` (tests); the defaults read this host. */
export interface ResolveServeSimOptions {
  platform?: NodeJS.Platform
  arch?: string
  /** Explicit binary path; defaults to \`IOS_SIM_SERVE_SIM_BIN\`. */
  override?: string | undefined
  packageBin?: () => string | undefined
  findNpx?: () => string | undefined
}

/**
 * Resolve how to launch serve-sim:
 * 1. \`IOS_SIM_SERVE_SIM_BIN\` when set (it must be an executable file);
 * 2. the locally installed package bin (\`serve-sim/package.json\` → bin);
 * 3. \`npx -y serve-sim@<pinned>\` when the package is not installed;
 * 4. an explicit \`available === false\` on non-macOS / non-arm64 hosts or
 *    when nothing resolves (serve-sim's helper is an arm64-only binary).
 */
export function resolveServeSimBinary(options: ResolveServeSimOptions = {}): ServeSimBinary {
  const platform = options.platform ?? process.platform
  if (platform !== 'darwin') {
    return { available: false, source: 'unavailable', args: [], reason: 'serve-sim only runs on macOS' }
  }
  const arch = options.arch ?? process.arch
  if (arch !== 'arm64') {
    return { available: false, source: 'unavailable', args: [], reason: \`serve-sim ships an arm64-only helper; this Mac is \${arch}\` }
  }
  const override = 'override' in options ? options.override : serveSimBinOverride()
  if (override !== undefined) {
    return isExecutableFile(override)
      ? { available: true, source: 'package-bin', command: override, args: [] }
      : { available: false, source: 'unavailable', args: [], reason: \`IOS_SIM_SERVE_SIM_BIN is not an executable file: \${override}\` }
  }
  const packageBin = (options.packageBin ?? tryResolvePackageBin)()
  if (packageBin !== undefined) {
    return { available: true, source: 'package-bin', command: packageBin, args: [] }
  }
  const npx = (options.findNpx ?? (() => findOnPath('npx')))()
  if (npx === undefined) {
    return { available: false, source: 'unavailable', args: [], reason: 'serve-sim is not installed and npx is not on PATH' }
  }
  return { available: true, source: 'npx', command: npx, args: ['-y', \`\${SERVE_SIM_PACKAGE}@\${SERVE_SIM_VERSION}\`] }
}

`)
fs.writeFileSync(file, text)
EOF
```

- [ ] **Step 5: 运行，确认通过**

Run: `npm test && npm run typecheck`
Expected：sim-host 的 6 个测试 PASS，typecheck 无错误。若 “finds the serve-sim installed in this repo” 失败且原因是文件不可执行，运行 `ls -l node_modules/serve-sim/dist/serve-sim.js` 确认 npm 设置了可执行位；没有的话 `npm rebuild serve-sim` 后重跑。

- [ ] **Step 6: 提交**

```bash
git add src/sim-host.ts test/sim-host.test.ts
git commit -q -m "feat: port the serve-sim stream host with an env override and pinned npx fallback

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 6: 移植 WS 手势通道、设备动作和 StreamSource

**Files:**
- Create: `src/sim-gesture.ts`、`src/device-actions.ts`、`src/stream-source.ts`（均从 dsh-ios 移植）
- Create: `test/helpers/png.ts`、`test/helpers/fakes.ts`
- Test: `test/sim-gesture.test.ts`、`test/device-actions.test.ts`、`test/stream-source.test.ts`

说明：dsh-ios 的 `app-switcher.ts` 只被真机的 `WdaStreamSource` 使用，所以推迟到第 ⑤ 期，本任务把对它的 import 一并删掉。

**Interfaces:**
- Produces（sim-gesture）：`SIM_TOUCH_TAG = 3`、`SIM_BUTTON_TAG = 4`、`SIM_GESTURE_STEP_MS = 16`、`SIM_SCROLL_STEPS = 18`、`SIM_GESTURE_BAND_MIN = 0.08`、`SIM_GESTURE_BAND_MAX = 0.92`、`interface SimGesturePoint { x; y }`、`encodeSimControlFrame(tag, payload): Buffer`、`encodeSimTouchFrame(type, x, y)`、`encodeSimButtonFrame(name)`、`interface SimScrollRequest { direction; amount; anchorX; anchorY; steps? }`、`simScrollPath(request)`、`interface SimDragRequest`、`simDragPath(request, stepMs?)`、`simDragRequestOf(payload)`、`interface SimGestureReport { frames; moves; elapsedMs; stepMs; wsUrl }`、`sendSimGesture(wsUrl, points, { stepMs?, connectTimeoutMs? })`
- Produces（device-actions）：`DEVICE_ACTIONS`（`'app-switcher' | 'lock' | 'unlock' | 'shake' | 'siri' | 'action-button' | 're-center'`）、`type DeviceAction`、`isDeviceAction(value: unknown)`、`deviceActionSpec(action)`、`deviceActionFailureHint(message)`、`simulatorMenuItemScript(item)`、`runSimulatorDeviceAction(action, pressButton, timeoutMs?)`
- Produces（stream-source）：`type StreamSourceKind`、`interface StreamControl { tap; drag; button; type; rotate?; deviceAction?; screenshot; uiTree? }`、`interface StreamSource`、`type SimStreamHost = Pick<SimHostController, 'ensureRunning' | 'status' | 'stop' | 'acquire' | 'control'>`、`class SimStreamSource(host: SimStreamHost)`、`pngDimensionsFromBase64(base64)`
- Produces（测试工具）：`tinyPng(width, height): Buffer`；`type FakeHost`、`interface FakeHostOptions { available?; device?; baseUrl?; wsUrl?; exposeStreamInfo? }`、`fakeHost(options?): { host; calls: string[][]; consumers(): number }`

- [ ] **Step 1: 复制三个文件并改名**

```bash
export DSH=/Users/elise123/Tools/Claude/Projects/dsh-ios/src
for f in sim-gesture device-actions stream-source; do
  { echo "// Ported from dsh-ios (MIT, © 2026 ZSeven—W) @ d9a9731 — src/$f.ts"; cat "$DSH/$f.ts"; } > "src/$f.ts"
  sed -i '' -e 's#@zseven-w/dsh-ios/#ios-simulator/#g' -e 's/dsh-ios: /ios-simulator: /g' -e 's/dsh-ios-stream-/ios-simulator-stream-/g' "src/$f.ts"
done
sed -i '' 's#then enable the app running DSH (Terminal / iTerm / your editor)#then enable the app running Claude Code (Terminal / iTerm / the Claude app)#' src/device-actions.ts
grep -c "running Claude Code" src/device-actions.ts
```

Expected：最后一行输出 `1`。

- [ ] **Step 2: 改 sim-gesture（静态 import ws）与 stream-source（去掉真机适配器）**

```bash
node - <<'EOF'
const fs = require('node:fs')
function edit(file, fn) { let text = fs.readFileSync(file, 'utf8'); text = fn(text); fs.writeFileSync(file, text) }
function replaceExact(text, oldText, newText) {
  if (!text.includes(oldText)) throw new Error(`text not found: ${oldText.slice(0, 60)}`)
  return text.replace(oldText, newText)
}
function replaceBetween(text, start, end, replacement) {
  const a = text.indexOf(start)
  const b = a < 0 ? -1 : text.indexOf(end, a)
  if (a < 0 || b < 0) throw new Error(`markers not found: ${start.slice(0, 60)}`)
  return text.slice(0, a) + replacement + text.slice(b)
}
edit('src/sim-gesture.ts', text => {
  text = replaceExact(text, "import { createRequire } from 'node:module'\n", "import { WebSocket as WsWebSocket } from 'ws'\n")
  return replaceBetween(text, 'const requireWs = createRequire(import.meta.url)', 'function errorMessage(error: unknown): string {', `/**
 * The \`ws\` client, imported statically so esbuild can bundle it (dsh-ios
 * loaded it lazily through createRequire, which a bundle cannot follow).
 */
function loadWs(): SimWsModuleLike {
  return { WebSocket: WsWebSocket as unknown as SimWsModuleLike['WebSocket'] }
}

`)
})
edit('src/stream-source.ts', text => {
  text = replaceExact(text, `import {
  APP_SWITCHER_DRAG_DURATION_S,
  APP_SWITCHER_FROM_Y,
  APP_SWITCHER_TO_Y,
} from './app-switcher.js'
`, '')
  text = replaceExact(text, "import type { SimHostController, SimStreamInfo } from './sim-host.js'\n",
    "import type { SimHostController, SimStreamInfo } from './sim-host.js'\n\n/** The slice of SimHostController this adapter uses (structural, so tests can fake it). */\nexport type SimStreamHost = Pick<SimHostController, 'ensureRunning' | 'status' | 'stop' | 'acquire' | 'control'>\n")
  text = replaceExact(text, 'constructor(private readonly host: SimHostController) {}', 'constructor(private readonly host: SimStreamHost) {}')
  // WdaControllerLike + WdaStreamSource are the real-device adapter (phase 5).
  const marker = text.indexOf(' * Structural view of `WdaController`')
  if (marker < 0) throw new Error('WdaControllerLike marker not found')
  const commentStart = text.lastIndexOf('/**', marker)
  return text.slice(0, commentStart).trimEnd() + '\n'
})
EOF
grep -n "Wda\|app-switcher\|createRequire" src/stream-source.ts src/sim-gesture.ts | grep -v "^\S*:\s*\*" || echo "clean"
```

Expected：打印 `clean`，或者只剩模块注释里提到 `WdaStreamSource` 的行。

- [ ] **Step 3: 写测试工具 `test/helpers/png.ts`**

```ts
import { deflateSync } from 'node:zlib'

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buffer: Buffer): number {
  let c = 0xffffffff
  for (const byte of buffer) c = (CRC_TABLE[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

/** A solid grey RGB PNG — valid for sips and for IHDR readers. */
export function tinyPng(width: number, height: number): Buffer {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8 // bit depth
  header[9] = 2 // colour type: RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x80)])
  const raw = Buffer.concat(Array.from({ length: height }, () => row))
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
```

- [ ] **Step 4: 写测试工具 `test/helpers/fakes.ts`**（Task 9、10 会在这个文件里继续追加）

```ts
/**
 * Test doubles for the host-facing seams: a serve-sim host here, plus a
 * recordVideo spawner (Task 9) and a simctl API (Task 10) appended later.
 */
import type { SimHostController, SimHostStatus, SimStreamInfo } from '../../src/sim-host.js'

/** The public slice of SimHostController that the tools and the panel use. */
export type FakeHost = Pick<SimHostController, 'binary' | 'streamInfo' | 'status' | 'ensureRunning' | 'stop' | 'acquire' | 'control'>

export interface FakeHostOptions {
  /** serve-sim resolvable (default true). */
  available?: boolean
  /** Device currently streamed; undefined means no stream. */
  device?: string
  /** Base URL of the (fake) serve-sim HTTP server (default http://127.0.0.1:3181). */
  baseUrl?: string
  /** Control-socket URL in the handshake (default: baseUrl with ws://). */
  wsUrl?: string
  /** Expose the live handshake through `streamInfo` (default false → CLI fallback). */
  exposeStreamInfo?: boolean
}

export interface FakeHostHandle {
  host: FakeHost
  calls: string[][]
  consumers(): number
}

export function fakeHost(options: FakeHostOptions = {}): FakeHostHandle {
  const calls: string[][] = []
  const available = options.available ?? true
  const baseUrl = options.baseUrl ?? 'http://127.0.0.1:3181'
  const port = Number(new URL(baseUrl).port)
  let device = options.device
  let consumers = 0
  const infoFor = (udid: string): SimStreamInfo => ({
    url: baseUrl,
    streamUrl: `${baseUrl}/stream.mjpeg`,
    wsUrl: options.wsUrl ?? baseUrl.replace(/^http/u, 'ws'),
    port,
    device: udid,
  })
  const host: FakeHost = {
    binary: available
      ? { available: true, source: 'package-bin', command: '/fake/serve-sim', args: [] }
      : { available: false, source: 'unavailable', args: [], reason: 'test: serve-sim unavailable' },
    get streamInfo() {
      return options.exposeStreamInfo === true && device !== undefined ? infoFor(device) : undefined
    },
    status(): SimHostStatus {
      return {
        available,
        running: device !== undefined,
        ...(device === undefined ? {} : { device, port }),
        restarts: 0,
        serveSimSource: available ? 'package-bin' : 'unavailable',
        consumers,
        stderr: [],
      }
    },
    async ensureRunning({ udid }) {
      calls.push(['ensureRunning', udid])
      device = udid
      return infoFor(udid)
    },
    async stop() {
      calls.push(['stop'])
      device = undefined
    },
    acquire() {
      consumers += 1
      let released = false
      return () => {
        if (released) return
        released = true
        consumers -= 1
      }
    },
    async control(args) {
      calls.push(['control', ...args])
      return { stdout: '', stderr: '' }
    },
  }
  return { host, calls, consumers: () => consumers }
}
```

- [ ] **Step 5: 写测试 `test/sim-gesture.test.ts`**

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WebSocketServer } from 'ws'
import {
  encodeSimButtonFrame,
  encodeSimTouchFrame,
  sendSimGesture,
  simDragPath,
  simDragRequestOf,
  simScrollPath,
  SIM_GESTURE_BAND_MAX,
  SIM_GESTURE_BAND_MIN,
} from '../src/sim-gesture.js'

test('touch and button frames are [tag][json] with clamped coordinates', () => {
  const touch = encodeSimTouchFrame('begin', 1.5, -0.2)
  assert.equal(touch[0], 3)
  assert.deepEqual(JSON.parse(touch.subarray(1).toString('utf8')), { type: 'begin', x: 1, y: 0 })
  const button = encodeSimButtonFrame('home')
  assert.equal(button[0], 4)
  assert.deepEqual(JSON.parse(button.subarray(1).toString('utf8')), { button: 'home' })
})

test('scroll "down" moves the finger up and never leaves the 8–92% band', () => {
  const path = simScrollPath({ direction: 'down', amount: 0.9, anchorX: 0.5, anchorY: 0.99 })
  assert.equal(path.length, 19)
  assert.ok((path[0]?.y ?? 0) > (path[path.length - 1]?.y ?? 1))
  for (const point of path) {
    assert.ok(point.y >= SIM_GESTURE_BAND_MIN && point.y <= SIM_GESTURE_BAND_MAX)
    assert.equal(point.x, 0.5)
  }
})

test('a drag duration sets the number of 16 ms frames; raw frames are not drags', () => {
  assert.equal(simDragPath({ fromX: 0.1, fromY: 0.5, toX: 0.9, toY: 0.5, duration: 0.3 }).length, 20)
  assert.equal(simDragRequestOf({ type: 'begin', x: 0.5, y: 0.5 }), undefined)
  assert.deepEqual(simDragRequestOf({ fromX: 0.1, fromY: 0.2, toX: 0.3, toY: 0.4 }), { fromX: 0.1, fromY: 0.2, toX: 0.3, toY: 0.4 })
})

test('sendSimGesture writes begin, moves and end over one socket', async () => {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise<void>(resolve => wss.once('listening', () => resolve()))
  const port = (wss.address() as { port: number }).port
  const frames: Array<{ type: string }> = []
  wss.on('connection', socket => socket.on('message', data => {
    const bytes = data as Buffer
    frames.push(JSON.parse(bytes.subarray(1).toString('utf8')) as { type: string })
  }))
  const report = await sendSimGesture(`ws://127.0.0.1:${port}`, [{ x: 0.5, y: 0.8 }, { x: 0.5, y: 0.5 }, { x: 0.5, y: 0.2 }], { stepMs: 0 })
  await new Promise(resolve => setTimeout(resolve, 50))
  wss.close()
  assert.equal(report.frames, 4)
  assert.deepEqual(frames.map(frame => frame.type), ['begin', 'move', 'move', 'end'])
})

test('sendSimGesture rejects without a control-socket url', async () => {
  await assert.rejects(sendSimGesture('', [{ x: 0, y: 0 }, { x: 1, y: 1 }]), /gesture channel/)
})
```

- [ ] **Step 6: 写测试 `test/device-actions.test.ts`**

```ts
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
```

- [ ] **Step 7: 写测试 `test/stream-source.test.ts`**

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pngDimensionsFromBase64, SimStreamSource } from '../src/stream-source.js'
import { fakeHost } from './helpers/fakes.js'
import { tinyPng } from './helpers/png.js'

test('SimStreamSource routes control through serve-sim for the streamed device', async () => {
  const { host, calls } = fakeHost({ device: 'BBB' })
  const source = new SimStreamSource(host)
  await source.control.tap(0.25, 0.75)
  await source.control.button()
  await source.control.rotate?.('landscape_left')
  await source.control.deviceAction?.('lock')
  assert.deepEqual(calls.filter(call => call[0] === 'control'), [
    ['control', 'tap', '0.25', '0.75', '-d', 'BBB'],
    ['control', 'button', 'home', '-d', 'BBB'],
    ['control', 'rotate', 'landscape_left', '-d', 'BBB'],
    ['control', 'button', 'lock', '-d', 'BBB'],
  ])
  await assert.rejects(source.control.tap(2, 0), /normalized 0\.\.1/)
})

test('pngDimensionsFromBase64 reads the IHDR size', () => {
  assert.deepEqual(pngDimensionsFromBase64(tinyPng(3, 7).toString('base64')), { width: 3, height: 7 })
})
```

- [ ] **Step 8: 运行测试和类型检查**

Run: `npm test && npm run typecheck`
Expected：新增 9 个测试全部 PASS；typecheck 无错误。

- [ ] **Step 9: 提交**

```bash
git add src/sim-gesture.ts src/device-actions.ts src/stream-source.ts test/helpers test/sim-gesture.test.ts test/device-actions.test.ts test/stream-source.test.ts
git commit -q -m "feat: port the WS gesture channel, device actions and the StreamSource adapter

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: interact 参数映射与投递（从 tools.ts 移植）

**Files:**
- Create: `src/interact.ts`
- Test: `test/interact.test.ts`

**Interfaces:**
- Consumes：`sendSimGesture`、`simDragPath`、`simDragRequestOf`、`simScrollPath`、`SIM_GESTURE_STEP_MS`、`SimGesturePoint`、`SimScrollRequest`（Task 6）、`SimStreamInfo`（Task 5）
- Produces：`type SimInteractAction = 'tap' | 'type' | 'button' | 'gesture' | 'scroll'`、`interface SimInteractArgs { action; x?; y?; text?; name?; json?: unknown; direction?; amount? }`、`scrollRequestOf(args)`、`interactControlArgs(args): string[][]`、`interface SimGestureHostLike { streamInfo?; control(args, options?) }`、`type SimGestureChannel = 'ws' | 'cli'`、`interface SimInteractDelivery { channel; frames?; elapsedMs?; wsError? }`、`simInteractGesturePath(args)`、`performSimInteract(host, udid, args, payloads, { stepMs? }?): Promise<SimInteractDelivery>`

- [ ] **Step 1: 写失败的测试 `test/interact.test.ts`**

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WebSocketServer } from 'ws'
import { interactControlArgs, performSimInteract, scrollRequestOf, type SimInteractArgs } from '../src/interact.js'
import { fakeHost } from './helpers/fakes.js'

test('interactControlArgs maps each action to serve-sim CLI arguments', () => {
  assert.deepEqual(interactControlArgs({ action: 'tap', x: 0.1, y: 0.2 }), [['tap', '0.1', '0.2']])
  assert.deepEqual(interactControlArgs({ action: 'type', text: 'hello' }), [['type', 'hello']])
  assert.deepEqual(interactControlArgs({ action: 'button', name: ' home ' }), [['button', 'home']])
  assert.deepEqual(
    interactControlArgs({ action: 'gesture', json: { type: 'begin', x: 0.5, y: 0.5 } }),
    [['gesture', '{"type":"begin","x":0.5,"y":0.5}']],
  )
  assert.equal(interactControlArgs({ action: 'scroll', direction: 'down' }).length, 3)
})

test('interactControlArgs rejects bad input with actionable errors', () => {
  assert.throws(() => interactControlArgs({ action: 'tap', x: 0.5 }), /requires numeric x and y/)
  assert.throws(() => interactControlArgs({ action: 'type', text: '你好' }), /US-keyboard ASCII/)
  assert.throws(() => interactControlArgs({ action: 'scroll' }), /requires direction/)
  assert.throws(() => scrollRequestOf({ action: 'scroll', direction: 'up', amount: 2 }), /amount/)
})

test('performSimInteract falls back to the CLI when no control socket is known', async () => {
  const { host, calls } = fakeHost({ device: 'BBB' })
  const args: SimInteractArgs = { action: 'scroll', direction: 'down' }
  const delivery = await performSimInteract(host, 'BBB', args, interactControlArgs(args))
  assert.equal(delivery.channel, 'cli')
  assert.match(delivery.wsError ?? '', /control-socket url/)
  assert.deepEqual(calls.map(call => call[1]), ['gesture', 'gesture', 'gesture'])
})

test('performSimInteract traces a scroll over the stream socket when it is live', async () => {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise<void>(resolve => wss.once('listening', () => resolve()))
  const port = (wss.address() as { port: number }).port
  let received = 0
  wss.on('connection', socket => socket.on('message', () => { received += 1 }))
  const { host, calls } = fakeHost({ device: 'BBB', wsUrl: `ws://127.0.0.1:${port}`, exposeStreamInfo: true })
  const args: SimInteractArgs = { action: 'scroll', direction: 'up' }
  const delivery = await performSimInteract(host, 'BBB', args, interactControlArgs(args), { stepMs: 0 })
  await new Promise(resolve => setTimeout(resolve, 50))
  wss.close()
  assert.equal(delivery.channel, 'ws')
  assert.equal(delivery.frames, 20)
  assert.equal(received, 20)
  assert.deepEqual(calls, [])
})
```

- [ ] **Step 2: 运行，确认失败**

Run: `npm test`
Expected: FAIL，`Cannot find module '.../src/interact.js'`。

- [ ] **Step 3: 写 `src/interact.ts`**

```ts
// Ported from dsh-ios (MIT, © 2026 ZSeven—W) @ d9a9731 — src/tools.ts (interaction mapping)
/**
 * Maps one `ios_sim_interact` call onto serve-sim input: CLI argument vectors
 * for single events, and the stream's WebSocket control channel for
 * multi-event gestures (sim-gesture.ts), with the CLI as the fallback.
 * @module ios-simulator/interact
 */

import type { SimStreamInfo } from './sim-host.js'
import {
  sendSimGesture,
  simDragPath,
  simDragRequestOf,
  simScrollPath,
  SIM_GESTURE_STEP_MS,
  type SimGesturePoint,
  type SimScrollRequest,
} from './sim-gesture.js'

/** The serve-sim input actions (rotate / device_action are handled by the tool). */
export type SimInteractAction = 'tap' | 'type' | 'button' | 'gesture' | 'scroll'

export interface SimInteractArgs {
  action: SimInteractAction
  x?: number
  y?: number
  text?: string
  name?: string
  json?: unknown
  /** Scroll direction, named by the CONTENT ("down" reveals content further down). */
  direction?: 'up' | 'down' | 'left' | 'right'
  /** Fraction of the screen a scroll travels, 0..1 (default 0.6). */
  amount?: number
}

/**
 * Hold between the begin→move and move→end frames of the CLI FALLBACK path.
 * One serve-sim process per touch event measured 2.05 s for a 7-event scroll,
 * which iOS reads as press-and-drag; the WS channel is the default.
 */
const SCROLL_HOLD_MS = 175

const SCROLL_DIRECTIONS = ['up', 'down', 'left', 'right'] as const

/** serve-sim types through the US keyboard layout only. */
const US_KEYBOARD_TEXT = /^[\x20-\x7E\t\n]+$/u

function sleep(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Validate scroll args into the pure geometry request `simScrollPath` traces. */
export function scrollRequestOf(args: SimInteractArgs): SimScrollRequest {
  const direction = args.direction
  if (direction === undefined || !(SCROLL_DIRECTIONS as readonly string[]).includes(direction)) {
    throw new Error(
      'ios_sim_interact: action "scroll" requires direction "up", "down", "left" or "right"'
      + ` (got ${direction === undefined ? 'nothing' : JSON.stringify(direction)})`,
    )
  }
  const amount = args.amount ?? 0.6
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0 || amount > 1) {
    throw new Error(`ios_sim_interact: scroll amount must be a number within 0..1, got ${String(amount)}`)
  }
  const anchorX = typeof args.x === 'number' && Number.isFinite(args.x) ? args.x : 0.5
  const anchorY = typeof args.y === 'number' && Number.isFinite(args.y) ? args.y : 0.5
  if (anchorX < 0 || anchorX > 1 || anchorY < 0 || anchorY > 1) {
    throw new Error(`ios_sim_interact: scroll anchor x/y must be within 0..1, got x=${String(args.x)} y=${String(args.y)}`)
  }
  return { direction, amount, anchorX, anchorY }
}

/** One scroll's finger path endpoints in normalized 0..1 coordinates. */
interface ScrollPath {
  fromX: number
  fromY: number
  toX: number
  toY: number
}

/** The endpoints of the traced scroll (the CLI fallback consumes those). */
function scrollArgs(args: SimInteractArgs): ScrollPath {
  const points = simScrollPath(scrollRequestOf(args))
  const from = points[0]
  const to = points[points.length - 1]
  if (from === undefined || to === undefined) throw new Error('ios_sim_interact: the scroll path is empty')
  return { fromX: from.x, fromY: from.y, toX: to.x, toY: to.y }
}

/** CLI fallback for a path: begin → move → end, one `serve-sim gesture` each. */
function dragFramePayloads(path: ScrollPath): string[][] {
  return [
    ['gesture', JSON.stringify({ type: 'begin', x: path.fromX, y: path.fromY })],
    ['gesture', JSON.stringify({ type: 'move', x: path.toX, y: path.toY })],
    ['gesture', JSON.stringify({ type: 'end', x: path.toX, y: path.toY })],
  ]
}

/** Map a validated interact call to serve-sim CLI argument vectors. */
export function interactControlArgs(args: SimInteractArgs): string[][] {
  switch (args.action) {
    case 'tap': {
      if (typeof args.x !== 'number' || typeof args.y !== 'number' || !Number.isFinite(args.x) || !Number.isFinite(args.y)) {
        throw new Error('ios_sim_interact: action "tap" requires numeric x and y (normalized 0..1)')
      }
      if (args.x < 0 || args.x > 1 || args.y < 0 || args.y > 1) {
        throw new Error(`ios_sim_interact: tap x/y must be within 0..1, got x=${args.x} y=${args.y}`)
      }
      return [['tap', String(args.x), String(args.y)]]
    }
    case 'type': {
      if (typeof args.text !== 'string' || args.text === '') {
        throw new Error('ios_sim_interact: action "type" requires a non-empty text')
      }
      if (!US_KEYBOARD_TEXT.test(args.text)) {
        throw new Error(
          'ios_sim_interact: action "type" only supports US-keyboard ASCII text — for Chinese, emoji or other '
          + 'characters copy the text to the simulator pasteboard (printf "%s" "<text>" | xcrun simctl pbcopy <udid>) '
          + 'and paste it (long-press the field, then Paste)',
        )
      }
      return [['type', args.text]]
    }
    case 'button': {
      if (typeof args.name !== 'string' || args.name.trim() === '') {
        throw new Error('ios_sim_interact: action "button" requires a button name, e.g. "home"')
      }
      return [['button', args.name.trim()]]
    }
    case 'gesture': {
      if (typeof args.json !== 'object' || args.json === null || Array.isArray(args.json)) {
        throw new Error('ios_sim_interact: action "gesture" requires a json object, e.g. {"type":"begin","x":0.5,"y":0.5}')
      }
      // A normalized {fromX,fromY,toX,toY} payload is a PATH the CLI cannot
      // express: fall back to begin → move → end. A {type,x,y} frame is one event.
      const drag = simDragRequestOf(args.json)
      if (drag !== undefined) {
        return dragFramePayloads({ fromX: drag.fromX, fromY: drag.fromY, toX: drag.toX, toY: drag.toY })
      }
      return [['gesture', JSON.stringify(args.json)]]
    }
    case 'scroll':
      return dragFramePayloads(scrollArgs(args))
  }
}

/** What the gesture router needs from the sim host (SimHostController fits). */
export interface SimGestureHostLike {
  /** Live stream handshake — undefined when nothing is streaming. */
  readonly streamInfo?: SimStreamInfo | undefined
  control(args: readonly string[], options?: { timeoutMs?: number }): Promise<{ stdout: string; stderr: string }>
}

async function performSimInteractControl(host: SimGestureHostLike, deviceUdid: string, payloads: string[][]): Promise<void> {
  for (const payload of payloads) {
    const [command, ...rest] = payload
    if (command === undefined) continue
    await host.control([command, '-d', deviceUdid, ...rest])
    // Dwelling between frames is what makes serve-sim register a drag
    // instead of three independent touches.
    if (payloads.length > 1 && payload !== payloads[payloads.length - 1]) {
      await sleep(SCROLL_HOLD_MS)
    }
  }
}

/** Which channel actually carried one simulator interaction. */
export type SimGestureChannel = 'ws' | 'cli'

/** How one simulator interaction was delivered (diagnostics). */
export interface SimInteractDelivery {
  channel: SimGestureChannel
  /** Frames written when the WS channel carried it (1 begin + moves + 1 end). */
  frames?: number
  /** Measured wall time of the traced gesture, ms. */
  elapsedMs?: number
  /** Why the WS channel was skipped or refused; the CLI carried it instead. */
  wsError?: string
}

/** The traced finger path of a multi-event interaction, else undefined. */
export function simInteractGesturePath(args: SimInteractArgs): SimGesturePoint[] | undefined {
  if (args.action === 'scroll') return simScrollPath(scrollRequestOf(args))
  if (args.action === 'gesture') {
    const drag = simDragRequestOf(args.json)
    return drag === undefined ? undefined : simDragPath(drag)
  }
  return undefined
}

/**
 * Deliver one simulator interaction. Multi-event gestures go over serve-sim's
 * WebSocket control channel (~16 ms per frame, which iOS reads as a real
 * flick); the CLI is the fallback when no live stream reports a control
 * socket for this device or the socket refuses. Single events use the CLI.
 */
export async function performSimInteract(
  host: SimGestureHostLike,
  deviceUdid: string,
  args: SimInteractArgs,
  payloads: string[][],
  options: { stepMs?: number } = {},
): Promise<SimInteractDelivery> {
  const points = simInteractGesturePath(args)
  const info = host.streamInfo
  // The control socket belongs to the ONE streamed device; never send this
  // device's gesture to a socket that streams another one.
  const wsUrl = info !== undefined && info.device === deviceUdid && typeof info.wsUrl === 'string'
    ? info.wsUrl
    : undefined
  let wsError: string | undefined
  if (points !== undefined) {
    if (wsUrl === undefined) {
      wsError = `no live serve-sim stream reports a control-socket url for ${deviceUdid} `
        + '— the gesture went through the serve-sim CLI instead (one process per touch event)'
    } else {
      try {
        const report = await sendSimGesture(wsUrl, points, { stepMs: options.stepMs ?? SIM_GESTURE_STEP_MS })
        return { channel: 'ws', frames: report.frames, elapsedMs: report.elapsedMs }
      } catch (error) {
        wsError = errorMessage(error)
      }
    }
  }
  await performSimInteractControl(host, deviceUdid, payloads)
  return { channel: 'cli', ...(wsError === undefined ? {} : { wsError }) }
}
```

- [ ] **Step 4: 运行测试和类型检查**

Run: `npm test && npm run typecheck`
Expected：interact 的 4 个测试 PASS；typecheck 无错误。

- [ ] **Step 5: 提交**

```bash
git add src/interact.ts test/interact.test.ts
git commit -q -m "feat: port the interact mapping with the WS gesture path and CLI fallback

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 8: 截图缓存与给模型的 JPEG

**Files:**
- Create: `src/screenshot.ts`
- Test: `test/screenshot.test.ts`

**Interfaces:**
- Consumes：`SCREENSHOT_KEEP`、`MODEL_IMAGE_MAX_EDGE`、`MODEL_IMAGE_JPEG_QUALITY`（Task 1）
- Produces：`interface ScreenshotCapture { path; bytes; width?; height? }`、`interface ModelImage { data: string /* base64 */; mimeType: 'image/jpeg'; width; height }`、`interface ScreenshotStoreOptions { dir; takeScreenshot(udid, path, signal?); keep?; maxEdge?; quality? }`、`isScreenshotFileName(name)`、`readPngSize(path)`、`jpegSize(buffer)`、`class ScreenshotStore { dir; nextPath(udid); capture(udid, signal?); prune(); toModelImage(capture) }`

- [ ] **Step 1: 写失败的测试 `test/screenshot.test.ts`**

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isScreenshotFileName, jpegSize, readPngSize, ScreenshotStore } from '../src/screenshot.js'
import { tinyPng } from './helpers/png.js'

function newStore(keep = 100, size: [number, number] = [1206, 2622]): { store: ScreenshotStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'ios-sim-shots-'))
  const store = new ScreenshotStore({
    dir,
    keep,
    takeScreenshot: async (_udid, path) => { writeFileSync(path, tinyPng(size[0], size[1])) },
  })
  return { store, dir }
}

test('capture writes numbered PNGs per device and reports their size', async () => {
  const { store } = newStore()
  const first = await store.capture('BBB-1')
  const second = await store.capture('BBB-1')
  assert.match(first.path, /screenshot-BBB-1-0\.png$/)
  assert.match(second.path, /screenshot-BBB-1-1\.png$/)
  assert.deepEqual({ width: first.width, height: first.height }, { width: 1206, height: 2622 })
  assert.ok(first.bytes > 0)
})

test('capture prunes the oldest screenshots beyond the keep limit', async () => {
  const { store, dir } = newStore(3)
  for (let index = 0; index < 5; index += 1) await store.capture('X')
  assert.deepEqual(readdirSync(dir).filter(isScreenshotFileName).sort(), [
    'screenshot-X-2.png',
    'screenshot-X-3.png',
    'screenshot-X-4.png',
  ])
})

test('toModelImage returns a JPEG whose long edge is at most 1024 and cleans up', async () => {
  const { store } = newStore()
  const shot = await store.capture('Y')
  const image = await store.toModelImage(shot)
  assert.equal(image.mimeType, 'image/jpeg')
  assert.deepEqual({ width: image.width, height: image.height }, { width: 471, height: 1024 })
  assert.deepEqual(jpegSize(Buffer.from(image.data, 'base64')), { width: 471, height: 1024 })
  assert.equal(existsSync(shot.path.replace(/\.png$/u, '.model.jpg')), false)
})

test('toModelImage keeps small screenshots at their own size', async () => {
  const { store } = newStore(100, [300, 400])
  const image = await store.toModelImage(await store.capture('W'))
  assert.deepEqual({ width: image.width, height: image.height }, { width: 300, height: 400 })
})

test('readPngSize reads IHDR and isScreenshotFileName only accepts cache names', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ios-sim-png-'))
  const path = join(dir, 'a.png')
  writeFileSync(path, tinyPng(5, 9))
  assert.deepEqual(readPngSize(path), { width: 5, height: 9 })
  assert.equal(isScreenshotFileName('screenshot-ABC-12.png'), true)
  for (const bad of ['../x.png', 'screenshot-A-1.png/..', 'screenshot-A-1.jpg', 'x.png', 'screenshot-../a-1.png']) {
    assert.equal(isScreenshotFileName(bad), false, bad)
  }
})
```

- [ ] **Step 2: 运行，确认失败**

Run: `npm test`
Expected: FAIL，`Cannot find module '.../src/screenshot.js'`。

- [ ] **Step 3: 写 `src/screenshot.ts`**

```ts
/**
 * Screenshot cache shared by the tools and the panel: numbered full-size PNGs
 * per device (the ScreenshotStore naming is ported from dsh-ios src/tools.ts),
 * pruned to the newest N, plus the downscaled JPEG handed to the model.
 * @module ios-simulator/screenshot
 */

import { execFile } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { MODEL_IMAGE_JPEG_QUALITY, MODEL_IMAGE_MAX_EDGE, SCREENSHOT_KEEP } from './config.js'

export interface ScreenshotCapture {
  path: string
  bytes: number
  width?: number
  height?: number
}

export interface ModelImage {
  /** Base64 JPEG bytes. */
  data: string
  mimeType: 'image/jpeg'
  width: number
  height: number
}

export interface ScreenshotStoreOptions {
  dir: string
  takeScreenshot(udid: string, path: string, signal?: AbortSignal): Promise<void>
  keep?: number
  maxEdge?: number
  quality?: number
}

const FILE_PATTERN = /^screenshot-[A-Za-z0-9_-]+-(\d+)\.png$/u
const SIPS_TIMEOUT_MS = 30_000

/** True for the names this store writes (the panel serves nothing else). */
export function isScreenshotFileName(name: string): boolean {
  return FILE_PATTERN.test(name)
}

/** Read PNG dimensions from the IHDR chunk (best effort, 24-byte header). */
export function readPngSize(path: string): { width: number; height: number } | undefined {
  try {
    const fd = openSync(path, 'r')
    try {
      const header = Buffer.alloc(24)
      if (readSync(fd, header, 0, 24, 0) !== 24) return undefined
      const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      const isPng = header.subarray(0, 8).equals(pngSignature)
      const isIhdr = header.subarray(12, 16).toString('ascii') === 'IHDR'
      if (!isPng || !isIhdr) return undefined
      return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) }
    } finally {
      closeSync(fd)
    }
  } catch {
    return undefined
  }
}

/** Pixel size of a JPEG from its SOF marker, without decoding. */
export function jpegSize(buffer: Buffer): { width: number; height: number } | undefined {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return undefined
  let offset = 2
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1
      continue
    }
    const marker = buffer[offset + 1] ?? 0
    if (marker === 0xff || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      offset += marker === 0xff ? 1 : 2
      continue
    }
    const length = buffer.readUInt16BE(offset + 2)
    const isStartOfFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (isStartOfFrame) {
      return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) }
    }
    offset += 2 + length
  }
  return undefined
}

function runSips(args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('sips', [...args], { timeout: SIPS_TIMEOUT_MS }, (error, _stdout, stderr) => {
      if (error === null) {
        resolve()
        return
      }
      reject(new Error(`sips failed: ${stderr.trim() === '' ? error.message : stderr.trim()}`))
    })
  })
}

export class ScreenshotStore {
  readonly dir: string
  readonly #take: ScreenshotStoreOptions['takeScreenshot']
  readonly #keep: number
  readonly #maxEdge: number
  readonly #quality: number
  readonly #next = new Map<string, number>()

  constructor(options: ScreenshotStoreOptions) {
    this.dir = options.dir
    this.#take = options.takeScreenshot
    this.#keep = options.keep ?? SCREENSHOT_KEEP
    this.#maxEdge = options.maxEdge ?? MODEL_IMAGE_MAX_EDGE
    this.#quality = options.quality ?? MODEL_IMAGE_JPEG_QUALITY
  }

  /**
   * `<dir>/screenshot-<udid>-<n>.png` with a monotonically increasing index;
   * names already on disk are skipped so concurrent writers never collide.
   */
  nextPath(udid: string): string {
    mkdirSync(this.dir, { recursive: true })
    const safe = udid.replace(/[^A-Za-z0-9_-]/g, '_')
    let next = this.#next.get(safe)
    if (next === undefined) {
      next = 0
      const prefix = `screenshot-${safe}-`
      for (const entry of readdirSync(this.dir)) {
        if (!entry.startsWith(prefix) || !entry.endsWith('.png')) continue
        const index = Number(entry.slice(prefix.length, -4))
        if (Number.isInteger(index) && index >= next) next = index + 1
      }
    }
    let path = join(this.dir, `screenshot-${safe}-${next}.png`)
    while (existsSync(path)) {
      next += 1
      path = join(this.dir, `screenshot-${safe}-${next}.png`)
    }
    this.#next.set(safe, next + 1)
    return path
  }

  /** Capture a fresh full-size PNG, then prune the cache. */
  async capture(udid: string, signal?: AbortSignal): Promise<ScreenshotCapture> {
    const path = this.nextPath(udid)
    await this.#take(udid, path, signal)
    const bytes = statSync(path).size
    const size = readPngSize(path)
    this.prune()
    return { path, bytes, ...(size === undefined ? {} : size) }
  }

  /** Keep the newest `keep` screenshots (by mtime, then index). */
  prune(): void {
    let names: string[]
    try {
      names = readdirSync(this.dir).filter(isScreenshotFileName)
    } catch {
      return
    }
    if (names.length <= this.#keep) return
    const entries = names.map(name => {
      const path = join(this.dir, name)
      let mtime = 0
      try {
        mtime = statSync(path).mtimeMs
      } catch {
        // vanished between readdir and stat
      }
      return { path, mtime, index: Number(FILE_PATTERN.exec(name)?.[1] ?? 0) }
    })
    entries.sort((a, b) => (b.mtime - a.mtime) || (b.index - a.index))
    for (const entry of entries.slice(this.#keep)) {
      try {
        unlinkSync(entry.path)
      } catch {
        // best effort
      }
    }
  }

  /** The JPEG the model sees: quality 80, long edge at most `maxEdge`. */
  async toModelImage(capture: ScreenshotCapture): Promise<ModelImage> {
    const out = capture.path.replace(/\.png$/u, '.model.jpg')
    const args = ['-s', 'format', 'jpeg', '-s', 'formatOptions', String(this.#quality)]
    const longEdge = Math.max(capture.width ?? 0, capture.height ?? 0)
    if (longEdge === 0 || longEdge > this.#maxEdge) args.push('--resampleHeightWidthMax', String(this.#maxEdge))
    args.push(capture.path, '--out', out)
    try {
      await runSips(args)
      const buffer = await readFile(out)
      const size = jpegSize(buffer)
      if (size === undefined) throw new Error(`sips produced an unreadable JPEG for ${capture.path}`)
      return { data: buffer.toString('base64'), mimeType: 'image/jpeg', ...size }
    } finally {
      await rm(out, { force: true })
    }
  }
}
```

- [ ] **Step 4: 运行测试和类型检查**

Run: `npm test && npm run typecheck`
Expected：screenshot 的 5 个测试 PASS；typecheck 无错误。

- [ ] **Step 5: 提交**

```bash
git add src/screenshot.ts test/screenshot.test.ts
git commit -q -m "feat: screenshot cache with pruning and a downscaled JPEG for the model

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: 录屏子进程管理

**Files:**
- Create: `src/recorder.ts`
- Modify: `test/helpers/fakes.ts`（追加 `fakeRecordSpawn`）
- Test: `test/recorder.test.ts`

**Interfaces:**
- Consumes：`RECORD_START_TIMEOUT_MS`、`RECORD_STOP_TIMEOUT_MS`（Task 1）
- Produces：`interface RecordingInfo { udid; path; startedAt }`、`interface RecordingResult { udid; path; bytes; durationMs }`、`type SpawnRecord = (udid, path) => ChildProcess`、`interface RecorderOptions { dir; spawnRecord?; startTimeoutMs?; stopTimeoutMs?; now? }`、`recordVideoArgs(udid, path)`、`class Recorder { active(udid); defaultPath(udid); start(udid, outputPath?); stop(udid); stopAll() }`；测试工具 `fakeRecordSpawn({ announce?, exitEarly? }): { spawnRecord; spawned: FakeRecording[] }`

- [ ] **Step 1: 在 `test/helpers/fakes.ts` 顶部加 import，并在文件末尾追加 `fakeRecordSpawn`**

在文件开头的 import 区加入：

```ts
import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { writeFileSync } from 'node:fs'
import { PassThrough } from 'node:stream'
```

在文件末尾追加：

```ts
export interface FakeRecording {
  udid: string
  path: string
  signals: string[]
}

/**
 * A `simctl io recordVideo` stand-in: prints "Recording started" (unless
 * told not to), and on SIGINT writes a 2 KB movie and exits 0.
 */
export function fakeRecordSpawn(options: { announce?: boolean; exitEarly?: boolean } = {}): {
  spawnRecord: (udid: string, path: string) => ChildProcess
  spawned: FakeRecording[]
} {
  const spawned: FakeRecording[] = []
  const spawnRecord = (udid: string, path: string): ChildProcess => {
    const record: FakeRecording = { udid, path, signals: [] }
    spawned.push(record)
    const stderr = new PassThrough()
    const emitter = new EventEmitter()
    const child = Object.assign(emitter, {
      stderr,
      kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
        record.signals.push(signal)
        if (signal === 'SIGINT') {
          writeFileSync(path, Buffer.alloc(2048, 1))
          setImmediate(() => emitter.emit('exit', 0))
        }
        return true
      },
    })
    setImmediate(() => {
      if (options.exitEarly === true) {
        stderr.write('Invalid device: booted\n')
        setTimeout(() => emitter.emit('exit', 1), 10)
        return
      }
      if (options.announce !== false) stderr.write('Recording started\n')
    })
    return child as unknown as ChildProcess
  }
  return { spawnRecord, spawned }
}
```

- [ ] **Step 2: 写失败的测试 `test/recorder.test.ts`**

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Recorder, recordVideoArgs } from '../src/recorder.js'
import { fakeRecordSpawn } from './helpers/fakes.js'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'ios-sim-rec-'))
}

test('start waits for "Recording started"; stop finalizes with SIGINT', async () => {
  const { spawnRecord, spawned } = fakeRecordSpawn()
  let clock = 1_000
  const recorder = new Recorder({ dir: tempDir(), spawnRecord, now: () => clock })
  const info = await recorder.start('BBB')
  assert.match(info.path, /recording-BBB-.*\.mov$/)
  assert.equal(recorder.active('BBB')?.path, info.path)
  await assert.rejects(recorder.start('BBB'), /already running/)
  clock = 4_500
  const result = await recorder.stop('BBB')
  assert.deepEqual(spawned[0]?.signals, ['SIGINT'])
  assert.equal(result.bytes, 2048)
  assert.equal(result.durationMs, 3_500)
  assert.equal(recorder.active('BBB'), undefined)
})

test('start fails loudly when recordVideo exits early', async () => {
  const recorder = new Recorder({ dir: tempDir(), spawnRecord: fakeRecordSpawn({ exitEarly: true }).spawnRecord })
  await assert.rejects(recorder.start('BBB'), /exited before recording \(code 1\): Invalid device/)
})

test('start times out without the announcement and stops the child', async () => {
  const { spawnRecord, spawned } = fakeRecordSpawn({ announce: false })
  const recorder = new Recorder({ dir: tempDir(), spawnRecord, startTimeoutMs: 50 })
  await assert.rejects(recorder.start('BBB'), /did not report "Recording started"/)
  assert.deepEqual(spawned[0]?.signals, ['SIGINT'])
})

test('stop without a recording and bad extensions are rejected', async () => {
  const recorder = new Recorder({ dir: tempDir(), spawnRecord: fakeRecordSpawn().spawnRecord })
  await assert.rejects(recorder.stop('BBB'), /no recording is running/)
  await assert.rejects(recorder.start('BBB', join(tempDir(), 'x.gif')), /\.mov or \.mp4/)
})

test('recordVideoArgs records h264 and overwrites', () => {
  assert.deepEqual(recordVideoArgs('BBB', '/tmp/a.mov'), ['simctl', 'io', 'BBB', 'recordVideo', '--codec=h264', '--force', '/tmp/a.mov'])
})
```

- [ ] **Step 3: 运行，确认失败**

Run: `npm test`
Expected: FAIL，`Cannot find module '.../src/recorder.js'`。

- [ ] **Step 4: 写 `src/recorder.ts`**

```ts
/**
 * `ios_sim_record`: one tracked `simctl io recordVideo` child per device.
 * Replaces the old `pkill -f recordVideo`: stop signals exactly the child it
 * started (SIGINT, so the movie is finalized) and waits for it to exit.
 * @module ios-simulator/recorder
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { RECORD_START_TIMEOUT_MS, RECORD_STOP_TIMEOUT_MS } from './config.js'

export interface RecordingInfo {
  udid: string
  path: string
  startedAt: number
}

export interface RecordingResult {
  udid: string
  path: string
  bytes: number
  durationMs: number
}

export type SpawnRecord = (udid: string, path: string) => ChildProcess

export interface RecorderOptions {
  dir: string
  spawnRecord?: SpawnRecord
  startTimeoutMs?: number
  stopTimeoutMs?: number
  now?: () => number
}

interface ActiveRecording {
  child: ChildProcess
  info: RecordingInfo
  exited: Promise<number | null>
}

/** `xcrun simctl io <udid> recordVideo --codec=h264 --force <path>` arguments. */
export function recordVideoArgs(udid: string, path: string): string[] {
  return ['simctl', 'io', udid, 'recordVideo', '--codec=h264', '--force', path]
}

const spawnXcrunRecord: SpawnRecord = (udid, path) =>
  spawn('xcrun', recordVideoArgs(udid, path), { stdio: ['ignore', 'ignore', 'pipe'] })

function safeName(udid: string): string {
  return udid.replace(/[^A-Za-z0-9_-]/g, '_')
}

function fileSize(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

export class Recorder {
  readonly #dir: string
  readonly #spawnRecord: SpawnRecord
  readonly #startTimeoutMs: number
  readonly #stopTimeoutMs: number
  readonly #now: () => number
  readonly #active = new Map<string, ActiveRecording>()

  constructor(options: RecorderOptions) {
    this.#dir = options.dir
    this.#spawnRecord = options.spawnRecord ?? spawnXcrunRecord
    this.#startTimeoutMs = options.startTimeoutMs ?? RECORD_START_TIMEOUT_MS
    this.#stopTimeoutMs = options.stopTimeoutMs ?? RECORD_STOP_TIMEOUT_MS
    this.#now = options.now ?? Date.now
  }

  active(udid: string): RecordingInfo | undefined {
    return this.#active.get(udid)?.info
  }

  defaultPath(udid: string): string {
    const stamp = new Date(this.#now()).toISOString().replace(/[:.]/g, '-')
    return join(this.#dir, `recording-${safeName(udid)}-${stamp}.mov`)
  }

  async start(udid: string, outputPath?: string): Promise<RecordingInfo> {
    const running = this.#active.get(udid)
    if (running !== undefined) {
      throw new Error(`a recording is already running for ${udid} (${running.info.path}) — stop it first with action "stop"`)
    }
    const requested = outputPath?.trim() ?? ''
    const path = requested === '' ? this.defaultPath(udid) : requested
    if (!/\.(mov|mp4)$/iu.test(path)) throw new Error(`outputPath must end with .mov or .mp4, got ${path}`)
    mkdirSync(dirname(path), { recursive: true })
    const child = this.#spawnRecord(udid, path)
    const exited = new Promise<number | null>(resolve => {
      child.once('exit', code => resolve(code))
      child.once('error', () => resolve(null))
    })
    await this.#waitForStart(child, exited)
    const info: RecordingInfo = { udid, path, startedAt: this.#now() }
    this.#active.set(udid, { child, info, exited })
    return info
  }

  async stop(udid: string): Promise<RecordingResult> {
    const recording = this.#active.get(udid)
    if (recording === undefined) throw new Error(`no recording is running for ${udid} — start one with action "start"`)
    this.#active.delete(udid)
    recording.child.kill('SIGINT')
    let timer: ReturnType<typeof setTimeout> | undefined
    const outcome = await Promise.race([
      recording.exited.then(code => ({ code })),
      new Promise<'timeout'>(resolve => { timer = setTimeout(() => resolve('timeout'), this.#stopTimeoutMs) }),
    ])
    if (timer !== undefined) clearTimeout(timer)
    if (outcome === 'timeout') {
      recording.child.kill('SIGKILL')
      throw new Error(`recordVideo did not finish writing ${recording.info.path} within ${this.#stopTimeoutMs} ms`)
    }
    const bytes = fileSize(recording.info.path)
    if (bytes === 0) {
      throw new Error(`recordVideo exited (code ${String(outcome.code)}) without writing ${recording.info.path}`)
    }
    return { udid, path: recording.info.path, bytes, durationMs: this.#now() - recording.info.startedAt }
  }

  /** Finish every running recording (used on shutdown). */
  async stopAll(): Promise<void> {
    await Promise.all([...this.#active.keys()].map(udid => this.stop(udid).catch(() => undefined)))
  }

  #waitForStart(child: ChildProcess, exited: Promise<number | null>): Promise<void> {
    return new Promise((resolve, reject) => {
      let stderr = ''
      let settled = false
      const onData = (chunk: Buffer): void => {
        stderr += chunk.toString('utf8')
        if (stderr.includes('Recording started')) finish()
      }
      const finish = (error?: Error): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        child.stderr?.off('data', onData)
        if (error === undefined) resolve()
        else reject(error)
      }
      const detail = (): string => (stderr.trim() === '' ? '' : `: ${stderr.trim()}`)
      const timer = setTimeout(() => {
        child.kill('SIGINT')
        finish(new Error(`recordVideo did not report "Recording started" within ${this.#startTimeoutMs} ms${detail()}`))
      }, this.#startTimeoutMs)
      child.stderr?.on('data', onData)
      void exited.then(code => {
        finish(new Error(`recordVideo exited before recording (code ${String(code)})${detail()} — is the simulator booted?`))
      })
    })
  }
}
```

- [ ] **Step 5: 运行测试和类型检查**

Run: `npm test && npm run typecheck`
Expected：recorder 的 5 个测试 PASS；typecheck 无错误。

- [ ] **Step 6: 提交**

```bash
git add src/recorder.ts test/recorder.test.ts test/helpers/fakes.ts
git commit -q -m "feat: track recordVideo children per device and finalize them with SIGINT

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: 依赖接口、设备选择规则、结果格式与测试夹具

**Files:**
- Create: `src/deps.ts`、`src/target.ts`、`src/tools/result.ts`、`test/helpers/harness.ts`
- Modify: `test/helpers/fakes.ts`（追加 `DEVICES`、`fakeSimctl`）
- Test: `test/target.test.ts`、`test/result.test.ts`

**Interfaces:**
- Consumes：Task 2–9 的类型
- Produces（`src/deps.ts`）：`type StreamHost = Pick<SimHostController, 'binary' | 'streamInfo' | 'status' | 'ensureRunning' | 'stop' | 'acquire' | 'control'>`、`interface SimctlApi`（`listDevices`、`getDevice`、`bootDevice`、`shutdownDevice`、`takeScreenshot`、`installApp`、`uninstallApp`、`launchApp`、`terminateApp`、`openUrl`、`sendPush`、`setLocation`、`clearLocation`、`setAppearance`）、`interface ScreenshotService { dir; capture; toModelImage }`、`interface PanelHandle { ensureStarted(): Promise<string> }`、`interface RecorderApi { active; start; stop }`、`interface BuilderApi { detectProject; buildRun; readBundleIdentifier }`、`interface ToolDeps { host; stream; simctl; screenshots; panel; recorder; builder; listApps(udid, signal?); cacheRoot; platform; settleMs }`
- Produces（`src/target.ts`）：`SIMULATOR_UNAVAILABLE`、`assertMac(platform)`、`assertStreamAvailable(host)`、`sortDevices(devices)`、`pickPreferred(devices)`、`resolveTargetDevice({ simctl, host }, reference?, { bootFallback? }?)`、`requireBooted(tool, device)`、`ensureStreamFor(host, device): Promise<SimStreamInfo>`
- Produces（`src/tools/result.ts`）：`UDID_PARAM`、`interface DeviceSummary`、`deviceSummary(device, state?)`、`jsonResult(value, image?)`、`errorResult(tool, error)`、`runTool(tool, body)`、`sleep(ms)`
- Produces（测试工具）：`DEVICES`（AAA iPhone 16/iOS 18/关机、BBB iPhone 17 Pro/iOS 26/已启动、CCC iPad Air/iOS 26/关机、EEE iPhone 15/iOS 18/已启动）、`fakeSimctl(devices?): { api; calls: unknown[][]; devices }`、`toolHarness(register, { host?, devices?, deps? }?): Promise<Harness>`、`textOf(result)`

- [ ] **Step 1: 写 `src/deps.ts`**

```ts
/**
 * The dependency seams the MCP tools and the panel are written against, so
 * tests drive them with fakes and src/server.ts wires the real modules.
 * @module ios-simulator/deps
 */

import type { InstalledApp } from './app-list.js'
import type { BuildRunOptions, BuildRunResult, ProjectTarget } from './build-run.js'
import type { RecordingInfo, RecordingResult } from './recorder.js'
import type { ModelImage, ScreenshotCapture } from './screenshot.js'
import type { SimHostController } from './sim-host.js'
import type { SimulatorDevice } from './simctl.js'
import type { StreamSource } from './stream-source.js'

/** The public slice of SimHostController that the tools and the panel use. */
export type StreamHost = Pick<SimHostController, 'binary' | 'streamInfo' | 'status' | 'ensureRunning' | 'stop' | 'acquire' | 'control'>

/** The simctl operations the tools use (the src/simctl.ts module satisfies it). */
export interface SimctlApi {
  listDevices(): Promise<SimulatorDevice[]>
  getDevice(reference: string): Promise<SimulatorDevice>
  bootDevice(udid: string): Promise<void>
  shutdownDevice(udid: string): Promise<void>
  takeScreenshot(udid: string, filePath: string, signal?: AbortSignal): Promise<void>
  installApp(udid: string, appPath: string, signal?: AbortSignal): Promise<void>
  uninstallApp(udid: string, bundleId: string, signal?: AbortSignal): Promise<void>
  launchApp(udid: string, bundleId: string, signal?: AbortSignal): Promise<string>
  terminateApp(udid: string, bundleId: string, signal?: AbortSignal): Promise<string>
  openUrl(udid: string, url: string, signal?: AbortSignal): Promise<void>
  sendPush(udid: string, bundleId: string, payloadPath: string, signal?: AbortSignal): Promise<void>
  setLocation(udid: string, latitude: number, longitude: number, signal?: AbortSignal): Promise<void>
  clearLocation(udid: string, signal?: AbortSignal): Promise<void>
  setAppearance(udid: string, appearance: 'light' | 'dark', signal?: AbortSignal): Promise<void>
}

export interface ScreenshotService {
  readonly dir: string
  capture(udid: string, signal?: AbortSignal): Promise<ScreenshotCapture>
  toModelImage(capture: ScreenshotCapture): Promise<ModelImage>
}

/** Starts the live panel once and reports its URL. */
export interface PanelHandle {
  ensureStarted(): Promise<string>
}

export interface RecorderApi {
  active(udid: string): RecordingInfo | undefined
  start(udid: string, outputPath?: string): Promise<RecordingInfo>
  stop(udid: string): Promise<RecordingResult>
}

export interface BuilderApi {
  detectProject(projectPath: string): ProjectTarget
  buildRun(options: BuildRunOptions): Promise<BuildRunResult>
  readBundleIdentifier(appPath: string, signal?: AbortSignal): Promise<string>
}

export interface ToolDeps {
  host: StreamHost
  stream: StreamSource
  simctl: SimctlApi
  screenshots: ScreenshotService
  panel: PanelHandle
  recorder: RecorderApi
  builder: BuilderApi
  listApps(udid: string, signal?: AbortSignal): Promise<InstalledApp[]>
  cacheRoot: string
  platform: NodeJS.Platform
  /** Delay before the effect screenshot of ios_sim_interact, ms. */
  settleMs: number
}
```

- [ ] **Step 2: 在 `test/helpers/fakes.ts` 追加 `DEVICES` 和 `fakeSimctl`**

把顶部的 `import { writeFileSync } from 'node:fs'` 改成 `import { readFileSync, writeFileSync } from 'node:fs'`，并在 import 区加入：

```ts
import type { SimctlApi } from '../../src/deps.js'
import type { SimulatorDevice } from '../../src/simctl.js'
import { tinyPng } from './png.js'
```

在文件末尾追加：

```ts
/** Four simulators: two booted iPhones on different runtimes, two shut down. */
export const DEVICES: readonly SimulatorDevice[] = [
  { udid: 'AAA', name: 'iPhone 16', runtime: 'com.apple.CoreSimulator.SimRuntime.iOS-18-0', state: 'Shutdown' },
  {
    udid: 'BBB',
    name: 'iPhone 17 Pro',
    runtime: 'com.apple.CoreSimulator.SimRuntime.iOS-26-0',
    state: 'Booted',
    deviceType: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro',
  },
  { udid: 'CCC', name: 'iPad Air', runtime: 'com.apple.CoreSimulator.SimRuntime.iOS-26-0', state: 'Shutdown' },
  { udid: 'EEE', name: 'iPhone 15', runtime: 'com.apple.CoreSimulator.SimRuntime.iOS-18-0', state: 'Booted' },
]

/** A simctl stand-in over a mutable device list; records every side effect. */
export function fakeSimctl(devices: SimulatorDevice[] = DEVICES.map(device => ({ ...device }))): {
  api: SimctlApi
  calls: unknown[][]
  devices: SimulatorDevice[]
} {
  const calls: unknown[][] = []
  const find = (reference: string): SimulatorDevice => {
    const wanted = reference.trim()
    const device = devices.find(candidate => candidate.udid === wanted)
      ?? devices.find(candidate => candidate.name.toLowerCase() === wanted.toLowerCase())
    if (device === undefined) throw new Error(`unknown simulator "${wanted}" — run ios_sim_devices to list available devices`)
    return device
  }
  const setState = (udid: string, state: string): void => {
    const device = devices.find(candidate => candidate.udid === udid)
    if (device !== undefined) device.state = state
  }
  const api: SimctlApi = {
    listDevices: async () => devices.map(device => ({ ...device })),
    getDevice: async reference => ({ ...find(reference) }),
    bootDevice: async udid => { calls.push(['boot', udid]); setState(udid, 'Booted') },
    shutdownDevice: async udid => { calls.push(['shutdown', udid]); setState(udid, 'Shutdown') },
    takeScreenshot: async (udid, filePath) => { calls.push(['screenshot', udid]); writeFileSync(filePath, tinyPng(1206, 2622)) },
    installApp: async (udid, appPath) => { calls.push(['install', udid, appPath]) },
    uninstallApp: async (udid, bundleId) => { calls.push(['uninstall', udid, bundleId]) },
    launchApp: async (udid, bundleId) => { calls.push(['launch', udid, bundleId]); return `${bundleId}: 4242\n` },
    terminateApp: async (udid, bundleId) => { calls.push(['terminate', udid, bundleId]); return '' },
    openUrl: async (udid, url) => { calls.push(['openurl', udid, url]) },
    sendPush: async (udid, bundleId, payloadPath) => {
      calls.push(['push', udid, bundleId, JSON.parse(readFileSync(payloadPath, 'utf8')) as unknown])
    },
    setLocation: async (udid, latitude, longitude) => { calls.push(['location', udid, latitude, longitude]) },
    clearLocation: async udid => { calls.push(['location-clear', udid]) },
    setAppearance: async (udid, appearance) => { calls.push(['appearance', udid, appearance]) },
  }
  return { api, calls, devices }
}
```

- [ ] **Step 3: 写失败的测试 `test/target.test.ts` 和 `test/result.test.ts`**

`test/target.test.ts`：

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assertMac, ensureStreamFor, requireBooted, resolveTargetDevice, sortDevices } from '../src/target.js'
import { DEVICES, fakeHost, fakeSimctl } from './helpers/fakes.js'

test('an explicit reference wins', async () => {
  const { api } = fakeSimctl()
  const { host } = fakeHost()
  assert.equal((await resolveTargetDevice({ simctl: api, host }, 'iPad Air')).udid, 'CCC')
})

test('the streamed device comes before other booted devices', async () => {
  const { api } = fakeSimctl()
  const { host } = fakeHost({ device: 'EEE' })
  assert.equal((await resolveTargetDevice({ simctl: api, host }, undefined)).udid, 'EEE')
})

test('without a stream the newest-runtime booted iPhone is picked', async () => {
  const { api } = fakeSimctl()
  const { host } = fakeHost()
  assert.equal((await resolveTargetDevice({ simctl: api, host }, '  ')).udid, 'BBB')
})

test('bootFallback boots the newest-runtime iPhone when nothing is booted', async () => {
  const { api, calls } = fakeSimctl(DEVICES.map(device => ({ ...device, state: 'Shutdown' })))
  const { host } = fakeHost()
  const device = await resolveTargetDevice({ simctl: api, host }, undefined, { bootFallback: true })
  assert.equal(device.udid, 'BBB')
  assert.equal(device.state, 'Booted')
  assert.deepEqual(calls, [['boot', 'BBB']])
})

test('no booted device and no fallback is an actionable error', async () => {
  const { api } = fakeSimctl(DEVICES.map(device => ({ ...device, state: 'Shutdown' })))
  const { host } = fakeHost()
  await assert.rejects(resolveTargetDevice({ simctl: api, host }, undefined), /call ios_sim_boot first/)
})

test('sortDevices puts booted first, then the newest runtime, then the name', () => {
  assert.deepEqual(sortDevices(DEVICES).map(device => device.udid), ['BBB', 'EEE', 'CCC', 'AAA'])
})

test('requireBooted, assertMac and ensureStreamFor guard their preconditions', async () => {
  assert.throws(() => requireBooted('ios_sim_panel', { udid: 'CCC', name: 'iPad Air', runtime: 'r', state: 'Shutdown' }), /iPad Air is Shutdown — boot it first with ios_sim_boot/)
  assert.throws(() => assertMac('linux'), /iOS Simulator requires macOS with Xcode/)
  const unavailable = fakeHost({ available: false })
  await assert.rejects(ensureStreamFor(unavailable.host, { udid: 'BBB', name: 'x', runtime: 'r', state: 'Booted' }), /serve-sim is unavailable/)
  const available = fakeHost()
  const info = await ensureStreamFor(available.host, { udid: 'BBB', name: 'x', runtime: 'r', state: 'Booted' })
  assert.equal(info.device, 'BBB')
  assert.deepEqual(available.calls, [['ensureRunning', 'BBB']])
})
```

`test/result.test.ts`：

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deviceSummary, errorResult, jsonResult, runTool } from '../src/tools/result.js'

test('jsonResult carries JSON text and an optional image block', () => {
  const result = jsonResult({ ok: true }, { data: 'AAAA', mimeType: 'image/jpeg', width: 1, height: 2 })
  assert.deepEqual(result.content, [
    { type: 'text', text: '{\n  "ok": true\n}' },
    { type: 'image', data: 'AAAA', mimeType: 'image/jpeg' },
  ])
})

test('errorResult prefixes the tool name once', () => {
  assert.deepEqual(errorResult('ios_sim_x', new Error('boom')), { content: [{ type: 'text', text: 'ios_sim_x: boom' }], isError: true })
  assert.equal((errorResult('ios_sim_x', new Error('ios_sim_x: boom')).content[0] as { text: string }).text, 'ios_sim_x: boom')
})

test('runTool turns throws into error results; deviceSummary can override state', async () => {
  const result = await runTool('ios_sim_x', async () => { throw new Error('nope') })
  assert.equal(result.isError, true)
  assert.deepEqual(deviceSummary({ udid: 'A', name: 'n', runtime: 'r', state: 'Shutdown' }, 'Booted'), { udid: 'A', name: 'n', runtime: 'r', state: 'Booted' })
})
```

- [ ] **Step 4: 运行，确认失败**

Run: `npm test`
Expected: FAIL，`src/target.js`、`src/tools/result.js` 不存在。

- [ ] **Step 5: 写 `src/target.ts`**

```ts
/**
 * Which simulator a tool call targets, and the guards every tool shares.
 * The resolution order is ported from dsh-ios src/tools.ts
 * (resolveTargetDevice): explicit udid/name → streamed device → booted
 * device (iPhones, newest runtime first) → optional boot fallback.
 * @module ios-simulator/target
 */

import type { SimctlApi, StreamHost } from './deps.js'
import type { SimStreamInfo } from './sim-host.js'
import { compareRuntimesDesc, type SimulatorDevice } from './simctl.js'

/** Error prefix on hosts that cannot run the simulator. */
export const SIMULATOR_UNAVAILABLE = 'iOS Simulator requires macOS with Xcode'

export function assertMac(platform: NodeJS.Platform): void {
  if (platform !== 'darwin') {
    throw new Error(`${SIMULATOR_UNAVAILABLE} — this host runs ${platform}, so no simulator tools can run here`)
  }
}

/** Touch input and the live panel need serve-sim; say so, and what still works. */
export function assertStreamAvailable(host: StreamHost): void {
  if (!host.binary.available) {
    throw new Error(
      `serve-sim is unavailable (${host.binary.reason ?? 'unknown reason'}) — touch input and the live panel need it; `
      + 'the simctl-only tools (ios_sim_screenshot, ios_sim_list_apps, ios_sim_launch_app, ios_sim_open_url, '
      + 'ios_sim_push, ios_sim_location, ios_sim_appearance, ios_sim_record) still work',
    )
  }
}

/** Booted first, then the newest runtime, then the name. */
export function sortDevices(devices: readonly SimulatorDevice[]): SimulatorDevice[] {
  return [...devices].sort((a, b) => {
    const booted = Number(b.state === 'Booted') - Number(a.state === 'Booted')
    if (booted !== 0) return booted
    const runtime = compareRuntimesDesc(a.runtime, b.runtime)
    return runtime !== 0 ? runtime : a.name.localeCompare(b.name)
  })
}

/** Prefer iPhones, then the newest runtime. `devices` must be non-empty. */
export function pickPreferred(devices: readonly SimulatorDevice[]): SimulatorDevice {
  const iphones = devices.filter(device => device.name.toLowerCase().startsWith('iphone'))
  const pool = [...(iphones.length > 0 ? iphones : devices)]
  const picked = pool.sort((a, b) => compareRuntimesDesc(a.runtime, b.runtime))[0]
  if (picked === undefined) throw new Error('No simulator devices are installed — install an iOS Simulator runtime in Xcode, then retry')
  return picked
}

export async function resolveTargetDevice(
  deps: { simctl: SimctlApi; host: StreamHost },
  reference?: string,
  options: { bootFallback?: boolean } = {},
): Promise<SimulatorDevice> {
  if (reference !== undefined && reference.trim() !== '') return deps.simctl.getDevice(reference)
  const status = deps.host.status()
  if (status.running && status.device !== undefined) {
    try {
      return await deps.simctl.getDevice(status.device)
    } catch {
      // The streamed device vanished from simctl; fall through to booted devices.
    }
  }
  const devices = await deps.simctl.listDevices()
  const booted = devices.filter(device => device.state === 'Booted')
  if (booted.length > 0) return pickPreferred(booted)
  if (options.bootFallback === true) {
    const picked = pickPreferred(devices)
    await deps.simctl.bootDevice(picked.udid)
    return { ...picked, state: 'Booted' }
  }
  throw new Error('No booted simulator and no live stream — call ios_sim_boot first, then retry')
}

/** Tools that act on a device never boot it implicitly. */
export function requireBooted(tool: string, device: SimulatorDevice): void {
  if (device.state !== 'Booted') {
    throw new Error(`${tool}: ${device.name} is ${device.state} — boot it first with ios_sim_boot (this tool never boots a device)`)
  }
}

/** Make sure the live stream serves `device` (it must already be booted). */
export async function ensureStreamFor(host: StreamHost, device: SimulatorDevice): Promise<SimStreamInfo> {
  assertStreamAvailable(host)
  const info = host.streamInfo
  if (info !== undefined && info.device === device.udid) return info
  return host.ensureRunning({ udid: device.udid })
}
```

- [ ] **Step 6: 写 `src/tools/result.ts`**

```ts
/**
 * Shared tool-result helpers: JSON text plus an optional image block, one
 * error prefix per tool, and the device summary every result carries.
 * @module ios-simulator/tools/result
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import type { ModelImage } from '../screenshot.js'
import type { SimulatorDevice } from '../simctl.js'

export const UDID_PARAM = z.string().optional()
  .describe('Simulator udid or device name. Default: the streamed device, else the newest-runtime booted iPhone.')

export interface DeviceSummary {
  udid: string
  name: string
  runtime: string
  state: string
}

export function deviceSummary(device: SimulatorDevice, state: string = device.state): DeviceSummary {
  return { udid: device.udid, name: device.name, runtime: device.runtime, state }
}

export function jsonResult(value: unknown, image?: ModelImage): CallToolResult {
  const content: CallToolResult['content'] = [{ type: 'text', text: JSON.stringify(value, null, 2) }]
  if (image !== undefined) content.push({ type: 'image', data: image.data, mimeType: image.mimeType })
  return { content }
}

export function errorResult(tool: string, error: unknown): CallToolResult {
  const message = error instanceof Error ? error.message : String(error)
  return {
    content: [{ type: 'text', text: message.startsWith(`${tool}:`) ? message : `${tool}: ${message}` }],
    isError: true,
  }
}

export async function runTool(tool: string, body: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await body()
  } catch (error) {
    return errorResult(tool, error)
  }
}

export function sleep(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}
```

- [ ] **Step 7: 写 MCP 测试夹具 `test/helpers/harness.ts`**

```ts
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { ToolDeps } from '../../src/deps.js'
import { Recorder } from '../../src/recorder.js'
import { ScreenshotStore } from '../../src/screenshot.js'
import type { SimulatorDevice } from '../../src/simctl.js'
import { SimStreamSource } from '../../src/stream-source.js'
import { fakeHost, fakeRecordSpawn, fakeSimctl, type FakeHostOptions } from './fakes.js'

export interface Harness {
  deps: ToolDeps
  hostCalls: string[][]
  simctlCalls: unknown[][]
  call(name: string, args?: Record<string, unknown>): Promise<CallToolResult>
  json(result: CallToolResult): any
  close(): Promise<void>
}

export interface HarnessOptions {
  host?: FakeHostOptions
  devices?: SimulatorDevice[]
  deps?: Partial<ToolDeps>
}

/** The first text block of a tool result. */
export function textOf(result: CallToolResult): string {
  const first = result.content[0]
  return first !== undefined && first.type === 'text' ? first.text : ''
}

/** A real McpServer + Client over an in-memory transport, wired to fakes. */
export async function toolHarness(
  register: (server: McpServer, deps: ToolDeps) => void,
  options: HarnessOptions = {},
): Promise<Harness> {
  const cacheRoot = mkdtempSync(join(tmpdir(), 'ios-sim-tools-'))
  const { host, calls: hostCalls } = fakeHost(options.host)
  const { api: simctl, calls: simctlCalls } = fakeSimctl(options.devices)
  const deps: ToolDeps = {
    host,
    stream: new SimStreamSource(host),
    simctl,
    screenshots: new ScreenshotStore({ dir: join(cacheRoot, 'screenshots'), takeScreenshot: simctl.takeScreenshot }),
    panel: { ensureStarted: async () => 'http://127.0.0.1:3999/' },
    recorder: new Recorder({ dir: join(cacheRoot, 'recordings'), spawnRecord: fakeRecordSpawn().spawnRecord }),
    builder: {
      detectProject: projectPath => ({ kind: 'xcodeproj', root: '/p', location: projectPath }),
      buildRun: async build => ({
        device: { udid: build.device.udid, name: build.device.name, runtime: build.device.runtime, state: 'Booted' },
        state: 'launched',
        bundleId: 'com.example.App',
        pid: '4242',
        appPath: '/dd/App.app',
        projectPath: build.target.location,
        scheme: build.scheme ?? 'App',
        configuration: build.configuration,
      }),
      readBundleIdentifier: async () => 'com.example.App',
    },
    listApps: async () => [
      { bundleId: 'com.apple.mobilecal', name: '日历', baseName: 'Calendar', system: true },
      { bundleId: 'com.example.notes', name: 'Notes Pro', system: false },
    ],
    cacheRoot,
    platform: 'darwin',
    settleMs: 0,
    ...options.deps,
  }
  const server = new McpServer({ name: 'ios-simulator-test', version: '0.0.0' })
  register(server, deps)
  const client = new Client({ name: 'ios-simulator-test-client', version: '0.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  return {
    deps,
    hostCalls,
    simctlCalls,
    call: async (name, args = {}) => (await client.callTool({ name, arguments: args })) as CallToolResult,
    json: result => JSON.parse(textOf(result)),
    close: async () => {
      await client.close()
      await server.close()
    },
  }
}
```

- [ ] **Step 8: 写夹具冒烟测试 `test/harness.test.ts`**

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deviceSummary, jsonResult, runTool, UDID_PARAM } from '../src/tools/result.js'
import { toolHarness } from './helpers/harness.js'

test('the tool harness wires fakes into an in-memory MCP client', async () => {
  const harness = await toolHarness((server, deps) => {
    server.registerTool('probe', { inputSchema: { udid: UDID_PARAM } }, async ({ udid }) =>
      runTool('probe', async () => jsonResult({ device: deviceSummary(await deps.simctl.getDevice(udid ?? 'BBB')) })))
  })
  assert.equal(harness.json(await harness.call('probe', { udid: 'CCC' })).device.name, 'iPad Air')
  await harness.close()
})
```

- [ ] **Step 9: 运行测试和类型检查**

Run: `npm test && npm run typecheck`
Expected：target 7 个、result 3 个、harness 1 个测试 PASS；typecheck 无错误。

- [ ] **Step 10: 提交**

```bash
git add src/deps.ts src/target.ts src/tools/result.ts test/helpers test/target.test.ts test/result.test.ts test/harness.test.ts
git commit -q -m "feat: tool dependency seams, device targeting rules and result helpers

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 11: 核心工具（devices / boot / shutdown / panel / screenshot / interact）

**Files:**
- Create: `src/tools/core.ts`
- Test: `test/tools-core.test.ts`

**Interfaces:**
- Consumes：`ToolDeps`（Task 10）、`interactControlArgs`、`performSimInteract`、`SimInteractArgs`、`SimInteractDelivery`（Task 7）、`DEVICE_ACTIONS`、`isDeviceAction`（Task 6）、target 与 result 的全部导出（Task 10）
- Produces：`ROTATE_ORIENTATIONS`、`registerCoreTools(server: McpServer, deps: ToolDeps): void`（注册 `ios_sim_devices`、`ios_sim_boot`、`ios_sim_shutdown`、`ios_sim_panel`、`ios_sim_screenshot`、`ios_sim_interact`）

- [ ] **Step 1: 写失败的测试 `test/tools-core.test.ts`**

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerCoreTools } from '../src/tools/core.js'
import { textOf, toolHarness } from './helpers/harness.js'

test('ios_sim_devices lists booted-first and names the streamed device', async () => {
  const h = await toolHarness(registerCoreTools, { host: { device: 'BBB' } })
  const body = h.json(await h.call('ios_sim_devices'))
  assert.deepEqual(body.devices.map((device: { udid: string }) => device.udid), ['BBB', 'EEE', 'CCC', 'AAA'])
  assert.deepEqual(body.booted, ['BBB', 'EEE'])
  assert.equal(body.streaming, 'BBB')
  assert.equal(body.devices[0].deviceType, 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro')
  const filtered = h.json(await h.call('ios_sim_devices', { query: 'ipad' }))
  assert.deepEqual(filtered.devices.map((device: { udid: string }) => device.udid), ['CCC'])
  await h.close()
})

test('ios_sim_boot starts the stream and returns the panel url', async () => {
  const h = await toolHarness(registerCoreTools)
  const body = h.json(await h.call('ios_sim_boot', { udid: 'iPad Air' }))
  assert.equal(body.device.udid, 'CCC')
  assert.equal(body.device.state, 'Booted')
  assert.equal(body.streaming, true)
  assert.equal(body.panelUrl, 'http://127.0.0.1:3999/')
  assert.deepEqual(h.hostCalls, [['ensureRunning', 'CCC']])
  await h.close()
})

test('ios_sim_boot degrades to a plain boot when serve-sim is unavailable', async () => {
  const h = await toolHarness(registerCoreTools, { host: { available: false } })
  const body = h.json(await h.call('ios_sim_boot', { udid: 'CCC' }))
  assert.equal(body.streaming, false)
  assert.match(body.note, /serve-sim is unavailable/)
  assert.deepEqual(h.simctlCalls, [['boot', 'CCC']])
  await h.close()
})

test('ios_sim_shutdown stops the stream of the streamed device first', async () => {
  const h = await toolHarness(registerCoreTools, { host: { device: 'BBB' } })
  const body = h.json(await h.call('ios_sim_shutdown', { udid: 'BBB' }))
  assert.equal(body.state, 'shutdown')
  assert.deepEqual(h.hostCalls, [['stop']])
  assert.deepEqual(h.simctlCalls, [['shutdown', 'BBB']])
  await h.close()
})

test('ios_sim_panel refuses a shut-down device instead of booting it', async () => {
  const h = await toolHarness(registerCoreTools)
  const result = await h.call('ios_sim_panel', { udid: 'CCC' })
  assert.equal(result.isError, true)
  assert.match(textOf(result), /^ios_sim_panel: iPad Air is Shutdown — boot it first with ios_sim_boot/)
  assert.deepEqual(h.hostCalls, [])
  const ok = h.json(await h.call('ios_sim_panel'))
  assert.equal(ok.panelUrl, 'http://127.0.0.1:3999/')
  assert.equal(ok.device.udid, 'BBB')
  await h.close()
})

test('ios_sim_screenshot returns a JPEG image block plus the summary', async () => {
  const h = await toolHarness(registerCoreTools)
  const result = await h.call('ios_sim_screenshot')
  const image = result.content.find(block => block.type === 'image')
  assert.ok(image !== undefined && image.type === 'image')
  assert.equal(image.mimeType, 'image/jpeg')
  const body = h.json(result)
  assert.equal(body.device.udid, 'BBB')
  assert.equal(body.width, 1206)
  assert.deepEqual(body.image, { width: 471, height: 1024 })
  await h.close()
})

test('ios_sim_interact taps through serve-sim and returns the effect screenshot', async () => {
  const h = await toolHarness(registerCoreTools, { host: { device: 'BBB' } })
  const result = await h.call('ios_sim_interact', { action: 'tap', x: 0.5, y: 0.25 })
  assert.equal(result.isError, undefined)
  assert.ok(h.hostCalls.some(call => call.join(' ') === 'control tap -d BBB 0.5 0.25'))
  assert.ok(result.content.some(block => block.type === 'image'))
  assert.equal(h.json(result).delivery.channel, 'cli')
  await h.close()
})

test('ios_sim_interact rotate and device_action go through the stream source', async () => {
  const h = await toolHarness(registerCoreTools, { host: { device: 'BBB' } })
  await h.call('ios_sim_interact', { action: 'rotate', orientation: 'landscape_left', screenshot: false })
  await h.call('ios_sim_interact', { action: 'device_action', name: 'lock', screenshot: false })
  const controls = h.hostCalls.filter(call => call[0] === 'control').map(call => call.slice(1).join(' '))
  assert.deepEqual(controls, ['rotate landscape_left -d BBB', 'button lock -d BBB'])
  await h.close()
})

test('ios_sim_interact explains bad arguments, a missing serve-sim and a non-Mac host', async () => {
  const h = await toolHarness(registerCoreTools, { host: { device: 'BBB' } })
  assert.match(textOf(await h.call('ios_sim_interact', { action: 'rotate' })), /requires orientation/)
  assert.match(textOf(await h.call('ios_sim_interact', { action: 'device_action', name: 'reboot' })), /requires name — one of app-switcher/)
  assert.match(textOf(await h.call('ios_sim_interact', { action: 'type', text: '中文' })), /US-keyboard ASCII/)
  await h.close()
  const noServeSim = await toolHarness(registerCoreTools, { host: { available: false } })
  assert.match(textOf(await noServeSim.call('ios_sim_interact', { action: 'tap', x: 0.5, y: 0.5 })), /serve-sim is unavailable/)
  await noServeSim.close()
  const linux = await toolHarness(registerCoreTools, { deps: { platform: 'linux' } })
  assert.match(textOf(await linux.call('ios_sim_devices')), /iOS Simulator requires macOS with Xcode/)
  await linux.close()
})
```

- [ ] **Step 2: 运行，确认失败**

Run: `npm test`
Expected: FAIL，`Cannot find module '.../src/tools/core.js'`。

- [ ] **Step 3: 写 `src/tools/core.ts`**

```ts
/**
 * Core `ios_sim_*` tools: devices, boot, shutdown, panel, screenshot and
 * interact. Behaviour follows dsh-ios src/tools.ts; screenshots come back as
 * image blocks because Claude reads images (dsh-ios served text-only models).
 * @module ios-simulator/tools/core
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { ToolDeps } from '../deps.js'
import { DEVICE_ACTIONS, isDeviceAction } from '../device-actions.js'
import { interactControlArgs, performSimInteract, type SimInteractArgs, type SimInteractDelivery } from '../interact.js'
import { assertMac, assertStreamAvailable, ensureStreamFor, requireBooted, resolveTargetDevice, sortDevices } from '../target.js'
import { deviceSummary, jsonResult, runTool, sleep, UDID_PARAM } from './result.js'

export const ROTATE_ORIENTATIONS = ['portrait', 'landscape_left', 'portrait_upside_down', 'landscape_right'] as const

const XCODE27_TYPE_HINT = ' — with Xcode 27, keyboard input needs Device Hub running with this simulator visible and '
  + 'frontmost, and the app that launched Claude enabled under System Settings ▸ Privacy & Security ▸ Accessibility; '
  + 'if input stays dead, `serve-sim repair-input -d <udid>` repairs it (it restarts SpringBoard and closes apps)'

export function registerCoreTools(server: McpServer, deps: ToolDeps): void {
  server.registerTool('ios_sim_devices', {
    title: 'List iOS simulators',
    description: 'List the iOS Simulator devices on this Mac (udid, name, runtime, state, deviceType): booted first, '
      + 'then newest runtime. Use it to find the udid or name the other ios_sim_* tools take; `streaming` names the '
      + 'device the live panel shows.',
    inputSchema: { query: z.string().optional().describe('Case-insensitive substring over name, udid and runtime') },
    annotations: { readOnlyHint: true },
  }, async ({ query }) => runTool('ios_sim_devices', async () => {
    assertMac(deps.platform)
    const all = await deps.simctl.listDevices()
    const needle = (query ?? '').trim().toLowerCase()
    const devices = sortDevices(all).filter(device => needle === ''
      || device.name.toLowerCase().includes(needle)
      || device.udid.toLowerCase().includes(needle)
      || device.runtime.toLowerCase().includes(needle))
    const status = deps.host.status()
    return jsonResult({
      devices: devices.map(device => ({
        ...deviceSummary(device),
        ...(device.deviceType === undefined ? {} : { deviceType: device.deviceType }),
      })),
      count: devices.length,
      booted: all.filter(device => device.state === 'Booted').map(device => device.udid),
      ...(status.running && status.device !== undefined ? { streaming: status.device } : {}),
    })
  }))

  server.registerTool('ios_sim_boot', {
    title: 'Boot a simulator',
    description: 'Boot an iOS Simulator and start its live serve-sim stream. Returns panelUrl: open it in the browser '
      + 'pane (preview_start with that url) so the user can watch and tap the simulator live. Find a udid or name '
      + '(e.g. "iPhone 17 Pro") with ios_sim_devices.',
    inputSchema: { udid: z.string().min(1).describe('Simulator udid or device name, e.g. "iPhone 17 Pro"') },
  }, async ({ udid }) => runTool('ios_sim_boot', async () => {
    assertMac(deps.platform)
    const device = await deps.simctl.getDevice(udid)
    if (!deps.host.binary.available) {
      await deps.simctl.bootDevice(device.udid)
      return jsonResult({
        device: deviceSummary(device, 'Booted'),
        state: 'booted',
        streaming: false,
        note: `booted without a live stream: serve-sim is unavailable (${deps.host.binary.reason ?? 'unknown reason'})`,
      })
    }
    await deps.host.ensureRunning({ udid: device.udid })
    const panelUrl = await deps.panel.ensureStarted()
    return jsonResult({ device: deviceSummary(device, 'Booted'), state: 'booted', streaming: true, panelUrl })
  }))

  server.registerTool('ios_sim_shutdown', {
    title: 'Shut down a simulator',
    description: 'Shut down an iOS Simulator. Stops its recording and its live stream first when they target it.',
    inputSchema: { udid: z.string().min(1).describe('Simulator udid or device name') },
    annotations: { destructiveHint: true },
  }, async ({ udid }) => runTool('ios_sim_shutdown', async () => {
    assertMac(deps.platform)
    const device = await deps.simctl.getDevice(udid)
    if (deps.recorder.active(device.udid) !== undefined) {
      await deps.recorder.stop(device.udid).catch(() => undefined)
    }
    if (deps.host.status().device === device.udid) await deps.host.stop()
    await deps.simctl.shutdownDevice(device.udid)
    return jsonResult({ device: deviceSummary(device, 'Shutdown'), state: 'shutdown', streaming: false })
  }))

  server.registerTool('ios_sim_panel', {
    title: 'Open the live panel',
    description: 'Make sure the live stream runs for a booted simulator and return panelUrl, the live panel (video, '
      + 'tap/drag, Home, rotate, screenshot). Open it with preview_start {url: panelUrl} in the browser pane; in a '
      + 'terminal-only session give the URL to the user. Never boots a device.',
    inputSchema: { udid: UDID_PARAM },
  }, async ({ udid }) => runTool('ios_sim_panel', async () => {
    assertMac(deps.platform)
    assertStreamAvailable(deps.host)
    const device = await resolveTargetDevice(deps, udid)
    requireBooted('ios_sim_panel', device)
    await ensureStreamFor(deps.host, device)
    const panelUrl = await deps.panel.ensureStarted()
    return jsonResult({
      panelUrl,
      device: deviceSummary(device),
      hint: 'Open panelUrl in the browser pane (preview_start with this url); in a terminal-only session give the URL to the user.',
    })
  }))

  server.registerTool('ios_sim_screenshot', {
    title: 'Screenshot the simulator',
    description: 'Capture the screen of a booted simulator. Returns the image (JPEG, long edge at most 1024 px) so you '
      + 'can read the screen, plus JSON with the full-resolution PNG path and sizes. To tap something you see, '
      + 'normalize its pixel position by image.width / image.height.',
    inputSchema: { udid: UDID_PARAM },
    annotations: { readOnlyHint: true },
  }, async ({ udid }, extra) => runTool('ios_sim_screenshot', async () => {
    assertMac(deps.platform)
    const device = await resolveTargetDevice(deps, udid)
    requireBooted('ios_sim_screenshot', device)
    const capture = await deps.screenshots.capture(device.udid, extra.signal)
    const image = await deps.screenshots.toModelImage(capture)
    return jsonResult({
      path: capture.path,
      bytes: capture.bytes,
      ...(capture.width === undefined ? {} : { width: capture.width, height: capture.height }),
      image: { width: image.width, height: image.height },
      device: deviceSummary(device),
    }, image)
  }))

  server.registerTool('ios_sim_interact', {
    title: 'Interact with the simulator',
    description: 'Drive a booted simulator through serve-sim: tap at normalized 0..1 coordinates (x = pixel x / '
      + 'screenshot image width, y = pixel y / image height), type US-keyboard text, press a hardware button (home, '
      + 'lock, …), send a gesture, scroll (direction names the CONTENT), rotate, or run a device action (app-switcher, '
      + 'lock, unlock, shake, siri, action-button, re-center; all but lock drive Simulator.app and need the '
      + 'Accessibility permission). Starts the live stream when needed but never boots a device. About 300 ms after '
      + 'the action a screenshot of the result comes back as an image; pass screenshot:false when chaining actions.',
    inputSchema: {
      action: z.enum(['tap', 'type', 'button', 'gesture', 'scroll', 'rotate', 'device_action']),
      udid: UDID_PARAM,
      x: z.number().min(0).max(1).optional().describe('Normalized x (tap: required; scroll: start anchor, default 0.5)'),
      y: z.number().min(0).max(1).optional().describe('Normalized y (tap: required; scroll: start anchor, default 0.5)'),
      text: z.string().optional().describe('Text for "type" (US-keyboard ASCII only)'),
      name: z.string().optional().describe('Button for "button" (home, lock, …) or the action for "device_action"'),
      json: z.record(z.string(), z.unknown()).optional()
        .describe('Gesture for "gesture": a drag {"fromX":0.1,"fromY":0.5,"toX":0.9,"toY":0.5,"duration":0.3} or one raw frame {"type":"begin","x":0.5,"y":0.5}'),
      direction: z.enum(['up', 'down', 'left', 'right']).optional()
        .describe('Scroll direction named by the CONTENT: "down" reveals content further down (the finger moves up)'),
      amount: z.number().min(0).max(1).optional().describe('Fraction of the screen a scroll travels (default 0.6)'),
      orientation: z.enum(ROTATE_ORIENTATIONS).optional().describe('Target orientation for "rotate"'),
      screenshot: z.boolean().optional().describe('Return a screenshot of the result (default true)'),
    },
  }, async (args, extra) => runTool('ios_sim_interact', async () => {
    assertMac(deps.platform)
    assertStreamAvailable(deps.host)
    const device = await resolveTargetDevice(deps, args.udid)
    requireBooted('ios_sim_interact', device)
    await ensureStreamFor(deps.host, device)
    let delivery: SimInteractDelivery | undefined
    if (args.action === 'rotate') {
      if (args.orientation === undefined) {
        throw new Error(`action "rotate" requires orientation: ${ROTATE_ORIENTATIONS.join(', ')}`)
      }
      const rotate = deps.stream.control.rotate
      if (rotate === undefined) throw new Error('this stream backend cannot rotate the device')
      await rotate(args.orientation)
    } else if (args.action === 'device_action') {
      const action = args.name
      if (!isDeviceAction(action)) {
        throw new Error(`action "device_action" requires name — one of ${DEVICE_ACTIONS.join(', ')}`)
      }
      const run = deps.stream.control.deviceAction
      if (run === undefined) throw new Error('this stream backend has no device actions')
      await run(action)
    } else {
      const simArgs: SimInteractArgs = {
        action: args.action,
        x: args.x,
        y: args.y,
        text: args.text,
        name: args.name,
        json: args.json,
        direction: args.direction,
        amount: args.amount,
      }
      const payloads = interactControlArgs(simArgs)
      try {
        delivery = await performSimInteract(deps.host, device.udid, simArgs, payloads)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        throw new Error(`serve-sim ${args.action} failed: ${message}${args.action === 'type' ? XCODE27_TYPE_HINT : ''}`)
      }
    }
    const result = { action: args.action, device: deviceSummary(device), ...(delivery === undefined ? {} : { delivery }) }
    if (args.screenshot === false) return jsonResult(result)
    await sleep(deps.settleMs)
    const capture = await deps.screenshots.capture(device.udid, extra.signal)
    const image = await deps.screenshots.toModelImage(capture)
    return jsonResult({
      ...result,
      screenshot: {
        path: capture.path,
        ...(capture.width === undefined ? {} : { width: capture.width, height: capture.height }),
        image: { width: image.width, height: image.height },
      },
    }, image)
  }))
}
```

- [ ] **Step 4: 运行测试和类型检查**

Run: `npm test && npm run typecheck`
Expected：tools-core 的 9 个测试 PASS；typecheck 无错误。

- [ ] **Step 5: 提交**

```bash
git add src/tools/core.ts test/tools-core.test.ts
git commit -q -m "feat: core ios_sim tools with image screenshots and serve-sim interaction

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: app 工具（list / launch / build_run / install / uninstall）

**Files:**
- Create: `src/tools/apps.ts`
- Test: `test/tools-apps.test.ts`

**Interfaces:**
- Consumes：`ToolDeps`、target 与 result（Task 10）、`filterInstalledApps`、`noMatchCandidateLines`、`noMatchListingHint`、`resolveAppByName`（Task 3）
- Produces：`registerAppTools(server, deps)`（注册 `ios_sim_list_apps`、`ios_sim_launch_app`、`ios_sim_build_run`、`ios_sim_install_app`、`ios_sim_uninstall_app`）

- [ ] **Step 1: 写失败的测试 `test/tools-apps.test.ts`**

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerAppTools } from '../src/tools/apps.js'
import { DEVICES } from './helpers/fakes.js'
import { textOf, toolHarness } from './helpers/harness.js'

test('ios_sim_list_apps shows user apps and explains a miss', async () => {
  const h = await toolHarness(registerAppTools)
  assert.deepEqual(h.json(await h.call('ios_sim_list_apps')).apps.map((app: { bundleId: string }) => app.bundleId), ['com.example.notes'])
  assert.equal(h.json(await h.call('ios_sim_list_apps', { query: 'calendar', include_system: true })).apps[0].name, '日历')
  const miss = h.json(await h.call('ios_sim_list_apps', { query: 'zzz' }))
  assert.equal(miss.count, 0)
  assert.match(miss.hint, /no installed app matches/)
  assert.ok(miss.candidates.length > 0)
  await h.close()
})

test('ios_sim_launch_app resolves a localized name, relaunches and reports the pid', async () => {
  const h = await toolHarness(registerAppTools)
  const body = h.json(await h.call('ios_sim_launch_app', { name: '日历', relaunch: true }))
  assert.equal(body.bundleId, 'com.apple.mobilecal')
  assert.equal(body.pid, 4242)
  assert.equal(body.relaunched, true)
  assert.deepEqual(h.simctlCalls, [['terminate', 'BBB', 'com.apple.mobilecal'], ['launch', 'BBB', 'com.apple.mobilecal']])
  await h.close()
})

test('ios_sim_launch_app wants exactly one of bundleId and name', async () => {
  const h = await toolHarness(registerAppTools)
  assert.match(textOf(await h.call('ios_sim_launch_app', {})), /bundleId is required/)
  assert.match(textOf(await h.call('ios_sim_launch_app', { bundleId: 'a', name: 'b' })), /either bundleId or name/)
  await h.close()
})

test('ios_sim_build_run boots the fallback iPhone, builds and returns the panel url', async () => {
  const h = await toolHarness(registerAppTools, { devices: DEVICES.map(device => ({ ...device, state: 'Shutdown' })) })
  const body = h.json(await h.call('ios_sim_build_run', { projectPath: '/p/App.xcodeproj' }))
  assert.equal(body.state, 'launched')
  assert.equal(body.device.udid, 'BBB')
  assert.equal(body.configuration, 'Debug')
  assert.equal(body.panelUrl, 'http://127.0.0.1:3999/')
  assert.equal(typeof body.durationMs, 'number')
  await h.close()
})

test('ios_sim_install_app needs a real .app bundle and reports its bundle id', async () => {
  const h = await toolHarness(registerAppTools)
  assert.match(textOf(await h.call('ios_sim_install_app', { appPath: '/nope/App.app' })), /containing Info\.plist/)
  const app = join(mkdtempSync(join(tmpdir(), 'ios-sim-app-')), 'Demo.app')
  mkdirSync(app)
  writeFileSync(join(app, 'Info.plist'), '')
  const body = h.json(await h.call('ios_sim_install_app', { appPath: app }))
  assert.equal(body.bundleId, 'com.example.App')
  assert.deepEqual(h.simctlCalls, [['install', 'BBB', app]])
  await h.close()
})

test('ios_sim_uninstall_app uninstalls by bundle id; app tools refuse a shut-down device', async () => {
  const h = await toolHarness(registerAppTools)
  assert.equal(h.json(await h.call('ios_sim_uninstall_app', { bundleId: ' com.example.notes ' })).bundleId, 'com.example.notes')
  assert.deepEqual(h.simctlCalls, [['uninstall', 'BBB', 'com.example.notes']])
  assert.match(textOf(await h.call('ios_sim_list_apps', { udid: 'CCC' })), /is Shutdown — boot it first/)
  await h.close()
})
```

- [ ] **Step 2: 运行，确认失败**

Run: `npm test`
Expected: FAIL，`Cannot find module '.../src/tools/apps.js'`。

- [ ] **Step 3: 写 `src/tools/apps.ts`**

```ts
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
```

- [ ] **Step 4: 运行测试和类型检查**

Run: `npm test && npm run typecheck`
Expected：tools-apps 的 6 个测试 PASS；typecheck 无错误。

- [ ] **Step 5: 提交**

```bash
git add src/tools/apps.ts test/tools-apps.test.ts
git commit -q -m "feat: app tools — list, launch by name, build & run, install, uninstall

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: 环境工具（open_url / push / location / appearance / record）

**Files:**
- Create: `src/tools/env.ts`
- Test: `test/tools-env.test.ts`

**Interfaces:**
- Consumes：`ToolDeps`、target 与 result（Task 10）
- Produces：`registerEnvTools(server, deps)`（注册 `ios_sim_open_url`、`ios_sim_push`、`ios_sim_location`、`ios_sim_appearance`、`ios_sim_record`）

- [ ] **Step 1: 写失败的测试 `test/tools-env.test.ts`**

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { registerEnvTools } from '../src/tools/env.js'
import { textOf, toolHarness } from './helpers/harness.js'

test('ios_sim_open_url requires a scheme and forwards the url', async () => {
  const h = await toolHarness(registerEnvTools)
  assert.match(textOf(await h.call('ios_sim_open_url', { url: 'example.com' })), /needs a scheme/)
  assert.equal(h.json(await h.call('ios_sim_open_url', { url: 'myapp://profile/1' })).opened, true)
  assert.deepEqual(h.simctlCalls, [['openurl', 'BBB', 'myapp://profile/1']])
  await h.close()
})

test('ios_sim_push writes a private payload file and removes it afterwards', async () => {
  const h = await toolHarness(registerEnvTools)
  assert.match(textOf(await h.call('ios_sim_push', { bundleId: 'com.x', payload: { alert: 'no aps' } })), /"aps" object/)
  await h.call('ios_sim_push', { bundleId: 'com.x', payload: { aps: { alert: 'Hi' } } })
  assert.deepEqual(h.simctlCalls, [['push', 'BBB', 'com.x', { aps: { alert: 'Hi' } }]])
  assert.deepEqual(readdirSync(join(h.deps.cacheRoot, 'tmp')), [])
  await h.close()
})

test('ios_sim_location sets, clears and validates', async () => {
  const h = await toolHarness(registerEnvTools)
  await h.call('ios_sim_location', { latitude: 37.7749, longitude: -122.4194 })
  await h.call('ios_sim_location', { clear: true })
  assert.match(textOf(await h.call('ios_sim_location', { latitude: 1 })), /both latitude and longitude/)
  assert.equal((await h.call('ios_sim_location', { latitude: 100, longitude: 0 })).isError, true)
  assert.deepEqual(h.simctlCalls, [['location', 'BBB', 37.7749, -122.4194], ['location-clear', 'BBB']])
  await h.close()
})

test('ios_sim_appearance switches to dark mode', async () => {
  const h = await toolHarness(registerEnvTools)
  assert.equal(h.json(await h.call('ios_sim_appearance', { appearance: 'dark' })).appearance, 'dark')
  assert.deepEqual(h.simctlCalls, [['appearance', 'BBB', 'dark']])
  await h.close()
})

test('ios_sim_record starts and stops one recording per device', async () => {
  const h = await toolHarness(registerEnvTools)
  const started = h.json(await h.call('ios_sim_record', { action: 'start' }))
  assert.equal(started.recording, true)
  assert.match(started.path, /recording-BBB-/)
  const stopped = h.json(await h.call('ios_sim_record', { action: 'stop' }))
  assert.equal(stopped.recording, false)
  assert.equal(stopped.bytes, 2048)
  assert.match(textOf(await h.call('ios_sim_record', { action: 'stop' })), /no recording is running/)
  await h.close()
})
```

- [ ] **Step 2: 运行，确认失败**

Run: `npm test`
Expected: FAIL，`Cannot find module '.../src/tools/env.js'`。

- [ ] **Step 3: 写 `src/tools/env.ts`**

```ts
/**
 * Environment tools carried over from the old panel, rebuilt on argument
 * arrays: open a URL, send a push, set or clear the location, switch the
 * appearance, and record the screen.
 * @module ios-simulator/tools/env
 */

import { randomUUID } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { ToolDeps } from '../deps.js'
import type { SimulatorDevice } from '../simctl.js'
import { assertMac, requireBooted, resolveTargetDevice } from '../target.js'
import { deviceSummary, jsonResult, runTool, UDID_PARAM } from './result.js'

export function registerEnvTools(server: McpServer, deps: ToolDeps): void {
  const bootedDevice = async (tool: string, udid: string | undefined): Promise<SimulatorDevice> => {
    assertMac(deps.platform)
    const device = await resolveTargetDevice(deps, udid)
    requireBooted(tool, device)
    return device
  }

  server.registerTool('ios_sim_open_url', {
    title: 'Open a URL or deep link',
    description: 'Open a URL or deep link (https://…, myapp://path) on a booted simulator.',
    inputSchema: { url: z.string().min(1), udid: UDID_PARAM },
  }, async (args, extra) => runTool('ios_sim_open_url', async () => {
    const url = args.url.trim()
    if (!/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(url)) {
      throw new Error(`url needs a scheme, e.g. https://example.com or myapp://path (got "${url}")`)
    }
    const device = await bootedDevice('ios_sim_open_url', args.udid)
    await deps.simctl.openUrl(device.udid, url, extra.signal)
    return jsonResult({ device: deviceSummary(device), url, opened: true })
  }))

  server.registerTool('ios_sim_push', {
    title: 'Send a push notification',
    description: 'Send a simulated push notification to an installed app. payload is the APNs JSON and must contain '
      + 'an "aps" object, e.g. {"aps":{"alert":{"title":"Hi","body":"Test"},"badge":1,"sound":"default"}}.',
    inputSchema: { bundleId: z.string().min(1), payload: z.record(z.string(), z.unknown()), udid: UDID_PARAM },
  }, async (args, extra) => runTool('ios_sim_push', async () => {
    const aps = args.payload.aps
    if (typeof aps !== 'object' || aps === null || Array.isArray(aps)) {
      throw new Error('payload must contain an "aps" object, e.g. {"aps":{"alert":"Hello"}}')
    }
    const bundleId = args.bundleId.trim()
    const device = await bootedDevice('ios_sim_push', args.udid)
    const dir = join(deps.cacheRoot, 'tmp')
    await mkdir(dir, { recursive: true })
    const file = join(dir, `push-${randomUUID()}.json`)
    await writeFile(file, JSON.stringify(args.payload), { mode: 0o600 })
    try {
      await deps.simctl.sendPush(device.udid, bundleId, file, extra.signal)
    } finally {
      await rm(file, { force: true })
    }
    return jsonResult({ device: deviceSummary(device), bundleId, sent: true })
  }))

  server.registerTool('ios_sim_location', {
    title: 'Set the simulated location',
    description: 'Set the simulated GPS location of a booted simulator (latitude and longitude), or clear it with clear:true.',
    inputSchema: {
      latitude: z.number().min(-90).max(90).optional(),
      longitude: z.number().min(-180).max(180).optional(),
      clear: z.boolean().optional(),
      udid: UDID_PARAM,
    },
  }, async (args, extra) => runTool('ios_sim_location', async () => {
    if (args.clear !== true && (args.latitude === undefined || args.longitude === undefined)) {
      throw new Error('pass both latitude and longitude, or clear:true')
    }
    const device = await bootedDevice('ios_sim_location', args.udid)
    if (args.clear === true) {
      await deps.simctl.clearLocation(device.udid, extra.signal)
      return jsonResult({ device: deviceSummary(device), cleared: true })
    }
    const latitude = args.latitude ?? 0
    const longitude = args.longitude ?? 0
    await deps.simctl.setLocation(device.udid, latitude, longitude, extra.signal)
    return jsonResult({ device: deviceSummary(device), latitude, longitude })
  }))

  server.registerTool('ios_sim_appearance', {
    title: 'Switch light or dark mode',
    description: 'Switch a booted simulator between light and dark mode.',
    inputSchema: { appearance: z.enum(['light', 'dark']), udid: UDID_PARAM },
  }, async (args, extra) => runTool('ios_sim_appearance', async () => {
    const device = await bootedDevice('ios_sim_appearance', args.udid)
    await deps.simctl.setAppearance(device.udid, args.appearance, extra.signal)
    return jsonResult({ device: deviceSummary(device), appearance: args.appearance })
  }))

  server.registerTool('ios_sim_record', {
    title: 'Record the screen',
    description: 'Record the simulator screen. action "start" begins a recording (outputPath optional, .mov or .mp4; '
      + 'default in the plugin cache); action "stop" finishes it and returns the file path, size and duration. '
      + 'One recording per device.',
    inputSchema: { action: z.enum(['start', 'stop']), outputPath: z.string().optional(), udid: UDID_PARAM },
  }, async args => runTool('ios_sim_record', async () => {
    const device = await bootedDevice('ios_sim_record', args.udid)
    if (args.action === 'start') {
      const info = await deps.recorder.start(device.udid, args.outputPath === undefined ? undefined : resolve(args.outputPath))
      return jsonResult({ device: deviceSummary(device), recording: true, path: info.path })
    }
    const result = await deps.recorder.stop(device.udid)
    return jsonResult({
      device: deviceSummary(device),
      recording: false,
      path: result.path,
      bytes: result.bytes,
      durationMs: result.durationMs,
    })
  }))
}
```

- [ ] **Step 4: 运行测试和类型检查**

Run: `npm test && npm run typecheck`
Expected：tools-env 的 5 个测试 PASS；typecheck 无错误。

- [ ] **Step 5: 提交**

```bash
git add src/tools/env.ts test/tools-env.test.ts
git commit -q -m "feat: environment tools — open_url, push, location, appearance, record

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 14: 面板安全边界 `fence.ts`

**Files:**
- Create: `src/panel/fence.ts`
- Test: `test/fence.test.ts`

**Interfaces:**
- Produces：`type FenceKind = 'read' | 'mutate' | 'upgrade'`、`interface FenceRequest { remoteAddress; headers }`、`type FenceVerdict = { ok: true } | { ok: false; reason: 'peer' | 'host' | 'origin' | 'fetch-site' | 'content-type' }`、`isLoopbackRemoteAddress(address)`、`allowedAuthorities(port)`、`checkRequest(request, port, kind): FenceVerdict`

- [ ] **Step 1: 写失败的测试 `test/fence.test.ts`**

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkRequest, isLoopbackRemoteAddress } from '../src/panel/fence.js'

const PORT = 3456
const base = { remoteAddress: '127.0.0.1', headers: { host: '127.0.0.1:3456' } }

test('only loopback peers pass', () => {
  for (const address of ['127.0.0.1', '127.8.9.10', '::1', '::ffff:127.0.0.1', '::ffff:7f00:1']) {
    assert.equal(isLoopbackRemoteAddress(address), true, address)
  }
  for (const address of [undefined, '192.168.1.2', '::ffff:10.0.0.1', '10.0.0.1', '::2']) {
    assert.equal(isLoopbackRemoteAddress(address), false, String(address))
  }
})

test('reads need a loopback Host on our port and no cross-site fetch', () => {
  assert.deepEqual(checkRequest(base, PORT, 'read'), { ok: true })
  assert.deepEqual(checkRequest({ ...base, headers: { host: 'localhost:3456', 'sec-fetch-site': 'none' } }, PORT, 'read'), { ok: true })
  assert.deepEqual(checkRequest({ ...base, headers: { host: 'evil.example:3456' } }, PORT, 'read'), { ok: false, reason: 'host' })
  assert.deepEqual(checkRequest({ ...base, headers: { host: '127.0.0.1:9999' } }, PORT, 'read'), { ok: false, reason: 'host' })
  assert.deepEqual(checkRequest({ ...base, remoteAddress: '192.168.1.2' }, PORT, 'read'), { ok: false, reason: 'peer' })
  assert.deepEqual(checkRequest({ ...base, headers: { host: '127.0.0.1:3456', 'sec-fetch-site': 'cross-site' } }, PORT, 'read'), { ok: false, reason: 'fetch-site' })
  assert.deepEqual(checkRequest({ ...base, headers: { host: '127.0.0.1:3456', 'sec-fetch-site': 'same-site' } }, PORT, 'read'), { ok: false, reason: 'fetch-site' })
  assert.deepEqual(checkRequest({ ...base, headers: { host: '127.0.0.1:3456', origin: 'http://evil.example' } }, PORT, 'read'), { ok: false, reason: 'origin' })
})

test('mutations need our exact Origin and a JSON body', () => {
  const ok = { host: '127.0.0.1:3456', origin: 'http://127.0.0.1:3456', 'content-type': 'application/json; charset=utf-8', 'sec-fetch-site': 'same-origin' }
  assert.deepEqual(checkRequest({ ...base, headers: ok }, PORT, 'mutate'), { ok: true })
  assert.deepEqual(checkRequest({ ...base, headers: { ...ok, host: 'localhost:3456', origin: 'http://localhost:3456' } }, PORT, 'mutate'), { ok: true })
  assert.deepEqual(checkRequest({ ...base, headers: { ...ok, origin: undefined } }, PORT, 'mutate'), { ok: false, reason: 'origin' })
  assert.deepEqual(checkRequest({ ...base, headers: { ...ok, origin: 'http://evil.example' } }, PORT, 'mutate'), { ok: false, reason: 'origin' })
  assert.deepEqual(checkRequest({ ...base, headers: { ...ok, 'content-type': 'text/plain' } }, PORT, 'mutate'), { ok: false, reason: 'content-type' })
  assert.deepEqual(checkRequest({ ...base, headers: { ...ok, 'sec-fetch-site': 'same-site' } }, PORT, 'mutate'), { ok: false, reason: 'fetch-site' })
})

test('WebSocket upgrades need our Origin but no content type', () => {
  assert.deepEqual(checkRequest({ ...base, headers: { host: '127.0.0.1:3456', origin: 'http://127.0.0.1:3456' } }, PORT, 'upgrade'), { ok: true })
  assert.deepEqual(checkRequest({ ...base, headers: { host: '127.0.0.1:3456', origin: 'null' } }, PORT, 'upgrade'), { ok: false, reason: 'origin' })
  assert.deepEqual(checkRequest({ ...base, headers: { host: '127.0.0.1:3456' } }, PORT, 'upgrade'), { ok: false, reason: 'origin' })
})
```

- [ ] **Step 2: 运行，确认失败**

Run: `npm test`
Expected: FAIL，`Cannot find module '.../src/panel/fence.js'`。

- [ ] **Step 3: 写 `src/panel/fence.ts`**

```ts
/**
 * Transport fence for the panel server, ported from dsh-ios
 * src/stream-routes.ts (isLoopbackRemoteAddress & co): a loopback peer, a
 * loopback Host naming OUR port (DNS rebinding), and — for anything that
 * changes state or opens the control socket — our exact Origin, plus a JSON
 * content type on POSTs (which forces a CORS preflight on foreign pages).
 * @module ios-simulator/panel/fence
 */

export type FenceKind = 'read' | 'mutate' | 'upgrade'

export interface FenceRequest {
  remoteAddress: string | undefined
  headers: Readonly<Record<string, string | string[] | undefined>>
}

export type FenceVerdict =
  | { ok: true }
  | { ok: false; reason: 'peer' | 'host' | 'origin' | 'fetch-site' | 'content-type' }

function isIpv4LoopbackAddress(address: string): boolean {
  const parts = address.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every(part => /^\d{1,3}$/u.test(part) && Number(part) <= 255)
}

/**
 * Trust the transport peer, never caller-controlled host data. Node may expose
 * an IPv4 peer directly or as an IPv4-mapped IPv6 address (also in the compact
 * hexadecimal form).
 */
export function isLoopbackRemoteAddress(address: string | undefined): boolean {
  if (address === undefined) return false
  const normalized = address.toLowerCase().split('%', 1)[0] ?? ''
  if (normalized === '::1' || isIpv4LoopbackAddress(normalized)) return true
  if (!normalized.startsWith('::ffff:')) return false
  const mapped = normalized.slice('::ffff:'.length)
  if (isIpv4LoopbackAddress(mapped)) return true
  const hexadecimal = /^([a-f0-9]{1,4}):([a-f0-9]{1,4})$/u.exec(mapped)
  return hexadecimal !== null && (Number.parseInt(hexadecimal[1] ?? '0', 16) >>> 8) === 127
}

function header(request: FenceRequest, name: string): string | undefined {
  const value = request.headers[name]
  return typeof value === 'string' ? value : undefined
}

/** The loopback authorities this panel answers to on `port`. */
export function allowedAuthorities(port: number): string[] {
  return [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]
}

export function checkRequest(request: FenceRequest, port: number, kind: FenceKind): FenceVerdict {
  if (!isLoopbackRemoteAddress(request.remoteAddress)) return { ok: false, reason: 'peer' }
  const authorities = allowedAuthorities(port)
  const host = header(request, 'host')?.toLowerCase()
  if (host === undefined || !authorities.includes(host)) return { ok: false, reason: 'host' }
  const site = header(request, 'sec-fetch-site')
  const origin = header(request, 'origin')
  const originOk = origin !== undefined && authorities.some(authority => origin.toLowerCase() === `http://${authority}`)
  if (kind === 'read') {
    // `none` is a user-initiated navigation (typing the URL, preview_start).
    if (site !== undefined && site !== 'same-origin' && site !== 'none') return { ok: false, reason: 'fetch-site' }
    if (origin !== undefined && !originOk) return { ok: false, reason: 'origin' }
    return { ok: true }
  }
  if (!originOk) return { ok: false, reason: 'origin' }
  if (site !== undefined && site !== 'same-origin') return { ok: false, reason: 'fetch-site' }
  if (kind === 'mutate') {
    const type = header(request, 'content-type')
    if (type === undefined || !/^application\/json\s*(;|$)/iu.test(type)) return { ok: false, reason: 'content-type' }
  }
  return { ok: true }
}
```

- [ ] **Step 4: 运行测试和类型检查**

Run: `npm test && npm run typecheck`
Expected：fence 的 4 个测试 PASS；typecheck 无错误。

- [ ] **Step 5: 提交**

```bash
git add src/panel/fence.ts test/fence.test.ts
git commit -q -m "feat: loopback/Host/Origin fence for the panel server

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 15: 面板服务 `panel-server.ts`

**Files:**
- Create: `src/panel/panel-server.ts`
- Test: `test/panel-server.test.ts`

**Interfaces:**
- Consumes：`checkRequest`、`FenceKind`（Task 14）、`StreamHost`、`SimctlApi`、`ScreenshotService`（Task 10）、`StreamSource`（Task 6）、`isDeviceAction`（Task 6）、`isScreenshotFileName`（Task 8）、`pickPreferred`、`sortDevices`（Task 10）、`PANEL_PORT_ATTEMPTS`（Task 1）
- Produces：`interface PanelServerOptions { staticDir; preferredPort; attempts?; host; stream; simctl: Pick<SimctlApi, 'listDevices' | 'getDevice' | 'bootDevice'>; screenshots: Pick<ScreenshotService, 'capture' | 'dir'> }`、`class PanelServer { url; ensureStarted(): Promise<string>; dispose(): Promise<void> }`（满足 `PanelHandle`）
- 路由：`GET /` `/index.html` `/main.js` `/styles.css`、`GET /stream`、`GET /shots/<name>`、`GET /api/status`、`GET /api/devices`、`POST /api/switch-device {udid}`、`POST /api/capture {}`、`POST /api/device-action {action}`、`WS /ws`

- [ ] **Step 1: 写失败的测试 `test/panel-server.test.ts`**

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request, type IncomingHttpHeaders } from 'node:http'
import { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket, WebSocketServer } from 'ws'
import { PanelServer } from '../src/panel/panel-server.js'
import { ScreenshotStore } from '../src/screenshot.js'
import { SimStreamSource } from '../src/stream-source.js'
import { fakeHost, fakeSimctl } from './helpers/fakes.js'

interface Upstream {
  port: number
  received: Buffer[]
  close(): void
}

/** A serve-sim stand-in: an MJPEG route plus a control socket that greets with a config frame. */
async function fakeServeSim(): Promise<Upstream> {
  const http = createServer((req, res) => {
    if (req.url === '/stream.mjpeg') {
      res.writeHead(200, { 'content-type': 'multipart/x-mixed-replace; boundary=frame', 'access-control-allow-origin': '*' })
      res.write('--frame\r\nContent-Type: image/jpeg\r\n\r\nJPEG1\r\n')
      return
    }
    res.writeHead(404).end()
  })
  const wss = new WebSocketServer({ server: http })
  const received: Buffer[] = []
  wss.on('connection', socket => {
    socket.send(Buffer.concat([Buffer.from([130]), Buffer.from(JSON.stringify({ width: 1206, height: 2622, orientation: 'portrait' }))]))
    socket.on('message', data => { received.push(data as Buffer) })
  })
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', () => resolve()))
  return {
    port: (http.address() as { port: number }).port,
    received,
    close: () => {
      wss.close()
      http.closeAllConnections()
      http.close()
    },
  }
}

interface Fixture {
  port: number
  upstream: Upstream
  hostCalls: string[][]
  simctlCalls: unknown[][]
  shotsDir: string
  consumers(): number
  close(): Promise<void>
}

async function panelFixture(): Promise<Fixture> {
  const upstream = await fakeServeSim()
  const { host, calls: hostCalls, consumers } = fakeHost({ device: 'BBB', baseUrl: `http://127.0.0.1:${upstream.port}` })
  const { api: simctl, calls: simctlCalls } = fakeSimctl()
  const staticDir = mkdtempSync(join(tmpdir(), 'ios-sim-static-'))
  writeFileSync(join(staticDir, 'index.html'), '<!doctype html><title>panel</title>')
  writeFileSync(join(staticDir, 'main.js'), '')
  writeFileSync(join(staticDir, 'styles.css'), '')
  const shotsDir = mkdtempSync(join(tmpdir(), 'ios-sim-panel-shots-'))
  const panel = new PanelServer({
    staticDir,
    preferredPort: 0,
    attempts: 1,
    host,
    stream: new SimStreamSource(host),
    simctl,
    screenshots: new ScreenshotStore({ dir: shotsDir, takeScreenshot: simctl.takeScreenshot }),
  })
  const url = await panel.ensureStarted()
  return {
    port: Number(new URL(url).port),
    upstream,
    hostCalls,
    simctlCalls,
    shotsDir,
    consumers,
    close: async () => {
      await panel.dispose()
      upstream.close()
    },
  }
}

interface Reply {
  status: number
  headers: IncomingHttpHeaders
  body: string
}

/** Plain node:http, so Host / Origin / Sec-Fetch-Site are fully under test control. */
function call(port: number, path: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: options.method ?? 'GET', headers: options.headers }, res => {
      const chunks: Buffer[] = []
      const finish = (): void => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') })
      if (String(res.headers['content-type']).startsWith('multipart/')) {
        res.once('data', chunk => {
          chunks.push(chunk as Buffer)
          finish()
          res.destroy()
        })
        return
      }
      res.on('data', chunk => chunks.push(chunk as Buffer))
      res.on('end', finish)
    })
    req.on('error', reject)
    req.end(options.body)
  })
}

function jsonHeaders(port: number): Record<string, string> {
  return { origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }
}

test('serves the panel page with a CSP and rejects DNS-rebinding hosts', async () => {
  const f = await panelFixture()
  const page = await call(f.port, '/')
  assert.equal(page.status, 200)
  assert.match(page.body, /<title>panel<\/title>/)
  assert.match(String(page.headers['content-security-policy']), /default-src 'self'/)
  assert.equal((await call(f.port, '/', { headers: { host: 'evil.example' } })).status, 403)
  assert.equal((await call(f.port, '/nope')).status, 404)
  await f.close()
})

test('proxies the MJPEG stream without upstream CORS headers and releases its consumer', async () => {
  const f = await panelFixture()
  const stream = await call(f.port, '/stream')
  assert.equal(stream.status, 200)
  assert.match(stream.body, /--frame/)
  assert.equal(stream.headers['access-control-allow-origin'], undefined)
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(f.consumers(), 0)
  await f.close()
})

test('mutations need our Origin and JSON; captures are served from /shots', async () => {
  const f = await panelFixture()
  const foreign = await call(f.port, '/api/capture', { method: 'POST', headers: { ...jsonHeaders(f.port), origin: 'http://evil.example' }, body: '{}' })
  assert.equal(foreign.status, 403)
  const plain = await call(f.port, '/api/capture', { method: 'POST', headers: { ...jsonHeaders(f.port), 'content-type': 'text/plain' }, body: '{}' })
  assert.equal(plain.status, 403)
  const captured = await call(f.port, '/api/capture', { method: 'POST', headers: jsonHeaders(f.port), body: '{}' })
  assert.equal(captured.status, 200)
  const { url } = JSON.parse(captured.body) as { url: string }
  assert.match(url, /^\/shots\/screenshot-BBB-\d+\.png$/)
  const png = await call(f.port, url)
  assert.equal(png.status, 200)
  assert.equal(png.headers['content-type'], 'image/png')
  await f.close()
})

test('/shots refuses traversal and symlinks', async () => {
  const f = await panelFixture()
  symlinkSync('/etc/hosts', join(f.shotsDir, 'screenshot-X-1.png'))
  assert.equal((await call(f.port, '/shots/..%2F..%2Fetc%2Fhosts')).status, 404)
  assert.equal((await call(f.port, '/shots/screenshot-X-1.png')).status, 404)
  await f.close()
})

test('status, devices and switch-device (which may boot the chosen device)', async () => {
  const f = await panelFixture()
  const status = JSON.parse((await call(f.port, '/api/status')).body) as { running: boolean; device: string; deviceName: string }
  assert.deepEqual([status.running, status.device, status.deviceName], [true, 'BBB', 'iPhone 17 Pro'])
  const devices = JSON.parse((await call(f.port, '/api/devices')).body) as { devices: Array<{ udid: string }>; streaming: string }
  assert.deepEqual(devices.devices.map(device => device.udid), ['BBB', 'EEE', 'CCC', 'AAA'])
  assert.equal(devices.streaming, 'BBB')
  const switched = await call(f.port, '/api/switch-device', { method: 'POST', headers: jsonHeaders(f.port), body: JSON.stringify({ udid: 'CCC' }) })
  assert.equal(switched.status, 200)
  assert.deepEqual(f.simctlCalls, [['boot', 'CCC']])
  assert.ok(f.hostCalls.some(entry => entry.join(' ') === 'ensureRunning CCC'))
  await f.close()
})

test('relays control frames both ways over /ws and refuses foreign origins', async () => {
  const f = await panelFixture()
  const client = new WebSocket(`ws://127.0.0.1:${f.port}/ws`, { origin: `http://127.0.0.1:${f.port}` })
  const firstMessage = new Promise<Buffer>(resolve => client.once('message', data => resolve(data as Buffer)))
  await new Promise<void>((resolve, reject) => {
    client.once('open', () => resolve())
    client.once('error', reject)
  })
  assert.equal((await firstMessage)[0], 130)
  client.send(Buffer.concat([Buffer.from([4]), Buffer.from('{"button":"home"}')]))
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(f.upstream.received[0]?.[0], 4)
  client.close()
  const status = await new Promise<number>(resolve => {
    const foreign = new WebSocket(`ws://127.0.0.1:${f.port}/ws`, { origin: 'http://evil.example' })
    foreign.on('unexpected-response', (_request, response) => resolve(response.statusCode ?? 0))
    foreign.on('error', () => resolve(-1))
  })
  assert.equal(status, 403)
  await f.close()
})
```

- [ ] **Step 2: 运行，确认失败**

Run: `npm test`
Expected: FAIL，`Cannot find module '.../src/panel/panel-server.js'`。

- [ ] **Step 3: 写 `src/panel/panel-server.ts`**

```ts
/**
 * The live panel's loopback HTTP + WebSocket server. It replaces dsh-ios's
 * signed DSH webserver routes (src/stream-routes.ts) with a dedicated
 * 127.0.0.1 origin: the MJPEG proxy and the control-socket relay are ported;
 * the HMAC capability layer is unnecessary on a dedicated origin (spec §8.1).
 * @module ios-simulator/panel/panel-server
 */

import { createReadStream, lstatSync, realpathSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createServer, get as httpGet, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { basename, join, sep } from 'node:path'
import type { Duplex } from 'node:stream'
import { WebSocket, WebSocketServer, type RawData } from 'ws'
import { PANEL_PORT_ATTEMPTS } from '../config.js'
import type { ScreenshotService, SimctlApi, StreamHost } from '../deps.js'
import { isDeviceAction } from '../device-actions.js'
import { isScreenshotFileName } from '../screenshot.js'
import type { SimulatorDevice } from '../simctl.js'
import type { StreamSource } from '../stream-source.js'
import { pickPreferred, sortDevices } from '../target.js'
import { checkRequest, type FenceKind } from './fence.js'

export interface PanelServerOptions {
  /** Directory holding index.html, main.js and styles.css. */
  staticDir: string
  preferredPort: number
  /** Ports tried: preferredPort .. preferredPort + attempts - 1 (default 21). */
  attempts?: number
  host: StreamHost
  stream: StreamSource
  simctl: Pick<SimctlApi, 'listDevices' | 'getDevice' | 'bootDevice'>
  screenshots: Pick<ScreenshotService, 'capture' | 'dir'>
}

const STATIC_FILES: Readonly<Record<string, { file: string; type: string }>> = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/main.js': { file: 'main.js', type: 'text/javascript; charset=utf-8' },
  '/styles.css': { file: 'styles.css', type: 'text/css; charset=utf-8' },
}
const MAX_BODY_BYTES = 16 * 1024
const MAX_PENDING_WS_FRAMES = 64
const WEBSOCKET_KEY_PATTERN = /^[A-Za-z0-9+/]{22}==$/u
const STATUS_TEXT: Readonly<Record<number, string>> = {
  400: 'Bad Request',
  403: 'Forbidden',
  404: 'Not Found',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(body)
}

function rejectUpgrade(socket: Duplex, status: number): void {
  socket.once('finish', () => socket.destroy())
  socket.end(`HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? 'Error'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data
  if (Array.isArray(data)) return Buffer.concat(data)
  return Buffer.from(data)
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'request body too large')
    chunks.push(buffer)
  }
  if (size === 0) return {}
  let value: unknown
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HttpError(400, 'request body is not JSON')
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HttpError(400, 'request body must be a JSON object')
  }
  return value as Record<string, unknown>
}

export class PanelServer {
  readonly #options: PanelServerOptions
  readonly #wss = new WebSocketServer({ noServer: true, perMessageDeflate: false })
  readonly #teardowns = new Set<() => void>()
  #server: Server | undefined
  #port = 0
  #starting: Promise<string> | undefined
  #disposed = false

  constructor(options: PanelServerOptions) {
    this.#options = options
  }

  /** The panel URL once started. */
  get url(): string | undefined {
    return this.#server === undefined ? undefined : `http://127.0.0.1:${this.#port}/`
  }

  /** Start listening (once) and resolve the panel URL. */
  ensureStarted(): Promise<string> {
    if (this.#disposed) return Promise.reject(new Error('the panel server is disposed'))
    this.#starting ??= this.#listen().catch((error: unknown) => {
      this.#starting = undefined
      throw error
    })
    return this.#starting
  }

  /** Close every stream proxy and relay, then the listener. */
  async dispose(): Promise<void> {
    this.#disposed = true
    for (const teardown of [...this.#teardowns]) teardown()
    this.#wss.close()
    const server = this.#server
    this.#server = undefined
    if (server !== undefined) {
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  }

  async #listen(): Promise<string> {
    const attempts = this.#options.attempts ?? PANEL_PORT_ATTEMPTS
    let lastError: unknown
    for (let offset = 0; offset < attempts; offset += 1) {
      const port = this.#options.preferredPort + offset
      if (port > 65535) break
      const server = createServer((req, res) => { void this.#handle(req, res) })
      server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => { void this.#handleUpgrade(req, socket, head) })
      try {
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject)
          server.listen(port, '127.0.0.1', () => {
            server.off('error', reject)
            resolve()
          })
        })
      } catch (error) {
        lastError = error
        if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') continue
        break
      }
      this.#server = server
      this.#port = (server.address() as AddressInfo).port
      return `http://127.0.0.1:${this.#port}/`
    }
    throw new Error(`could not start the panel server on 127.0.0.1:${this.#options.preferredPort}+: ${errorMessage(lastError)}`)
  }

  #allowed(req: IncomingMessage, kind: FenceKind): boolean {
    return checkRequest({ remoteAddress: req.socket.remoteAddress, headers: req.headers }, this.#port, kind).ok
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const method = req.method ?? 'GET'
      if (!this.#allowed(req, method === 'GET' || method === 'HEAD' ? 'read' : 'mutate')) {
        sendJson(res, 403, { ok: false, error: 'forbidden' })
        return
      }
      const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
      const staticFile = STATIC_FILES[path]
      if (method === 'GET' && staticFile !== undefined) return await this.#serveStatic(res, staticFile)
      if (method === 'GET' && path === '/stream') return await this.#serveStream(res)
      if (method === 'GET' && path.startsWith('/shots/')) return this.#serveShot(res, path.slice('/shots/'.length))
      if (method === 'GET' && path === '/api/status') return sendJson(res, 200, await this.#status())
      if (method === 'GET' && path === '/api/devices') return sendJson(res, 200, await this.#devices())
      if (method === 'POST' && path === '/api/switch-device') {
        return sendJson(res, 200, await this.#switchDevice(await readJsonBody(req)))
      }
      if (method === 'POST' && path === '/api/capture') {
        await readJsonBody(req)
        return sendJson(res, 200, await this.#capture())
      }
      if (method === 'POST' && path === '/api/device-action') {
        return sendJson(res, 200, await this.#deviceAction(await readJsonBody(req)))
      }
      sendJson(res, 404, { ok: false, error: 'not found' })
    } catch (error) {
      if (res.headersSent) {
        res.destroy()
        return
      }
      sendJson(res, error instanceof HttpError ? error.status : 500, { ok: false, error: errorMessage(error) })
    }
  }

  async #serveStatic(res: ServerResponse, entry: { file: string; type: string }): Promise<void> {
    const body = await readFile(join(this.#options.staticDir, entry.file))
    const port = this.#port
    res.writeHead(200, {
      'content-type': entry.type,
      'content-length': body.length,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'content-security-policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; "
        + `connect-src 'self' ws://127.0.0.1:${port} ws://localhost:${port}`,
    })
    res.end(body)
  }

  /** The streamed device, else the preferred booted one (never boots anything). */
  async #currentDevice(): Promise<SimulatorDevice | undefined> {
    const status = this.#options.host.status()
    if (status.running && status.device !== undefined) {
      try {
        return await this.#options.simctl.getDevice(status.device)
      } catch {
        // fall through to the booted devices
      }
    }
    const booted = (await this.#options.simctl.listDevices()).filter(device => device.state === 'Booted')
    return booted.length === 0 ? undefined : pickPreferred(booted)
  }

  async #serveStream(res: ServerResponse): Promise<void> {
    const device = await this.#currentDevice()
    if (device === undefined) throw new HttpError(503, 'no booted simulator — boot one with ios_sim_boot')
    const release = this.#options.host.acquire()
    let streamUrl: string
    try {
      streamUrl = (await this.#options.host.ensureRunning({ udid: device.udid })).streamUrl
    } catch (error) {
      release()
      throw new HttpError(502, `the simulator stream failed to start: ${errorMessage(error)}`)
    }
    this.#proxy(streamUrl, res, release)
  }

  /** Pipe serve-sim's multipart body through unchanged; hold one consumer while open. */
  #proxy(streamUrl: string, res: ServerResponse, release: () => void): void {
    let closed = false
    const upstream = httpGet(streamUrl)
    const teardown = (): void => {
      if (closed) return
      closed = true
      this.#teardowns.delete(teardown)
      upstream.destroy()
      if (!res.writableEnded) res.destroy()
      release()
    }
    this.#teardowns.add(teardown)
    res.on('close', teardown)
    res.on('error', teardown)
    upstream.on('error', teardown)
    upstream.on('response', response => {
      if (closed) {
        response.destroy()
        return
      }
      if (response.statusCode !== 200) {
        response.resume()
        sendJson(res, 502, { ok: false, error: `serve-sim stream returned HTTP ${String(response.statusCode)}` })
        teardown()
        return
      }
      // serve-sim's own `Access-Control-Allow-Origin: *` is deliberately NOT forwarded.
      res.writeHead(200, {
        'content-type': response.headers['content-type'] ?? 'multipart/x-mixed-replace; boundary=frame',
        'cache-control': 'no-cache, no-store',
        'x-content-type-options': 'nosniff',
        'cross-origin-resource-policy': 'same-origin',
        'referrer-policy': 'no-referrer',
      })
      response.on('error', teardown)
      response.pipe(res)
    })
  }

  #serveShot(res: ServerResponse, name: string): void {
    if (!isScreenshotFileName(name)) throw new HttpError(404, 'not found')
    const dir = this.#options.screenshots.dir
    let real: string
    try {
      const path = join(dir, name)
      if (lstatSync(path).isSymbolicLink()) throw new HttpError(404, 'not found')
      real = realpathSync(path)
      if (!real.startsWith(realpathSync(dir) + sep)) throw new HttpError(404, 'not found')
    } catch (error) {
      throw error instanceof HttpError ? error : new HttpError(404, 'not found')
    }
    res.writeHead(200, {
      'content-type': 'image/png',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'cross-origin-resource-policy': 'same-origin',
    })
    createReadStream(real).pipe(res)
  }

  async #status(): Promise<Record<string, unknown>> {
    const status = this.#options.host.status()
    let deviceName: string | undefined
    if (status.device !== undefined) {
      try {
        deviceName = (await this.#options.simctl.getDevice(status.device)).name
      } catch {
        deviceName = undefined
      }
    }
    return {
      running: status.running,
      available: this.#options.host.binary.available,
      ...(status.device === undefined ? {} : { device: status.device }),
      ...(deviceName === undefined ? {} : { deviceName }),
      panelUrl: `http://127.0.0.1:${this.#port}/`,
    }
  }

  async #devices(): Promise<Record<string, unknown>> {
    const devices = sortDevices(await this.#options.simctl.listDevices()).slice(0, 50)
    const status = this.#options.host.status()
    return {
      devices: devices.map(device => ({ udid: device.udid, name: device.name, runtime: device.runtime, state: device.state })),
      ...(status.running && status.device !== undefined ? { streaming: status.device } : {}),
    }
  }

  /** Picking a device in the panel is an explicit user gesture, so it may boot it. */
  async #switchDevice(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const udid = typeof body.udid === 'string' ? body.udid.trim() : ''
    if (udid === '') throw new HttpError(400, 'udid is required')
    let device: SimulatorDevice
    try {
      device = await this.#options.simctl.getDevice(udid)
    } catch (error) {
      throw new HttpError(409, errorMessage(error))
    }
    if (device.state !== 'Booted') await this.#options.simctl.bootDevice(device.udid)
    await this.#options.host.ensureRunning({ udid: device.udid })
    return { ok: true, device: { udid: device.udid, name: device.name, runtime: device.runtime, state: 'Booted' } }
  }

  async #capture(): Promise<Record<string, unknown>> {
    const device = await this.#currentDevice()
    if (device === undefined) throw new HttpError(409, 'no booted simulator to capture')
    const shot = await this.#options.screenshots.capture(device.udid)
    return {
      ok: true,
      url: `/shots/${basename(shot.path)}`,
      ...(shot.width === undefined ? {} : { width: shot.width, height: shot.height }),
    }
  }

  async #deviceAction(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const action = body.action
    if (!isDeviceAction(action)) throw new HttpError(400, 'unknown device action')
    const device = await this.#currentDevice()
    if (device === undefined) throw new HttpError(409, 'no booted simulator')
    await this.#options.host.ensureRunning({ udid: device.udid })
    const run = this.#options.stream.control.deviceAction
    if (run === undefined) throw new HttpError(501, 'device actions are not supported by this backend')
    await run(action)
    return { ok: true, action }
  }

  async #handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    try {
      if (new URL(req.url ?? '/', 'http://127.0.0.1').pathname !== '/ws') return rejectUpgrade(socket, 404)
      if (!this.#allowed(req, 'upgrade')) return rejectUpgrade(socket, 403)
      const key = req.headers['sec-websocket-key']
      if (typeof key !== 'string' || !WEBSOCKET_KEY_PATTERN.test(key)) return rejectUpgrade(socket, 400)
      const status = this.#options.host.status()
      if (!status.running || status.device === undefined) return rejectUpgrade(socket, 503)
      const release = this.#options.host.acquire()
      let wsUrl: string
      try {
        wsUrl = (await this.#options.host.ensureRunning({ udid: status.device })).wsUrl
      } catch {
        release()
        return rejectUpgrade(socket, 502)
      }
      if (this.#disposed) {
        release()
        return rejectUpgrade(socket, 503)
      }
      this.#relay(req, socket, head, wsUrl, release)
    } catch {
      rejectUpgrade(socket, 502)
    }
  }

  /** Relay binary HID frames between the panel and serve-sim's control socket. */
  #relay(req: IncomingMessage, socket: Duplex, head: Buffer, wsUrl: string, release: () => void): void {
    let browser: WebSocket | undefined
    let upstream: WebSocket | undefined
    let finished = false
    const teardown = (): void => {
      if (finished) return
      finished = true
      this.#teardowns.delete(teardown)
      browser?.terminate()
      upstream?.terminate()
      socket.destroy()
      release()
    }
    this.#teardowns.add(teardown)
    socket.on('error', teardown)
    socket.on('close', () => {
      if (browser === undefined) teardown()
    })
    this.#wss.handleUpgrade(req, socket, head, client => {
      if (finished) {
        client.terminate()
        return
      }
      browser = client
      const target = new WebSocket(wsUrl, { perMessageDeflate: false })
      upstream = target
      const pending: Array<{ data: Buffer; binary: boolean }> = []
      client.on('error', teardown)
      client.on('close', teardown)
      target.on('error', teardown)
      target.on('close', teardown)
      target.on('open', () => {
        for (const frame of pending) target.send(frame.data, { binary: frame.binary })
        pending.length = 0
      })
      client.on('message', (data: RawData, isBinary: boolean) => {
        const frame = { data: toBuffer(data), binary: isBinary }
        if (target.readyState === WebSocket.OPEN) target.send(frame.data, { binary: frame.binary })
        else if (pending.length < MAX_PENDING_WS_FRAMES) pending.push(frame)
      })
      target.on('message', (data: RawData, isBinary: boolean) => {
        if (client.readyState === WebSocket.OPEN) client.send(toBuffer(data), { binary: isBinary })
      })
    })
  }
}
```

- [ ] **Step 4: 运行测试和类型检查**

Run: `npm test && npm run typecheck`
Expected：panel-server 的 6 个测试 PASS；typecheck 无错误。

- [ ] **Step 5: 提交**

```bash
git add src/panel/panel-server.ts test/panel-server.test.ts
git commit -q -m "feat: loopback panel server with MJPEG proxy, control-socket relay and capture

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 16: 面板网页（原生 TS）

**Files:**
- Create: `src/panel/client/protocol.ts`、`src/panel/client/layout.ts`、`src/panel/client/copy.ts`、`src/panel/client/main.ts`、`src/panel/client/index.html`、`src/panel/client/styles.css`
- Test: `test/panel-client.test.ts`（只测纯函数模块；DOM 部分在 Task 19 的浏览器验收里测）

**Interfaces:**
- Produces（protocol）：`SIM_TOUCH_TAG`、`SIM_BUTTON_TAG`、`SIM_ROTATE_TAG = 7`、`SIM_CONFIG_TAG = 130`、`SIM_ROTATE_ORIENTATIONS`、`type SimRotateOrientation`、`interface SimPoint`、`interface SimScreenConfig { width; height; orientation }`、`encodeSimControlFrame(tag, payload): Uint8Array`、`simTouchFrame`、`simButtonFrame`、`simRotateFrame`、`nextSimRotateOrientation(current)`、`parseSimConfigFrame(data)`、`normalizePointerPoint(event, bounds)`
- Produces（layout）：`DEVICE_SCALE = 3`、`FALLBACK_BASE = { width: 1170, height: 2532 }`、`type SizeMode`、`type FrameStyle = 'none' | 'bezel' | 'device'`、`interface OrientationLayout { rotationDeg; displayW; displayH }`、`SIZE_OPTIONS`、`FRAME_STYLES`、`sizeModeOf(id)`、`sizeModeId(mode)`、`frameStyleOf(id)`、`orientationLayout(orientation, baseW, baseH)`、`framebufferPoint(orientation, point)`、`framePadding(style)`、`frameInset(style)`、`screenWidthFor(mode, layout, stage, style)`、`screenRadius(width, height)`
- Produces（copy）：`type DeviceActionId`、`interface PanelCopy`、`copyFor(language)`

- [ ] **Step 1: 写失败的测试 `test/panel-client.test.ts`**

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { copyFor } from '../src/panel/client/copy.js'
import {
  framebufferPoint,
  frameStyleOf,
  orientationLayout,
  screenRadius,
  screenWidthFor,
  sizeModeId,
  sizeModeOf,
} from '../src/panel/client/layout.js'
import {
  encodeSimControlFrame,
  nextSimRotateOrientation,
  normalizePointerPoint,
  parseSimConfigFrame,
  simButtonFrame,
  simRotateFrame,
  simTouchFrame,
} from '../src/panel/client/protocol.js'

test('control frames are [tag][json]; config frames parse defensively', () => {
  const touch = simTouchFrame('move', 2, -1)
  assert.equal(touch[0], 3)
  assert.deepEqual(JSON.parse(new TextDecoder().decode(touch.subarray(1))), { type: 'move', x: 1, y: 0 })
  assert.equal(simButtonFrame('home')[0], 4)
  assert.equal(simRotateFrame('portrait')[0], 7)
  const config = encodeSimControlFrame(130, { width: 1206, height: 2622, orientation: 'landscape_left' })
  assert.deepEqual(parseSimConfigFrame(config.buffer), { width: 1206, height: 2622, orientation: 'landscape_left' })
  assert.equal(parseSimConfigFrame(simButtonFrame('home')), undefined)
  assert.equal(parseSimConfigFrame(new Uint8Array([130, 123])), undefined)
})

test('rotation cycles clockwise from portrait and pointer points normalize to the box', () => {
  assert.equal(nextSimRotateOrientation(undefined), 'landscape_left')
  assert.equal(nextSimRotateOrientation('landscape_right'), 'portrait')
  assert.deepEqual(normalizePointerPoint({ clientX: 150, clientY: 50 }, { left: 100, top: 0, width: 200, height: 100 }), { x: 0.25, y: 0.5 })
})

test('landscape swaps the displayed axes and pointer points map back to the framebuffer', () => {
  assert.deepEqual(orientationLayout('landscape_left', 1206, 2622), { rotationDeg: 90, displayW: 2622, displayH: 1206 })
  assert.deepEqual(orientationLayout('landscape_right', 1206, 2622), { rotationDeg: -90, displayW: 2622, displayH: 1206 })
  assert.deepEqual(orientationLayout('garbage', 1206, 2622), { rotationDeg: 0, displayW: 1206, displayH: 2622 })
  assert.deepEqual(framebufferPoint('landscape_left', { x: 0.25, y: 0.75 }), { x: 0.75, y: 0.75 })
  assert.deepEqual(framebufferPoint('landscape_right', { x: 0.25, y: 0.75 }), { x: 0.25, y: 0.25 })
  assert.deepEqual(framebufferPoint('portrait_upside_down', { x: 0.25, y: 0.75 }), { x: 0.75, y: 0.25 })
  assert.deepEqual(framebufferPoint(undefined, { x: 0.25, y: 0.75 }), { x: 0.25, y: 0.75 })
})

test('fit contains the screen in the stage; percent and presets follow the device', () => {
  const portrait = orientationLayout('portrait', 1206, 2622)
  assert.equal(screenWidthFor({ kind: 'fit' }, portrait, { width: 1000, height: 600 }, 'none'), 275)
  assert.equal(screenWidthFor({ kind: 'fit' }, portrait, { width: 300, height: 2000 }, 'bezel'), 286)
  assert.equal(screenWidthFor({ kind: 'percent', value: 100 }, portrait, { width: 1, height: 1 }, 'none'), 402)
  assert.equal(screenWidthFor({ kind: 'preset', width: 240 }, portrait, { width: 1, height: 1 }, 'none'), 240)
  const landscape = orientationLayout('landscape_left', 1206, 2622)
  assert.equal(screenWidthFor({ kind: 'preset', width: 240 }, landscape, { width: 1, height: 1 }, 'none'), 522)
})

test('size and frame ids round-trip and fall back safely; copy follows the language', () => {
  assert.deepEqual(sizeModeOf('percent-75'), { kind: 'percent', value: 75 })
  assert.equal(sizeModeId({ kind: 'preset', width: 320 }), 'preset-M')
  assert.deepEqual(sizeModeOf('bogus'), { kind: 'fit' })
  assert.equal(frameStyleOf('device'), 'device')
  assert.equal(frameStyleOf(null), 'bezel')
  assert.equal(screenRadius(402, 874), 57)
  assert.equal(copyFor('zh-CN').home, '回到桌面')
  assert.equal(copyFor('en-US').home, 'Home')
})
```

- [ ] **Step 2: 运行，确认失败**

Run: `npm test`
Expected: FAIL，`src/panel/client/*.js` 不存在。

- [ ] **Step 3: 写 `src/panel/client/protocol.ts`**

```ts
// Ported from dsh-ios (MIT, © 2026 ZSeven—W) @ d9a9731 — src/client/protocol.ts (frame encoding)
/**
 * serve-sim control frames for the browser panel — the byte-identical twin of
 * src/sim-gesture.ts on the host. Every frame is `[tag byte][utf-8 JSON]`:
 * tag 3 touch `{type,x,y}` (0..1), tag 4 button `{button}`, tag 7 rotate
 * `{orientation}`; serve-sim broadcasts tag 130 `{width,height,orientation}`.
 * @module ios-simulator/panel/client/protocol
 */

export const SIM_TOUCH_TAG = 3
export const SIM_BUTTON_TAG = 4
export const SIM_ROTATE_TAG = 7
export const SIM_CONFIG_TAG = 130

/** Orientations serve-sim accepts, in clockwise order from portrait. */
export const SIM_ROTATE_ORIENTATIONS = ['portrait', 'landscape_left', 'portrait_upside_down', 'landscape_right'] as const
export type SimRotateOrientation = typeof SIM_ROTATE_ORIENTATIONS[number]

export interface SimPoint {
  x: number
  y: number
}

export interface SimScreenConfig {
  width: number
  height: number
  orientation: string
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function encodeSimControlFrame(tag: number, payload: unknown): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(payload))
  const frame = new Uint8Array(1 + json.length)
  frame[0] = tag
  frame.set(json, 1)
  return frame
}

export function simTouchFrame(type: 'begin' | 'move' | 'end', x: number, y: number): Uint8Array {
  return encodeSimControlFrame(SIM_TOUCH_TAG, { type, x: clamp01(x), y: clamp01(y) })
}

export function simButtonFrame(name: string): Uint8Array {
  return encodeSimControlFrame(SIM_BUTTON_TAG, { button: name })
}

export function simRotateFrame(orientation: string): Uint8Array {
  return encodeSimControlFrame(SIM_ROTATE_TAG, { orientation })
}

/** The next orientation clockwise (unknown starts from portrait). */
export function nextSimRotateOrientation(current: string | undefined): SimRotateOrientation {
  const index = (SIM_ROTATE_ORIENTATIONS as readonly string[]).indexOf(current ?? '')
  return SIM_ROTATE_ORIENTATIONS[((index < 0 ? 0 : index) + 1) % SIM_ROTATE_ORIENTATIONS.length] ?? 'portrait'
}

function messageBytes(data: unknown): Uint8Array | undefined {
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  return undefined
}

/** Parse a tag-130 config frame; anything else (or malformed) is undefined. */
export function parseSimConfigFrame(data: unknown): SimScreenConfig | undefined {
  const bytes = messageBytes(data)
  if (bytes === undefined || bytes.length < 2 || bytes[0] !== SIM_CONFIG_TAG) return undefined
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes.subarray(1)))
    if (
      isRecord(value)
      && typeof value.width === 'number' && Number.isFinite(value.width)
      && typeof value.height === 'number' && Number.isFinite(value.height)
      && typeof value.orientation === 'string' && value.orientation !== ''
    ) {
      return { width: value.width, height: value.height, orientation: value.orientation }
    }
  } catch {
    // malformed config JSON
  }
  return undefined
}

/** A pointer position normalized to an element box, clamped to 0..1. */
export function normalizePointerPoint(
  event: { clientX: number; clientY: number },
  bounds: { left: number; top: number; width: number; height: number },
): SimPoint {
  const width = bounds.width > 0 ? bounds.width : 1
  const height = bounds.height > 0 ? bounds.height : 1
  return { x: clamp01((event.clientX - bounds.left) / width), y: clamp01((event.clientY - bounds.top) / height) }
}
```

- [ ] **Step 4: 写 `src/panel/client/layout.ts`**

```ts
/**
 * Pure panel layout math (no DOM): orientation counter-rotation and the
 * pointer inverse mapping (ported from dsh-ios src/client/sim-orientation.ts,
 * verified live against serve-sim), plus size modes and frame styles after
 * sim-panel-size.ts / sim-frame-style.ts.
 * @module ios-simulator/panel/client/layout
 */

import type { SimPoint } from './protocol.js'

/** Logical points per framebuffer pixel assumed for percent sizes (@3x phones). */
export const DEVICE_SCALE = 3
/** Framebuffer size assumed until the first frame arrives (390×844 pt @3x). */
export const FALLBACK_BASE = { width: 1170, height: 2532 } as const

export type SizeMode =
  | { kind: 'fit' }
  | { kind: 'percent'; value: number }
  | { kind: 'preset'; width: number }

export type FrameStyle = 'none' | 'bezel' | 'device'

export interface OrientationLayout {
  /** CSS rotation for the stream img (degrees, positive = clockwise). */
  rotationDeg: number
  /** Width of the displayed (rotated) box, in framebuffer pixels. */
  displayW: number
  displayH: number
}

export const SIZE_OPTIONS: ReadonlyArray<{ id: string; mode: SizeMode; en: string; zh: string }> = [
  { id: 'fit', mode: { kind: 'fit' }, en: 'Fit', zh: '适应' },
  ...[50, 75, 100, 125].map(value => ({ id: `percent-${value}`, mode: { kind: 'percent', value } as SizeMode, en: `${value}%`, zh: `${value}%` })),
  { id: 'preset-S', mode: { kind: 'preset', width: 240 }, en: 'S · 240px', zh: 'S（240px）' },
  { id: 'preset-M', mode: { kind: 'preset', width: 320 }, en: 'M · 320px', zh: 'M（320px）' },
  { id: 'preset-L', mode: { kind: 'preset', width: 420 }, en: 'L · 420px', zh: 'L（420px）' },
]

export const FRAME_STYLES: readonly FrameStyle[] = ['none', 'bezel', 'device']

export function sizeModeOf(id: string | null | undefined): SizeMode {
  return SIZE_OPTIONS.find(option => option.id === id)?.mode ?? { kind: 'fit' }
}

export function sizeModeId(mode: SizeMode): string {
  const key = JSON.stringify(mode)
  return SIZE_OPTIONS.find(option => JSON.stringify(option.mode) === key)?.id ?? 'fit'
}

export function frameStyleOf(id: string | null | undefined): FrameStyle {
  return (FRAME_STYLES as readonly string[]).includes(id ?? '') ? id as FrameStyle : 'bezel'
}

/** The CSS rotation and displayed box for one serve-sim orientation. */
export function orientationLayout(orientation: string | undefined, baseW: number, baseH: number): OrientationLayout {
  switch (orientation) {
    case 'landscape_left':
      return { rotationDeg: 90, displayW: baseH, displayH: baseW }
    case 'landscape_right':
      return { rotationDeg: -90, displayW: baseH, displayH: baseW }
    case 'portrait_upside_down':
      return { rotationDeg: 180, displayW: baseW, displayH: baseH }
    default:
      return { rotationDeg: 0, displayW: baseW, displayH: baseH }
  }
}

/**
 * Inverse of the CSS counter-rotation: a point normalized to the DISPLAYED
 * box → framebuffer-normalized coordinates for serve-sim touch frames.
 */
export function framebufferPoint(orientation: string | undefined, displayed: SimPoint): SimPoint {
  switch (orientation) {
    case 'landscape_left':
      return { x: displayed.y, y: 1 - displayed.x }
    case 'landscape_right':
      return { x: 1 - displayed.y, y: displayed.x }
    case 'portrait_upside_down':
      return { x: 1 - displayed.x, y: 1 - displayed.y }
    default:
      return { x: displayed.x, y: displayed.y }
  }
}

/** Shell padding per frame style (none 0, bezel 6, device 16). */
export function framePadding(style: FrameStyle): number {
  return style === 'none' ? 0 : style === 'bezel' ? 6 : 16
}

/** Padding plus the 1 px border of the bordered styles. */
export function frameInset(style: FrameStyle): number {
  return style === 'none' ? 0 : framePadding(style) + 1
}

/** The displayed screen width in CSS px for one size mode. */
export function screenWidthFor(
  mode: SizeMode,
  layout: OrientationLayout,
  stage: { width: number; height: number },
  style: FrameStyle,
): number {
  const aspect = layout.displayW / layout.displayH
  switch (mode.kind) {
    case 'fit': {
      const inset = 2 * frameInset(style)
      const maxW = Math.max(0, stage.width - inset)
      const maxH = Math.max(0, stage.height - inset)
      return Math.max(1, Math.floor(Math.min(maxW, maxH * aspect)))
    }
    case 'percent':
      return Math.max(1, Math.round((layout.displayW / DEVICE_SCALE) * mode.value / 100))
    case 'preset':
      // Presets size the SHORT side, so a landscape device keeps its physical size.
      return Math.max(1, Math.round(aspect > 1 ? mode.width * aspect : mode.width))
  }
}

/** Screen corner radius proportional to the short side (55 pt at 390 pt). */
export function screenRadius(width: number, height: number): number {
  return Math.round(Math.min(width, height) * 55 / 390)
}
```

- [ ] **Step 5: 写 `src/panel/client/copy.ts`**

```ts
/**
 * Panel copy in English and Chinese (strings from dsh-ios src/client/copy.ts
 * where they exist), picked from navigator.language.
 * @module ios-simulator/panel/client/copy
 */

export type DeviceActionId = 'app-switcher' | 'lock' | 'unlock' | 'shake' | 'siri' | 'action-button' | 're-center'

export interface PanelCopy {
  language: 'en' | 'zh'
  title: string
  connecting: string
  live: string
  offline: string
  noDevice: string
  home: string
  homeHint: string
  screenshot: string
  rotate: string
  refresh: string
  deviceActions: string
  actions: Record<DeviceActionId, string>
  size: string
  frame: string
  frameStyles: Record<'none' | 'bezel' | 'device', string>
  picker: string
  booted: string
  switching: string
  captureFailed: string
  actionFailed: string
}

const EN: PanelCopy = {
  language: 'en',
  title: 'iOS Simulator',
  connecting: 'connecting…',
  live: 'live',
  offline: 'offline',
  noDevice: 'No live simulator — boot one with ios_sim_boot, or pick a device above.',
  home: 'Home',
  homeHint: 'Home · double-click for the app switcher',
  screenshot: 'Screenshot',
  rotate: 'Rotate',
  refresh: 'Refresh',
  deviceActions: 'Device actions…',
  actions: {
    'app-switcher': 'App Switcher',
    lock: 'Lock',
    unlock: 'Unlock',
    shake: 'Shake',
    siri: 'Siri',
    'action-button': 'Action Button',
    're-center': 'Re-center window',
  },
  size: 'Simulator display size',
  frame: 'Simulator frame style',
  frameStyles: { none: 'Frameless', bezel: 'Bezel', device: 'Device' },
  picker: 'Simulator device',
  booted: 'booted',
  switching: 'switching…',
  captureFailed: 'Screenshot failed',
  actionFailed: 'Action failed',
}

const ZH: PanelCopy = {
  language: 'zh',
  title: 'iOS 模拟器',
  connecting: '连接中…',
  live: '实时',
  offline: '离线',
  noDevice: '没有实时画面——用 ios_sim_boot 启动一台模拟器，或在上方选择设备。',
  home: '回到桌面',
  homeHint: '回到桌面 · 双击打开后台 App',
  screenshot: '截图',
  rotate: '旋转',
  refresh: '刷新',
  deviceActions: '设备操作…',
  actions: {
    'app-switcher': '后台 App',
    lock: '锁屏',
    unlock: '解锁',
    shake: '摇一摇',
    siri: 'Siri',
    'action-button': 'Action 按钮',
    're-center': '窗口重新居中',
  },
  size: '模拟器显示大小',
  frame: '模拟器边框样式',
  frameStyles: { none: '无框', bezel: '边框', device: '真机框' },
  picker: '模拟器设备',
  booted: '已启动',
  switching: '切换中…',
  captureFailed: '截图失败',
  actionFailed: '操作失败',
}

export function copyFor(language: string | undefined): PanelCopy {
  return (language ?? '').toLowerCase().startsWith('zh') ? ZH : EN
}
```

- [ ] **Step 6: 运行纯函数测试**

Run: `npm test && npm run typecheck`
Expected：panel-client 的 5 个测试 PASS；typecheck 无错误。

- [ ] **Step 7: 写 `src/panel/client/index.html`**

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>iOS Simulator</title>
  <link rel="stylesheet" href="/styles.css">
  <script type="module" src="/main.js"></script>
</head>
<body>
  <header class="topbar">
    <select id="device-picker"></select>
    <span id="status" class="status" role="status" data-kind="connecting"></span>
  </header>
  <nav class="toolbar">
    <button id="btn-home" type="button"></button>
    <button id="btn-screenshot" type="button"></button>
    <button id="btn-rotate" type="button"></button>
    <select id="device-action"></select>
    <button id="btn-refresh" type="button"></button>
    <span class="spacer"></span>
    <select id="size-mode"></select>
    <select id="frame-style"></select>
  </nav>
  <main class="stage" id="stage">
    <div class="frame" id="frame">
      <div class="screen" id="screen">
        <img id="stream" alt="" draggable="false">
      </div>
    </div>
    <p id="placeholder" class="placeholder" hidden></p>
  </main>
</body>
</html>
```

- [ ] **Step 8: 写 `src/panel/client/styles.css`**

```css
:root {
  color-scheme: light dark;
  --bg: #0f1117;
  --bar: #171a23;
  --line: #2a2e3a;
  --text: #f5f5f5;
  --muted: #9aa0ab;
  --live: #34c759;
  --warn: #ff9f0a;
  --bad: #ff453a;
}
@media (prefers-color-scheme: light) {
  :root { --bg: #f5f5f7; --bar: #ffffff; --line: #d9d9de; --text: #1d1d1f; --muted: #6e6e73; }
}
* { box-sizing: border-box; margin: 0; }
html, body { height: 100%; }
body {
  display: flex;
  flex-direction: column;
  background: var(--bg);
  color: var(--text);
  font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  overflow: hidden;
}
.topbar, .toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: var(--bar);
  border-bottom: 1px solid var(--line);
}
.topbar select { flex: 1; min-width: 0; }
.spacer { flex: 1; }
select, button {
  font: inherit;
  color: var(--text);
  background: transparent;
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 4px 8px;
}
button { display: inline-flex; align-items: center; justify-content: center; cursor: pointer; }
button:hover, select:hover { border-color: var(--muted); }
.status { white-space: nowrap; color: var(--muted); }
.status::before {
  content: "";
  display: inline-block;
  width: 8px;
  height: 8px;
  margin-right: 6px;
  border-radius: 50%;
  background: var(--warn);
}
.status[data-kind="live"]::before { background: var(--live); }
.status[data-kind="offline"]::before { background: var(--bad); }
.stage {
  position: relative;
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  overflow: auto;
}
.frame { flex: none; }
.frame[data-style="bezel"] { background: #1c1c1e; border: 1px solid #3a3a3c; }
.frame[data-style="device"] {
  background: linear-gradient(145deg, #2c2c2e, #111);
  border: 1px solid #48484a;
  box-shadow: 0 20px 60px rgb(0 0 0 / 45%);
}
.screen {
  position: relative;
  overflow: hidden;
  background: #000;
  touch-action: none;
  user-select: none;
  cursor: pointer;
}
.screen img {
  position: absolute;
  left: 50%;
  top: 50%;
  display: block;
  max-width: none;
  pointer-events: none;
  transform-origin: center center;
}
.placeholder { position: absolute; left: 16px; right: 16px; bottom: 16px; text-align: center; color: var(--muted); }
```

- [ ] **Step 9: 写 `src/panel/client/main.ts`**

```ts
/**
 * Browser entry for the live panel: the MJPEG <img>, pointer → serve-sim
 * touch frames over /ws, the toolbar, the device picker and the size/frame
 * controls. Behaviour follows dsh-ios's React sim-panel in plain DOM code.
 * @module ios-simulator/panel/client/main
 */

import { copyFor, type DeviceActionId } from './copy.js'
import {
  FALLBACK_BASE,
  FRAME_STYLES,
  SIZE_OPTIONS,
  frameInset,
  framePadding,
  frameStyleOf,
  framebufferPoint,
  orientationLayout,
  screenRadius,
  screenWidthFor,
  sizeModeId,
  sizeModeOf,
  type FrameStyle,
  type SizeMode,
} from './layout.js'
import {
  nextSimRotateOrientation,
  normalizePointerPoint,
  parseSimConfigFrame,
  simButtonFrame,
  simRotateFrame,
  simTouchFrame,
  type SimPoint,
} from './protocol.js'

const copy = copyFor(navigator.language)
const RECONNECT_DELAYS_MS = [1000, 2000, 5000]
const DEVICE_ACTION_IDS: readonly DeviceActionId[] = ['app-switcher', 'lock', 'unlock', 'shake', 'siri', 'action-button', 're-center']
const SVG_ATTRS = 'viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"'
const ICONS = {
  home: `<svg ${SVG_ATTRS}><path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/></svg>`,
  screenshot: `<svg ${SVG_ATTRS}><path d="M4 7h3l2-3h6l2 3h3v13H4z"/><circle cx="12" cy="13" r="4"/></svg>`,
  rotate: `<svg ${SVG_ATTRS}><path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v6h-6"/></svg>`,
  refresh: `<svg ${SVG_ATTRS}><path d="M3 12a9 9 0 0 1 15.5-6.3L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15.5 6.3L3 16"/><path d="M3 21v-5h5"/></svg>`,
}

function element<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id)
  if (node === null) throw new Error(`panel markup is missing #${id}`)
  return node as T
}

const ui = {
  picker: element<HTMLSelectElement>('device-picker'),
  status: element<HTMLSpanElement>('status'),
  home: element<HTMLButtonElement>('btn-home'),
  shot: element<HTMLButtonElement>('btn-screenshot'),
  rotate: element<HTMLButtonElement>('btn-rotate'),
  action: element<HTMLSelectElement>('device-action'),
  refresh: element<HTMLButtonElement>('btn-refresh'),
  size: element<HTMLSelectElement>('size-mode'),
  frameStyle: element<HTMLSelectElement>('frame-style'),
  stage: element<HTMLElement>('stage'),
  frame: element<HTMLDivElement>('frame'),
  screen: element<HTMLDivElement>('screen'),
  img: element<HTMLImageElement>('stream'),
  placeholder: element<HTMLParagraphElement>('placeholder'),
}

interface PanelState {
  orientation: string
  sizeMode: SizeMode
  frameStyle: FrameStyle
  deviceName: string
  ws: WebSocket | undefined
  streamFailures: number
  dragging: boolean
  pendingMove: SimPoint | undefined
  moveScheduled: boolean
}

const state: PanelState = {
  orientation: 'portrait',
  sizeMode: sizeModeOf(localStorage.getItem('ios-sim.size')),
  frameStyle: frameStyleOf(localStorage.getItem('ios-sim.frame')),
  deviceName: '',
  ws: undefined,
  streamFailures: 0,
  dragging: false,
  pendingMove: undefined,
  moveScheduled: false,
}

function setStatus(kind: 'connecting' | 'live' | 'offline', message?: string): void {
  ui.status.dataset.kind = kind
  const label = message ?? (kind === 'live' ? copy.live : kind === 'connecting' ? copy.connecting : copy.offline)
  ui.status.textContent = state.deviceName === '' ? label : `${state.deviceName} · ${label}`
}

function report(prefix: string, error: unknown): void {
  setStatus('offline', `${prefix}: ${error instanceof Error ? error.message : String(error)}`)
}

// ── layout ────────────────────────────────────────────────────────────────────

function applyLayout(): void {
  const baseW = ui.img.naturalWidth > 0 ? ui.img.naturalWidth : FALLBACK_BASE.width
  const baseH = ui.img.naturalHeight > 0 ? ui.img.naturalHeight : FALLBACK_BASE.height
  const layout = orientationLayout(state.orientation, baseW, baseH)
  const stage = ui.stage.getBoundingClientRect()
  const width = screenWidthFor(state.sizeMode, layout, { width: stage.width - 32, height: stage.height - 32 }, state.frameStyle)
  const height = Math.round(width * layout.displayH / layout.displayW)
  const scale = width / layout.displayW
  ui.screen.style.width = `${width}px`
  ui.screen.style.height = `${height}px`
  ui.img.style.width = `${Math.round(baseW * scale)}px`
  ui.img.style.height = `${Math.round(baseH * scale)}px`
  ui.img.style.transform = `translate(-50%, -50%) rotate(${layout.rotationDeg}deg)`
  const radius = screenRadius(width, height)
  ui.screen.style.borderRadius = `${radius}px`
  ui.frame.dataset.style = state.frameStyle
  ui.frame.style.padding = `${framePadding(state.frameStyle)}px`
  ui.frame.style.borderRadius = state.frameStyle === 'none' ? '0' : `${radius + frameInset(state.frameStyle)}px`
}

// ── live stream ───────────────────────────────────────────────────────────────

let reconnectTimer: number | undefined
let frameWatch: number | undefined

function onLive(): void {
  window.clearInterval(frameWatch)
  state.streamFailures = 0
  ui.placeholder.hidden = true
  setStatus('live')
  applyLayout()
}

function startStream(): void {
  window.clearTimeout(reconnectTimer)
  window.clearInterval(frameWatch)
  setStatus('connecting')
  ui.img.src = `/stream?t=${Date.now()}`
  // A multipart MJPEG body may never fire `load`; the first decoded frame sets naturalWidth.
  frameWatch = window.setInterval(() => {
    if (ui.img.naturalWidth > 0) onLive()
  }, 300)
}

ui.img.addEventListener('load', onLive)
ui.img.addEventListener('error', () => {
  window.clearInterval(frameWatch)
  const delay = RECONNECT_DELAYS_MS[Math.min(state.streamFailures, RECONNECT_DELAYS_MS.length - 1)] ?? 5000
  state.streamFailures += 1
  setStatus('offline')
  ui.placeholder.hidden = false
  ui.placeholder.textContent = copy.noDevice
  reconnectTimer = window.setTimeout(() => { void refreshStatus().finally(startStream) }, delay)
})

// ── control socket ────────────────────────────────────────────────────────────

function connectWs(): void {
  const ws = new WebSocket(`ws://${location.host}/ws`)
  ws.binaryType = 'arraybuffer'
  state.ws = ws
  ws.addEventListener('message', event => {
    const config = parseSimConfigFrame(event.data)
    if (config === undefined || config.orientation === state.orientation) return
    state.orientation = config.orientation
    applyLayout()
  })
  ws.addEventListener('close', () => {
    if (state.ws === ws) state.ws = undefined
    window.setTimeout(connectWs, 2000)
  })
}

function send(frame: Uint8Array): void {
  const ws = state.ws
  if (ws !== undefined && ws.readyState === WebSocket.OPEN) ws.send(frame)
}

// ── touch ─────────────────────────────────────────────────────────────────────

function pointerPoint(event: PointerEvent): SimPoint {
  return framebufferPoint(state.orientation, normalizePointerPoint(event, ui.screen.getBoundingClientRect()))
}

ui.screen.addEventListener('pointerdown', event => {
  if (event.button !== 0) return
  event.preventDefault()
  ui.screen.setPointerCapture(event.pointerId)
  state.dragging = true
  const point = pointerPoint(event)
  send(simTouchFrame('begin', point.x, point.y))
})

ui.screen.addEventListener('pointermove', event => {
  if (!state.dragging) return
  state.pendingMove = pointerPoint(event)
  if (state.moveScheduled) return
  state.moveScheduled = true
  requestAnimationFrame(() => {
    state.moveScheduled = false
    const point = state.pendingMove
    if (point !== undefined && state.dragging) send(simTouchFrame('move', point.x, point.y))
  })
})

function endTouch(event: PointerEvent): void {
  if (!state.dragging) return
  state.dragging = false
  const point = pointerPoint(event)
  send(simTouchFrame('end', point.x, point.y))
}
ui.screen.addEventListener('pointerup', endTouch)
ui.screen.addEventListener('pointercancel', endTouch)

// ── toolbar ───────────────────────────────────────────────────────────────────

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const value = await response.json().catch(() => ({})) as { error?: string }
  if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`)
  return value as T
}

ui.home.addEventListener('click', () => send(simButtonFrame('home')))
ui.home.addEventListener('dblclick', () => {
  void postJson('/api/device-action', { action: 'app-switcher' }).catch(error => report(copy.actionFailed, error))
})
ui.shot.addEventListener('click', () => {
  void postJson<{ url: string }>('/api/capture', {})
    .then(({ url }) => { window.open(url, '_blank', 'noopener') })
    .catch(error => report(copy.captureFailed, error))
})
ui.rotate.addEventListener('click', () => {
  const next = nextSimRotateOrientation(state.orientation)
  send(simRotateFrame(next))
  state.orientation = next
  applyLayout()
})
ui.action.addEventListener('change', () => {
  const action = ui.action.value
  ui.action.value = ''
  if (action !== '') void postJson('/api/device-action', { action }).catch(error => report(copy.actionFailed, error))
})
ui.refresh.addEventListener('click', () => {
  state.streamFailures = 0
  startStream()
})
ui.size.addEventListener('change', () => {
  state.sizeMode = sizeModeOf(ui.size.value)
  localStorage.setItem('ios-sim.size', ui.size.value)
  applyLayout()
})
ui.frameStyle.addEventListener('change', () => {
  state.frameStyle = frameStyleOf(ui.frameStyle.value)
  localStorage.setItem('ios-sim.frame', state.frameStyle)
  applyLayout()
})
ui.picker.addEventListener('focus', () => { void loadDevices() })
ui.picker.addEventListener('change', () => {
  setStatus('connecting', copy.switching)
  void postJson('/api/switch-device', { udid: ui.picker.value })
    .then(() => refreshStatus())
    .then(startStream)
    .catch(error => report(copy.actionFailed, error))
})

// ── devices & status ──────────────────────────────────────────────────────────

interface DeviceRow {
  udid: string
  name: string
  runtime: string
  state: string
}

function runtimeLabel(runtime: string): string {
  const match = /SimRuntime\.([A-Za-z]+)-(\d+)-(\d+)/u.exec(runtime)
  return match === null ? runtime : `${match[1] ?? ''} ${match[2] ?? ''}.${match[3] ?? ''}`
}

function option(value: string, label: string): HTMLOptionElement {
  const node = document.createElement('option')
  node.value = value
  node.textContent = label
  return node
}

async function loadDevices(): Promise<void> {
  const response = await fetch('/api/devices')
  if (!response.ok) return
  const { devices, streaming } = await response.json() as { devices: DeviceRow[]; streaming?: string }
  ui.picker.replaceChildren(...devices.map(device => {
    const node = option(device.udid, `${device.name} · ${runtimeLabel(device.runtime)}${device.state === 'Booted' ? ` · ${copy.booted}` : ''}`)
    node.selected = device.udid === streaming
    return node
  }))
}

async function refreshStatus(): Promise<void> {
  const response = await fetch('/api/status')
  if (!response.ok) return
  const status = await response.json() as { running: boolean; deviceName?: string }
  state.deviceName = status.deviceName ?? ''
  if (!status.running && ui.status.dataset.kind === 'live') setStatus('offline')
}

// ── start ─────────────────────────────────────────────────────────────────────

function initControls(): void {
  document.title = copy.title
  document.documentElement.lang = copy.language
  const buttons: Array<[HTMLButtonElement, string, string]> = [
    [ui.home, ICONS.home, copy.homeHint],
    [ui.shot, ICONS.screenshot, copy.screenshot],
    [ui.rotate, ICONS.rotate, copy.rotate],
    [ui.refresh, ICONS.refresh, copy.refresh],
  ]
  for (const [button, icon, label] of buttons) {
    button.innerHTML = icon
    button.title = label
    button.setAttribute('aria-label', label)
  }
  ui.action.replaceChildren(option('', copy.deviceActions), ...DEVICE_ACTION_IDS.map(id => option(id, copy.actions[id])))
  ui.size.replaceChildren(...SIZE_OPTIONS.map(entry => option(entry.id, copy.language === 'zh' ? entry.zh : entry.en)))
  ui.size.value = sizeModeId(state.sizeMode)
  ui.frameStyle.replaceChildren(...FRAME_STYLES.map(style => option(style, copy.frameStyles[style])))
  ui.frameStyle.value = state.frameStyle
  ui.size.title = copy.size
  ui.frameStyle.title = copy.frame
  ui.picker.title = copy.picker
}

initControls()
new ResizeObserver(() => applyLayout()).observe(ui.stage)
applyLayout()
void loadDevices()
void refreshStatus().finally(startStream)
connectWs()
window.setInterval(() => { void refreshStatus() }, 5000)
```

- [ ] **Step 10: 确认网页能打包**

Run: `npx esbuild src/panel/client/main.ts --bundle --format=esm --platform=browser --outfile=/tmp/ios-sim-panel-check.js && npm run typecheck`
Expected：esbuild 打印产物大小、无错误；typecheck 无错误。

- [ ] **Step 11: 提交**

```bash
git add src/panel/client test/panel-client.test.ts
git commit -q -m "feat: live panel page — MJPEG view, touch relay, toolbar, sizes and frames

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 17: 组装 MCP 服务、打包并检查 bundle

**Files:**
- Create: `src/server.ts`、`scripts/check-bundle.mjs`、`test/mcp-protocol.test.ts`
- Create（构建产物，提交）：`dist/server.js`、`dist/panel/index.html`、`dist/panel/main.js`、`dist/panel/styles.css`

**Interfaces:**
- Consumes：前面所有任务的导出
- Produces：`dist/server.js`（插件清单 `.claude-plugin/plugin.json` 启动的就是它）

- [ ] **Step 1: 写失败的测试 `test/mcp-protocol.test.ts`**

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

const EXPECTED_TOOLS = [
  'ios_sim_appearance',
  'ios_sim_boot',
  'ios_sim_build_run',
  'ios_sim_devices',
  'ios_sim_install_app',
  'ios_sim_interact',
  'ios_sim_launch_app',
  'ios_sim_list_apps',
  'ios_sim_location',
  'ios_sim_open_url',
  'ios_sim_panel',
  'ios_sim_push',
  'ios_sim_record',
  'ios_sim_screenshot',
  'ios_sim_shutdown',
  'ios_sim_uninstall_app',
]

function childEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value
  }
  env.IOS_SIM_CACHE_DIR = mkdtempSync(join(tmpdir(), 'ios-sim-proto-'))
  env.IOS_SIM_PANEL_PORT = '3556'
  return env
}

test('the stdio MCP server lists the 16 ios_sim tools and answers calls', async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', join(ROOT, 'src/server.ts')],
    cwd: ROOT,
    env: childEnv(),
    stderr: 'pipe',
  })
  const client = new Client({ name: 'protocol-test', version: '0.0.0' })
  await client.connect(transport)
  try {
    const { tools } = await client.listTools()
    assert.deepEqual(tools.map(tool => tool.name).sort(), EXPECTED_TOOLS)
    const devices = (await client.callTool({ name: 'ios_sim_devices', arguments: {} })) as CallToolResult
    assert.notEqual(devices.isError, true)
    const invalid = (await client.callTool({ name: 'ios_sim_interact', arguments: { action: 'explode' } })) as CallToolResult
    assert.equal(invalid.isError, true)
  } finally {
    await client.close()
  }
})
```

- [ ] **Step 2: 运行，确认失败**

Run: `npm test`
Expected: FAIL，客户端连接失败（子进程找不到 `src/server.ts`）。

- [ ] **Step 3: 写 `src/server.ts`**

```ts
/**
 * MCP entry point: wires the real modules into the ios_sim_* tools and the
 * live panel, serves them over stdio, and tears everything down on exit
 * (recordings are finalized, the serve-sim process group is killed).
 * @module ios-simulator/server
 */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { listSimulatorApps } from './app-list.js'
import { buildRun, detectProject, readBundleIdentifier } from './build-run.js'
import { cacheRoot, INTERACT_SETTLE_MS, PLUGIN_NAME, preferredPanelPort, SERVER_VERSION } from './config.js'
import type { ToolDeps } from './deps.js'
import { PanelServer } from './panel/panel-server.js'
import { Recorder } from './recorder.js'
import { ScreenshotStore } from './screenshot.js'
import { SimHostController } from './sim-host.js'
import * as simctl from './simctl.js'
import { SimStreamSource } from './stream-source.js'
import { registerAppTools } from './tools/apps.js'
import { registerCoreTools } from './tools/core.js'
import { registerEnvTools } from './tools/env.js'

async function main(): Promise<void> {
  const root = cacheRoot()
  const host = new SimHostController()
  host.startKeepAlive()
  const stream = new SimStreamSource(host)
  const screenshots = new ScreenshotStore({ dir: join(root, 'screenshots'), takeScreenshot: simctl.takeScreenshot })
  const recorder = new Recorder({ dir: join(root, 'recordings') })
  const panel = new PanelServer({
    // In the bundle this resolves to dist/panel (built by scripts/build.mjs).
    staticDir: join(dirname(fileURLToPath(import.meta.url)), 'panel'),
    preferredPort: preferredPanelPort(),
    host,
    stream,
    simctl,
    screenshots,
  })
  const deps: ToolDeps = {
    host,
    stream,
    simctl,
    screenshots,
    panel,
    recorder,
    builder: { detectProject, buildRun, readBundleIdentifier },
    listApps: listSimulatorApps,
    cacheRoot: root,
    platform: process.platform,
    settleMs: INTERACT_SETTLE_MS,
  }
  const server = new McpServer({ name: PLUGIN_NAME, version: SERVER_VERSION })
  registerCoreTools(server, deps)
  registerAppTools(server, deps)
  registerEnvTools(server, deps)

  let shuttingDown = false
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    await recorder.stopAll().catch(() => undefined)
    await host.dispose().catch(() => undefined)
    await panel.dispose().catch(() => undefined)
    process.exit(0)
  }
  process.stdin.on('end', () => { void shutdown() })
  process.stdin.on('close', () => { void shutdown() })
  process.on('SIGTERM', () => { void shutdown() })
  process.on('SIGINT', () => { void shutdown() })
  server.server.onclose = () => { void shutdown() }

  await server.connect(new StdioServerTransport())
  process.stderr.write(`${PLUGIN_NAME} MCP server ready (serve-sim: ${host.status().serveSimSource})\n`)
}

main().catch((error: unknown) => {
  process.stderr.write(`${PLUGIN_NAME}: fatal: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`)
  process.exit(1)
})
```

- [ ] **Step 4: 运行，确认通过**

Run: `npm test && npm run typecheck`
Expected：全部测试 PASS（含 mcp-protocol），typecheck 无错误。

- [ ] **Step 5: 写 `scripts/check-bundle.mjs`**

```js
// Smoke-checks the committed bundle: starts dist/server.js over stdio, lists its tools,
// and makes sure the panel assets sit next to it.
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
for (const file of ['server.js', 'panel/index.html', 'panel/main.js', 'panel/styles.css']) {
  if (!existsSync(join(root, 'dist', file))) {
    console.error(`missing dist/${file} — run npm run build`)
    process.exit(1)
  }
}
const env = Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined))
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(root, 'dist/server.js')],
  cwd: root,
  env: { ...env, IOS_SIM_CACHE_DIR: mkdtempSync(join(tmpdir(), 'ios-sim-bundle-')), IOS_SIM_PANEL_PORT: '3557' },
  stderr: 'inherit',
})
const client = new Client({ name: 'check-bundle', version: '0.0.0' })
await client.connect(transport)
const { tools } = await client.listTools()
await client.close()
if (tools.length !== 16) {
  console.error(`expected 16 tools, got ${tools.length}: ${tools.map(tool => tool.name).join(', ')}`)
  process.exit(1)
}
console.log(`bundle OK: ${tools.length} tools`)
```

- [ ] **Step 6: 构建并检查 bundle**

Run: `npm run build && npm run check:bundle && ls dist dist/panel`
Expected：`built dist/server.js and dist/panel/`；stderr 打印 `ios-simulator MCP server ready (serve-sim: package-bin)`；stdout 打印 `bundle OK: 16 tools`；`dist` 下有 `server.js` 和 `panel/{index.html,main.js,styles.css}`。

- [ ] **Step 7: 确认 src 里没有 shell 字符串执行**

Run: `grep -rnE "\bexec(Sync)?\(" src || echo "no shell exec"`
Expected：`no shell exec`。

- [ ] **Step 8: 提交（包含 dist）**

```bash
git add src/server.ts scripts/check-bundle.mjs test/mcp-protocol.test.ts dist
git commit -q -m "feat: wire the MCP server and commit the esbuild bundle

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 18: Skill 与 README

**Files:**
- Create: `skills/ios-ui-automation/SKILL.md`
- Modify（整体重写）: `README.md`

**Interfaces:**
- Consumes：16 个工具名与参数（Task 11–13）、`panelUrl` 约定（Task 11）
- Produces：插件自动发现的 skill `ios-ui-automation`

- [ ] **Step 1: 写 `skills/ios-ui-automation/SKILL.md`**

```markdown
---
name: ios-ui-automation
description: Use when operating an iOS Simulator through this plugin's ios_sim_* tools — booting a device, opening the live panel, launching or building apps, tapping, typing, scrolling, and checking what is on screen.
---

# Driving the iOS Simulator with the ios_sim_* tools

The loop is **observe once → act → read the result the action returns**. Every `ios_sim_interact` call already returns a screenshot of its effect (unless you pass `screenshot: false`), so a separate `ios_sim_screenshot` after each action is wasted work.

## Getting a device and the live panel

1. `ios_sim_devices` lists simulators, booted first. Use a udid or the exact name ("iPhone 17 Pro").
2. `ios_sim_boot` boots it and starts the live stream; the result carries `panelUrl`.
3. Open the panel for the user **once per session**: in the Claude desktop app call the browser tool `preview_start` with `{ "url": "<panelUrl>" }`; in a terminal-only session, print the URL for the user. `ios_sim_panel` returns the URL again later and never boots a device.
4. The user can tap, drag, press Home, rotate and take screenshots in the panel; your tool calls and their clicks drive the same simulator.

## Reading the screen

- `ios_sim_screenshot` returns a JPEG you can look at (long edge at most 1024 px) plus JSON with the full-resolution PNG path.
- Tap coordinates are normalized to the image you were given: `x = pixelX / image.width`, `y = pixelY / image.height` (the JSON repeats `image.width` and `image.height`). Aim at the centre of a control.

## Acting

| Want to… | Call |
| --- | --- |
| tap | `ios_sim_interact {action:"tap", x, y}` |
| type ASCII into the focused field | `ios_sim_interact {action:"type", text}` |
| scroll | `ios_sim_interact {action:"scroll", direction}` — direction names the CONTENT: `down` reveals what is below (the finger moves up) |
| drag or swipe | `ios_sim_interact {action:"gesture", json:{fromX, fromY, toX, toY, duration}}` |
| go home | `ios_sim_interact {action:"button", name:"home"}` |
| rotate | `ios_sim_interact {action:"rotate", orientation:"landscape_left"}` |
| app switcher, lock, unlock, shake, Siri | `ios_sim_interact {action:"device_action", name}` |

- Chaining actions (tap a field, type, tap Done)? Pass `screenshot:false` on all but the last one.
- `type` only supports US-keyboard ASCII. For Chinese, emoji or other text run `printf '%s' '中文' | xcrun simctl pbcopy <udid>` in Bash, then long-press the field and tap Paste.
- Every `device_action` except `lock` drives Simulator.app's menu through AppleScript and needs the Accessibility permission for the app running Claude. If one fails with that hint, tell the user instead of retrying.
- With Xcode 27, keyboard input also needs Device Hub running with the simulator visible and frontmost. `serve-sim repair-input -d <udid>` revives dead input but restarts SpringBoard — ask the user before running it.

## Apps

- **Never guess a third-party bundle id.** Use `ios_sim_launch_app {name}` (a case-insensitive display-name substring) or look the id up with `ios_sim_list_apps` first.
- Names on a simulator are the localized ones the user sees (日历, not Calendar); `query` and `name` also match the base English name and the bundle id.
- Stable Apple ids: Calendar `com.apple.mobilecal`, Safari `com.apple.mobilesafari`, Settings `com.apple.Preferences`, Photos `com.apple.mobileslideshow`, Messages `com.apple.MobileSMS`, Maps `com.apple.Maps`, Notes `com.apple.mobilenotes`.
- The app lives on the simulator. Do not search the user's source tree or DerivedData for it. A failed listing is an error to read; `count: 0` means nothing matched.
- `ios_sim_build_run` builds, installs and launches a project, workspace or Swift package. A full build takes minutes; on failure read the error tail it returns instead of re-running blindly.
- Also available: `ios_sim_install_app` (a built .app), `ios_sim_uninstall_app`, `ios_sim_open_url` (deep links), `ios_sim_push` (the payload needs an `aps` object), `ios_sim_location`, `ios_sim_appearance`, `ios_sim_record` (start / stop).

## Scope

These rules cover this plugin's `ios_sim_*` tools. The Claude desktop app's built-in iOS Simulator tool is a different integration; do not mix the two in one task.
```

- [ ] **Step 2: 重写 `README.md`**

```markdown
# iOS Simulator 插件（Claude Code）

在 Claude Code 里驱动 iOS 模拟器：实时画面面板、点击和手势、安装和启动 app、构建运行。核心代码移植自 [dsh-ios](https://github.com/ZSeven-W/dsh-ios)（MIT）。

## 功能

- **实时面板**：serve-sim 的 MJPEG 视频流，可以直接在画面上点击、拖动；工具栏有 Home（双击打开后台 App）、截图、旋转、设备操作、刷新；支持切换设备、尺寸（适应 / 50–125% / S·M·L）和外框（无框 / 边框 / 真机框）。
- **16 个工具**：`ios_sim_devices`、`ios_sim_boot`、`ios_sim_shutdown`、`ios_sim_panel`、`ios_sim_screenshot`、`ios_sim_interact`、`ios_sim_list_apps`、`ios_sim_launch_app`、`ios_sim_build_run`、`ios_sim_install_app`、`ios_sim_uninstall_app`、`ios_sim_open_url`、`ios_sim_push`、`ios_sim_location`、`ios_sim_appearance`、`ios_sim_record`。
- **截图直接给 Claude 看**：JPEG，长边不超过 1024 px。
- **Skill `ios-ui-automation`**：教 Claude 怎么观察、操作、确认，以及哪些事不要做（比如猜 bundle id）。

## 运行要求

- macOS、完整 Xcode、Apple Silicon（serve-sim 只提供 arm64 版本）
- Node.js ≥ 20
- `device_action` 里除锁屏以外的动作需要给运行 Claude 的应用开启“辅助功能”权限

## 安装

开发调试（直接加载本目录）：

~~~bash
claude --plugin-dir ~/Tools/Claude/Projects/ios-simulator-panel
~~~

正式安装（本目录同时是一个本地 marketplace）：

~~~text
/plugin marketplace add ~/Tools/Claude/Projects/ios-simulator-panel
/plugin install ios-simulator@ios-simulator-panel
~~~

## 使用

对 Claude 说“启动 iPhone 17 Pro 模拟器”。`ios_sim_boot` 会返回 `panelUrl`，Claude 会在 Code 标签页的浏览器面板里打开它；在终端里使用时，把这个地址复制到浏览器即可。

## 环境变量

| 变量 | 作用 | 默认值 |
|---|---|---|
| `IOS_SIM_PANEL_PORT` | 面板端口（被占用时依次尝试到 +20） | `3456` |
| `IOS_SIM_CACHE_DIR` | 截图、录屏、构建产物的缓存目录 | `~/Library/Caches/ios-simulator` |
| `IOS_SIM_SERVE_SIM_BIN` | 指定 serve-sim 可执行文件 | 插件自带，找不到时用 `npx -y serve-sim@0.1.47` |

## 开发

~~~bash
npm install
npm test              # 单元与集成测试，不需要模拟器
npm run build         # 类型检查 + 打包 dist/（dist 需要提交）
npm run check:bundle  # 启动 dist/server.js 并确认 16 个工具
IOS_SIM_SMOKE=1 npm run test:live   # 在真实模拟器上冒烟
npm run dev:panel     # 启动一台模拟器并保持面板运行，用于在浏览器里调试
~~~

## 路线图

第 ① 期是本版本。之后依次是：② UI 自动化（AXe 无障碍树 + Vision OCR）、③ 日志与调试、④ SwiftUI 预览热重载、⑤ USB 真机（WebDriverAgent）。

## 致谢与许可

- [dsh-ios](https://github.com/ZSeven-W/dsh-ios)（MIT，© 2026 ZSeven—W）：serve-sim 生命周期、手势、设备动作、app 列表、构建流程、面板协议与布局都移植自这里，见 `THIRD_PARTY_NOTICES.md`。
- [serve-sim](https://github.com/EvanBacon/serve-sim)（Apache-2.0）：视频流与触控。
- 许可：MIT
```

- [ ] **Step 3: 检查 skill frontmatter 与 README 命令**

Run: `head -4 skills/ios-ui-automation/SKILL.md && grep -c "ios_sim_" README.md`
Expected：前 4 行是 `---`、`name: ios-ui-automation`、`description: …`、`---`；第二个命令输出大于 16。

- [ ] **Step 4: 提交**

```bash
git add skills README.md
git commit -q -m "docs: ios-ui-automation skill and a Chinese README for the plugin

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 19: 真机冒烟、面板验收与插件加载检查

**Files:**
- Create: `test/live/simulator.live.test.ts`、`scripts/dev-panel.mjs`
- Modify: `package.json`（加 `dev:panel` 脚本）

**Interfaces:**
- Consumes：`dist/server.js`（Task 17）
- Produces：`npm run test:live`、`npm run dev:panel`；Task 20 需要的数据：竖屏和横屏截图尺寸

- [ ] **Step 1: 写 `test/live/simulator.live.test.ts`**（默认跳过，`IOS_SIM_SMOKE=1` 才运行）

```ts
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

const LIVE = process.env.IOS_SIM_SMOKE === '1'
const ROOT = fileURLToPath(new URL('../..', import.meta.url))

let client: Client | undefined
let udid = ''
let bootedHere = false

async function call(name: string, args: Record<string, unknown> = {}): Promise<{ result: CallToolResult; body: any }> {
  if (client === undefined) throw new Error('client not connected')
  const result = (await client.callTool({ name, arguments: args })) as CallToolResult
  const first = result.content[0]
  const text = first !== undefined && first.type === 'text' ? first.text : ''
  if (result.isError === true) throw new Error(`${name} failed: ${text}`)
  return { result, body: JSON.parse(text) }
}

before(async () => {
  if (!LIVE) return
  const env = Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined)) as Record<string, string>
  client = new Client({ name: 'live-smoke', version: '0.0.0' })
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [join(ROOT, 'dist/server.js')],
    cwd: ROOT,
    env: { ...env, IOS_SIM_CACHE_DIR: mkdtempSync(join(tmpdir(), 'ios-sim-live-')), IOS_SIM_PANEL_PORT: '3656' },
    stderr: 'inherit',
  }))
})

after(async () => {
  if (!LIVE) return
  if (bootedHere && udid !== '') await call('ios_sim_shutdown', { udid }).catch(() => undefined)
  await client?.close()
})

test('live: boot, panel, screenshot, input, rotate, record', { skip: LIVE ? false : 'set IOS_SIM_SMOKE=1 to run on a real simulator', timeout: 600_000 }, async () => {
  const { body: list } = await call('ios_sim_devices', { query: process.env.IOS_SIM_SMOKE_DEVICE ?? 'iPhone' })
  const device = list.devices[0]
  assert.ok(device !== undefined, 'no iPhone simulator found')
  udid = device.udid
  bootedHere = device.state !== 'Booted'

  const { body: boot } = await call('ios_sim_boot', { udid })
  assert.equal(boot.streaming, true)
  assert.equal((await fetch(boot.panelUrl)).status, 200)
  const status = await (await fetch(new URL('/api/status', boot.panelUrl))).json() as { running: boolean }
  assert.equal(status.running, true)

  const portrait = await call('ios_sim_screenshot', { udid })
  assert.ok(portrait.result.content.some(block => block.type === 'image'))
  console.log(`portrait screenshot: ${portrait.body.width}x${portrait.body.height}, model image ${portrait.body.image.width}x${portrait.body.image.height}`)

  await call('ios_sim_interact', { udid, action: 'button', name: 'home', screenshot: false })
  await call('ios_sim_interact', { udid, action: 'tap', x: 0.5, y: 0.5, screenshot: false })
  const scroll = await call('ios_sim_interact', { udid, action: 'scroll', direction: 'down', screenshot: false })
  assert.equal(scroll.body.delivery.channel, 'ws', `scroll fell back to the CLI: ${String(scroll.body.delivery.wsError)}`)

  await call('ios_sim_launch_app', { udid, bundleId: 'com.apple.mobilesafari' })
  await call('ios_sim_interact', { udid, action: 'rotate', orientation: 'landscape_left', screenshot: false })
  await new Promise(resolve => setTimeout(resolve, 1500))
  const landscape = await call('ios_sim_screenshot', { udid })
  console.log(`landscape screenshot: ${landscape.body.width}x${landscape.body.height}, model image ${landscape.body.image.width}x${landscape.body.image.height}`)
  await call('ios_sim_interact', { udid, action: 'rotate', orientation: 'portrait', screenshot: false })

  const started = await call('ios_sim_record', { udid, action: 'start' })
  assert.equal(started.body.recording, true)
  await new Promise(resolve => setTimeout(resolve, 2000))
  const stopped = await call('ios_sim_record', { udid, action: 'stop' })
  assert.ok(stopped.body.bytes > 0)
})
```

- [ ] **Step 2: 写 `scripts/dev-panel.mjs`，并在 `package.json` 的 `scripts` 里加 `"dev:panel": "node scripts/dev-panel.mjs"`**

```js
// Dev helper: start dist/server.js, boot a simulator and keep the live panel up until Ctrl+C.
// Usage: npm run dev:panel -- "iPhone 17 Pro"
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const query = process.argv[2] ?? 'iPhone'
const env = Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined))
const client = new Client({ name: 'dev-panel', version: '0.0.0' })
await client.connect(new StdioClientTransport({
  command: process.execPath,
  args: [join(root, 'dist/server.js')],
  cwd: root,
  env,
  stderr: 'inherit',
}))
const textOf = result => (result.content[0]?.type === 'text' ? result.content[0].text : '')
const list = JSON.parse(textOf(await client.callTool({ name: 'ios_sim_devices', arguments: { query } })))
const device = list.devices[0]
if (device === undefined) {
  console.error(`no simulator matches "${query}"`)
  process.exit(1)
}
const boot = await client.callTool({ name: 'ios_sim_boot', arguments: { udid: device.udid } })
if (boot.isError === true) {
  console.error(textOf(boot))
  process.exit(1)
}
console.log(`panel: ${JSON.parse(textOf(boot)).panelUrl} (${device.name}) — Ctrl+C to stop`)
const stop = async () => {
  await client.close()
  process.exit(0)
}
process.on('SIGINT', () => { void stop() })
process.on('SIGTERM', () => { void stop() })
setInterval(() => {}, 1 << 30)
```

- [ ] **Step 3: 跑真机冒烟**

Run: `npm run build && IOS_SIM_SMOKE=1 npm run test:live`
Expected：`# pass 1`。日志里有两行 `portrait screenshot: WxH…` 和 `landscape screenshot: WxH…`，**把这两行记下来，Task 20 会用到**。如果失败：
- `scroll fell back to the CLI` → 看 `wsError`，确认 serve-sim 握手里的 `wsUrl` 可以连接；
- `ios_sim_boot` 超时 → 看 stderr 里 serve-sim 的输出（第一次用 npx 需要联网）。

- [ ] **Step 4: 在浏览器面板里验收**

1. 用 Bash 后台运行 `npm run dev:panel`，从输出里读取 `panel: http://127.0.0.1:<port>/`。
2. 用浏览器工具 `preview_start`，参数 `{ "url": "<panelUrl>" }` 打开面板，截图确认：有实时画面，状态点为绿色、文字为“实时 / live”。
3. 点击工具栏 Home，再点击画面上的“设置”图标，1 秒后截图：确认进入了设置。
4. 点击旋转按钮，截图确认画面横过来且内容是正的；再点三次回到竖屏。
5. 点击截图按钮，确认新标签页打开了 PNG。
6. 结束后台的 `dev:panel` 进程。

任何一步不符合预期，就先按 superpowers:systematic-debugging 排查，修好后重新构建再验收。

- [ ] **Step 5: 检查插件能被 Claude Code 加载**

Run: `claude plugin validate . ; claude --plugin-dir . -p "List the names of the tools you can call that start with ios_sim_, one per line, and nothing else." --output-format text`
Expected：validate 没有报错；第二个命令列出 16 个 `ios_sim_*` 工具（工具名可能带 `mcp__plugin_ios-simulator_ios-simulator__` 这样的前缀）。如果本机没有 `claude` 命令，记录下来并跳过这一步，在最终汇报里说明。

- [ ] **Step 6: 提交**

```bash
git add test/live scripts/dev-panel.mjs package.json
git commit -q -m "test: live simulator smoke, dev panel helper and plugin load check

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 20: 横屏下的截图方向与坐标换算

**背景**：serve-sim 的触摸坐标以竖屏帧缓冲为准（dsh-ios 面板在 serve-sim 0.1.45 + iOS 26.4 上实测过）。横屏时，Claude 看到的截图应该是正的，它给出的坐标也就是“正的图片”里的坐标，所以工具要把坐标换算回帧缓冲；如果 `simctl` 截出来的图是侧着的（仍是竖屏形状），还要先把图转正。面板用的是同一个换算函数（`framebufferPoint`），这里直接复用。

**Files:**
- Create: `src/orientation.ts`
- Modify: `src/screenshot.ts`（`toModelImage` 支持旋转）、`src/deps.ts`（`ScreenshotService.toModelImage` 签名）、`src/tools/core.ts`（截图与 interact 读取方向）、`skills/ios-ui-automation/SKILL.md`、`test/live/simulator.live.test.ts`
- Test: `test/orientation.test.ts`、`test/tools-core.test.ts`（追加一个测试）

**Interfaces:**
- Consumes：`framebufferPoint`（Task 16 的 layout.ts）、`parseSimConfigFrame`、`SimScreenConfig`（Task 16 的 protocol.ts）、`simDragRequestOf`（Task 6）、`SimInteractArgs`（Task 7）
- Produces：`isLandscape(orientation)`、`readSimScreenConfig(wsUrl, timeoutMs?)`、`uprightRotation(orientation, png): 0 | 90 | 270`、`toFramebufferArgs(orientation, args): SimInteractArgs`；`ScreenshotService.toModelImage(capture, options?: { rotateDeg?: number })`

- [ ] **Step 1: 写失败的测试 `test/orientation.test.ts`**

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WebSocketServer } from 'ws'
import { readSimScreenConfig, toFramebufferArgs, uprightRotation } from '../src/orientation.js'

test('uprightRotation turns a sideways landscape capture upright and leaves the rest', () => {
  assert.equal(uprightRotation('portrait', { width: 1206, height: 2622 }), 0)
  assert.equal(uprightRotation('landscape_left', { width: 1206, height: 2622 }), 90)
  assert.equal(uprightRotation('landscape_right', { width: 1206, height: 2622 }), 270)
  assert.equal(uprightRotation('landscape_left', { width: 2622, height: 1206 }), 0)
  assert.equal(uprightRotation('landscape_left', {}), 0)
})

test('toFramebufferArgs maps taps, drags and scrolls from upright-image space', () => {
  assert.deepEqual(toFramebufferArgs('portrait', { action: 'tap', x: 0.25, y: 0.75 }), { action: 'tap', x: 0.25, y: 0.75 })
  assert.deepEqual(toFramebufferArgs('landscape_left', { action: 'tap', x: 0.25, y: 0.75 }), { action: 'tap', x: 0.75, y: 0.75 })
  assert.deepEqual(toFramebufferArgs('landscape_right', { action: 'tap', x: 0.25, y: 0.75 }), { action: 'tap', x: 0.25, y: 0.25 })
  assert.deepEqual(
    toFramebufferArgs('landscape_left', { action: 'scroll', direction: 'down' }),
    { action: 'scroll', direction: 'right', x: 0.5, y: 0.5 },
  )
  assert.deepEqual(
    toFramebufferArgs('landscape_right', { action: 'scroll', direction: 'right', x: 0.25, y: 0.5 }),
    { action: 'scroll', direction: 'down', x: 0.5, y: 0.25 },
  )
  // Values exactly representable in binary: 1 - 0.9 !== 0.1 in JS, 1 - 0.75 === 0.25.
  assert.deepEqual(
    toFramebufferArgs('landscape_left', { action: 'gesture', json: { fromX: 0.25, fromY: 0.5, toX: 0.75, toY: 0.5, duration: 0.3 } }),
    { action: 'gesture', json: { fromX: 0.5, fromY: 0.75, toX: 0.5, toY: 0.25, duration: 0.3 } },
  )
  assert.deepEqual(toFramebufferArgs('landscape_left', { action: 'type', text: 'a' }), { action: 'type', text: 'a' })
})

test('readSimScreenConfig returns the first tag-130 frame, or undefined on silence', async () => {
  const talkative = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  talkative.on('connection', socket => {
    socket.send(Buffer.from([4, 123, 125]))
    socket.send(Buffer.concat([Buffer.from([130]), Buffer.from('{"width":1206,"height":2622,"orientation":"landscape_left"}')]))
  })
  await new Promise<void>(resolve => talkative.once('listening', () => resolve()))
  const config = await readSimScreenConfig(`ws://127.0.0.1:${(talkative.address() as { port: number }).port}`)
  assert.deepEqual(config, { width: 1206, height: 2622, orientation: 'landscape_left' })
  talkative.close()

  const silent = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise<void>(resolve => silent.once('listening', () => resolve()))
  assert.equal(await readSimScreenConfig(`ws://127.0.0.1:${(silent.address() as { port: number }).port}`, 100), undefined)
  silent.close()
})
```

核对：landscape_right 时 fb = (1 − y, x)，所以锚点 (0.25, 0.5) → (0.5, 0.25)；landscape_left 时 fb = (y, 1 − x)，所以拖动起点 (0.25, 0.5) → (0.5, 0.75)、终点 (0.75, 0.5) → (0.5, 0.25)。

- [ ] **Step 2: 在 `test/tools-core.test.ts` 末尾追加一个测试**（在文件顶部的 import 区加上 `import { WebSocketServer } from 'ws'`）

```ts
test('in landscape, screenshots come back upright and taps are mapped to the framebuffer', async () => {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  wss.on('connection', socket => {
    socket.send(Buffer.concat([Buffer.from([130]), Buffer.from('{"width":1206,"height":2622,"orientation":"landscape_left"}')]))
  })
  await new Promise<void>(resolve => wss.once('listening', () => resolve()))
  const wsUrl = `ws://127.0.0.1:${(wss.address() as { port: number }).port}`
  const h = await toolHarness(registerCoreTools, { host: { device: 'BBB', wsUrl, exposeStreamInfo: true } })
  const shot = h.json(await h.call('ios_sim_screenshot'))
  assert.equal(shot.orientation, 'landscape_left')
  assert.deepEqual(shot.image, { width: 1024, height: 471 })
  await h.call('ios_sim_interact', { action: 'tap', x: 0.25, y: 0.75, screenshot: false })
  assert.ok(h.hostCalls.some(call => call.join(' ') === 'control tap -d BBB 0.75 0.75'))
  await h.close()
  wss.close()
})
```

- [ ] **Step 3: 运行，确认失败**

Run: `npm test`
Expected: FAIL，`src/orientation.js` 不存在；新的 tools-core 测试失败（没有 `orientation` 字段）。

- [ ] **Step 4: 写 `src/orientation.ts`**

```ts
/**
 * Orientation-aware screenshots and coordinates. serve-sim touches are
 * normalized to the PORTRAIT framebuffer, so in landscape the tools hand the
 * model an UPRIGHT image and map its coordinates back to the framebuffer with
 * the same inverse the panel uses (src/panel/client/layout.ts).
 * @module ios-simulator/orientation
 */

import { WebSocket } from 'ws'
import type { SimInteractArgs } from './interact.js'
import { framebufferPoint } from './panel/client/layout.js'
import { parseSimConfigFrame, type SimScreenConfig } from './panel/client/protocol.js'
import { simDragRequestOf } from './sim-gesture.js'

type Direction = 'up' | 'down' | 'left' | 'right'
type Landscape = 'landscape_left' | 'landscape_right'

export function isLandscape(orientation: string): orientation is Landscape {
  return orientation === 'landscape_left' || orientation === 'landscape_right'
}

/**
 * Control sockets that did not greet with a config frame in time. They are
 * not asked again, so a serve-sim that never sends one costs a single wait
 * per stream instead of one per screenshot (a restarted stream gets a new url).
 */
const silentSockets = new Set<string>()

/** Read serve-sim's current screen config (tag 130) from its control socket. */
export function readSimScreenConfig(wsUrl: string, timeoutMs = 800): Promise<SimScreenConfig | undefined> {
  if (silentSockets.has(wsUrl)) return Promise.resolve(undefined)
  return new Promise(resolve => {
    let settled = false
    const socket = new WebSocket(wsUrl, { perMessageDeflate: false })
    const finish = (config: SimScreenConfig | undefined): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.terminate()
      resolve(config)
    }
    const timer = setTimeout(() => {
      silentSockets.add(wsUrl)
      finish(undefined)
    }, timeoutMs)
    socket.on('message', data => {
      const config = parseSimConfigFrame(data)
      if (config !== undefined) finish(config)
    })
    socket.on('error', () => finish(undefined))
    socket.on('close', () => finish(undefined))
  })
}

/**
 * Clockwise degrees that make a capture upright: a landscape device whose
 * PNG still has the portrait framebuffer's shape was captured sideways.
 */
export function uprightRotation(orientation: string, png: { width?: number; height?: number }): 0 | 90 | 270 {
  if (!isLandscape(orientation) || png.width === undefined || png.height === undefined) return 0
  if (png.width > png.height) return 0
  return orientation === 'landscape_left' ? 90 : 270
}

/** Content direction in upright space → content direction in framebuffer space. */
const SCROLL_DIRECTIONS: Readonly<Record<Landscape, Readonly<Record<Direction, Direction>>>> = {
  landscape_left: { down: 'right', up: 'left', right: 'up', left: 'down' },
  landscape_right: { down: 'left', up: 'right', right: 'down', left: 'up' },
}

/** Map interact args given in UPRIGHT-image coordinates to framebuffer coordinates. */
export function toFramebufferArgs(orientation: string, args: SimInteractArgs): SimInteractArgs {
  if (!isLandscape(orientation)) return args
  const map = (x: number, y: number): { x: number; y: number } => framebufferPoint(orientation, { x, y })
  switch (args.action) {
    case 'tap': {
      if (typeof args.x !== 'number' || typeof args.y !== 'number') return args
      const point = map(args.x, args.y)
      return { ...args, x: point.x, y: point.y }
    }
    case 'scroll': {
      const anchor = map(args.x ?? 0.5, args.y ?? 0.5)
      const direction = args.direction === undefined ? undefined : SCROLL_DIRECTIONS[orientation][args.direction]
      return { ...args, x: anchor.x, y: anchor.y, ...(direction === undefined ? {} : { direction }) }
    }
    case 'gesture': {
      const json = args.json
      if (typeof json !== 'object' || json === null || Array.isArray(json)) return args
      const record = json as Record<string, unknown>
      const drag = simDragRequestOf(record)
      if (drag !== undefined) {
        const from = map(drag.fromX, drag.fromY)
        const to = map(drag.toX, drag.toY)
        return { ...args, json: { ...record, fromX: from.x, fromY: from.y, toX: to.x, toY: to.y } }
      }
      if (typeof record.x === 'number' && typeof record.y === 'number') {
        const point = map(record.x, record.y)
        return { ...args, json: { ...record, x: point.x, y: point.y } }
      }
      return args
    }
    default:
      return args
  }
}
```

- [ ] **Step 5: 让 `toModelImage` 支持旋转。** 在 `src/screenshot.ts` 中：

把方法签名 `async toModelImage(capture: ScreenshotCapture): Promise<ModelImage> {` 改成：

```ts
  async toModelImage(capture: ScreenshotCapture, options: { rotateDeg?: number } = {}): Promise<ModelImage> {
```

并把 `args.push(capture.path, '--out', out)` 这一行替换为：

```ts
    if (options.rotateDeg !== undefined && options.rotateDeg % 360 !== 0) args.push('--rotate', String(options.rotateDeg))
    args.push(capture.path, '--out', out)
```

在 `src/deps.ts` 里把 `ScreenshotService` 的 `toModelImage(capture: ScreenshotCapture): Promise<ModelImage>` 改成：

```ts
  toModelImage(capture: ScreenshotCapture, options?: { rotateDeg?: number }): Promise<ModelImage>
```

- [ ] **Step 6: 在 `src/tools/core.ts` 里接入方向。**

在 import 区加入：

```ts
import { readSimScreenConfig, toFramebufferArgs, uprightRotation } from '../orientation.js'
```

在 `registerCoreTools` 函数的最前面加入：

```ts
  /** serve-sim's orientation for a streamed device; portrait when unknown. */
  const orientationOf = async (udid: string): Promise<string> => {
    const info = deps.host.streamInfo
    if (info === undefined || info.device !== udid) return 'portrait'
    return (await readSimScreenConfig(info.wsUrl))?.orientation ?? 'portrait'
  }
```

在 `ios_sim_screenshot` 的处理函数里，把

```ts
    const capture = await deps.screenshots.capture(device.udid, extra.signal)
    const image = await deps.screenshots.toModelImage(capture)
    return jsonResult({
      path: capture.path,
```

替换为

```ts
    const capture = await deps.screenshots.capture(device.udid, extra.signal)
    const orientation = await orientationOf(device.udid)
    const image = await deps.screenshots.toModelImage(capture, { rotateDeg: uprightRotation(orientation, capture) })
    return jsonResult({
      orientation,
      path: capture.path,
```

在 `ios_sim_interact` 的处理函数里：把 `await ensureStreamFor(deps.host, device)` 之后加一行

```ts
    const orientation = await orientationOf(device.udid)
```

把 `const payloads = interactControlArgs(simArgs)` 以及它下面 `performSimInteract(deps.host, device.udid, simArgs, payloads)` 里的 `simArgs` 换成换算后的参数：

```ts
      const framebufferArgs = toFramebufferArgs(orientation, simArgs)
      const payloads = interactControlArgs(framebufferArgs)
```

```ts
        delivery = await performSimInteract(deps.host, device.udid, framebufferArgs, payloads)
```

最后把效果截图那两行

```ts
    const capture = await deps.screenshots.capture(device.udid, extra.signal)
    const image = await deps.screenshots.toModelImage(capture)
```

替换为（旋转动作刚改变了方向，所以用目标方向）

```ts
    const capture = await deps.screenshots.capture(device.udid, extra.signal)
    const shotOrientation = args.action === 'rotate' && args.orientation !== undefined ? args.orientation : orientation
    const image = await deps.screenshots.toModelImage(capture, { rotateDeg: uprightRotation(shotOrientation, capture) })
```

- [ ] **Step 7: 运行测试和类型检查**

Run: `npm test && npm run typecheck`
Expected：orientation 的 3 个测试、tools-core 新增的横屏测试全部 PASS；之前的测试仍然全部通过。

- [ ] **Step 8: 在 skill 的 “Reading the screen” 一节末尾加一行**

```markdown
- Screenshots are always returned upright, also in landscape, and coordinates always refer to the image you were given — the tools map them to the device.
```

- [ ] **Step 9: 在真机冒烟里断言横屏截图是正的。** 在 `test/live/simulator.live.test.ts` 的 `console.log(\`landscape screenshot: …\`)` 之后加入：

```ts
  assert.equal(landscape.body.orientation, 'landscape_left')
  assert.ok(landscape.body.image.width > landscape.body.image.height, 'the landscape model image should be wider than tall')
```

- [ ] **Step 10: 重新构建、跑真机冒烟，并在面板里核对横屏点击**

Run: `npm run build && npm run check:bundle && IOS_SIM_SMOKE=1 npm run test:live`
Expected：`bundle OK: 16 tools`，真机冒烟 `# pass 1`。如果 `orientation` 断言失败（serve-sim 连接时没有发送 tag 130），用 `node -e` 连一次 `SimStreamInfo.wsUrl` 打印收到的前几帧确认格式，再按实际格式修正 `readSimScreenConfig`。

然后在浏览器面板里人工核对一次：`npm run dev:panel` → `preview_start` 打开面板 → 用工具打开 Safari 并旋转到 landscape_left → 用一个 MCP 客户端脚本（照 `scripts/dev-panel.mjs` 的写法）调用 `ios_sim_screenshot`，在返回的图片里找到地址栏中心坐标，再用 `ios_sim_interact tap` 点它，确认面板里地址栏被激活。

- [ ] **Step 11: 提交（包含 dist）**

```bash
git add src/orientation.ts src/screenshot.ts src/deps.ts src/tools/core.ts skills test dist
git commit -q -m "feat: upright landscape screenshots and framebuffer-mapped coordinates

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## 完成标准（对应设计文档 §16）

1. `npm run build`、`npm test` 全部通过，不需要模拟器（Task 17）。
2. `claude plugin validate .` 通过，`claude --plugin-dir .` 能看到 16 个工具和 `ios-ui-automation` skill（Task 19 Step 5）。
3. `IOS_SIM_SMOKE=1 npm run test:live` 通过（Task 19、20）。
4. 浏览器面板里能看到实时画面，点击视频有响应，Home 和旋转不需要辅助功能权限（Task 19 Step 4）。
5. 外部 Origin、Host、非 JSON 的 POST 都返回 403（Task 14、15 的测试）。
6. `src/` 里没有 `exec(` / `execSync(`（Task 17 Step 7）。

全部完成后，用 superpowers:finishing-a-development-branch 决定如何合并 `feat/foundation`。
