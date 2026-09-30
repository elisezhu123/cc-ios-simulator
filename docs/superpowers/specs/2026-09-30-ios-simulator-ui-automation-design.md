# iOS Simulator 插件 · 第 ② 期（UI 自动化）设计

- 日期：2026-09-30
- 状态：已实现（模拟器部分）
- 参考源：[dsh-ios](https://github.com/ZSeven-W/dsh-ios) `0.1.0-rc.10` @ `d9a9731`（MIT，© 2026 ZSeven—W）
- 前置：[第 ① 期设计](2026-09-28-ios-simulator-foundation-design.md)

## 1. 目标

让 Claude 按"含义"读屏和操作，不再靠猜坐标：

- 读取无障碍树，按 identifier / label 点击控件；
- 用 Vision OCR 识别屏幕文字，按文字点击、等待文字出现或消失；
- 把信息流拆成行，在行内按相对位置点击，并用计数变化确认操作生效。

**本期不做**：真机（WebDriverAgent）分支。上游的这 7 个工具同时支持模拟器和真机，真机部分随第 ⑤ 期移植。

## 2. 已确定的决策

| 决策 | 结论 |
|---|---|
| 无障碍树后端 | AXe CLI（MIT）。查找顺序：`IOS_SIM_AXE_BIN` → PATH → Homebrew → 插件缓存；都没有时下载固定版本 v1.8.0，校验上游固定的 SHA-256，并记录解压后二进制的摘要，每次使用前复核 |
| OCR 后端 | 插件自带 `assets/ocr.swift`（VNRecognizeTextRequest，accurate，zh-Hans + en-US），首次使用时用 swiftc 编译进 `<cache>/bin/ocr/<源码哈希前 16 位>/`，记录二进制摘要 |
| 可测试性 | `AxeHelper`、`OcrHelper` 通过构造参数接收 platform、env、缓存目录；工具层通过 `ToolDeps.axe` / `ToolDeps.ocr` 注入，测试用假实现，可在 Linux 上运行 |
| 坐标空间 | AXe 帧和 OCR 结果统一报告为设备**点**。OCR 框从像素换算到点时，用截图像素尺寸和 AXe 根节点尺寸（按 udid + 像素尺寸缓存）；AXe 不可用时退回像素，并在 `note` 里说明 |
| 点击通道 | `tap_element`、`tap_row` 用 AXe HID 点击（点坐标）；`tap_text` 与上游一致，走 serve-sim 归一化坐标，横屏时按 `ios_sim_interact` 的规则映射到帧缓冲 |
| 结果截图 | 与 `ios_sim_interact` 一致：三个点击工具默认附带效果截图（图片块），可用 `screenshot:false` 关闭。这点与上游不同（上游面向纯文本模型） |
| 确认结果 | `expect_text` / `expect_gone` 点击后轮询 OCR（约 4 秒，每 600 ms 一次）；`tap_row` 的 `expect_count` 在 800 ms 后重读该行，校验计数正好变化 ±1，行里没有这个计数时在点击**之前**就拒绝 |
| 无标签提示 | 模拟器的 AXe 输出是整棵树，没有采样深度的概念。所以去掉了上游依赖采样深度的"列表重定向"提示，只按过滤未命中 / `max_depth` / 输出上限 / 全在屏幕外 / 确实无标签来给出原因 |

## 3. 工具（7 个，合计 23 个）

| 工具 | 后端 | 说明 |
|---|---|---|
| `ios_sim_ui_tree` | AXe | 紧凑树，过滤、`max_depth`、屏幕外裁剪、40 KB 上限 |
| `ios_sim_tap_element` | AXe | 先精确匹配、再包含匹配；嵌套重复合并；屏幕外 / 禁用拒绝；多个匹配列出候选 |
| `ios_sim_find_text` | OCR | 文字、置信度、点坐标；按置信度排序，40 KB 上限 |
| `ios_sim_tap_text` | OCR + serve-sim | 与 `tap_element` 相同的匹配规则；低于阈值的匹配会被点名 |
| `ios_sim_wait_for` | OCR | 超时返回 `matched:false` |
| `ios_sim_ui_rows` | AXe | 行识别（Cell 类型 + 同形状重复容器兜底），计数解析 |
| `ios_sim_tap_row` | AXe | 行内相对位置点击，越界失败不截断，`expect_count` 校验 |

## 4. 文件

```
assets/ocr.swift            # 移植
src/uitree-backend.ts       # 移植，改为 AxeHelper 类
src/ocr-backend.ts          # 移植，改为 OcrHelper 类
src/list-rows.ts            # 原样移植
src/uitree.ts               # 从 tool-uitree.ts 抽出的纯逻辑（模拟器分支）
src/tools/ui.ts             # 7 个工具的注册
test/{uitree,uitree-backend,ocr-backend,list-rows,tools-ui}.test.ts
```

## 5. 验证

- 单元测试和集成测试：43 个新用例，用假的 axe / swiftc 脚本覆盖查找、编译缓存、摘要校验和重建。
- 未在真实 macOS 模拟器上跑过。首次在 Mac 上使用时需要确认：AXe 下载和校验、swiftc 编译、`tap_text` 在横屏下的映射。
