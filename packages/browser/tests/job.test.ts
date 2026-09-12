import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compileJob, compileQa } from '../src/job.ts'

test('compiles a deterministic job with bail by default', () => {
  const result = compileJob({
    steps: [
      { action: 'open', url: 'https://example.com' },
      { action: 'snapshot' },
      { action: 'click', selector: '#go' },
    ],
  })
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.deepEqual(result.args, ['batch', '--bail'])
    assert.deepEqual(JSON.parse(result.stdin), [
      ['open', 'https://example.com'],
      ['snapshot', '-i'],
      ['click', '#go'],
    ])
  }
})

test('failFast false removes --bail', () => {
  const result = compileJob({ steps: [{ action: 'snapshot' }], failFast: false })
  assert.equal(result.ok, true)
  if (result.ok) assert.deepEqual(result.args, ['batch'])
})

test('rejects empty job', () => {
  const result = compileJob({ steps: [] })
  assert.equal(result.ok, false)
})

test('limits delayed typing', () => {
  const result = compileJob({ steps: [{ action: 'type', text: 'x'.repeat(201), delayMs: 10 }] })
  assert.equal(result.ok, false)
})

test('qa presets open and assert', () => {
  const result = compileQa({ url: 'https://example.com', expectedText: 'Example' })
  assert.equal(result.ok, true)
  if (result.ok) {
    const rows = JSON.parse(result.stdin) as string[][]
    assert.deepEqual(rows[0], ['network', 'requests', '--clear'])
    assert.ok(rows.some((row) => row[0] === 'open' && row[1] === 'https://example.com'))
    assert.ok(rows.some((row) => row[0] === 'wait' && row[1] === '--fn'))
  }
})

test('attached qa does not clear diagnostics', () => {
  const result = compileQa({ attached: true })
  assert.equal(result.ok, true)
  if (result.ok) {
    const rows = JSON.parse(result.stdin) as string[][]
    assert.equal(rows[0]?.[0], 'get')
  }
})

test('qa url required unless attached', () => {
  const result = compileQa({})
  assert.equal(result.ok, false)
})
