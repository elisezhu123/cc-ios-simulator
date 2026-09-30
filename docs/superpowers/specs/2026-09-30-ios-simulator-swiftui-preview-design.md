# iOS Simulator 插件 · 第 ④ 期（SwiftUI 预览热重载）设计

- 日期：2026-09-30
- 状态：已实现
- 参考源：[dsh-ios](https://github.com/ZSeven-W/dsh-ios) `0.1.0-rc.10` @ `d9a9731` 的 `src/preview-host.ts`、`src/tool-preview.ts`、`assets/preview-host/*.swift`（MIT，© 2026 ZSeven—W）
- 前置：[第 ③ 期设计](2026-09-30-ios-simulator-logs-debug-design.md)

## 1. 目标

`ios_sim_preview` 把一个 Swift 包里的 SwiftUI 预览直接跑在模拟器里，保存文件后几秒内热替换，不重启 App。

## 2. 工作方式

1. 在插件缓存 `<cache>/preview/<包名>/` 里生成一次性的宿主 App（`assets/preview-host/*.swift`），编译、ad-hoc 签名、安装并启动。宿主轮询自己沙盒里的 `Documents/ios-sim-preview-drop/`。
2. 生成一个依赖用户包的"动态库包"，入口文件 `Entry.swift` 汇总所有预览，导出 `iossim_preview_count / _name / _make_view` 三个 C 符号，编译成模拟器用的动态库。
3. 动态库复制到宿主的 drop 目录，命名为 `preview_<n>.dylib`，同时写入 `manifest.json`。宿主 `dlopen` 新库并替换画面，然后把加载到的版本写回 `result.json`。插件从 Mac 这一侧读取 `result.json` 确认。
4. 监听包目录（忽略 `.build` 等），去抖 300 ms 后重新扫描、生成、增量编译、推送。编译失败时保留上一个版本，错误末尾通过 `status` 返回。drop 目录只保留最近 3 个版本的动态库。

## 3. 已确定的决策

| 决策 | 结论 |
|---|---|
| 拆分 | `src/preview-source.ts` 放纯逻辑（Package.swift 解析、预览扫描、生成 Swift 代码、编译输出过滤）；`src/preview-host.ts` 放会话控制器 |
| 可测试性 | swift build、codesign、SDK 路径通过 `PreviewToolchain` 注入；simctl、文件监听、时间参数也都可注入。测试里用假工具链和一个模拟宿主 App 的轮询器，跑完"启动 → 修改 → 热替换 → 编译失败 → 恢复 → 停止"整个循环 |
| 扫描范围 | 只扫描 `.target(...)` 的源码目录（上游扫描整个包，测试目录里的预览会引用不存在的模块）；dependencies 里出现的 `.target(name:)` 只算一次；Package.swift 的注释会被忽略 |
| internal 类型 | 入口以 `@testable import` 引入用户模块（SwiftPM debug 构建默认开启 testing），预览里可以用 internal 类型。上游用普通 `import`，但文档里说支持 internal，两者不一致 |
| 设备 | 沿用 `resolveTargetDevice`（指定设备 → 推流设备 → 已启动设备 → 自动启动最新 iPhone）。停止时不关机 |
| 实时画面 | serve-sim 可用时启动推流并返回 `panelUrl`；不可用时预览照常运行，提示在 Simulator.app 里看 |
| 命名 | 符号前缀 `iossim_`，bundle id `dev.ios-simulator.preview-host`，drop 目录 `ios-sim-preview-drop` |
| 退出 | 服务退出时与其他清理并行执行：终止并卸载宿主 App |

## 4. 验证

- 13 个新测试：纯逻辑 5 个，控制器完整循环 6 个（含真实文件监听），工具层 2 个。
- 未在 Mac 上验证。首次使用时需要确认：`xcrun swift build --triple arm64-apple-ios<v>.0-simulator` 能否编出宿主和动态库、`@testable import` 能否编过、宿主 `dlopen` 热替换、`simctl get_app_container` 返回的路径能否从 Mac 侧写入。
