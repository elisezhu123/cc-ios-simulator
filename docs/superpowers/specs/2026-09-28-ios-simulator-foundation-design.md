# iOS Simulator 插件 · 第 ① 期（基础）设计

- 日期：2026-09-28
- 状态：已评审（对话中逐节确认），待书面审阅
- 参考源：[dsh-ios](https://github.com/ZSeven-W/dsh-ios) `0.1.0-rc.10` @ `d9a9731`（MIT，© 2026 ZSeven—W），本地副本 `Projects/dsh-ios`
- 本仓库：`Projects/ios-simulator-panel`（基线提交 `9da4e6a` 保存了重建前的全部内容）

## 1. 背景与目标

现状有两个互相重叠的项目：

- `ios-simulator-panel`：MCP App + 本地 HTTP 面板，17 个 simctl 工具写在一个大 switch 里。Home 和旋转用 `osascript` 发键盘快捷键，需要辅助功能权限，而且会作用到当前最前面的应用。“实时”画面其实是每 2 秒轮询一次截图。命令靠拼 shell 字符串执行，有注入风险。`simulator_set_location` 把经纬度作为两个参数传入，而 simctl 要的是 `set <lat>,<lon>`，所以这个工具本来就不能用。`stop_recording` 用 `pkill` 杀掉所有录屏进程。
- `ios-simulator-mcp-server`：9 个 simctl 工具，和上面的功能重叠。

目标：参照 dsh-ios（DeepSeek Harness 的 iOS 插件）把 `ios-simulator-panel` 重建为一个 **Claude Code 插件**。插件自带 MCP 服务、实时面板和 skill，并分 5 期逐步做到与 dsh-ios 功能对齐。本文档只覆盖第 ① 期。

## 2. 已确定的决策

| 决策 | 结论 |
|---|---|
| 插件形态 | Claude Code 插件：`.claude-plugin/plugin.json` + 自带 MCP 服务 + skill。实时面板是一个本地回环网页，在 Code 标签页的浏览器面板里打开 |
| 最终范围 | dsh-ios 全部能力，分 5 期（见 §3） |
| 仓库 | 在 `ios-simulator-panel` 原地重建，只保留一个包。`ios-simulator-mcp-server` 原样留在磁盘上，不改动 |
| 做法 | 移植改写 dsh-ios 中与宿主无关的模块（MIT，保留署名），去掉 cordis/DSH 绑定，改用 MCP SDK + zod 注册工具 |
| 截图 | 以图片块返回给 Claude（与 dsh-ios 相反：DeepSeek 是纯文本模型，而 Claude 能看图） |
| `ios_sim_interact` | 默认在动作后返回一张截图，每次约 650 token，可用 `screenshot:false` 关闭 |
| 面板安全 | 照搬 dsh-ios 的回环/Host/Origin 检查。不用 HMAC 令牌，因为面板独占一个 origin |
| 面板实现 | 自己写（原生 TS），不用 serve-sim 自带的预览页，因为第 ⑤ 期要在同一个面板里显示真机的 WDA 视频流 |
| 语言 | 对话和 README 用中文。工具描述和 skill 面向模型，用英文（与 dsh-ios 一致）。面板界面中英双语，按浏览器语言自动切换 |

## 3. 分期路线图

| 期 | 内容 | dsh-ios 来源 |
|---|---|---|
| **① 基础（本文档）** | 插件骨架、MCP 服务、serve-sim 视频流与触控、实时面板、16 个核心工具、skill v1 | `simctl` `sim-host` `stream-source` `sim-gesture` `device-actions` `app-switcher` `plist` `app-list` `build-run` `tools` `stream-routes` `skill`，以及 client 中的协议、文案、尺寸、外框、方向部分 |
| ② UI 自动化 | AXe 无障碍树 + Vision OCR：`ui_tree` `tap_element` `ui_rows` `tap_row` `find_text` `tap_text` `wait_for` | `tool-uitree` `uitree-backend` `list-rows` `tool-list-rows` `ocr-backend` `assets/ocr.swift` |
| ③ 日志与调试 | `logs` `processes` `backtrace` `leaks` `app_info` | `tool-logs` `tool-debug` |
| ④ SwiftUI 预览 | `ios_sim_preview` 热重载 | `tool-preview` `preview-host` `assets/preview-host/*` |
| ⑤ 真机 | WDA + usbmux + devicectl，同一面板和工具可以驱动 USB 连接的 iPhone | `wda-*` `usbmux` `devicectl` `ios_real_start_wda`，以及 app-list/build-run 的真机分支 |

每期单独走一轮“设计 → 计划 → 实现”。第 ① 期要为后续几期预留接口：沿用 `StreamSource` 抽象（模拟器和真机共用一套接口），文件命名与 dsh-ios 保持一致。

**第 ① 期不做**：第 ②–⑤ 期的全部内容、面板键盘转发（dsh-ios 也没有）、DSH 专有的界面（侧栏停靠、对话卡片、状态胶囊）、`.mcpb` / Claude Desktop 打包。

## 4. 架构

```
Claude Code ──stdio──▶ MCP 服务 (dist/server.js)
                        ├─ 工具层 (MCP SDK + zod)
                        │    ├─ SimStreamSource ─▶ SimHostController ─▶ serve-sim 子进程（MJPEG + WS 控制）
                        │    └─ simctl / xcodebuild 封装（execFile 传参数数组）
                        └─ 面板服务 PanelServer（127.0.0.1:3456 起）
                             ├─ GET /stream  ─代理─▶ serve-sim MJPEG
                             ├─ WS  /ws      ─转发─▶ serve-sim 控制 socket
                             └─ 面板网页 ◀── Code 标签页浏览器面板（preview_start {url}）
Skill ios-ui-automation（随插件分发，教 Claude 工作流）
```

- 工具层和面板服务在同一个进程里，共用一个 `SimHostController`。
- 懒启动：MCP 服务启动时什么都不开。第一次有工具需要视频流时才启动 serve-sim；第一次需要返回 `panelUrl` 时才启动面板服务。
- 一个会话同一时间只推一台设备的流（和 dsh-ios 一样）。对另一台设备调用 `interact` / `panel` 时，流和面板会切换到那台设备。
- 多个会话：每个 Claude 会话都有自己的 MCP 服务，面板端口各不相同（3456 起递增）。同一台设备的 serve-sim 流通过 dsh-ios 的孤儿接管逻辑共享：同一设备直接接管，占着端口但设备不对的就回收后重启。

## 5. 目录结构

```
.claude-plugin/plugin.json          # name: ios-simulator；mcpServers → node ${CLAUDE_PLUGIN_ROOT}/dist/server.js
.claude-plugin/marketplace.json     # 本地 marketplace（name: ios-simulator-panel，plugins[0].source: "./"）
skills/ios-ui-automation/SKILL.md
src/server.ts                       # MCP 入口、组装、生命周期
src/config.ts                       # 常量、环境变量、缓存目录
src/simctl.ts                       # 移植 + 新增封装
src/sim-host.ts                     # 移植：serve-sim 生命周期
src/stream-source.ts                # 移植：StreamSource 接口 + SimStreamSource
src/sim-gesture.ts                  # 移植：WS 手势通道
src/device-actions.ts               # 移植
src/app-switcher.ts                 # 移植
src/plist.ts                        # 移植
src/app-list.ts                     # 移植（只保留模拟器分支）
src/build-run.ts                    # 移植（只保留模拟器分支）
src/screenshot.ts                   # ScreenshotStore（移植）+ 缩放为 JPEG（sips）
src/recorder.ts                     # 录屏子进程管理（新写）
src/target.ts                       # 设备选择规则（移植 resolveToolTarget 的模拟器路径）
src/tools/core.ts                   # devices / boot / shutdown / panel / screenshot / interact
src/tools/apps.ts                   # list_apps / launch_app / build_run / install_app / uninstall_app
src/tools/env.ts                    # open_url / push / location / appearance / record
src/panel/panel-server.ts           # 回环 HTTP + WS
src/panel/fence.ts                  # 安全边界判断（纯函数，方便测试）
src/panel/client/                   # 面板网页（原生 TS）：index.html、main.ts、protocol.ts、copy.ts、layout.ts、styles.css
test/                               # node:test 单元测试与集成测试；test/live/ 放按需开启的冒烟测试
dist/                               # esbuild 打包产物（提交进 git）：server.js、panel/
THIRD_PARTY_NOTICES.md              # dsh-ios (MIT)、serve-sim (Apache-2.0)
README.md                           # 中文
```

每个移植文件的开头都注明出处：`Ported from dsh-ios (MIT) @ d9a9731 — src/<file>`。错误信息前缀从 `dsh-ios:` 改为 `ios-simulator:`，提示文字里提到 DSH 的地方都改掉。

## 6. 移植清单

| dsh-ios | 本项目 | 处理方式 |
|---|---|---|
| `simctl.ts` | `src/simctl.ts` | 原样移植。新增 `openUrl`、`sendPush`、`setLocation`（`set <lat>,<lon>`）、`clearLocation`、`setAppearance`、`spawnRecordVideo` |
| `sim-host.ts` | `src/sim-host.ts` | 原样移植（前台运行、不用 `--detach`、端口段 3181–3244、孤儿接管/回收、保活、空闲停流）。serve-sim 按以下顺序解析：环境变量 `IOS_SIM_SERVE_SIM_BIN` → 插件目录 `node_modules/serve-sim` 的 bin → `npx -y serve-sim@0.1.47` |
| `stream-source.ts` | 同名 | 保留 `StreamSource`、`StreamControl` 接口和 `SimStreamSource`。`WdaStreamSource` 放到第 ⑤ 期 |
| `sim-gesture.ts` | 同名 | 原样（16ms 一帧，手势路径限制在 8–92% 区域内）。唯一改动：`createRequire(import.meta.url)('ws')` 改为静态 `import WebSocket from 'ws'`，否则 esbuild 打不进包。`stream-routes.ts` 的 ws 加载方式同样处理 |
| `device-actions.ts`、`app-switcher.ts`、`plist.ts` | 同名 | 原样，只改提示文字 |
| `app-list.ts` | 同名 | 去掉 devicectl 和真机分支，保留 simctl 列表解析和本地化 |
| `build-run.ts` | 同名 | 去掉真机分支、签名和 `plugin-env`。DerivedData 放在缓存目录下 |
| `tools.ts` | `src/target.ts`、`src/screenshot.ts`、`src/tools/*` | 抽取设备选择、`interactControlArgs`、`performSimInteract`、滚动路径和 `ScreenshotStore`。DSH 的 `ToolRegistry` / `presentationMeta` 改为 MCP 的 `registerTool` + zod |
| `stream-routes.ts` | `src/panel/*` | 只移植安全边界判断、MJPEG 代理、WS 转发、capture 和截图路径校验。去掉 HMAC、`/grant` 和真机路由 |
| `client/protocol.ts`（帧编码）、`copy.ts`、`sim-panel-size.ts`、`sim-frame-style.ts`、`sim-orientation.ts` | `src/panel/client/*` | 逻辑移植为原生 TS。React 组件重写，不照搬 |
| `skill.ts` | `skills/ios-ui-automation/SKILL.md` | 改写（见 §10） |
| `scripts/dev-*-smoke.mjs` 中对应的断言 | `test/*.test.ts` | 移植为 node:test |

## 7. 工具清单（16 个）

**通用约定**
- 所有工具都接受可选的 `udid`，值可以是 udid 或设备名。
- 设备选择顺序：显式 `udid` → 正在推流的设备 → 第一台已启动的设备 → 都没有就报错，提示先调用 `ios_sim_boot`。
- 正常结果以 JSON 文本返回。出错时返回 `isError: true`，附原因和下一步。
- 坐标一律是 0..1 归一化值（相对截图或视频画面）。

| 工具 | 参数 | 行为与返回 |
|---|---|---|
| `ios_sim_devices` | `query?` | 列出可用模拟器 `{udid,name,runtime,state,deviceType}`，已启动的在前，同状态下 runtime 新的在前。另外返回 `booted: udid[]`，以及正在推流的设备 `streaming?`。`query` 对 name、udid、runtime 做不区分大小写的子串匹配 |
| `ios_sim_boot` | `udid`（必填） | 启动设备（已启动则跳过）并开始推流。返回 `{device, state:'booted', streaming:true, panelUrl}` |
| `ios_sim_shutdown` | `udid`（必填） | 关机。如果这台正在推流就同时停流。返回 `{device, state:'shutdown', streaming:false}` |
| `ios_sim_panel` | `udid?` | 为目标设备确保流在运行（不会启动关机的设备），并启动面板服务。返回 `{panelUrl, device}` |
| `ios_sim_screenshot` | `udid?` | 用 `simctl io screenshot` 截一张完整 PNG 存入缓存，再缩成 JPEG（质量 80，长边 ≤1024）作为**图片块**返回。文本部分是 `{path, bytes, width, height, image:{width,height}, device}` |
| `ios_sim_interact` | `action`：`tap` / `type` / `button` / `gesture` / `scroll` / `rotate` / `device_action`；另有 `x` `y` `text` `name` `json` `direction` `amount` `orientation` `screenshot?`（默认 true） | 目标设备已启动但没在推流时，自动开始推流（不会启动关机的设备）。各动作：<br>• `tap`：需要 x、y<br>• `type`：只接受美式键盘 ASCII<br>• `button`：`name`，如 home、lock<br>• `gesture`：原始帧，或 `{fromX,fromY,toX,toY}` 拖动<br>• `scroll`：`direction` 取 up/down/left/right，`amount` 取 0..1（默认 0.6），可用 x、y 指定锚点<br>• `rotate`：`orientation` 取 portrait / portrait_upside_down / landscape_left / landscape_right<br>• `device_action`：`name` 取 app-switcher / lock / unlock / shake / siri / action-button / re-center<br>多事件手势走 WS 通道，失败时退回 CLI。动作后等 300ms 返回截图图片块。返回 `{action, device, delivery:{channel, frames?, wsError?}, screenshot?}` |
| `ios_sim_list_apps` | `udid?` `query?` `include_system?`（默认 false） | 已安装的 app `{bundleId,name,version,system}`，名称按模拟器语言本地化。列表获取失败时报错，不返回空列表 |
| `ios_sim_launch_app` | `bundleId` 或 `name`（二选一）、`udid?`、`relaunch?` | `name` 做不区分大小写的子串匹配（支持中文等 CJK 名称）。匹配到多个时报错并列出候选 |
| `ios_sim_build_run` | `projectPath`（必填）、`scheme?`、`configuration?`（默认 Debug）、`udid?` | 支持 xcodeproj、xcworkspace、SPM：构建 → 安装 → 启动。设备选择的最后一步是：没有已启动设备时，自动启动 runtime 最新的 iPhone。失败时返回过滤后的 xcodebuild 错误尾部。返回 `{device, scheme, appPath, bundleId, durationMs, panelUrl}` |
| `ios_sim_install_app` | `appPath`（必填）、`udid?` | 安装 `.app`，并从 Info.plist 读出 `bundleId` 返回 |
| `ios_sim_uninstall_app` | `bundleId`（必填）、`udid?` | 卸载 |
| `ios_sim_open_url` | `url`（必填）、`udid?` | 打开 URL 或 deep link |
| `ios_sim_push` | `bundleId`（必填）、`payload`（object，必填）、`udid?` | 把 payload 写入权限为 0600 的临时文件，执行 `simctl push`，然后删除临时文件 |
| `ios_sim_location` | `latitude?` `longitude?` `clear?` `udid?` | 执行 `simctl location <udid> set <lat>,<lon>`，或 `clear`。会校验经纬度范围 |
| `ios_sim_appearance` | `appearance`：`light` / `dark`，`udid?` | 执行 `simctl ui <udid> appearance <值>` |
| `ios_sim_record` | `action`：`start` / `stop`，`outputPath?`，`udid?` | `start`：启动 `simctl io <udid> recordVideo --codec=h264 --force <path>`，等 stderr 出现 “Recording started”；默认路径在缓存 `recordings/` 下；每台设备同时只能有一个录屏。`stop`：发 SIGINT，最多等 10 秒让 .mov 写完。返回 `{path, bytes, durationMs}` |

**从旧项目移除的工具**
- `simulator_home`、`simulator_rotate`：功能并入 `ios_sim_interact` 的 `button` / `rotate`，改由 serve-sim 实现，不再需要辅助功能权限。
- `simulator_get_status`、`simulator_get_device_info`：并入 `ios_sim_devices`。
- `simulator_open_panel`：由 `ios_sim_panel` 替代。

## 8. 实时面板

### 8.1 面板服务 `src/panel/panel-server.ts`

- 监听 `127.0.0.1`。优先端口为 `IOS_SIM_PANEL_PORT`（默认 3456），被占用时依次尝试到 +20。`panelUrl = http://127.0.0.1:<port>/`。

| 路由 | 作用 |
|---|---|
| `GET /` 及静态资源 | 面板网页（`dist/panel/`） |
| `GET /stream` | 转发当前设备的 serve-sim MJPEG（`multipart/x-mixed-replace`），不转发上游的 CORS 头。连接存续期间 `acquire()` 一个使用者，断开时释放 |
| `WS /ws` | 与 serve-sim `wsUrl` 双向转发二进制帧：tag 3 触摸 `{type,x,y}`，tag 4 按键 `{button}`，tag 7 旋转 `{orientation}`，tag 130 是 serve-sim 发来的屏幕配置 `{width,height,orientation}`。切换设备时断开旧连接 |
| `GET /api/status` | `{running, device?, deviceName?, panelUrl}`。只读，不会启动任何东西 |
| `GET /api/devices` | 给设备选择器用的列表，已启动的在前、runtime 新的在前 |
| `POST /api/switch-device` | `{udid}`：设备未启动时先启动，再切换推流。这是用户主动操作，所以允许启动设备（与 dsh-ios 一致） |
| `POST /api/capture` | 截一张新 PNG 存入缓存，返回 `{url:"/shots/<文件名>", width, height}` |
| `GET /shots/<文件名>` | 只提供截图缓存目录里的文件：文件名白名单 + realpath 包含检查，拒绝符号链接 |
| `POST /api/device-action` | `{action}`，取值见 §7 的 device_action |

**安全边界 `src/panel/fence.ts`**，所有路由都先过这一层，从 dsh-ios 移植：
1. 对端地址必须是回环地址（127.0.0.0/8、::1、::ffff:127.x）。
2. `Host` 必须是 `127.0.0.1:<port>` 或 `localhost:<port>`，防 DNS 重绑定。
3. WS 升级请求和所有 POST 必须带 `Origin`，且必须是 `http://127.0.0.1:<port>` 或 `http://localhost:<port>`（本面板端口的两种回环写法）。带 `Sec-Fetch-Site` 时必须是 `same-origin`。
4. POST 的 `Content-Type` 必须是 `application/json`（其他网站跨站调用时会因此触发 CORS 预检，从而被拦下），请求体上限 16 KB。

不通过的请求一律返回 403，不带任何细节。

### 8.2 面板网页 `src/panel/client/`

- 用 `<img src="/stream">` 实时显示。出错时按 1s → 2s → 5s 退避重连。状态栏显示“设备名 · 实时 / 连接中 / 离线（原因）”。
- 指针交互：按下 → 移动 → 抬起，映射为 tag 3 的 begin / move / end 帧。坐标按画面实际显示区域换算为 0..1，自动扣除黑边。
- 工具栏用图标按钮，悬停有提示：
  - Home：单击回主屏，双击打开多任务；
  - 截图：调用 `/api/capture` 后在新标签页打开；
  - 旋转：按 portrait → landscape_left → portrait_upside_down → landscape_right 循环；
  - 设备动作菜单；
  - 刷新。
- 顶栏有设备选择器，选中后调用 `/api/switch-device`。
- 尺寸：适应（按面板宽度）/ 50–125%（逻辑宽度的缩放）/ S·M·L（按短边的预设）。外框：无框 / 边框 / 真机框。设置存在 localStorage。
- 方向（移植 `sim-orientation.ts`）：设备横屏时，serve-sim 仍然发送竖屏的帧缓冲，画面内容是侧着画在里面的。所以面板要根据 tag 130 的 orientation 用 CSS 反向旋转 `<img>`：landscape_left 转 +90°，landscape_right 转 −90°，portrait_upside_down 转 180°。指针坐标再按同一规则换算回帧缓冲坐标，例如 landscape_left 时 fb = (dy, 1−dx)。
- 文案中英双语（移植 `copy.ts`），根据 `navigator.language` 自动选择。

## 9. 生命周期与缓存

- 常量：
  - serve-sim：保活重启延迟 5 秒、空闲 5 分钟停流、启动握手超时 120 秒（沿用 dsh-ios）；
  - interact：动作后等待 300 毫秒再截图；
  - 录屏：停止时最多等 10 秒。
- 退出：stdin 关闭、SIGTERM 或 SIGINT 时，依次停止所有录屏（SIGINT，等待写完）→ 结束 serve-sim 整个进程组 → 关闭面板服务，最后退出。
- 缓存根目录 `~/Library/Caches/ios-simulator/`：
  - `screenshots/`：只保留最新 100 张，每次写入时清理最旧的；
  - `recordings/`；
  - `builds/<slug>/DerivedData`；
  - `tmp/`：push payload 等临时文件。

## 10. 错误处理与降级

- **非 macOS / 没有 Xcode**：工具照常注册，调用时返回 “iOS Simulator requires macOS with Xcode …”。
- **serve-sim 不可用**（Intel Mac、没有 npx、下载失败）：只依赖 simctl 的工具照常工作，包括截图、设备、app、环境、录屏等。`interact` 和 `panel` 报错并说明原因，比如 “serve-sim 只支持 Apple Silicon”。
- **serve-sim 崩溃**：5 秒后自动重启。面板显示“连接中”并自动重连。
- **Xcode 27 键盘**：`type` 失败时，错误里附上提示：需要 Device Hub 在前台显示目标模拟器，并给启动 Claude 的应用开启辅助功能权限。输入彻底失效时，提示可手动运行 `serve-sim repair-input`（会重启 SpringBoard），但绝不自动执行。
- **错误信息带下一步**：沿用 dsh-ios 的写法，例如 app 名称有歧义时列出候选，未启动设备时提示 `ios_sim_boot`，构建失败时给出过滤后的错误尾部。
- **命令执行**：全部通过 `execFile` / `spawn` 传参数数组，代码里不出现 shell 字符串拼接。

## 11. Skill `ios-ui-automation`

- frontmatter 的 `description` 限定为：通过 `ios_sim_*` 工具操作 iOS 模拟器时使用。这样不会和 Code 标签页内置的 iOS 模拟器工具抢着触发。
- 正文（英文）以 dsh-ios 的 `skill.ts` 为底改写：
  - 工作循环：先观察，再做带断言的操作，只在断言无法确认时再观察；
  - **截图是正常的观察手段**：Claude 能看图；归一化坐标 = 图片像素 ÷ 图片宽高；
  - **打开面板**：拿到 `panelUrl` 后，用浏览器面板的 `preview_start {url}` 打开；在命令行里就把 URL 告诉用户；
  - 不猜第三方 bundle id：先 `ios_sim_list_apps`，或者直接用 `name`；
  - 模拟器上的 app 名是本地化名称（日历，不是 Calendar）；
  - `type` 只支持美式键盘的 ASCII，中文请用剪贴板；
  - 只在设备上找 app，不去用户源码或 DerivedData 里找；
  - 连续操作时可以传 `screenshot:false` 节省 token；
  - 列出 Apple 自带 app 的稳定 bundle id。
- 只写第 ① 期已有的工具。第 ②–⑤ 期上线时，把 dsh-ios 手册中对应的段落（OCR 置信度、列表行操作、真机安全规则）加回来。

## 12. 打包与安装

- `package.json`：`engines.node >= 20`；`dependencies: { "serve-sim": "0.1.47" }`（锁定版本）。devDependencies：`@modelcontextprotocol/sdk`、`zod`、`ws`、`esbuild`、`typescript`、`tsx`、`@types/node`、`@types/ws`。这几个库都打包进 bundle，所以放在 devDependencies。
- `npm run build`：先 `tsc --noEmit` 做类型检查，再用 esbuild 把 `src/server.ts` 打成单个 `dist/server.js`（ESM，platform node），最后用 esbuild 打包 `src/panel/client/main.ts`，并把 html/css 复制到 `dist/panel/`。
- `dist/` 提交进 git（从 `.gitignore` 里移除），这样按 git 安装插件时不需要再构建。
- 安装：
  - 开发调试：`claude --plugin-dir ~/Tools/Claude/Projects/ios-simulator-panel`；
  - 正式安装：`/plugin marketplace add ~/Tools/Claude/Projects/ios-simulator-panel`，然后 `/plugin install ios-simulator@ios-simulator-panel`。
- 运行要求：macOS + 完整 Xcode + Apple Silicon（serve-sim 的限制）+ Node ≥ 20。本机是 arm64、Node 26、Xcode 27.0，全部满足。

## 13. 测试

- `npm test` 运行 `node --import tsx --test test/*.test.ts`，不需要模拟器：
  - **单元测试**：serve-sim 握手解析、端口选择、手势路径裁剪、`interactControlArgs` 映射、滚动参数校验、安全边界判断（peer / Host / Origin / Sec-Fetch-Site / Content-Type）、simctl 列表解析与排序、app 列表解析与本地化、`resolveAppByName` 的歧义处理、build 参数组装与错误过滤、设备选择规则、location 参数格式、截图目录清理。
  - **集成测试**：用假的 `StreamSource` 和一个假的上游 MJPEG/WS 服务，覆盖面板路由的状态码、安全边界拒绝、MJPEG 代理、WS 双向转发、`/shots` 的路径逃逸拒绝。
  - **MCP 协议测试**：用 SDK 的 `Client` 通过 stdio 启动 `dist/server.js`，确认列出 16 个工具，调用 `ios_sim_devices` 返回合法 JSON，参数不合法时返回 `isError`。
- `npm run test:live` 需要设置 `IOS_SIM_SMOKE=1`，在本机真实模拟器上跑：boot → 推流 → 截图（图片块）→ tap → scroll → rotate → 录屏 start/stop → shutdown。

## 14. 清理（在基线提交之后执行）

删除以下内容，均可从 `9da4e6a` 找回：
- 旧代码：`src/index.ts`、`src/http-server.ts`、`src/server.mjs`、`src/ui/*`
- 状态文档：`ARCHITECTURE.md`、`COMPLETION_REPORT.md`、`DEMO.md`、`GATEWAY_OPTION.md`、`PROJECT.txt`、`QUICKSTART.md`、`START_HERE.txt`、`SUMMARY.md`、`ios-simulator-panel/`
- 脚本：`configure.mjs`、`demo.sh`、`install.sh`、`start-server.js`、`test-server.mjs`
- 产物：`ios-simulator-panel.mcpb`、`ios-simulator-panel-complete.tar.gz`、`manifest.json`、`claude_desktop_config.example.json`、`.claude/launch.json`

`LICENSE`（MIT）保留，`README.md` 重写，`package.json` / `tsconfig.json` 重写。

## 15. 风险与已知限制

- serve-sim 是 0.1.x 版本，依赖 Apple 私有接口。已锁定 0.1.47，升级需要单独验证。
- Xcode 27 下键盘输入依赖 Device Hub 和辅助功能权限（见 §10）。
- Claude Code 从本地 marketplace 安装插件时会把目录复制到缓存，不确定会不会带上 `node_modules`。不带的话就走 npx 兜底，第一次需要联网。
- Code 标签页的浏览器面板里，MJPEG `<img>` 上的指针事件需要在验收时实测。
- 横屏时的坐标系：serve-sim 的触摸坐标以竖屏帧缓冲为准，而 `simctl io screenshot` 在横屏时输出的图片方向还没有验证。如果截图是横向的，Claude 从截图算出的坐标就对不上。实现时先在真实模拟器上验证；如果确实不一致，`interact` 要按当前 orientation 做和面板相同的坐标换算，并补上测试。
- Code 标签页自带的 iOS 模拟器工具和本插件会同时存在，靠 skill 描述的范围来区分。

## 16. 验收标准

1. `npm run build` 和 `npm test` 全部通过，不需要模拟器。
2. 用 `claude --plugin-dir` 加载后，能看到 16 个工具和 `ios-ui-automation` skill（通过 `claude -p` 的无头调用确认）。
3. 在本机设置 `IOS_SIM_SMOKE=1` 跑 `npm run test:live`，全部通过。
4. 在 Code 标签页的浏览器面板里打开 `panelUrl`，看到实时画面；点击视频，模拟器有响应；Home 和旋转按钮在没有辅助功能权限的情况下也能用。
5. 安全边界测试中，外部 Origin、Host 或非 JSON 的 POST 全部返回 403。
6. `src/` 里没有 `exec(` / `execSync(` 这类 shell 字符串执行（用 grep 检查）。
