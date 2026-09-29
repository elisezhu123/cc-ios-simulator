// Ported from dsh-ios (MIT, © 2026 ZSeven—W) @ d9a9731 — src/client/sim-orientation.ts, sim-panel-size.ts, sim-frame-style.ts
/**
 * Pure panel layout math (no DOM): orientation counter-rotation and the
 * pointer inverse mapping (ported from dsh-ios src/client/sim-orientation.ts,
 * verified live against serve-sim), plus size modes and frame styles after
 * sim-panel-size.ts / sim-frame-style.ts.
 * @module ios-simulator/panel/client/layout
 */

import type { SimPoint } from './protocol.js'

/** Logical points per framebuffer pixel assumed for percent sizes (@3x phones). */
export const DEVICE_SCALE = 3
/** Framebuffer size assumed until the first frame arrives (390×844 pt @3x). */
export const FALLBACK_BASE = { width: 1170, height: 2532 } as const

export type SizeMode =
  | { kind: 'fit' }
  | { kind: 'percent'; value: number }
  | { kind: 'preset'; width: number }

export type FrameStyle = 'none' | 'bezel' | 'device'

export interface OrientationLayout {
  /** CSS rotation for the stream img (degrees, positive = clockwise). */
  rotationDeg: number
  /** Width of the displayed (rotated) box, in framebuffer pixels. */
  displayW: number
  displayH: number
}

export const SIZE_OPTIONS: ReadonlyArray<{ id: string; mode: SizeMode; en: string; zh: string }> = [
  { id: 'fit', mode: { kind: 'fit' }, en: 'Fit', zh: '适应' },
  ...[50, 75, 100, 125].map(value => ({ id: `percent-${value}`, mode: { kind: 'percent', value } as SizeMode, en: `${value}%`, zh: `${value}%` })),
  { id: 'preset-S', mode: { kind: 'preset', width: 240 }, en: 'S · 240px', zh: 'S（240px）' },
  { id: 'preset-M', mode: { kind: 'preset', width: 320 }, en: 'M · 320px', zh: 'M（320px）' },
  { id: 'preset-L', mode: { kind: 'preset', width: 420 }, en: 'L · 420px', zh: 'L（420px）' },
]

export const FRAME_STYLES: readonly FrameStyle[] = ['none', 'bezel', 'device']

export function sizeModeOf(id: string | null | undefined): SizeMode {
  return SIZE_OPTIONS.find(option => option.id === id)?.mode ?? { kind: 'fit' }
}

export function sizeModeId(mode: SizeMode): string {
  const key = JSON.stringify(mode)
  return SIZE_OPTIONS.find(option => JSON.stringify(option.mode) === key)?.id ?? 'fit'
}

export function frameStyleOf(id: string | null | undefined): FrameStyle {
  return (FRAME_STYLES as readonly string[]).includes(id ?? '') ? (id as FrameStyle) : 'bezel'
}

/** The CSS rotation and displayed box for one serve-sim orientation. */
export function orientationLayout(orientation: string | undefined, baseW: number, baseH: number): OrientationLayout {
  switch (orientation) {
    case 'landscape_left':
      return { rotationDeg: 90, displayW: baseH, displayH: baseW }
    case 'landscape_right':
      return { rotationDeg: -90, displayW: baseH, displayH: baseW }
    case 'portrait_upside_down':
      return { rotationDeg: 180, displayW: baseW, displayH: baseH }
    default:
      return { rotationDeg: 0, displayW: baseW, displayH: baseH }
  }
}

/**
 * Inverse of the CSS counter-rotation: a point normalized to the DISPLAYED
 * box → framebuffer-normalized coordinates for serve-sim touch frames.
 */
export function framebufferPoint(orientation: string | undefined, displayed: SimPoint): SimPoint {
  switch (orientation) {
    case 'landscape_left':
      return { x: displayed.y, y: 1 - displayed.x }
    case 'landscape_right':
      return { x: 1 - displayed.y, y: displayed.x }
    case 'portrait_upside_down':
      return { x: 1 - displayed.x, y: 1 - displayed.y }
    default:
      return { x: displayed.x, y: displayed.y }
  }
}

/** Shell padding per frame style (none 0, bezel 6, device 16). */
export function framePadding(style: FrameStyle): number {
  return style === 'none' ? 0 : style === 'bezel' ? 6 : 16
}

/** Padding plus the 1 px border of the bordered styles. */
export function frameInset(style: FrameStyle): number {
  return style === 'none' ? 0 : framePadding(style) + 1
}

/** The displayed screen width in CSS px for one size mode. */
export function screenWidthFor(
  mode: SizeMode,
  layout: OrientationLayout,
  stage: { width: number; height: number },
  style: FrameStyle,
): number {
  const aspect = layout.displayW / layout.displayH
  switch (mode.kind) {
    case 'fit': {
      const inset = 2 * frameInset(style)
      const maxW = Math.max(0, stage.width - inset)
      const maxH = Math.max(0, stage.height - inset)
      return Math.max(1, Math.floor(Math.min(maxW, maxH * aspect)))
    }
    case 'percent':
      return Math.max(1, Math.round((layout.displayW / DEVICE_SCALE) * mode.value / 100))
    case 'preset':
      // Presets size the SHORT side, so a landscape device keeps its physical size.
      return Math.max(1, Math.round(aspect > 1 ? mode.width * aspect : mode.width))
  }
}

/** Screen corner radius proportional to the short side (55 pt at 390 pt). */
export function screenRadius(width: number, height: number): number {
  return Math.round(Math.min(width, height) * 55 / 390)
}
