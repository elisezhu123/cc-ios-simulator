// Ported from dsh-ios (MIT, © 2026 ZSeven—W) @ d9a9731 — src/tool-uitree.ts, src/tool-list-rows.ts (simulator branch)
/**
 * UI-automation tools: read the screen by meaning instead of by pixels, and
 * act on what was read.
 * - accessibility tree (AXe): ios_sim_ui_tree, ios_sim_tap_element;
 * - Vision OCR: ios_sim_find_text, ios_sim_tap_text, ios_sim_wait_for;
 * - list/feed rows: ios_sim_ui_rows, ios_sim_tap_row.
 * The tap tools return the effect screenshot as an image, like
 * ios_sim_interact, and can assert their outcome in the same call
 * (expect_text / expect_gone, or expect_count for a row).
 * @module ios-simulator/tools/ui
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { TAP_EXPECTATION_BUDGET_MS } from '../config.js'
import type { ToolDeps } from '../deps.js'
import { interactControlArgs, performSimInteract, type SimInteractArgs } from '../interact.js'
import {
  detectListRows,
  planRowTap,
  requireCountKey,
  sanitizeCountDelta,
  verifyCountChange,
  type CountCheckResult,
  type ListRow,
} from '../list-rows.js'
import { filterOcrItems, pixelRectToNormalizedCenter, pixelRectToPoints, type OcrItem, type PixelSize } from '../ocr-backend.js'
import { isLandscape, readSimScreenConfig, toFramebufferArgs } from '../orientation.js'
import { captureWda, ROW_SNAPSHOT_DEPTH, wdaTree } from '../real-ui.js'
import type { ScreenshotCapture } from '../screenshot.js'
import type { SimulatorDevice } from '../simctl.js'
import { assertMac, ensureStreamFor, realDeviceSummary, requireBooted, resolveToolTarget } from '../target.js'
import type { AxeElement } from '../uitree-backend.js'
import {
  buildTreeResult,
  capList,
  frameCenter,
  hasLabeledNode,
  OCR_FALLBACK_HINT,
  pollForText,
  resolveOcrTextTarget,
  resolveTapTarget,
  round2,
  roundFrame,
  sanitizeMinConfidence,
  screenBounds,
  tapExpectation,
} from '../uitree.js'
import { deviceSummary, jsonResult, runTool, sleep, UDID_PARAM, type DeviceSummary } from './result.js'

const SCREENSHOT_PARAM = z.boolean().optional()
  .describe('Return a screenshot of the result as an image (default true); pass false when chaining actions')
const EXPECT_TEXT_PARAM = z.string().optional()
  .describe('Text that should APPEAR after the tap: screen OCR is polled for up to ~4 s and reported as expected.matched')
const EXPECT_GONE_PARAM = z.string().optional()
  .describe('Text that should DISAPPEAR after the tap (mutually exclusive with expect_text); expected.matched = it is gone')
const MIN_CONFIDENCE_PARAM = z.number().min(0).max(1).optional()
  .describe('Minimum OCR confidence 0..1 (default 0.3 — CJK labels commonly read 0.3–0.6, so do not raise it "to be safe")')

const IMAGE_LANDSCAPE_UNSYNCED_WARNING = 'the screen looks landscape, but the live stream does not report a landscape '
  + 'orientation, so the tap went out without the landscape mapping and may miss — send ios_sim_interact '
  + '{action: "rotate", orientation: "landscape_left" or "landscape_right"} matching the screen, then retry'

export function registerUiTools(server: McpServer, deps: ToolDeps): void {
  /**
   * udid:pixel size → point size. A device's point size is fixed for a given
   * screenshot size, but resolving it costs a full describe-ui dump, so it is
   * cached; a rotation changes the pixel size and so misses.
   */
  const pointSizes = new Map<string, PixelSize>()

  const readTree = async (device: SimulatorDevice, signal?: AbortSignal): Promise<AxeElement[]> => {
    try {
      return await deps.axe.describeUi(device.udid, signal)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`could not read the accessibility tree of ${device.name} (${device.udid}): ${message}`)
    }
  }

  /**
   * The simulator's point size, from the AXe app root frame. Best effort and
   * never downloads AXe: without it, OCR geometry stays in image pixels and
   * a note says so.
   */
  const pointSizeOf = async (udid: string, pixelSize: PixelSize, signal?: AbortSignal): Promise<{ size: PixelSize; note?: string }> => {
    const key = `${udid}:${pixelSize.width}x${pixelSize.height}`
    const cached = pointSizes.get(key)
    if (cached !== undefined) return { size: cached }
    try {
      if (deps.axe.resolve().available) {
        const size = screenBounds(await deps.axe.describeUi(udid, signal))
        if (size.width > 0 && size.height > 0) {
          pointSizes.set(key, size)
          return { size }
        }
      }
    } catch {
      // Fall through to pixel geometry.
    }
    return {
      size: pixelSize,
      note: 'the simulator point size could not be resolved (the AXe helper is not installed yet, or describe-ui '
        + 'failed) — size and rects are in image pixels instead of points',
    }
  }

  /**
   * The device a UI tool acts on: a booted simulator (AXe, simctl
   * screenshots) or a connected iPhone/iPad (WebDriverAgent, which must be
   * running — ios_real_start_wda). Coordinates are device points either way.
   */
  interface UiTarget {
    kind: 'simulator' | 'real'
    udid: string
    name: string
    summary: DeviceSummary
    /** Set for a simulator. */
    simulator?: SimulatorDevice
    /** `depth` caps WDA's snapshot on a real device; a simulator always reads the full tree. */
    readTree(signal?: AbortSignal, depth?: number): Promise<{ roots: AxeElement[]; sampledDepth?: number; deepened?: boolean }>
    tap(x: number, y: number, signal?: AbortSignal): Promise<void>
    capture(signal?: AbortSignal): Promise<ScreenshotCapture>
    pointSize(pixelSize: PixelSize, signal?: AbortSignal): Promise<{ size: PixelSize; note?: string }>
  }

  const uiTarget = async (tool: string, udid: string | undefined): Promise<UiTarget> => {
    assertMac(deps.platform)
    const target = await resolveToolTarget(deps, udid)
    if (target.kind === 'real') {
      const device = target.device
      const client = await deps.wda.control(device)
      return {
        kind: 'real',
        udid: device.udid,
        name: device.name,
        summary: realDeviceSummary(device),
        readTree: async (_signal, depth) => wdaTree(client, device.name, depth),
        tap: async (x, y) => {
          try {
            await client.tap(x, y)
          } catch (error) {
            throw new Error(`WebDriverAgent tap at (${x}, ${y}) failed: ${error instanceof Error ? error.message : String(error)}`)
          }
        },
        capture: async () => captureWda(client, deps.screenshots, device.udid, device.name),
        pointSize: async () => ({ size: await client.windowSize() }),
      }
    }
    const device = target.device
    requireBooted(tool, device)
    return {
      kind: 'simulator',
      udid: device.udid,
      name: device.name,
      summary: deviceSummary(device),
      simulator: device,
      readTree: async signal => ({ roots: await readTree(device, signal) }),
      tap: async (x, y, signal) => {
        try {
          await deps.axe.tap(device.udid, x, y, signal)
        } catch (error) {
          throw new Error(`AXe tap at (${x}, ${y}) failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      },
      capture: signal => deps.screenshots.capture(device.udid, signal),
      pointSize: (pixelSize, signal) => pointSizeOf(device.udid, pixelSize, signal),
    }
  }

  interface OcrSnapshot {
    items: OcrItem[]
    pixelSize: PixelSize
    pointSize: PixelSize
    note?: string
    path: string
  }

  const readOcr = async (device: UiTarget, signal?: AbortSignal): Promise<OcrSnapshot> => {
    const capture = await device.capture(signal)
    if (capture.width === undefined || capture.height === undefined || capture.width <= 0 || capture.height <= 0) {
      throw new Error(`could not determine the screenshot pixel size of ${device.name} (unreadable PNG header)`)
    }
    const pixelSize = { width: capture.width, height: capture.height }
    const point = await device.pointSize(pixelSize, signal)
    let items: OcrItem[]
    try {
      items = await deps.ocr.recognize(capture.path, signal)
    } catch (error) {
      throw new Error(`OCR failed for ${device.name}: ${error instanceof Error ? error.message : String(error)}`)
    }
    return { items, pixelSize, pointSize: point.size, path: capture.path, ...(point.note === undefined ? {} : { note: point.note }) }
  }

  const pointsItem = (item: OcrItem, snapshot: OcrSnapshot): { text: string; confidence: number; rect: { x: number; y: number; w: number; h: number } } => ({
    text: item.text,
    confidence: round2(item.confidence),
    rect: roundFrame(pixelRectToPoints(item.rect, snapshot.pixelSize, snapshot.pointSize)),
  })

  /** A tap tool's expect_text / expect_gone, polled after the settle delay. */
  const runExpectation = async (
    device: UiTarget,
    expectation: { text: string; mode: 'appear' | 'disappear' } | undefined,
    signal?: AbortSignal,
  ): Promise<{ text: string; mode: 'appear' | 'disappear'; matched: boolean; waitedMs: number } | undefined> => {
    if (expectation === undefined) return undefined
    const outcome = await pollForText(
      async () => (await readOcr(device, signal)).items,
      expectation.text,
      expectation.mode,
      TAP_EXPECTATION_BUDGET_MS,
      deps.pollIntervalMs,
      0,
      signal,
    )
    return { ...expectation, matched: outcome.matched, waitedMs: outcome.waitedMs }
  }

  /** The tap tools' result: JSON plus, unless screenshot:false, the effect image. */
  const withScreenshot = async (
    device: UiTarget,
    body: Record<string, unknown>,
    screenshot: boolean | undefined,
    signal?: AbortSignal,
  ): Promise<CallToolResult> => {
    if (screenshot === false) return jsonResult(body)
    const capture = await device.capture(signal)
    const image = await deps.screenshots.toModelImage(capture)
    return jsonResult({
      ...body,
      screenshot: {
        path: capture.path,
        ...(capture.width === undefined ? {} : { width: capture.width, height: capture.height }),
        image: { width: image.width, height: image.height },
      },
    }, image)
  }

  server.registerTool('ios_sim_ui_tree', {
    title: 'Read the accessibility tree',
    description: 'Dump the accessibility element tree of the frontmost app on a booted simulator (AXe helper): '
      + 'type, label, identifier, value, enabled / selected flags and frames in device points, plus the screen '
      + 'size in points. Use it to find elements by identity and tap them with ios_sim_tap_element instead of '
      + 'guessing coordinates; selected=true marks the chosen option of a list or picker (reported only when the '
      + 'app says so). Off-screen elements are EXCLUDED by default and counted as omittedOffscreen '
      + '(include_offscreen:true lists them). Output is capped at ~40 KB: past that the deepest levels are pruned '
      + 'and truncated:true is set — narrow with filter or max_depth. An unlabeled read comes with a hint naming '
      + 'its cause (filter miss, output cap, off-screen exclusion); only a full unfiltered read with no labels '
      + 'points to ios_sim_find_text. Feed rows aggregate their controls into one element — use ios_sim_ui_rows '
      + 'for those. AXe is used from PATH or Homebrew, else downloaded (pinned release) on first use.',
    inputSchema: {
      udid: UDID_PARAM,
      max_depth: z.number().int().min(0).optional().describe('Maximum nesting depth to include (0 = app roots only)'),
      filter: z.string().optional()
        .describe('Case-insensitive substring over label, identifier and type; matches and their ancestors are kept'),
      include_offscreen: z.boolean().optional().describe('Include off-screen elements (default false)'),
    },
    annotations: { readOnlyHint: true },
  }, async (args, extra) => runTool('ios_sim_ui_tree', async () => {
    const device = await uiTarget('ios_sim_ui_tree', args.udid)
    const { roots, sampledDepth, deepened } = await device.readTree(extra.signal, args.max_depth)
    const result = buildTreeResult(roots, screenBounds(roots), args)
    const { tree, ...summary } = result
    return jsonResult({
      ...summary,
      device: device.summary,
      ...(sampledDepth === undefined ? {} : { snapshotDepth: sampledDepth, ...(deepened === true ? { deepened } : {}) }),
      tree,
    })
  }))

  server.registerTool('ios_sim_tap_element', {
    title: 'Tap an accessibility element',
    description: 'Tap an element of a booted simulator by identity — identifier and/or label, exact match first, '
      + 'then case-insensitive substring — through the AXe helper. Nested duplicates (a row mirroring its label '
      + 'onto child text) collapse to one target; several distinct matches fail with every candidate listed. '
      + 'Off-screen or disabled matches are refused with what to do instead (allow_offscreen:true taps an '
      + 'off-screen element anyway; disabled always refuses). The tap lands on the element center; a screenshot of '
      + 'the effect comes back as an image. To CONFIRM the tap worked pass expect_text (text that should appear) '
      + 'or expect_gone (text that should disappear) — screen OCR is polled and reported as expected.matched.',
    inputSchema: {
      udid: UDID_PARAM,
      identifier: z.string().optional().describe('Accessibility identifier, e.g. "com.apple.settings.general"'),
      label: z.string().optional().describe('Accessibility label, e.g. "General"'),
      allow_offscreen: z.boolean().optional().describe('Tap an off-screen match at its recorded coordinates (default false)'),
      expect_text: EXPECT_TEXT_PARAM,
      expect_gone: EXPECT_GONE_PARAM,
      screenshot: SCREENSHOT_PARAM,
    },
  }, async (args, extra) => runTool('ios_sim_tap_element', async () => {
    const expectation = tapExpectation(args)
    const device = await uiTarget('ios_sim_tap_element', args.udid)
    const { roots } = await device.readTree(extra.signal)
    const { element, matchedBy } = resolveTapTarget(roots, args, { allowOffscreen: args.allow_offscreen === true })
    const center = frameCenter(element.frame)
    await device.tap(center.x, center.y, extra.signal)
    await sleep(deps.settleMs)
    const expected = await runExpectation(device, expectation, extra.signal)
    return withScreenshot(device, {
      action: 'tap-element',
      element: {
        type: element.type,
        ...(element.label === undefined ? {} : { label: element.label }),
        ...(element.identifier === undefined ? {} : { identifier: element.identifier }),
        ...(element.value === undefined ? {} : { value: element.value }),
        frame: roundFrame(element.frame),
      },
      matchedBy,
      center,
      device: device.summary,
      ...(expected === undefined ? {} : { expected }),
    }, args.screenshot, extra.signal)
  }))

  server.registerTool('ios_sim_find_text', {
    title: 'Find text on screen (OCR)',
    description: 'OCR the CURRENT screen of a booted simulator with the plugin\'s Vision helper (accurate, zh-Hans + '
      + 'en-US; compiled with swiftc on first use). Returns items [{text, confidence, rect}] with rects in device '
      + 'points (origin top-left), confidence-sorted and capped at ~40 KB. The quickest way to learn what text is '
      + 'on screen and where; also covers what the accessibility tree cannot see (games, canvas, text baked into '
      + 'images, badge counts). Icon-only controls carry no text — use ios_sim_ui_tree for those.',
    inputSchema: {
      udid: UDID_PARAM,
      query: z.string().optional().describe('Case-insensitive substring filter on the recognized text, e.g. "支付" or "Payment"'),
      min_confidence: MIN_CONFIDENCE_PARAM,
    },
    annotations: { readOnlyHint: true },
  }, async (args, extra) => runTool('ios_sim_find_text', async () => {
    const minConfidence = sanitizeMinConfidence(args.min_confidence)
    const device = await uiTarget('ios_sim_find_text', args.udid)
    const snapshot = await readOcr(device, extra.signal)
    const items = filterOcrItems(snapshot.items, args.query, minConfidence).map(item => pointsItem(item, snapshot))
    const capped = capList(items)
    return jsonResult({
      device: device.summary,
      size: { width: round2(snapshot.pointSize.width), height: round2(snapshot.pointSize.height) },
      count: capped.items.length,
      items: capped.items,
      ...(capped.truncated
        ? { truncated: true, hint: 'The item list exceeded the 40 KB output cap and the lowest-confidence items were dropped. Narrow with query or raise min_confidence.' }
        : {}),
      ...(snapshot.note === undefined ? {} : { note: snapshot.note }),
    })
  }))

  server.registerTool('ios_sim_wait_for', {
    title: 'Wait for text to appear or disappear',
    description: 'Poll screen OCR of a booted simulator until text appears (mode "appear", default) or disappears '
      + '(mode "disappear"), or timeout_ms runs out. A timeout is a normal matched:false answer, not an error. '
      + 'Use it to wait for a load, an animation or a network round trip in one call instead of a find_text loop. '
      + 'On an appear match, item carries the text, confidence and rect in device points.',
    inputSchema: {
      udid: UDID_PARAM,
      text: z.string().trim().min(1).describe('Text to wait for (exact first, then case-insensitive substring)'),
      mode: z.enum(['appear', 'disappear']).optional(),
      timeout_ms: z.number().int().min(0).max(60_000).optional().describe('How long to poll, ms (default 8000, max 60000)'),
      min_confidence: MIN_CONFIDENCE_PARAM,
    },
    annotations: { readOnlyHint: true },
  }, async (args, extra) => runTool('ios_sim_wait_for', async () => {
    const minConfidence = sanitizeMinConfidence(args.min_confidence)
    const mode = args.mode ?? 'appear'
    const device = await uiTarget('ios_sim_wait_for', args.udid)
    let last: OcrSnapshot | undefined
    const outcome = await pollForText(async () => {
      last = await readOcr(device, extra.signal)
      return last.items
    }, args.text, mode, args.timeout_ms ?? 8000, deps.pollIntervalMs, minConfidence, extra.signal)
    return jsonResult({
      device: device.summary,
      matched: outcome.matched,
      waitedMs: outcome.waitedMs,
      text: args.text,
      mode,
      ...(outcome.item !== undefined && last !== undefined ? { item: pointsItem(outcome.item, last) } : {}),
    })
  }))

  server.registerTool('ios_sim_tap_text', {
    title: 'Tap text on screen (OCR)',
    description: 'OCR the CURRENT screen and tap the center of the matching text, with ios_sim_tap_element\'s rules: '
      + 'exact match first, then case-insensitive substring; several distinct matches fail with the candidates '
      + 'listed, and a match that only exists below min_confidence is named. The tap goes through the live '
      + 'serve-sim stream (started when needed; never boots a device) and the effect screenshot comes back as an '
      + 'image. To CONFIRM the tap worked pass expect_text or expect_gone — screen OCR is polled and reported as '
      + 'expected.matched. Prefer this or ios_sim_tap_element over raw ios_sim_interact coordinates.',
    inputSchema: {
      udid: UDID_PARAM,
      query: z.string().trim().min(1).describe('Text to tap, e.g. "继续" or "Continue"'),
      min_confidence: MIN_CONFIDENCE_PARAM,
      expect_text: EXPECT_TEXT_PARAM,
      expect_gone: EXPECT_GONE_PARAM,
      screenshot: SCREENSHOT_PARAM,
    },
  }, async (args, extra) => runTool('ios_sim_tap_text', async () => {
    const minConfidence = sanitizeMinConfidence(args.min_confidence)
    const expectation = tapExpectation(args)
    const device = await uiTarget('ios_sim_tap_text', args.udid)
    const info = device.simulator === undefined ? undefined : await ensureStreamFor(deps.host, device.simulator)
    const snapshot = await readOcr(device, extra.signal)
    const { item, matchedBy } = resolveOcrTextTarget(
      filterOcrItems(snapshot.items, args.query, minConfidence), args.query, snapshot.items, minConfidence)
    const normalized = pixelRectToNormalizedCenter(item.rect, snapshot.pixelSize)
    const tapArgs: SimInteractArgs = {
      action: 'tap',
      x: Math.round(normalized.x * 10_000) / 10_000,
      y: Math.round(normalized.y * 10_000) / 10_000,
    }
    const pointRect = pixelRectToPoints(item.rect, snapshot.pixelSize, snapshot.pointSize)
    let warning: string | undefined
    if (info === undefined) {
      // WebDriverAgent taps in points of the upright app window.
      const center = frameCenter(pointRect)
      await device.tap(center.x, center.y, extra.signal)
    } else {
      // Screenshots are upright in the interface orientation; serve-sim takes
      // portrait framebuffer coordinates, so a landscape image is mapped.
      let framebufferArgs = tapArgs
      if (snapshot.pixelSize.width > snapshot.pixelSize.height) {
        const orientation = (await readSimScreenConfig(info.wsUrl))?.orientation ?? 'portrait'
        if (isLandscape(orientation)) framebufferArgs = toFramebufferArgs(orientation, tapArgs)
        else warning = IMAGE_LANDSCAPE_UNSYNCED_WARNING
      }
      try {
        await performSimInteract(deps.host, device.udid, framebufferArgs, interactControlArgs(framebufferArgs))
      } catch (error) {
        throw new Error(`serve-sim tap failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    await sleep(deps.settleMs)
    const expected = await runExpectation(device, expectation, extra.signal)
    return withScreenshot(device, {
      action: 'tap-text',
      text: item.text,
      confidence: round2(item.confidence),
      matchedBy,
      rect: roundFrame(pointRect),
      center: frameCenter(pointRect),
      tap: { x: tapArgs.x, y: tapArgs.y },
      device: device.summary,
      ...(expected === undefined ? {} : { expected }),
      ...(warning === undefined ? {} : { warning }),
      ...(snapshot.note === undefined ? {} : { note: snapshot.note }),
    }, args.screenshot, extra.signal)
  }))

  const outputRow = (row: ListRow): Record<string, unknown> => ({
    index: row.index,
    type: row.type,
    frame: row.frame,
    ...(row.label === undefined ? {} : { label: row.label }),
    counts: row.counts.map(count => ({ key: count.key, value: round2(count.value) })),
    ...(row.group === undefined ? {} : { group: row.group }),
  })

  server.registerTool('ios_sim_ui_rows', {
    title: 'Read list rows',
    description: 'Read the visible rows of a list or feed on a booted simulator (AXe): each row\'s 0-based index, '
      + 'frame in points, aggregated label, and the counters parsed from that label (number + classifier, e.g. '
      + '"57 回复" → 回复=57, 中文 or English). Feed apps fold one whole item into a single cell whose label holds the '
      + 'summary and its counters, with NO child buttons to match — so reach controls inside a row with '
      + 'ios_sim_tap_row. Counter keys round-trip: pass one exactly as listed to ios_sim_tap_row.expect_count. '
      + 'Off-screen rows are excluded and counted as omittedOffscreen; with no rows, hint says why.',
    inputSchema: { udid: UDID_PARAM },
    annotations: { readOnlyHint: true },
  }, async (args, extra) => runTool('ios_sim_ui_rows', async () => {
    const device = await uiTarget('ios_sim_ui_rows', args.udid)
    const { roots } = await device.readTree(extra.signal, ROW_SNAPSHOT_DEPTH)
    const size = screenBounds(roots)
    const detected = detectListRows(roots, { bounds: size })
    const hint = detected.rows.length > 0
      ? undefined
      : hasLabeledNode(roots)
        ? 'No repeated rows detected: this screen may not be a list, or its rows use a shape this pass does not '
          + 'recognize. Its labeled elements are in ios_sim_ui_tree — drive those with ios_sim_tap_element.'
        : OCR_FALLBACK_HINT
    return jsonResult({
      device: device.summary,
      size: { width: round2(size.width), height: round2(size.height) },
      rowCount: detected.rows.length,
      repeatedGroups: detected.repeatedGroups,
      omittedOffscreen: detected.omittedOffscreen,
      rows: detected.rows.map(outputRow),
      ...(hint === undefined ? {} : { hint }),
      note: 'Counters are parsed heuristically from row labels; pass a key exactly as listed to ios_sim_tap_row.expect_count.',
    })
  }))

  server.registerTool('ios_sim_tap_row', {
    title: 'Tap inside a list row',
    description: 'Tap at a RELATIVE position inside one visible list row of a booted simulator (AXe): row is the '
      + '0-based index ios_sim_ui_rows reports, x/y are fractions of that row\'s frame (0 = left/top, 1 = '
      + 'right/bottom, default 0.5; a right-side action button is often near x=0.9). The row is re-located in a '
      + 'FRESH tree read and an out-of-range index fails instead of clamping. With expect_count {key, delta: +1 '
      + 'or -1} the row is re-read after the tap and countCheck.verified says whether that counter moved by '
      + 'exactly delta; a key the row does not carry is refused BEFORE tapping — never probe an unidentified '
      + 'control. The effect screenshot comes back as an image.',
    inputSchema: {
      udid: UDID_PARAM,
      row: z.number().int().min(0).describe('0-based row index exactly as ios_sim_ui_rows reported it'),
      x: z.number().min(0).max(1).optional().describe('Horizontal fraction of the row frame (default 0.5)'),
      y: z.number().min(0).max(1).optional().describe('Vertical fraction of the row frame (default 0.5)'),
      expect_count: z.object({
        key: z.string().trim().min(1).describe('Counter key exactly as ios_sim_ui_rows listed it'),
        delta: z.number().int().describe('Expected change: +1 or -1'),
      }).optional(),
      screenshot: SCREENSHOT_PARAM,
    },
  }, async (args, extra) => runTool('ios_sim_tap_row', async () => {
    const expectation = args.expect_count === undefined
      ? undefined
      : { key: args.expect_count.key, delta: sanitizeCountDelta(args.expect_count.delta) }
    const device = await uiTarget('ios_sim_tap_row', args.udid)
    const { roots } = await device.readTree(extra.signal, ROW_SNAPSHOT_DEPTH)
    const bounds = screenBounds(roots)
    const plan = planRowTap(detectListRows(roots, { bounds }).rows, args.row, args.x ?? 0.5, args.y ?? 0.5, bounds)
    const before = expectation === undefined ? undefined : requireCountKey(plan.row, expectation.key)
    await device.tap(plan.tap.x, plan.tap.y, extra.signal)
    let countCheck: CountCheckResult | undefined
    if (expectation !== undefined) {
      await sleep(deps.rowSettleMs)
      const { roots: afterRoots } = await device.readTree(extra.signal, ROW_SNAPSHOT_DEPTH)
      const afterRow = detectListRows(afterRoots, { bounds: screenBounds(afterRoots) }).rows.find(row => row.index === plan.row.index)
      countCheck = afterRow === undefined
        ? { key: expectation.key, delta: expectation.delta, before, verified: false, changed: false, reason: 'the re-read tree no longer contains the row (the screen changed)' }
        : verifyCountChange(plan.row, afterRow, expectation.key, expectation.delta)
    } else {
      await sleep(deps.settleMs)
    }
    return withScreenshot(device, {
      action: 'tap-row',
      row: outputRow(plan.row),
      inRow: plan.inRow,
      tap: plan.tap,
      device: device.summary,
      ...(countCheck === undefined
        ? { note: 'No expect_count was given, so nothing was verified — re-run ios_sim_ui_rows and compare the counters if it matters.' }
        : { countCheck }),
    }, args.screenshot, extra.signal)
  }))
}
