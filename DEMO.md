# 🎬 iOS Simulator Panel - 使用演示

## 完成状态：✅ 100%

所有功能已经实现并测试通过！

---

## 📦 安装步骤

### 方式 1: 自动配置（推荐）

```bash
cd /Users/elise123/Tools/Claude/ios-simulator-panel
npm run configure
```

这会自动：
- ✅ 编译项目
- ✅ 更新 Claude Desktop 配置
- ✅ 创建备份（如果已有配置）

### 方式 2: 安装脚本

```bash
./install.sh
```

### 方式 3: 手动配置

1. 编译项目：
```bash
npm install
npm run build
```

2. 编辑配置文件：
```bash
vi ~/Library/Application\ Support/Claude/claude_desktop_config.json
```

3. 添加以下内容：
```json
{
  "mcpServers": {
    "ios-simulator": {
      "command": "node",
      "args": [
        "/Users/elise123/Tools/Claude/ios-simulator-panel/dist/index.js"
      ]
    }
  }
}
```

4. 重启 Claude Desktop

---

## 🚀 使用示例

### 场景 1: 打开面板

**你说：**
> 打开 iOS 模拟器面板

或

> Open the iOS simulator panel

**Claude 会：**
1. 调用 `simulator_open_panel` 工具
2. 在右侧显示实时预览面板
3. 显示当前模拟器画面
4. 启动自动刷新（每 2 秒）

**你会看到：**
```
┌─────────────────────────────┐
│  iOS Simulator             │
│  iPhone 18 Pro - iOS 27.0  │
├─────────────────────────────┤
│                             │
│    📱 [模拟器截图]           │
│                             │
│                             │
├─────────────────────────────┤
│ 🏠  📸  ↶  ↷  🔄  ⏻       │
└─────────────────────────────┘
```

### 场景 2: 在 Claude 对话中控制

**你说：**
> 按一下 Home 键

**Claude 会：**
- 调用 `simulator_home` 工具
- 模拟器返回主屏幕
- 面板自动刷新显示主屏幕

**你说：**
> 截个图给我看看

**Claude 会：**
- 调用 `simulator_screenshot` 工具
- 在对话中显示截图

**你说：**
> 把模拟器向右旋转

**Claude 会：**
- 调用 `simulator_rotate` with direction: "right"
- 模拟器旋转到横屏
- 面板更新显示横屏画面

### 场景 3: 直接在面板操作

在右侧面板中，你可以直接点击按钮：

| 按钮 | 功能 | 效果 |
|------|------|------|
| 🏠 | Home | 立即返回主屏幕 |
| 📸 | Screenshot | 手动刷新截图 |
| ↶ | Rotate Left | 向左旋转 90° |
| ↷ | Rotate Right | 向右旋转 90° |
| 🔄 | Refresh | 立即刷新视图 |
| ⏻ | Shutdown | 关闭模拟器 |

**操作流程：**
1. 点击按钮
2. 看到状态提示："Executing..."
3. 操作完成："Done!"
4. 面板自动刷新显示结果

---

## 🎯 实际使用场景

### 开发 SwiftUI 应用

**场景：** 你正在用 Claude 开发一个 SwiftUI 应用

```
你: 帮我创建一个天气应用的主界面

Claude: [生成 SwiftUI 代码]

你: 打开模拟器面板，我想看看效果

Claude: [调用 simulator_open_panel]
       右侧出现实时预览面板

你: [在 Xcode 中构建并运行]

Claude: 我看到应用已经在模拟器中运行了，
       界面显示了温度和天气图标。
       需要调整什么吗？

你: 把温度字体放大一些

Claude: [修改代码，重新构建]
       现在字体更大了，更容易阅读。
```

### 调试布局问题

**场景：** 界面在横屏模式下有问题

```
你: 打开模拟器面板

Claude: [打开面板，显示竖屏模式]

你: 旋转到横屏看看

Claude: [点击 ↷ 按钮]
       现在是横屏模式，我看到布局有些元素重叠了。
       让我修改约束...

你: [看着右侧面板实时查看]

Claude: [修改代码，热重载]
       现在布局正常了，元素都正确排列了。
```

### 测试不同设备

**场景：** 需要在多个设备上测试

```
你: 列出所有可用的模拟器

Claude: [调用 simulator_list]
       找到以下设备：
       - iPhone 18 Pro (iOS 27.0)
       - iPhone 18 Pro Max (iOS 27.0)
       - iPad Pro 13-inch (iPadOS 27.0)

你: 启动 iPad Pro 并打开面板

Claude: [调用 simulator_boot + simulator_open_panel]
       iPad 模拟器已启动，面板显示更大的屏幕。
       你的应用在 iPad 上看起来很好！
```

---

## 🔍 故障排查

### 问题 1: 面板显示 "No booted simulator"

**原因：** 没有运行中的模拟器

**解决：**
```bash
# 方法 1: 直接打开 Simulator.app
open -a Simulator

# 方法 2: 让 Claude 启动
你: 启动一个 iPhone 18 Pro 模拟器
```

### 问题 2: 工具没有出现

**原因：** Claude Desktop 没有加载 MCP 服务器

**解决：**
1. 检查配置文件：
```bash
cat ~/Library/Application\ Support/Claude/claude_desktop_config.json
```

2. 确认路径正确：
```bash
ls -la /Users/elise123/Tools/Claude/ios-simulator-panel/dist/index.js
```

3. 重启 Claude Desktop（完全退出再打开）

4. 查看日志（如果有问题）：
```bash
tail -f ~/Library/Logs/Claude/mcp*.log
```

### 问题 3: 截图不更新

**原因：** 模拟器在后台或被其他窗口遮挡

**解决：**
- 点击 Refresh (🔄) 按钮
- 确保 Simulator.app 在前台
- 等待 2 秒让自动刷新生效

### 问题 4: 按钮点击无响应

**原因：** MCP App Bridge 通信问题

**解决：**
- 刷新面板（关闭再重新打开）
- 检查浏览器控制台（如果可访问）
- 重启 Claude Desktop

---

## 📊 测试清单

### ✅ 基础功能测试

- [x] MCP Server 成功启动
- [x] 7 个工具正确注册
- [x] UI resource 正确声明
- [x] TypeScript 编译无错误
- [x] 所有依赖正确安装

### ✅ 工具测试

- [x] `simulator_open_panel` - 打开面板
- [x] `simulator_list` - 列出设备
- [x] `simulator_boot` - 启动模拟器
- [x] `simulator_shutdown` - 关闭模拟器
- [x] `simulator_screenshot` - 截图
- [x] `simulator_home` - Home 键
- [x] `simulator_rotate` - 旋转设备

### ✅ UI 功能测试

- [x] 显示设备信息
- [x] 显示实时截图
- [x] 自动刷新（2秒）
- [x] 6 个控制按钮全部工作
- [x] 状态提示显示
- [x] 深色主题正确应用

---

## 🎨 自定义

### 调整刷新频率

编辑 `src/ui/index.html`：

```javascript
// 找到这行
setInterval(refreshScreenshot, 2000);

// 改为更快的刷新（1秒）
setInterval(refreshScreenshot, 1000);

// 或更慢的刷新（5秒）
setInterval(refreshScreenshot, 5000);
```

然后重新编译：
```bash
npm run build
```

### 修改面板样式

编辑 `src/ui/index.html` 中的 `<style>` 部分：

```css
/* 修改背景色 */
body {
  background: #1a1a2e; /* 改为你喜欢的颜色 */
}

/* 修改设备边框颜色 */
.device-frame {
  border: 16px solid #16213e; /* 改为你喜欢的颜色 */
}

/* 修改按钮颜色 */
.control-btn {
  background: #0f3460; /* 改为你喜欢的颜色 */
}
```

### 添加新功能

在 `src/index.ts` 中添加新工具：

```typescript
// 例如：添加录屏功能
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  // ... 现有代码 ...
  
  case 'simulator_record_video':
    // 实现录屏逻辑
    return {
      content: [{ type: 'text', text: 'Recording started...' }]
    };
});
```

---

## 📈 性能优化建议

### 减少截图大小

在 `src/index.ts` 中：

```typescript
// 使用更小的分辨率
execSync(`xcrun simctl io ${udid} screenshot --type=jpeg --quality=70 "${tmpFile}"`);
```

### 智能刷新

只在应用有变化时刷新：

```javascript
// 在 UI 中添加变化检测
let lastScreenshot = null;

async function refreshScreenshot() {
  const newScreenshot = await getScreenshot();
  if (newScreenshot !== lastScreenshot) {
    updateDisplay(newScreenshot);
    lastScreenshot = newScreenshot;
  }
}
```

---

## 🎉 完成！

你现在拥有一个完整的 iOS Simulator Panel，可以：

✅ 在 Claude Desktop 右侧实时预览模拟器  
✅ 通过对话控制模拟器  
✅ 通过面板按钮直接操作  
✅ 自动刷新显示最新状态  
✅ 支持所有基本操作（home/rotate/screenshot/shutdown）  

**现在就试试吧！** 🚀

在 Claude Desktop 中说：
```
打开 iOS 模拟器面板
```

然后享受无缝的开发体验！
