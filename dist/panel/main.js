// src/panel/client/annotate.ts
var ANNOTATE_TOOLS = ["pen", "line", "arrow", "rect", "ellipse", "text"];
var ANNOTATE_COLORS = ["#e5484d", "#3b82f6", "#46a758", "#1d1d1f", "#ffffff"];
function markSizes(image) {
  const longEdge = Math.max(image.width, image.height, 1);
  return { stroke: Math.max(2, Math.round(longEdge * 5e-3)), text: Math.max(12, Math.round(longEdge * 0.022)) };
}
var AnnotationDoc = class {
  #shapes = [];
  #past = [];
  #future = [];
  get shapes() {
    return this.#shapes;
  }
  get canUndo() {
    return this.#past.length > 0;
  }
  get canRedo() {
    return this.#future.length > 0;
  }
  add(shape) {
    this.#commit([...this.#shapes, shape]);
  }
  clear() {
    if (this.#shapes.length > 0) this.#commit([]);
  }
  undo() {
    const previous = this.#past.pop();
    if (previous === void 0) return;
    this.#future.push(this.#shapes);
    this.#shapes = previous;
  }
  redo() {
    const next = this.#future.pop();
    if (next === void 0) return;
    this.#past.push(this.#shapes);
    this.#shapes = next;
  }
  #commit(shapes) {
    this.#past.push(this.#shapes);
    this.#future = [];
    this.#shapes = shapes;
  }
};
function shapeFor(tool, color, width, from, to, points = [from, to]) {
  return tool === "pen" ? { kind: "pen", color, width, points } : { kind: tool, color, width, from, to };
}
function isNegligible(shape, minimum) {
  if (shape.kind === "text") return shape.text.trim() === "";
  if (shape.kind === "pen") return shape.points.length < 2;
  return Math.hypot(shape.to.x - shape.from.x, shape.to.y - shape.from.y) < minimum;
}
function arrowHead(from, to, length) {
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  const spread = Math.PI / 7;
  return [
    { x: to.x - length * Math.cos(angle - spread), y: to.y - length * Math.sin(angle - spread) },
    { x: to.x - length * Math.cos(angle + spread), y: to.y - length * Math.sin(angle + spread) }
  ];
}
var FONT_FAMILY = '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif';
function drawShapes(ctx, shapes, scale) {
  for (const shape of shapes) {
    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    if (shape.kind === "text") {
      const size = shape.size * scale;
      ctx.font = `600 ${size}px ${FONT_FAMILY}`;
      ctx.textBaseline = "top";
      ctx.lineWidth = Math.max(2, size * 0.16);
      ctx.strokeStyle = shape.color === "#ffffff" ? "rgba(0,0,0,0.75)" : "rgba(255,255,255,0.9)";
      ctx.fillStyle = shape.color;
      let y = shape.at.y * scale;
      for (const line of shape.text.split("\n")) {
        ctx.strokeText(line, shape.at.x * scale, y);
        ctx.fillText(line, shape.at.x * scale, y);
        y += size * 1.2;
      }
      ctx.restore();
      continue;
    }
    ctx.strokeStyle = shape.color;
    ctx.lineWidth = shape.width * scale;
    ctx.beginPath();
    if (shape.kind === "pen") {
      const [first, ...rest] = shape.points;
      if (first !== void 0) {
        ctx.moveTo(first.x * scale, first.y * scale);
        for (const point of rest) ctx.lineTo(point.x * scale, point.y * scale);
      }
      ctx.stroke();
    } else if (shape.kind === "rect") {
      ctx.strokeRect(
        Math.min(shape.from.x, shape.to.x) * scale,
        Math.min(shape.from.y, shape.to.y) * scale,
        Math.abs(shape.to.x - shape.from.x) * scale,
        Math.abs(shape.to.y - shape.from.y) * scale
      );
    } else if (shape.kind === "ellipse") {
      ctx.ellipse(
        (shape.from.x + shape.to.x) / 2 * scale,
        (shape.from.y + shape.to.y) / 2 * scale,
        Math.abs(shape.to.x - shape.from.x) / 2 * scale,
        Math.abs(shape.to.y - shape.from.y) / 2 * scale,
        0,
        0,
        Math.PI * 2
      );
      ctx.stroke();
    } else {
      ctx.moveTo(shape.from.x * scale, shape.from.y * scale);
      ctx.lineTo(shape.to.x * scale, shape.to.y * scale);
      if (shape.kind === "arrow") {
        const [left, right] = arrowHead(shape.from, shape.to, shape.width * 5.5);
        ctx.moveTo(left.x * scale, left.y * scale);
        ctx.lineTo(shape.to.x * scale, shape.to.y * scale);
        ctx.lineTo(right.x * scale, right.y * scale);
      }
      ctx.stroke();
    }
    ctx.restore();
  }
}

// src/panel/client/annotate-ui.ts
var SVG = 'viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';
var PENCIL_ICON = `<svg ${SVG}><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/><path d="m14.5 5.5 3 3"/></svg>`;
var TOOL_ICONS = {
  pen: PENCIL_ICON,
  line: `<svg ${SVG}><path d="M5 19 19 5"/></svg>`,
  arrow: `<svg ${SVG}><path d="M5 19 19 5"/><path d="M9 5h10v10"/></svg>`,
  rect: `<svg ${SVG}><rect x="4" y="4" width="16" height="16" rx="1"/></svg>`,
  ellipse: `<svg ${SVG}><circle cx="12" cy="12" r="8"/></svg>`,
  text: `<svg ${SVG}><path d="M5 5h14"/><path d="M12 5v14"/><path d="M9 19h6"/></svg>`
};
var UNDO_ICON = `<svg ${SVG}><path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/></svg>`;
var REDO_ICON = `<svg ${SVG}><path d="m15 14 5-5-5-5"/><path d="M20 9H9a5 5 0 0 0 0 10h3"/></svg>`;
var TRASH_ICON = `<svg ${SVG}><path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="M6 7l1 13h10l1-13"/><path d="M9 7V4h6v3"/></svg>`;
function button(html, label, className = "annotate-button") {
  const node = document.createElement("button");
  node.type = "button";
  node.className = className;
  node.innerHTML = html;
  node.title = label;
  node.setAttribute("aria-label", label);
  return node;
}
function separator() {
  const node = document.createElement("span");
  node.className = "annotate-separator";
  return node;
}
var Annotator = class {
  #options;
  #overlay = document.createElement("div");
  #canvas = document.createElement("canvas");
  #bar = document.createElement("div");
  #toolButtons = /* @__PURE__ */ new Map();
  #colorButtons = /* @__PURE__ */ new Map();
  #undo;
  #redo;
  #add;
  #image;
  #doc = new AnnotationDoc();
  #tool = "pen";
  #color = ANNOTATE_COLORS[0];
  #draft;
  #dragFrom;
  #input;
  #busy = false;
  constructor(options) {
    this.#options = options;
    const { copy: copy2 } = options;
    this.#overlay.className = "annotate-overlay";
    this.#overlay.hidden = true;
    this.#overlay.append(this.#canvas);
    options.screen.append(this.#overlay);
    this.#bar.className = "annotate-bar";
    this.#bar.hidden = true;
    for (const tool of ANNOTATE_TOOLS) {
      const node = button(TOOL_ICONS[tool], copy2.annotateTools[tool]);
      node.addEventListener("click", () => this.#setTool(tool));
      this.#toolButtons.set(tool, node);
      this.#bar.append(node);
    }
    this.#bar.append(separator());
    for (const color of ANNOTATE_COLORS) {
      const node = button("", copy2.annotateColors[ANNOTATE_COLORS.indexOf(color)] ?? color, "annotate-color");
      node.style.setProperty("--swatch", color);
      node.addEventListener("click", () => this.#setColor(color));
      this.#colorButtons.set(color, node);
      this.#bar.append(node);
    }
    this.#bar.append(separator());
    this.#undo = button(UNDO_ICON, copy2.undo);
    this.#redo = button(REDO_ICON, copy2.redo);
    const clear = button(TRASH_ICON, copy2.clear);
    this.#undo.addEventListener("click", () => {
      this.#doc.undo();
      this.#render();
    });
    this.#redo.addEventListener("click", () => {
      this.#doc.redo();
      this.#render();
    });
    clear.addEventListener("click", () => {
      this.#doc.clear();
      this.#render();
    });
    const close = button(copy2.close, copy2.close, "annotate-text-button");
    close.addEventListener("click", () => this.close());
    this.#add = button(copy2.addToChat, copy2.addToChat, "annotate-primary");
    this.#add.addEventListener("click", () => {
      void this.#submit();
    });
    this.#bar.append(this.#undo, this.#redo, clear, close, this.#add);
    document.body.append(this.#bar);
    this.#overlay.addEventListener("pointerdown", (event) => this.#down(event));
    this.#overlay.addEventListener("pointermove", (event) => this.#move(event));
    this.#overlay.addEventListener("pointerup", (event) => this.#up(event));
    this.#overlay.addEventListener("pointercancel", (event) => this.#up(event));
    window.addEventListener("keydown", (event) => this.#key(event));
    new ResizeObserver(() => this.#render()).observe(this.#overlay);
    this.#setTool("pen");
    this.#setColor(this.#color);
  }
  get isOpen() {
    return !this.#overlay.hidden;
  }
  /** Freeze a fresh screenshot and show the tools. */
  async open() {
    if (this.isOpen || this.#busy) return;
    this.#busy = true;
    try {
      const { url } = await this.#options.capture();
      const image = new Image();
      image.src = url;
      await image.decode();
      this.#image = image;
      this.#doc = new AnnotationDoc();
      this.#overlay.hidden = false;
      this.#bar.hidden = false;
      document.body.classList.add("annotating");
      this.#render();
    } finally {
      this.#busy = false;
    }
  }
  close() {
    this.#commitText();
    this.#overlay.hidden = true;
    this.#bar.hidden = true;
    document.body.classList.remove("annotating");
    this.#image = void 0;
    this.#draft = void 0;
  }
  #setTool(tool) {
    this.#commitText();
    this.#tool = tool;
    for (const [name, node] of this.#toolButtons) node.classList.toggle("active", name === tool);
    this.#overlay.dataset.tool = tool;
  }
  #setColor(color) {
    this.#color = color;
    for (const [name, node] of this.#colorButtons) node.classList.toggle("active", name === color);
    if (this.#input !== void 0) this.#input.style.color = color;
  }
  /** Image pixels per overlay (CSS) pixel. */
  #imageScale() {
    const width = this.#overlay.clientWidth;
    return this.#image === void 0 || width === 0 ? 1 : this.#image.naturalWidth / width;
  }
  #imagePoint(event) {
    const box = this.#overlay.getBoundingClientRect();
    const scale = this.#imageScale();
    return { x: (event.clientX - box.left) * scale, y: (event.clientY - box.top) * scale };
  }
  #sizes() {
    return markSizes(this.#image === void 0 ? { width: 1, height: 1 } : { width: this.#image.naturalWidth, height: this.#image.naturalHeight });
  }
  #down(event) {
    event.stopPropagation();
    event.preventDefault();
    if (this.#image === void 0 || event.button !== 0) return;
    const point = this.#imagePoint(event);
    if (this.#tool === "text") {
      this.#commitText();
      this.#openText(event, point);
      return;
    }
    this.#overlay.setPointerCapture(event.pointerId);
    this.#dragFrom = point;
    this.#draft = shapeFor(this.#tool, this.#color, this.#sizes().stroke, point, point, [point]);
  }
  #move(event) {
    event.stopPropagation();
    const from = this.#dragFrom;
    const draft = this.#draft;
    if (from === void 0 || draft === void 0 || this.#tool === "text") return;
    const point = this.#imagePoint(event);
    this.#draft = draft.kind === "pen" ? { ...draft, points: [...draft.points, point] } : shapeFor(this.#tool, this.#color, draft.kind === "text" ? 1 : draft.width, from, point);
    this.#render();
  }
  #up(event) {
    event.stopPropagation();
    const draft = this.#draft;
    this.#draft = void 0;
    this.#dragFrom = void 0;
    if (draft !== void 0 && !isNegligible(draft, this.#sizes().stroke * 2)) this.#doc.add(draft);
    this.#render();
  }
  #openText(event, at) {
    const box = this.#overlay.getBoundingClientRect();
    const input = document.createElement("textarea");
    input.className = "annotate-input";
    input.rows = 1;
    input.style.left = `${event.clientX - box.left}px`;
    input.style.top = `${event.clientY - box.top}px`;
    input.style.color = this.#color;
    input.style.fontSize = `${this.#sizes().text / this.#imageScale()}px`;
    input.dataset.x = String(at.x);
    input.dataset.y = String(at.y);
    input.addEventListener("pointerdown", (stop) => stop.stopPropagation());
    input.addEventListener("keydown", (key) => {
      key.stopPropagation();
      if (key.key === "Enter" && !key.shiftKey) {
        key.preventDefault();
        this.#commitText();
      } else if (key.key === "Escape") {
        input.value = "";
        this.#commitText();
      }
    });
    input.addEventListener("blur", () => this.#commitText());
    this.#overlay.append(input);
    this.#input = input;
    input.focus();
  }
  #commitText() {
    const input = this.#input;
    if (input === void 0) return;
    this.#input = void 0;
    const text = input.value.replace(/\s+$/u, "");
    input.remove();
    if (text.trim() !== "") {
      this.#doc.add({ kind: "text", color: this.#color, size: this.#sizes().text, at: { x: Number(input.dataset.x), y: Number(input.dataset.y) }, text });
      this.#render();
    }
  }
  #key(event) {
    if (!this.isOpen || this.#input !== void 0) return;
    const mod = event.metaKey || event.ctrlKey;
    if (event.key === "Escape") {
      this.close();
    } else if (mod && event.key.toLowerCase() === "z") {
      event.preventDefault();
      if (event.shiftKey) this.#doc.redo();
      else this.#doc.undo();
      this.#render();
    } else if (mod && event.key === "Enter") {
      event.preventDefault();
      void this.#submit();
    }
  }
  #render() {
    this.#undo.disabled = !this.#doc.canUndo;
    this.#redo.disabled = !this.#doc.canRedo;
    const image = this.#image;
    if (image === void 0 || this.#overlay.hidden) return;
    const ratio = window.devicePixelRatio || 1;
    const width = this.#overlay.clientWidth;
    const height = this.#overlay.clientHeight;
    this.#canvas.width = Math.max(1, Math.round(width * ratio));
    this.#canvas.height = Math.max(1, Math.round(height * ratio));
    const ctx = this.#canvas.getContext("2d");
    if (ctx === null) return;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.drawImage(image, 0, 0, width, height);
    const shapes = this.#draft === void 0 ? this.#doc.shapes : [...this.#doc.shapes, this.#draft];
    drawShapes(ctx, shapes, 1 / this.#imageScale());
  }
  /** "Add to chat": the composite at full resolution → the server, and the clipboard. */
  async #submit() {
    this.#commitText();
    const image = this.#image;
    if (image === void 0 || this.#busy) return;
    this.#busy = true;
    this.#add.disabled = true;
    try {
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const ctx = canvas.getContext("2d");
      if (ctx === null) throw new Error("canvas is unavailable");
      ctx.drawImage(image, 0, 0);
      drawShapes(ctx, this.#doc.shapes, 1);
      const dataUrl = canvas.toDataURL("image/png");
      await this.#options.save(dataUrl);
      let copied = false;
      try {
        const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
        if (blob !== null && typeof ClipboardItem !== "undefined") {
          await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
          copied = true;
        }
      } catch {
      }
      this.close();
      this.#options.notify(copied ? this.#options.copy.annotationAddedCopied : this.#options.copy.annotationAdded, "ok");
    } catch (error) {
      this.#options.notify(`${this.#options.copy.annotationFailed}: ${error instanceof Error ? error.message : String(error)}`, "error");
    } finally {
      this.#busy = false;
      this.#add.disabled = false;
    }
  }
};

// src/panel/client/copy.ts
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
    "re-center": "Re-center window",
    "toggle-keyboard": "Show on-screen keyboard",
    "slow-animations": "Slow animations"
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
  noWda: "WebDriverAgent is not running on this iPhone \u2014 start it with ios_real_start_wda, or pick a simulator above.",
  annotate: "Annotate a screenshot",
  annotateTools: { pen: "Pen", line: "Line", arrow: "Arrow", rect: "Box", ellipse: "Ellipse", text: "Text" },
  annotateColors: ["Red", "Blue", "Green", "Black", "White"],
  undo: "Undo",
  redo: "Redo",
  clear: "Clear",
  close: "Close",
  addToChat: "Add to chat",
  annotationAdded: "Added \u2014 ask Claude to look at it (ios_sim_annotation)",
  annotationAddedCopied: "Added and copied \u2014 paste it into the chat, or ask Claude to look at it (ios_sim_annotation)",
  annotationFailed: "Could not add the annotation",
  deviceMenu: "Device",
  debugMenu: "Debug",
  appearance: "Appearance",
  light: "Light",
  dark: "Dark",
  keyboard: "Keyboard",
  rotateLeft: "Rotate left",
  rotateRight: "Rotate right",
  saveScreenshot: "Save screenshot",
  screenshotSaved: "Screenshot saved",
  recordVideo: "Record video",
  stopRecording: "Stop recording",
  recordingSaved: "Recording saved to",
  shutdown: "Shut down simulator",
  detach: "Detach simulator",
  fullscreen: "Full screen",
  bootedSection: "Booted",
  realSection: "iPhone / iPad",
  shutdownSection: "Shut down",
  displaySize: "Display size",
  reconnect: "Reconnect stream",
  simulatorOnly: "Simulators only"
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
    "re-center": "\u7A97\u53E3\u91CD\u65B0\u5C45\u4E2D",
    "toggle-keyboard": "\u663E\u793A\u5C4F\u5E55\u952E\u76D8",
    "slow-animations": "\u6162\u52A8\u753B"
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
  noWda: "\u8FD9\u53F0 iPhone \u4E0A\u7684 WebDriverAgent \u6CA1\u6709\u8FD0\u884C\u2014\u2014\u7528 ios_real_start_wda \u542F\u52A8\uFF0C\u6216\u5728\u4E0A\u65B9\u9009\u62E9\u6A21\u62DF\u5668\u3002",
  annotate: "\u6807\u6CE8\u622A\u56FE",
  annotateTools: { pen: "\u753B\u7B14", line: "\u76F4\u7EBF", arrow: "\u7BAD\u5934", rect: "\u77E9\u5F62", ellipse: "\u692D\u5706", text: "\u6587\u5B57" },
  annotateColors: ["\u7EA2", "\u84DD", "\u7EFF", "\u9ED1", "\u767D"],
  undo: "\u64A4\u9500",
  redo: "\u91CD\u505A",
  clear: "\u6E05\u7A7A",
  close: "\u5173\u95ED",
  addToChat: "\u6DFB\u52A0\u5230\u5BF9\u8BDD",
  annotationAdded: "\u5DF2\u6DFB\u52A0\u2014\u2014\u8BA9 Claude \u67E5\u770B\uFF08ios_sim_annotation\uFF09",
  annotationAddedCopied: "\u5DF2\u6DFB\u52A0\u5E76\u590D\u5236\u2014\u2014\u53EF\u76F4\u63A5\u7C98\u8D34\u5230\u5BF9\u8BDD\uFF0C\u6216\u8BA9 Claude \u67E5\u770B\uFF08ios_sim_annotation\uFF09",
  annotationFailed: "\u6DFB\u52A0\u6807\u6CE8\u5931\u8D25",
  deviceMenu: "\u8BBE\u5907",
  debugMenu: "\u8C03\u8BD5",
  appearance: "\u5916\u89C2",
  light: "\u6D45\u8272",
  dark: "\u6DF1\u8272",
  keyboard: "\u952E\u76D8",
  rotateLeft: "\u5411\u5DE6\u65CB\u8F6C",
  rotateRight: "\u5411\u53F3\u65CB\u8F6C",
  saveScreenshot: "\u4FDD\u5B58\u622A\u56FE",
  screenshotSaved: "\u622A\u56FE\u5DF2\u4FDD\u5B58",
  recordVideo: "\u5F55\u5236\u89C6\u9891",
  stopRecording: "\u505C\u6B62\u5F55\u5236",
  recordingSaved: "\u5F55\u5C4F\u5DF2\u4FDD\u5B58\u5230",
  shutdown: "\u5173\u95ED\u6A21\u62DF\u5668",
  detach: "\u65AD\u5F00\u6A21\u62DF\u5668",
  fullscreen: "\u5168\u5C4F",
  bootedSection: "\u5DF2\u542F\u52A8",
  realSection: "iPhone / iPad",
  shutdownSection: "\u672A\u542F\u52A8",
  displaySize: "\u663E\u793A\u5927\u5C0F",
  reconnect: "\u91CD\u65B0\u8FDE\u63A5\u753B\u9762",
  simulatorOnly: "\u4EC5\u6A21\u62DF\u5668\u53EF\u7528"
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
  return SIZE_OPTIONS.find((option) => option.id === id)?.mode ?? { kind: "fit" };
}
function sizeModeId(mode) {
  const key = JSON.stringify(mode);
  return SIZE_OPTIONS.find((option) => JSON.stringify(option.mode) === key)?.id ?? "fit";
}
function frameStyleOf(id) {
  return FRAME_STYLES.includes(id ?? "") ? id : "device";
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

// src/panel/client/menu.ts
var CHECK = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 5 5 9-10"/></svg>';
var CHEVRON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>';
var openMenu;
function closeMenus() {
  openMenu?.close();
}
document.addEventListener("pointerdown", (event) => {
  if (openMenu !== void 0 && !openMenu.contains(event.target)) openMenu.close();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeMenus();
});
window.addEventListener("blur", () => closeMenus());
var Menu = class {
  #anchor;
  #build;
  #root = document.createElement("div");
  #sub;
  constructor(anchor, build) {
    this.#anchor = anchor;
    this.#build = build;
    this.#root.className = "menu-popover";
    this.#root.setAttribute("role", "menu");
    this.#root.hidden = true;
    document.body.append(this.#root);
    anchor.setAttribute("aria-haspopup", "menu");
    anchor.addEventListener("click", () => {
      if (openMenu === this) this.close();
      else this.open();
    });
    anchor.addEventListener("pointerenter", () => {
      if (openMenu !== void 0 && openMenu !== this) this.open();
    });
  }
  get isOpen() {
    return openMenu === this;
  }
  contains(node) {
    return this.#anchor.contains(node) || this.#root.contains(node) || (this.#sub?.contains(node) ?? false);
  }
  open() {
    openMenu?.close();
    openMenu = this;
    this.#fill(this.#root, this.#build());
    this.#root.hidden = false;
    this.#anchor.classList.add("open");
    const box = this.#anchor.getBoundingClientRect();
    this.#root.style.left = `${Math.max(8, Math.min(box.left, window.innerWidth - this.#root.offsetWidth - 8))}px`;
    this.#root.style.top = `${box.bottom + 4}px`;
  }
  close() {
    if (openMenu === this) openMenu = void 0;
    this.#root.hidden = true;
    this.#closeSub();
    this.#anchor.classList.remove("open");
  }
  #closeSub() {
    this.#sub?.remove();
    this.#sub = void 0;
    for (const row of this.#root.querySelectorAll(".menu-item.expanded")) row.classList.remove("expanded");
  }
  #fill(container, entries) {
    container.replaceChildren();
    for (const entry of entries) {
      if ("separator" in entry) {
        const line = document.createElement("div");
        line.className = "menu-separator";
        container.append(line);
        continue;
      }
      if ("section" in entry) {
        const heading = document.createElement("div");
        heading.className = "menu-section";
        heading.textContent = entry.section;
        if (entry.dot === true) heading.insertAdjacentHTML("beforeend", '<span class="menu-dot"></span>');
        container.append(heading);
        continue;
      }
      container.append(this.#row(entry, container === this.#root));
    }
  }
  #row(item, topLevel) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "menu-item";
    row.setAttribute("role", item.checked === void 0 ? "menuitem" : "menuitemcheckbox");
    if (item.checked !== void 0) row.setAttribute("aria-checked", String(item.checked));
    row.disabled = item.disabled === true;
    const text = document.createElement("span");
    text.className = "menu-label";
    text.textContent = item.label;
    if (item.detail !== void 0) {
      const detail = document.createElement("span");
      detail.className = "menu-detail";
      detail.textContent = item.detail;
      text.append(detail);
    }
    row.append(text);
    if (item.shortcut !== void 0) {
      const hint = document.createElement("kbd");
      hint.textContent = item.shortcut;
      row.append(hint);
    }
    if (item.checked === true) row.insertAdjacentHTML("beforeend", `<span class="menu-check">${CHECK}</span>`);
    if (item.submenu !== void 0) row.insertAdjacentHTML("beforeend", `<span class="menu-chevron">${CHEVRON}</span>`);
    const submenu = item.submenu;
    if (submenu !== void 0) {
      const show = () => {
        if (row.disabled) return;
        this.#closeSub();
        row.classList.add("expanded");
        const sub = document.createElement("div");
        sub.className = "menu-popover submenu";
        sub.setAttribute("role", "menu");
        this.#fill(sub, submenu());
        document.body.append(sub);
        this.#sub = sub;
        const box = row.getBoundingClientRect();
        const left = box.right + 4 + sub.offsetWidth > window.innerWidth - 8 ? box.left - sub.offsetWidth - 4 : box.right + 4;
        sub.style.left = `${Math.max(8, left)}px`;
        sub.style.top = `${Math.max(8, box.top - 6)}px`;
      };
      row.addEventListener("pointerenter", show);
      row.addEventListener("click", show);
    } else {
      if (topLevel) row.addEventListener("pointerenter", () => this.#closeSub());
      row.addEventListener("click", () => {
        this.close();
        item.run?.();
      });
    }
    return row;
  }
};

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
var SIMULATOR_ACTIONS = ["app-switcher", "shake", "siri", "action-button", "re-center"];
var IS_MAC = /Mac|iPhone|iPad/u.test(navigator.platform);
function keys(shift, key) {
  return IS_MAC ? `${shift ? "\u21E7" : ""}\u2318${key}` : `${shift ? "Shift+" : ""}Ctrl+${key}`;
}
var SHORTCUTS = {
  home: keys(true, "H"),
  screenshot: keys(false, "S"),
  record: keys(false, "R"),
  rotateRight: keys(false, "\u2192"),
  rotateLeft: keys(false, "\u2190"),
  keyboard: keys(false, "K")
};
var SVG_ATTRS = 'viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';
var ICONS = {
  home: `<svg ${SVG_ATTRS}><path d="M4 10.5 12 4l8 6.5V19a1 1 0 0 1-1 1h-4v-5h-6v5H5a1 1 0 0 1-1-1z"/></svg>`,
  screenshot: `<svg ${SVG_ATTRS}><path d="M4 8h3l1.6-2.4h6.8L17 8h3v11H4z"/><circle cx="12" cy="13.5" r="3.5"/></svg>`,
  record: `<svg ${SVG_ATTRS}><rect x="3" y="7" width="12.5" height="10" rx="1.5"/><path d="m15.5 11 5-3v8l-5-3"/></svg>`,
  recording: `<svg ${SVG_ATTRS}><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none"/></svg>`,
  rotate: `<svg ${SVG_ATTRS}><path d="M20 12a8 8 0 1 1-2.5-5.8"/><path d="M20 4v5h-5"/></svg>`,
  power: `<svg ${SVG_ATTRS}><path d="M12 3v8"/><path d="M6.3 7.3a8 8 0 1 0 11.4 0"/></svg>`,
  detach: `<svg ${SVG_ATTRS}><path d="M10 4H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h5"/><path d="M14 8l4 4-4 4"/><path d="M18 12H9"/></svg>`,
  fullscreen: `<svg ${SVG_ATTRS}><path d="M14 4h6v6"/><path d="m20 4-6 6"/><path d="M10 20H4v-6"/><path d="m4 20 6-6"/></svg>`,
  chevron: '<svg class="chevron" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>'
};
function element(id) {
  const node = document.getElementById(id);
  if (node === null) throw new Error(`panel markup is missing #${id}`);
  return node;
}
var ui = {
  status: element("status"),
  fullscreen: element("btn-fullscreen"),
  devicesButton: element("menu-devices"),
  deviceName: element("device-name"),
  deviceRuntime: element("device-runtime"),
  deviceMenuButton: element("menu-device"),
  debugMenuButton: element("menu-debug"),
  stage: element("stage"),
  frame: element("frame"),
  screen: element("screen"),
  img: element("stream"),
  placeholder: element("placeholder"),
  toast: element("toast"),
  home: element("btn-home"),
  annotate: element("btn-annotate"),
  shot: element("btn-screenshot"),
  record: element("btn-record"),
  rotate: element("btn-rotate"),
  shutdown: element("btn-shutdown"),
  detach: element("btn-detach")
};
function stored(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function store(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
  }
}
var state = {
  kind: "simulator",
  orientation: "portrait",
  realOrientation: "portrait",
  sizeMode: sizeModeOf(stored("ios-sim.size")),
  frameStyle: frameStyleOf(stored("ios-sim.frame")),
  device: void 0,
  deviceName: "",
  recording: false,
  devices: [],
  realDevices: [],
  ws: void 0,
  streamFailures: 0,
  dragging: false,
  pendingMove: void 0,
  moveScheduled: false
};
function setStatus(kind, message) {
  ui.status.dataset.kind = kind;
  ui.status.textContent = message ?? (kind === "live" ? copy.live : kind === "connecting" ? copy.connecting : copy.offline);
  ui.status.title = ui.status.textContent;
}
function report(prefix, error) {
  notify(`${prefix}: ${error instanceof Error ? error.message : String(error)}`, "error");
}
var toastTimer;
function notify(message, kind) {
  window.clearTimeout(toastTimer);
  ui.toast.textContent = message;
  ui.toast.dataset.kind = kind;
  ui.toast.hidden = false;
  toastTimer = window.setTimeout(() => {
    ui.toast.hidden = true;
  }, kind === "ok" ? 5e3 : 8e3);
}
function applyLayout() {
  const baseW = ui.img.naturalWidth > 0 ? ui.img.naturalWidth : FALLBACK_BASE.width;
  const baseH = ui.img.naturalHeight > 0 ? ui.img.naturalHeight : FALLBACK_BASE.height;
  const layout = orientationLayout(state.orientation, baseW, baseH);
  const stage = ui.stage.getBoundingClientRect();
  const style = getComputedStyle(ui.stage);
  const room = {
    width: stage.width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
    height: stage.height - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)
  };
  const width = screenWidthFor(state.sizeMode, layout, room, state.frameStyle);
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
  ui.frame.dataset.landscape = String(width > height);
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
function reconnect() {
  state.streamFailures = 0;
  state.ws?.close();
  startStream();
}
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
function deviceAction(action) {
  void postJson("/api/device-action", { action }).catch((error) => report(copy.actionFailed, error));
}
function pressHome() {
  send(simButtonFrame("home"));
}
function rotate(direction) {
  const order = SIM_ROTATE_ORIENTATIONS;
  const turn = (current) => {
    if (direction === 1) return nextSimRotateOrientation(current);
    const index = order.indexOf(current);
    return order[((index < 0 ? 0 : index) + order.length - 1) % order.length] ?? "portrait";
  };
  if (state.kind === "real") {
    state.realOrientation = turn(state.realOrientation);
    send(simRotateFrame(state.realOrientation));
    return;
  }
  state.orientation = turn(state.orientation);
  send(simRotateFrame(state.orientation));
  applyLayout();
}
async function saveScreenshot() {
  const { url } = await postJson("/api/capture", {});
  const blob = await (await fetch(url)).blob();
  const link = document.createElement("a");
  const stamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:T]/gu, ".").replace(/\.\d+Z$/u, "");
  link.href = URL.createObjectURL(blob);
  link.download = `Simulator Screenshot - ${state.deviceName || "device"} - ${stamp}.png`;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(link.href), 1e4);
  notify(copy.screenshotSaved, "ok");
}
async function toggleRecording() {
  const result = await postJson("/api/record", { action: state.recording ? "stop" : "start" });
  state.recording = result.recording;
  renderDock();
  if (!result.recording && result.path !== void 0) notify(`${copy.recordingSaved} ${result.path}`, "ok");
}
async function shutdown() {
  await postJson("/api/shutdown", {});
  state.recording = false;
  await refreshStatus();
  reconnect();
}
async function detach() {
  await postJson("/api/detach", {});
  await refreshStatus();
  reconnect();
}
var annotator = new Annotator({
  screen: ui.screen,
  copy,
  capture: () => postJson("/api/capture", {}),
  save: async (image) => {
    await postJson("/api/annotations", { image });
  },
  notify
});
function toggleAnnotate() {
  if (annotator.isOpen) annotator.close();
  else void annotator.open().catch((error) => report(copy.captureFailed, error));
}
function dockButton(button2, icon, label, shortcut) {
  button2.innerHTML = `${icon}<span class="tip" role="tooltip">${label}${shortcut === void 0 ? "" : `<kbd>${shortcut}</kbd>`}</span>`;
  button2.setAttribute("aria-label", label);
  if (shortcut !== void 0) button2.setAttribute("aria-keyshortcuts", shortcut);
}
function renderDock() {
  const simulator = state.kind === "simulator";
  dockButton(ui.home, ICONS.home, copy.home, SHORTCUTS.home);
  dockButton(ui.annotate, PENCIL_ICON, copy.annotate);
  dockButton(ui.shot, ICONS.screenshot, copy.saveScreenshot, SHORTCUTS.screenshot);
  dockButton(ui.record, state.recording ? ICONS.recording : ICONS.record, simulator ? state.recording ? copy.stopRecording : copy.recordVideo : copy.simulatorOnly, SHORTCUTS.record);
  dockButton(ui.rotate, ICONS.rotate, copy.rotateRight, SHORTCUTS.rotateRight);
  dockButton(ui.shutdown, ICONS.power, simulator ? copy.shutdown : copy.simulatorOnly);
  dockButton(ui.detach, ICONS.detach, copy.detach);
  ui.record.classList.toggle("recording", state.recording);
  ui.record.disabled = !simulator;
  ui.shutdown.disabled = !simulator;
}
ui.home.addEventListener("click", pressHome);
ui.home.addEventListener("dblclick", () => deviceAction("app-switcher"));
ui.annotate.addEventListener("click", toggleAnnotate);
ui.shot.addEventListener("click", () => {
  void saveScreenshot().catch((error) => report(copy.captureFailed, error));
});
ui.record.addEventListener("click", () => {
  void toggleRecording().catch((error) => report(copy.actionFailed, error));
});
ui.rotate.addEventListener("click", () => rotate(1));
ui.shutdown.addEventListener("click", () => {
  void shutdown().catch((error) => report(copy.actionFailed, error));
});
ui.detach.addEventListener("click", () => {
  void detach().catch((error) => report(copy.actionFailed, error));
});
ui.fullscreen.addEventListener("click", () => {
  if (document.fullscreenElement === null) void document.documentElement.requestFullscreen().catch(() => void 0);
  else void document.exitFullscreen();
});
document.addEventListener("keydown", (event) => {
  if (annotator.isOpen || !(event.metaKey || event.ctrlKey) || event.altKey) return;
  const target = event.target;
  if (target !== null && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/u.test(target.tagName))) return;
  const key = event.key.toLowerCase();
  const run = (action) => {
    event.preventDefault();
    closeMenus();
    action();
  };
  if (event.shiftKey && key === "h") run(pressHome);
  else if (!event.shiftKey && key === "s") run(() => {
    void saveScreenshot().catch((error) => report(copy.captureFailed, error));
  });
  else if (!event.shiftKey && key === "r" && state.kind === "simulator") run(() => {
    void toggleRecording().catch((error) => report(copy.actionFailed, error));
  });
  else if (!event.shiftKey && key === "arrowright") run(() => rotate(1));
  else if (!event.shiftKey && key === "arrowleft") run(() => rotate(-1));
  else if (!event.shiftKey && key === "k" && state.kind === "simulator") run(() => deviceAction("toggle-keyboard"));
});
function runtimeLabel(runtime) {
  const match = /SimRuntime\.([A-Za-z]+)-(\d+)-(\d+)/u.exec(runtime);
  return match === null ? runtime : `${match[1] ?? ""} ${match[2] ?? ""}.${match[3] ?? ""}`;
}
function switchTo(udid) {
  setStatus("connecting", copy.switching);
  void postJson("/api/switch-device", { udid }).then(() => refreshStatus()).then(reconnect).catch((error) => report(copy.actionFailed, error));
}
var devicesMenu = new Menu(ui.devicesButton, () => {
  const entries = [];
  const row = (device) => ({
    label: device.name,
    detail: runtimeLabel(device.runtime),
    checked: device.udid === state.device,
    run: () => switchTo(device.udid)
  });
  const booted = state.devices.filter((device) => device.state === "Booted");
  const others = state.devices.filter((device) => device.state !== "Booted");
  if (booted.length > 0) entries.push({ section: copy.bootedSection, dot: true }, ...booted.map(row));
  if (state.realDevices.length > 0) {
    entries.push({ section: copy.realSection }, ...state.realDevices.map((device) => ({
      label: device.name,
      detail: copy.realDevice,
      checked: device.udid === state.device,
      run: () => switchTo(device.udid)
    })));
  }
  if (others.length > 0) entries.push({ section: copy.shutdownSection }, ...others.map(row));
  return entries.length > 0 ? entries : [{ label: copy.noDevice, disabled: true }];
});
ui.devicesButton.addEventListener("pointerdown", () => {
  void loadDevices().then(() => {
    if (devicesMenu.isOpen) devicesMenu.open();
  });
});
new Menu(ui.deviceMenuButton, () => {
  const rotation = [
    { label: copy.rotateLeft, shortcut: SHORTCUTS.rotateLeft, run: () => rotate(-1) },
    { label: copy.rotateRight, shortcut: SHORTCUTS.rotateRight, run: () => rotate(1) }
  ];
  const lock = [
    { label: copy.actions.lock, run: () => deviceAction("lock") },
    { label: copy.actions.unlock, run: () => deviceAction("unlock") },
    { label: copy.actions.siri, run: () => deviceAction("siri") }
  ];
  if (state.kind === "real") return [...rotation, { separator: true }, ...lock];
  const appearance = (value) => {
    void postJson("/api/appearance", { appearance: value }).catch((error) => report(copy.actionFailed, error));
  };
  return [
    { label: copy.appearance, submenu: () => [
      { label: copy.light, run: () => appearance("light") },
      { label: copy.dark, run: () => appearance("dark") }
    ] },
    { label: copy.keyboard, submenu: () => [
      { label: copy.actions["toggle-keyboard"], shortcut: SHORTCUTS.keyboard, run: () => deviceAction("toggle-keyboard") }
    ] },
    { separator: true },
    ...rotation,
    { separator: true },
    { label: copy.home, shortcut: SHORTCUTS.home, run: pressHome },
    ...SIMULATOR_ACTIONS.filter((id) => id !== "siri").map((id) => ({ label: copy.actions[id], run: () => deviceAction(id) })),
    { separator: true },
    ...lock
  ];
});
new Menu(ui.debugMenuButton, () => [
  ...state.kind === "simulator" ? [{ label: copy.actions["slow-animations"], run: () => deviceAction("slow-animations") }, { separator: true }] : [],
  { label: copy.displaySize, submenu: () => SIZE_OPTIONS.map((option) => ({
    label: copy.language === "zh" ? option.zh : option.en,
    checked: sizeModeId(state.sizeMode) === option.id,
    run: () => {
      state.sizeMode = option.mode;
      store("ios-sim.size", option.id);
      applyLayout();
    }
  })) },
  { label: copy.frame, submenu: () => FRAME_STYLES.map((style) => ({
    label: copy.frameStyles[style],
    checked: state.frameStyle === style,
    run: () => {
      state.frameStyle = style;
      store("ios-sim.frame", style);
      applyLayout();
    }
  })) },
  { separator: true },
  { label: copy.reconnect, run: reconnect }
]);
async function loadDevices() {
  const response = await fetch("/api/devices");
  if (!response.ok) return;
  const body = await response.json();
  state.devices = body.devices;
  state.realDevices = body.realDevices ?? [];
  renderDeviceButton();
}
function renderDeviceButton() {
  const row = state.devices.find((device) => device.udid === state.device);
  ui.deviceName.textContent = state.deviceName !== "" ? state.deviceName : copy.pickDevice;
  ui.deviceRuntime.textContent = state.kind === "real" ? copy.realDevice : row === void 0 ? "" : runtimeLabel(row.runtime);
  ui.devicesButton.insertAdjacentHTML("beforeend", ui.devicesButton.querySelector(".chevron") === null ? ICONS.chevron : "");
}
async function refreshStatus() {
  const response = await fetch("/api/status");
  if (!response.ok) return;
  const status = await response.json();
  state.device = status.device;
  state.deviceName = status.deviceName ?? "";
  const kind = status.kind ?? "simulator";
  const recording = status.recording === true;
  if (kind !== state.kind) {
    state.kind = kind;
    state.orientation = "portrait";
    state.realOrientation = "portrait";
    applyLayout();
    reconnect();
  }
  state.recording = recording;
  renderDock();
  renderDeviceButton();
  ui.placeholder.textContent = kind === "real" ? copy.noWda : copy.noDevice;
  if (!status.running && ui.status.dataset.kind === "live") setStatus("offline");
}
function initControls() {
  document.title = copy.title;
  document.documentElement.lang = copy.language;
  ui.deviceMenuButton.innerHTML = `${copy.deviceMenu}${ICONS.chevron}`;
  ui.debugMenuButton.innerHTML = `${copy.debugMenu}${ICONS.chevron}`;
  ui.devicesButton.title = copy.picker;
  ui.fullscreen.innerHTML = ICONS.fullscreen;
  ui.fullscreen.title = copy.fullscreen;
  ui.fullscreen.setAttribute("aria-label", copy.fullscreen);
  renderDock();
  renderDeviceButton();
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
