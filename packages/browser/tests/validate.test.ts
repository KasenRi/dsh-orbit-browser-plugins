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

test('args + stdin is accepted only for whitelisted upstream commands', () => {
  const batch = validateInput({ args: ['batch'], stdin: '[]' })
  assert.equal(batch.ok, true)
  if (batch.ok) {
    assert.equal(batch.stdin, '[]')
    assert.equal(batch.providesStdin, true)
  }
  assert.equal(validateInput({ args: ['eval', '--stdin'], stdin: '1+1' }).ok, true)
  assert.equal(validateInput({ args: ['auth', 'save', 'x', '--password-stdin'], stdin: 'pw' }).ok, true)
  const rejected = validateInput({ args: ['open', 'https://example.com'], stdin: 'secret' })
  assert.equal(rejected.ok, false)
  if (!rejected.ok) assert.match(rejected.message, /stdin is only supported/)
})

test('job and qa carry artifact requests from compiled steps', () => {
  const job = validateInput({
    job: { steps: [{ action: 'open', url: 'https://example.com' }, { action: 'screenshot', path: '/tmp/job.png' }] },
  })
  assert.equal(job.ok, true)
  if (job.ok) assert.deepEqual(job.artifactRequests, [{ requestedPath: '/tmp/job.png', kind: 'image' }])
  assert.equal(job.ok && job.providesStdin, true)

  const qa = validateInput({ qa: { url: 'https://example.com', screenshotPath: '/tmp/qa.png' } })
  assert.equal(qa.ok, true)
  if (qa.ok) assert.deepEqual(qa.artifactRequests, [{ requestedPath: '/tmp/qa.png', kind: 'image' }])
})
