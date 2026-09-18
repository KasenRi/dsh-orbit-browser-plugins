import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Context } from '@deepseek-ai/cordis'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import {
  AGENT_ORBIT_COMMAND,
  installOrbitGestureBoundary,
  invokedOrbitActivation,
  invokedOrbitMessage,
  parseOrbitActivation,
  registerOrbitToggleCommand,
} from '../src/activation.ts'
import { ORBIT_TOGGLE_COMMAND } from '../src/session-state.ts'

const userMessage = (text: string) =>
  createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })

type PreStepListener = (payload: {
  agent: { session: Session }
  messages: UserMessage[]
  turn: number
  step: number
  signal: AbortSignal
}, next: () => Promise<PreStepDecision>) => Promise<PreStepDecision>

interface BoundaryRun {
  decision: PreStepDecision
  activations: Array<{ goal: string }>
  appended: UserMessage[]
}

/** Fire the installed boundary once with a fake agent and the given decision cut. */
async function fireBoundary(
  sessionEnabled: boolean,
  messages: UserMessage[],
  decisionMessages: UserMessage[] = [...messages],
): Promise<BoundaryRun> {
  let listener: PreStepListener | undefined
  const activations: Array<{ goal: string }> = []
  const appended: UserMessage[] = []
  const ctx = {
    on: (_event: string, fn: PreStepListener) => {
      listener = fn
    },
  } as unknown as Context
  installOrbitGestureBoundary(ctx, {
    sessionEnabled: () => sessionEnabled,
    activate: async (_agent, goal) => {
      activations.push({ goal })
    },
  })
  assert.ok(listener)
  const session = {
    append: (_type: string, data: UserMessage) => {
      appended.push(data)
    },
  }
  const decision = await listener(
    { agent: { session: session as unknown as Session }, messages, turn: 1, step: 1, signal: new AbortController().signal },
    async () => ({ kind: 'enter', messages: [...decisionMessages] }),
  )
  return { decision, activations, appended }
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
})

test('the newest matching user message wins', () => {
  const invocation = invokedOrbitActivation([
    userMessage('/agent-orbit older'),
    userMessage('ordinary message'),
    userMessage('/agent-orbit newer'),
  ])
  assert.deepEqual(invocation, { goal: 'newer' })
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

test('an enabled Session hard-activates ordinary messages and consumes the turn', async () => {
  const message = userMessage('fix the failing test')

  const off = await fireBoundary(false, [message])
  assert.deepEqual(enterMessages(off.decision), [message], 'OFF keeps the parent path untouched')
  assert.equal(off.activations.length, 0, 'OFF must not start Orbit')
  assert.equal(off.appended.length, 0)

  const on = await fireBoundary(true, [message])
  assert.deepEqual(enterMessages(on.decision), [], 'the host consumes the turn without a model call')
  assert.deepEqual(on.activations, [{ goal: 'fix the failing test' }], 'the exact user text is the goal')
  assert.deepEqual(on.appended, [message], 'the claimed message stays in the conversation exactly once')
})

test('the hard activation keeps the goal verbatim', async () => {
  const goal = '帮我停止 https://steambalance.030.qzz.io 的服务'
  const on = await fireBoundary(true, [userMessage(`  ${goal}  `)])
  assert.deepEqual(on.activations, [{ goal }])
})

test('plugin messages never hard-activate', async () => {
  const pluginMessage = createUserMessage({
    content: [{ type: 'text', text: 'plugin context' }],
    source: { kind: 'plugin', plugin: 'dsh-orbit' },
  })
  const on = await fireBoundary(true, [pluginMessage])
  assert.equal(on.activations.length, 0)
  assert.equal(on.appended.length, 0)
  assert.deepEqual(enterMessages(on.decision), [pluginMessage])
})

test('an explicit /agent-orbit hard-activates exactly once, whatever the toggle says', async () => {
  const message = userMessage('/agent-orbit explicit goal')

  const off = await fireBoundary(false, [message])
  assert.deepEqual(enterMessages(off.decision), [], 'the host consumes the explicit turn')
  assert.deepEqual(off.activations, [{ goal: 'explicit goal' }], 'explicit /agent-orbit starts the run itself')
  assert.deepEqual(off.appended, [message], 'the command message stays in history')

  const on = await fireBoundary(true, [message])
  assert.deepEqual(enterMessages(on.decision), [])
  assert.deepEqual(on.activations, [{ goal: 'explicit goal' }], 'the Session toggle must not add a second start')
  assert.deepEqual(on.appended, [message])
})

test('an explicit /agent-orbit keeps the goal verbatim', async () => {
  const goal = '帮我停止 https://steambalance.030.qzz.io 的服务'
  const run = await fireBoundary(false, [userMessage(`/agent-orbit   ${goal}  `)])
  assert.deepEqual(run.activations, [{ goal }])
})

test('an empty explicit /agent-orbit never starts a run', async () => {
  const message = userMessage('/agent-orbit   ')
  const run = await fireBoundary(false, [message])
  assert.equal(run.activations.length, 0)
  assert.equal(run.appended.length, 0)
  assert.deepEqual(enterMessages(run.decision), [message], 'the parent path stays untouched')
})

test('an explicit /agent-orbit wins over the enabled-Session ordinary path', async () => {
  const message = userMessage('/agent-orbit explicit goal')
  const earlier = userMessage('earlier ordinary message')
  const run = await fireBoundary(true, [earlier, message])
  assert.deepEqual(run.activations, [{ goal: 'explicit goal' }], 'the explicit goal wins, exactly once')
  assert.deepEqual(run.appended, [earlier, message])
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
  assert.match(invalid.text ?? '', /用法：\/orbit-toggle/)
})
