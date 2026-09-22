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
import SessionQueryEngine from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-api-session-controller/types'
import SystemPromptPlugin from '@deepseek-ai/dsh-system-prompt'
import ToolsPlugin, { defineTool } from '@deepseek-ai/dsh-tools'
import AgentPlugin from '@deepseek-ai/dsh-agent'
import AgentLoopPlugin from '@deepseek-ai/dsh-agent-loop'
import CommandsPlugin from '@deepseek-ai/dsh-commands'
import SubagentPlugin from '@deepseek-ai/dsh-subagent'
import * as SpawnPlugin from '@deepseek-ai/dsh-subagent-spawn-in-process'
import * as OrbitPlugin from '../../src/index.ts'
import { DshOrbitHost } from '../../src/dsh-host.ts'
import { ORBIT_COMMANDER_DECISION_TOOL } from '../../src/host.ts'
import { resolveExecutable } from '../../../browser/src/cli.ts'
import { findChromium } from '../../../../tests/helpers/chromium.ts'

const MODEL = { provider: 'fake', model: 'fm' }
const ROUTE = { provider: 'fake', model: 'fm', reasoningEffort: 'off' }

/** Minimal exact-read backend for continuable cold-resume tests; search is irrelevant here. */
class TestSessionQuery extends SessionQueryEngine {
  async searchSessions(): Promise<never> { return { items: [], next: null } as never }
  async searchEvents(): Promise<never> { return { items: [], next: null } as never }
}

interface AdapterScript {
  plan?: string
  stepEvaluate?: string
  /** Successive STEP_EVALUATE replies; the last one repeats. */
  stepEvaluates?: string[]
  finalEvaluate?: string
  /** Visible text emitted before the FINAL_EVALUATE structured capture. */
  finalVisibleText?: string
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
  /** Every full prompt the adapter answered, in order. */
  readonly prompts: string[] = []
  /** The provider/model route of every request, in order, with a prompt head. */
  readonly requests: Array<{ sessionId?: string; provider: string; model: string; reasoningEffort?: string; prompt: string }> = []
  executorCalls = 0
  private stepEvaluateCalls = 0
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
          { id: 'xhigh', name: 'XHigh' },
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
    const currentUser = [...options.messages].reverse().find((message) =>
      message.role === 'user' && message.content.some((block) => block.type === 'text'),
    )
    const turnPrompt = currentUser?.content
      .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
      .map((block) => block.text)
      .join('\n') ?? prompt
    this.seen.push(prompt.slice(0, 80))
    this.prompts.push(prompt)
    this.requests.push({
      ...(options.sessionId === undefined ? {} : { sessionId: String(options.sessionId) }),
      provider: options.provider,
      model: options.model,
      ...(options.reasoningEffort === undefined ? {} : { reasoningEffort: String(options.reasoningEffort) }),
      prompt: prompt.slice(0, 40),
    })

    if (this.script.hangMarker && turnPrompt.includes(this.script.hangMarker)) {
      await hangUntilAborted(options.signal)
    }

    // Decision roles answer through the real DSH structured-output tool; only
    // the Executor settles with plain text.
    let reply = 'ok'
    let structured = false
    let commanderMode: 'PLAN' | 'STEP_EVALUATE' | 'FINAL_EVALUATE' | 'STRATEGY_RECONSIDER' | undefined
    if (turnPrompt.includes('当前阶段：PLAN')) {
      reply = this.script.plan ?? '{"summary":"e2e","steps":[{"id":"P1","goal":"do the thing"}]}'
      structured = true
      commanderMode = 'PLAN'
    } else if (turnPrompt.includes('你是 Orbit 的 MoA Judge')) {
      reply = '候选 2 更完整。\nWINNER_CANDIDATE_INDEX: 2'
    } else if (turnPrompt.includes('你是 Orbit 的 MoA 独立候选模型') || turnPrompt.includes('你是 Orbit 的 MoA 候选模型')) {
      reply = '候选方案 ' + options.model + '\n```text file="result.txt"\n' + options.model + '\n```'
    } else if (turnPrompt.includes('你是 Orbit 执行员')) {
      this.executorCalls += 1
      if (this.script.hangFirstExecutor && this.executorCalls === 1) {
        await hangUntilAborted(options.signal)
      }
      reply = 'executor done'
    } else if (turnPrompt.includes('STEP_EVALUATE')) {
      const replies = this.script.stepEvaluates
      reply = replies !== undefined && replies.length > 0
        ? replies[Math.min(this.stepEvaluateCalls, replies.length - 1)] ?? '{"decision":"PASS_CURRENT_STEP"}'
        : this.script.stepEvaluate ?? '{"decision":"PASS_CURRENT_STEP"}'
      this.stepEvaluateCalls += 1
      structured = true
      commanderMode = 'STEP_EVALUATE'
    } else if (turnPrompt.includes('FINAL_EVALUATE')) {
      reply = this.script.finalEvaluate ?? '{"decision":"SUCCESS","summary":"scripted final summary"}'
      structured = true
      commanderMode = 'FINAL_EVALUATE'
    } else if (turnPrompt.includes('STRATEGY_CHALLENGE')) {
      reply = this.script.strategyChallenge ?? '{"question":"is this tunnel vision?"}'
      structured = true
    } else if (turnPrompt.includes('STRATEGY_RECONSIDER')) {
      reply = this.script.strategyReconsider ?? '{"decision":"KEEP_APPROACH"}'
      structured = true
      commanderMode = 'STRATEGY_RECONSIDER'
    } else if (turnPrompt.includes('RUNTIME_DIAGNOSE')) {
      reply = this.script.runtimeDiagnose ?? '{"decision":"RESTART_STEP"}'
      structured = true
    } else if (turnPrompt.includes('COMMANDER_TIMEOUT_REVIEW')) {
      reply = this.script.timeoutReview ?? '{"decision":"EXTEND"}'
      structured = true
    } else if (turnPrompt.includes('GUARD_ESCALATION')) {
      reply = this.script.guardEscalation ?? '{"decision":"RETRY_DIFFERENTLY"}'
      structured = true
    }

    if (structured) {
      if (turnPrompt.includes('FINAL_EVALUATE') && this.script.finalVisibleText) {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: this.script.finalVisibleText }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: this.script.finalVisibleText } }
      }
      const callId = ToolCallId(`structured-${this.seen.length}`)
      const index = turnPrompt.includes('FINAL_EVALUATE') && this.script.finalVisibleText ? 1 : 0
      const toolName = commanderMode === undefined ? 'structured_output' : ORBIT_COMMANDER_DECISION_TOOL
      const args = commanderMode === undefined
        ? reply
        : JSON.stringify({ mode: commanderMode, ...(JSON.parse(reply) as Record<string, unknown>) })
      yield { type: 'block-start', index, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index, id: callId, name: toolName, argumentsDelta: args }
      yield { type: 'block-end', index, block: { type: 'tool-call', id: callId, name: toolName, arguments: args } }
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

async function boot(adapter: ScriptedAdapter, options: { executorTimeoutMs?: number; slashCommand?: boolean; providers?: string[]; moa?: Record<string, unknown> } = {}): Promise<Context> {
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
  new TestSessionQuery(root)
  root.llm.registerAdapter(options.providers ?? ['fake'], adapter)
  root.provide('agentDefaultModel', { currentSelection: () => ({ ...ROUTE }) } as never)
  for (const name of ['read', 'glob', 'grep', 'bash', 'write', 'edit', 'agent_browser']) root.tools.register(stubTool(name))
  await root.plugin(OrbitPlugin as never, {
    ...ORBIT_CONFIG,
    ...(options.executorTimeoutMs ? { executorTimeoutMs: options.executorTimeoutMs } : {}),
    ...(options.slashCommand === undefined ? {} : { slashCommand: options.slashCommand }),
    ...(options.moa ? { moa: options.moa } : {}),
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
  const adapter = new ScriptedAdapter({
    plan: '{"summary":"persistent","steps":[{"id":"P0","goal":"first"},{"id":"P1","goal":"second"}]}',
  })
  const root = await boot(adapter)
  const project = tempProject()
  const parent = await makeParent(root, project.dir, 'e2e-parent-1')
  try {
    const result = await root.agents.withInitiator(parent.agent, () =>
      root.orbit.run({ goal: 'real host e2e', approved_loop_count: 2 }, project.dir, new AbortController().signal),
    )
    assert.equal(result.ok, true, result.message)
    assert.equal(result.phase, 'SUCCESS')
    assert.equal(result.final_output?.text, 'scripted final summary', 'tool callers retain the final result as JSON data')
    assert.equal(
      assistantMessagesOf(parent.agent).filter((message) => textOf(message).includes('scripted final summary')).length,
      0,
      'direct service/tool-style calls never project the hard-activation final result',
    )
    const state = JSON.parse(readFileSync(join(project.dir, '.cx', 'state.json'), 'utf8')) as {
      phase: string
      driver_ownership: string
      role_sessions?: { commander?: { child_id?: string; turns?: number }; executor?: { child_id?: string; turns?: number } }
    }
    assert.equal(state.phase, 'SUCCESS')
    assert.equal(state.driver_ownership, 'CLOSED')
    assert.equal(adapter.executorCalls, 2, 'both real Executor turns must have run')
    assert.equal(state.role_sessions?.commander?.turns, 4, `PLAN + two reviews + FINAL reuse one Commander Session: ${JSON.stringify(state.role_sessions)}`)
    assert.equal(state.role_sessions?.executor?.turns, 2, 'two same-grant steps reuse one Executor Session')
    const commanderSessionIds = new Set(adapter.requests.filter((entry) => entry.prompt.includes('Orbit 指挥官')).map((entry) => entry.sessionId))
    const executorSessionIds = new Set(adapter.requests.filter((entry) => entry.prompt.includes('Orbit 执行员')).map((entry) => entry.sessionId))
    assert.equal(commanderSessionIds.size, 1, 'real DSH must keep one Commander child session id')
    assert.equal(executorSessionIds.size, 1, 'real DSH must keep one Executor child session id across steps')
    const runtimeEvents = parent.agent.session.snapshotEvents().filter((event) => event.type === 'orbit/runtime')
    assert.ok(runtimeEvents.length > 0, 'Orbit must publish durable runtime snapshots into the owning Session')
    const lastRuntime = runtimeEvents.at(-1)?.data as { phase?: string; status?: string }
    assert.equal(lastRuntime.phase, 'SUCCESS')
    assert.equal(lastRuntime.status, 'success')
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
    // The raw Watchdog prompt is Chinese, machine decision enums aside.
    const watchdogPrompt = adapter.prompts.find((prompt) => prompt.includes('RUNTIME_DIAGNOSE')) ?? ''
    assert.match(watchdogPrompt, /你是 Orbit 监控模型/)
    assert.doesNotMatch(watchdogPrompt, /You are the Orbit Smart Watchdog/)
    assert.doesNotMatch(watchdogPrompt, /Runtime anomaly:/)
  } finally {
    await parent.dispose()
    await root.fiber.dispose()
    project.cleanup()
  }
})

test('real host MoA one-shot scope: an empty allow filter exposes no inherited tools', { timeout: 120_000 }, async () => {
  const adapter = new ScriptedAdapter()
  const root = await boot(adapter)
  const project = tempProject()
  const parent = await makeParent(root, project.dir, 'e2e-parent-moa-tools')
  try {
    const host = new DshOrbitHost(root)
    await root.agents.withInitiator(parent.agent, async () => {
      const candidate = await host.startRole({
        role: 'commander',
        label: 'e2e-moa-tool-less',
        prompt: 'MoA candidate without tools',
        route: ROUTE,
        toolFilter: { allow: [] },
      })
      const child = root.agents.get(candidate.childId as SessionId)
      assert.ok(child)
      for (const tool of ['read', 'write', 'bash', 'subagent', 'agent_browser']) {
        assert.equal(root.tools.get(tool, child), undefined, `MoA child must not inherit ${tool}`)
      }
      await candidate.result
      await host.releaseRole(candidate)
      const modelResult = await host.runModel({ label: 'e2e-moa-usage', prompt: 'plain MoA candidate', route: ROUTE })
      assert.deepEqual(modelResult.usage, { inputTokens: 1, outputTokens: 1 })
    })
  } finally {
    await parent.dispose()
    await root.fiber.dispose()
    project.cleanup()
  }
})

test('real host optional MoA integration: three candidates -> Judge -> Orbit promotion -> verification', {
  timeout: 120_000,
  skip: process.env['ORBIT_MOA_OPTIONAL_E2E'] !== '1',
}, async () => {
  const adapter = new ScriptedAdapter({
    plan: '{"summary":"moa-e2e","steps":[{"id":"P0","goal":"produce the best result","execution_mode":"MOA"}]}',
  })
  const root = await boot(adapter, {
    moa: {
      enabled: true,
      candidateCount: 3,
      peerCritique: false,
      maxMoaSteps: 1,
      candidates: [
        { provider: 'fake', model: 'candidate-a', reasoningEffort: 'off' },
        { provider: 'fake', model: 'candidate-b', reasoningEffort: 'high' },
        { provider: 'fake', model: 'candidate-c', reasoningEffort: 'low' },
      ],
      judge: { provider: 'fake', model: 'judge', reasoningEffort: 'high' },
    },
  })
  const project = tempProject()
  const parent = await makeParent(root, project.dir, 'e2e-parent-moa-full')
  try {
    const result = await root.agents.withInitiator(parent.agent, () =>
      root.orbit.run({ goal: 'full MoA integration e2e' }, project.dir, new AbortController().signal),
    )
    assert.equal(result.phase, 'SUCCESS', result.message)
    assert.equal(readFileSync(join(project.dir, 'result.txt'), 'utf8').trim(), 'candidate-b')

    const state = JSON.parse(readFileSync(join(project.dir, '.cx', 'state.json'), 'utf8')) as {
      moa_step?: {
        phase?: string
        winning_candidate?: number
        winner_model?: string
        total_usage?: { total_tokens?: number }
      }
    }
    assert.equal(state.moa_step?.phase, 'PROMOTED')
    assert.equal(state.moa_step?.winning_candidate, 2)
    assert.equal(state.moa_step?.winner_model, 'fake/candidate-b')
    assert.equal(state.moa_step?.total_usage?.total_tokens, 8)

    const candidateRequests = adapter.prompts.filter((prompt) => prompt.includes('你是 Orbit 的 MoA 独立候选模型'))
    assert.equal(candidateRequests.length, 3)
    assert.equal(adapter.prompts.filter((prompt) => prompt.includes('你是 Orbit 的 MoA Judge')).length, 1)
    assert.equal(adapter.executorCalls, 1, 'the winner must still pass through the normal Executor verification')

    const runtimeEvents = parent.agent.session.snapshotEvents().filter((event) => event.type === 'orbit/runtime')
    const moaRuntime = runtimeEvents.map((event) => event.data as { moa?: { phase?: string; winningCandidate?: number } })
      .filter((entry) => entry.moa)
      .at(-1)
    assert.equal(moaRuntime?.moa?.phase, 'PROMOTED')
    assert.equal(moaRuntime?.moa?.winningCandidate, 2)
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

interface AssistantMessageLike extends SessionMessageLike {
  source: { kind?: string; provider?: string; model?: string }
}

function userMessagesOf(agent: {
  session?: { snapshotEvents?: () => readonly { type?: string; data?: unknown }[] }
}): SessionMessageLike[] {
  const events = agent.session?.snapshotEvents?.() ?? []
  return events
    .filter((event) => event.type === 'user/message')
    .map((event) => event.data as SessionMessageLike)
}

function assistantMessagesOf(agent: {
  session?: { snapshotEvents?: () => readonly { type?: string; data?: unknown }[] }
}): AssistantMessageLike[] {
  const events = agent.session?.snapshotEvents?.() ?? []
  return events
    .filter((event) => event.type === 'assistant/message')
    .map((event) => (event.data as { message: AssistantMessageLike }).message)
}

function parentModelCalls(adapter: ScriptedAdapter, parent: { agent: { session: { id: unknown } } }): number {
  return adapter.requests.filter((request) => request.sessionId === String(parent.agent.session.id)).length
}

function textOf(message: SessionMessageLike): string {
  return message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('\n')
}

test('real host command: /agent-orbit is registered, preserved in history, and hard-activates once', { timeout: 120_000 }, async () => {
  const adapter = new ScriptedAdapter({
    finalVisibleText: 'Explicit Final Commander result',
    finalEvaluate: '{"decision":"SUCCESS","summary":"explicit durable summary"}',
  })
  const root = await boot(adapter)
  const project = tempProject()
  const parent = await makeParent(root, project.dir, 'e2e-parent-orbit-command')
  try {
    // The Web GUI slash menu reads this exact descriptor list.
    const descriptors = root.commands.list(parent.agent)
    const descriptor = descriptors.find((entry) => entry.name === 'agent-orbit')
    assert.ok(descriptor, `agent-orbit must be listed (got: ${descriptors.map((entry) => entry.name).join(', ') || '(none)'})`)
    assert.equal(descriptor.description, '使用 Orbit 确定性工程编排执行目标')
    assert.equal(descriptor.input?.hint, '描述要交给 Orbit 完成的工程目标')

    const commandLine = '/agent-orbit implement the deterministic fix'
    const execution = await root.commands.execute(parent.agent, commandLine, [], new AbortController().signal)
    assert.ok(execution)
    assert.equal(execution.result.kind, 'success')
    await parent.agent.whenIdle()

    const messages = userMessagesOf(parent.agent)
    const userTexts = messages.filter((message) => message.source.kind === 'user').map(textOf)
    assert.ok(userTexts.includes(commandLine), 'the user command must stay visible in conversation history')
    assert.equal(userTexts.filter((text) => text.startsWith('/agent-orbit')).length, 1, 'exactly one preserved user command message')
    assert.equal(
      messages.filter((message) => message.source.kind === 'orbit-command').length,
      0,
      'the host activation must not inject a synthetic directive',
    )

    // The host ran Orbit itself: durable state exists with the exact goal and
    // the parent model never ran for this turn.
    const state = readRunState(project.dir)
    assert.equal(state?.goal, 'implement the deterministic fix')
    assert.equal(state?.phase, 'SUCCESS')
    assert.equal(parentModelCalls(adapter, parent), 0, 'the parent model must not run for an explicit /agent-orbit turn')
    assert.equal(
      parent.agent.session.snapshotEvents().filter((event) => event.type === 'tool/call').length,
      0,
      'the parent must not run tools for an explicit /agent-orbit turn',
    )
    const finals = assistantMessagesOf(parent.agent)
    assert.equal(finals.length, 1, 'the explicit activation must surface exactly one final result')
    assert.equal(textOf(finals[0] as SessionMessageLike), 'Explicit Final Commander result')
    assert.equal(finals[0]?.source.provider, 'fake')
    assert.equal(finals[0]?.source.model, 'fm')
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
    assert.match(execution.result.text, /用法：\/agent-orbit/)
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

test('real host gesture: genuine /agent-orbit hard-activates while OFF; ordinary chat does not', { timeout: 120_000 }, async () => {
  const adapter = new ScriptedAdapter()
  const root = await boot(adapter)
  const project = tempProject()
  const parent = await makeParent(root, project.dir, 'e2e-parent-orbit-gesture')
  try {
    // Ordinary chat with the toggle OFF stays native.
    parent.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'please inspect this file' }], source: { kind: 'user' } }))
    await parent.agent.whenIdle()
    assert.equal(existsSync(join(project.dir, '.cx', 'state.json')), false, 'ordinary chat must not activate Orbit')
    assert.ok(adapter.seen.length >= 1, 'ordinary chat must reach the parent model')

    // A genuine `/agent-orbit` message activates the host runtime itself.
    parent.agent.followup(createUserMessage({ content: [{ type: 'text', text: '/agent-orbit headless fallback goal' }], source: { kind: 'user' } }))
    await parent.agent.whenIdle()
    const state = readRunState(project.dir)
    assert.equal(state?.goal, 'headless fallback goal')
    assert.equal(state?.phase, 'SUCCESS')
    assert.equal(
      userMessagesOf(parent.agent).filter((message) => message.source.kind === 'orbit-command').length,
      0,
      'the host activation must not inject a synthetic directive',
    )
    // Only the ordinary turn reached the parent model: the /agent-orbit turn
    // was consumed by the host.
    assert.equal(parentModelCalls(adapter, parent), 1, 'only the ordinary chat turn must reach the parent model')
    assert.equal(assistantMessagesOf(parent.agent).length, 2, 'native reply plus one Orbit final result must be visible')
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

function readRunState(dir: string): Record<string, unknown> | undefined {
  const path = join(dir, '.cx', 'state.json')
  if (!existsSync(path)) return undefined
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  } catch {
    return undefined
  }
}

test('real session toggle: /orbit-toggle is durable and promotes ordinary messages', { timeout: 120_000 }, async () => {
  const adapter = new ScriptedAdapter()
  const root = await boot(adapter)
  const project = tempProject()
  const parent = await makeParent(root, project.dir, 'e2e-parent-orbit-toggle')
  try {
    const descriptor = root.commands.list(parent.agent).find((entry) => entry.name === 'orbit-toggle')
    assert.ok(descriptor, 'orbit-toggle must be listed for the slash menu')

    // A new Session starts OFF.
    assert.equal(root.sessionProjections.stateOf(parent.agent.session, 'orbitSession')?.enabled, false)

    const on = await root.commands.execute(parent.agent, '/orbit-toggle on', [], new AbortController().signal)
    assert.ok(on)
    assert.equal(on.result.kind, 'success')
    const record = parent.agent.session
      .snapshotEvents()
      .find((event) => event.type === 'command/run' && (event.data as { name?: string }).name === 'orbit-toggle')
    assert.ok(record, 'the toggle must be a durable command/run record')
    assert.equal((record.data as { args?: string }).args?.trim(), 'on')
    assert.equal(root.sessionProjections.stateOf(parent.agent.session, 'orbitSession')?.enabled, true)
    assert.equal(existsSync(join(project.dir, '.cx', 'state.json')), false, 'toggling must not start a run')

    // An ordinary message now hard-activates: the host consumes the turn and
    // starts the run itself — no synthetic directive, no parent model call.
    parent.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'fix the failing test' }], source: { kind: 'user' } }))
    await parent.agent.whenIdle()
    assert.equal(
      userMessagesOf(parent.agent).filter((message) => message.source.kind === 'orbit-command').length,
      0,
      'the hard path must not inject a synthetic directive',
    )
    const run = readRunState(project.dir)
    assert.equal(run?.goal, 'fix the failing test')
    assert.equal(run?.phase, 'SUCCESS')

    // Explicit /agent-orbit while ON activates the host runtime itself and
    // must not double-start through the enabled-Session path.
    const beforeExplicit = readRunState(project.dir)?.run_id
    parent.agent.followup(createUserMessage({ content: [{ type: 'text', text: '/agent-orbit explicit goal' }], source: { kind: 'user' } }))
    await parent.agent.whenIdle()
    const explicitState = readRunState(project.dir)
    assert.equal(explicitState?.goal, 'explicit goal')
    assert.equal(explicitState?.phase, 'SUCCESS')
    assert.notEqual(explicitState?.run_id, beforeExplicit, 'the explicit goal becomes its own run')
    assert.equal(
      userMessagesOf(parent.agent).filter((message) => message.source.kind === 'orbit-command').length,
      0,
      'explicit /agent-orbit must not inject a synthetic directive',
    )

    // OFF keeps ordinary chat native and starts nothing new.
    const off = await root.commands.execute(parent.agent, '/orbit-toggle off', [], new AbortController().signal)
    assert.ok(off)
    assert.equal(off.result.kind, 'success')
    assert.equal(root.sessionProjections.stateOf(parent.agent.session, 'orbitSession')?.enabled, false)
    const seenBefore = adapter.seen.length
    parent.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'just chat now' }], source: { kind: 'user' } }))
    await parent.agent.whenIdle()
    assert.ok(adapter.seen.length > seenBefore, 'OFF ordinary messages reach the parent model')
    assert.equal(readRunState(project.dir)?.run_id, explicitState?.run_id, 'OFF must not start an Orbit run')
  } finally {
    await parent.dispose()
    await root.fiber.dispose()
    project.cleanup()
  }
})

test('real session toggle: turning OFF during an active run never stops or mutates it', { timeout: 120_000 }, async () => {
  const adapter = new ScriptedAdapter({ hangFirstExecutor: true, runtimeDiagnose: '{"decision":"RESTART_STEP"}' })
  const root = await boot(adapter, { executorTimeoutMs: 1500 })
  const project = tempProject()
  const parent = await makeParent(root, project.dir, 'e2e-parent-orbit-toggle-run')
  try {
    const run = root.agents.withInitiator(parent.agent, () =>
      root.orbit.run({ goal: 'toggle during run', approved_loop_count: 2 }, project.dir, new AbortController().signal),
    )
    await waitUntil(() => readRunState(project.dir)?.phase === 'EXECUTE', 20_000)
    const before = readRunState(project.dir)
    assert.ok(before, 'the run must have written its durable state')

    const off = await root.commands.execute(parent.agent, '/orbit-toggle off', [], new AbortController().signal)
    assert.ok(off)
    assert.equal(off.result.kind, 'success')

    const after = readRunState(project.dir)
    assert.equal(after?.run_id, before.run_id, 'the toggle must not replace the run')
    assert.deepEqual(after?.routes, before.routes, 'the toggle must not touch the frozen routes')
    assert.notEqual(after?.driver_ownership, 'CLOSED', 'the toggle must not close the active driver')

    const result = await run
    assert.equal(result.ok, true, result.message)
    assert.equal(result.phase, 'SUCCESS', 'the run must finish normally after the toggle')
  } finally {
    await parent.dispose()
    await root.fiber.dispose()
    project.cleanup()
  }
})

test('real host hard activation: an enabled Session runs Orbit from an ordinary message without the parent model', { timeout: 120_000 }, async () => {
  const adapter = new ScriptedAdapter({
    plan: JSON.stringify({
      summary: 'four-step proof',
      steps: [1, 2, 3, 4].map((index) => ({ id: `P${index}`, goal: `do step ${index}` })),
    }),
    finalVisibleText: '任务已完成。\n\n- 共执行 4 个 Step，全部通过\n- 最终状态：SUCCESS',
    finalEvaluate: '{"decision":"SUCCESS","summary":"4 steps passed"}',
  })
  const root = await boot(adapter)
  const project = tempProject()
  const parent = await makeParent(root, project.dir, 'e2e-parent-hard-activation')
  try {
    // Enable the per-chat toggle through the real host command.
    const on = await root.commands.execute(parent.agent, '/orbit-toggle on', [], new AbortController().signal)
    assert.ok(on)
    assert.equal(on.result.kind, 'success')
    assert.equal(root.sessionProjections.stateOf(parent.agent.session, 'orbitSession')?.enabled, true)

    // An ordinary message — never `/agent-orbit`. The scripted parent model
    // never calls a tool: only the host can start Orbit here.
    parent.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'create the hard activation proof' }], source: { kind: 'user' } }))
    await parent.agent.whenIdle()

    const state = readRunState(project.dir)
    assert.ok(state, 'the host must have written durable run state')
    assert.equal(state.phase, 'SUCCESS')
    assert.equal(state.goal, 'create the hard activation proof')
    assert.equal(Number(state.approved_loop_count), 6, 'four-step hard activation reserves two bounded recovery slots')
    assert.equal(state.loop_budget_mode, 'automatic')
    assert.equal(adapter.executorCalls, 4, 'all four Executor steps must run through the real Orbit chain')
    assert.ok(adapter.seen.some((entry) => entry.includes('Orbit 指挥官')), 'the Commander must actually plan')

    // The raw role prompts are Chinese; only machine identifiers stay English.
    const planPrompt = adapter.prompts.find((prompt) => prompt.includes('当前阶段：PLAN')) ?? ''
    assert.match(planPrompt, /你是 Orbit 指挥官/)
    assert.doesNotMatch(planPrompt, /You are the Orbit Commander/)
    assert.doesNotMatch(planPrompt, /Hard constraints:/)
    const executorPrompt = adapter.prompts.find((prompt) => prompt.startsWith('你是 Orbit 执行员')) ?? ''
    assert.ok(executorPrompt !== '', 'the Executor prompt must be Chinese')
    assert.doesNotMatch(executorPrompt, /You are the Orbit Executor/)
    assert.doesNotMatch(executorPrompt, /Working directory:/)
    assert.match(executorPrompt, /简体中文/)

    // The parent turn was consumed: no parent model call, no parent tool call,
    // and the user message stays in the conversation.
    const parentEvents = parent.agent.session.snapshotEvents()
    assert.equal(parentModelCalls(adapter, parent), 0, 'the parent model must not run for a hard-activated turn')
    assert.equal(
      parentEvents.filter((event) => event.type === 'tool/call').length,
      0,
      'the parent must not run tools for a hard-activated turn',
    )
    const userTexts = userMessagesOf(parent.agent).filter((message) => message.source.kind === 'user').map(textOf)
    assert.deepEqual(userTexts, ['create the hard activation proof'], 'the message stays as durable history')
    const finals = assistantMessagesOf(parent.agent)
    assert.equal(finals.length, 1, 'four step reviews plus FINAL_EVALUATE must surface one final result')
    assert.match(textOf(finals[0] as SessionMessageLike), /共执行 4 个 Step，全部通过/)
    assert.doesNotMatch(textOf(finals[0] as SessionMessageLike), /reasoning|structured_output|tool-call/)

    // A second ordinary message starts the next run with the new goal.
    parent.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'second hard activation goal' }], source: { kind: 'user' } }))
    await parent.agent.whenIdle()
    const next = readRunState(project.dir)
    assert.notEqual(next?.run_id, state.run_id, 'the finished run must be replaced by the next run')
    assert.equal(next?.goal, 'second hard activation goal')
    assert.equal(next?.phase, 'SUCCESS')
    assert.equal(adapter.executorCalls, 8, 'the second four-step run must execute again')
    assert.equal(assistantMessagesOf(parent.agent).length, 2, 'each successful hard activation emits exactly one final result')
  } finally {
    await parent.dispose()
    await root.fiber.dispose()
    project.cleanup()
  }
})

test('real host NEEDS_USER: an arbitrary user reply resumes the same run with the reply durable', { timeout: 120_000 }, async () => {
  const adapter = new ScriptedAdapter({
    stepEvaluates: [
      '{"decision":"NEEDS_USER","reason":"请提供目标端口号"}',
      '{"decision":"PASS_CURRENT_STEP"}',
    ],
  })
  const root = await boot(adapter)
  const project = tempProject()
  const parent = await makeParent(root, project.dir, 'e2e-parent-needs-user')
  try {
    const on = await root.commands.execute(parent.agent, '/orbit-toggle on', [], new AbortController().signal)
    assert.ok(on)

    // An ordinary message hard-activates the run; the Commander asks a question.
    parent.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'deploy service' }], source: { kind: 'user' } }))
    await parent.agent.whenIdle()
    const paused = readRunState(project.dir)
    assert.equal(paused?.phase, 'NEEDS_USER')
    assert.equal(paused?.goal, 'deploy service')
    assert.ok(typeof paused?.run_id === 'string' && paused.run_id !== '')

    // The question must be visible to the user: a durable host notice.
    const notice = userMessagesOf(parent.agent).find((message) => (message.source as { form?: string }).form === 'notice')
    assert.ok(notice, 'the NEEDS_USER question must surface as a notice')
    assert.match(textOf(notice as SessionMessageLike), /请提供目标端口号/)

    // A reply with completely different text resumes the SAME run.
    parent.agent.followup(createUserMessage({ content: [{ type: 'text', text: '8080' }], source: { kind: 'user' } }))
    await parent.agent.whenIdle()
    const done = readRunState(project.dir)
    assert.equal(done?.run_id, paused?.run_id, 'the reply must continue the same run')
    assert.equal(done?.goal, 'deploy service', 'the original goal is never rewritten')
    assert.equal(done?.pending_user_reply, '8080', 'the reply stays in durable state')
    assert.equal(done?.phase, 'SUCCESS')

    // The Commander and Executor actually consumed the reply.
    assert.ok(
      adapter.prompts.some((prompt) => prompt.includes('你是 Orbit 执行员') && prompt.includes('8080')),
      'the Executor prompt must carry the user reply',
    )
    assert.ok(
      adapter.prompts.some((prompt) => prompt.includes('STEP_EVALUATE') && prompt.includes('8080')),
      'the Commander evaluation prompt must carry the user reply',
    )

    // The host stayed the only mutation driver.
    const events = parent.agent.session.snapshotEvents()
    assert.equal(parentModelCalls(adapter, parent), 0)
    assert.equal(events.filter((event) => event.type === 'assistant/message').length, 1)
    assert.equal(events.filter((event) => event.type === 'tool/call').length, 0)
  } finally {
    await parent.dispose()
    await root.fiber.dispose()
    project.cleanup()
  }
})

test('real host: slashCommand=false keeps enabled-Session hard activation', { timeout: 120_000 }, async () => {
  const adapter = new ScriptedAdapter()
  const root = await boot(adapter, { slashCommand: false })
  const project = tempProject()
  const parent = await makeParent(root, project.dir, 'e2e-parent-slash-off')
  try {
    // The slash command is gone; the per-chat toggle command stays for the UI.
    const names = root.commands.list(parent.agent).map((entry) => entry.name)
    assert.equal(names.includes('agent-orbit'), false, 'slashCommand=false must not register the /agent-orbit command')
    assert.equal(names.includes('orbit-toggle'), true, 'the per-chat toggle command stays for the UI')

    const on = await root.commands.execute(parent.agent, '/orbit-toggle on', [], new AbortController().signal)
    assert.ok(on)

    // An ordinary message still hard-activates.
    parent.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'create the disabled-slash proof' }], source: { kind: 'user' } }))
    await parent.agent.whenIdle()
    const state = readRunState(project.dir)
    assert.equal(state?.goal, 'create the disabled-slash proof')
    assert.equal(state?.phase, 'SUCCESS')
    assert.equal(parentModelCalls(adapter, parent), 0, 'the parent model must not run with slashCommand=false')
    assert.equal(textOf(assistantMessagesOf(parent.agent)[0] as SessionMessageLike), 'scripted final summary')

    // A genuine `/agent-orbit` message still activates without the command.
    parent.agent.followup(createUserMessage({ content: [{ type: 'text', text: '/agent-orbit second explicit goal' }], source: { kind: 'user' } }))
    await parent.agent.whenIdle()
    const next = readRunState(project.dir)
    assert.equal(next?.goal, 'second explicit goal')
    assert.equal(next?.phase, 'SUCCESS')
    assert.equal(assistantMessagesOf(parent.agent).length, 2)
  } finally {
    await parent.dispose()
    await root.fiber.dispose()
    project.cleanup()
  }
})

test('real host hard activation: unavailable model keeps the error notice and never emits a false final result', { timeout: 120_000 }, async () => {
  const adapter = new ScriptedAdapter()
  const root = await boot(adapter)
  const project = tempProject()
  const parent = await makeParent(root, project.dir, 'e2e-parent-unavailable-model')
  try {
    installTestModelSelection(root)
    parent.agent.session.append('model/selection', { provider: 'missing-provider', model: 'missing-model' })
    assert.ok(await root.commands.execute(parent.agent, '/orbit-toggle on', [], new AbortController().signal))

    parent.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'must fail before starting' }], source: { kind: 'user' } }))
    await parent.agent.whenIdle()

    assert.equal(parentModelCalls(adapter, parent), 0)
    assert.equal(parent.agent.session.snapshotEvents().filter((event) => event.type === 'tool/call').length, 0)
    assert.equal(assistantMessagesOf(parent.agent).length, 0, 'a failed activation must not emit a SUCCESS final result')
    const notices = userMessagesOf(parent.agent).filter((message) => (message.source as { form?: string }).form === 'notice')
    assert.ok(notices.some((message) => /ORBIT_MODEL_UNAVAILABLE/.test(textOf(message as SessionMessageLike))))
  } finally {
    await parent.dispose()
    await root.fiber.dispose()
    project.cleanup()
  }
})

/** The durable `modelSelection` unit exactly as the session controller registers it. */
function installTestModelSelection(root: Context): void {
  root.sessionProjections.register({
    key: 'modelSelection',
    stateSchema: { parse: (value: unknown) => value },
    init: () => ({ lastUsed: null, pending: null }),
    apply: (state: { lastUsed: unknown; pending: unknown }, event: { type: string; data: unknown }) =>
      event.type === 'model/selection' ? { lastUsed: state.lastUsed, pending: event.data } : state,
    wire: {
      viewSchema: { parse: (value: unknown) => value },
      view: (state: { lastUsed: unknown; pending: unknown }) => ({
        lastUsed: state.lastUsed,
        next: state.pending ?? state.lastUsed,
      }),
    },
    stateVersion: 2,
  } as never)
}

test('real host: the Executor route follows the durable Session modelSelection without a request header', { timeout: 120_000 }, async () => {
  const adapter = new ScriptedAdapter()
  const root = await boot(adapter, { providers: ['fake', 'provider-b'] })
  const project = tempProject()
  const parent = await makeParent(root, project.dir, 'e2e-parent-session-route')
  try {
    installTestModelSelection(root)
    // The user picked a non-deepseek provider; no parent model request exists
    // yet — exactly the hard-activation case that used to fall back to config.
    parent.agent.session.append('model/selection', { provider: 'provider-b', model: 'model-b', reasoningEffort: 'xhigh' })
    assert.equal(parent.agent.session.requestHeader(), undefined, 'this regression only reproduces without a request header')

    const on = await root.commands.execute(parent.agent, '/orbit-toggle on', [], new AbortController().signal)
    assert.ok(on)
    parent.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'create the session route proof' }], source: { kind: 'user' } }))
    await parent.agent.whenIdle()

    const state = readRunState(project.dir) as
      | { phase?: string; routes?: Record<string, { provider?: string; model?: string; reasoningEffort?: string }> }
      | undefined
    assert.equal(state?.phase, 'SUCCESS')
    assert.deepEqual(state?.routes?.['executor'], {
      provider: 'provider-b',
      model: 'model-b',
      reasoningEffort: 'xhigh',
    })

    // The real Executor child actually requested the Session's route.
    const executorRequests = adapter.requests.filter((entry) => entry.prompt.startsWith('你是 Orbit 执行员'))
    assert.ok(executorRequests.length >= 1, 'the Executor must have run')
    for (const entry of executorRequests) {
      assert.equal(entry.provider, 'provider-b')
      assert.equal(entry.model, 'model-b')
      assert.equal(entry.reasoningEffort, 'xhigh')
    }
  } finally {
    await parent.dispose()
    await root.fiber.dispose()
    project.cleanup()
  }
})

test('real host: a different Session never resumes another Session NEEDS_USER run', { timeout: 120_000 }, async () => {
  const adapter = new ScriptedAdapter({
    stepEvaluates: [
      '{"decision":"NEEDS_USER","reason":"请提供端口号"}',
      '{"decision":"PASS_CURRENT_STEP"}',
    ],
  })
  const root = await boot(adapter)
  const project = tempProject()
  const sessionA = await makeParent(root, project.dir, 'e2e-session-a')
  const sessionB = await makeParent(root, project.dir, 'e2e-session-b')
  const executorRuns = () => adapter.requests.filter((entry) => entry.prompt.startsWith('你是 Orbit 执行员')).length
  try {
    // Session A starts a run that waits for user input.
    assert.ok(await root.commands.execute(sessionA.agent, '/orbit-toggle on', [], new AbortController().signal))
    sessionA.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'deploy service' }], source: { kind: 'user' } }))
    await sessionA.agent.whenIdle()
    const paused = readRunState(project.dir)
    assert.equal(paused?.phase, 'NEEDS_USER')
    assert.equal(paused?.owner_session_id, String(sessionA.agent.session.id), 'the run records its owning Session')
    const before = executorRuns()

    // Session B sends a brand-new task: it must never be consumed as A's reply.
    assert.ok(await root.commands.execute(sessionB.agent, '/orbit-toggle on', [], new AbortController().signal))
    sessionB.agent.followup(createUserMessage({ content: [{ type: 'text', text: '帮我检查另一个项目' }], source: { kind: 'user' } }))
    await sessionB.agent.whenIdle()

    const blocked = readRunState(project.dir)
    assert.equal(blocked?.run_id, paused?.run_id, 'the old run id must not change')
    assert.equal(blocked?.goal, 'deploy service', 'the old goal must not change')
    assert.equal(blocked?.phase, 'NEEDS_USER')
    assert.equal(blocked?.pending_user_reply ?? null, null, "Session B's message never enters pending_user_reply")
    assert.equal(executorRuns(), before, 'no Executor may auto-start for a foreign Session')

    const notices = userMessagesOf(sessionB.agent).filter((message) => (message.source as { form?: string }).form === 'notice')
    assert.ok(
      notices.some((message) => textOf(message as SessionMessageLike).includes('ORBIT_NEEDS_USER_OTHER_SESSION')),
      'Session B must see the owner notice',
    )

    // The owning Session still resumes the same run.
    sessionA.agent.followup(createUserMessage({ content: [{ type: 'text', text: '8080' }], source: { kind: 'user' } }))
    await sessionA.agent.whenIdle()
    const done = readRunState(project.dir)
    assert.equal(done?.run_id, paused?.run_id)
    assert.equal(done?.goal, 'deploy service')
    assert.equal(done?.pending_user_reply, '8080')
    assert.equal(done?.phase, 'SUCCESS')
  } finally {
    await sessionA.dispose()
    await sessionB.dispose()
    await root.fiber.dispose()
    project.cleanup()
  }
})

test('real host: a fresh Session without projection state or header uses the deployment default model', { timeout: 120_000 }, async () => {
  const adapter = new ScriptedAdapter()
  const root = await boot(adapter, { providers: ['fake', 'provider-b'] })
  const project = tempProject()
  const parent = await makeParent(root, project.dir, 'e2e-fresh-session')
  try {
    // The deployment default service, as the real profile mounts it.
    ;(root.reflect.get('agentDefaultModel') as { currentSelection: () => unknown }).currentSelection =
      () => ({ provider: 'provider-b', model: 'model-b', reasoningEffort: 'xhigh' })

    // A fresh Session: the projection is registered but empty, no header yet.
    installTestModelSelection(root)
    assert.equal(parent.agent.session.requestHeader(), undefined, 'no parent request exists before the hard activation')
    const projected = root.sessionProjections.stateOf(parent.agent.session, 'modelSelection') as
      | { pending?: unknown; lastUsed?: unknown }
      | undefined
    assert.equal(projected?.pending ?? null, null)
    assert.equal(projected?.lastUsed ?? null, null)

    assert.ok(await root.commands.execute(parent.agent, '/orbit-toggle on', [], new AbortController().signal))
    parent.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'create the fresh-session proof' }], source: { kind: 'user' } }))
    await parent.agent.whenIdle()

    const state = readRunState(project.dir) as
      | { phase?: string; routes?: Record<string, { provider?: string; model?: string; reasoningEffort?: string }> }
      | undefined
    assert.equal(state?.phase, 'SUCCESS')
    assert.deepEqual(state?.routes?.['executor'], {
      provider: 'provider-b',
      model: 'model-b',
      reasoningEffort: 'xhigh',
    })
    // Commander and Watchdog keep their own configured routes.
    assert.deepEqual(state?.routes?.['commander'], { provider: 'fake', model: 'fm', reasoningEffort: 'off' })
    assert.deepEqual(state?.routes?.['watchdog'], { provider: 'fake', model: 'fm', reasoningEffort: 'off' })

    // The real Executor child actually requested the deployment default.
    const executorRequests = adapter.requests.filter((entry) => entry.prompt.startsWith('你是 Orbit 执行员'))
    assert.ok(executorRequests.length >= 1, 'the Executor must have run')
    for (const entry of executorRequests) {
      assert.equal(entry.provider, 'provider-b')
      assert.equal(entry.model, 'model-b')
      assert.equal(entry.reasoningEffort, 'xhigh')
    }
  } finally {
    await parent.dispose()
    await root.fiber.dispose()
    project.cleanup()
  }
})
