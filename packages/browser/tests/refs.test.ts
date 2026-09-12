import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkBatchRefOrdering, checkRefSafety, parseSnapshotRefs } from '../src/refs.ts'

const snapshot = {
  refIds: ['e1', 'e2'],
  refs: { e1: { role: 'button', name: 'Go' }, e2: { role: 'textbox' } },
  target: { url: 'https://example.com/page' },
}

test('parses refs from snapshot data', () => {
  const parsed = parseSnapshotRefs({ origin: 'https://example.com', refs: { e1: { role: 'button' }, e2: {} } })
  assert.deepEqual(parsed?.refIds.sort(), ['e1', 'e2'])
  assert.equal(parsed?.target.url, 'https://example.com')
})

test('parses refs from snapshot text fallback', () => {
  const parsed = parseSnapshotRefs({ snapshot: '- button "Go" [ref=e1]\n- textbox [ref=e2]' })
  assert.deepEqual(parsed?.refIds.sort(), ['e1', 'e2'])
})

test('allows refs present in the same page snapshot', () => {
  const check = checkRefSafety('click', ['@e1'], snapshot, { url: 'https://example.com/page' })
  assert.equal(check.ok, true)
})

test('blocks refs from a different page (fragment ignored)', () => {
  const ok = checkRefSafety('click', ['@e1'], snapshot, { url: 'https://example.com/page#section' })
  assert.equal(ok.ok, true)
  const blocked = checkRefSafety('click', ['@e1'], snapshot, { url: 'https://other.test/' })
  assert.equal(blocked.ok, false)
  assert.equal(blocked.category, 'stale-ref')
})

test('blocks refs missing from the latest snapshot', () => {
  const check = checkRefSafety('click', ['@e9'], snapshot, { url: 'https://example.com/page' })
  assert.equal(check.ok, false)
})

test('blocks refs with no snapshot at all', () => {
  const check = checkRefSafety('fill', ['@e1', 'value'], undefined, { url: 'https://example.com/page' })
  assert.equal(check.ok, false)
})

test('blocks refs invalidated by no-active-page', () => {
  const check = checkRefSafety('click', ['@e1'], { ...snapshot, invalidated: 'no-active-page' }, { url: 'https://example.com/page' })
  assert.equal(check.ok, false)
})

test('batch ordering blocks ref after navigation', () => {
  const check = checkBatchRefOrdering([
    ['open', 'https://example.com'],
    ['click', '@e1'],
  ])
  assert.equal(check.ok, false)
})

test('batch ordering allows ref after snapshot', () => {
  const check = checkBatchRefOrdering([
    ['open', 'https://example.com'],
    ['snapshot', '-i'],
    ['click', '@e1'],
  ])
  assert.equal(check.ok, true)
})
