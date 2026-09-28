# iOS Simulator Panel MCP 服务器

通过 Claude Desktop 完整控制 iOS 模拟器，带实时预览面板。

## 功能特性

### 核心控制 (7个工具)
- 🖥️ **实时预览面板** - Claude Desktop 侧边栏显示模拟器实时画面
- 📱 **设备管理** - 列出、启动、关闭模拟器
- 📸 **截图** - 捕获模拟器屏幕
- 🔄 **旋转** - 改变设备方向
- 🏠 **Home键** - 返回主屏幕

### 应用管理 (3个工具)
- 📦 **安装应用** - 安装 .app 包到模拟器
- 🚀 **启动应用** - 通过 bundle ID 启动应用
- 🗑️ **卸载应用** - 从模拟器移除应用

### 高级测试 (5个工具)
- 🔗 **打开URL** - 测试深链接和自定义scheme
- 📹 **录屏** - 录制模拟器视频 (.mov)
- 🔔 **推送通知** - 发送 APNs 测试通知
- 📍 **设置位置** - 模拟 GPS 坐标
- ℹ️ **设备信息** - 获取详细模拟器状态

**总计：17个工具，覆盖所有iOS开发需求**

## 安装方式

### 方式1：.mcpb 扩展（推荐）
1. 下载 `ios-simulator-panel.mcpb`
2. 双击安装
3. 重启 Claude Desktop

### 方式2：手动安装
```bash
# 克隆或解压
cd ios-simulator-panel

# 安装依赖
npm install

# 构建
npm run build

# 配置 Claude Desktop
npm run configure
```

然后添加到 `~/Library/Application Support/Claude/claude_desktop_config.json`：

```json
{
  "mcpServers": {
    "ios-simulator-panel": {
      "command": "node",
      "args": ["/path/to/ios-simulator-panel/dist/index.js"]
    }
  }
}
```

## 使用示例

### 基础操作
```
"列出所有可用的iOS模拟器"
"启动 iPhone 15 Pro 模拟器"
"打开模拟器预览面板"
"给模拟器截图"
"向右旋转模拟器"
```

### 应用开发
```
"安装这个app到模拟器: /path/to/MyApp.app"
"启动 com.example.myapp"
"卸载 com.example.myapp"
```

### 测试功能
```
"在模拟器中打开 myapp://deep-link"
"开始录屏，保存到 /tmp/demo.mov"
"停止录屏"
"发送推送通知到 com.example.app: {\"aps\":{\"alert\":\"测试\"}}"
"设置模拟器位置为北京: 39.9042, 116.4074"
```

### 设备信息
```
"查看模拟器状态"
"获取当前模拟器的详细信息"
```

## 系统要求

- macOS + Xcode
- Claude Desktop
- Node.js 18+

## API 参考

### 核心工具

#### `simulator_open_panel`
打开带交互控制的实时预览面板。

**参数：**
- `udid` (可选)：模拟器 UDID 或 "booted"

#### `simulator_list`
列出所有可用模拟器及其状态。

#### `simulator_boot`
启动模拟器。

**参数：**
- `udid` (必需)：模拟器 UDID

#### `simulator_shutdown`
关闭运行中的模拟器。

**参数：**
- `udid` (可选)：模拟器 UDID 或 "booted"

#### `simulator_screenshot`
截图并返回 base64 数据。

**参数：**
- `udid` (可选)：模拟器 UDID 或 "booted"

#### `simulator_home`
按 Home 键（需要辅助功能权限）。

**参数：**
- `udid` (可选)：模拟器 UDID 或 "booted"

#### `simulator_rotate`
旋转设备方向（需要辅助功能权限）。

**参数：**
- `udid` (可选)：模拟器 UDID 或 "booted"
- `direction` (必需)："left" 或 "right"

### 应用管理工具

#### `simulator_install_app`
安装 .app 包到模拟器。

**参数：**
- `udid` (可选)：模拟器 UDID 或 "booted"
- `appPath` (必需)：.app 包路径

#### `simulator_launch_app`
通过 bundle ID 启动已安装的应用。

**参数：**
- `udid` (可选)：模拟器 UDID 或 "booted"
- `bundleId` (必需)：应用 bundle identifier

#### `simulator_uninstall_app`
从模拟器卸载应用。

**参数：**
- `udid` (可选)：模拟器 UDID 或 "booted"
- `bundleId` (必需)：应用 bundle identifier

### 高级测试工具

#### `simulator_open_url`
在模拟器中打开 URL 或深链接。

**参数：**
- `udid` (可选)：模拟器 UDID 或 "booted"
- `url` (必需)：要打开的 URL（http://、https:// 或自定义 scheme）

#### `simulator_start_recording`
开始录制屏幕视频。

**参数：**
- `udid` (可选)：模拟器 UDID 或 "booted"
- `outputPath` (必需)：保存 .mov 文件的路径

#### `simulator_stop_recording`
停止当前录屏。

**参数：**
- `udid` (可选)：模拟器 UDID 或 "booted"

#### `simulator_push_notification`
发送推送通知到模拟器。

**参数：**
- `udid` (可选)：模拟器 UDID 或 "booted"
- `bundleId` (必需)：目标应用 bundle ID
- `payload` (必需)：APNs payload 对象

**Payload 示例：**
```json
{
  "aps": {
    "alert": {
      "title": "测试通知",
      "body": "这是一条测试消息"
    },
    "badge": 1,
    "sound": "default"
  }
}
```

#### `simulator_set_location`
设置模拟器 GPS 位置。

**参数：**
- `udid` (可选)：模拟器 UDID 或 "booted"
- `latitude` (必需)：纬度 (-90 到 90)
- `longitude` (必需)：经度 (-180 到 180)

### 设备信息工具

#### `simulator_get_status`
获取模拟器当前状态（状态、可用性）。

**参数：**
- `udid` (可选)：模拟器 UDID 或 "booted"

#### `simulator_get_device_info`
获取详细设备信息（名称、运行时、设备类型）。

**参数：**
- `udid` (可选)：模拟器 UDID 或 "booted"

## 故障排除

### 辅助功能权限
某些功能（Home键、旋转）需要辅助功能权限：

1. 打开 **系统设置** → **隐私与安全性** → **辅助功能**
2. 启用 **Claude** 或 **终端**（取决于运行方式）

### 常见问题

**"No booted simulator"**
- 先启动模拟器：`"启动 iPhone 15 Pro 模拟器"`

**"Command not found: xcrun"**
- 从 Mac App Store 安装 Xcode
- 运行：`xcode-select --install`

**MCP 服务器未出现**
- 检查 `claude_desktop_config.json` 路径是否正确
- 完全重启 Claude Desktop
- 查看日志：`~/Library/Logs/Claude/mcp*.log`

## 开发

```bash
# 安装依赖
npm install

# 构建 TypeScript
npm run build

# 测试服务器
npm test

# 打包分发
npm run package
```

## 许可证

MIT

## 作者

为 Claude Desktop MCP 生态系统构建
