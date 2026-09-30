# iOS Simulator 插件 · 第 ③ 期（日志与调试）设计

- 日期：2026-09-30
- 状态：已实现（模拟器部分）
- 参考源：[dsh-ios](https://github.com/ZSeven-W/dsh-ios) `0.1.0-rc.10` @ `d9a9731` 的 `src/tool-logs.ts`、`src/tool-debug.ts`（MIT，© 2026 ZSeven—W）
- 前置：[第 ② 期设计](2026-09-30-ios-simulator-ui-automation-design.md)

## 1. 目标

让 Claude 排查 App 的问题：看日志、找进程、抓卡住时的线程栈、查内存泄漏、找到 App 的数据目录。

**本期不做**：真机分支（上游通过 devicectl 列真机进程和 App 信息，真机上的日志、线程栈和泄漏检查上游也不支持），随第 ⑤ 期处理。

## 2. 已确定的决策

| 决策 | 结论 |
|---|---|
| 子进程运行器 | `src/devtools.ts` 的 `DevTools.run`：子进程作为进程组组长启动，关窗口、到期、中止时整组 SIGTERM，2 秒后 SIGKILL；输出只保留末尾 2 MB。通过 `ToolDeps.devtools` 注入，测试用假实现 |
| 抓取窗口与超时分开 | `windowMs` 到了杀掉进程组，算**成功**（`log stream` 的正常结束）；`timeoutMs` 到了也杀掉，但算**失败** |
| 被挂起的目标 | lldb attach 和 leaks 会挂起 App。只要运行器杀过子进程，就用 `ps -o stat=` 检查目标，处于 `T`（停止）状态就发 SIGCONT，并在结果里报告 `resumed`。backtrace / leaks 正常结束后也会再确认一次 |
| 目标限制 | pid 必须出现在这台模拟器 launchd 的 `UIKitApplication:*` 列表里，绝不 attach 宿主机上的其他进程 |
| backtrace | `lldb -b -o "attach <pid>" -o "thread backtrace all" -o detach`（批处理，不开交互会话），30 秒超时；拿不到栈就退回 `sample <pid> 1 1 -file …`，并在 note 里说明原因和 `sudo DevToolsSecurity -enable` |
| leaks | `leaks --nostacks <pid>` 解析摘要（前 30 种泄漏类型）；`memgraph` 模式用 `--outputGraph` 导出，不解析文件；120 秒超时 |
| 日志 | `xcrun simctl spawn <udid> log show --last <d>` 或 `log stream`（1–60 秒窗口），`--style compact`；`bundle_id` 展开为 `subsystem == id OR process == 末段`；grep 在截断**之前**应用，然后保留末尾 300 行 / 30 KB |
| app_info | `simctl appinfo`（OpenStep plist，只取标量值，`file://` URL 转成路径），缺字段时用 `get_app_container` 补 |
| 相对上游的小改动 | `log show` 的 debug 级别同时传 `--info --debug`；plist 解析跳过字典 / 数组值；grep 作用于完整抓取结果而不是已截断的末尾 |

## 3. 工具（5 个，合计 28 个）

`ios_sim_logs`、`ios_sim_processes`、`ios_sim_backtrace`、`ios_sim_leaks`、`ios_sim_app_info`。

## 4. 验证

- 20 个新测试：解析器用真实格式的样例；运行器用真实的短命子进程测窗口关闭、非零退出、超时、中止、启动失败；工具层用假运行器。
- 未在真实 macOS 模拟器上跑过。首次在 Mac 上使用时需要确认：`launchctl list` 的输出格式、lldb 批处理在开发者模式开 / 关时的表现、leaks 的输出格式。
