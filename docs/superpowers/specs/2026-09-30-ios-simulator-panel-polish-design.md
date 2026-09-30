# iOS Simulator 插件 · 面板打磨设计（图标、自动打开、README 截图）

- 日期：2026-09-30
- 状态：已实现
- 前置：[面板界面改版](2026-09-30-ios-simulator-panel-redesign-design.md)

## 1. 图标

| 决策 | 结论 |
|---|---|
| 来源 | Boxicons 2.1.4 regular（MIT）。只把路径数据写进 `client/icons.ts`，不新增依赖，面板仍是一个同源的打包文件 |
| 选用 | 主屏 home-alt-2、标注 pencil、截图 camera、录屏 video / stop-circle、旋转 revision、关闭 power-off、断开 log-out（旋转 180°：方框在左，箭头朝右出去）、全屏 fullscreen；标注工具 minus（直线，转 -45°）、up-arrow-alt（箭头，转 45°）、square、circle、text、undo、redo、trash；菜单用 check、chevron |
| 旋转方式 | 用 SVG 的 `transform` 属性，不用 `style` 属性，因为面板的 CSP 禁止内联样式 |
| 颜色 | 工具条和标注按钮的图标是深灰（浅色 #48484a，深色 #d1d1d6），悬停时有淡入效果 |

## 2. 面板第一次启动时自动打开

| 环境 | 做法 |
|---|---|
| 终端（CLI） | 面板第一次启动时用默认浏览器打开（macOS `open`、Linux `xdg-open`、Windows `start`），每个进程只打开一次 |
| Claude Code 桌面版 | MCP 服务无法控制内置浏览器，内置浏览器只能由 Claude 通过 `preview_start` 按 `.claude/launch.json` 打开。所以 `ios_sim_boot` / `ios_sim_panel` 的结果里带 `openInClaude`：一份 launch 配置，外加一段说明，提醒 Claude 不要结束占用面板端口的进程（那就是 MCP 服务本身） |
| 判断依据 | `IOS_SIM_OPEN_PANEL`（`browser` / `preview` / `none`）优先；否则 `CLAUDE_CODE_ENTRYPOINT` 里含 `desktop` 就用 preview，其他情况用 browser |
| 为什么在第一次启动时打开，而不是 MCP 连上时 | 连上时打开的话，每次会话都会弹出一个面板，即使这次根本不用模拟器 |

### 预览代理

- `dist/server.js --panel-proxy --state <缓存>/panel.json`：监听 `PORT`（配置里 `autoPort: true`，由内置浏览器分配端口），把 HTTP 请求和 `/ws` 升级请求转发到面板。
- 每次请求都重新读取面板写入的 `panel.json`（`{url, port, pid}`，面板关闭时删除），面板换了端口也能跟上；没找到面板时返回一个每 3 秒刷新的等待页。
- 安全：代理先按自己的端口套用同一套安全检查（只允许本机、校验 Host 防 DNS 重绑定、写操作要求自己的 Origin），再把 Host 和 Origin 改成面板的；这样面板自己的检查仍然有效。

## 3. README

- 效果预览换成用户在 Mac 上截的真实界面：内置浏览器里的面板、设备选择、设备菜单、调试菜单、标注。
- 所有截图都重新编码，去掉 EXIF；桌面版的截图只保留右侧内置浏览器那一栏，不公开会话列表和账号。
- 补充了自动打开、`IOS_SIM_OPEN_PANEL`、桌面版常见问题和 Boxicons 致谢；THIRD_PARTY_NOTICES 里加上 Boxicons 的 MIT 许可全文。

## 4. 验证

- 新增测试 4 个：打开方式的判断、只打开一次、桌面版提示里的配置内容、Host / Origin 改写；另有一个端到端测试：经过代理访问面板页面和状态接口，写操作要求自己的 Origin，DNS 重绑定和外来 Origin 返回 403，WebSocket 经代理把触控送到真机（假 WDA），面板关闭后删除 `panel.json`。
- 构建后的 `dist/server.js --panel-proxy` 能正常启动，没有面板时返回等待页（503）。
- 用无头 Chromium 检查新图标：工具条、菜单、标注工具条都正常，控制台没有错误。
