#!/usr/bin/env node
/**
 * Standalone HTTP Server Launcher
 * Starts only the HTTP server without MCP
 */

import { startServer } from './dist/http-server.js';

async function main() {
  try {
    const port = await startServer();
    console.log(`\n✅ iOS Simulator Panel is running!`);
    console.log(`📱 Open in browser: http://localhost:${port}\n`);
  } catch (error) {
    console.error('❌ Failed to start server:', error.message);
    process.exit(1);
  }
}

main();
