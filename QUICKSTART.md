# Quick Start Guide

## 快速开始

### 1. 安装

运行安装脚本：

```bash
./install.sh
```

或者手动安装：

```bash
npm install
npm run build
```

然后编辑 `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "ios-simulator": {
      "command": "node",
      "args": ["/Users/elise123/Tools/Claude/ios-simulator-panel/dist/index.js"]
    }
  }
}
```

### 2. 重启 Claude Desktop

关闭并重新打开 Claude Desktop 应用。

### 3. 启动 Simulator

打开 Xcode Simulator（或者让 Claude 帮你启动）：

```bash
open -a Simulator
```

### 4. 打开预览面板

在 Claude Desktop 中说：

```
打开 iOS 模拟器面板
```

或者：

```
Open the iOS simulator panel
```

Claude 会调用 `simulator_open_panel` 工具，右侧就会出现一个**实时预览面板**！

## 面板功能

面板打开后，你可以直接点击底部的按钮：

- **🏠 Home** - 返回主屏幕
- **📸 Screenshot** - 截图
- **↶ Rotate Left** - 向左旋转
- **↷ Rotate Right** - 向右旋转  
- **🔄 Refresh** - 手动刷新
- **⏻ Shutdown** - 关闭模拟器

面板会**每 2 秒自动刷新**一次，实时显示模拟器画面。

## 工作原理

```
Claude Desktop (右侧面板)
    ↕ MCP App Bridge
MCP Server (后台)
    ↕ xcrun simctl 命令
iOS Simulator
```

1. 你在 Claude 中请求打开面板
2. MCP server 返回一个 UI resource（HTML）
3. Claude Desktop 在右侧渲染这个 HTML
4. HTML 通过 App Bridge 调用 MCP tools
5. MCP tools 执行 `xcrun simctl` 命令控制模拟器
6. 截图以 base64 返回，实时显示在面板中

## 调试

测试 MCP server 是否正常：

```bash
node test-server.mjs
```

使用 MCP Inspector 测试：

```bash
npx @modelcontextprotocol/inspector node dist/index.js
```

查看可用的模拟器：

```bash
xcrun simctl list devices available
```

## 常见问题

**Q: 面板显示"No booted simulator"？**  
A: 先启动一个模拟器：`open -a Simulator`

**Q: 截图不更新？**  
A: 检查模拟器是否在前台，点击 Refresh 按钮

**Q: Claude Desktop 没有识别到工具？**  
A: 检查配置文件路径是否正确，重启 Claude Desktop

**Q: 想要更高的刷新率？**  
A: 编辑 `src/ui/index.html`，修改 `setInterval(refreshScreenshot, 2000)` 中的毫秒数

## 与官方插件的区别

官方的 iOS Simulator 插件可能是原生实现，这个是基于：
- MCP App（自定义 UI 面板）
- xcrun simctl（命令行工具）
- 定时轮询截图（每 2 秒）

功能类似，但实现更简单，完全开源可定制！

## 进一步定制

想要添加更多功能？编辑以下文件：

- `src/index.ts` - 添加新的 MCP tools
- `src/ui/index.html` - 修改 UI 界面和按钮
- CSS 部分 - 改变颜色、布局等

然后重新 build：

```bash
npm run build
```

重启 Claude Desktop 即可看到更改。
