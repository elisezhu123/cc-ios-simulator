# iOS Simulator Panel MCP Server

Complete iOS Simulator control through Claude Desktop with live preview panel.

## Features

### Core Controls (7 tools)
- 🖥️ **Live Preview Panel** - Real-time simulator display in Claude Desktop sidebar
- 📱 **Device Management** - List, boot, and shutdown simulators
- 📸 **Screenshot** - Capture simulator screen
- 🔄 **Rotate** - Change device orientation
- 🏠 **Home Button** - Navigate to home screen

### App Management (3 tools)
- 📦 **Install App** - Install .app bundles to simulator
- 🚀 **Launch App** - Start apps by bundle ID
- 🗑️ **Uninstall App** - Remove apps from simulator

### Advanced Testing (5 tools)
- 🔗 **Open URL** - Test deep links and custom schemes
- 📹 **Screen Recording** - Record simulator video (.mov)
- 🔔 **Push Notifications** - Send APNs test notifications
- 📍 **Set Location** - Mock GPS coordinates
- ℹ️ **Device Info** - Get detailed simulator status

**Total: 17 tools covering all iOS development needs**

## Installation

### Option 1: .mcpb Extension (Recommended)
1. Download `ios-simulator-panel.mcpb`
2. Double-click to install
3. Restart Claude Desktop

### Option 2: Manual Installation
```bash
# Clone or extract
cd ios-simulator-panel

# Install dependencies
npm install

# Build
npm run build

# Configure Claude Desktop
npm run configure
```

Then add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

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

## Usage Examples

### Basic Operations
```
"列出所有可用的iOS模拟器"
"启动 iPhone 15 Pro 模拟器"
"打开模拟器预览面板"
"给模拟器截图"
"向右旋转模拟器"
```

### App Development
```
"安装这个app到模拟器: /path/to/MyApp.app"
"启动 com.example.myapp"
"卸载 com.example.myapp"
```

### Testing
```
"在模拟器中打开 myapp://deep-link"
"开始录屏，保存到 /tmp/demo.mov"
"停止录屏"
"发送推送通知到 com.example.app: {\"aps\":{\"alert\":\"Test\"}}"
"设置模拟器位置为旧金山: 37.7749, -122.4194"
```

### Device Info
```
"查看模拟器状态"
"获取当前模拟器的详细信息"
```

## Requirements

- macOS with Xcode installed
- Claude Desktop
- Node.js 18+

## API Reference

### Core Tools

#### `simulator_open_panel`
Open live preview panel with interactive controls.

**Parameters:**
- `udid` (optional): Simulator UDID or "booted"

#### `simulator_list`
List all available simulators with their states.

#### `simulator_boot`
Boot a simulator.

**Parameters:**
- `udid` (required): Simulator UDID

#### `simulator_shutdown`
Shutdown a running simulator.

**Parameters:**
- `udid` (optional): Simulator UDID or "booted"

#### `simulator_screenshot`
Take a screenshot and return base64 data.

**Parameters:**
- `udid` (optional): Simulator UDID or "booted"

#### `simulator_home`
Press the home button (requires Accessibility permissions).

**Parameters:**
- `udid` (optional): Simulator UDID or "booted"

#### `simulator_rotate`
Rotate device orientation (requires Accessibility permissions).

**Parameters:**
- `udid` (optional): Simulator UDID or "booted"
- `direction` (required): "left" or "right"

### App Management Tools

#### `simulator_install_app`
Install an .app bundle to simulator.

**Parameters:**
- `udid` (optional): Simulator UDID or "booted"
- `appPath` (required): Path to .app bundle

#### `simulator_launch_app`
Launch an installed app by bundle ID.

**Parameters:**
- `udid` (optional): Simulator UDID or "booted"
- `bundleId` (required): App bundle identifier

#### `simulator_uninstall_app`
Uninstall an app from simulator.

**Parameters:**
- `udid` (optional): Simulator UDID or "booted"
- `bundleId` (required): App bundle identifier

### Advanced Testing Tools

#### `simulator_open_url`
Open a URL or deep link in simulator.

**Parameters:**
- `udid` (optional): Simulator UDID or "booted"
- `url` (required): URL to open (http://, https://, or custom scheme)

#### `simulator_start_recording`
Start screen recording video.

**Parameters:**
- `udid` (optional): Simulator UDID or "booted"
- `outputPath` (required): Path to save .mov file

#### `simulator_stop_recording`
Stop current screen recording.

**Parameters:**
- `udid` (optional): Simulator UDID or "booted"

#### `simulator_push_notification`
Send a push notification to simulator.

**Parameters:**
- `udid` (optional): Simulator UDID or "booted"
- `bundleId` (required): Target app bundle ID
- `payload` (required): APNs payload object

**Example payload:**
```json
{
  "aps": {
    "alert": {
      "title": "Test Notification",
      "body": "This is a test"
    },
    "badge": 1,
    "sound": "default"
  }
}
```

#### `simulator_set_location`
Set simulator GPS location.

**Parameters:**
- `udid` (optional): Simulator UDID or "booted"
- `latitude` (required): Latitude (-90 to 90)
- `longitude` (required): Longitude (-180 to 180)

### Device Info Tools

#### `simulator_get_status`
Get simulator current status (state, availability).

**Parameters:**
- `udid` (optional): Simulator UDID or "booted"

#### `simulator_get_device_info`
Get detailed device information (name, runtime, device type).

**Parameters:**
- `udid` (optional): Simulator UDID or "booted"

## Troubleshooting

### Accessibility Permissions
Some features (Home button, Rotate) require Accessibility permissions:

1. Open **System Settings** → **Privacy & Security** → **Accessibility**
2. Enable **Claude** or **Terminal** (depending on how you run it)

### Common Issues

**"No booted simulator"**
- Boot a simulator first: `"启动 iPhone 15 Pro 模拟器"`

**"Command not found: xcrun"**
- Install Xcode from Mac App Store
- Run: `xcode-select --install`

**MCP server not appearing**
- Check `claude_desktop_config.json` path is correct
- Restart Claude Desktop completely
- Check logs: `~/Library/Logs/Claude/mcp*.log`

## Development

```bash
# Install dependencies
npm install

# Build TypeScript
npm run build

# Test the server
npm test

# Package for distribution
npm run package
```

## License

MIT

## Author

Built for Claude Desktop MCP ecosystem
