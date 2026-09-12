import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chooseRecoveryTab, detectTabDrift, parseTabList } from '../src/tab-drift.ts'

test('same target is not drift', () => {
  const result = detectTabDrift({ url: 'https://a.test/' }, { url: 'https://a.test/' }, 'snapshot')
  assert.equal(result.drift, false)
})

test('hash-only change is not drift', () => {
  const result = detectTabDrift({ url: 'https://a.test/#one' }, { url: 'https://a.test/#two' }, 'snapshot')
  assert.equal(result.drift, false)
})

test('expected page becoming about:blank is drift', () => {
  const result = detectTabDrift({ url: 'https://a.test/' }, { url: 'about:blank' }, 'snapshot')
  assert.equal(result.drift, true)
  assert.equal(result.reason, 'about-blank')
})

test('unexpected different URL is drift', () => {
  const result = detectTabDrift({ url: 'https://a.test/' }, { url: 'https://b.test/' }, 'get')
  assert.equal(result.drift, true)
  assert.equal(result.reason, 'target-changed')
})

test('explicit target commands never count as drift', () => {
  for (const command of ['open', 'goto', 'navigate', 'back', 'forward', 'reload', 'connect', 'tab', 'close']) {
    const result = detectTabDrift({ url: 'https://a.test/' }, { url: 'https://b.test/' }, command)
    assert.equal(result.drift, false, `${command} must be an intentional target change`)
  }
})

test('missing expected or observed target is not drift', () => {
  assert.equal(detectTabDrift(undefined, { url: 'https://b.test/' }, 'get').drift, false)
  assert.equal(detectTabDrift({ url: 'https://a.test/' }, undefined, 'get').drift, false)
})

test('parses the real agent-browser tab list shape', () => {
  const tabs = parseTabList({
    tabs: [
      { active: true, label: null, tabId: 't1', title: 'about:blank', type: 'page', url: 'about:blank' },
      { active: false, label: 'app', tabId: 't2', title: 'App', type: 'page', url: 'https://a.test/' },
    ],
  })
  assert.deepEqual(tabs, [
    { id: 't1', active: true, title: 'about:blank', url: 'about:blank' },
    { id: 't2', active: false, title: 'App', url: 'https://a.test/' },
  ])
})

test('parses a plain array and skips entries without an id', () => {
  const tabs = parseTabList([{ id: 't9', url: 'https://a.test/' }, { url: 'https://no-id.test/' }, null, 'nope'])
  assert.deepEqual(tabs, [{ id: 't9', active: false, url: 'https://a.test/' }])
  assert.deepEqual(parseTabList(undefined), [])
})

test('exactly one non-blank matching tab is recoverable', () => {
  const tab = chooseRecoveryTab({ url: 'https://a.test/' }, [
    { id: 't1', active: false, url: 'about:blank' },
    { id: 't2', active: false, url: 'https://a.test/' },
    { id: 't3', active: true, url: 'https://b.test/' },
  ])
  assert.equal(tab?.id, 't2')
})

test('ambiguous and missing matches are not recoverable', () => {
  const ambiguous = chooseRecoveryTab({ url: 'https://a.test/' }, [
    { id: 't1', active: false, url: 'https://a.test/' },
    { id: 't2', active: true, url: 'https://a.test/#frag' },
  ])
  assert.equal(ambiguous, undefined)

  const none = chooseRecoveryTab({ url: 'https://a.test/' }, [
    { id: 't1', active: true, url: 'https://b.test/' },
    { id: 't2', active: false, url: 'about:blank' },
  ])
  assert.equal(none, undefined)

  assert.equal(chooseRecoveryTab(undefined, [{ id: 't1', active: true, url: 'https://a.test/' }]), undefined)
})
