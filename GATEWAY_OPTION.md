# iOS Simulator Panel - Remote MCP Gateway 版本

## 🌐 通过 Claude.ai Gateway 使用

如果你想通过 claude.ai（Web 版）使用这个功能，需要：

### 架构变化

```
原来（本地）:
Claude Desktop ← stdio → MCP Server（本机） → xcrun simctl

现在（远程）:
claude.ai ← HTTPS → MCP Gateway Server ← → xcrun simctl
```

### 需要做的改动

#### 1. 修改 Transport: stdio → HTTP

**当前代码** (stdio):
```typescript
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const transport = new StdioServerTransport();
await server.connect(transport);
```

**改为 HTTP**:
```typescript
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import express from 'express';

const app = express();
const transport = new SSEServerTransport('/message', res);
app.post('/message', (req, res) => {
  // 处理 MCP 请求
});
app.listen(3000);
```

#### 2. 部署到服务器

你需要：
- 一台有 macOS 的服务器（因为需要 Xcode）
- 公网 IP 或域名
- HTTPS 证书

#### 3. 在 Claude.ai 中配置

在 claude.ai 的设置中添加 MCP Gateway：
```
https://your-server.com/mcp
```

### ⚠️ 限制

**重要：这个方案有很大的限制！**

1. **必须是 macOS 服务器**
   - xcrun simctl 只能在 macOS 上运行
   - 需要安装 Xcode

2. **安全性问题**
   - 暴露模拟器控制到公网
   - 需要添加认证和授权

3. **性能问题**
   - 截图通过网络传输
   - 延迟会更高

4. **成本**
   - 需要云服务器（macOS 云服务器很贵）
   - 或者本地机器 + 端口转发

### 💡 推荐方案

**对于 iOS Simulator，我强烈推荐使用本地 MCP Server（已实现）**

原因：
1. ✅ iOS 模拟器本来就在你的本地 Mac 上
2. ✅ 不需要服务器和网络传输
3. ✅ 更快、更安全、更简单
4. ✅ 一次配置，永久使用

### 🤔 你可能想要的

如果你觉得配置 MCP Server 太麻烦，你可能想要的是：

#### 选项 A: 简化配置
我可以创建一个**一键安装脚本**：
```bash
curl -fsSL https://your-url/install.sh | bash
```
自动完成所有配置。

#### 选项 B: Electron 插件（但不可行）
做一个 Claude Desktop 的 Electron 插件？
❌ 不可行 - Claude Desktop 不支持第三方插件

#### 选项 C: 独立应用
做一个独立的 Electron 应用？
⚠️ 可以，但就失去了"集成到 Claude"的意义

### 🎯 最佳实践

**对于本地工具（如 iOS Simulator），使用本地 MCP Server 是最佳方案：**

1. 运行一次配置：
   ```bash
   npm run configure
   ```

2. 重启 Claude Desktop（一次）

3. 以后都可以直接使用：
   ```
   "打开 iOS 模拟器面板"
   ```

配置只需要做一次，之后就像原生功能一样使用！

### 📊 方案对比

| 特性 | 本地 MCP | 远程 Gateway | 原生插件 |
|------|---------|--------------|----------|
| 功能完整 | ✅ | ✅ | ✅ |
| 速度快 | ✅ | ❌ | ✅ |
| 安全 | ✅ | ⚠️ | ✅ |
| 易配置 | ✅ | ❌ | ✅ |
| 成本 | 免费 | 贵 | N/A |
| 可行性 | ✅ | ⚠️ | ❌ |

### 🚀 建议

**使用我们已经实现的本地 MCP Server！**

虽然需要一次配置，但：
- ✅ 配置过程只需 2 分钟
- ✅ 我提供了自动化脚本
- ✅ 配置一次，永久使用
- ✅ 性能最好，最安全

如果你想要我做一个**超级简化的一键安装脚本**，让配置过程更简单，请告诉我！
