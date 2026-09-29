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
- `device_action` 里除锁屏以外的动作需要给运行 Claude 的应用开启"辅助功能"权限

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

对 Claude 说"启动 iPhone 17 Pro 模拟器"。`ios_sim_boot` 会返回 `panelUrl`，Claude 会在 Code 标签页的浏览器面板里打开它；在终端里使用时，把这个地址复制到浏览器即可。

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
