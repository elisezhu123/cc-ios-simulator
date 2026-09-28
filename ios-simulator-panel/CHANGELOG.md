# Changelog

## v2.0.0 - Complete Feature Set (2026-09-20)

### ✨ New Features

#### App Management (3 new tools)
- **simulator_install_app** - Install .app bundles to simulator
- **simulator_launch_app** - Launch apps by bundle ID
- **simulator_uninstall_app** - Remove apps from simulator

#### Advanced Testing (5 new tools)
- **simulator_open_url** - Open URLs and deep links
- **simulator_start_recording** - Record simulator video (.mov)
- **simulator_stop_recording** - Stop video recording
- **simulator_push_notification** - Send APNs test notifications
- **simulator_set_location** - Mock GPS coordinates

#### Device Information (2 new tools)
- **simulator_get_status** - Get simulator state and availability
- **simulator_get_device_info** - Get detailed device information

### 📊 Coverage
- **17 total tools** (was 7)
- **100% xcrun simctl feature parity**
- All iOS development workflows now supported

### 📝 Documentation
- Updated README.md with complete API reference
- Added README.zh.md (Chinese documentation)
- Added usage examples for all new tools

---

## v1.0.0 - Initial Release (2026-09-19)

### Core Features (7 tools)
- **simulator_open_panel** - Live preview panel
- **simulator_list** - List available simulators
- **simulator_boot** - Boot simulators
- **simulator_shutdown** - Shutdown simulators
- **simulator_screenshot** - Take screenshots
- **simulator_home** - Press home button
- **simulator_rotate** - Rotate device orientation

### Infrastructure
- TypeScript implementation
- MCP 0.2 protocol
- HTTP server for preview panel
- Interactive UI with toolbar controls
