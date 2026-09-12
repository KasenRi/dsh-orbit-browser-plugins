import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildArgv, parseEnvelope, resolveExecutable } from '../src/cli.ts'
import { normalizeAgentBrowserVersion } from '../src/doctor.ts'

test('builds argv with json and session', () => {
  const argv = buildArgv({ args: ['open', 'https://x'], sessionName: 'dshab-x' })
  assert.deepEqual(argv, ['--json', '--session', 'dshab-x', 'open', 'https://x'])
})

test('parses object envelope', () => {
  const parsed = parseEnvelope('{"success":true,"data":{"origin":"https://x"}}')
  assert.ok(!('error' in parsed))
  if (!('error' in parsed)) {
    assert.equal(parsed.success, true)
    assert.deepEqual(parsed.data, { origin: 'https://x' })
  }
})

test('parses array envelope', () => {
  const parsed = parseEnvelope('[{"success":true},{"success":true}]')
  assert.ok(!('error' in parsed))
  if (!('error' in parsed)) assert.equal(parsed.success, true)
})

test('rejects missing success field', () => {
  const parsed = parseEnvelope('{"data":1}')
  assert.ok('error' in parsed)
})

test('rejects invalid json', () => {
  const parsed = parseEnvelope('not json')
  assert.ok('error' in parsed)
})

test('resolves executable on PATH', () => {
  const resolved = resolveExecutable('sh', process.env.PATH)
  assert.equal(resolved, '/usr/bin/sh')
})

test('missing executable resolves undefined', () => {
  assert.equal(resolveExecutable('definitely-not-a-real-binary-xyz', process.env.PATH), undefined)
})

test('normalizes agent-browser version output', () => {
  assert.equal(normalizeAgentBrowserVersion('agent-browser 0.33.2'), '0.33.2')
  assert.equal(normalizeAgentBrowserVersion('0.33.2\n'), '0.33.2')
  assert.equal(normalizeAgentBrowserVersion('nope'), undefined)
})
