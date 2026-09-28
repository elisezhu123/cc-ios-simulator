# iOS Simulator Panel - MCP App

A Claude Desktop MCP App that provides a **live iOS Simulator preview panel** with interactive controls, similar to Claude's official iOS Simulator integration.

## Features

- 🖼️ **Live preview panel** embedded directly in Claude Desktop's UI
- 🔄 **Auto-refresh** every 2 seconds to show real-time changes
- 🎮 **Interactive controls**: Home, Screenshot, Rotate, Refresh, Shutdown
- 📱 **Device frame** with realistic iPhone bezel
- ⚡ **Fast operations** using `xcrun simctl` commands

## Prerequisites

- macOS with Xcode installed
- Xcode Command Line Tools
- Claude Desktop app
- Node.js 18+

## Installation

1. **Build the project:**

```bash
npm install
npm run build
```

2. **Add to Claude Desktop config:**

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`:

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

3. **Restart Claude Desktop**

## Usage

### Open the Simulator Panel

In Claude Desktop, ask Claude to open the simulator panel:

```
Open the iOS simulator panel
```

Claude will call the `simulator_open_panel` tool, which opens a live preview panel on the right side showing:
- Real-time simulator screen
- Interactive control buttons
- Device info in the header

### Available Tools

The MCP server provides these tools:

- **`simulator_open_panel`** - Opens the live preview UI panel
- **`simulator_list`** - List all available simulators
- **`simulator_boot`** - Boot a specific simulator
- **`simulator_shutdown`** - Shutdown the running simulator
- **`simulator_screenshot`** - Capture a screenshot
- **`simulator_home`** - Press the home button
- **`simulator_rotate`** - Rotate device (left/right)

### UI Controls

Once the panel is open, you can interact directly:

- **🏠 Home** - Press the home button
- **📸 Screenshot** - Capture current screen
- **↶ Rotate Left** - Rotate device counter-clockwise
- **↷ Rotate Right** - Rotate device clockwise
- **🔄 Refresh** - Manually refresh the view
- **⏻ Shutdown** - Shutdown the simulator

## How It Works

1. **MCP Server** (`src/index.ts`) registers tools and serves the UI resource
2. **UI Panel** (`src/ui/index.html`) renders in Claude Desktop using MCP App Bridge
3. **Communication** happens through the App Bridge - UI calls MCP tools, gets results
4. **Screenshots** are captured via `xcrun simctl io screenshot` and returned as base64
5. **Auto-refresh** polls for new screenshots every 2 seconds

## Development

**Watch mode:**
```bash
npm run dev
```

**Build:**
```bash
npm run build
```

**Test locally with MCP Inspector:**
```bash
npx @modelcontextprotocol/inspector node dist/index.js
```

## Architecture

```
Claude Desktop
    ↕ MCP Protocol
MCP Server (stdio)
    ├─ Tools (simulator control)
    └─ UI Resource (HTML panel)
        ↕ App Bridge
    UI Panel (rendered in Claude)
        ↓
xcrun simctl (Xcode CLI)
    ↓
iOS Simulator
```

## Troubleshooting

**Panel doesn't open:**
- Check Claude Desktop config is correct
- Restart Claude Desktop after config changes
- Check console for MCP server errors

**Simulator not found:**
- Boot a simulator first: `open -a Simulator`
- Or use `simulator_boot` tool with a specific UDID

**Screenshot not updating:**
- Ensure simulator is booted and visible
- Check system permissions for screen capture
- Try manual refresh button

## License

MIT
