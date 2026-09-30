/**
 * Browser entry for the live panel, laid out like Claude Code desktop's iOS
 * Simulator: a title bar, a menu bar (device picker, Device, Debug), the
 * device in its frame, and a floating dock (Home, annotate, save screenshot,
 * record, rotate, shut down, detach) with shortcut tooltips. Touches go to
 * serve-sim as frames over /ws; behaviour follows dsh-ios's React sim-panel.
 * @module ios-simulator/panel/client/main
 */

import { Annotator } from './annotate-ui.js'
import { copyFor, type DeviceActionId } from './copy.js'
import { icon } from './icons.js'
import {
  FALLBACK_BASE,
  FRAME_STYLES,
  SIZE_OPTIONS,
  frameInset,
  framePadding,
  frameStyleOf,
  framebufferPoint,
  orientationLayout,
  screenRadius,
  screenWidthFor,
  sizeModeId,
  sizeModeOf,
  type FrameStyle,
  type SizeMode,
} from './layout.js'
import { closeMenus, Menu, type MenuEntry } from './menu.js'
import {
  nextSimRotateOrientation,
  SIM_ROTATE_ORIENTATIONS,
  normalizePointerPoint,
  parseSimConfigFrame,
  simButtonFrame,
  simRotateFrame,
  simTouchFrame,
  type SimPoint,
} from './protocol.js'

const copy = copyFor(navigator.language)
const RECONNECT_DELAYS_MS = [1000, 2000, 5000]
/** Device-menu actions besides lock/unlock (which the dock and menu show separately). */
const SIMULATOR_ACTIONS: readonly DeviceActionId[] = ['app-switcher', 'shake', 'siri', 'action-button', 're-center']
const IS_MAC = /Mac|iPhone|iPad/u.test(navigator.platform)
/** A shortcut label in the platform's notation: ⇧⌘H on a Mac, Shift+Ctrl+H elsewhere. */
function keys(shift: boolean, key: string): string {
  return IS_MAC ? `${shift ? '⇧' : ''}⌘${key}` : `${shift ? 'Shift+' : ''}Ctrl+${key}`
}
const SHORTCUTS = {
  home: keys(true, 'H'),
  screenshot: keys(false, 'S'),
  record: keys(false, 'R'),
  rotateRight: keys(false, '→'),
  rotateLeft: keys(false, '←'),
  keyboard: keys(false, 'K'),
}
const ICONS = {
  home: icon('home'),
  screenshot: icon('camera'),
  record: icon('video'),
  recording: icon('stop'),
  rotate: icon('rotate'),
  power: icon('power'),
  // log-out turned half a turn: the box on the left, the arrow leaving it to the right.
  detach: icon('detach', 20, 180),
  fullscreen: icon('fullscreen'),
  chevron: `<span class="chevron">${icon('chevronDown', 16)}</span>`,
}

function element<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id)
  if (node === null) throw new Error(`panel markup is missing #${id}`)
  return node as T
}

const ui = {
  status: element<HTMLSpanElement>('status'),
  fullscreen: element<HTMLButtonElement>('btn-fullscreen'),
  devicesButton: element<HTMLButtonElement>('menu-devices'),
  deviceName: element<HTMLSpanElement>('device-name'),
  deviceRuntime: element<HTMLSpanElement>('device-runtime'),
  deviceMenuButton: element<HTMLButtonElement>('menu-device'),
  debugMenuButton: element<HTMLButtonElement>('menu-debug'),
  stage: element<HTMLElement>('stage'),
  frame: element<HTMLDivElement>('frame'),
  screen: element<HTMLDivElement>('screen'),
  img: element<HTMLImageElement>('stream'),
  placeholder: element<HTMLParagraphElement>('placeholder'),
  toast: element<HTMLParagraphElement>('toast'),
  home: element<HTMLButtonElement>('btn-home'),
  annotate: element<HTMLButtonElement>('btn-annotate'),
  shot: element<HTMLButtonElement>('btn-screenshot'),
  record: element<HTMLButtonElement>('btn-record'),
  rotate: element<HTMLButtonElement>('btn-rotate'),
  shutdown: element<HTMLButtonElement>('btn-shutdown'),
  detach: element<HTMLButtonElement>('btn-detach'),
}

interface DeviceRow {
  udid: string
  name: string
  runtime: string
  state: string
}

interface PanelState {
  /** What the panel shows: a simulator (serve-sim) or a real device (WebDriverAgent). */
  kind: 'simulator' | 'real'
  /**
   * Layout orientation. A simulator streams its portrait framebuffer, rotated
   * here; WebDriverAgent frames are already upright, so a real device stays
   * 'portrait' and its own orientation is tracked in realOrientation.
   */
  orientation: string
  realOrientation: string
  sizeMode: SizeMode
  frameStyle: FrameStyle
  device: string | undefined
  deviceName: string
  recording: boolean
  devices: DeviceRow[]
  realDevices: Array<{ udid: string; name: string }>
  ws: WebSocket | undefined
  streamFailures: number
  dragging: boolean
  pendingMove: SimPoint | undefined
  moveScheduled: boolean
}

function stored(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function store(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Private windows: the setting just does not persist.
  }
}

const state: PanelState = {
  kind: 'simulator',
  orientation: 'portrait',
  realOrientation: 'portrait',
  sizeMode: sizeModeOf(stored('ios-sim.size')),
  frameStyle: frameStyleOf(stored('ios-sim.frame')),
  device: undefined,
  deviceName: '',
  recording: false,
  devices: [],
  realDevices: [],
  ws: undefined,
  streamFailures: 0,
  dragging: false,
  pendingMove: undefined,
  moveScheduled: false,
}

function setStatus(kind: 'connecting' | 'live' | 'offline', message?: string): void {
  ui.status.dataset.kind = kind
  ui.status.textContent = message ?? (kind === 'live' ? copy.live : kind === 'connecting' ? copy.connecting : copy.offline)
  ui.status.title = ui.status.textContent
}

function report(prefix: string, error: unknown): void {
  notify(`${prefix}: ${error instanceof Error ? error.message : String(error)}`, 'error')
}

let toastTimer: number | undefined

function notify(message: string, kind: 'ok' | 'error'): void {
  window.clearTimeout(toastTimer)
  ui.toast.textContent = message
  ui.toast.dataset.kind = kind
  ui.toast.hidden = false
  toastTimer = window.setTimeout(() => { ui.toast.hidden = true }, kind === 'ok' ? 5000 : 8000)
}

// ── layout ────────────────────────────────────────────────────────────────────

function applyLayout(): void {
  const baseW = ui.img.naturalWidth > 0 ? ui.img.naturalWidth : FALLBACK_BASE.width
  const baseH = ui.img.naturalHeight > 0 ? ui.img.naturalHeight : FALLBACK_BASE.height
  const layout = orientationLayout(state.orientation, baseW, baseH)
  const stage = ui.stage.getBoundingClientRect()
  const style = getComputedStyle(ui.stage)
  const room = {
    width: stage.width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
    height: stage.height - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom),
  }
  const width = screenWidthFor(state.sizeMode, layout, room, state.frameStyle)
  const height = Math.round(width * layout.displayH / layout.displayW)
  const scale = width / layout.displayW
  ui.screen.style.width = `${width}px`
  ui.screen.style.height = `${height}px`
  ui.img.style.width = `${Math.round(baseW * scale)}px`
  ui.img.style.height = `${Math.round(baseH * scale)}px`
  ui.img.style.transform = `translate(-50%, -50%) rotate(${layout.rotationDeg}deg)`
  const radius = screenRadius(width, height)
  ui.screen.style.borderRadius = `${radius}px`
  ui.frame.dataset.style = state.frameStyle
  ui.frame.dataset.landscape = String(width > height)
  ui.frame.style.padding = `${framePadding(state.frameStyle)}px`
  ui.frame.style.borderRadius = state.frameStyle === 'none' ? '0' : `${radius + frameInset(state.frameStyle)}px`
}

// ── live stream ───────────────────────────────────────────────────────────────

let reconnectTimer: number | undefined
let frameWatch: number | undefined

function onLive(): void {
  window.clearInterval(frameWatch)
  state.streamFailures = 0
  ui.placeholder.hidden = true
  setStatus('live')
  applyLayout()
}

function startStream(): void {
  window.clearTimeout(reconnectTimer)
  window.clearInterval(frameWatch)
  setStatus('connecting')
  ui.img.src = `/stream?t=${Date.now()}`
  // A multipart MJPEG body may never fire `load`; the first decoded frame sets naturalWidth.
  frameWatch = window.setInterval(() => {
    if (ui.img.naturalWidth > 0) onLive()
  }, 300)
}

ui.img.addEventListener('load', onLive)
ui.img.addEventListener('error', () => {
  window.clearInterval(frameWatch)
  const delay = RECONNECT_DELAYS_MS[Math.min(state.streamFailures, RECONNECT_DELAYS_MS.length - 1)] ?? 5000
  state.streamFailures += 1
  setStatus('offline')
  ui.placeholder.hidden = false
  ui.placeholder.textContent = state.kind === 'real' ? copy.noWda : copy.noDevice
  reconnectTimer = window.setTimeout(() => { void refreshStatus().finally(startStream) }, delay)
})

function reconnect(): void {
  state.streamFailures = 0
  // The control socket is bound to the device shown when it opened.
  state.ws?.close()
  startStream()
}

// ── control socket ────────────────────────────────────────────────────────────

function connectWs(): void {
  const ws = new WebSocket(`ws://${location.host}/ws`)
  ws.binaryType = 'arraybuffer'
  state.ws = ws
  ws.addEventListener('message', event => {
    if (state.kind === 'real') return
    const config = parseSimConfigFrame(event.data)
    if (config === undefined || config.orientation === state.orientation) return
    state.orientation = config.orientation
    applyLayout()
  })
  ws.addEventListener('close', () => {
    if (state.ws === ws) state.ws = undefined
    window.setTimeout(connectWs, 2000)
  })
}

function send(frame: Uint8Array): void {
  const ws = state.ws
  if (ws !== undefined && ws.readyState === WebSocket.OPEN) ws.send(new Uint8Array(frame))
}

// ── touch ─────────────────────────────────────────────────────────────────────

function pointerPoint(event: PointerEvent): SimPoint {
  return framebufferPoint(state.orientation, normalizePointerPoint(event, ui.screen.getBoundingClientRect()))
}

ui.screen.addEventListener('pointerdown', event => {
  if (event.button !== 0) return
  event.preventDefault()
  ui.screen.setPointerCapture(event.pointerId)
  state.dragging = true
  const point = pointerPoint(event)
  send(simTouchFrame('begin', point.x, point.y))
})

ui.screen.addEventListener('pointermove', event => {
  if (!state.dragging) return
  state.pendingMove = pointerPoint(event)
  if (state.moveScheduled) return
  state.moveScheduled = true
  requestAnimationFrame(() => {
    state.moveScheduled = false
    const point = state.pendingMove
    if (point !== undefined && state.dragging) send(simTouchFrame('move', point.x, point.y))
  })
})

function endTouch(event: PointerEvent): void {
  if (!state.dragging) return
  state.dragging = false
  const point = pointerPoint(event)
  send(simTouchFrame('end', point.x, point.y))
}
ui.screen.addEventListener('pointerup', endTouch)
ui.screen.addEventListener('pointercancel', endTouch)

// ── actions ───────────────────────────────────────────────────────────────────

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const value = await response.json().catch(() => ({})) as { error?: string }
  if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`)
  return value as T
}

function deviceAction(action: DeviceActionId): void {
  void postJson('/api/device-action', { action }).catch(error => report(copy.actionFailed, error))
}

function pressHome(): void {
  send(simButtonFrame('home'))
}

/** Rotate by a quarter turn; a simulator also re-lays out its rotated stream here. */
function rotate(direction: 1 | -1): void {
  const order = SIM_ROTATE_ORIENTATIONS as readonly string[]
  const turn = (current: string): string => {
    if (direction === 1) return nextSimRotateOrientation(current)
    const index = order.indexOf(current)
    return order[((index < 0 ? 0 : index) + order.length - 1) % order.length] ?? 'portrait'
  }
  if (state.kind === 'real') {
    state.realOrientation = turn(state.realOrientation)
    send(simRotateFrame(state.realOrientation))
    return
  }
  state.orientation = turn(state.orientation)
  send(simRotateFrame(state.orientation))
  applyLayout()
}

/** Save a full-resolution screenshot as a download, named like Simulator's own. */
async function saveScreenshot(): Promise<void> {
  const { url } = await postJson<{ url: string }>('/api/capture', {})
  const blob = await (await fetch(url)).blob()
  const link = document.createElement('a')
  const stamp = new Date().toISOString().replace(/[:T]/gu, '.').replace(/\.\d+Z$/u, '')
  link.href = URL.createObjectURL(blob)
  link.download = `Simulator Screenshot - ${state.deviceName || 'device'} - ${stamp}.png`
  document.body.append(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(link.href), 10_000)
  notify(copy.screenshotSaved, 'ok')
}

async function toggleRecording(): Promise<void> {
  const result = await postJson<{ recording: boolean; path?: string }>('/api/record', { action: state.recording ? 'stop' : 'start' })
  state.recording = result.recording
  renderDock()
  if (!result.recording && result.path !== undefined) notify(`${copy.recordingSaved} ${result.path}`, 'ok')
}

async function shutdown(): Promise<void> {
  await postJson('/api/shutdown', {})
  state.recording = false
  await refreshStatus()
  reconnect()
}

async function detach(): Promise<void> {
  await postJson('/api/detach', {})
  await refreshStatus()
  reconnect()
}

const annotator = new Annotator({
  screen: ui.screen,
  copy,
  capture: () => postJson<{ url: string }>('/api/capture', {}),
  save: async image => { await postJson('/api/annotations', { image }) },
  notify,
})

function toggleAnnotate(): void {
  if (annotator.isOpen) annotator.close()
  else void annotator.open().catch(error => report(copy.captureFailed, error))
}

// ── dock ──────────────────────────────────────────────────────────────────────

/** An icon button with a tooltip above it: the label and, when there is one, its shortcut. */
function dockButton(button: HTMLButtonElement, icon: string, label: string, shortcut?: string): void {
  button.innerHTML = `${icon}<span class="tip" role="tooltip">${label}${shortcut === undefined ? '' : `<kbd>${shortcut}</kbd>`}</span>`
  button.setAttribute('aria-label', label)
  if (shortcut !== undefined) button.setAttribute('aria-keyshortcuts', shortcut)
}

function renderDock(): void {
  const simulator = state.kind === 'simulator'
  dockButton(ui.home, ICONS.home, copy.home, SHORTCUTS.home)
  dockButton(ui.annotate, icon('pencil'), copy.annotate)
  dockButton(ui.shot, ICONS.screenshot, copy.saveScreenshot, SHORTCUTS.screenshot)
  dockButton(ui.record, state.recording ? ICONS.recording : ICONS.record, simulator ? (state.recording ? copy.stopRecording : copy.recordVideo) : copy.simulatorOnly, SHORTCUTS.record)
  dockButton(ui.rotate, ICONS.rotate, copy.rotateRight, SHORTCUTS.rotateRight)
  dockButton(ui.shutdown, ICONS.power, simulator ? copy.shutdown : copy.simulatorOnly)
  dockButton(ui.detach, ICONS.detach, copy.detach)
  ui.record.classList.toggle('recording', state.recording)
  ui.record.disabled = !simulator
  ui.shutdown.disabled = !simulator
}

ui.home.addEventListener('click', pressHome)
ui.home.addEventListener('dblclick', () => deviceAction('app-switcher'))
ui.annotate.addEventListener('click', toggleAnnotate)
ui.shot.addEventListener('click', () => { void saveScreenshot().catch(error => report(copy.captureFailed, error)) })
ui.record.addEventListener('click', () => { void toggleRecording().catch(error => report(copy.actionFailed, error)) })
ui.rotate.addEventListener('click', () => rotate(1))
ui.shutdown.addEventListener('click', () => { void shutdown().catch(error => report(copy.actionFailed, error)) })
ui.detach.addEventListener('click', () => { void detach().catch(error => report(copy.actionFailed, error)) })
ui.fullscreen.addEventListener('click', () => {
  if (document.fullscreenElement === null) void document.documentElement.requestFullscreen().catch(() => undefined)
  else void document.exitFullscreen()
})

document.addEventListener('keydown', event => {
  if (annotator.isOpen || !(event.metaKey || event.ctrlKey) || event.altKey) return
  const target = event.target as HTMLElement | null
  if (target !== null && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/u.test(target.tagName))) return
  const key = event.key.toLowerCase()
  const run = (action: () => void): void => {
    event.preventDefault()
    closeMenus()
    action()
  }
  if (event.shiftKey && key === 'h') run(pressHome)
  else if (!event.shiftKey && key === 's') run(() => { void saveScreenshot().catch(error => report(copy.captureFailed, error)) })
  else if (!event.shiftKey && key === 'r' && state.kind === 'simulator') run(() => { void toggleRecording().catch(error => report(copy.actionFailed, error)) })
  else if (!event.shiftKey && key === 'arrowright') run(() => rotate(1))
  else if (!event.shiftKey && key === 'arrowleft') run(() => rotate(-1))
  else if (!event.shiftKey && key === 'k' && state.kind === 'simulator') run(() => deviceAction('toggle-keyboard'))
})

// ── menus ─────────────────────────────────────────────────────────────────────

function runtimeLabel(runtime: string): string {
  const match = /SimRuntime\.([A-Za-z]+)-(\d+)-(\d+)/u.exec(runtime)
  return match === null ? runtime : `${match[1] ?? ''} ${match[2] ?? ''}.${match[3] ?? ''}`
}

function switchTo(udid: string): void {
  setStatus('connecting', copy.switching)
  void postJson('/api/switch-device', { udid })
    .then(() => refreshStatus())
    .then(reconnect)
    .catch(error => report(copy.actionFailed, error))
}

const devicesMenu = new Menu(ui.devicesButton, () => {
  const entries: MenuEntry[] = []
  const row = (device: DeviceRow): MenuEntry => ({
    label: device.name,
    detail: runtimeLabel(device.runtime),
    checked: device.udid === state.device,
    run: () => switchTo(device.udid),
  })
  const booted = state.devices.filter(device => device.state === 'Booted')
  const others = state.devices.filter(device => device.state !== 'Booted')
  if (booted.length > 0) entries.push({ section: copy.bootedSection, dot: true }, ...booted.map(row))
  if (state.realDevices.length > 0) {
    entries.push({ section: copy.realSection }, ...state.realDevices.map(device => ({
      label: device.name,
      detail: copy.realDevice,
      checked: device.udid === state.device,
      run: () => switchTo(device.udid),
    })))
  }
  if (others.length > 0) entries.push({ section: copy.shutdownSection }, ...others.map(row))
  return entries.length > 0 ? entries : [{ label: copy.noDevice, disabled: true }]
})
// The list is fetched as the menu opens, then shown again with fresh rows.
ui.devicesButton.addEventListener('pointerdown', () => {
  void loadDevices().then(() => { if (devicesMenu.isOpen) devicesMenu.open() })
})

new Menu(ui.deviceMenuButton, () => {
  const rotation: MenuEntry[] = [
    { label: copy.rotateLeft, shortcut: SHORTCUTS.rotateLeft, run: () => rotate(-1) },
    { label: copy.rotateRight, shortcut: SHORTCUTS.rotateRight, run: () => rotate(1) },
  ]
  const lock: MenuEntry[] = [
    { label: copy.actions.lock, run: () => deviceAction('lock') },
    { label: copy.actions.unlock, run: () => deviceAction('unlock') },
    { label: copy.actions.siri, run: () => deviceAction('siri') },
  ]
  if (state.kind === 'real') return [...rotation, { separator: true }, ...lock]
  const appearance = (value: 'light' | 'dark'): void => {
    void postJson('/api/appearance', { appearance: value }).catch(error => report(copy.actionFailed, error))
  }
  return [
    { label: copy.appearance, submenu: () => [
      { label: copy.light, run: () => appearance('light') },
      { label: copy.dark, run: () => appearance('dark') },
    ] },
    { label: copy.keyboard, submenu: () => [
      { label: copy.actions['toggle-keyboard'], shortcut: SHORTCUTS.keyboard, run: () => deviceAction('toggle-keyboard') },
    ] },
    { separator: true },
    ...rotation,
    { separator: true },
    { label: copy.home, shortcut: SHORTCUTS.home, run: pressHome },
    ...SIMULATOR_ACTIONS.filter(id => id !== 'siri').map(id => ({ label: copy.actions[id], run: () => deviceAction(id) })),
    { separator: true },
    ...lock,
  ]
})

new Menu(ui.debugMenuButton, () => [
  ...(state.kind === 'simulator'
    ? [{ label: copy.actions['slow-animations'], run: () => deviceAction('slow-animations') }, { separator: true } as const]
    : []),
  { label: copy.displaySize, submenu: () => SIZE_OPTIONS.map(option => ({
    label: copy.language === 'zh' ? option.zh : option.en,
    checked: sizeModeId(state.sizeMode) === option.id,
    run: () => {
      state.sizeMode = option.mode
      store('ios-sim.size', option.id)
      applyLayout()
    },
  })) },
  { label: copy.frame, submenu: () => FRAME_STYLES.map(style => ({
    label: copy.frameStyles[style],
    checked: state.frameStyle === style,
    run: () => {
      state.frameStyle = style
      store('ios-sim.frame', style)
      applyLayout()
    },
  })) },
  { separator: true },
  { label: copy.reconnect, run: reconnect },
])

// ── devices & status ──────────────────────────────────────────────────────────

async function loadDevices(): Promise<void> {
  const response = await fetch('/api/devices')
  if (!response.ok) return
  const body = await response.json() as { devices: DeviceRow[]; realDevices?: Array<{ udid: string; name: string }>; streaming?: string }
  state.devices = body.devices
  state.realDevices = body.realDevices ?? []
  renderDeviceButton()
}

function renderDeviceButton(): void {
  const row = state.devices.find(device => device.udid === state.device)
  ui.deviceName.textContent = state.deviceName !== '' ? state.deviceName : copy.pickDevice
  ui.deviceRuntime.textContent = state.kind === 'real' ? copy.realDevice : row === undefined ? '' : runtimeLabel(row.runtime)
  ui.devicesButton.insertAdjacentHTML('beforeend', ui.devicesButton.querySelector('.chevron') === null ? ICONS.chevron : '')
}

async function refreshStatus(): Promise<void> {
  const response = await fetch('/api/status')
  if (!response.ok) return
  const status = await response.json() as { kind?: 'simulator' | 'real'; running: boolean; device?: string; deviceName?: string; recording?: boolean }
  state.device = status.device
  state.deviceName = status.deviceName ?? ''
  const kind = status.kind ?? 'simulator'
  const recording = status.recording === true
  if (kind !== state.kind) {
    // Switched by a tool (ios_sim_panel / ios_sim_boot) or another tab: follow it.
    state.kind = kind
    state.orientation = 'portrait'
    state.realOrientation = 'portrait'
    applyLayout()
    reconnect()
  }
  state.recording = recording
  renderDock()
  renderDeviceButton()
  ui.placeholder.textContent = kind === 'real' ? copy.noWda : copy.noDevice
  if (!status.running && ui.status.dataset.kind === 'live') setStatus('offline')
}

// ── start ─────────────────────────────────────────────────────────────────────

function initControls(): void {
  document.title = copy.title
  document.documentElement.lang = copy.language
  ui.deviceMenuButton.innerHTML = `${copy.deviceMenu}${ICONS.chevron}`
  ui.debugMenuButton.innerHTML = `${copy.debugMenu}${ICONS.chevron}`
  ui.devicesButton.title = copy.picker
  ui.fullscreen.innerHTML = ICONS.fullscreen
  ui.fullscreen.title = copy.fullscreen
  ui.fullscreen.setAttribute('aria-label', copy.fullscreen)
  renderDock()
  renderDeviceButton()
}

initControls()
new ResizeObserver(() => applyLayout()).observe(ui.stage)
applyLayout()
void loadDevices()
void refreshStatus().finally(startStream)
connectWs()
window.setInterval(() => { void refreshStatus() }, 5000)
