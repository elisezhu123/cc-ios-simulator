// src/panel/client/copy.ts
var REAL_DEVICE_ACTION_IDS = ["lock", "unlock", "siri"];
var EN = {
  language: "en",
  title: "iOS Simulator",
  connecting: "connecting\u2026",
  live: "live",
  offline: "offline",
  noDevice: "No live simulator \u2014 boot one with ios_sim_boot, or pick a device above.",
  home: "Home",
  homeHint: "Home \xB7 double-click for the app switcher",
  screenshot: "Screenshot",
  rotate: "Rotate",
  refresh: "Refresh",
  deviceActions: "Device actions\u2026",
  actions: {
    "app-switcher": "App Switcher",
    lock: "Lock",
    unlock: "Unlock",
    shake: "Shake",
    siri: "Siri",
    "action-button": "Action Button",
    "re-center": "Re-center window"
  },
  size: "Simulator display size",
  frame: "Simulator frame style",
  frameStyles: { none: "Frameless", bezel: "Bezel", device: "Device" },
  picker: "Simulator device",
  pickDevice: "Pick a simulator\u2026",
  booted: "booted",
  switching: "switching\u2026",
  captureFailed: "Screenshot failed",
  actionFailed: "Action failed",
  realDevices: "iPhone / iPad (WebDriverAgent)",
  realDevice: "real device",
  noWda: "WebDriverAgent is not running on this iPhone \u2014 start it with ios_real_start_wda, or pick a simulator above."
};
var ZH = {
  language: "zh",
  title: "iOS \u6A21\u62DF\u5668",
  connecting: "\u8FDE\u63A5\u4E2D\u2026",
  live: "\u5B9E\u65F6",
  offline: "\u79BB\u7EBF",
  noDevice: "\u6CA1\u6709\u5B9E\u65F6\u753B\u9762\u2014\u2014\u7528 ios_sim_boot \u542F\u52A8\u4E00\u53F0\u6A21\u62DF\u5668\uFF0C\u6216\u5728\u4E0A\u65B9\u9009\u62E9\u8BBE\u5907\u3002",
  home: "\u56DE\u5230\u684C\u9762",
  homeHint: "\u56DE\u5230\u684C\u9762 \xB7 \u53CC\u51FB\u6253\u5F00\u540E\u53F0 App",
  screenshot: "\u622A\u56FE",
  rotate: "\u65CB\u8F6C",
  refresh: "\u5237\u65B0",
  deviceActions: "\u8BBE\u5907\u64CD\u4F5C\u2026",
  actions: {
    "app-switcher": "\u540E\u53F0 App",
    lock: "\u9501\u5C4F",
    unlock: "\u89E3\u9501",
    shake: "\u6447\u4E00\u6447",
    siri: "Siri",
    "action-button": "Action \u6309\u94AE",
    "re-center": "\u7A97\u53E3\u91CD\u65B0\u5C45\u4E2D"
  },
  size: "\u6A21\u62DF\u5668\u663E\u793A\u5927\u5C0F",
  frame: "\u6A21\u62DF\u5668\u8FB9\u6846\u6837\u5F0F",
  frameStyles: { none: "\u65E0\u6846", bezel: "\u8FB9\u6846", device: "\u771F\u673A\u6846" },
  picker: "\u6A21\u62DF\u5668\u8BBE\u5907",
  pickDevice: "\u9009\u62E9\u6A21\u62DF\u5668\u2026",
  booted: "\u5DF2\u542F\u52A8",
  switching: "\u5207\u6362\u4E2D\u2026",
  captureFailed: "\u622A\u56FE\u5931\u8D25",
  actionFailed: "\u64CD\u4F5C\u5931\u8D25",
  realDevices: "iPhone / iPad\uFF08WebDriverAgent\uFF09",
  realDevice: "\u771F\u673A",
  noWda: "\u8FD9\u53F0 iPhone \u4E0A\u7684 WebDriverAgent \u6CA1\u6709\u8FD0\u884C\u2014\u2014\u7528 ios_real_start_wda \u542F\u52A8\uFF0C\u6216\u5728\u4E0A\u65B9\u9009\u62E9\u6A21\u62DF\u5668\u3002"
};
function copyFor(language) {
  return (language ?? "").toLowerCase().startsWith("zh") ? ZH : EN;
}

// src/panel/client/layout.ts
var DEVICE_SCALE = 3;
var FALLBACK_BASE = { width: 1170, height: 2532 };
var SIZE_OPTIONS = [
  { id: "fit", mode: { kind: "fit" }, en: "Fit", zh: "\u9002\u5E94" },
  ...[50, 75, 100, 125].map((value) => ({ id: `percent-${value}`, mode: { kind: "percent", value }, en: `${value}%`, zh: `${value}%` })),
  { id: "preset-S", mode: { kind: "preset", width: 240 }, en: "S \xB7 240px", zh: "S\uFF08240px\uFF09" },
  { id: "preset-M", mode: { kind: "preset", width: 320 }, en: "M \xB7 320px", zh: "M\uFF08320px\uFF09" },
  { id: "preset-L", mode: { kind: "preset", width: 420 }, en: "L \xB7 420px", zh: "L\uFF08420px\uFF09" }
];
var FRAME_STYLES = ["none", "bezel", "device"];
function sizeModeOf(id) {
  return SIZE_OPTIONS.find((option2) => option2.id === id)?.mode ?? { kind: "fit" };
}
function sizeModeId(mode) {
  const key = JSON.stringify(mode);
  return SIZE_OPTIONS.find((option2) => JSON.stringify(option2.mode) === key)?.id ?? "fit";
}
function frameStyleOf(id) {
  return FRAME_STYLES.includes(id ?? "") ? id : "bezel";
}
function orientationLayout(orientation, baseW, baseH) {
  switch (orientation) {
    case "landscape_left":
      return { rotationDeg: 90, displayW: baseH, displayH: baseW };
    case "landscape_right":
      return { rotationDeg: -90, displayW: baseH, displayH: baseW };
    case "portrait_upside_down":
      return { rotationDeg: 180, displayW: baseW, displayH: baseH };
    default:
      return { rotationDeg: 0, displayW: baseW, displayH: baseH };
  }
}
function framebufferPoint(orientation, displayed) {
  switch (orientation) {
    case "landscape_left":
      return { x: displayed.y, y: 1 - displayed.x };
    case "landscape_right":
      return { x: 1 - displayed.y, y: displayed.x };
    case "portrait_upside_down":
      return { x: 1 - displayed.x, y: 1 - displayed.y };
    default:
      return { x: displayed.x, y: displayed.y };
  }
}
function framePadding(style) {
  return style === "none" ? 0 : style === "bezel" ? 6 : 16;
}
function frameInset(style) {
  return style === "none" ? 0 : framePadding(style) + 1;
}
function screenWidthFor(mode, layout, stage, style) {
  const aspect = layout.displayW / layout.displayH;
  switch (mode.kind) {
    case "fit": {
      const inset = 2 * frameInset(style);
      const maxW = Math.max(0, stage.width - inset);
      const maxH = Math.max(0, stage.height - inset);
      return Math.max(1, Math.floor(Math.min(maxW, maxH * aspect)));
    }
    case "percent":
      return Math.max(1, Math.round(layout.displayW / DEVICE_SCALE * mode.value / 100));
    case "preset":
      return Math.max(1, Math.round(aspect > 1 ? mode.width * aspect : mode.width));
  }
}
function screenRadius(width, height) {
  return Math.round(Math.min(width, height) * 55 / 390);
}

// src/panel/client/protocol.ts
var SIM_TOUCH_TAG = 3;
var SIM_BUTTON_TAG = 4;
var SIM_ROTATE_TAG = 7;
var SIM_CONFIG_TAG = 130;
var SIM_ROTATE_ORIENTATIONS = ["portrait", "landscape_left", "portrait_upside_down", "landscape_right"];
function clamp01(value) {
  return Math.min(1, Math.max(0, value));
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function encodeSimControlFrame(tag, payload) {
  const json = new TextEncoder().encode(JSON.stringify(payload));
  const frame = new Uint8Array(1 + json.length);
  frame[0] = tag;
  frame.set(json, 1);
  return frame;
}
function simTouchFrame(type, x, y) {
  return encodeSimControlFrame(SIM_TOUCH_TAG, { type, x: clamp01(x), y: clamp01(y) });
}
function simButtonFrame(name) {
  return encodeSimControlFrame(SIM_BUTTON_TAG, { button: name });
}
function simRotateFrame(orientation) {
  return encodeSimControlFrame(SIM_ROTATE_TAG, { orientation });
}
function nextSimRotateOrientation(current) {
  const index = SIM_ROTATE_ORIENTATIONS.indexOf(current ?? "");
  return SIM_ROTATE_ORIENTATIONS[((index < 0 ? 0 : index) + 1) % SIM_ROTATE_ORIENTATIONS.length] ?? "portrait";
}
function messageBytes(data) {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return void 0;
}
function parseSimConfigFrame(data) {
  const bytes = messageBytes(data);
  if (bytes === void 0 || bytes.length < 2 || bytes[0] !== SIM_CONFIG_TAG) return void 0;
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes.subarray(1)));
    if (isRecord(value) && typeof value.width === "number" && Number.isFinite(value.width) && typeof value.height === "number" && Number.isFinite(value.height) && typeof value.orientation === "string" && value.orientation !== "") {
      return { width: value.width, height: value.height, orientation: value.orientation };
    }
  } catch {
  }
  return void 0;
}
function normalizePointerPoint(event, bounds) {
  const width = bounds.width > 0 ? bounds.width : 1;
  const height = bounds.height > 0 ? bounds.height : 1;
  return { x: clamp01((event.clientX - bounds.left) / width), y: clamp01((event.clientY - bounds.top) / height) };
}

// src/panel/client/main.ts
var copy = copyFor(navigator.language);
var RECONNECT_DELAYS_MS = [1e3, 2e3, 5e3];
var DEVICE_ACTION_IDS = ["app-switcher", "lock", "unlock", "shake", "siri", "action-button", "re-center"];
var SVG_ATTRS = 'viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';
var ICONS = {
  home: `<svg ${SVG_ATTRS}><path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/></svg>`,
  screenshot: `<svg ${SVG_ATTRS}><path d="M4 7h3l2-3h6l2 3h3v13H4z"/><circle cx="12" cy="13" r="4"/></svg>`,
  rotate: `<svg ${SVG_ATTRS}><path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v6h-6"/></svg>`,
  refresh: `<svg ${SVG_ATTRS}><path d="M3 12a9 9 0 0 1 15.5-6.3L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15.5 6.3L3 16"/><path d="M3 21v-5h5"/></svg>`
};
function element(id) {
  const node = document.getElementById(id);
  if (node === null) throw new Error(`panel markup is missing #${id}`);
  return node;
}
var ui = {
  picker: element("device-picker"),
  status: element("status"),
  home: element("btn-home"),
  shot: element("btn-screenshot"),
  rotate: element("btn-rotate"),
  action: element("device-action"),
  refresh: element("btn-refresh"),
  size: element("size-mode"),
  frameStyle: element("frame-style"),
  stage: element("stage"),
  frame: element("frame"),
  screen: element("screen"),
  img: element("stream"),
  placeholder: element("placeholder")
};
var state = {
  kind: "simulator",
  orientation: "portrait",
  realOrientation: "portrait",
  sizeMode: sizeModeOf(localStorage.getItem("ios-sim.size")),
  frameStyle: frameStyleOf(localStorage.getItem("ios-sim.frame")),
  deviceName: "",
  ws: void 0,
  streamFailures: 0,
  dragging: false,
  pendingMove: void 0,
  moveScheduled: false
};
function setStatus(kind, message) {
  ui.status.dataset.kind = kind;
  const label = message ?? (kind === "live" ? copy.live : kind === "connecting" ? copy.connecting : copy.offline);
  ui.status.textContent = state.deviceName === "" ? label : `${state.deviceName} \xB7 ${label}`;
}
function report(prefix, error) {
  setStatus("offline", `${prefix}: ${error instanceof Error ? error.message : String(error)}`);
}
function applyLayout() {
  const baseW = ui.img.naturalWidth > 0 ? ui.img.naturalWidth : FALLBACK_BASE.width;
  const baseH = ui.img.naturalHeight > 0 ? ui.img.naturalHeight : FALLBACK_BASE.height;
  const layout = orientationLayout(state.orientation, baseW, baseH);
  const stage = ui.stage.getBoundingClientRect();
  const width = screenWidthFor(state.sizeMode, layout, { width: stage.width - 32, height: stage.height - 32 }, state.frameStyle);
  const height = Math.round(width * layout.displayH / layout.displayW);
  const scale = width / layout.displayW;
  ui.screen.style.width = `${width}px`;
  ui.screen.style.height = `${height}px`;
  ui.img.style.width = `${Math.round(baseW * scale)}px`;
  ui.img.style.height = `${Math.round(baseH * scale)}px`;
  ui.img.style.transform = `translate(-50%, -50%) rotate(${layout.rotationDeg}deg)`;
  const radius = screenRadius(width, height);
  ui.screen.style.borderRadius = `${radius}px`;
  ui.frame.dataset.style = state.frameStyle;
  ui.frame.style.padding = `${framePadding(state.frameStyle)}px`;
  ui.frame.style.borderRadius = state.frameStyle === "none" ? "0" : `${radius + frameInset(state.frameStyle)}px`;
}
var reconnectTimer;
var frameWatch;
function onLive() {
  window.clearInterval(frameWatch);
  state.streamFailures = 0;
  ui.placeholder.hidden = true;
  setStatus("live");
  applyLayout();
}
function startStream() {
  window.clearTimeout(reconnectTimer);
  window.clearInterval(frameWatch);
  setStatus("connecting");
  ui.img.src = `/stream?t=${Date.now()}`;
  frameWatch = window.setInterval(() => {
    if (ui.img.naturalWidth > 0) onLive();
  }, 300);
}
ui.img.addEventListener("load", onLive);
ui.img.addEventListener("error", () => {
  window.clearInterval(frameWatch);
  const delay = RECONNECT_DELAYS_MS[Math.min(state.streamFailures, RECONNECT_DELAYS_MS.length - 1)] ?? 5e3;
  state.streamFailures += 1;
  setStatus("offline");
  ui.placeholder.hidden = false;
  ui.placeholder.textContent = state.kind === "real" ? copy.noWda : copy.noDevice;
  reconnectTimer = window.setTimeout(() => {
    void refreshStatus().finally(startStream);
  }, delay);
});
function connectWs() {
  const ws = new WebSocket(`ws://${location.host}/ws`);
  ws.binaryType = "arraybuffer";
  state.ws = ws;
  ws.addEventListener("message", (event) => {
    if (state.kind === "real") return;
    const config = parseSimConfigFrame(event.data);
    if (config === void 0 || config.orientation === state.orientation) return;
    state.orientation = config.orientation;
    applyLayout();
  });
  ws.addEventListener("close", () => {
    if (state.ws === ws) state.ws = void 0;
    window.setTimeout(connectWs, 2e3);
  });
}
function send(frame) {
  const ws = state.ws;
  if (ws !== void 0 && ws.readyState === WebSocket.OPEN) ws.send(new Uint8Array(frame));
}
function pointerPoint(event) {
  return framebufferPoint(state.orientation, normalizePointerPoint(event, ui.screen.getBoundingClientRect()));
}
ui.screen.addEventListener("pointerdown", (event) => {
  if (event.button !== 0) return;
  event.preventDefault();
  ui.screen.setPointerCapture(event.pointerId);
  state.dragging = true;
  const point = pointerPoint(event);
  send(simTouchFrame("begin", point.x, point.y));
});
ui.screen.addEventListener("pointermove", (event) => {
  if (!state.dragging) return;
  state.pendingMove = pointerPoint(event);
  if (state.moveScheduled) return;
  state.moveScheduled = true;
  requestAnimationFrame(() => {
    state.moveScheduled = false;
    const point = state.pendingMove;
    if (point !== void 0 && state.dragging) send(simTouchFrame("move", point.x, point.y));
  });
});
function endTouch(event) {
  if (!state.dragging) return;
  state.dragging = false;
  const point = pointerPoint(event);
  send(simTouchFrame("end", point.x, point.y));
}
ui.screen.addEventListener("pointerup", endTouch);
ui.screen.addEventListener("pointercancel", endTouch);
async function postJson(path, body) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`);
  return value;
}
ui.home.addEventListener("click", () => send(simButtonFrame("home")));
ui.home.addEventListener("dblclick", () => {
  void postJson("/api/device-action", { action: "app-switcher" }).catch((error) => report(copy.actionFailed, error));
});
ui.shot.addEventListener("click", () => {
  void postJson("/api/capture", {}).then(({ url }) => {
    window.open(url, "_blank", "noopener");
  }).catch((error) => report(copy.captureFailed, error));
});
ui.rotate.addEventListener("click", () => {
  if (state.kind === "real") {
    state.realOrientation = nextSimRotateOrientation(state.realOrientation);
    send(simRotateFrame(state.realOrientation));
    return;
  }
  const next = nextSimRotateOrientation(state.orientation);
  send(simRotateFrame(next));
  state.orientation = next;
  applyLayout();
});
ui.action.addEventListener("change", () => {
  const action = ui.action.value;
  ui.action.value = "";
  if (action !== "") void postJson("/api/device-action", { action }).catch((error) => report(copy.actionFailed, error));
});
ui.refresh.addEventListener("click", () => {
  state.streamFailures = 0;
  startStream();
});
ui.size.addEventListener("change", () => {
  state.sizeMode = sizeModeOf(ui.size.value);
  localStorage.setItem("ios-sim.size", ui.size.value);
  applyLayout();
});
ui.frameStyle.addEventListener("change", () => {
  state.frameStyle = frameStyleOf(ui.frameStyle.value);
  localStorage.setItem("ios-sim.frame", state.frameStyle);
  applyLayout();
});
ui.picker.addEventListener("focus", () => {
  void loadDevices();
});
ui.picker.addEventListener("change", () => {
  setStatus("connecting", copy.switching);
  void postJson("/api/switch-device", { udid: ui.picker.value }).then(() => refreshStatus()).then(() => {
    state.ws?.close();
    startStream();
  }).catch((error) => report(copy.actionFailed, error));
});
function runtimeLabel(runtime) {
  const match = /SimRuntime\.([A-Za-z]+)-(\d+)-(\d+)/u.exec(runtime);
  return match === null ? runtime : `${match[1] ?? ""} ${match[2] ?? ""}.${match[3] ?? ""}`;
}
function option(value, label) {
  const node = document.createElement("option");
  node.value = value;
  node.textContent = label;
  return node;
}
async function loadDevices() {
  const response = await fetch("/api/devices");
  if (!response.ok) return;
  const { devices, realDevices = [], streaming } = await response.json();
  const rows = devices.map((device) => {
    const node = option(device.udid, `${device.name} \xB7 ${runtimeLabel(device.runtime)}${device.state === "Booted" ? ` \xB7 ${copy.booted}` : ""}`);
    node.selected = device.udid === streaming;
    return node;
  });
  if (realDevices.length > 0) {
    const group = document.createElement("optgroup");
    group.label = copy.realDevices;
    for (const device of realDevices) {
      const node = option(device.udid, `${device.name} \xB7 ${copy.realDevice}`);
      node.selected = device.udid === streaming;
      group.append(node);
    }
    rows.push(group);
  }
  if (![...devices, ...realDevices].some((device) => device.udid === streaming)) {
    const placeholder = option("", copy.pickDevice);
    placeholder.disabled = true;
    placeholder.selected = true;
    rows.unshift(placeholder);
  }
  ui.picker.replaceChildren(...rows);
}
async function refreshStatus() {
  const response = await fetch("/api/status");
  if (!response.ok) return;
  const status = await response.json();
  state.deviceName = status.deviceName ?? "";
  const kind = status.kind ?? "simulator";
  if (kind !== state.kind) {
    state.kind = kind;
    state.orientation = "portrait";
    state.realOrientation = "portrait";
    fillDeviceActions();
    applyLayout();
    state.ws?.close();
    startStream();
  }
  ui.placeholder.textContent = kind === "real" ? copy.noWda : copy.noDevice;
  if (!status.running && ui.status.dataset.kind === "live") setStatus("offline");
}
function fillDeviceActions() {
  const ids = state.kind === "real" ? REAL_DEVICE_ACTION_IDS : DEVICE_ACTION_IDS;
  ui.action.replaceChildren(option("", copy.deviceActions), ...ids.map((id) => option(id, copy.actions[id])));
}
function initControls() {
  document.title = copy.title;
  document.documentElement.lang = copy.language;
  const buttons = [
    [ui.home, ICONS.home, copy.homeHint],
    [ui.shot, ICONS.screenshot, copy.screenshot],
    [ui.rotate, ICONS.rotate, copy.rotate],
    [ui.refresh, ICONS.refresh, copy.refresh]
  ];
  for (const [button, icon, label] of buttons) {
    button.innerHTML = icon;
    button.title = label;
    button.setAttribute("aria-label", label);
  }
  fillDeviceActions();
  ui.size.replaceChildren(...SIZE_OPTIONS.map((entry) => option(entry.id, copy.language === "zh" ? entry.zh : entry.en)));
  ui.size.value = sizeModeId(state.sizeMode);
  ui.frameStyle.replaceChildren(...FRAME_STYLES.map((style) => option(style, copy.frameStyles[style])));
  ui.frameStyle.value = state.frameStyle;
  ui.size.title = copy.size;
  ui.frameStyle.title = copy.frame;
  ui.picker.title = copy.picker;
}
initControls();
new ResizeObserver(() => applyLayout()).observe(ui.stage);
applyLayout();
void loadDevices();
void refreshStatus().finally(startStream);
connectWs();
window.setInterval(() => {
  void refreshStatus();
}, 5e3);
