#!/usr/bin/env node

/**
 * Configuration helper for Claude Desktop
 * Automatically updates claude_desktop_config.json
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const CONFIG_DIR = join(homedir(), 'Library', 'Application Support', 'Claude');
const CONFIG_FILE = join(CONFIG_DIR, 'claude_desktop_config.json');
const SERVER_PATH = join(__dirname, 'dist', 'index.js');

console.log('🔧 Claude Desktop Configuration Helper');
console.log('=====================================\n');

// Ensure config directory exists
if (!existsSync(CONFIG_DIR)) {
  console.log('📁 Creating config directory...');
  mkdirSync(CONFIG_DIR, { recursive: true });
}

let config = { mcpServers: {} };

// Read existing config if it exists
if (existsSync(CONFIG_FILE)) {
  console.log('✓ Found existing config at:', CONFIG_FILE);
  try {
    const content = readFileSync(CONFIG_FILE, 'utf-8');
    config = JSON.parse(content);
    if (!config.mcpServers) {
      config.mcpServers = {};
    }
  } catch (error) {
    console.error('⚠️  Error parsing existing config:', error.message);
    console.log('📝 Creating backup...');
    writeFileSync(CONFIG_FILE + '.backup', readFileSync(CONFIG_FILE));
    console.log('✓ Backup saved to:', CONFIG_FILE + '.backup');
  }
} else {
  console.log('📝 No existing config found. Creating new one...');
}

// Add or update ios-simulator server
config.mcpServers['ios-simulator'] = {
  command: 'node',
  args: [SERVER_PATH]
};

// Write config
try {
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  console.log('\n✅ Configuration updated successfully!\n');
  console.log('Config location:', CONFIG_FILE);
  console.log('\nServer entry:');
  console.log(JSON.stringify(config.mcpServers['ios-simulator'], null, 2));
  console.log('\n🎯 Next steps:');
  console.log('1. Restart Claude Desktop app');
  console.log('2. Open Simulator.app or boot a simulator');
  console.log('3. In Claude Desktop, say: "打开 iOS 模拟器面板"');
  console.log('\n✨ The panel will appear on the right side!');
} catch (error) {
  console.error('\n❌ Error writing config:', error.message);
  console.log('\n💡 Manual setup:');
  console.log('Add this to your', CONFIG_FILE + ':');
  console.log(JSON.stringify({ mcpServers: config.mcpServers }, null, 2));
}
