#!/bin/bash

# iOS Simulator Panel MCP - Installation Script

set -e

echo "🚀 Installing iOS Simulator Panel MCP..."
echo ""

# Check prerequisites
echo "✓ Checking prerequisites..."

if ! command -v node &> /dev/null; then
    echo "❌ Node.js is not installed. Please install Node.js 18+ first."
    exit 1
fi

if ! command -v xcrun &> /dev/null; then
    echo "❌ Xcode Command Line Tools not found. Please install Xcode first."
    exit 1
fi

echo "✓ Node.js: $(node --version)"
echo "✓ Xcode tools found"
echo ""

# Build the project
echo "📦 Building project..."
npm install
npm run build
echo ""

# Get config path
CONFIG_DIR="$HOME/Library/Application Support/Claude"
CONFIG_FILE="$CONFIG_DIR/claude_desktop_config.json"
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

# Create config directory if it doesn't exist
mkdir -p "$CONFIG_DIR"

# Check if config exists
if [ -f "$CONFIG_FILE" ]; then
    echo "⚠️  Claude Desktop config already exists at:"
    echo "   $CONFIG_FILE"
    echo ""
    echo "Add this to your mcpServers section:"
    echo ""
    echo "  \"ios-simulator\": {"
    echo "    \"command\": \"node\","
    echo "    \"args\": [\"$SCRIPT_DIR/dist/index.js\"]"
    echo "  }"
    echo ""
else
    # Create new config
    cat > "$CONFIG_FILE" << EOF
{
  "mcpServers": {
    "ios-simulator": {
      "command": "node",
      "args": ["$SCRIPT_DIR/dist/index.js"]
    }
  }
}
EOF
    echo "✅ Created Claude Desktop config at:"
    echo "   $CONFIG_FILE"
    echo ""
fi

echo "✅ Installation complete!"
echo ""
echo "Next steps:"
echo "1. Restart Claude Desktop app"
echo "2. Boot an iOS Simulator (or open Simulator.app)"
echo "3. Ask Claude: 'Open the iOS simulator panel'"
echo ""
echo "The panel will appear on the right side with live preview and controls!"
