# iOS Simulator 插件 · 第 ⑤c 期（USB 真机：面板实时画面）设计

- 日期：2026-09-30
- 状态：已实现（待真机验证）
- 参考源：[dsh-ios](https://github.com/ZSeven-W/dsh-ios) `0.1.0-rc.10` @ `d9a9731` 的 `src/wda-host.ts`（MJPEG 隧道）、`src/stream-source.ts`、`src/stream-routes.ts`（MIT，© 2026 ZSeven—W）
- 前置：[第 ⑤b 期设计](2026-09-30-ios-simulator-real-device-wda-design.md)

## 1. 目标

面板除了模拟器，还能显示一台运行着 WebDriverAgent 的 iPhone / iPad，并在画面上点击、滑动。

## 2. 已确定的决策

| 决策 | 结论 |
|---|---|
| 画面来源 | WDA 自带的 MJPEG 广播（手机端口 9100，⑤b 的补丁已让它只监听手机回环地址）。`WdaController.mjpegUrl` 第一次被面板请求时开一条 USB 隧道，随 WDA 会话一起关闭 |
| 切换方式 | 面板的设备选择器增加"iPhone / iPad"分组（只列出 WDA 正在运行的那台）；`ios_sim_panel {udid: iPhone}` 也会切过去；选模拟器或 `ios_sim_boot` 切回模拟器。切换时断开已有的画面和控制连接，浏览器自动重连 |
| 触控 | 浏览器照旧发 serve-sim 的控制帧。服务端的 `RealTouchTranslator` 把 begin → end 变成一次 WDA 点击（位移 ≤ 0.02）或一次拖动（时长 = 按住时长，0.05–5 s），中间的 move 丢弃；按键帧 → `pressButton` / `lock`，旋转帧 → `setOrientation`。操作按顺序串行执行 |
| 坐标 | 归一化坐标乘 WDA 的窗口尺寸（点）。WDA 画面本身是正向的，所以浏览器端真机模式不做旋转映射 |
| 其他面板功能 | 截图走 WDA 并存入同一个截图缓存；设备操作只支持锁屏 / 解锁 / Siri，其他返回 400 |
| WDA 停止后 | `/api/status` 返回 `running: false` 和"先运行 ios_real_start_wda"；`/stream` 返回 409，不会自动构建 |
| 不做 | 连续触控流（WDA 没有这种通道）；多台真机同时显示 |

## 3. 验证

- 新增测试 6 个：触控翻译、MJPEG 隧道只开一次且随 stop 关闭、面板的设备列表 / 切换 / 画面代理、面板触控 → WDA 点击与截图 / 设备操作、WDA 停止后的提示，以及 `ios_sim_panel` 选中 iPhone。
- 用无头 Chromium 驱动构建后的面板（假 WDA + 本地 MJPEG）：画面正常显示，单击、拖动、回到桌面、旋转都到达 WDA，设备操作只列出锁屏 / 解锁 / Siri。
- **未在真机上验证**：WDA MJPEG 的帧格式与帧率、横屏时画面方向、拖动时长是否适合滚动。
