---
name: ios-ui-automation
description: Use when operating an iOS Simulator through this plugin's ios_sim_* tools — booting a device, opening the live panel, launching or building apps, reading the screen (accessibility tree, OCR), tapping elements or text, typing, scrolling, waiting for text, working with list rows, confirming that an action worked, debugging an app (logs, processes, backtraces, leaks, app containers), and live SwiftUI previews with hot reload.
---

# Driving the iOS Simulator with the ios_sim_* tools

The loop is **observe once → act with an assertion → observe again only if the assertion could not settle it**. Every tap tool already returns a screenshot of its effect (unless you pass `screenshot: false`), and `ios_sim_tap_element` / `ios_sim_tap_text` can confirm their outcome in the same call (`expect_text` / `expect_gone`), so a separate `ios_sim_screenshot` after each action is wasted work.

## Getting a device and the live panel

1. `ios_sim_devices` lists simulators, booted first. Use a udid or the exact name ("iPhone 17 Pro").
2. `ios_sim_boot` boots it and starts the live stream; the result carries `panelUrl`.
   - No `panelUrl` means a degraded boot, and a `note` says why. With `streaming: false`, serve-sim is unavailable (an Intel Mac, no npx): the device is booted, and screenshots, apps, `open_url`, `push`, `location`, `appearance`, `record` and the AXe / OCR tools (`ui_tree`, `tap_element`, `ui_rows`, `tap_row`, `find_text`, `wait_for`) still work, but `ios_sim_interact`, `ios_sim_tap_text` and the panel do not — tell the user rather than retrying. With `streaming: true`, only the panel could not start; `ios_sim_panel` retries it.
3. Open the panel for the user **once per session**: in the Claude desktop app call the browser tool `preview_start` with `{ "url": "<panelUrl>" }`; in a terminal-only session, print the URL for the user. `ios_sim_panel` returns the URL again later and never boots a device.
4. The user can tap, drag, press Home, rotate and take screenshots in the panel; your tool calls and their clicks drive the same simulator.
5. `ios_sim_shutdown` shuts a simulator down when you are done; it stops that device's recording and live stream first.

## Reading the screen

| Tool | Use it for |
| --- | --- |
| `ios_sim_find_text` | "what text is on screen, and where" (Vision OCR) — the default observer |
| `ios_sim_ui_tree` | element identity: type, label, identifier, value, enabled / selected, frames |
| `ios_sim_ui_rows` | list and feed screens: one entry per row with the counters in its label |
| `ios_sim_screenshot` | looking at the screen yourself, or showing it to the user |

- Start with `ios_sim_find_text`. Reach for `ios_sim_ui_tree` when you need an element's identity rather than its text, and `ios_sim_ui_rows` for feeds.
- `ios_sim_screenshot` returns a JPEG you can look at (long edge at most 1024 px) plus JSON with the full-resolution PNG path.
- Rects from `ios_sim_find_text`, `ios_sim_ui_tree` and `ios_sim_ui_rows` are device POINTS (origin top-left). Coordinates for `ios_sim_interact` are different: normalized to the screenshot image, `x = pixelX / image.width`, `y = pixelY / image.height`.
- Screenshots are always returned upright, also in landscape, and coordinates always refer to the image you were given — the tools map them to the device.
- A result may carry a `warning` or a `hint` — for example the live stream lost the landscape orientation, or why a tree has no labels. Read it and do what it says before your next action.
- An unlabeled `ios_sim_ui_tree` is not proof that the app lacks accessibility. The `hint` names the cause: a filter that matched nothing, a `max_depth` too shallow, the 40 KB output cap, or labels that are all off-screen. Only a full, unfiltered read with no labels means "use OCR instead".
- The first AXe call may download the pinned AXe release, and the first OCR call compiles the Vision helper with swiftc; both are cached afterwards. If either reports it is unavailable, tell the user the install hint instead of retrying.

## Acting

Prefer tapping by meaning — raw coordinates break on the next layout change.

| Want to… | Call |
| --- | --- |
| tap a control by identity | `ios_sim_tap_element {identifier}` or `{label}` (exact match first, then case-insensitive substring) |
| tap visible text | `ios_sim_tap_text {query}` |
| tap inside a list row | `ios_sim_tap_row {row, x, y}` (fractions of the row frame) |
| tap a raw position (last resort) | `ios_sim_interact {action:"tap", x, y}` |
| type ASCII into the focused field | `ios_sim_interact {action:"type", text}` |
| scroll | `ios_sim_interact {action:"scroll", direction}` — direction names the CONTENT: `down` reveals what is below (the finger moves up) |
| drag or swipe | `ios_sim_interact {action:"gesture", json:{fromX, fromY, toX, toY, duration}}` |
| go home | `ios_sim_interact {action:"button", name:"home"}` (other buttons: `lock`, `siri`, `volume-up`, …; an unknown name returns the full list) |
| rotate | `ios_sim_interact {action:"rotate", orientation:"landscape_left"}` |
| app switcher, lock, unlock, shake, Siri, Action button, re-center the window | `ios_sim_interact {action:"device_action", name}` with `name` one of `app-switcher`, `lock`, `unlock`, `shake`, `siri`, `action-button`, `re-center` |
| wait for a load or animation | `ios_sim_wait_for {text, mode:"appear" or "disappear"}` |

- `ios_sim_tap_element` refuses off-screen and disabled matches and tells you what to do; scroll the element into view rather than passing `allow_offscreen` by reflex. An ambiguous selector fails with every candidate listed — pick a more specific one.
- Chaining actions (tap a field, type, tap Done)? Pass `screenshot:false` on all but the last one.
- `type` only supports US-keyboard ASCII. For Chinese, emoji or other text run `printf '%s' '中文' | xcrun simctl pbcopy <udid>` in Bash, then long-press the field and tap Paste.
- `lock` is a hardware-button press through serve-sim. The other six device actions drive Simulator.app through AppleScript — menu clicks, and `unlock` is a keystroke (⇧⌘H twice) — so they bring Simulator.app to the front for a moment and need the Accessibility permission for the app running Claude. If one fails with that hint, tell the user instead of retrying.
- With Xcode 27, keyboard input also needs Device Hub running with the simulator visible and frontmost. `serve-sim repair-input -d <udid>` revives dead input but restarts SpringBoard — ask the user before running it.

## Confirming an action worked

- Pass `expect_text` (text that should appear) or `expect_gone` (text that should disappear) to `ios_sim_tap_element` / `ios_sim_tap_text`: the tap and its check are one call, and the result carries `expected.matched`.
- Waiting for something slow is `ios_sim_wait_for` — one call that polls internally. A timeout is `matched: false`, not an error.
- Never compare screenshots pixel by pixel to decide whether something happened. Read the text back.

## OCR facts that matter

- Chinese and Japanese labels commonly read at **confidence 0.3–0.6**. The default `min_confidence` is 0.3 — do NOT raise it "to be safe": that drops exactly the CJK buttons you are aiming at. `ios_sim_tap_text` says when a match existed below your threshold.
- Icon-only controls (a heart, a bookmark) carry no text; find them in `ios_sim_ui_tree` or, inside a feed row, with `ios_sim_tap_row`.

## Lists and feeds

- Feed apps fold each item into ONE accessibility cell whose label holds the summary and its counters ("57 回复。18 喜欢"), with no child buttons to match — `ios_sim_tap_element` cannot find the like button inside it.
- `ios_sim_ui_rows` lists the visible rows: 0-based index, frame, aggregated label, and counters parsed from the label. Pass a counter key EXACTLY as listed.
- `ios_sim_tap_row {row, x, y}` taps at a relative position inside that row (a right-side action is often near x=0.9). The row is re-located in a fresh read and an out-of-range index fails — re-read the rows instead of reusing a remembered position.
- Confirm a row action with `expect_count: {key, delta: 1 or -1}`: the row is re-read and `countCheck.verified` says whether the counter moved by exactly that much. A key the row does not carry is refused before tapping — never tap an unidentified control to find out what it does. If a check is not verified, say so; do not re-tap blindly.

## Debugging an app

| Want to… | Call |
| --- | --- |
| see what the app printed | `ios_sim_logs {bundle_id}` (recent: `duration:"2m"`), narrowed with `grep` or a `predicate` |
| catch what an action logs | `ios_sim_logs {mode:"follow", duration_seconds}` — it returns when the window closes, so start it, then act (or act right after it returns and read a snapshot) |
| find the app's pid | `ios_sim_processes` |
| see where a hung app is stuck | `ios_sim_backtrace {bundle_id or pid}` (`all_threads:false` for just the main thread) |
| check for memory leaks | `ios_sim_leaks {bundle_id or pid}`; `mode:"memgraph"` writes a file for Instruments |
| find the app's Documents / data folder or version | `ios_sim_app_info {bundle_id}` |

- backtrace and leaks only target this simulator's app processes and always leave the app running. `engine: "sample"` plus a `note` about Developer Mode means LLDB could not attach — pass the note's command on to the user instead of retrying.
- Logs are capped at the last ~300 lines; `truncated: true` means narrow the filter, not read again.

## SwiftUI previews with hot reload

- `ios_sim_preview {packagePath}` shows a Swift package's `#Preview` / `PreviewProvider` previews live in the simulator. The first start builds the whole package (up to a minute); after that every saved edit is hot-swapped in a few seconds without relaunching.
- After editing a file, check `ios_sim_preview {action: "status"}`: `loadedGeneration` rises when the host shows the new build; `lastBuildError` holds the compiler error tail when the edit broke the build (the last good preview stays up). Fix the error rather than restarting the session.
- One session at a time. `action: "stop"` removes the host app when you are done.
- Nothing is written into the user's package: the host app and build products live in the plugin cache.

## The user's annotations

- In the live panel the user can annotate a screenshot (pen, arrows, boxes, text) and press "Add to chat". When they refer to "my annotation", "what I marked" or "the red box", or a screenshot result carries `userAnnotations`, call `ios_sim_annotation` and read the marks together with their message before acting.
- The marks point at what the user means; they are not part of the app. Confirm on a fresh screenshot before tapping what was marked.

## Real iPhones and iPads

- `ios_sim_devices` lists connected devices under `realDevices`. Pass one's udid or name to `ios_sim_list_apps`, `ios_sim_launch_app`, `ios_sim_install_app`, `ios_sim_processes` or `ios_sim_app_info`; those run through devicectl.
- Screen, touch and UI tools reach a phone through WebDriverAgent. Run `ios_real_start_wda {udid}` once first (it adopts a running WDA, or signs and builds one — a cold build takes minutes); after that `ios_sim_screenshot`, `ios_sim_interact`, `ios_sim_ui_tree`, `ios_sim_tap_element`, `ios_sim_find_text`, `ios_sim_tap_text`, `ios_sim_wait_for`, `ios_sim_ui_rows` and `ios_sim_tap_row` take the same udid. The observe → act → confirm loop is unchanged.
- On a phone, `type` accepts any text (it goes through the device keyboard); buttons are home, lock, volume-up and volume-down; `device_action` is limited to lock, unlock and siri.
- WDA tree reads are capped in depth to stay fast (15 levels, one automatic retry at 40; rows read 60). When `ios_sim_ui_tree` misses something that is clearly on screen, pass a larger `max_depth` or use OCR.
- `ios_real_start_wda` failures name the fix (unlock the phone, trust the developer certificate, sign in to Xcode or set IOS_SIM_TEAM_ID, clone WebDriverAgent). Pass them on to the user instead of retrying in a loop.
- To let the user watch or drive the phone, call `ios_sim_panel {udid}` for it once WDA runs: the panel then shows the phone's live view.
- Logs, backtraces and leaks work on simulators only and say so when handed a real device.
- On a phone, app names are devicectl's base (usually English) names: a Chinese label from the screen will not match, so use the English name or the bundle id.
- A real device is someone's phone: every launch or install happens for real. Do not uninstall apps there (the tool refuses: the data cannot be recovered).
- "Not reachable by CoreDevice", "locked", "Developer Mode is off" are fixed on the phone (reconnect, unlock, enable) — pass the message on to the user.

## Apps

- **Never guess a third-party bundle id.** Use `ios_sim_launch_app {name}` (a case-insensitive display-name substring) or look the id up with `ios_sim_list_apps` first.
- Names on a simulator are the localized ones the user sees (日历, not Calendar); `query` and `name` also match the base English name and the bundle id.
- Stable Apple ids: Calendar `com.apple.mobilecal`, Safari `com.apple.mobilesafari`, Settings `com.apple.Preferences`, Photos `com.apple.mobileslideshow`, Messages `com.apple.MobileSMS`, Maps `com.apple.Maps`, Notes `com.apple.mobilenotes`.
- The app lives on the simulator. Do not search the user's source tree or DerivedData for it. A failed listing is an error to read; `count: 0` means nothing matched.
- `ios_sim_build_run` builds, installs and launches a project, workspace or Swift package. A full build takes minutes; on failure read the error tail it returns instead of re-running blindly.
- Also available: `ios_sim_install_app` (a built .app), `ios_sim_uninstall_app`, `ios_sim_open_url` (deep links), `ios_sim_push` (the payload needs an `aps` object), `ios_sim_location`, `ios_sim_appearance`, `ios_sim_record` (start / stop).

## Scope

These rules cover this plugin's `ios_sim_*` tools. The Claude desktop app's built-in iOS Simulator tool is a different integration; do not mix the two in one task.
