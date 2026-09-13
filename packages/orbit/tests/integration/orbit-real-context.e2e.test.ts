import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, ToolCallId, createUserMessage, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import LlmPlugin from '@deepseek-ai/dsh-llm'
import SessionPlugin, { SessionId } from '@deepseek-ai/dsh-session'
import PersistencePlugin from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjectionPlugin from '@deepseek-ai/dsh-session-projection'
import SystemPromptPlugin from '@deepseek-ai/dsh-system-prompt'
import ToolsPlugin, { defineTool } from '@deepseek-ai/dsh-tools'
import AgentPlugin from '@deepseek-ai/dsh-agent'
import AgentLoopPlugin from '@deepseek-ai/dsh-agent-loop'
import CommandsPlugin from '@deepseek-ai/dsh-commands'
import SubagentPlugin from '@deepseek-ai/dsh-subagent'
import * as SpawnPlugin from '@deepseek-ai/dsh-subagent-spawn-in-process'
import * as OrbitPlugin from '../../src/index.ts'
import { DshOrbitHost } from '../../src/dsh-host.ts'
import { resolveExecutable } from '../../../browser/src/cli.ts'
import { findChromium } from '../../../../tests/helpers/chromium.ts'

const MODEL = { provider: 'fake', model: 'fm' }
const ROUTE = { provider: 'fake', model: 'fm', reasoningEffort: 'off' }

interface AdapterScript {
  plan?: string
  stepEvaluate?: string
  finalEvaluate?: string
  strategyChallenge?: string
  strategyReconsider?: string
  runtimeDiagnose?: string
  timeoutReview?: string
  guardEscalation?: string
  /** Executor first call hangs, later calls complete (runtime timeout test). */
  hangFirstExecutor?: boolean
  /** Commander prompt containing this marker never settles. */
  hangMarker?: string
}

class ScriptedAdapter extends LlmAdapter {
  readonly seen: string[] = []
  executorCalls = 0
  private readonly script: AdapterScript

  constructor(script: AdapterScript = {}) {
    super()
    this.script = script
  }

  providerInfo(provider: string): { id: string; name: string } {
    return { id: provider, name: 'Scripted' }
  }

  async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return {
      provider,
      id: model,
      name: model,
      inputModalities: ['text'],
      context: { contextWindow: 100_000 },
      reasoning: {
        efforts: [
          { id: 'off', name: 'Off' },
          { id: 'low', name: 'Low' },
          { id: 'high', name: 'High' },
        ],
        defaultEffort: 'off',
      },
    } as unknown as LlmResolvedModelInfo
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const prompt = [...options.messages]
      .reverse()
      .flatMap((message) => message.content)
      .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
    this.seen.push(prompt.slice(0, 80))

    if (this.script.hangMarker && prompt.includes(this.script.hangMarker)) {
      await hangUntilAborted(options.signal)
    }

    // Decision roles answer through the real DSH structured-output tool; only
    // the Executor settles with plain text.
    let reply = 'ok'
    let structured = false
    if (prompt.includes('Produce the smallest set of 2-5 logical engineering steps')) {
      reply = this.script.plan ?? '{"summary":"e2e","steps":[{"id":"P1","goal":"do the thing"}]}'
      structured = true
    } else if (prompt.includes('You are the Orbit Executor')) {
      this.executorCalls += 1
      if (this.script.hangFirstExecutor && this.executorCalls === 1) {
        await hangUntilAborted(options.signal)
      }
      reply = 'executor done'
    } else if (prompt.includes('STEP_EVALUATE')) {
      reply = this.script.stepEvaluate ?? '{"decision":"PASS_CURRENT_STEP"}'
      structured = true
    } else if (prompt.includes('FINAL_EVALUATE')) {
      reply = this.script.finalEvaluate ?? '{"decision":"SUCCESS"}'
      structured = true
    } else if (prompt.includes('STRATEGY_CHALLENGE')) {
      reply = this.script.strategyChallenge ?? '{"question":"is this tunnel vision?"}'
      structured = true
    } else if (prompt.includes('STRATEGY_RECONSIDER')) {
      reply = this.script.strategyReconsider ?? '{"decision":"KEEP_APPROACH"}'
      structured = true
    } else if (prompt.includes('RUNTIME_DIAGNOSE')) {
      reply = this.script.runtimeDiagnose ?? '{"decision":"RESTART_STEP"}'
      structured = true
    } else if (prompt.includes('COMMANDER_TIMEOUT_REVIEW')) {
      reply = this.script.timeoutReview ?? '{"decision":"EXTEND"}'
      structured = true
    } else if (prompt.includes('GUARD_ESCALATION')) {
      reply = this.script.guardEscalation ?? '{"decision":"RETRY_DIFFERENTLY"}'
      structured = true
    }

    if (structured) {
      const callId = ToolCallId(`structured-${this.seen.length}`)
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id: callId, name: 'structured_output', argumentsDelta: reply }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: callId, name: 'structured_output', arguments: reply } }
      yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }

    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: reply }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

function stubTool(name: string) {
  return defineTool({
    name,
    description: `stub ${name}`,
    parameters: { input: { type: 'string' } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {} },
      render: () => [{ type: 'text', text: `${name} ok` }],
    },
    execute: async () => ({}),
  })
}

const ORBIT_CONFIG = {
  routes: { commander: ROUTE, executor: ROUTE, watchdog: ROUTE },
  browserTools: ['agent_browser'],
  commanderReadOnlyTools: ['read', 'glob', 'grep'],
  watchdogTools: ['read'],
  executorTools: ['read', 'glob', 'grep', 'bash', 'write', 'edit'],
  registerTool: true,
  registerGuards: true,
}

async function boot(adapter: ScriptedAdapter, options: { executorTimeoutMs?: number } = {}): Promise<Context> {
  const root = new Context()
  const storage = mkdtempSync(join(tmpdir(), 'dsh-orbit-e2e-store-'))
  const plugins: Array<[unknown, unknown]> = [
    [LlmPlugin, {}],
    [SessionPlugin, {}],
    [PersistencePlugin, { root: storage }],
    [SessionProjectionPlugin, {}],
    [SystemPromptPlugin, { includeHarnessIdentity: false, includeRuntimeContext: false, personaPrefix: 'test' }],
    [ToolsPlugin, { mode: 'native' }],
    [AgentPlugin, {}],
    [CommandsPlugin, {}],
    [SubagentPlugin, {}],
    [SpawnPlugin, { providerName: 'spawn' }],
    [AgentLoopPlugin, { agents: [] }],
  ]
  for (const [plugin, config] of plugins) await root.plugin(plugin as never, config as never)
  root.llm.registerAdapter(['fake'], adapter)
  for (const name of ['read', 'glob', 'grep', 'bash', 'write', 'edit', 'agent_browser']) root.tools.register(stubTool(name))
  await root.plugin(OrbitPlugin as never, {
    ...ORBIT_CONFIG,
    ...(options.executorTimeoutMs ? { executorTimeoutMs: options.executorTimeoutMs } : {}),
  } as never)
  return root
}

async function makeParent(root: Context, cwd: string, id: string) {
  return root.agents.create({
    sessionId: SessionId(id),
    agentOptions: { provider: 'fake', model: 'fm' },
    meta: { cwd },
  })
}

function tempProject(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-orbit-e2e-project-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline && !predicate()) {
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

/** Hangs the scripted stream until the request signal aborts. */
function hangUntilAborted(signal: AbortSignal | undefined): Promise<never> {
  return new Promise<never>((_, reject) => {
    const onAbort = (): void => reject(new Error('scripted stream aborted'))
    if (signal?.aborted) {
      onAbort()
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    setTimeout(() => reject(new Error('scripted stream safety timeout')), 30_000).unref?.()
  })
}

test('real host E2E: full Orbit plan/execute/evaluate/success, parent not a competitor', { timeout: 120_000 }, async () => {
  const adapter = new ScriptedAdapter()
  const root = await boot(adapter)
  const project = tempProject()
  const parent = await makeParent(root, project.dir, 'e2e-parent-1')
  try {
    const result = await root.agents.withInitiator(parent.agent, () =>
      root.orbit.run({ goal: 'real host e2e', approved_loop_count: 2 }, project.dir, new AbortController().signal),
    )
    assert.equal(result.ok, true, result.message)
    assert.equal(result.phase, 'SUCCESS')
    const state = JSON.parse(readFileSync(join(project.dir, '.cx', 'state.json'), 'utf8')) as { phase: string; driver_ownership: string }
    assert.equal(state.phase, 'SUCCESS')
    assert.equal(state.driver_ownership, 'CLOSED')
    assert.ok(adapter.executorCalls >= 1, 'the real Executor child must have run')
  } finally {
    await parent.dispose()
    await root.fiber.dispose()
    project.cleanup()
  }
})

test('real host lifecycle: executor normal completion is interrupted=false', { timeout: 120_000 }, async () => {
  const adapter = new ScriptedAdapter()
  const root = await boot(adapter)
  const project = tempProject()
  const parent = await makeParent(root, project.dir, 'e2e-parent-2')
  try {
    const host = new DshOrbitHost(root)
    await root.agents.withInitiator(parent.agent, async () => {
      const handle = await host.startRole({
        role: 'executor',
        label: 'e2e-normal-exec',
        prompt: 'You are the Orbit Executor. plain work',
        route: ROUTE,
        toolFilter: { allow: ['read'] },
      })
      assert.ok(handle.childId)
      const result = await handle.result
      assert.equal(result.interrupted, false, result.reason)
      assert.ok(result.output.length > 0)
      await host.releaseRole(handle)
    })
  } finally {
    await parent.dispose()
    await root.fiber.dispose()
    project.cleanup()
  }
})

test('real host lifecycle: 840s hard timeout cancels a one-shot Commander and leaves no orphan', { timeout: 120_000 }, async () => {
  const adapter = new ScriptedAdapter({ hangMarker: 'HANG_COMMANDER_NOW' })
  const root = await boot(adapter)
  const project = tempProject()
  const parent = await makeParent(root, project.dir, 'e2e-parent-3')
  try {
    const host = new DshOrbitHost(root)
    await root.agents.withInitiator(parent.agent, async () => {
      const handle = await host.startRole({
        role: 'commander',
        label: 'e2e-hang-commander',
        prompt: 'HANG_COMMANDER_NOW',
        route: ROUTE,
        toolFilter: { allow: ['read'] },
      })
      const childId = handle.childId as SessionId
      assert.ok(childId)
      await waitUntil(() => root.agents.get(childId)?.status === 'running')
      const telemetry = await handle.runtimeSnapshot?.()
      assert.ok(telemetry && telemetry.status !== undefined)

      await handle.cancel?.('COMMANDER_HARD_TIMEOUT')
      await waitUntil(() => root.agents.get(childId) === undefined)
      assert.equal(root.agents.get(childId), undefined, 'cancelled one-shot Commander must be disposed')
      assert.ok(!root.agents.list().some((agent) => String(agent.id) === String(childId)))
    })
  } finally {
    await parent.dispose()
    await root.fiber.dispose()
    project.cleanup()
  }
})

test('real host runtime watchdog: executor timeout -> RUNTIME_DIAGNOSE -> RESTART_STEP -> success', { timeout: 120_000 }, async () => {
  const adapter = new ScriptedAdapter({ hangFirstExecutor: true, runtimeDiagnose: '{"decision":"RESTART_STEP"}' })
  const root = await boot(adapter, { executorTimeoutMs: 400 })
  const project = tempProject()
  const parent = await makeParent(root, project.dir, 'e2e-parent-4')
  try {
    const result = await root.agents.withInitiator(parent.agent, () =>
      root.orbit.run({ goal: 'timeout recovery e2e', approved_loop_count: 2 }, project.dir, new AbortController().signal),
    )
    assert.equal(result.ok, true, result.message)
    assert.equal(result.phase, 'SUCCESS')
    assert.ok(adapter.executorCalls >= 2, 'a fresh executor must run after RESTART_STEP')
    assert.ok(adapter.seen.some((entry) => entry.includes('RUNTIME_DIAGNOSE')), 'runtime watchdog must be invoked through the real host')
  } finally {
    await parent.dispose()
    await root.fiber.dispose()
    project.cleanup()
  }
})

test('real host capability scoping: agent_browser is unavailable to a restricted executor and available to a browser executor', { timeout: 120_000 }, async () => {
  const adapter = new ScriptedAdapter()
  const root = await boot(adapter)
  const project = tempProject()
  const parent = await makeParent(root, project.dir, 'e2e-parent-5')
  try {
    const host = new DshOrbitHost(root)
    await root.agents.withInitiator(parent.agent, async () => {
      const restricted = await host.startRole({
        role: 'executor',
        label: 'e2e-restricted',
        prompt: 'restricted work',
        route: ROUTE,
        toolFilter: { allow: ['read'] },
      })
      const restrictedAgent = root.agents.get(restricted.childId as SessionId)
      assert.ok(restrictedAgent)
      assert.equal(root.tools.get('agent_browser', restrictedAgent), undefined)
      await restricted.result
      await host.releaseRole(restricted)

      const browser = await host.startRole({
        role: 'executor',
        label: 'e2e-browser',
        prompt: 'browser work',
        route: ROUTE,
        toolFilter: { allow: ['read', 'agent_browser'] },
        capabilities: ['browser'],
      })
      const browserAgent = root.agents.get(browser.childId as SessionId)
      assert.ok(browserAgent)
      assert.notEqual(root.tools.get('agent_browser', browserAgent), undefined)
      await browser.result
      await host.releaseRole(browser)
    })
  } finally {
    await parent.dispose()
    await root.fiber.dispose()
    project.cleanup()
  }
})

test('real Cordis tool pipeline: agent_browser tool -> BrowserAutomationService -> Chromium', { timeout: 180_000 }, async () => {
  const chromium = findChromium()
  assert.ok(chromium, 'a working chromium executable is required')
  assert.ok(resolveExecutable('agent-browser', process.env.PATH), 'agent-browser must be on PATH')

  const root = new Context()
  const storage = mkdtempSync(join(tmpdir(), 'dsh-browser-e2e-store-'))
  for (const [plugin, config] of [
    [LlmPlugin, {}],
    [SessionPlugin, {}],
    [PersistencePlugin, { root: storage }],
    [SessionProjectionPlugin, {}],
    [SystemPromptPlugin, { includeHarnessIdentity: false, includeRuntimeContext: false, personaPrefix: 'test' }],
    [ToolsPlugin, { mode: 'native' }],
    [AgentPlugin, {}],
    [SubagentPlugin, {}],
    [SpawnPlugin, { providerName: 'spawn' }],
    [AgentLoopPlugin, { agents: [] }],
  ] as const) {
    await root.plugin(plugin as never, config as never)
  }
  const BrowserPlugin = await import('../../../browser/src/index.ts')
  await root.plugin(BrowserPlugin as never, {
    executablePath: chromium,
    registerTool: true,
  } as never)

  const parent = await makeParent(root, '/tmp', 'browser-e2e-parent')
  try {
    const fixture =
      'data:text/html,<html><head><title>ToolPipeline</title></head><body><h1>Hello</h1><button>Go</button></body></html>'
    const open = await root.tools.execute({
      callId: ToolCallId('browser-e2e-open'),
      name: 'agent_browser',
      arguments: { args: ['open', fixture] },
      agent: parent.agent,
      signal: new AbortController().signal,
    })
    const openPayload = JSON.stringify(open)
    assert.ok(!openPayload.includes('"isError":true'), openPayload.slice(0, 500))

    const snapshot = await root.tools.execute({
      callId: ToolCallId('browser-e2e-snapshot'),
      name: 'agent_browser',
      arguments: { args: ['snapshot', '-i'] },
      agent: parent.agent,
      signal: new AbortController().signal,
    })
    assert.ok(!JSON.stringify(snapshot).includes('"isError":true'))

    const title = await root.tools.execute({
      callId: ToolCallId('browser-e2e-title'),
      name: 'agent_browser',
      arguments: { args: ['get', 'title'] },
      agent: parent.agent,
      signal: new AbortController().signal,
    })
    assert.match(JSON.stringify(title), /ToolPipeline/)

    await (root as unknown as { browserAutomation: { close(): Promise<void> } }).browserAutomation.close()
  } finally {
    await parent.dispose()
    await root.fiber.dispose()
  }
})

interface SessionMessageLike {
  source: { kind?: string; goal?: string }
  content: Array<{ type?: string; text?: string }>
}

function userMessagesOf(agent: {
  session?: { snapshotEvents?: () => readonly { type?: string; data?: unknown }[] }
}): SessionMessageLike[] {
  const events = agent.session?.snapshotEvents?.() ?? []
  return events
    .filter((event) => event.type === 'user/message')
    .map((event) => event.data as SessionMessageLike)
}

function textOf(message: SessionMessageLike): string {
  return message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('\n')
}

test('real host command: /agent-orbit is registered, preserved in history, and activates once', { timeout: 120_000 }, async () => {
  const adapter = new ScriptedAdapter()
  const root = await boot(adapter)
  const project = tempProject()
  const parent = await makeParent(root, project.dir, 'e2e-parent-orbit-command')
  try {
    // The Web GUI slash menu reads this exact descriptor list.
    const descriptors = root.commands.list(parent.agent)
    const descriptor = descriptors.find((entry) => entry.name === 'agent-orbit')
    assert.ok(descriptor, `agent-orbit must be listed (got: ${descriptors.map((entry) => entry.name).join(', ') || '(none)'})`)
    assert.equal(descriptor.description, 'Run a goal with Orbit deterministic engineering orchestration')
    assert.equal(descriptor.input?.hint, 'Describe the engineering goal for Orbit')

    const commandLine = '/agent-orbit implement the deterministic fix'
    const execution = await root.commands.execute(parent.agent, commandLine, [], new AbortController().signal)
    assert.ok(execution)
    assert.equal(execution.result.kind, 'success')
    await parent.agent.whenIdle()

    const messages = userMessagesOf(parent.agent)
    const userTexts = messages.filter((message) => message.source.kind === 'user').map(textOf)
    assert.ok(userTexts.includes(commandLine), 'the user command must stay visible in conversation history')
    assert.equal(userTexts.filter((text) => text.startsWith('/agent-orbit')).length, 1, 'exactly one preserved user command message')

    const directives = messages.filter((message) => message.source.kind === 'orbit-command')
    assert.equal(directives.length, 1, 'host command + preserved message must activate exactly once')
    assert.equal(directives[0]?.source.goal, 'implement the deterministic fix')
    assert.match(textOf(directives[0] as SessionMessageLike), /orbit_controller/)
    assert.match(textOf(directives[0] as SessionMessageLike), /Goal: implement the deterministic fix/)

    // The existing tool is still the only business entry: the activation layer
    // must not start a durable run by itself.
    assert.equal(existsSync(join(project.dir, '.cx', 'state.json')), false)
  } finally {
    await parent.dispose()
    await root.fiber.dispose()
    project.cleanup()
  }
})

test('real host command: empty /agent-orbit is rejected without starting a run', { timeout: 60_000 }, async () => {
  const adapter = new ScriptedAdapter()
  const root = await boot(adapter)
  const project = tempProject()
  const parent = await makeParent(root, project.dir, 'e2e-parent-orbit-empty')
  try {
    const execution = await root.commands.execute(parent.agent, '/agent-orbit', [], new AbortController().signal)
    assert.ok(execution)
    assert.ok(execution.result.kind === 'error', 'an empty goal must be rejected')
    assert.match(execution.result.text, /Usage: \/agent-orbit/)
    await parent.agent.whenIdle()

    assert.equal(userMessagesOf(parent.agent).length, 0, 'an empty goal must post no user message')
    assert.equal(adapter.seen.length, 0, 'an empty goal must not reach the model')
    assert.equal(existsSync(join(project.dir, '.cx', 'state.json')), false)
  } finally {
    await parent.dispose()
    await root.fiber.dispose()
    project.cleanup()
  }
})

test('real host gesture fallback: genuine /agent-orbit activates once; ordinary chat does not', { timeout: 120_000 }, async () => {
  const adapter = new ScriptedAdapter()
  const root = await boot(adapter)
  const project = tempProject()
  const parent = await makeParent(root, project.dir, 'e2e-parent-orbit-gesture')
  try {
    parent.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'please inspect this file' }], source: { kind: 'user' } }))
    await parent.agent.whenIdle()
    assert.equal(
      userMessagesOf(parent.agent).filter((message) => message.source.kind === 'orbit-command').length,
      0,
      'ordinary chat must not activate Orbit',
    )

    parent.agent.followup(createUserMessage({ content: [{ type: 'text', text: '/agent-orbit headless fallback goal' }], source: { kind: 'user' } }))
    await parent.agent.whenIdle()
    const directives = userMessagesOf(parent.agent).filter((message) => message.source.kind === 'orbit-command')
    assert.equal(directives.length, 1, 'the headless gesture must activate exactly once')
    assert.equal(directives[0]?.source.goal, 'headless fallback goal')
    assert.match(textOf(directives[0] as SessionMessageLike), /Goal: headless fallback goal/)
  } finally {
    await parent.dispose()
    await root.fiber.dispose()
    project.cleanup()
  }
})

test('real host agent loop: a normal user turn runs on the same real Context', { timeout: 60_000 }, async () => {
  // A compact regression guard: the same real Context also accepts a normal user turn.
  const adapter = new ScriptedAdapter()
  const root = await boot(adapter)
  const parent = await makeParent(root, '/tmp', 'tool-pipe-parent')
  try {
    parent.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }))
    await parent.agent.whenIdle()
    assert.ok(adapter.seen.length >= 1)
  } finally {
    await parent.dispose()
    await root.fiber.dispose()
  }
})
