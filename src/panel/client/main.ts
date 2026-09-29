/**
 * Browser entry for the live panel: the MJPEG <img>, pointer → serve-sim
 * touch frames over /ws, the toolbar, the device picker and the size/frame
 * controls. Behaviour follows dsh-ios's React sim-panel in plain DOM code.
 * @module ios-simulator/panel/client/main
 */

import { copyFor, type DeviceActionId } from './copy.js'
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
import {
  nextSimRotateOrientation,
  normalizePointerPoint,
  parseSimConfigFrame,
  simButtonFrame,
  simRotateFrame,
  simTouchFrame,
  type SimPoint,
} from './protocol.js'

const copy = copyFor(navigator.language)
const RECONNECT_DELAYS_MS = [1000, 2000, 5000]
const DEVICE_ACTION_IDS: readonly DeviceActionId[] = ['app-switcher', 'lock', 'unlock', 'shake', 'siri', 'action-button', 're-center']
const SVG_ATTRS = 'viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"'
const ICONS = {
  home: `<svg ${SVG_ATTRS}><path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/></svg>`,
  screenshot: `<svg ${SVG_ATTRS}><path d="M4 7h3l2-3h6l2 3h3v13H4z"/><circle cx="12" cy="13" r="4"/></svg>`,
  rotate: `<svg ${SVG_ATTRS}><path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v6h-6"/></svg>`,
  refresh: `<svg ${SVG_ATTRS}><path d="M3 12a9 9 0 0 1 15.5-6.3L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15.5 6.3L3 16"/><path d="M3 21v-5h5"/></svg>`,
}

function element<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id)
  if (node === null) throw new Error(`panel markup is missing #${id}`)
  return node as T
}

const ui = {
  picker: element<HTMLSelectElement>('device-picker'),
  status: element<HTMLSpanElement>('status'),
  home: element<HTMLButtonElement>('btn-home'),
  shot: element<HTMLButtonElement>('btn-screenshot'),
  rotate: element<HTMLButtonElement>('btn-rotate'),
  action: element<HTMLSelectElement>('device-action'),
  refresh: element<HTMLButtonElement>('btn-refresh'),
  size: element<HTMLSelectElement>('size-mode'),
  frameStyle: element<HTMLSelectElement>('frame-style'),
  stage: element<HTMLElement>('stage'),
  frame: element<HTMLDivElement>('frame'),
  screen: element<HTMLDivElement>('screen'),
  img: element<HTMLImageElement>('stream'),
  placeholder: element<HTMLParagraphElement>('placeholder'),
}

interface PanelState {
  orientation: string
  sizeMode: SizeMode
  frameStyle: FrameStyle
  deviceName: string
  ws: WebSocket | undefined
  streamFailures: number
  dragging: boolean
  pendingMove: SimPoint | undefined
  moveScheduled: boolean
}

const state: PanelState = {
  orientation: 'portrait',
  sizeMode: sizeModeOf(localStorage.getItem('ios-sim.size')),
  frameStyle: frameStyleOf(localStorage.getItem('ios-sim.frame')),
  deviceName: '',
  ws: undefined,
  streamFailures: 0,
  dragging: false,
  pendingMove: undefined,
  moveScheduled: false,
}

function setStatus(kind: 'connecting' | 'live' | 'offline', message?: string): void {
  ui.status.dataset.kind = kind
  const label = message ?? (kind === 'live' ? copy.live : kind === 'connecting' ? copy.connecting : copy.offline)
  ui.status.textContent = state.deviceName === '' ? label : `${state.deviceName} · ${label}`
}

function report(prefix: string, error: unknown): void {
  setStatus('offline', `${prefix}: ${error instanceof Error ? error.message : String(error)}`)
}

// ── layout ────────────────────────────────────────────────────────────────────

function applyLayout(): void {
  const baseW = ui.img.naturalWidth > 0 ? ui.img.naturalWidth : FALLBACK_BASE.width
  const baseH = ui.img.naturalHeight > 0 ? ui.img.naturalHeight : FALLBACK_BASE.height
  const layout = orientationLayout(state.orientation, baseW, baseH)
  const stage = ui.stage.getBoundingClientRect()
  const width = screenWidthFor(state.sizeMode, layout, { width: stage.width - 32, height: stage.height - 32 }, state.frameStyle)
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
  ui.placeholder.textContent = copy.noDevice
  reconnectTimer = window.setTimeout(() => { void refreshStatus().finally(startStream) }, delay)
})

// ── control socket ────────────────────────────────────────────────────────────

function connectWs(): void {
  const ws = new WebSocket(`ws://${location.host}/ws`)
  ws.binaryType = 'arraybuffer'
  state.ws = ws
  ws.addEventListener('message', event => {
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

// ── toolbar ───────────────────────────────────────────────────────────────────

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

ui.home.addEventListener('click', () => send(simButtonFrame('home')))
ui.home.addEventListener('dblclick', () => {
  void postJson('/api/device-action', { action: 'app-switcher' }).catch(error => report(copy.actionFailed, error))
})
ui.shot.addEventListener('click', () => {
  void postJson<{ url: string }>('/api/capture', {})
    .then(({ url }) => { window.open(url, '_blank', 'noopener') })
    .catch(error => report(copy.captureFailed, error))
})
ui.rotate.addEventListener('click', () => {
  const next = nextSimRotateOrientation(state.orientation)
  send(simRotateFrame(next))
  state.orientation = next
  applyLayout()
})
ui.action.addEventListener('change', () => {
  const action = ui.action.value
  ui.action.value = ''
  if (action !== '') void postJson('/api/device-action', { action }).catch(error => report(copy.actionFailed, error))
})
ui.refresh.addEventListener('click', () => {
  state.streamFailures = 0
  startStream()
})
ui.size.addEventListener('change', () => {
  state.sizeMode = sizeModeOf(ui.size.value)
  localStorage.setItem('ios-sim.size', ui.size.value)
  applyLayout()
})
ui.frameStyle.addEventListener('change', () => {
  state.frameStyle = frameStyleOf(ui.frameStyle.value)
  localStorage.setItem('ios-sim.frame', state.frameStyle)
  applyLayout()
})
ui.picker.addEventListener('focus', () => { void loadDevices() })
ui.picker.addEventListener('change', () => {
  setStatus('connecting', copy.switching)
  void postJson('/api/switch-device', { udid: ui.picker.value })
    .then(() => refreshStatus())
    .then(startStream)
    .catch(error => report(copy.actionFailed, error))
})

// ── devices & status ──────────────────────────────────────────────────────────

interface DeviceRow {
  udid: string
  name: string
  runtime: string
  state: string
}

function runtimeLabel(runtime: string): string {
  const match = /SimRuntime\.([A-Za-z]+)-(\d+)-(\d+)/u.exec(runtime)
  return match === null ? runtime : `${match[1] ?? ''} ${match[2] ?? ''}.${match[3] ?? ''}`
}

function option(value: string, label: string): HTMLOptionElement {
  const node = document.createElement('option')
  node.value = value
  node.textContent = label
  return node
}

async function loadDevices(): Promise<void> {
  const response = await fetch('/api/devices')
  if (!response.ok) return
  const { devices, streaming } = await response.json() as { devices: DeviceRow[]; streaming?: string }
  const rows = devices.map(device => {
    const node = option(device.udid, `${device.name} · ${runtimeLabel(device.runtime)}${device.state === 'Booted' ? ` · ${copy.booted}` : ''}`)
    node.selected = device.udid === streaming
    return node
  })
  if (!devices.some(device => device.udid === streaming)) {
    // With no row selected the browser shows the first device, and picking it fires no
    // `change`: a selected, disabled placeholder makes every device a real choice.
    const placeholder = option('', copy.pickDevice)
    placeholder.disabled = true
    placeholder.selected = true
    rows.unshift(placeholder)
  }
  ui.picker.replaceChildren(...rows)
}

async function refreshStatus(): Promise<void> {
  const response = await fetch('/api/status')
  if (!response.ok) return
  const status = await response.json() as { running: boolean; deviceName?: string }
  state.deviceName = status.deviceName ?? ''
  if (!status.running && ui.status.dataset.kind === 'live') setStatus('offline')
}

// ── start ─────────────────────────────────────────────────────────────────────

function initControls(): void {
  document.title = copy.title
  document.documentElement.lang = copy.language
  const buttons: Array<[HTMLButtonElement, string, string]> = [
    [ui.home, ICONS.home, copy.homeHint],
    [ui.shot, ICONS.screenshot, copy.screenshot],
    [ui.rotate, ICONS.rotate, copy.rotate],
    [ui.refresh, ICONS.refresh, copy.refresh],
  ]
  for (const [button, icon, label] of buttons) {
    button.innerHTML = icon
    button.title = label
    button.setAttribute('aria-label', label)
  }
  ui.action.replaceChildren(option('', copy.deviceActions), ...DEVICE_ACTION_IDS.map(id => option(id, copy.actions[id])))
  ui.size.replaceChildren(...SIZE_OPTIONS.map(entry => option(entry.id, copy.language === 'zh' ? entry.zh : entry.en)))
  ui.size.value = sizeModeId(state.sizeMode)
  ui.frameStyle.replaceChildren(...FRAME_STYLES.map(style => option(style, copy.frameStyles[style])))
  ui.frameStyle.value = state.frameStyle
  ui.size.title = copy.size
  ui.frameStyle.title = copy.frame
  ui.picker.title = copy.picker
}

initControls()
new ResizeObserver(() => applyLayout()).observe(ui.stage)
applyLayout()
void loadDevices()
void refreshStatus().finally(startStream)
connectWs()
window.setInterval(() => { void refreshStatus() }, 5000)
