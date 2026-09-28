#!/bin/bash

# Demo script - 演示如何使用 iOS Simulator Panel

echo "🎬 iOS Simulator Panel - Demo"
echo "================================"
echo ""

# Check if a simulator is booted
BOOTED=$(xcrun simctl list devices booted | grep "Booted" || echo "")

if [ -z "$BOOTED" ]; then
    echo "📱 No simulator is booted. Let's boot one..."
    echo ""

    # Get first available iPhone
    UDID=$(xcrun simctl list devices available | grep "iPhone" | head -1 | grep -o '[A-F0-9-]\{36\}')

    if [ -z "$UDID" ]; then
        echo "❌ No iPhone simulators found. Please install Xcode and iOS Simulator."
        exit 1
    fi

    DEVICE_NAME=$(xcrun simctl list devices available | grep "$UDID" | sed 's/^[[:space:]]*//' | sed 's/ (.*$//')

    echo "🚀 Booting: $DEVICE_NAME"
    xcrun simctl boot "$UDID"
    open -a Simulator

    echo "⏳ Waiting for simulator to boot..."
    sleep 3
else
    echo "✅ Simulator already booted"
fi

echo ""
echo "================================"
echo "📋 Available MCP Tools:"
echo "================================"
echo ""
echo "1. simulator_open_panel    - Open live preview panel"
echo "2. simulator_list          - List all simulators"
echo "3. simulator_boot          - Boot a simulator"
echo "4. simulator_shutdown      - Shutdown simulator"
echo "5. simulator_screenshot    - Take screenshot"
echo "6. simulator_home          - Press home button"
echo "7. simulator_rotate        - Rotate device"
echo ""
echo "================================"
echo "🎯 How to use:"
echo "================================"
echo ""
echo "1. Make sure Claude Desktop is running"
echo "2. Config file should be at:"
echo "   ~/Library/Application Support/Claude/claude_desktop_config.json"
echo ""
echo "3. Config content:"
echo '   {'
echo '     "mcpServers": {'
echo '       "ios-simulator": {'
echo '         "command": "node",'
echo '         "args": ["'$(pwd)/dist/index.js'"]'
echo '       }'
echo '     }'
echo '   }'
echo ""
echo "4. In Claude Desktop, say:"
echo '   "打开 iOS 模拟器面板"'
echo "   or"
echo '   "Open the iOS simulator panel"'
echo ""
echo "5. The panel will appear on the right side with:"
echo "   - Live screenshot (auto-refresh every 2s)"
echo "   - Control buttons at the bottom"
echo "   - Device frame around the screen"
echo ""
echo "================================"
echo "🧪 Test MCP Server (Optional):"
echo "================================"
echo ""
echo "Run: node test-server.mjs"
echo "or"
echo "Run: npx @modelcontextprotocol/inspector node dist/index.js"
echo ""
echo "✅ Setup complete! Ready to use in Claude Desktop!"
