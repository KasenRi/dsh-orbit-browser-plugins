import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  checkAllowedDomains,
  findProtectedStateViolation,
  isHostAllowedByDomains,
  parseAllowedDomains,
  redactArgs,
  redactText,
  redactValue,
  sanitizeEnv,
} from '../src/security.ts'

test('redacts bearer and key-value secrets', () => {
  assert.equal(redactText('Authorization: Bearer abc.def.ghi'), 'Authorization: Bearer [REDACTED]')
  assert.match(redactText('api_key=supersecret'), /\[REDACTED\]/)
  assert.doesNotMatch(redactText('api_key=supersecret'), /supersecret/)
})

test('redacts sensitive keys recursively', () => {
  const value = redactValue({ password: 'p', nested: { cookie: 'c', keep: 'k' } })
  assert.deepEqual(value, { password: '[REDACTED]', nested: { cookie: '[REDACTED]', keep: 'k' } })
})

test('redacts sensitive flag values but keeps position', () => {
  assert.deepEqual(redactArgs(['curl', '--headers', '{"authorization":"x"}', 'url']), [
    'curl',
    '--headers',
    '[REDACTED]',
    'url',
  ])
  assert.deepEqual(redactArgs(['--password=abc']), ['--password=[REDACTED]'])
})

test('blocks protected browser state operands', () => {
  assert.ok(findProtectedStateViolation(['open', '/root/.agent-browser/state.json']))
  assert.ok(findProtectedStateViolation(['open', 'file:///root/x']))
  assert.ok(findProtectedStateViolation(['open', '--config', 'x.yml']))
  assert.equal(findProtectedStateViolation(['open', 'https://example.com']), undefined)
})

test('sanitizes redirected browser env', () => {
  const env = sanitizeEnv({ AGENT_BROWSER_STATE: '/x', AGENT_BROWSER_PROFILE: '/y', KEEP: '1' })
  assert.deepEqual(env, { KEEP: '1' })
})

test('parses and enforces allowed domains', () => {
  const domains = parseAllowedDomains(['*.Example.com, https://foo.test:8443/path', 'bar.test'])
  assert.ok(domains.includes('example.com'))
  assert.ok(domains.includes('foo.test'))
  assert.ok(isHostAllowedByDomains('api.example.com', domains))
  assert.ok(!isHostAllowedByDomains('evil.test', domains))
  assert.ok(checkAllowedDomains('https://evil.test/', domains))
  assert.equal(checkAllowedDomains('https://api.example.com/', domains), undefined)
})
