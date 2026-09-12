import { test } from 'node:test'
import assert from 'node:assert/strict'
import { guardBashCommand, guardToolPath, guardReason } from '../src/guard.ts'

test('blocks github remote writes when not allowed', () => {
  const decision = guardBashCommand('git push origin main', { github_allowed: false })
  assert.equal(decision.allowed, false)
  if (!decision.allowed) assert.equal(decision.code, 'github_remote_write')
})

test('allows github remote writes when explicitly allowed', () => {
  assert.equal(guardBashCommand('git push origin main', { github_allowed: true }).allowed, true)
})

test('blocks destructive operations', () => {
  const rm = guardBashCommand('rm -rf /tmp/x')
  const reset = guardBashCommand('git reset --hard HEAD~1')
  assert.equal(rm.allowed, false)
  assert.equal(reset.allowed, false)
})

test('blocks production operations', () => {
  assert.equal(guardBashCommand('kubectl apply -f prod.yaml').allowed, false)
  assert.equal(guardBashCommand('terraform apply').allowed, false)
})

test('blocks bare secret reads but allows benign env assignments', () => {
  assert.equal(guardBashCommand('printenv').allowed, false)
  assert.equal(guardBashCommand('printenv OPENAI_API_KEY').allowed, false)
  assert.equal(guardBashCommand('cat .env').allowed, false)
  assert.equal(guardBashCommand('env TMPDIR=/tmp/test npm test').allowed, true)
  assert.equal(guardBashCommand('env VAL_MAP_ELECTRON_APPDATA_ROOT=/tmp/a command').allowed, true)
})

test('blocks export of secrets', () => {
  assert.equal(guardBashCommand('export PASSWORD=abc').allowed, false)
  assert.equal(guardBashCommand('export PATH=/usr/bin').allowed, true)
})

test('blocks durable .cx writes', () => {
  assert.equal(guardBashCommand('echo {} > .cx/state.json').allowed, false)
  assert.equal(guardBashCommand('sed -i s/a/b/ .cx/state.json').allowed, false)
  assert.equal(guardBashCommand('rm .cx/state.json').allowed, false)
})

test('allows ordinary read-only shell', () => {
  assert.equal(guardBashCommand('git status --short').allowed, true)
  assert.equal(guardBashCommand('cat README.md').allowed, true)
})

test('guard reason mentions the code', () => {
  const decision = guardBashCommand('printenv')
  assert.equal(decision.allowed, false)
  if (!decision.allowed) assert.match(guardReason(decision), /secret_operation/)
})

test('guards write tools targeting .cx', () => {
  const blocked = guardToolPath('write', '.cx/state.json', { cwd: '/proj' })
  assert.equal(blocked.allowed, false)
  if (!blocked.allowed) assert.equal(blocked.code, 'durable_state_write')
  assert.equal(guardToolPath('write', 'src/app.ts', { cwd: '/proj' }).allowed, true)
  assert.equal(guardToolPath('read', '.cx/state.json', { cwd: '/proj' }).allowed, true)
})
