/**
 * The panel's annotation mode: freeze a full-resolution screenshot over the
 * live screen, draw on it (pen, line, arrow, box, ellipse, text; five
 * colors; undo / redo / clear), then "Add to chat" — the composite PNG goes to
 * the server for ios_sim_annotation and onto the clipboard for pasting.
 * @module ios-simulator/panel/client/annotate-ui
 */

import {
  ANNOTATE_COLORS,
  ANNOTATE_TOOLS,
  AnnotationDoc,
  drawShapes,
  isNegligible,
  markSizes,
  shapeFor,
  type AnnotateTool,
  type Point,
  type Shape,
} from './annotate.js'
import type { PanelCopy } from './copy.js'

const SVG = 'viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"'
export const PENCIL_ICON = `<svg ${SVG}><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/><path d="m14.5 5.5 3 3"/></svg>`
const TOOL_ICONS: Record<AnnotateTool, string> = {
  pen: PENCIL_ICON,
  line: `<svg ${SVG}><path d="M5 19 19 5"/></svg>`,
  arrow: `<svg ${SVG}><path d="M5 19 19 5"/><path d="M9 5h10v10"/></svg>`,
  rect: `<svg ${SVG}><rect x="4" y="4" width="16" height="16" rx="1"/></svg>`,
  ellipse: `<svg ${SVG}><circle cx="12" cy="12" r="8"/></svg>`,
  text: `<svg ${SVG}><path d="M5 5h14"/><path d="M12 5v14"/><path d="M9 19h6"/></svg>`,
}
const UNDO_ICON = `<svg ${SVG}><path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/></svg>`
const REDO_ICON = `<svg ${SVG}><path d="m15 14 5-5-5-5"/><path d="M20 9H9a5 5 0 0 0 0 10h3"/></svg>`
const TRASH_ICON = `<svg ${SVG}><path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="M6 7l1 13h10l1-13"/><path d="M9 7V4h6v3"/></svg>`

export interface AnnotatorOptions {
  /** The live screen box the overlay covers. */
  screen: HTMLElement
  copy: PanelCopy
  /** A fresh full-resolution screenshot of the shown device. */
  capture(): Promise<{ url: string }>
  /** Store the annotated PNG (data URL) for ios_sim_annotation. */
  save(dataUrl: string): Promise<void>
  /** Show a short status message. */
  notify(message: string, kind: 'ok' | 'error'): void
}

function button(html: string, label: string, className = 'annotate-button'): HTMLButtonElement {
  const node = document.createElement('button')
  node.type = 'button'
  node.className = className
  node.innerHTML = html
  node.title = label
  node.setAttribute('aria-label', label)
  return node
}

function separator(): HTMLSpanElement {
  const node = document.createElement('span')
  node.className = 'annotate-separator'
  return node
}

export class Annotator {
  readonly #options: AnnotatorOptions
  readonly #overlay = document.createElement('div')
  readonly #canvas = document.createElement('canvas')
  readonly #bar = document.createElement('div')
  readonly #toolButtons = new Map<AnnotateTool, HTMLButtonElement>()
  readonly #colorButtons = new Map<string, HTMLButtonElement>()
  readonly #undo: HTMLButtonElement
  readonly #redo: HTMLButtonElement
  readonly #add: HTMLButtonElement
  #image: HTMLImageElement | undefined
  #doc = new AnnotationDoc()
  #tool: AnnotateTool = 'pen'
  #color: string = ANNOTATE_COLORS[0]
  #draft: Shape | undefined
  #dragFrom: Point | undefined
  #input: HTMLTextAreaElement | undefined
  #busy = false

  constructor(options: AnnotatorOptions) {
    this.#options = options
    const { copy } = options
    this.#overlay.className = 'annotate-overlay'
    this.#overlay.hidden = true
    this.#overlay.append(this.#canvas)
    options.screen.append(this.#overlay)

    this.#bar.className = 'annotate-bar'
    this.#bar.hidden = true
    for (const tool of ANNOTATE_TOOLS) {
      const node = button(TOOL_ICONS[tool], copy.annotateTools[tool])
      node.addEventListener('click', () => this.#setTool(tool))
      this.#toolButtons.set(tool, node)
      this.#bar.append(node)
    }
    this.#bar.append(separator())
    for (const color of ANNOTATE_COLORS) {
      const node = button('', copy.annotateColors[ANNOTATE_COLORS.indexOf(color)] ?? color, 'annotate-color')
      node.style.setProperty('--swatch', color)
      node.addEventListener('click', () => this.#setColor(color))
      this.#colorButtons.set(color, node)
      this.#bar.append(node)
    }
    this.#bar.append(separator())
    this.#undo = button(UNDO_ICON, copy.undo)
    this.#redo = button(REDO_ICON, copy.redo)
    const clear = button(TRASH_ICON, copy.clear)
    this.#undo.addEventListener('click', () => { this.#doc.undo(); this.#render() })
    this.#redo.addEventListener('click', () => { this.#doc.redo(); this.#render() })
    clear.addEventListener('click', () => { this.#doc.clear(); this.#render() })
    const close = button(copy.close, copy.close, 'annotate-text-button')
    close.addEventListener('click', () => this.close())
    this.#add = button(copy.addToChat, copy.addToChat, 'annotate-primary')
    this.#add.addEventListener('click', () => { void this.#submit() })
    this.#bar.append(this.#undo, this.#redo, clear, close, this.#add)
    document.body.append(this.#bar)

    this.#overlay.addEventListener('pointerdown', event => this.#down(event))
    this.#overlay.addEventListener('pointermove', event => this.#move(event))
    this.#overlay.addEventListener('pointerup', event => this.#up(event))
    this.#overlay.addEventListener('pointercancel', event => this.#up(event))
    window.addEventListener('keydown', event => this.#key(event))
    new ResizeObserver(() => this.#render()).observe(this.#overlay)
    this.#setTool('pen')
    this.#setColor(this.#color)
  }

  get isOpen(): boolean {
    return !this.#overlay.hidden
  }

  /** Freeze a fresh screenshot and show the tools. */
  async open(): Promise<void> {
    if (this.isOpen || this.#busy) return
    this.#busy = true
    try {
      const { url } = await this.#options.capture()
      const image = new Image()
      image.src = url
      await image.decode()
      this.#image = image
      this.#doc = new AnnotationDoc()
      this.#overlay.hidden = false
      this.#bar.hidden = false
      document.body.classList.add('annotating')
      this.#render()
    } finally {
      this.#busy = false
    }
  }

  close(): void {
    this.#commitText()
    this.#overlay.hidden = true
    this.#bar.hidden = true
    document.body.classList.remove('annotating')
    this.#image = undefined
    this.#draft = undefined
  }

  #setTool(tool: AnnotateTool): void {
    this.#commitText()
    this.#tool = tool
    for (const [name, node] of this.#toolButtons) node.classList.toggle('active', name === tool)
    this.#overlay.dataset.tool = tool
  }

  #setColor(color: string): void {
    this.#color = color
    for (const [name, node] of this.#colorButtons) node.classList.toggle('active', name === color)
    if (this.#input !== undefined) this.#input.style.color = color
  }

  /** Image pixels per overlay (CSS) pixel. */
  #imageScale(): number {
    const width = this.#overlay.clientWidth
    return this.#image === undefined || width === 0 ? 1 : this.#image.naturalWidth / width
  }

  #imagePoint(event: PointerEvent): Point {
    const box = this.#overlay.getBoundingClientRect()
    const scale = this.#imageScale()
    return { x: (event.clientX - box.left) * scale, y: (event.clientY - box.top) * scale }
  }

  #sizes(): { stroke: number; text: number } {
    return markSizes(this.#image === undefined ? { width: 1, height: 1 } : { width: this.#image.naturalWidth, height: this.#image.naturalHeight })
  }

  #down(event: PointerEvent): void {
    event.stopPropagation()
    event.preventDefault()
    if (this.#image === undefined || event.button !== 0) return
    const point = this.#imagePoint(event)
    if (this.#tool === 'text') {
      this.#commitText()
      this.#openText(event, point)
      return
    }
    this.#overlay.setPointerCapture(event.pointerId)
    this.#dragFrom = point
    this.#draft = shapeFor(this.#tool, this.#color, this.#sizes().stroke, point, point, [point])
  }

  #move(event: PointerEvent): void {
    event.stopPropagation()
    const from = this.#dragFrom
    const draft = this.#draft
    if (from === undefined || draft === undefined || this.#tool === 'text') return
    const point = this.#imagePoint(event)
    this.#draft = draft.kind === 'pen'
      ? { ...draft, points: [...draft.points, point] }
      : shapeFor(this.#tool, this.#color, draft.kind === 'text' ? 1 : draft.width, from, point)
    this.#render()
  }

  #up(event: PointerEvent): void {
    event.stopPropagation()
    const draft = this.#draft
    this.#draft = undefined
    this.#dragFrom = undefined
    if (draft !== undefined && !isNegligible(draft, this.#sizes().stroke * 2)) this.#doc.add(draft)
    this.#render()
  }

  #openText(event: PointerEvent, at: Point): void {
    const box = this.#overlay.getBoundingClientRect()
    const input = document.createElement('textarea')
    input.className = 'annotate-input'
    input.rows = 1
    input.style.left = `${event.clientX - box.left}px`
    input.style.top = `${event.clientY - box.top}px`
    input.style.color = this.#color
    input.style.fontSize = `${this.#sizes().text / this.#imageScale()}px`
    input.dataset.x = String(at.x)
    input.dataset.y = String(at.y)
    input.addEventListener('pointerdown', stop => stop.stopPropagation())
    input.addEventListener('keydown', key => {
      key.stopPropagation()
      if (key.key === 'Enter' && !key.shiftKey) {
        key.preventDefault()
        this.#commitText()
      } else if (key.key === 'Escape') {
        input.value = ''
        this.#commitText()
      }
    })
    input.addEventListener('blur', () => this.#commitText())
    this.#overlay.append(input)
    this.#input = input
    // Focus now: a keystroke that lands before a deferred focus would be lost.
    input.focus()
  }

  #commitText(): void {
    const input = this.#input
    if (input === undefined) return
    this.#input = undefined
    const text = input.value.replace(/\s+$/u, '')
    input.remove()
    if (text.trim() !== '') {
      this.#doc.add({ kind: 'text', color: this.#color, size: this.#sizes().text, at: { x: Number(input.dataset.x), y: Number(input.dataset.y) }, text })
      this.#render()
    }
  }

  #key(event: KeyboardEvent): void {
    if (!this.isOpen || this.#input !== undefined) return
    const mod = event.metaKey || event.ctrlKey
    if (event.key === 'Escape') {
      this.close()
    } else if (mod && event.key.toLowerCase() === 'z') {
      event.preventDefault()
      if (event.shiftKey) this.#doc.redo()
      else this.#doc.undo()
      this.#render()
    } else if (mod && event.key === 'Enter') {
      event.preventDefault()
      void this.#submit()
    }
  }

  #render(): void {
    this.#undo.disabled = !this.#doc.canUndo
    this.#redo.disabled = !this.#doc.canRedo
    const image = this.#image
    if (image === undefined || this.#overlay.hidden) return
    const ratio = window.devicePixelRatio || 1
    const width = this.#overlay.clientWidth
    const height = this.#overlay.clientHeight
    this.#canvas.width = Math.max(1, Math.round(width * ratio))
    this.#canvas.height = Math.max(1, Math.round(height * ratio))
    const ctx = this.#canvas.getContext('2d')
    if (ctx === null) return
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
    ctx.drawImage(image, 0, 0, width, height)
    const shapes = this.#draft === undefined ? this.#doc.shapes : [...this.#doc.shapes, this.#draft]
    drawShapes(ctx, shapes, 1 / this.#imageScale())
  }

  /** "Add to chat": the composite at full resolution → the server, and the clipboard. */
  async #submit(): Promise<void> {
    this.#commitText()
    const image = this.#image
    if (image === undefined || this.#busy) return
    this.#busy = true
    this.#add.disabled = true
    try {
      const canvas = document.createElement('canvas')
      canvas.width = image.naturalWidth
      canvas.height = image.naturalHeight
      const ctx = canvas.getContext('2d')
      if (ctx === null) throw new Error('canvas is unavailable')
      ctx.drawImage(image, 0, 0)
      drawShapes(ctx, this.#doc.shapes, 1)
      const dataUrl = canvas.toDataURL('image/png')
      await this.#options.save(dataUrl)
      let copied = false
      try {
        const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'))
        if (blob !== null && typeof ClipboardItem !== 'undefined') {
          await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
          copied = true
        }
      } catch {
        // The clipboard needs focus and permission; the stored copy is what matters.
      }
      this.close()
      this.#options.notify(copied ? this.#options.copy.annotationAddedCopied : this.#options.copy.annotationAdded, 'ok')
    } catch (error) {
      this.#options.notify(`${this.#options.copy.annotationFailed}: ${error instanceof Error ? error.message : String(error)}`, 'error')
    } finally {
      this.#busy = false
      this.#add.disabled = false
    }
  }
}
