import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildPageChangeSummary, isAboutBlank, normalizeComparableUrl, targetsMatch } from '../src/page-change.ts'

test('navigation summary is produced for an explicit navigation', () => {
  const summary = buildPageChangeSummary({
    command: 'open',
    previousTarget: undefined,
    currentTarget: { url: 'https://example.test/page', title: 'Page' },
    refsRefreshed: false,
    artifactCount: 0,
  })
  assert.ok(summary)
  assert.equal(summary.changeType, 'navigation')
  assert.equal(summary.url, 'https://example.test/page')
  assert.match(summary.summary, /^open → navigation/)
  assert.ok(!('refsBefore' in summary))
  assert.ok(!('urlChanged' in summary))
})

test('URL change is reported, hash-only change is ignored', () => {
  const changed = buildPageChangeSummary({
    command: 'get',
    previousTarget: { url: 'https://a.test/' },
    currentTarget: { url: 'https://b.test/' },
    refsRefreshed: false,
    artifactCount: 0,
  })
  assert.ok(changed)
  assert.equal(changed.urlChanged, true)
  assert.equal(changed.activeTargetChanged, true)
  assert.equal(changed.previousUrl, 'https://a.test/')
  assert.match(changed.summary, /url https:\/\/a\.test\/ -> https:\/\/b\.test\//)

  const hashOnly = buildPageChangeSummary({
    command: 'get',
    previousTarget: { url: 'https://a.test/#one' },
    currentTarget: { url: 'https://a.test/#two' },
    refsRefreshed: false,
    artifactCount: 0,
  })
  assert.equal(hashOnly, undefined)
})

test('title change is reported as a mutation', () => {
  const summary = buildPageChangeSummary({
    command: 'get',
    previousTarget: { url: 'https://a.test/', title: 'Before' },
    currentTarget: { url: 'https://a.test/', title: 'After' },
    refsRefreshed: false,
    artifactCount: 0,
  })
  assert.ok(summary)
  assert.equal(summary.changeType, 'mutation')
  assert.equal(summary.titleChanged, true)
  assert.match(summary.summary, /title Before -> After/)
})

test('refs refreshed reports the ref count delta', () => {
  const summary = buildPageChangeSummary({
    command: 'snapshot',
    previousTarget: { url: 'https://a.test/' },
    currentTarget: { url: 'https://a.test/' },
    refsBefore: 3,
    refsAfter: 5,
    refsRefreshed: true,
    artifactCount: 0,
  })
  assert.ok(summary)
  assert.equal(summary.refsBefore, 3)
  assert.equal(summary.refsAfter, 5)
  assert.equal(summary.refsRefreshed, true)
  assert.match(summary.summary, /refs 3 -> 5/)
})

test('first snapshot omits refsBefore instead of emitting undefined', () => {
  const summary = buildPageChangeSummary({
    command: 'snapshot',
    previousTarget: { url: 'https://a.test/' },
    currentTarget: { url: 'https://a.test/' },
    refsAfter: 2,
    refsRefreshed: true,
    artifactCount: 0,
  })
  assert.ok(summary)
  assert.equal(summary.refsAfter, 2)
  assert.ok(!('refsBefore' in summary))
  assert.equal(JSON.stringify(summary).includes('undefined'), false)
})

test('artifact and confirmation changes are classified', () => {
  const artifact = buildPageChangeSummary({
    command: 'screenshot',
    previousTarget: { url: 'https://a.test/' },
    currentTarget: { url: 'https://a.test/' },
    refsRefreshed: false,
    artifactCount: 2,
  })
  assert.ok(artifact)
  assert.equal(artifact.changeType, 'artifact')
  assert.equal(artifact.artifactCount, 2)
  assert.match(artifact.summary, /2 artifacts/)

  const confirmation = buildPageChangeSummary({
    command: 'click',
    previousTarget: { url: 'https://a.test/' },
    currentTarget: { url: 'https://a.test/' },
    refsRefreshed: false,
    artifactCount: 0,
    confirmationRequired: true,
  })
  assert.ok(confirmation)
  assert.equal(confirmation.changeType, 'confirmation')
  assert.match(confirmation.summary, /confirmation required/)
})

test('recovery takes precedence and is marked', () => {
  const summary = buildPageChangeSummary({
    command: 'get',
    previousTarget: { url: 'https://a.test/' },
    currentTarget: { url: 'https://a.test/' },
    refsRefreshed: false,
    artifactCount: 0,
    recoveryApplied: true,
  })
  assert.ok(summary)
  assert.equal(summary.changeType, 'recovery')
  assert.equal(summary.recoveryApplied, true)
  assert.match(summary.summary, /tab recovery applied/)
})

test('no meaningful change returns undefined for a non-navigating command', () => {
  const summary = buildPageChangeSummary({
    command: 'get',
    previousTarget: { url: 'https://a.test/', title: 'Same' },
    currentTarget: { url: 'https://a.test/', title: 'Same' },
    refsRefreshed: false,
    artifactCount: 0,
  })
  assert.equal(summary, undefined)
})

test('summary stays bounded at 400 characters', () => {
  const long = (label: string) => `https://example.test/${label.repeat(300)}`
  const summary = buildPageChangeSummary({
    command: 'get',
    previousTarget: { url: long('a') },
    currentTarget: { url: long('b') },
    refsRefreshed: false,
    artifactCount: 0,
  })
  assert.ok(summary)
  assert.ok(summary.summary.length <= 400, `summary length ${summary.summary.length}`)
})

test('normalize and target helpers strip fragments and treat partial targets as matching', () => {
  assert.equal(normalizeComparableUrl('https://a.test/x#frag'), 'https://a.test/x')
  assert.equal(isAboutBlank('about:blank#x'), true)
  assert.equal(isAboutBlank('https://a.test/'), false)
  assert.equal(targetsMatch(undefined, { url: 'https://a.test/' }), true)
  assert.equal(targetsMatch({ url: 'https://a.test/x#a' }, { url: 'https://a.test/x#b' }), true)
  assert.equal(targetsMatch({ url: 'https://a.test/x' }, { url: 'https://a.test/y' }), false)
})
