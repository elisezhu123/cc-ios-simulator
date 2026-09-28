## 🎉 iOS Simulator Panel MCP - 项目完成！

### ✅ 已完成的功能

这个 MCP App 实现了类似 Claude Desktop 官方 iOS Simulator 插件的功能，可以在**右侧面板**实时预览和控制 iOS 模拟器。

### 📁 项目结构

```
ios-simulator-panel/
├── src/
│   ├── index.ts              # MCP Server 主逻辑
│   └── ui/
│       └── index.html        # 实时预览面板 UI
├── dist/                     # 编译输出
├── package.json              # 依赖配置
├── tsconfig.json             # TypeScript 配置
├── install.sh                # 一键安装脚本
├── test-server.mjs           # 测试脚本
├── README.md                 # 完整文档
├── QUICKSTART.md             # 快速开始指南
└── claude_desktop_config.example.json
```

### 🎯 核心功能

#### 1. MCP Tools (7个工具)

- ✅ `simulator_open_panel` - 打开实时预览面板（带 UI）
- ✅ `simulator_list` - 列出所有可用模拟器
- ✅ `simulator_boot` - 启动指定模拟器
- ✅ `simulator_shutdown` - 关闭模拟器
- ✅ `simulator_screenshot` - 截图
- ✅ `simulator_home` - 按 Home 键
- ✅ `simulator_rotate` - 旋转设备

#### 2. 实时预览面板 UI

- ✅ **实时截图显示** - 每 2 秒自动刷新
- ✅ **设备边框** - 仿真 iPhone 外观（黑色圆角边框）
- ✅ **底部工具栏** - 6 个操作按钮
- ✅ **状态提示** - 显示当前操作状态
- ✅ **深色主题** - 配色：#0F1117 背景 + #5B8CFF 强调色

#### 3. 交互按钮

| 按钮 | 功能 | 图标 |
|------|------|------|
| 🏠 Home | 返回主屏幕 | 房子 |
| 📸 Screenshot | 手动截图 | 相机 |
| ↶ Rotate Left | 向左旋转 | 左箭头 |
| ↷ Rotate Right | 向右旋转 | 右箭头 |
| 🔄 Refresh | 刷新视图 | 刷新 |
| ⏻ Shutdown | 关闭模拟器 | 电源（红色） |

### 🏗️ 技术架构

```
┌─────────────────────────────────────────┐
│      Claude Desktop (右侧面板)            │
│  ┌─────────────────────────────────┐    │
│  │   实时预览面板 (HTML/JS)          │    │
│  │   - 显示截图                      │    │
│  │   - 控制按钮                      │    │
│  │   - 每 2 秒刷新                   │    │
│  └──────────┬──────────────────────┘    │
│             │ MCP App Bridge            │
└─────────────┼─────────────────────────┘
              │
              ▼
┌─────────────────────────────────────────┐
│     MCP Server (stdio transport)        │
│  - 注册 7 个工具                         │
│  - 提供 UI resource                      │
│  - 处理工具调用                          │
│  - 返回 base64 截图                      │
└──────────────┬──────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────┐
│   xcrun simctl (Xcode CLI)              │
│  - simctl list devices                  │
│  - simctl boot <udid>                   │
│  - simctl shutdown <udid>               │
│  - simctl io <udid> screenshot          │
│  - simctl ui <udid> home/rotate         │
└──────────────┬──────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────┐
│        iOS Simulator.app                │
└─────────────────────────────────────────┘
```

### 🚀 使用流程

1. **用户说**: "打开 iOS 模拟器面板"
2. **Claude 调用**: `simulator_open_panel` 工具
3. **MCP Server**:
   - 查找正在运行的模拟器
   - 截取当前画面
   - 返回 UI resource + screenshot base64
4. **Claude Desktop**:
   - 在右侧渲染 HTML 面板
   - 显示截图
5. **面板 UI**:
   - 显示截图
   - 启动定时器（每 2 秒刷新）
   - 等待用户点击按钮
6. **用户点击按钮**:
   - 通过 App Bridge 调用相应的 MCP tool
   - 执行操作（home/rotate/screenshot 等）
   - 刷新截图显示

### 📦 快速安装

```bash
# 1. 运行安装脚本
./install.sh

# 2. 重启 Claude Desktop

# 3. 启动模拟器
open -a Simulator

# 4. 在 Claude 中说
"打开 iOS 模拟器面板"
```

### 🔍 测试结果

✅ MCP Server 启动成功  
✅ 7 个工具正确注册  
✅ UI resource 正确声明  
✅ `simulator_open_panel` 带有 `_meta["ui/resourceUri"]`  
✅ TypeScript 编译无错误  
✅ 依赖安装完成

### 🎨 设计特点

按照你的 design_sense：

- **调色板**: Slate-dark (#0F1117, #171A23, #1E222E) + 蓝色强调 (#5B8CFF)
- **字体**: 系统字体栈 (-apple-system, Segoe UI)
- **圆角**: 设备边框 40px，按钮 6px
- **布局**: Flex 布局，从上到下：header → 预览区 → 工具栏
- **按钮**: 深色背景 + hover 高亮，红色 danger 按钮用于 shutdown

### 📝 配置文件位置

```
~/Library/Application Support/Claude/claude_desktop_config.json
```

### 🔧 后续可以添加的功能

- [ ] 支持多个模拟器切换
- [ ] 录屏功能
- [ ] 触摸/手势模拟
- [ ] 网络状态切换
- [ ] 电池电量模拟
- [ ] 位置模拟
- [ ] 推送通知测试
- [ ] 应用安装/卸载

### 🎯 与官方插件的对比

| 特性 | 官方插件 | 这个实现 |
|------|---------|---------|
| 实时预览 | ✅ | ✅ |
| 控制按钮 | ✅ | ✅ |
| 刷新频率 | 实时 | 2秒轮询 |
| 实现方式 | 原生？ | MCP App |
| 开源 | ❌ | ✅ |
| 可定制 | ❌ | ✅ |

### 📚 参考资料

- [MCP Apps Documentation](https://apps.extensions.modelcontextprotocol.io/api/)
- [MCP Protocol Spec](https://modelcontextprotocol.io/specification/draft.md)
- [Xcode simctl Reference](https://developer.apple.com/documentation/xcode/xcode-command-line-tool-reference)

---

**现在你可以在 Claude Desktop 中直接预览和控制 iOS Simulator 了！🎉**
