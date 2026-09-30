import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  detectListRows,
  parseCountsFromLabel,
  planRowTap,
  requireCountKey,
  sanitizeCountDelta,
  verifyCountChange,
} from '../src/list-rows.js'
import { feedTree, node } from './helpers/ui-fixtures.js'

const bounds = { width: 402, height: 874 }

test('parseCountsFromLabel reads number + classifier pairs in Chinese and English, with units', () => {
  assert.deepEqual(parseCountsFromLabel('57 回复。18 喜欢。592 次查看'), [
    { key: '回复', value: 57 },
    { key: '喜欢', value: 18 },
    { key: '次查看', value: 592 },
  ])
  assert.deepEqual(parseCountsFromLabel('1,204 likes, 3.2k views'), [{ key: 'likes', value: 1204 }, { key: 'views', value: 3200 }])
  assert.deepEqual(parseCountsFromLabel('3.2W 赞 1.5万 转发'), [{ key: '赞', value: 32000 }, { key: '转发', value: 15000 }])
  assert.deepEqual(parseCountsFromLabel('serial 1A215'), [])
})

test('detectListRows finds visible cells top to bottom, groups isomorphic ones, drops off-screen ones', () => {
  const roots = feedTree()
  roots[0]!.children.push(node('Cell', { x: 0, y: 2000, w: 402, h: 150 }, { label: 'Post 9. 1 回复' }))
  const detected = detectListRows(roots, { bounds })
  assert.deepEqual(detected.rows.map(row => row.index), [0, 1, 2])
  assert.equal(detected.repeatedGroups, 1)
  assert.equal(detected.omittedOffscreen, 1)
  assert.deepEqual(detected.rows[0]!.counts, [{ key: '回复', value: 57 }, { key: '喜欢', value: 18 }])
})

test('detectListRows falls back to repeated full-width labeled containers without controls', () => {
  const row = (y: number, label: string) => node('Other', { x: 0, y, w: 402, h: 120 }, {
    children: [node('StaticText', { x: 16, y: y + 10, w: 300, h: 20 }, { label })],
  })
  const roots = [node('Application', { x: 0, y: 0, w: 402, h: 874 }, { children: [row(100, 'A 5 likes'), row(220, 'B 6 likes')] })]
  const detected = detectListRows(roots, { bounds })
  assert.equal(detected.fallbackRows, 2)
  assert.deepEqual(detected.rows.map(entry => entry.label), ['A 5 likes', 'B 6 likes'])
})

test('planRowTap maps row fractions to points and never clamps an out-of-range index', () => {
  const rows = detectListRows(feedTree(), { bounds }).rows
  const plan = planRowTap(rows, 1, 0.9, 0.5, bounds)
  assert.deepEqual(plan.tap, { x: 361.8, y: 325 })
  assert.throws(() => planRowTap(rows, 3, 0.5, 0.5, bounds), /row 3 does not exist — the current screen has 3 visible row/)
  assert.throws(() => planRowTap(rows, 0, 1.2, 0.5, bounds), /x must be a fraction within 0..1/)
})

test('requireCountKey refuses a key the row does not carry, before any tap', () => {
  const [row] = detectListRows(feedTree(), { bounds }).rows
  assert.equal(requireCountKey(row!, '喜欢'), 18)
  assert.throws(() => requireCountKey(row!, 'likes'), /the row label parses to: 回复=57, 喜欢=18/)
  assert.throws(() => sanitizeCountDelta(2), /\+1 or -1/)
})

test('verifyCountChange verifies an exact ±1 move and explains anything else', () => {
  const before = detectListRows(feedTree([[57, 18]]), { bounds }).rows[0]!
  const liked = detectListRows(feedTree([[57, 19]]), { bounds }).rows[0]!
  assert.deepEqual(verifyCountChange(before, liked, '喜欢', 1), { key: '喜欢', delta: 1, before: 18, after: 19, verified: true, changed: true })
  const wrong = verifyCountChange(before, liked, '喜欢', -1)
  assert.equal(wrong.verified, false)
  assert.match(wrong.reason ?? '', /moved by 1, not the expected -1/)
  const moved = { ...liked, frame: { ...liked.frame, y: liked.frame.y + 300 } }
  assert.match(verifyCountChange(before, moved, '喜欢', 1).reason ?? '', /the row moved/)
})
