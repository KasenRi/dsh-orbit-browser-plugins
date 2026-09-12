import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateInput } from '../src/validate.ts'

test('requires exactly one input mode', () => {
  const result = validateInput({})
  assert.equal(result.ok, false)
})

test('rejects multiple input modes', () => {
  const result = validateInput({ args: ['open', 'x'], job: { steps: [{ action: 'snapshot' }] } })
  assert.equal(result.ok, false)
})

test('accepts raw args mode', () => {
  const result = validateInput({ args: ['open', 'https://example.com'] })
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.kind, 'args')
    assert.deepEqual(result.args, ['open', 'https://example.com'])
    assert.equal(result.sessionMode, 'auto')
  }
})

test('rejects stdin with generated modes', () => {
  const result = validateInput({ job: { steps: [{ action: 'snapshot' }] }, stdin: '[]' })
  assert.equal(result.ok, false)
})

test('rejects invalid timeoutMs', () => {
  const result = validateInput({ args: ['snapshot'], timeoutMs: 0 })
  assert.equal(result.ok, false)
})

test('rejects empty outputPath', () => {
  const result = validateInput({ args: ['snapshot'], outputPath: '' })
  assert.equal(result.ok, false)
})

test('rejects qa.attached with sessionMode fresh', () => {
  const result = validateInput({ qa: { attached: true }, sessionMode: 'fresh' })
  assert.equal(result.ok, false)
})

test('compiles semanticAction into args', () => {
  const result = validateInput({ semanticAction: { action: 'click', role: 'button', name: 'Submit' } })
  assert.equal(result.ok, true)
  if (result.ok) assert.deepEqual(result.args, ['find', 'role', 'button', 'click', '--name', 'Submit'])
})

test('compiles job into batch stdin', () => {
  const result = validateInput({ job: { steps: [{ action: 'open', url: 'https://example.com' }, { action: 'snapshot' }] } })
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.providesStdin, true)
    assert.deepEqual(result.args, ['batch', '--bail'])
    assert.deepEqual(JSON.parse(result.generatedStdin ?? '[]'), [
      ['open', 'https://example.com'],
      ['snapshot', '-i'],
    ])
  }
})
