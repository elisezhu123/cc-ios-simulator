import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { OcrItem } from '../src/ocr-backend.js'
import {
  buildTreeResult,
  capList,
  frameCenter,
  OCR_FALLBACK_HINT,
  pollForText,
  resolveOcrTextTarget,
  resolveTapTarget,
  sanitizeMinConfidence,
  screenBounds,
  tapExpectation,
  type UiTreeNode,
} from '../src/uitree.js'
import { feedTree, node, settingsTree } from './helpers/ui-fixtures.js'

const labels = (nodes: readonly UiTreeNode[]): string[] =>
  nodes.flatMap(entry => [...(entry.label === undefined ? [] : [entry.label]), ...labels(entry.children)])

test('buildTreeResult drops off-screen subtrees by default and counts them', () => {
  const roots = settingsTree()
  const result = buildTreeResult(roots, screenBounds(roots), {})
  assert.deepEqual(result.size, { width: 402, height: 874 })
  assert.equal(result.omittedOffscreen, 2) // the off-screen cell and its text
  assert.ok(!labels(result.tree).includes('General Info'))
  assert.equal(result.hint, undefined)
  const all = buildTreeResult(roots, screenBounds(roots), { include_offscreen: true })
  assert.equal(all.omittedOffscreen, 0)
  assert.ok(labels(all.tree).includes('General Info'))
  assert.equal(all.nodeCount, result.nodeCount + 2)
})

test('buildTreeResult filters keep matching nodes with their ancestors, and a miss says so', () => {
  const roots = settingsTree()
  const filtered = buildTreeResult(roots, screenBounds(roots), { filter: 'privacy' })
  assert.deepEqual(labels(filtered.tree), ['Settings', 'Privacy & Security', 'Privacy & Security'])
  const miss = buildTreeResult(roots, screenBounds(roots), { filter: 'bluetooth' })
  assert.equal(miss.nodeCount, 0)
  assert.match(miss.hint ?? '', /matched nothing.*says nothing about the app/)
})

test('buildTreeResult max_depth caps nesting and blames the depth, not the app, for missing labels', () => {
  const roots = settingsTree()
  const shallow = buildTreeResult(roots, screenBounds(roots), { max_depth: 0 })
  assert.equal(shallow.nodeCount, 1)
  assert.match(shallow.hint ?? '', /max_depth 0 shows only container chrome/)
})

test('buildTreeResult blames the app only for a full, unlabeled read', () => {
  const roots = [node('Application', { x: 0, y: 0, w: 402, h: 874 }, { label: 'Game', children: [node('Other', { x: 0, y: 0, w: 402, h: 874 })] })]
  assert.equal(buildTreeResult(roots, screenBounds(roots), {}).hint, OCR_FALLBACK_HINT)
})

test('buildTreeResult prunes the deepest levels past the 40 KB cap', () => {
  const deep = (depth: number): ReturnType<typeof node> => node('Other', { x: 0, y: 0, w: 402, h: 874 }, {
    label: `level ${depth} ${'x'.repeat(200)}`,
    children: depth === 0 ? [] : Array.from({ length: 4 }, () => deep(depth - 1)),
  })
  const roots = [deep(6)]
  const result = buildTreeResult(roots, screenBounds(roots), {})
  assert.equal(result.truncated, true)
  assert.ok(Buffer.byteLength(JSON.stringify(result.tree)) <= 40 * 1024)
  assert.match(result.hint ?? '', /40 KB output cap/)
})

test('resolveTapTarget prefers an exact match and collapses a cell with its mirrored text', () => {
  const roots = settingsTree()
  const { element, matchedBy } = resolveTapTarget(roots, { label: 'General' })
  assert.equal(matchedBy, 'exact')
  assert.equal(element.type, 'Cell')
  assert.deepEqual(frameCenter(element.frame), { x: 201, y: 226 })
  assert.equal(resolveTapTarget(roots, { identifier: 'com.apple.settings.general' }).element.label, 'General')
})

test('resolveTapTarget falls back to contains and lists ambiguous candidates', () => {
  const roots = settingsTree()
  assert.equal(resolveTapTarget(roots, { label: 'accessib' }).matchedBy, 'contains')
  assert.throws(() => resolveTapTarget(roots, { label: 'edit ' }), /2 elements match label "edit".*\n {2}2\) type=Button label="Edit Profile"/s)
})

test('resolveTapTarget refuses off-screen and disabled matches with the fix', () => {
  const roots = settingsTree()
  assert.throws(() => resolveTapTarget(roots, { label: 'General Info' }), /matched an off-screen element — scroll it into view/)
  assert.equal(resolveTapTarget(roots, { label: 'General Info' }, { allowOffscreen: true }).element.label, 'General Info')
  assert.throws(() => resolveTapTarget(roots, { label: 'Privacy & Security' }), /matched a disabled element/)
  assert.throws(() => resolveTapTarget(roots, { label: 'Privacy & Security' }, { allowOffscreen: true }), /disabled stays refused/)
})

test('resolveTapTarget needs a selector and names the next step on a miss', () => {
  assert.throws(() => resolveTapTarget(settingsTree(), {}), /identifier and\/or label/)
  assert.throws(() => resolveTapTarget(settingsTree(), { label: 'Wi-Fi' }), /run ios_sim_ui_tree/)
  assert.throws(() => resolveTapTarget(feedTree(), { label: 'Like' }), /use ios_sim_ui_rows/)
})

const item = (text: string, confidence: number, x = 10, y = 10): OcrItem => ({ text, confidence, rect: { x, y, w: 100, h: 40 } })

test('resolveOcrTextTarget: exact, then contains, ambiguity and the below-threshold near miss', () => {
  const items = [item('Continue', 0.9, 10), item('Continue later', 0.8, 10, 200), item('继续', 0.4, 10, 400)]
  assert.equal(resolveOcrTextTarget(items, 'Continue').item.text, 'Continue')
  assert.throws(() => resolveOcrTextTarget(items, 'continue'), /2 OCR matches for "continue"/)
  const strong = items.filter(entry => entry.confidence >= 0.5)
  assert.throws(() => resolveOcrTextTarget(strong, '继续', items, 0.5), /"继续" IS on the current screen, but its OCR confidence 0.40 is below min_confidence 0.50/)
  assert.throws(() => resolveOcrTextTarget(items, 'Cancel'), /no recognized text matches "Cancel"/)
})

test('pollForText reports a match with its item, and a timeout as matched:false', async () => {
  const reads = [[item('Loading', 0.9)], [item('Loading', 0.9)], [item('Done', 0.9)]]
  let calls = 0
  const read = async (): Promise<OcrItem[]> => reads[Math.min(calls++, reads.length - 1)]!
  const appeared = await pollForText(read, 'done', 'appear', 5000, 0, 0.3)
  assert.equal(appeared.matched, true)
  assert.equal(appeared.item?.text, 'Done')
  assert.equal(calls, 3)
  const gone = await pollForText(async () => [item('Loading', 0.9)], 'Loading', 'disappear', 0, 0, 0.3)
  assert.deepEqual([gone.matched, gone.item], [false, undefined])
})

test('argument guards: min_confidence range, expect_text vs expect_gone, list cap', () => {
  assert.equal(sanitizeMinConfidence(undefined), 0.3)
  assert.throws(() => sanitizeMinConfidence(1.5), /within 0..1/)
  assert.deepEqual(tapExpectation({ expect_gone: ' Save ' }), { text: 'Save', mode: 'disappear' })
  assert.throws(() => tapExpectation({ expect_text: 'a', expect_gone: 'b' }), /not both/)
  const capped = capList(Array.from({ length: 2000 }, (_, index) => ({ text: `item ${index}`.padEnd(40, '.') })))
  assert.equal(capped.truncated, true)
  assert.ok(Buffer.byteLength(JSON.stringify(capped.items)) <= 40 * 1024)
})
