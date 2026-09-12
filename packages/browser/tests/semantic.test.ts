import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compileSemanticAction } from '../src/semantic.ts'

test('click with selector compiles to direct command', () => {
  const result = compileSemanticAction({ action: 'click', selector: '#submit' })
  assert.equal(result.ok, true)
  if (result.ok) assert.deepEqual(result.args, ['click', '#submit'])
})

test('fill with locator compiles to find fill', () => {
  const result = compileSemanticAction({ action: 'fill', locator: 'label', value: 'Email', text: 'a@b.c' })
  assert.equal(result.ok, true)
  if (result.ok) assert.deepEqual(result.args, ['find', 'label', 'Email', 'fill', 'a@b.c'])
})

test('select requires selector and values', () => {
  const missing = compileSemanticAction({ action: 'select', selector: '#c' })
  assert.equal(missing.ok, false)
  const ok = compileSemanticAction({ action: 'select', selector: '#c', values: ['a', 'b'] })
  assert.equal(ok.ok, true)
  if (ok.ok) assert.deepEqual(ok.args, ['select', '#c', 'a', 'b'])
})

test('rejects selector combined with locator', () => {
  const result = compileSemanticAction({ action: 'click', selector: '#x', value: 'X' })
  assert.equal(result.ok, false)
})

test('fill requires text', () => {
  const result = compileSemanticAction({ action: 'fill', selector: '#x' })
  assert.equal(result.ok, false)
})

test('session prefix is preserved', () => {
  const result = compileSemanticAction({ action: 'click', selector: '#x', session: 's1' })
  assert.equal(result.ok, true)
  if (result.ok) assert.deepEqual(result.args, ['--session', 's1', 'click', '#x'])
})
