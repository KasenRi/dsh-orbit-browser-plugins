import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import {
  buildFreshSessionName,
  buildImplicitSessionName,
  decideSession,
  hasExplicitSession,
  launchScopedFlags,
} from '../src/session.ts'

test('implicit session name is stable and cwd-scoped', () => {
  const a = buildImplicitSessionName('12345678-1234-1234-1234-1234567890ab', '/tmp/projects/demo')
  const b = buildImplicitSessionName('12345678-1234-1234-1234-1234567890ab', '/tmp/projects/demo')
  const c = buildImplicitSessionName('12345678-1234-1234-1234-1234567890ab', '/tmp/projects/other')
  assert.equal(a, b)
  assert.notEqual(a, c)
  assert.ok(a.startsWith('dshab-'))
})

test('fresh session name differs each time', () => {
  const base = buildImplicitSessionName('12345678-1234-1234-1234-1234567890ab', '/tmp/projects/demo')
  assert.notEqual(buildFreshSessionName(base), buildFreshSessionName(base))
})

test('detects explicit session and launch flags', () => {
  assert.ok(hasExplicitSession(['--session', 'x']))
  assert.ok(hasExplicitSession(['--session=x']))
  assert.deepEqual(launchScopedFlags(['open', '--profile', 'p', 'https://x']), ['--profile'])
})

test('auto mode injects implicit session', () => {
  const decision = decideSession(['open', 'https://example.com'], 'auto', 'dshab-x', false)
  assert.equal(decision.sessionName, 'dshab-x')
  assert.equal(decision.usedImplicitSession, true)
})

test('explizit session wins', () => {
  const decision = decideSession(['--session', 'user', 'open', 'https://x'], 'auto', 'dshab-x', true)
  assert.equal(decision.sessionName, undefined)
  assert.equal(decision.usedImplicitSession, false)
})

test('launch flags on active implicit session require fresh', () => {
  const decision = decideSession(['open', '--headed', 'https://x'], 'auto', 'dshab-x', true)
  assert.ok(decision.launchFlagError)
  assert.deepEqual(decision.sessionRecoveryHint, { recommendedSessionMode: 'fresh' })
})

test('fresh mode always generates a fresh session', () => {
  const decision = decideSession(['open', 'https://x'], 'fresh', 'dshab-x', true)
  assert.ok(decision.sessionName?.includes('-fresh-'))
})

test('plain text inspection needs no session', () => {
  const decision = decideSession(['--version'], 'auto', 'dshab-x', false)
  assert.equal(decision.sessionName, undefined)
})
