import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compileElectron } from '../src/electron.ts'
import { validateInput } from '../src/validate.ts'

test('electron connect compiles an explicit port', () => {
  const result = compileElectron({ action: 'connect', port: 9222 })
  assert.equal(result.ok, true)
  if (result.ok) assert.deepEqual(result.args, ['connect', '9222'])
})

test('electron connect compiles an explicit CDP url', () => {
  const result = compileElectron({ action: 'connect', url: 'ws://127.0.0.1:9222/devtools/browser/x' })
  assert.equal(result.ok, true)
  if (result.ok) assert.deepEqual(result.args, ['connect', 'ws://127.0.0.1:9222/devtools/browser/x'])
})

test('electron connect requires exactly one explicit target', () => {
  assert.equal(compileElectron({ action: 'connect' }).ok, false)
  assert.equal(compileElectron({ action: 'connect', port: 9222, url: 'ws://x' }).ok, false)
})

test('electron connect validates port and url shape', () => {
  assert.equal(compileElectron({ action: 'connect', port: 0 }).ok, false)
  assert.equal(compileElectron({ action: 'connect', port: 70000 }).ok, false)
  assert.equal(compileElectron({ action: 'connect', port: 1.5 }).ok, false)
  assert.equal(compileElectron({ action: 'connect', url: 'file:///etc/passwd' }).ok, false)
})

test('electron probe is a read-only batch', () => {
  const result = compileElectron({ action: 'probe' })
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.deepEqual(result.args, ['batch'])
    assert.match(result.generatedStdin ?? '', /"get","url"/)
    assert.match(result.generatedStdin ?? '', /"tab","list"/)
  }
})

test('electron rejects unknown actions', () => {
  assert.equal(compileElectron({ action: 'launch' as never }).ok, false)
})

test('validate counts electron as an exclusive input mode', () => {
  const ok = validateInput({ electron: { action: 'connect', port: 9222 } })
  assert.equal(ok.ok, true)
  if (ok.ok) assert.equal(ok.kind, 'electron')
  assert.equal(validateInput({ args: ['snapshot'], electron: { action: 'probe' } }).ok, false)
  assert.equal(validateInput({ electron: { action: 'probe' }, stdin: 'x' }).ok, false)
})
