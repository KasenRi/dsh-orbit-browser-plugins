import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import {
  AGENT_ORBIT_COMMAND,
  buildOrbitActivationDirective,
  invokedOrbitActivation,
  parseOrbitActivation,
} from '../src/activation.ts'

const userMessage = (text: string) =>
  createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })

test('parses /agent-orbit goals exactly', () => {
  assert.equal(AGENT_ORBIT_COMMAND, 'agent-orbit')
  assert.deepEqual(parseOrbitActivation('/agent-orbit foo'), { goal: 'foo' })
  assert.deepEqual(parseOrbitActivation('/agent-orbit     foo'), { goal: 'foo' })
  assert.deepEqual(parseOrbitActivation('/agent-orbit'), { goal: '' })
  assert.deepEqual(parseOrbitActivation('/agent-orbit   '), { goal: '' })
  assert.deepEqual(parseOrbitActivation('  /agent-orbit foo'), { goal: 'foo' })
})

test('preserves the goal without semantic rewriting', () => {
  const goal = '修复 auth 模块，保持 API 不变，然后运行 npm test'
  assert.deepEqual(parseOrbitActivation(`/agent-orbit ${goal}`), { goal })
  assert.deepEqual(parseOrbitActivation(`/agent-orbit   ${goal}  `), { goal })
  assert.deepEqual(parseOrbitActivation('/agent-orbit line one\nline two'), { goal: 'line one\nline two' })
})

test('does not treat mid-sentence or near-miss text as a gesture', () => {
  assert.equal(parseOrbitActivation('foo /agent-orbit bar'), undefined)
  assert.equal(parseOrbitActivation('请解释 /agent-orbit'), undefined)
  assert.equal(parseOrbitActivation('README 里写了 "/agent-orbit foo"'), undefined)
  assert.equal(parseOrbitActivation('/agent-orbits foo'), undefined)
  assert.equal(parseOrbitActivation('/agent-orbitx'), undefined)
  assert.equal(parseOrbitActivation('/agent-orbit-foo'), undefined)
  assert.equal(parseOrbitActivation('agent-orbit foo'), undefined)
})

test('only genuine user messages activate', () => {
  const invocation = invokedOrbitActivation([userMessage('/agent-orbit genuine')])
  assert.deepEqual(invocation, { goal: 'genuine' })

  const pluginMessage = createUserMessage({
    content: [{ type: 'text', text: '/agent-orbit plugin' }],
    source: { kind: 'plugin', plugin: 'dsh-orbit' },
  })
  assert.equal(invokedOrbitActivation([pluginMessage]), undefined)

  const directive = createUserMessage({
    content: [{ type: 'text', text: 'Orbit activation is explicit for this turn.' }],
    source: { kind: 'orbit-command', goal: 'x' },
  })
  assert.equal(invokedOrbitActivation([directive]), undefined)
})

test('the newest matching user message wins', () => {
  const invocation = invokedOrbitActivation([
    userMessage('/agent-orbit older'),
    userMessage('ordinary message'),
    userMessage('/agent-orbit newer'),
  ])
  assert.deepEqual(invocation, { goal: 'newer' })
})

test('activation directive states activation and carries the goal', () => {
  const directive = buildOrbitActivationDirective('ship the fix')
  assert.match(directive, /orbit_controller/)
  assert.match(directive, /Goal: ship the fix/)
  assert.doesNotMatch(directive, /ask the user what Orbit should accomplish/)
})

test('empty-goal directive asks for a goal instead of starting an empty run', () => {
  const directive = buildOrbitActivationDirective('')
  assert.match(directive, /ask the user what Orbit should accomplish/)
  assert.doesNotMatch(directive, /^Goal:/m)
})
