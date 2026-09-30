# iOS Simulator 插件 · 第 ⑤a 期（USB 真机：devicectl）设计

- 日期：2026-09-30
- 状态：已实现
- 参考源：[dsh-ios](https://github.com/ZSeven-W/dsh-ios) `0.1.0-rc.10` @ `d9a9731` 的 `src/devicectl.ts`，以及 `src/tools.ts`、`src/tool-debug.ts`、`src/app-list.ts` 的真机分支（MIT，© 2026 ZSeven—W）
- 前置：[第 ④ 期设计](2026-09-30-ios-simulator-swiftui-preview-design.md)

## 1. 拆分

上游第 ⑤ 期（真机）涉及 devicectl、usbmux、WebDriverAgent（WDA）构建与连接、真机视频流，以及几乎每个工具的真机分支，合计七千多行。拆成三个 PR：

| 分步 | 内容 |
|---|---|
| **⑤a（本文）** | devicectl：列出真机；真机上的 App 列表、启动 / 结束、安装、进程、App 信息 |
| ⑤b | WDA：签名、构建启动 WDA、usbmux 转发；真机截图、点击、输入、无障碍树、OCR 点击 |
| ⑤c | 面板显示真机实时画面 |

## 2. 已确定的决策

| 决策 | 结论 |
|---|---|
| 运行方式 | `xcrun devicectl --timeout <s> --json-output <临时文件> …`，通过第 ③ 期的 `DevTools.run` 执行（超时杀进程组）。命令必须退出码为 0 **且** JSON 里 `outcome === "success"` 才算成功 |
| 可测试性 | `Devicectl` 接收一个 `DevicectlRunner`；工具层通过 `ToolDeps.realDevices`（`RealDeviceApi`）注入 |
| 设备解析 | 新增 `resolveToolTarget`：没传设备 → 模拟器；传了 → 先按模拟器找，找不到再找连接的真机（避免每次调用都跑一次 devicectl）。真机必须已配对且可用 |
| 支持真机的工具 | `ios_sim_devices`（`realDevices`，失败时返回 `realDevicesError`，不影响模拟器列表）、`ios_sim_list_apps`、`ios_sim_launch_app`、`ios_sim_install_app`、`ios_sim_processes`、`ios_sim_app_info` |
| 其他工具 | 收到真机 udid 时明确说明"只支持模拟器"，并列出可用于真机的工具 |
| 卸载 | 真机上**拒绝**卸载：真机数据无法恢复，交给用户在手机上操作（上游没有卸载工具） |
| 错误分类 | 锁屏、开发者模式未开、未配对、CoreDevice 找不到设备，分别给出处理方法；"列表失败"绝不当成"没有这个 App" |
| 不移植 | 签名身份与团队检测（⑤b 构建 WDA 时再移植）；devicectl 的文本输出解析（只用 JSON） |

## 3. 验证

- 14 个新测试：devicectl 解析和命令流程 7 个（用脚本化运行器），工具层真机分支 7 个（用假 devicectl）。
- 未连接真机验证。首次使用时需要确认：`devicectl list devices` 的 JSON 字段、`device info apps` 的 `url` 路径格式、进程与 App 路径的对应关系。
