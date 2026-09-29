---
name: ios-ui-automation
description: Use when operating an iOS Simulator through this plugin's ios_sim_* tools — booting a device, opening the live panel, launching or building apps, tapping, typing, scrolling, and checking what is on screen.
---

# Driving the iOS Simulator with the ios_sim_* tools

The loop is **observe once → act → read the result the action returns**. Every `ios_sim_interact` call already returns a screenshot of its effect (unless you pass `screenshot: false`), so a separate `ios_sim_screenshot` after each action is wasted work.

## Getting a device and the live panel

1. `ios_sim_devices` lists simulators, booted first. Use a udid or the exact name ("iPhone 17 Pro").
2. `ios_sim_boot` boots it and starts the live stream; the result carries `panelUrl`.
3. Open the panel for the user **once per session**: in the Claude desktop app call the browser tool `preview_start` with `{ "url": "<panelUrl>" }`; in a terminal-only session, print the URL for the user. `ios_sim_panel` returns the URL again later and never boots a device.
4. The user can tap, drag, press Home, rotate and take screenshots in the panel; your tool calls and their clicks drive the same simulator.

## Reading the screen

- `ios_sim_screenshot` returns a JPEG you can look at (long edge at most 1024 px) plus JSON with the full-resolution PNG path.
- Tap coordinates are normalized to the image you were given: `x = pixelX / image.width`, `y = pixelY / image.height` (the JSON repeats `image.width` and `image.height`). Aim at the centre of a control.
- Screenshots are always returned upright, also in landscape, and coordinates always refer to the image you were given — the tools map them to the device.

## Acting

| Want to… | Call |
| --- | --- |
| tap | `ios_sim_interact {action:"tap", x, y}` |
| type ASCII into the focused field | `ios_sim_interact {action:"type", text}` |
| scroll | `ios_sim_interact {action:"scroll", direction}` — direction names the CONTENT: `down` reveals what is below (the finger moves up) |
| drag or swipe | `ios_sim_interact {action:"gesture", json:{fromX, fromY, toX, toY, duration}}` |
| go home | `ios_sim_interact {action:"button", name:"home"}` |
| rotate | `ios_sim_interact {action:"rotate", orientation:"landscape_left"}` |
| app switcher, lock, unlock, shake, Siri | `ios_sim_interact {action:"device_action", name}` |

- Chaining actions (tap a field, type, tap Done)? Pass `screenshot:false` on all but the last one.
- `type` only supports US-keyboard ASCII. For Chinese, emoji or other text run `printf '%s' '中文' | xcrun simctl pbcopy <udid>` in Bash, then long-press the field and tap Paste.
- Every `device_action` except `lock` drives Simulator.app's menu through AppleScript and needs the Accessibility permission for the app running Claude. If one fails with that hint, tell the user instead of retrying.
- With Xcode 27, keyboard input also needs Device Hub running with the simulator visible and frontmost. `serve-sim repair-input -d <udid>` revives dead input but restarts SpringBoard — ask the user before running it.

## Apps

- **Never guess a third-party bundle id.** Use `ios_sim_launch_app {name}` (a case-insensitive display-name substring) or look the id up with `ios_sim_list_apps` first.
- Names on a simulator are the localized ones the user sees (日历, not Calendar); `query` and `name` also match the base English name and the bundle id.
- Stable Apple ids: Calendar `com.apple.mobilecal`, Safari `com.apple.mobilesafari`, Settings `com.apple.Preferences`, Photos `com.apple.mobileslideshow`, Messages `com.apple.MobileSMS`, Maps `com.apple.Maps`, Notes `com.apple.mobilenotes`.
- The app lives on the simulator. Do not search the user's source tree or DerivedData for it. A failed listing is an error to read; `count: 0` means nothing matched.
- `ios_sim_build_run` builds, installs and launches a project, workspace or Swift package. A full build takes minutes; on failure read the error tail it returns instead of re-running blindly.
- Also available: `ios_sim_install_app` (a built .app), `ios_sim_uninstall_app`, `ios_sim_open_url` (deep links), `ios_sim_push` (the payload needs an `aps` object), `ios_sim_location`, `ios_sim_appearance`, `ios_sim_record` (start / stop).

## Scope

These rules cover this plugin's `ios_sim_*` tools. The Claude desktop app's built-in iOS Simulator tool is a different integration; do not mix the two in one task.
