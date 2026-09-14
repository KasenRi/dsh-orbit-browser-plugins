import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Context } from '@deepseek-ai/cordis'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import {
  AGENT_ORBIT_COMMAND,
  buildOrbitActivationDirective,
  installOrbitGestureBoundary,
  invokedOrbitActivation,
  invokedOrbitMessage,
  parseOrbitActivation,
  registerOrbitToggleCommand,
} from '../src/activation.ts'
import { ORBIT_TOGGLE_COMMAND } from '../src/session-state.ts'

const userMessage = (text: string) =>
  createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })

const textOf = (message: { content: readonly { type: string; text?: string }[] }): string =>
  message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('\n')

type PreStepListener = (payload: {
  agent: { session: Session }
  messages: UserMessage[]
  turn: number
  step: number
  signal: AbortSignal
}, next: () => Promise<PreStepDecision>) => Promise<PreStepDecision>

/** Fire the installed boundary once with a fake agent and the given decision cut. */
async function fireBoundary(
  sessionEnabled: boolean,
  messages: UserMessage[],
  decisionMessages: UserMessage[] = [...messages],
): Promise<PreStepDecision> {
  let listener: PreStepListener | undefined
  const ctx = {
    on: (_event: string, fn: PreStepListener) => {
      listener = fn
    },
  } as unknown as Context
  installOrbitGestureBoundary(ctx, { sessionEnabled: () => sessionEnabled })
  assert.ok(listener)
  return listener(
    { agent: { session: {} as Session }, messages, turn: 1, step: 1, signal: new AbortController().signal },
    async () => ({ kind: 'enter', messages: [...decisionMessages] }),
  )
}

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

test('the newest genuine user message becomes the implicit goal', () => {
  assert.deepEqual(invokedOrbitMessage([userMessage('  fix it  ')])?.goal, 'fix it')
  assert.equal(invokedOrbitMessage([]), undefined)
  assert.deepEqual(invokedOrbitMessage([userMessage('older'), userMessage('newer')])?.goal, 'newer')
  const pluginMessage = createUserMessage({
    content: [{ type: 'text', text: 'plugin context' }],
    source: { kind: 'plugin', plugin: 'dsh-orbit' },
  })
  assert.equal(invokedOrbitMessage([pluginMessage]), undefined)
})

/** Narrow one decision to its entering messages. */
function enterMessages(decision: PreStepDecision): UserMessage[] {
  assert.equal(decision.kind, 'enter')
  if (decision.kind !== 'enter') throw new Error('expected an enter decision')
  return decision.messages
}

test('ordinary messages activate only when the Session toggle is on', async () => {
  const message = userMessage('fix the failing test')

  const off = await fireBoundary(false, [message])
  assert.deepEqual(enterMessages(off), [message])

  const on = await fireBoundary(true, [message])
  const entered = enterMessages(on)
  assert.equal(entered.length, 2)
  const directive = entered[1]
  assert.equal(directive?.source.kind, 'orbit-command')
  assert.equal((directive?.source as { goal?: string }).goal, 'fix the failing test')
  assert.match(textOf(directive as UserMessage), /Orbit is enabled for this chat/)
})

test('an explicit /agent-orbit always wins and never doubles', async () => {
  const message = userMessage('/agent-orbit explicit goal')

  const off = await fireBoundary(false, [message])
  const offEntered = enterMessages(off)
  assert.equal(offEntered.length, 2)
  assert.match(textOf(offEntered[1] as UserMessage), /Orbit activation is explicit/)

  const on = await fireBoundary(true, [message])
  const onEntered = enterMessages(on)
  assert.equal(onEntered.length, 2, 'the Session toggle must not add a directive beside the explicit one')
  assert.match(textOf(onEntered[1] as UserMessage), /Orbit activation is explicit/)
  assert.equal((onEntered[1]?.source as { goal?: string }).goal, 'explicit goal')

  // A step that already carries an Orbit directive gains no second one.
  const again = await fireBoundary(true, [message], onEntered)
  assert.equal(enterMessages(again).length, 2, 'an entered step keeps exactly one directive')
})

test('/orbit-toggle validates its argument', () => {
  let definition: { name: string; handler: (invocation: { rawInput: string }) => { kind: string; text?: string } } | undefined
  const ctx = {
    effect: (fn: () => unknown) => {
      fn()
    },
    commands: {
      register: (registered: never) => {
        definition = registered as never
        return () => undefined
      },
    },
  } as unknown as Context

  registerOrbitToggleCommand(ctx)
  assert.ok(definition)
  assert.equal(definition.name, ORBIT_TOGGLE_COMMAND)
  assert.equal(definition.handler({ rawInput: ' on' }).kind, 'success')
  assert.equal(definition.handler({ rawInput: 'off' }).kind, 'success')
  const invalid = definition.handler({ rawInput: 'maybe' })
  assert.equal(invalid.kind, 'error')
  assert.match(invalid.text ?? '', /Usage: \/orbit-toggle/)
})
