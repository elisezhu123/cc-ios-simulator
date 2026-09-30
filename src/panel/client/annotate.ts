/**
 * Screenshot annotation for the live panel: the shapes (pen, line, arrow,
 * box, ellipse, text), their undo/redo history, and the drawing code shared by
 * the on-screen canvas and the full-resolution export. Shapes live in IMAGE
 * pixels, so the export draws them at scale 1 and the screen at its own scale.
 * @module ios-simulator/panel/client/annotate
 */

export const ANNOTATE_TOOLS = ['pen', 'line', 'arrow', 'rect', 'ellipse', 'text'] as const
export type AnnotateTool = typeof ANNOTATE_TOOLS[number]

/** Red, blue, green, black, white. */
export const ANNOTATE_COLORS = ['#e5484d', '#3b82f6', '#46a758', '#1d1d1f', '#ffffff'] as const

export interface Point {
  x: number
  y: number
}

export type Shape =
  | { kind: 'pen'; color: string; width: number; points: Point[] }
  | { kind: 'line' | 'arrow' | 'rect' | 'ellipse'; color: string; width: number; from: Point; to: Point }
  | { kind: 'text'; color: string; size: number; at: Point; text: string }

/** Stroke width and text size for an image, so marks read the same on any screenshot size. */
export function markSizes(image: { width: number; height: number }): { stroke: number; text: number } {
  const longEdge = Math.max(image.width, image.height, 1)
  return { stroke: Math.max(2, Math.round(longEdge * 0.005)), text: Math.max(12, Math.round(longEdge * 0.022)) }
}

/** The shapes plus an undo/redo history; every change (clear included) can be undone. */
export class AnnotationDoc {
  #shapes: Shape[] = []
  #past: Shape[][] = []
  #future: Shape[][] = []

  get shapes(): readonly Shape[] {
    return this.#shapes
  }

  get canUndo(): boolean {
    return this.#past.length > 0
  }

  get canRedo(): boolean {
    return this.#future.length > 0
  }

  add(shape: Shape): void {
    this.#commit([...this.#shapes, shape])
  }

  clear(): void {
    if (this.#shapes.length > 0) this.#commit([])
  }

  undo(): void {
    const previous = this.#past.pop()
    if (previous === undefined) return
    this.#future.push(this.#shapes)
    this.#shapes = previous
  }

  redo(): void {
    const next = this.#future.pop()
    if (next === undefined) return
    this.#past.push(this.#shapes)
    this.#shapes = next
  }

  #commit(shapes: Shape[]): void {
    this.#past.push(this.#shapes)
    this.#future = []
    this.#shapes = shapes
  }
}

/** A shape being dragged out from `from` to `to` with the current tool (never text). */
export function shapeFor(tool: Exclude<AnnotateTool, 'text'>, color: string, width: number, from: Point, to: Point, points: Point[] = [from, to]): Shape {
  return tool === 'pen' ? { kind: 'pen', color, width, points } : { kind: tool, color, width, from, to }
}

/** Whether a finished drag is too small to keep (a click with a shape tool). */
export function isNegligible(shape: Shape, minimum: number): boolean {
  if (shape.kind === 'text') return shape.text.trim() === ''
  if (shape.kind === 'pen') return shape.points.length < 2
  return Math.hypot(shape.to.x - shape.from.x, shape.to.y - shape.from.y) < minimum
}

/** The two barb ends of an arrow head at `to`. */
export function arrowHead(from: Point, to: Point, length: number): [Point, Point] {
  const angle = Math.atan2(to.y - from.y, to.x - from.x)
  const spread = Math.PI / 7
  return [
    { x: to.x - length * Math.cos(angle - spread), y: to.y - length * Math.sin(angle - spread) },
    { x: to.x - length * Math.cos(angle + spread), y: to.y - length * Math.sin(angle + spread) },
  ]
}

/** The subset of CanvasRenderingContext2D the drawing code uses (tests pass a recorder). */
export interface DrawContext {
  strokeStyle: string | CanvasGradient | CanvasPattern
  fillStyle: string | CanvasGradient | CanvasPattern
  lineWidth: number
  lineCap: CanvasLineCap
  lineJoin: CanvasLineJoin
  font: string
  textBaseline: CanvasTextBaseline
  save(): void
  restore(): void
  beginPath(): void
  moveTo(x: number, y: number): void
  lineTo(x: number, y: number): void
  stroke(): void
  strokeRect(x: number, y: number, width: number, height: number): void
  ellipse(x: number, y: number, radiusX: number, radiusY: number, rotation: number, startAngle: number, endAngle: number): void
  strokeText(text: string, x: number, y: number): void
  fillText(text: string, x: number, y: number): void
}

const FONT_FAMILY = '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif'

/** Draw `shapes` (image pixels) at `scale` screen pixels per image pixel. */
export function drawShapes(ctx: DrawContext, shapes: readonly Shape[], scale: number): void {
  for (const shape of shapes) {
    ctx.save()
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    if (shape.kind === 'text') {
      const size = shape.size * scale
      ctx.font = `600 ${size}px ${FONT_FAMILY}`
      ctx.textBaseline = 'top'
      // A contrasting outline keeps the text readable on any background.
      ctx.lineWidth = Math.max(2, size * 0.16)
      ctx.strokeStyle = shape.color === '#ffffff' ? 'rgba(0,0,0,0.75)' : 'rgba(255,255,255,0.9)'
      ctx.fillStyle = shape.color
      let y = shape.at.y * scale
      for (const line of shape.text.split('\n')) {
        ctx.strokeText(line, shape.at.x * scale, y)
        ctx.fillText(line, shape.at.x * scale, y)
        y += size * 1.2
      }
      ctx.restore()
      continue
    }
    ctx.strokeStyle = shape.color
    ctx.lineWidth = shape.width * scale
    ctx.beginPath()
    if (shape.kind === 'pen') {
      const [first, ...rest] = shape.points
      if (first !== undefined) {
        ctx.moveTo(first.x * scale, first.y * scale)
        for (const point of rest) ctx.lineTo(point.x * scale, point.y * scale)
      }
      ctx.stroke()
    } else if (shape.kind === 'rect') {
      ctx.strokeRect(
        Math.min(shape.from.x, shape.to.x) * scale,
        Math.min(shape.from.y, shape.to.y) * scale,
        Math.abs(shape.to.x - shape.from.x) * scale,
        Math.abs(shape.to.y - shape.from.y) * scale,
      )
    } else if (shape.kind === 'ellipse') {
      ctx.ellipse(
        (shape.from.x + shape.to.x) / 2 * scale,
        (shape.from.y + shape.to.y) / 2 * scale,
        Math.abs(shape.to.x - shape.from.x) / 2 * scale,
        Math.abs(shape.to.y - shape.from.y) / 2 * scale,
        0,
        0,
        Math.PI * 2,
      )
      ctx.stroke()
    } else {
      ctx.moveTo(shape.from.x * scale, shape.from.y * scale)
      ctx.lineTo(shape.to.x * scale, shape.to.y * scale)
      if (shape.kind === 'arrow') {
        const [left, right] = arrowHead(shape.from, shape.to, shape.width * 5.5)
        ctx.moveTo(left.x * scale, left.y * scale)
        ctx.lineTo(shape.to.x * scale, shape.to.y * scale)
        ctx.lineTo(right.x * scale, right.y * scale)
      }
      ctx.stroke()
    }
    ctx.restore()
  }
}
