// Ported from dsh-ios (MIT, © 2026 ZSeven—W) @ d9a9731 — src/tool-uitree.ts (tree and selector logic)
/**
 * Pure logic behind the UI-automation tools: the compact accessibility tree
 * (filter, depth cap, off-screen pruning, ~40 KB output cap, and a hint that
 * says WHY a read carries no labels), the tap_element selector resolver with
 * its off-screen/disabled safety gate, the OCR text resolver, and the shared
 * appear/disappear poll. The simulator branch of dsh-ios's tool-uitree.ts;
 * the WebDriverAgent (real device) branch lands with phase ⑤.
 * @module ios-simulator/uitree
 */

import { filterOcrItems, type OcrItem } from './ocr-backend.js'
import type { AxeElement } from './uitree-backend.js'

/** Compact accessibility element as returned by ios_sim_ui_tree. */
export interface UiTreeNode {
  type: string
  label?: string
  identifier?: string
  value?: string
  visible?: boolean
  enabled?: boolean
  selected?: boolean
  /** Frame in device points. */
  frame: { x: number; y: number; w: number; h: number }
  children: UiTreeNode[]
}

export type Frame = { x: number; y: number; w: number; h: number }
export type Size = { width: number; height: number }

/** Output cap of ios_sim_ui_tree and ios_sim_find_text. */
export const OUTPUT_CAP_BYTES = 40 * 1024

/** Default minimum OCR confidence (CJK labels commonly read 0.3–0.6). */
export const OCR_DEFAULT_MIN_CONFIDENCE = 0.3

/** Element types treated as the interactive container of a match chain. */
const TAPPABLE_TYPES = new Set([
  'Button', 'Cell', 'Link', 'Switch', 'TextField', 'SearchField', 'TextArea',
  'Tab', 'TabButton', 'Menu', 'MenuItem', 'MenuBarItem', 'Slider', 'Stepper',
  'Incrementor', 'PickerWheel', 'Handle', 'RadioButton', 'CheckBox',
  'DisclosureTriangle', 'PopUpButton', 'ComboBox', 'ScrollBar', 'Window',
])

/** Tolerance (points) for frame containment checks. */
const FRAME_EPSILON = 1

export const OCR_FALLBACK_HINT = 'The accessibility tree is empty or degenerate (no labeled elements), so the app '
  + 'exposes little or no accessibility information — run ios_sim_find_text to OCR the screen instead.'

/** Round to 2 decimals; negative zero never escapes. */
export function round2(value: number): number {
  const rounded = Math.round(value * 100) / 100
  return rounded === 0 ? 0 : rounded
}

export function roundFrame(frame: Frame): Frame {
  return { x: round2(frame.x), y: round2(frame.y), w: round2(frame.w), h: round2(frame.h) }
}

function toUiTreeNode(element: AxeElement): UiTreeNode {
  const node: UiTreeNode = { type: element.type, frame: roundFrame(element.frame), children: [] }
  if (element.label !== undefined) node.label = element.label
  if (element.identifier !== undefined) node.identifier = element.identifier
  if (element.value !== undefined) node.value = element.value
  if (element.visible !== undefined) node.visible = element.visible
  if (element.enabled !== undefined) node.enabled = element.enabled
  if (element.selected !== undefined) node.selected = element.selected
  return node
}

/**
 * Compact tree with an optional case-insensitive filter over label,
 * identifier and type (ancestors of matches are kept so the tree stays
 * connected) and an optional nesting depth cap (0 = roots only).
 */
export function buildCompactTree(roots: readonly AxeElement[], maxDepth?: number, filter?: string): { tree: UiTreeNode[]; count: number } {
  const needle = filter !== undefined && filter.trim() !== '' ? filter.trim().toLowerCase() : undefined
  let count = 0
  const walk = (element: AxeElement, depth: number): UiTreeNode | undefined => {
    const selfMatches = needle === undefined
      || [element.type, element.label, element.identifier].some(value => value?.toLowerCase().includes(needle) === true)
    const children: UiTreeNode[] = []
    if (maxDepth === undefined || depth < maxDepth) {
      for (const child of element.children) {
        const compact = walk(child, depth + 1)
        if (compact !== undefined) children.push(compact)
      }
    }
    if (!selfMatches && children.length === 0) return undefined
    const node = toUiTreeNode(element)
    node.children = children
    count += 1
    return node
  }
  const tree: UiTreeNode[] = []
  for (const root of roots) {
    const compact = walk(root, 0)
    if (compact !== undefined) tree.push(compact)
  }
  return { tree, count }
}

function treeDepth(nodes: readonly UiTreeNode[]): number {
  let depth = 0
  for (const node of nodes) {
    if (node.children.length > 0) depth = Math.max(depth, 1 + treeDepth(node.children))
  }
  return depth
}

function pruneDeepestLevel(nodes: UiTreeNode[]): void {
  const depth = treeDepth(nodes)
  if (depth === 0) return
  const pruneAt = (list: UiTreeNode[], level: number): void => {
    for (const node of list) {
      if (level === depth - 1) node.children = []
      else pruneAt(node.children, level + 1)
    }
  }
  pruneAt(nodes, 0)
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

/** Fit a compact tree under `capBytes` by pruning the deepest levels first. */
export function capTreeToBytes(tree: UiTreeNode[], capBytes = OUTPUT_CAP_BYTES): { tree: UiTreeNode[]; truncated: boolean } {
  let truncated = jsonBytes(tree) > capBytes
  while (jsonBytes(tree) > capBytes && treeDepth(tree) > 0) pruneDeepestLevel(tree)
  if (!truncated) truncated = jsonBytes(tree) > capBytes
  return { tree, truncated }
}

/** True when `frame` lies ENTIRELY outside the screen bounds (points). */
export function isOffscreenFrame(frame: Frame, bounds: Size): boolean {
  if (bounds.width <= 0 || bounds.height <= 0) return false
  return frame.x + frame.w <= 0
    || frame.y + frame.h <= 0
    || frame.x >= bounds.width
    || frame.y >= bounds.height
}

/** visible=false, or (AXe has no visibility flag) a frame outside the screen. */
export function isOffscreenElement(element: { visible?: boolean; frame: Frame }, bounds: Size): boolean {
  return element.visible === false || isOffscreenFrame(element.frame, bounds)
}

/**
 * Drop off-screen subtrees (roots are kept so the tree stays anchored),
 * counting every dropped node.
 */
export function pruneOffscreenTree(tree: UiTreeNode[], bounds: Size): { tree: UiTreeNode[]; omitted: number } {
  let omitted = 0
  const countAll = (node: UiTreeNode): number => 1 + node.children.reduce((sum, child) => sum + countAll(child), 0)
  const walk = (node: UiTreeNode, isRoot: boolean): UiTreeNode | undefined => {
    if (!isRoot && isOffscreenElement(node, bounds)) {
      omitted += countAll(node)
      return undefined
    }
    const children: UiTreeNode[] = []
    for (const child of node.children) {
      const kept = walk(child, false)
      if (kept !== undefined) children.push(kept)
    }
    node.children = children
    return node
  }
  const kept: UiTreeNode[] = []
  for (const root of tree) {
    const node = walk(root, true)
    if (node !== undefined) kept.push(node)
  }
  return { tree: kept, omitted }
}

/** True when the tree carries a labeled element (the Application root's own label is chrome). */
export function hasLabeledNode(tree: ReadonlyArray<{ type: string; label?: string; children: ReadonlyArray<unknown> }>): boolean {
  for (const node of tree) {
    if (node.type !== 'Application' && node.label !== undefined && node.label !== '') return true
    if (hasLabeledNode(node.children as typeof tree)) return true
  }
  return false
}

export function countNodes(node: UiTreeNode): number {
  return 1 + node.children.reduce((sum, child) => sum + countNodes(child), 0)
}

/** Screen bounds in points across every on-screen app root. */
export function screenBounds(roots: readonly AxeElement[]): Size {
  let width = 0
  let height = 0
  for (const root of roots) {
    width = Math.max(width, root.frame.x + root.frame.w)
    height = Math.max(height, root.frame.y + root.frame.h)
  }
  if (width <= 0 || height <= 0) {
    width = roots[0]?.frame.w ?? 0
    height = roots[0]?.frame.h ?? 0
  }
  return { width, height }
}

function containsFrame(outer: Frame, inner: Frame): boolean {
  return outer.x <= inner.x + FRAME_EPSILON
    && outer.y <= inner.y + FRAME_EPSILON
    && outer.x + outer.w >= inner.x + inner.w - FRAME_EPSILON
    && outer.y + outer.h >= inner.y + inner.h - FRAME_EPSILON
}

function sameFrame(a: Frame, b: Frame): boolean {
  return containsFrame(a, b) && containsFrame(b, a)
}

export interface UiTreeResult {
  /** Screen size in points. */
  size: Size
  nodeCount: number
  omittedOffscreen: number
  truncated?: boolean
  hint?: string
  tree: UiTreeNode[]
}

/**
 * ios_sim_ui_tree's result: compact build → off-screen pruning (unless
 * include_offscreen) → ~40 KB cap, plus a hint that attributes an unlabeled
 * read to its cause — a filter miss, the output cap, off-screen exclusion —
 * and only a full, unfiltered, uncapped read with no labels to the app.
 */
export function buildTreeResult(
  roots: readonly AxeElement[],
  size: Size,
  args: { max_depth?: number; filter?: string; include_offscreen?: boolean },
): UiTreeResult {
  const built = buildCompactTree(roots, args.max_depth, args.filter)
  const pruned = args.include_offscreen === true ? { tree: built.tree, omitted: 0 } : pruneOffscreenTree(built.tree, size)
  const capped = capTreeToBytes(pruned.tree)
  const hints: string[] = []
  if (capped.truncated) {
    hints.push('The tree exceeded the 40 KB output cap and its deepest levels were pruned. '
      + 'Re-run with max_depth or filter to narrow the subtree.')
  }
  const filter = args.filter?.trim() ?? ''
  if (filter !== '' && built.count === 0) {
    // A filter miss says nothing about the app, only about the filter.
    hints.push(`The filter ${JSON.stringify(filter)} matched nothing. A filter miss says nothing about the app — re-run `
      + 'WITHOUT a filter to see what is actually there.')
  } else if (!hasLabeledNode(capped.tree)) {
    if (args.max_depth !== undefined) {
      hints.push(`max_depth ${args.max_depth} shows only container chrome — the labeled controls live deeper; re-run without max_depth.`)
    } else if (capped.truncated) {
      hints.push('The tree was pruned to fit the output cap, so the surviving levels carry no labels — narrow it with '
        + 'a filter before concluding anything about the app.')
    } else if (pruned.omitted > 0) {
      hints.push(`The visible tree carries no labels — every labeled element is among the ${pruned.omitted} off-screen `
        + 'element(s) excluded from the output. Scroll, or re-run with include_offscreen=true.')
    } else {
      hints.push(OCR_FALLBACK_HINT)
    }
  }
  return {
    size: { width: round2(size.width), height: round2(size.height) },
    nodeCount: capped.tree.reduce((count, node) => count + countNodes(node), 0),
    omittedOffscreen: pruned.omitted,
    ...(capped.truncated ? { truncated: true } : {}),
    ...(hints.length > 0 ? { hint: hints.join(' ') } : {}),
    tree: capped.tree,
  }
}

/** One element of the flattened tree (full-precision frame). */
export interface FlatElement {
  type: string
  label?: string
  identifier?: string
  value?: string
  visible?: boolean
  enabled?: boolean
  frame: Frame
  depth: number
}

function flattenElements(roots: readonly AxeElement[]): FlatElement[] {
  const flat: FlatElement[] = []
  const walk = (element: AxeElement, depth: number): void => {
    const entry: FlatElement = { type: element.type, frame: element.frame, depth }
    if (element.label !== undefined) entry.label = element.label
    if (element.identifier !== undefined) entry.identifier = element.identifier
    if (element.value !== undefined) entry.value = element.value
    if (element.visible !== undefined) entry.visible = element.visible
    if (element.enabled !== undefined) entry.enabled = element.enabled
    flat.push(entry)
    for (const child of element.children) walk(child, depth + 1)
  }
  for (const root of roots) walk(root, 0)
  return flat
}

function describeCandidate(element: FlatElement, index: number): string {
  const label = element.label === undefined ? '' : ` label=${JSON.stringify(element.label)}`
  const identifier = element.identifier === undefined ? '' : ` identifier=${JSON.stringify(element.identifier)}`
  const flags = `${element.visible === false ? ' visible=false' : ''}${element.enabled === false ? ' enabled=false' : ''}`
  const frame = roundFrame(element.frame)
  return `${index}) type=${element.type}${label}${identifier}${flags} frame={x:${frame.x},y:${frame.y},w:${frame.w},h:${frame.h}}`
}

function tapGateFailure(representatives: FlatElement[], bounds: Size, wanted: string, allowOffscreen: boolean): never {
  const offscreen = representatives.filter(element => isOffscreenElement(element, bounds))
  const disabled = representatives.filter(element => element.enabled === false)
  const hint = allowOffscreen ? ' (allow_offscreen=true bypasses only the off-screen check — disabled stays refused)' : ''
  if (offscreen.length > 0 && disabled.length > 0) {
    throw new Error(`${wanted} matched ${representatives.length} element(s) that are off-screen or disabled`
      + ` — scroll the off-screen ones into view first and enable the disabled ones${hint}`)
  }
  if (offscreen.length > 0) {
    const noun = representatives.length === 1 ? 'matched an off-screen element' : `matched ${representatives.length} off-screen elements`
    throw new Error(`${wanted} ${noun} — scroll it into view first, then retry; pass allow_offscreen=true to tap the `
      + `recorded coordinates anyway${hint}`)
  }
  const noun = representatives.length === 1 ? 'matched a disabled element' : `matched ${representatives.length} disabled elements`
  throw new Error(`${wanted} ${noun} — the control is disabled, so a tap would do nothing; enable it first${hint}`)
}

/**
 * Resolve one element from a selector: exact (case-sensitive) equality
 * first, then case-insensitive substring. Nested duplicates (a row mirroring
 * its label onto child text) collapse to one chain whose outermost tappable
 * container — or deepest element when nothing is tappable — is the target.
 * Off-screen and disabled matches are not tappable (allow_offscreen lifts
 * only the off-screen half); several viable matches list every candidate.
 */
export function resolveTapTarget(
  roots: readonly AxeElement[],
  selector: { identifier?: string; label?: string },
  options: { allowOffscreen?: boolean } = {},
): { element: FlatElement; matchedBy: 'exact' | 'contains' } {
  const identifier = selector.identifier?.trim() || undefined
  const label = selector.label?.trim() || undefined
  if (identifier === undefined && label === undefined) {
    throw new Error('an element selector is required: identifier and/or label')
  }
  const wantedFields: Array<['identifier' | 'label', string]> = []
  if (identifier !== undefined) wantedFields.push(['identifier', identifier])
  if (label !== undefined) wantedFields.push(['label', label])
  const flat = flattenElements(roots)
  const matches = (mode: 'exact' | 'contains'): FlatElement[] => flat.filter(element => wantedFields.every(([field, value]) => {
    const actual = element[field]
    if (actual === undefined) return false
    return mode === 'exact' ? actual === value : actual.toLowerCase().includes(value.toLowerCase())
  }))
  let candidates = matches('exact')
  let matchedBy: 'exact' | 'contains' = 'exact'
  if (candidates.length === 0) {
    candidates = matches('contains')
    matchedBy = 'contains'
  }
  if (candidates.length === 0) {
    const wanted = wantedFields.map(([field, value]) => `${field}=${value}`).join(' and ')
    throw new Error(`no accessibility element matches ${wanted} on the current screen — run ios_sim_ui_tree to inspect `
      + 'the visible elements (a control inside a feed row is not an element of its own: use ios_sim_ui_rows)')
  }
  // Accessibility sometimes lists one element twice with identical frames.
  const unique = candidates.filter((element, index) =>
    !candidates.slice(0, index).some(other => sameFrame(element.frame, other.frame) && element.type === other.type))
  // An ancestor that mirrors its descendant's label is the same row, not an ambiguity.
  const chains: FlatElement[][] = []
  for (const element of unique) {
    const chain = chains.find(group => group.some(other =>
      !sameFrame(element.frame, other.frame) && (containsFrame(element.frame, other.frame) || containsFrame(other.frame, element.frame))))
    if (chain === undefined) chains.push([element])
    else chain.push(element)
  }
  const representatives = chains.map(chain => {
    const tappable = chain.filter(element => TAPPABLE_TYPES.has(element.type))
    if (tappable.length > 0) {
      return tappable.find(element => !tappable.some(other =>
        other !== element && containsFrame(other.frame, element.frame) && !sameFrame(other.frame, element.frame))) ?? tappable[0]!
    }
    return chain.reduce((deepest, element) => (element.depth > deepest.depth ? element : deepest), chain[0]!)
  })
  const wanted = wantedFields.map(([field, value]) => `${field} ${JSON.stringify(value)}`).join(' and ')
  const bounds = screenBounds(roots)
  const allowOffscreen = options.allowOffscreen === true
  const viable = representatives.filter(element =>
    element.enabled !== false && (allowOffscreen || !isOffscreenElement(element, bounds)))
  if (viable.length === 0) tapGateFailure(representatives, bounds, wanted, allowOffscreen)
  if (viable.length > 1) {
    const skipped = representatives.length - viable.length
    const shown = representatives.slice(0, 8)
    const more = representatives.length - shown.length
    throw new Error(`${representatives.length} elements match ${wanted}${skipped > 0 ? ` (${skipped} skipped: off-screen or disabled)` : ''}`
      + ' — use a more specific selector (exact label, identifier, or ios_sim_ui_tree to disambiguate). Candidates:\n'
      + shown.map((element, index) => `  ${describeCandidate(element, index + 1)}`).join('\n')
      + (more > 0 ? `\n  …and ${more} more` : ''))
  }
  return { element: viable[0]!, matchedBy }
}

/** Center of a frame in points, rounded to one decimal. */
export function frameCenter(frame: Frame): { x: number; y: number } {
  const round1 = (value: number): number => {
    const rounded = Math.round(value * 10) / 10
    return rounded === 0 ? 0 : rounded
  }
  return { x: round1(frame.x + frame.w / 2), y: round1(frame.y + frame.h / 2) }
}

/** Validate the optional min_confidence argument. */
export function sanitizeMinConfidence(value: number | undefined): number {
  if (value === undefined) return OCR_DEFAULT_MIN_CONFIDENCE
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error('min_confidence must be a number within 0..1')
  return value
}

/** Which post-tap assertion the args carry, if any. */
export function tapExpectation(args: { expect_text?: string; expect_gone?: string }): { text: string; mode: 'appear' | 'disappear' } | undefined {
  const expectText = args.expect_text?.trim() || undefined
  const expectGone = args.expect_gone?.trim() || undefined
  if (expectText !== undefined && expectGone !== undefined) {
    throw new Error('pass expect_text OR expect_gone, not both — they assert opposite outcomes')
  }
  if (expectText !== undefined) return { text: expectText, mode: 'appear' }
  if (expectGone !== undefined) return { text: expectGone, mode: 'disappear' }
  return undefined
}

/** Exact text first, then case-insensitive contains. */
function ocrTextPresent(items: readonly OcrItem[], text: string): OcrItem | undefined {
  const needle = text.toLowerCase()
  return items.find(item => item.text === text) ?? items.find(item => item.text.toLowerCase().includes(needle))
}

export interface OcrPollOutcome {
  matched: boolean
  waitedMs: number
  /** The matched item (appear mode), in pixels. */
  item?: OcrItem
}

/**
 * Poll `read` until `text` appears or disappears, or the budget runs out.
 * A timeout is a normal `matched: false`, never a throw.
 */
export async function pollForText(
  read: () => Promise<readonly OcrItem[]>,
  text: string,
  mode: 'appear' | 'disappear',
  timeoutMs: number,
  intervalMs: number,
  minConfidence: number,
  signal?: AbortSignal,
): Promise<OcrPollOutcome> {
  const startedAt = Date.now()
  const deadline = startedAt + timeoutMs
  for (;;) {
    const present = ocrTextPresent(filterOcrItems(await read(), text, minConfidence), text)
    const matched = mode === 'appear' ? present !== undefined : present === undefined
    const waitedMs = Date.now() - startedAt
    if (matched) return mode === 'appear' && present !== undefined ? { matched, waitedMs, item: present } : { matched, waitedMs }
    if (signal?.aborted === true || Date.now() >= deadline) return { matched: false, waitedMs }
    await new Promise(resolve => setTimeout(resolve, Math.min(intervalMs, Math.max(0, deadline - Date.now()))))
  }
}

/**
 * Resolve one OCR text target with tap_element's rules: exact first, then
 * contains; several distinct matches list the candidates. A match that only
 * exists below min_confidence is named, since CJK labels often read 0.3–0.6.
 */
export function resolveOcrTextTarget(
  items: readonly OcrItem[],
  query: string,
  unfiltered: readonly OcrItem[] = items,
  minConfidence = 0,
): { item: OcrItem; matchedBy: 'exact' | 'contains' } {
  const matches = (pool: readonly OcrItem[], mode: 'exact' | 'contains'): OcrItem[] => mode === 'exact'
    ? pool.filter(item => item.text === query)
    : pool.filter(item => item.text.toLowerCase().includes(query.toLowerCase()))
  let pool = matches(items, 'exact')
  let matchedBy: 'exact' | 'contains' = 'exact'
  if (pool.length === 0) {
    pool = matches(items, 'contains')
    matchedBy = 'contains'
  }
  if (pool.length === 0) {
    const nearMiss = [...matches(unfiltered, 'exact'), ...matches(unfiltered, 'contains')]
      .filter(item => item.confidence < minConfidence)
      .sort((a, b) => b.confidence - a.confidence)[0]
    if (nearMiss !== undefined) {
      throw new Error(`${JSON.stringify(nearMiss.text)} IS on the current screen, but its OCR confidence `
        + `${nearMiss.confidence.toFixed(2)} is below min_confidence ${minConfidence.toFixed(2)} — pass a lower `
        + 'min_confidence (CJK labels commonly read 0.3–0.6) or tap it by identifier with ios_sim_tap_element')
    }
    throw new Error(`no recognized text matches ${JSON.stringify(query)} on the current screen — run ios_sim_find_text `
      + 'to see everything the OCR read')
  }
  const unique = pool.filter((item, index) => !pool.slice(0, index).some(other =>
    other.text === item.text && other.rect.x === item.rect.x && other.rect.y === item.rect.y
    && other.rect.w === item.rect.w && other.rect.h === item.rect.h))
  if (unique.length > 1) {
    const shown = unique.slice(0, 8)
    const more = unique.length - shown.length
    throw new Error(`${unique.length} OCR matches for ${JSON.stringify(query)} — use a more specific query, or raise `
      + 'min_confidence to drop weak matches. Candidates:\n'
      + shown.map((item, index) => {
        const rect = roundFrame(item.rect)
        return `  ${index + 1}) text=${JSON.stringify(item.text)} confidence=${round2(item.confidence)} `
          + `rect={x:${rect.x},y:${rect.y},w:${rect.w},h:${rect.h}}`
      }).join('\n')
      + (more > 0 ? `\n  …and ${more} more` : ''))
  }
  return { item: unique[0]!, matchedBy }
}

/** Cap a list under the output cap by dropping its tail (lowest confidence last). */
export function capList<T>(items: readonly T[], capBytes = OUTPUT_CAP_BYTES): { items: T[]; truncated: boolean } {
  if (jsonBytes(items) <= capBytes) return { items: [...items], truncated: false }
  const kept = [...items]
  while (jsonBytes(kept) > capBytes && kept.length > 1) kept.pop()
  return { items: kept, truncated: true }
}
