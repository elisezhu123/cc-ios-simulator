# iOS Simulator Panel - 架构图

## 🏗️ 系统架构

```
┌─────────────────────────────────────────────────────────────────┐
│                     Claude Desktop App                          │
│                                                                 │
│  ┌────────────────────┐              ┌──────────────────────┐  │
│  │                    │              │   Conversation       │  │
│  │   左侧: 对话区域     │              │   (用户 ↔ Claude)    │  │
│  │                    │              │                      │  │
│  │  User: "打开 iOS    │              │   Claude 调用:       │  │
│  │        模拟器面板"   │─────────────▶│   simulator_        │  │
│  │                    │              │   open_panel()       │  │
│  └────────────────────┘              └──────────┬───────────┘  │
│                                                 │              │
│                                                 ▼              │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │              右侧: 实时预览面板 (HTML/CSS/JS)              │  │
│  │  ┌────────────────────────────────────────────────────┐  │  │
│  │  │           📱 iPhone Device Frame                   │  │  │
│  │  │  ┌──────────────────────────────────────────────┐  │  │  │
│  │  │  │                                              │  │  │  │
│  │  │  │         📸 实时截图显示                       │  │  │  │
│  │  │  │        (每 2 秒自动刷新)                      │  │  │  │
│  │  │  │                                              │  │  │  │
│  │  │  │    [显示 iOS 模拟器当前画面]                  │  │  │  │
│  │  │  │                                              │  │  │  │
│  │  │  └──────────────────────────────────────────────┘  │  │  │
│  │  │                                                    │  │  │
│  │  │  🏠  📸  ↶  ↷  🔄  ⏻                              │  │  │
│  │  │  [Home][Shot][L][R][Refresh][Shutdown]           │  │  │
│  │  └────────────────────────────────────────────────────┘  │  │
│  │                                                          │  │
│  │  JavaScript 逻辑:                                         │  │
│  │  - setInterval(() => refreshScreenshot(), 2000)         │  │
│  │  - 按钮点击 → MCP Tool 调用                              │  │
│  │  - 通过 App Bridge 与 MCP Server 通信                    │  │
│  └──────────────────────┬───────────────────────────────────┘  │
│                         │                                      │
└─────────────────────────┼──────────────────────────────────────┘
                          │
                          │ MCP App Bridge
                          │ (stdio transport)
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│              MCP Server (TypeScript/Node.js)                    │
│                                                                 │
│  📦 src/index.ts                                                │
│  ┌───────────────────────────────────────────────────────────┐ │
│  │  import { Server } from '@modelcontextprotocol/sdk'      │ │
│  │  import { createAppServer } from '@modelcontextprotocol/ │ │
│  │                               ext-apps'                   │ │
│  └───────────────────────────────────────────────────────────┘ │
│                                                                 │
│  🛠️ 注册的 Tools:                                              │
│  ┌───────────────────────────────────────────────────────────┐ │
│  │  1. simulator_open_panel   ← 特殊: 返回 UI resource       │ │
│  │     {                                                     │ │
│  │       _meta: {                                            │ │
│  │         "ui/resourceUri": "ui://index.html"               │ │
│  │       }                                                   │ │
│  │     }                                                     │ │
│  │                                                           │ │
│  │  2. simulator_list         ← 列出设备                     │ │
│  │  3. simulator_boot         ← 启动设备                     │ │
│  │  4. simulator_shutdown     ← 关闭设备                     │ │
│  │  5. simulator_screenshot   ← 截图 (返回 base64)           │ │
│  │  6. simulator_home         ← Home 键                      │ │
│  │  7. simulator_rotate       ← 旋转设备                     │ │
│  └───────────────────────────────────────────────────────────┘ │
│                                                                 │
│  📄 UI Resources:                                               │
│  ┌───────────────────────────────────────────────────────────┐ │
│  │  ui://index.html  → dist/ui/index.html                    │ │
│  │  - 完整的 HTML/CSS/JS                                      │ │
│  │  - 嵌入式样式和脚本                                         │ │
│  │  - 通过 App Bridge 调用 MCP tools                          │ │
│  └───────────────────────────────────────────────────────────┘ │
│                                                                 │
│  每个 Tool 的实现:                                              │
│  ┌───────────────────────────────────────────────────────────┐ │
│  │  server.setRequestHandler(CallToolRequestSchema,          │ │
│  │    async (request) => {                                   │ │
│  │      switch (request.params.name) {                       │ │
│  │        case 'simulator_screenshot':                       │ │
│  │          → execSync('xcrun simctl io ... screenshot')     │ │
│  │          → readFileSync() → base64                        │ │
│  │          → return { content: [...] }                      │ │
│  │      }                                                     │ │
│  │    }                                                      │ │
│  │  )                                                        │ │
│  └───────────────────────────────────────────────────────────┘ │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           │ child_process.execSync()
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                  xcrun simctl (Xcode CLI)                       │
│                                                                 │
│  📱 命令:                                                        │
│  ┌───────────────────────────────────────────────────────────┐ │
│  │  xcrun simctl list devices              ← 列出设备         │ │
│  │  xcrun simctl boot <udid>               ← 启动            │ │
│  │  xcrun simctl shutdown <udid>           ← 关闭            │ │
│  │  xcrun simctl io <udid> screenshot      ← 截图            │ │
│  │  xcrun simctl ui <udid> appearance      ← 外观            │ │
│  │  xcrun simctl pbsync <udid>             ← 剪贴板          │ │
│  └───────────────────────────────────────────────────────────┘ │
│                                                                 │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           │ 控制
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                     iOS Simulator.app                           │
│                                                                 │
│  📱 运行的模拟器:                                                │
│  ┌───────────────────────────────────────────────────────────┐ │
│  │  • iPhone 18 Pro                                          │ │
│  │  • iOS 27.0                                               │ │
│  │  • UDID: B1F23680-CED0-4008-9C44-3B1C12FB5AD8            │ │
│  │  • 状态: Booted                                           │ │
│  └───────────────────────────────────────────────────────────┘ │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

## 🔄 数据流

### 1. 打开面板
```
用户: "打开 iOS 模拟器面板"
  ↓
Claude Desktop: 识别意图
  ↓
调用 MCP Tool: simulator_open_panel()
  ↓
MCP Server: 
  1. 查找正在运行的模拟器
  2. 截取当前画面
  3. 返回 UI resource + screenshot base64
  ↓
Claude Desktop:
  1. 在右侧渲染 HTML 面板
  2. 加载 ui://index.html
  3. 注入初始截图数据
  ↓
面板 UI:
  1. 显示截图
  2. 启动自动刷新定时器 (2s)
  3. 等待用户交互
```

### 2. 自动刷新
```
setInterval (每 2 秒):
  ↓
JavaScript: refreshScreenshot()
  ↓
通过 App Bridge 调用: simulator_screenshot
  ↓
MCP Server: 执行 xcrun simctl screenshot
  ↓
返回: base64 图片
  ↓
JavaScript: 更新 <img> src
  ↓
用户看到: 最新的模拟器画面
```

### 3. 用户点击按钮
```
用户点击: 🏠 Home 按钮
  ↓
JavaScript: handleHome()
  ↓
通过 App Bridge 调用: simulator_home
  ↓
MCP Server: execSync('xcrun simctl ui home')
  ↓
Simulator.app: 执行 Home 操作
  ↓
下次刷新时: 显示主屏幕
```

## 📁 文件结构

```
ios-simulator-panel/
│
├── src/
│   ├── index.ts              ← MCP Server 主代码
│   │   ├── 注册 7 个 tools
│   │   ├── 声明 UI resources
│   │   ├── 处理 tool 调用
│   │   └── 执行 xcrun simctl 命令
│   │
│   └── ui/
│       └── index.html        ← 实时预览面板 UI
│           ├── HTML 结构
│           ├── CSS 样式 (嵌入)
│           └── JavaScript 逻辑 (嵌入)
│
├── dist/                     ← 编译输出
│   ├── index.js             ← 编译后的服务器
│   └── ui/
│       └── index.html       ← 复制的 UI
│
├── package.json              ← 项目配置
├── tsconfig.json             ← TypeScript 配置
├── .gitignore
│
├── README.md                 ← 完整文档
├── QUICKSTART.md             ← 快速指南
├── SUMMARY.md                ← 项目总结
├── PROJECT.txt               ← 项目说明
├── ARCHITECTURE.md           ← 本文件
│
├── install.sh                ← 一键安装
├── configure.mjs             ← 自动配置
├── demo.sh                   ← 演示脚本
├── test-server.mjs           ← 测试脚本
│
└── claude_desktop_config.example.json
                              ← 配置示例
```

## 🔌 集成点

### 1. MCP Protocol
- **Transport**: stdio (标准输入输出)
- **Format**: JSON-RPC 2.0
- **Tools**: CallToolRequest/Response
- **Resources**: ReadResourceRequest/Response

### 2. MCP Apps Extension
- **UI Resources**: `ui://` 协议
- **App Bridge**: JavaScript ↔ MCP Server
- **Meta Field**: `_meta["ui/resourceUri"]`

### 3. Xcode Simulator
- **CLI**: `xcrun simctl`
- **Format**: 文本输出 + 文件操作
- **Screenshot**: PNG 文件 → base64

## 🎯 关键设计决策

### 1. 为什么用 MCP Apps 而不是纯 MCP Tools？
- ✅ 可以嵌入实时预览 UI
- ✅ 用户体验更好（不需要反复截图）
- ✅ 支持自动刷新
- ✅ 可以添加交互按钮

### 2. 为什么用轮询而不是实时流？
- ✅ 实现简单（MCP 目前不支持 streaming images）
- ✅ 资源占用可控
- ✅ 2 秒刷新对大多数场景足够
- ⚠️  未来可以优化为事件驱动

### 3. 为什么把 UI 嵌入单个 HTML 文件？
- ✅ 部署简单（只需要一个文件）
- ✅ 不需要额外的 Web 服务器
- ✅ 样式和脚本都在一个地方
- ✅ 容易维护

### 4. 为什么用 TypeScript？
- ✅ 类型安全
- ✅ 更好的 IDE 支持
- ✅ MCP SDK 官方支持
- ✅ 易于重构

## 📊 性能考量

- **截图频率**: 2 秒 (可配置)
- **截图大小**: ~100-500KB (取决于分辨率)
- **内存占用**: ~50MB (Node.js + MCP Server)
- **CPU 占用**: 几乎为 0 (仅在截图时有短暂峰值)

## 🔮 未来改进方向

1. **性能优化**
   - 使用增量截图（只传输变化部分）
   - 支持更高的刷新率
   - 添加截图压缩

2. **功能扩展**
   - 支持多个模拟器切换
   - 触摸/手势模拟
   - 录屏功能
   - 网络状态控制
   - 位置模拟

3. **UI 改进**
   - 可调整的面板大小
   - 自定义刷新频率
   - 更多的设备边框样式
   - 键盘快捷键

4. **集成增强**
   - 与 Xcode 项目集成
   - 自动检测应用变化
   - 支持 SwiftUI 预览
   - 日志实时显示
