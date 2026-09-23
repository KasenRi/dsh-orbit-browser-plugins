import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import LlmPlugin, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import SessionPlugin, { SessionId } from '@deepseek-ai/dsh-session'
import PersistencePlugin from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjectionPlugin from '@deepseek-ai/dsh-session-projection'
import SystemPromptPlugin from '@deepseek-ai/dsh-system-prompt'
import ToolsPlugin, { defineTool } from '@deepseek-ai/dsh-tools'
import AgentPlugin from '@deepseek-ai/dsh-agent'
import AgentLoopPlugin from '@deepseek-ai/dsh-agent-loop'
import SubagentPlugin from '@deepseek-ai/dsh-subagent'
import * as SpawnPlugin from '@deepseek-ai/dsh-subagent-spawn-in-process'
import * as OrbitPlugin from '../../src/index.ts'
import type { OrbitService } from '../../src/service.ts'
import type { OrbitState } from '../../src/types.ts'

const MODEL = { provider: 'fake', model: 'fm' }
const ROUTE = { provider: 'fake', model: 'fm', reasoningEffort: 'off' }

/** Minimal scripted adapter that always answers with a passing Commander decision. */
class LegacyAdapter extends LlmAdapter {
  providerInfo(provider: string): { id: string; name: string } {
    return { id: provider, name: 'LegacyScripted' }
  }
  async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return {
      provider,
      id: model,
      name: model,
      inputModalities: ['text'],
      context: { contextWindow: 100_000 },
      reasoning: { efforts: [{ id: 'off', name: 'Off' }], defaultEffort: 'off' },
    } as unknown as LlmResolvedModelInfo
  }
  async *stream(): AsyncIterable<StreamChunk> {
    const reply = '{"decision":"SUCCESS"}'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: reply }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
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

async function boot(): Promise<Context> {
  const root = new Context()
  const storage = mkdtempSync(join(tmpdir(), 'dsh-orbit-legacy-store-'))
  const plugins: Array<[unknown, unknown]> = [
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
  ]
  for (const [plugin, config] of plugins) await root.plugin(plugin as never, config as never)
  root.llm.registerAdapter(['fake'], new LegacyAdapter())
  for (const name of ['read', 'glob', 'grep', 'bash', 'write', 'edit', 'agent_browser']) root.tools.register(stubTool(name))
  await root.plugin(OrbitPlugin as never, {
    routes: { commander: ROUTE, executor: ROUTE, watchdog: ROUTE },
    browserTools: ['agent_browser'],
    commanderReadOnlyTools: ['read'],
    watchdogTools: ['read'],
    executorTools: ['read', 'write', 'bash'],
    registerTool: true,
    registerGuards: true,
  } as never)
  return root
}

test('legacy compatibility: canonical and legacy tools share one service', { timeout: 60_000 }, async () => {
  const root = await boot()
  const parent = await root.agents.create({ sessionId: SessionId('legacy-parent'), agentOptions: MODEL, meta: { cwd: '/tmp' } })
  try {
    assert.ok(root.tools.get('orbit_controller'), 'orbit_controller must be registered')
    assert.ok(root.tools.get('cx_controller'), 'legacy cx_controller alias must be registered')

    const scope = root as unknown as { orbit: Record<string, unknown>; cx: Record<string, unknown> }
    assert.ok(scope.orbit, 'ctx.orbit must be available')
    assert.ok(scope.cx, 'ctx.cx legacy alias must be available')
    // cordis wraps service access in a traceable proxy, so identity is proven by
    // a marker written through one alias and read through the other.
    const marker = Symbol('identity')
    scope.orbit['__identityProbe'] = marker
    assert.equal(scope.cx['__identityProbe'], marker, 'ctx.cx must alias the same OrbitService instance')
    assert.equal((scope.orbit as { name?: string }).name, 'orbit')

    const legacyDescription = root.tools.get('cx_controller')?.description ?? ''
    assert.match(legacyDescription, /Legacy compatibility alias/)
    assert.match(legacyDescription, /orbit_controller/)
  } finally {
    await parent.dispose()
    await root.fiber.dispose()
  }
})

test('legacy compatibility: old .cx/state.json resumes under Orbit', { timeout: 60_000 }, async () => {
  const root = await boot()
  const projectDir = mkdtempSync(join(tmpdir(), 'dsh-orbit-legacy-project-'))
  const parent = await root.agents.create({ sessionId: SessionId('legacy-resume'), agentOptions: MODEL, meta: { cwd: projectDir } })
  try {
    // A state document as written by the previous CX-era runtime, including a
    // historical CX_* last_error string that must be read as plain history.
    const legacyState: OrbitState = {
      schema_version: 5,
      active_run_id: 'legacy-run',
      run_id: 'legacy-run',
      phase: 'SUCCESS',
      status: 'success',
      driver_ownership: 'CLOSED',
      state_revision: 3,
      updated_at: new Date().toISOString(),
      goal: 'legacy goal',
      goal_hash: 'g0',
      preset: 'cx-lite',
      routes: { commander: ROUTE, executor: ROUTE, watchdog: ROUTE },
      loop: { used: 1, max: 2 },
      approved_loop_count: 2,
      remaining_budget: 1,
      loop_count: 1,
      plan: { summary: 'legacy plan', steps: [{ id: 'P0', goal: 'legacy step', status: 'passed' }] },
      changed_files: [],
      test_summary: [],
      last_error: 'CX_RUN_NOT_FOUND: historical value',
      user_hard_constraints: [],
      github_allowed: false,
      interruption_retries: 0,
    }
    const { OrbitStateStore } = await import('../../src/state-store.ts')
    new OrbitStateStore(projectDir).writeState(legacyState)

    const status = await root.agents.withInitiator(parent.agent, () => root.orbit.status(projectDir))
    assert.equal(status.ok, true)
    assert.equal(status.phase, 'SUCCESS')
    assert.equal(status.data?.['goal'], 'legacy goal')

    const toolResult = await root.tools.execute({
      callId: ToolCallId('legacy-status'),
      name: 'cx_controller',
      arguments: { action: 'status' },
      agent: parent.agent,
      signal: new AbortController().signal,
    })
    assert.ok(!JSON.stringify(toolResult).includes('"isError":true'), JSON.stringify(toolResult).slice(0, 400))
    assert.match(JSON.stringify(toolResult), /SUCCESS/)
  } finally {
    await parent.dispose()
    await root.fiber.dispose()
    rmSync(projectDir, { recursive: true, force: true })
  }
})

test('legacy compatibility: rejected cx_controller run still returns a normal result', { timeout: 60_000 }, async () => {
  const root = await boot()
  const projectDir = mkdtempSync(join(tmpdir(), 'dsh-orbit-legacy-reject-'))
  const parent = await root.agents.create({ sessionId: SessionId('legacy-reject'), agentOptions: MODEL, meta: { cwd: projectDir } })
  try {
    const result = await root.tools.execute({
      callId: ToolCallId('legacy-run-missing-goal'),
      name: 'cx_controller',
      arguments: { action: 'run' },
      agent: parent.agent,
      signal: new AbortController().signal,
    })
    const payload = JSON.stringify(toolResultValue(result))
    assert.match(payload, /ORBIT_GOAL_REQUIRED/)
  } finally {
    await parent.dispose()
    await root.fiber.dispose()
    rmSync(projectDir, { recursive: true, force: true })
  }
})

function toolResultValue(result: unknown): unknown {
  if (result !== null && typeof result === 'object' && 'value' in (result as Record<string, unknown>)) {
    return (result as Record<string, unknown>)['value']
  }
  return result
}
