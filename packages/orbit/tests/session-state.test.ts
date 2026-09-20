import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ORBIT_RUNTIME_KEY,
  ORBIT_SESSION_KEY,
  ORBIT_TOGGLE_COMMAND,
  foldOrbitRuntime,
  foldOrbitSession,
  installOrbitSessionProjection,
  orbitRuntimeFromState,
  parseOrbitToggle,
  type OrbitRuntimeState,
  type OrbitSessionState,
} from '../src/session-state.ts'

test('the toggle argument parses only to on/off', () => {
  assert.equal(ORBIT_TOGGLE_COMMAND, 'orbit-toggle')
  assert.equal(parseOrbitToggle('on'), true)
  assert.equal(parseOrbitToggle(' ON '), true)
  assert.equal(parseOrbitToggle('off'), false)
  assert.equal(parseOrbitToggle(' Off'), false)
  assert.equal(parseOrbitToggle(''), undefined)
  assert.equal(parseOrbitToggle('true'), undefined)
  assert.equal(parseOrbitToggle('/orbit-toggle on'), undefined)
})

test('a new Session starts OFF and folds its own toggle records', () => {
  const toggle = (args: string) => ({ type: 'command/run', data: { name: ORBIT_TOGGLE_COMMAND, args } })
  assert.deepEqual(foldOrbitSession({ enabled: false }, toggle(' on')), { enabled: true })
  assert.deepEqual(foldOrbitSession({ enabled: true }, toggle('off')), { enabled: false })
  assert.deepEqual(foldOrbitSession({ enabled: true }, toggle(' on')), { enabled: true })
})

test('unrelated events, other commands, and malformed arguments keep the same state', () => {
  const state: OrbitSessionState = { enabled: true }
  assert.equal(foldOrbitSession(state, { type: 'turn/start', data: { turn: 1 } }), state)
  assert.equal(foldOrbitSession(state, { type: 'command/run', data: { name: 'agent-orbit', args: ' goal' } }), state)
  assert.equal(foldOrbitSession(state, { type: 'command/run', data: { name: ORBIT_TOGGLE_COMMAND, args: 'maybe' } }), state)
  assert.equal(foldOrbitSession(state, { type: 'command/run', data: { name: ORBIT_TOGGLE_COMMAND } }), state)
  assert.equal(foldOrbitSession(state, { type: 'command/run', data: 'not-a-record' }), state)
})

test('the projections register strict toggle and runtime wire shapes', () => {
  const registered: Array<Record<string, unknown>> = []
  const ctx = {
    sessionProjections: {
      register: (definition: never) => {
        registered.push(definition as never)
        return () => undefined
      },
    },
  }
  installOrbitSessionProjection(ctx as never)
  assert.equal(registered.length, 2)

  const toggle = registered.find((definition) => definition['key'] === ORBIT_SESSION_KEY) as {
    init: () => OrbitSessionState
    apply: (state: OrbitSessionState, event: { type: string; data: unknown }) => OrbitSessionState
    wire: { view: (state: OrbitSessionState) => OrbitSessionState }
    stateSchema: { parse: (value: unknown) => unknown }
  }
  assert.deepEqual(toggle.init(), { enabled: false })
  assert.deepEqual(toggle.apply({ enabled: false }, { type: 'command/run', data: { name: ORBIT_TOGGLE_COMMAND, args: ' on' } }), { enabled: true })
  assert.deepEqual(toggle.wire.view({ enabled: true }), { enabled: true })
  assert.deepEqual(toggle.stateSchema.parse({ enabled: false }), { enabled: false })
  assert.throws(() => toggle.stateSchema.parse({ enabled: 'yes' }))
  assert.throws(() => toggle.stateSchema.parse(null))

  const runtime = registered.find((definition) => definition['key'] === ORBIT_RUNTIME_KEY) as {
    init: () => OrbitRuntimeState | null
    apply: (state: OrbitRuntimeState | null, event: { type: string; data: unknown }) => OrbitRuntimeState | null
    wire: { view: (state: OrbitRuntimeState | null) => OrbitRuntimeState | null }
    stateSchema: { parse: (value: unknown) => unknown }
  }
  assert.equal(runtime.init(), null)
  const snapshot: OrbitRuntimeState = {
    runId: 'run-1',
    phase: 'EXECUTE',
    status: 'running',
    loop: { used: 1, max: 5 },
    currentStep: { id: 'P1', attempt: 1, executionMode: 'MOA' },
    moa: {
      phase: 'JUDGE',
      candidates: [{ index: 1, provider: 'p', model: 'm', ok: true, files: 2, usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15, cost_usd: 0.01 } }],
      judgeModel: 'p/judge',
      totalUsage: { input_tokens: 10, output_tokens: 5, total_tokens: 15, cost_usd: 0.01 },
    },
    updatedAt: '2026-09-20T00:00:00.000Z',
  }
  assert.deepEqual(runtime.apply(null, { type: 'orbit/runtime', data: snapshot }), snapshot)
  assert.deepEqual(runtime.wire.view(snapshot), snapshot)
  assert.deepEqual(runtime.stateSchema.parse(snapshot), snapshot)
  assert.throws(() => runtime.stateSchema.parse({ phase: 'EXECUTE' }))
})

test('runtime snapshot is bounded and excludes candidate/Judge text', () => {
  const snapshot = orbitRuntimeFromState({
    schema_version: 3,
    active_run_id: 'run-1',
    run_id: 'run-1',
    phase: 'EXECUTE',
    status: 'running',
    driver_ownership: 'ACTIVE',
    state_revision: 9,
    updated_at: '2026-09-20T00:00:00.000Z',
    goal: 'secret goal text is not projected',
    goal_hash: 'hash',
    routes: {
      commander: { provider: 'p', model: 'c' },
      executor: { provider: 'p', model: 'e' },
      watchdog: { provider: 'p', model: 'w' },
    },
    moa_policy: {
      enabled: true,
      candidate_count: 2,
      peer_critique: false,
      max_moa_steps: 1,
      candidates: [{ provider: 'p', model: 'a' }, { provider: 'p', model: 'b' }],
      judge: { provider: 'p', model: 'j' },
    },
    loop: { used: 0, max: 5 },
    remaining_budget: 5,
    loop_count: 0,
    plan: { summary: 'hidden', steps: [{ id: 'P0', goal: 'hidden step text', execution_mode: 'MOA', status: 'running' }] },
    changed_files: [],
    test_summary: [],
    last_error: null,
    user_hard_constraints: [],
    github_allowed: false,
    interruption_retries: 0,
    current_step: { id: 'P0', attempt: 1 },
    moa_step: {
      step_id: 'P0',
      phase: 'JUDGE',
      candidates: [
        { index: 1, provider: 'p', model: 'a', ok: true, summary: 'DO NOT PROJECT', files: ['x.ts'], usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } },
        { index: 2, provider: 'p', model: 'b', ok: false, summary: 'DO NOT PROJECT', files: [], error: 'hidden' },
      ],
      successful_candidates: 1,
      failed_candidates: 1,
      judge_summary: 'DO NOT PROJECT',
      total_usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
    },
  } as never)
  assert.equal(snapshot.currentStep?.executionMode, 'MOA')
  assert.equal(snapshot.moa?.candidates[0]?.files, 1)
  assert.equal(JSON.stringify(snapshot).includes('DO NOT PROJECT'), false)
  assert.equal(JSON.stringify(snapshot).includes('secret goal'), false)
  assert.deepEqual(foldOrbitRuntime(null, { type: 'orbit/runtime', data: snapshot }), snapshot)
})
