# iOS Simulator 插件 · 第 ⑤b 期（USB 真机：WebDriverAgent）设计

- 日期：2026-09-30
- 状态：已实现（待真机验证）
- 参考源：[dsh-ios](https://github.com/ZSeven-W/dsh-ios) `0.1.0-rc.10` @ `d9a9731` 的 `src/usbmux.ts`、`src/wda-host.ts`、`src/wda-uitree.ts`、`src/wda-physical-stage.ts`、`src/devicectl.ts`（签名部分）、`src/tool-uitree.ts`、`src/tool-list-rows.ts`、`src/tools.ts` 的真机分支（MIT，© 2026 ZSeven—W）
- 前置：[第 ⑤a 期设计](2026-09-30-ios-simulator-real-device-devicectl-design.md)

## 1. 范围

| 内容 | 结论 |
|---|---|
| 新工具 | `ios_real_start_wda`（`start` 默认 / `status` / `stop`），工具总数 30 |
| 支持真机的已有工具 | `ios_sim_screenshot`、`ios_sim_interact`、`ios_sim_ui_tree`、`ios_sim_tap_element`、`ios_sim_find_text`、`ios_sim_tap_text`、`ios_sim_wait_for`、`ios_sim_ui_rows`、`ios_sim_tap_row` |
| 不在本期 | 面板实时画面（⑤c，WDA 的 MJPEG）；真机日志、backtrace、leaks |

## 2. 模块

| 模块 | 职责 |
|---|---|
| `usbmux.ts` | 直接和 `/var/run/usbmuxd` 通信的端口转发（每个 TCP 连接一个 Connect 通道），不依赖 iproxy |
| `wda-setup.ts` | 签名团队选择；runner bundle id；WDA 源码的私有暂存副本与安全补丁 |
| `wda-client.ts` | WDA HTTP 客户端：会话复用、失效后重建一次、超时后的忙碌冷却、只对幂等 GET 重试；启动失败分类 |
| `wda-host.ts` | `WdaController`：接管 / 构建启动 / 隧道 / 就绪等待 / 停止；所有系统操作经 `WdaHostSeams` 注入 |
| `wda-uitree.ts` | WDA `/source` XML → 与 AXe 相同的 `AxeElement` 结构（坐标为点），合并同框的冗余包装元素 |
| `real-ui.ts` | 真机的树读取（快照深度控制）、截图保存、`ios_sim_interact` 参数 → WDA 操作 |

## 3. 已确定的决策

| 决策 | 结论 |
|---|---|
| 签名团队 | 顺序：工具参数 → `IOS_SIM_TEAM_ID` → Xcode 账号里有开发证书的团队 → 免费个人团队 → 第一个团队 → 钥匙串证书的团队。**没有内置默认团队**，找不到时报错并说明如何设置 |
| bundle id | `IOS_SIM_WDA_BUNDLE_ID`，否则 `dev.ios-simulator.wda.t<团队ID>`（免费团队之间不冲突） |
| WDA 源码 | 用户自己 clone（默认 `<缓存>/WebDriverAgent`，或 `IOS_SIM_WDA_DIR`），插件不分发 WDA |
| 安全补丁 | 复制到缓存里的私有副本上打补丁：HTTP 和 MJPEG 只监听手机的 `127.0.0.1`，只能经 USB 隧道访问。锚点必须恰好出现一次，否则拒绝构建；拒绝符号链接；原 checkout 不改动 |
| 启动流程 | 先开隧道探测 8100，WDA 已就绪就接管；否则 `xcodebuild … test`，等 `ServerURLHere`，再轮询 `GET /status` 直到 ready，然后建会话、设快照深度 15 |
| 隧道 | 优先 usbmuxd 直连；没有 USB 记录时退回 `iproxy <本地端口> 8100 <udid>`；都不行时说明是"只有 Wi-Fi"还是"未连接" |
| 失败分类 | 锁屏（优先判断，可自愈）、证书不受信任、描述文件过期、未连接、构建失败、启动超时，错误和 `status()` 都带处理方法 |
| 工具调用中不构建 | 其他工具用 `control()`：返回运行中的客户端，或接管已在跑的 WDA；否则报"先运行 ios_real_start_wda"，附上次失败原因。冷构建要几分钟，不能藏在一次点击里 |
| 一次一台 | 为另一台设备启动时先停掉当前的；同一设备的并发启动共用一次尝试 |
| 坐标 | 全部用点：交互的归一化坐标乘 `windowSize()`；OCR 像素按截图尺寸与窗口尺寸换算 |
| 树深度 | 默认快照深度 15，没有带 label 的元素时自动用 40 重读一次；显式 `max_depth` 不会被超出；列表行读 60 层 |
| 真机交互 | `type` 走设备键盘，支持任意文字；按键 home / lock / volume-up / volume-down；`device_action` 只支持 lock / unlock / siri；`gesture` 只支持拖动 |
| 退出 | 关闭时停止本插件启动的 runner 并关闭隧道；接管来的 WDA 保持运行 |
| 简化（相对上游） | 不记忆每台设备的深度、不做 MJPEG 隧道、不在工具调用中自动构建、不保留多端口范围探测 |

## 4. 验证

- 新增 12 个模块测试：usbmux 编解码、签名解析与团队选择、暂存与补丁（含锚点不匹配拒绝）、XML 归一化、失败分类、WdaClient（本地假 WDA HTTP 服务，含会话失效重建）、交互计划、树自动加深、WdaController 的接管 / 构建 / 失败 / 无团队路径；另有工具层测试 6 个（假 WDA）。
- **未在真机上验证。** 首次使用需要确认：usbmuxd 转发、`xcodebuild test` 的签名与 `ServerURLHere`、安全补丁锚点与当前 WebDriverAgent 版本是否匹配、截图与窗口尺寸的比例、`/wda/keys` 输入中文。
