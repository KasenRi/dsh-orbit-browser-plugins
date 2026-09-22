import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OrbitStateStore } from '../src/state-store.ts'
import { OrbitSupervisor, type OrbitSupervisorConfig } from '../src/supervisor.ts'
import { FakeHost } from './helpers/fake-host.ts'

const config: OrbitSupervisorConfig = {
  defaultRoutes: {
    commander: { provider: 'provider-a', model: 'model-b', reasoningEffort: 'high' },
    executor: { provider: 'provider-a', model: 'model-a', reasoningEffort: 'high' },
    watchdog: { provider: 'provider-a', model: 'model-a', reasoningEffort: 'low' },
  },
  browserTools: ['agent_browser'],
  commanderReadOnlyTools: ['read', 'read_image', 'glob', 'grep', 'web_search', 'web_fetch'],
  watchdogTools: ['read', 'read_image', 'glob', 'grep'],
  executorTools: ['read', 'glob', 'grep', 'bash', 'write', 'edit'],
}

function project(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-orbit-test-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

function make(host: FakeHost, dir: string): OrbitSupervisor {
  return new OrbitSupervisor(new OrbitStateStore(dir), host, config)
}

const plan = (steps: Array<{ id: string; goal: string; capabilities?: string[] }>, summary = 'plan') =>
  ({ summary, steps })

const commander = (decision: Record<string, unknown>) => decision

test('PLAN -> EXECUTE -> EVALUATE -> SUCCESS', async () => {
  const { dir, cleanup } = project()
  const host = new FakeHost()
  host
    .script('commander', [
      { structured: plan([{ id: 'P1', goal: 'do a' }]) },
      { structured: commander({ decision: 'PASS_CURRENT_STEP' }) },
      {
        output: '[reasoning]\n[tool-call]',
        visibleOutput: 'Final Commander result',
        structured: commander({ decision: 'SUCCESS', summary: 'Durable final summary' }),
      },
    ])
    .script('executor', [{ output: 'did a', childId: 'e1' }])
  const result = await make(host, dir).bootstrap({ goal: 'ship feature', approved_loop_count: 5 })
  assert.equal(result.ok, true)
  assert.equal(result.phase, 'SUCCESS')
  assert.deepEqual(result.final_output, {
    text: 'Final Commander result',
    provider: 'provider-a',
    model: 'model-b',
  })
  assert.equal(result.data?.['loop'] && (result.data['loop'] as { used: number }).used, 1)
  cleanup()
})

test('STEP_EVALUATE rejects SUCCESS as a recoverable interruption', async () => {
  const { dir, cleanup } = project()
  const host = new FakeHost()
  host
    .script('commander', [{ structured: plan([{ id: 'P1', goal: 'a' }]) }, { structured: commander({ decision: 'SUCCESS' }) }])
    .script('executor', [{ output: 'done', childId: 'e1' }])
  const result = await make(host, dir).bootstrap({ goal: 'x', approved_loop_count: 5 })
  assert.equal(result.ok, false)
  assert.equal(result.phase, 'EVALUATE')
  assert.match(String(result.data?.['last_error']), /COMMANDER_EVALUATION_DECISION_INVALID_FOR_MODE/)
  cleanup()
})

test('FINAL_EVALUATE rejects PASS_CURRENT_STEP as a recoverable interruption', async () => {
  const { dir, cleanup } = project()
  const host = new FakeHost()
  host
    .script('commander', [
      { structured: plan([{ id: 'P1', goal: 'a' }]) },
      { structured: commander({ decision: 'PASS_CURRENT_STEP' }) },
      { structured: commander({ decision: 'PASS_CURRENT_STEP' }) },
    ])
    .script('executor', [{ output: 'done', childId: 'e1' }])
  const result = await make(host, dir).bootstrap({ goal: 'x', approved_loop_count: 5 })
  assert.equal(result.ok, false)
  assert.match(String(result.data?.['last_error']), /COMMANDER_EVALUATION_DECISION_INVALID_FOR_MODE/)
  cleanup()
})

test('bounded corrections reach CORRECTION_LIMIT_REACHED', async () => {
  const { dir, cleanup } = project()
  const host = new FakeHost()
  host
    .script('commander', [
      { structured: plan([{ id: 'P1', goal: 'a' }]) },
      { structured: commander({ decision: 'CORRECT_CURRENT_STEP', next_step_goal: 'fix1' }) },
      { structured: commander({ decision: 'CORRECT_CURRENT_STEP', next_step_goal: 'fix2' }) },
      { structured: commander({ decision: 'KEEP_APPROACH' }) },
      { structured: commander({ decision: 'CORRECT_CURRENT_STEP', next_step_goal: 'fix3' }) },
    ])
    .script('executor', [{ output: 'e', childId: 'e1' }, { output: 'e', childId: 'e2' }, { output: 'e', childId: 'e3' }])
    .script('watchdog', [{ structured: commander({ question: 'simpler route?' }) }])
  const result = await make(host, dir).bootstrap({ goal: 'x', approved_loop_count: 10 })
  assert.equal(result.phase, 'NEEDS_USER')
  assert.equal(result.data?.['last_error'], 'CORRECTION_LIMIT_REACHED')
  const steps = result.data?.['plan'] as { steps: Array<{ id: string }> }
  assert.ok(steps.steps.some((step) => step.id === 'P1-2'))
  assert.ok(steps.steps.some((step) => step.id === 'P1-3'))
  assert.ok(!steps.steps.some((step) => step.id === 'P1-4'))
  cleanup()
})

test('loop budget reservation protects later steps', async () => {
  const { dir, cleanup } = project()
  const host = new FakeHost()
  host
    .script('commander', [
      { structured: plan([{ id: 'P1', goal: 'a' }, { id: 'P2', goal: 'b' }, { id: 'P3', goal: 'c' }, { id: 'P4', goal: 'd' }]) },
      { structured: commander({ decision: 'CORRECT_CURRENT_STEP', next_step_goal: 'fix1' }) },
      { structured: commander({ decision: 'CORRECT_CURRENT_STEP', next_step_goal: 'fix2' }) },
    ])
    .script('executor', [{ output: 'e', childId: 'e1' }, { output: 'e', childId: 'e2' }])
  const result = await make(host, dir).bootstrap({ goal: 'x', approved_loop_count: 5 })
  assert.equal(result.data?.['last_error'], 'LOOP_BUDGET_RESERVED_FOR_LATER_STEPS')
  cleanup()
})

test('automatic budget lets a four-step plan absorb one correction and still finish', async () => {
  const { dir, cleanup } = project()
  const host = new FakeHost()
  host
    .script('commander', [
      { structured: plan([
        { id: 'P0', goal: 'a' },
        { id: 'P1', goal: 'b' },
        { id: 'P2', goal: 'c' },
        { id: 'P3', goal: 'd' },
      ]) },
      { structured: commander({ decision: 'CORRECT_CURRENT_STEP', next_step_goal: 'fix a' }) },
      { structured: commander({ decision: 'PASS_CURRENT_STEP' }) },
      { structured: commander({ decision: 'PASS_CURRENT_STEP' }) },
      { structured: commander({ decision: 'PASS_CURRENT_STEP' }) },
      { structured: commander({ decision: 'PASS_CURRENT_STEP' }) },
      { structured: commander({ decision: 'SUCCESS' }) },
    ])
    .script('executor', [
      { output: 'a needs correction', childId: 'e0' },
      { output: 'a fixed', childId: 'e0-2' },
      { output: 'b done', childId: 'e1' },
      { output: 'c done', childId: 'e2' },
      { output: 'd done', childId: 'e3' },
    ])
  const result = await make(host, dir).bootstrap({ goal: 'automatic four-step correction' })
  assert.equal(result.phase, 'SUCCESS')
  assert.deepEqual(result.data?.['loop'], { used: 5, max: 6 })
  cleanup()
})

test('explicit low budget is never enlarged by the accepted plan', async () => {
  const { dir, cleanup } = project()
  const host = new FakeHost()
  host
    .script('commander', [
      { structured: plan([
        { id: 'P0', goal: 'a' },
        { id: 'P1', goal: 'b' },
        { id: 'P2', goal: 'c' },
        { id: 'P3', goal: 'd' },
      ]) },
      { structured: commander({ decision: 'PASS_CURRENT_STEP' }) },
      { structured: commander({ decision: 'PASS_CURRENT_STEP' }) },
      { structured: commander({ decision: 'PASS_CURRENT_STEP' }) },
    ])
    .script('executor', [
      { output: 'a', childId: 'e0' },
      { output: 'b', childId: 'e1' },
      { output: 'c', childId: 'e2' },
    ])
  const result = await make(host, dir).bootstrap({ goal: 'explicit budget stays exact', approved_loop_count: 3 })
  assert.equal(result.phase, 'BUDGET_EXHAUSTED')
  assert.deepEqual(result.data?.['loop'], { used: 3, max: 3 })
  cleanup()
})

test('automatic budget keeps a five-step normal plan bounded with recovery reserve', async () => {
  const { dir, cleanup } = project()
  const host = new FakeHost()
  host
    .script('commander', [
      { structured: plan([
        { id: 'P0', goal: 'a' },
        { id: 'P1', goal: 'b' },
        { id: 'P2', goal: 'c' },
        { id: 'P3', goal: 'd' },
        { id: 'P4', goal: 'e' },
      ]) },
      { structured: commander({ decision: 'PASS_CURRENT_STEP' }) },
      { structured: commander({ decision: 'PASS_CURRENT_STEP' }) },
      { structured: commander({ decision: 'PASS_CURRENT_STEP' }) },
      { structured: commander({ decision: 'PASS_CURRENT_STEP' }) },
      { structured: commander({ decision: 'PASS_CURRENT_STEP' }) },
      { structured: commander({ decision: 'SUCCESS' }) },
    ])
    .script('executor', [
      { output: 'a', childId: 'e0' },
      { output: 'b', childId: 'e1' },
      { output: 'c', childId: 'e2' },
      { output: 'd', childId: 'e3' },
      { output: 'e', childId: 'e4' },
    ])
  const result = await make(host, dir).bootstrap({ goal: 'automatic five-step plan' })
  assert.equal(result.phase, 'SUCCESS')
  assert.deepEqual(result.data?.['loop'], { used: 5, max: 7 })
  cleanup()
})

test('automatic four-step plan survives one runtime watchdog recovery without spending extra loop slots', async () => {
  const { dir, cleanup } = project()
  const host = new FakeHost()
  host
    .script('commander', [
      { structured: plan([
        { id: 'P0', goal: 'a' },
        { id: 'P1', goal: 'b' },
        { id: 'P2', goal: 'c' },
        { id: 'P3', goal: 'd' },
      ]) },
      { structured: commander({ decision: 'PASS_CURRENT_STEP' }) },
      { structured: commander({ decision: 'PASS_CURRENT_STEP' }) },
      { structured: commander({ decision: 'PASS_CURRENT_STEP' }) },
      { structured: commander({ decision: 'PASS_CURRENT_STEP' }) },
      { structured: commander({ decision: 'SUCCESS' }) },
    ])
    .script('executor', [
      { output: '', interrupted: true, reason: 'controlled-timeout', childId: 'e0' },
      { output: 'a recovered', childId: 'e0' },
      { output: 'b', childId: 'e1' },
      { output: 'c', childId: 'e2' },
      { output: 'd', childId: 'e3' },
    ])
    .script('watchdog', [{ structured: commander({ decision: 'RESUME_CHILD' }) }])
  const result = await make(host, dir).bootstrap({ goal: 'automatic four-step recovery' })
  assert.equal(result.phase, 'SUCCESS')
  assert.deepEqual(result.data?.['loop'], { used: 4, max: 6 })
  assert.equal(host.scriptsFor('watchdog').length, 1)
  cleanup()
})

test('strategy REPLACE_CURRENT_STEP replaces goal', async () => {
  const { dir, cleanup } = project()
  const host = new FakeHost()
  host
    .script('commander', [
      { structured: plan([{ id: 'P1', goal: 'a' }]) },
      { structured: commander({ decision: 'CORRECT_CURRENT_STEP', next_step_goal: 'fix1' }) },
      { structured: commander({ decision: 'CORRECT_CURRENT_STEP', next_step_goal: 'fix2' }) },
      { structured: commander({ decision: 'REPLACE_CURRENT_STEP', replacement_goal: 'alt route' }) },
      { structured: commander({ decision: 'CORRECT_CURRENT_STEP', next_step_goal: 'fix3' }) },
    ])
    .script('executor', [{ output: 'e', childId: 'e1' }, { output: 'e', childId: 'e2' }, { output: 'e', childId: 'e3' }])
    .script('watchdog', [{ structured: commander({ question: 'is this tunnel vision?' }) }])
  const result = await make(host, dir).bootstrap({ goal: 'x', approved_loop_count: 10 })
  const steps = (result.data?.['plan'] as { steps: Array<{ id: string; goal: string }> }).steps
  assert.equal(steps.find((step) => step.id === 'P1-3')?.goal, 'alt route')
  cleanup()
})

test('runtime watchdog RESUME_CHILD resumes the same child', async () => {
  const { dir, cleanup } = project()
  const host = new FakeHost()
  host
    .script('commander', [
      { structured: plan([{ id: 'P1', goal: 'a' }]) },
      { structured: commander({ decision: 'PASS_CURRENT_STEP' }) },
      { structured: commander({ decision: 'SUCCESS' }) },
    ])
    .script('executor', [
      { output: '', interrupted: true, reason: 'timed-out', childId: 'exec-1' },
      { output: 'recovered', childId: 'exec-1' },
    ])
    .script('watchdog', [{ structured: commander({ decision: 'RESUME_CHILD' }) }])
  const result = await make(host, dir).bootstrap({ goal: 'x', approved_loop_count: 5 })
  const executors = host.scriptsFor('executor')
  assert.equal(executors.length, 2)
  assert.equal(executors[1]?.request.resumeOf, 'exec-1')
  assert.equal(result.data?.['loop'] && (result.data['loop'] as { used: number }).used, 1)
  cleanup()
})

test('runtime watchdog RESTART_STEP interrupts the old child first', async () => {
  const { dir, cleanup } = project()
  const host = new FakeHost()
  host
    .script('commander', [
      { structured: plan([{ id: 'P1', goal: 'a' }]) },
      { structured: commander({ decision: 'PASS_CURRENT_STEP' }) },
      { structured: commander({ decision: 'SUCCESS' }) },
    ])
    .script('executor', [
      { output: '', interrupted: true, reason: 'child anomaly', childId: 'exec-1' },
      { output: 'fresh', childId: 'exec-2' },
    ])
    .script('watchdog', [{ structured: commander({ decision: 'RESTART_STEP' }) }])
  await make(host, dir).bootstrap({ goal: 'x', approved_loop_count: 5 })
  assert.ok(host.interruptCalls.some((call) => call.childId === 'exec-1' && call.reason === 'ORBIT_RESTART_STEP'))
  const executors = host.scriptsFor('executor')
  assert.equal(executors[1]?.request.resumeOf, undefined)
  cleanup()
})

test('runtime watchdog caps at two calls per step', async () => {
  const { dir, cleanup } = project()
  const host = new FakeHost()
  host
    .script('commander', [{ structured: plan([{ id: 'P1', goal: 'a' }]) }])
    .script('executor', [
      { output: '', interrupted: true, reason: 'r1' },
      { output: '', interrupted: true, reason: 'r2' },
      { output: '', interrupted: true, reason: 'r3' },
    ])
    .script('watchdog', [{ structured: commander({ decision: 'RESUME_CHILD' }) }, { structured: commander({ decision: 'RESUME_CHILD' }) }])
  const result = await make(host, dir).bootstrap({ goal: 'x', approved_loop_count: 5 })
  assert.equal(result.phase, 'NEEDS_USER')
  assert.equal(host.scriptsFor('watchdog').length, 2)
  cleanup()
})

test('commander adaptive timeout reviews then hard ceiling cancels the same child', async () => {
  const { dir, cleanup } = project()
  const store = new OrbitStateStore(dir)
  const host = new FakeHost()
  host
    .script('commander', [
      { structured: plan([{ id: 'P1', goal: 'a' }]) },
      { pending: true, childId: 'cmd-1' },
      { structured: commander({ decision: 'PASS_CURRENT_STEP' }) },
      { structured: commander({ decision: 'SUCCESS' }) },
    ])
    .script('executor', [{ output: 'done', childId: 'e1' }])
    .script('watchdog', [
      { structured: commander({ decision: 'EXTEND' }) },
      { structured: commander({ decision: 'EXTEND' }) },
    ])
  const supervisor = new OrbitSupervisor(store, host, config)
  const first = await supervisor.bootstrap({ goal: 'x', approved_loop_count: 5 })
  assert.equal(first.ok, false)
  assert.equal(first.phase, 'EVALUATE')
  assert.deepEqual(host.sleepCalls.slice(0, 3), [360000, 240000, 240000])
  const commanderId = host.scriptsFor('commander')[0]?.childId
  assert.ok(commanderId)
  assert.ok(host.cancelled.some((call) => call.reason === 'COMMANDER_HARD_TIMEOUT' && call.childId === commanderId))
  // timeout telemetry is bound to the persistent Commander child, not the Executor
  assert.equal(host.snapshots[0]?.childId, commanderId)

  const resumed = await supervisor.run(store.readState()!)
  assert.equal(resumed.phase, 'SUCCESS')
  cleanup()
})

test('commander timeout watchdog unavailable: EXTEND then INTERRUPT', async () => {
  const { dir, cleanup } = project()
  const store = new OrbitStateStore(dir)
  const host = new FakeHost()
  host
    .script('commander', [
      { structured: plan([{ id: 'P1', goal: 'a' }]) },
      { pending: true, childId: 'cmd-1' },
      { structured: commander({ decision: 'PASS_CURRENT_STEP' }) },
      { structured: commander({ decision: 'SUCCESS' }) },
    ])
    .script('executor', [{ output: 'done', childId: 'e1' }])
  const supervisor = new OrbitSupervisor(store, host, config)
  const first = await supervisor.bootstrap({ goal: 'x', approved_loop_count: 5 })
  assert.equal(first.ok, false)
  assert.deepEqual(host.sleepCalls.slice(0, 2), [360000, 240000])
  assert.equal(host.scriptsFor('watchdog').length, 0)
  const commanderId = host.scriptsFor('commander')[0]?.childId
  assert.ok(host.cancelled.some((call) => call.reason === 'COMMANDER_TIMEOUT_INTERRUPTED' && call.childId === commanderId))

  const resumed = await supervisor.run(store.readState()!)
  assert.equal(resumed.phase, 'SUCCESS')
  cleanup()
})

test('parent abort short-circuits', async () => {
  const { dir, cleanup } = project()
  const host = new FakeHost()
  const controller = new AbortController()
  controller.abort()
  const result = await make(host, dir).bootstrap({ goal: 'x', approved_loop_count: 5 }, controller.signal)
  assert.equal(result.ok, false)
  assert.equal(result.message, 'ORBIT_ABORTED')
  cleanup()
})

test('recoverable guard escalation: block_continue -> watchdog -> needs_user', async () => {
  const { dir, cleanup } = project()
  const host = new FakeHost()
  host.script('watchdog', [
    { structured: commander({ decision: 'RETRY_DIFFERENTLY', instruction: 'try another way' }) },
    { structured: commander({ decision: 'NEEDS_USER' }) },
  ])
  const supervisor = make(host, dir)
  const state = supervisor.createState({ goal: 'x', approved_loop_count: 5 })
  state.phase = 'EXECUTE'
  state.status = 'running'
  state.plan = { summary: 'p', steps: [{ id: 'P1', goal: 'a', status: 'running' }] }
  state.current_step = { id: 'P1', attempt: 1 }
  new OrbitStateStore(dir).writeState(state)

  const first = await supervisor.recordGuardBlock('secret_operation', 'printenv')
  assert.equal(first.disposition, 'block_continue')
  assert.equal(first.watchdog_calls, 0)
  assert.equal(new OrbitStateStore(dir).readState()?.phase, 'EXECUTE')

  const second = await supervisor.recordGuardBlock('secret_operation', 'printenv')
  assert.equal(second.count, 2)
  assert.equal(second.watchdog_calls, 0)

  const third = await supervisor.recordGuardBlock('secret_operation', 'printenv')
  assert.equal(third.disposition, 'block_continue')
  assert.equal(third.watchdog_calls, 1)

  const fourth = await supervisor.recordGuardBlock('secret_operation', 'printenv')
  assert.equal(fourth.disposition, 'block_needs_user')

  const fifth = await supervisor.recordGuardBlock('secret_operation', 'printenv')
  assert.equal(fifth.disposition, 'block_needs_user')
  assert.equal(host.scriptsFor('watchdog').length, 2)
  cleanup()
})

test('browser capability scopes the executor tool filter', async () => {
  const { dir, cleanup } = project()
  const host = new FakeHost()
  host
    .script('commander', [
      { structured: plan([{ id: 'P1', goal: 'code' }, { id: 'P2', goal: 'verify page', capabilities: ['browser'] }]) },
      { structured: commander({ decision: 'PASS_CURRENT_STEP' }) },
      { structured: commander({ decision: 'PASS_CURRENT_STEP' }) },
      { structured: commander({ decision: 'SUCCESS' }) },
    ])
    .script('executor', [{ output: 'a', childId: 'e1' }, { output: 'b', childId: 'e2' }])
  await make(host, dir).bootstrap({ goal: 'x', approved_loop_count: 5 })
  const executors = host.scriptsFor('executor')
  assert.ok(executors[0]?.toolFilter?.allow?.includes('read'))
  assert.ok(!(executors[0]?.toolFilter?.allow ?? []).includes('agent_browser'))
  assert.ok(executors[1]?.toolFilter?.allow?.includes('agent_browser'))
  assert.ok(executors[1]?.request.capabilities?.includes('browser'))
  const commanders = host.scriptsFor('commander')
  assert.ok(!(commanders[1]?.request.toolFilter?.allow ?? []).includes('agent_browser'))
  cleanup()
})

test('browser capability unavailable routes to Commander without executing', async () => {
  const { dir, cleanup } = project()
  const host = new FakeHost()
  host.tools.delete('agent_browser')
  host
    .script('commander', [
      { structured: plan([{ id: 'P1', goal: 'verify page', capabilities: ['browser'] }]) },
      { structured: commander({ decision: 'NEEDS_USER' }) },
    ])
  const result = await make(host, dir).bootstrap({ goal: 'x', approved_loop_count: 5 })
  assert.equal(result.phase, 'NEEDS_USER')
  assert.equal(host.scriptsFor('executor').length, 0)
  cleanup()
})

test('ordinary Executor scope is read-only without capabilities', async () => {
  const { dir, cleanup } = project()
  const host = new FakeHost()
  host
    .script('commander', [
      { structured: plan([{ id: 'P1', goal: 'code' }]) },
      { structured: commander({ decision: 'PASS_CURRENT_STEP' }) },
      { structured: commander({ decision: 'SUCCESS' }) },
    ])
    .script('executor', [{ output: 'a', childId: 'e1' }])
  await make(host, dir).bootstrap({ goal: 'x', approved_loop_count: 5 })
  const allow = host.scriptsFor('executor')[0]?.toolFilter?.allow ?? []
  assert.ok(allow.includes('read'))
  assert.ok(!allow.includes('bash'))
  assert.ok(!allow.includes('write'))
  assert.ok(!allow.includes('agent_browser'))
  assert.ok(!allow.includes('create_goal'))
  assert.ok(!allow.includes('ralph'))
  assert.ok(!allow.includes('workflow'))
  assert.ok(!allow.includes('subagent'))
  cleanup()
})

test('PLAN also runs under the adaptive Commander timeout', async () => {
  const { dir, cleanup } = project()
  const store = new OrbitStateStore(dir)
  const host = new FakeHost()
  host
    .script('commander', [{ pending: true, childId: 'cmd-plan' }])
    .script('watchdog', [
      { structured: commander({ decision: 'EXTEND' }) },
      { structured: commander({ decision: 'EXTEND' }) },
    ])
  const supervisor = new OrbitSupervisor(store, host, config)
  const first = await supervisor.bootstrap({ goal: 'x', approved_loop_count: 5 })
  assert.equal(first.ok, false)
  assert.equal(first.phase, 'PLAN')
  assert.deepEqual(host.sleepCalls, [360000, 240000, 240000])
  assert.ok(host.cancelled.some((call) => call.reason === 'COMMANDER_HARD_TIMEOUT' && call.childId === 'cmd-plan'))
  cleanup()
})

test('FINAL_EVALUATE also runs under the adaptive Commander timeout', async () => {
  const { dir, cleanup } = project()
  const store = new OrbitStateStore(dir)
  const host = new FakeHost()
  host
    .script('commander', [
      { structured: plan([{ id: 'P1', goal: 'a' }]) },
      { structured: commander({ decision: 'PASS_CURRENT_STEP' }) },
      { pending: true, childId: 'cmd-final' },
    ])
    .script('executor', [{ output: 'done', childId: 'e1' }])
    .script('watchdog', [
      { structured: commander({ decision: 'EXTEND' }) },
      { structured: commander({ decision: 'EXTEND' }) },
    ])
  const supervisor = new OrbitSupervisor(store, host, config)
  const first = await supervisor.bootstrap({ goal: 'x', approved_loop_count: 5 })
  assert.equal(first.ok, false)
  const commanderId = host.scriptsFor('commander')[0]?.childId
  assert.ok(host.cancelled.some((call) => call.reason === 'COMMANDER_HARD_TIMEOUT' && call.childId === commanderId))
  const finalStart = host.scriptsFor('commander').find((entry) => entry.request.commanderMode === 'FINAL_EVALUATE')
  assert.ok(finalStart)
  assert.equal(finalStart.childId, commanderId)
  assert.equal(host.snapshots.at(-1)?.childId, commanderId)
  cleanup()
})

test('STRATEGY_RECONSIDER runs under the adaptive Commander timeout and stays resumable', async () => {
  const { dir, cleanup } = project()
  const store = new OrbitStateStore(dir)
  const host = new FakeHost()
  host
    .script('commander', [
      { structured: plan([{ id: 'P1', goal: 'a' }]) },
      { structured: commander({ decision: 'CORRECT_CURRENT_STEP', next_step_goal: 'fix1' }) },
      { structured: commander({ decision: 'CORRECT_CURRENT_STEP', next_step_goal: 'fix2' }) },
      { pending: true, childId: 'cmd-strategy' },
    ])
    .script('executor', [{ output: 'e', childId: 'e1' }, { output: 'e', childId: 'e2' }])
    .script('watchdog', [
      { structured: commander({ question: 'simpler route?' }) },
      { structured: commander({ decision: 'EXTEND' }) },
      { structured: commander({ decision: 'EXTEND' }) },
    ])
  const supervisor = new OrbitSupervisor(store, host, config)
  const first = await supervisor.bootstrap({ goal: 'x', approved_loop_count: 10 })
  assert.equal(first.ok, false)
  const commanderId = host.scriptsFor('commander')[0]?.childId
  assert.ok(host.cancelled.some((call) => call.reason === 'COMMANDER_HARD_TIMEOUT' && call.childId === commanderId))
  // Temporary failure must NOT consume the strategy challenge.
  assert.equal(store.readState()?.strategy_challenge, undefined)
  assert.equal(store.readState()?.phase, 'EVALUATE')
  cleanup()
})

test('Commander receives the settled step evidence bundle', async () => {
  const { dir, cleanup } = project()
  const host = new FakeHost()
  host
    .script('commander', [
      { structured: plan([{ id: 'P1', goal: 'a' }]) },
      { structured: commander({ decision: 'PASS_CURRENT_STEP' }) },
      { structured: commander({ decision: 'SUCCESS' }) },
    ])
    .script('executor', [
      {
        output: 'did a',
        childId: 'e1',
        settlement: 'completed',
        toolEvidence: [
          { name: 'edit', status: 'ok', detail: 'src/a.ts' },
          { name: 'bash', status: 'ok', command: 'npm test', detail: 'npm test' },
        ],
      },
    ])
  await make(host, dir).bootstrap({ goal: 'x', approved_loop_count: 5 })
  const stepPrompt =
    host.scriptsFor('commander').find((entry) => entry.request.commanderMode === 'STEP_EVALUATE')?.request.prompt ?? ''
  assert.match(stepPrompt, /"settlement":"completed"/)
  assert.match(stepPrompt, /"command":"npm test"/)
  assert.match(stepPrompt, /执行员证据/)
  assert.match(stepPrompt, /你是 Orbit 指挥官/)
  cleanup()
})

test('a completed Commander without a structured capture fails loud', async () => {
  const { dir, cleanup } = project()
  const store = new OrbitStateStore(dir)
  const host = new FakeHost()
  // A text-only completion is not a substitute for the requested capture.
  host.script('commander', [{ output: '{"summary":"plan","steps":[]}' }])
  const supervisor = new OrbitSupervisor(store, host, config)
  const result = await supervisor.bootstrap({ goal: 'x', approved_loop_count: 5 })
  assert.equal(result.ok, false)
  assert.match(String(store.readState()?.last_error), /PLAN_STRUCTURED_OUTPUT_MISSING/)
  cleanup()
})

test('temporary strategy watchdog failure does not consume the challenge', async () => {
  const { dir, cleanup } = project()
  const store = new OrbitStateStore(dir)
  const host = new FakeHost()
  host
    .script('commander', [
      { structured: plan([{ id: 'P1', goal: 'a' }]) },
      { structured: commander({ decision: 'CORRECT_CURRENT_STEP', next_step_goal: 'fix1' }) },
      { structured: commander({ decision: 'CORRECT_CURRENT_STEP', next_step_goal: 'fix2' }) },
    ])
    .script('executor', [{ output: 'e', childId: 'e1' }, { output: 'e', childId: 'e2' }])
  // No watchdog script: the strategy challenge is temporarily unavailable.
  const supervisor = new OrbitSupervisor(store, host, config)
  const first = await supervisor.bootstrap({ goal: 'x', approved_loop_count: 10 })
  assert.equal(first.ok, false)
  assert.equal(store.readState()?.strategy_challenge, undefined)
  assert.equal(store.readState()?.phase, 'EVALUATE')
  assert.ok(!(host.scriptsFor('executor').some((entry) => entry.label === 'executor-P1-3')))
  cleanup()
})

test('insufficient stop evidence cannot settle as FINAL SUCCESS', async () => {
  const { dir, cleanup } = project()
  const host = new FakeHost()
  host
    .script('commander', [
      { structured: plan([{ id: 'P1', goal: 'stop the service' }]) },
      { structured: commander({ decision: 'PASS_CURRENT_STEP' }) },
      { structured: commander({ decision: 'NEEDS_USER', reason: 'only an external HTTP 502 was observed' }) },
    ])
    .script('executor', [
      { output: 'curl returned HTTP 502; no process, port, or systemd evidence collected', childId: 'e1', settlement: 'completed' },
    ])
  const result = await make(host, dir).bootstrap({ goal: 'stop the service', approved_loop_count: 5 })
  assert.equal(result.phase, 'NEEDS_USER')
  assert.notEqual(result.phase, 'SUCCESS')

  // The Commander's final review receives the weak evidence verbatim, so the
  // verdict can refuse SUCCESS instead of trusting the Executor's claim.
  const finalPrompt =
    host.scriptsFor('commander').find((entry) => entry.request.commanderMode === 'FINAL_EVALUATE')?.request.prompt ?? ''
  assert.match(finalPrompt, /HTTP 502/)
  assert.match(finalPrompt, /执行员证据/)
  assert.match(finalPrompt, /你是 Orbit 指挥官/)
  cleanup()
})

test('a same-goal reply resumes the NEEDS_USER run instead of starting a new one', async () => {
  const { dir, cleanup } = project()
  const store = new OrbitStateStore(dir)
  const host = new FakeHost()
  host
    .script('commander', [
      { structured: plan([{ id: 'P1', goal: 'a' }]) },
      { structured: commander({ decision: 'NEEDS_USER' }) },
      { structured: commander({ decision: 'PASS_CURRENT_STEP' }) },
      { structured: commander({ decision: 'SUCCESS' }) },
      { structured: commander({ decision: 'SUCCESS' }) },
    ])
    .script('executor', [
      { output: 'did a', childId: 'e1' },
      { output: 'did a after the user reply', childId: 'e2' },
      { output: 'did a again', childId: 'e3' },
    ])
  const supervisor = new OrbitSupervisor(store, host, { ...config, resolveOwnerSessionId: () => 'session-a' })

  const first = await supervisor.bootstrap({ goal: 'x', approved_loop_count: 5 })
  assert.equal(first.phase, 'NEEDS_USER')
  assert.equal(store.readState()?.owner_session_id, 'session-a', 'a new run records its owning Session')
  const paused = store.readState()
  assert.ok(paused)

  const resumed = await supervisor.bootstrap({ goal: 'x', approved_loop_count: 5 })
  const after = store.readState()
  assert.equal(resumed.phase, 'SUCCESS')
  assert.equal(after?.run_id, paused.run_id, 'the same durable run must continue, never a second run')
  assert.equal(after?.goal, 'x')
  cleanup()
})

test('an arbitrary user reply resumes the NEEDS_USER run and stays durable', async () => {
  const { dir, cleanup } = project()
  const store = new OrbitStateStore(dir)
  const host = new FakeHost()
  host
    .script('commander', [
      { structured: plan([{ id: 'P1', goal: 'collect the port' }]) },
      { structured: commander({ decision: 'NEEDS_USER', reason: 'which port?' }) },
      { structured: commander({ decision: 'PASS_CURRENT_STEP' }) },
      { structured: commander({ decision: 'SUCCESS' }) },
    ])
    .script('executor', [
      { output: 'need the port', childId: 'e1' },
      { output: 'deployed on 8080', childId: 'e2' },
    ])
  const supervisor = new OrbitSupervisor(store, host, { ...config, resolveOwnerSessionId: () => 'session-a' })

  const first = await supervisor.bootstrap({ goal: 'deploy service', approved_loop_count: 5 })
  assert.equal(first.phase, 'NEEDS_USER')
  const paused = store.readState()
  assert.ok(paused)

  // The reply text is nothing like the original goal: it must still continue
  // the same run instead of starting a new one or failing the goal check.
  const resumed = await supervisor.bootstrap({ goal: '8080', approved_loop_count: 5 })
  const after = store.readState()
  assert.equal(resumed.phase, 'SUCCESS')
  assert.equal(after?.run_id, paused.run_id, 'the same durable run must continue')
  assert.equal(after?.goal, 'deploy service', 'the original goal is never rewritten')
  assert.equal(after?.pending_user_reply, '8080', 'the reply stays durable')
  assert.deepEqual(after?.routes, paused.routes, 'the frozen routes must be reused')

  // The roles consumed the reply.
  const executorPrompt = host.scriptsFor('executor')[1]?.request.prompt ?? ''
  assert.match(executorPrompt, /8080/)
  const stepPrompt = host
    .scriptsFor('commander')
    .find((entry) => entry.request.commanderMode === 'STEP_EVALUATE' && entry.request.prompt.includes('8080'))?.request.prompt
  assert.ok(stepPrompt, 'the Commander step evaluation must read the reply')
  cleanup()
})

test('a different Session never resumes a NEEDS_USER run', async () => {
  const { dir, cleanup } = project()
  const store = new OrbitStateStore(dir)
  const host = new FakeHost()
  host
    .script('commander', [
      { structured: plan([{ id: 'P1', goal: 'collect the port' }]) },
      { structured: commander({ decision: 'NEEDS_USER', reason: 'which port?' }) },
      { structured: commander({ decision: 'PASS_CURRENT_STEP' }) },
      { structured: commander({ decision: 'SUCCESS' }) },
    ])
    .script('executor', [
      { output: 'need the port', childId: 'e1' },
      { output: 'deployed on 8080', childId: 'e2' },
    ])
  let session = 'session-a'
  const supervisor = new OrbitSupervisor(store, host, { ...config, resolveOwnerSessionId: () => session })

  const first = await supervisor.bootstrap({ goal: 'deploy service', approved_loop_count: 5 })
  assert.equal(first.phase, 'NEEDS_USER')
  const paused = store.readState()
  assert.ok(paused)
  assert.equal(paused.owner_session_id, 'session-a')
  const executorCalls = host.scriptsFor('executor').length

  // Session B's brand-new task must not be consumed as Session A's reply.
  session = 'session-b'
  const blocked = await supervisor.bootstrap({ goal: 'check another project', approved_loop_count: 5 })
  assert.equal(blocked.ok, false)
  assert.match(String(blocked.message), /ORBIT_NEEDS_USER_OTHER_SESSION/)
  const after = store.readState()
  assert.equal(after?.run_id, paused.run_id, 'the old run id must not change')
  assert.equal(after?.goal, 'deploy service', 'the old goal must not change')
  assert.equal(after?.phase, 'NEEDS_USER')
  assert.equal(after?.pending_user_reply ?? null, null, 'a foreign message never enters pending_user_reply')
  assert.equal(host.scriptsFor('executor').length, executorCalls, 'no Executor may start for a foreign Session')

  // The owning Session still resumes normally.
  session = 'session-a'
  const resumed = await supervisor.bootstrap({ goal: '8080', approved_loop_count: 5 })
  const done = store.readState()
  assert.equal(resumed.phase, 'SUCCESS')
  assert.equal(done?.run_id, paused.run_id)
  assert.equal(done?.pending_user_reply, '8080')
  cleanup()
})

test('an ownerless NEEDS_USER Run explicitly rejects automatic reply without adopting the Session', async () => {
  const { dir, cleanup } = project()
  const store = new OrbitStateStore(dir)
  const host = new FakeHost()
  const supervisor = make(host, dir)
  const state = supervisor.createState({ goal: 'old goal' })
  state.phase = 'NEEDS_USER'
  state.status = 'needs_user'
  store.writeState(state)
  const before = store.readRawState()
  const caller = new OrbitSupervisor(store, host, { ...config, resolveOwnerSessionId: () => 'new-session' })
  const result = await caller.bootstrap({ goal: 'new reply' })
  assert.equal(result.ok, false)
  assert.match(result.message ?? '', /ORBIT_NEEDS_USER_OWNER_UNKNOWN/)
  assert.deepEqual(store.readRawState(), before)
  assert.equal(host.started.length, 0)
  cleanup()
})

test('FINAL_EVALUATE sees every durable step result after rebuilding the Supervisor', async () => {
  const { dir, cleanup } = project()
  const store = new OrbitStateStore(dir)
  const host = new FakeHost()
  host.script('commander', [
    { structured: plan([{ id: 'P0', goal: 'first' }, { id: 'P1', goal: 'second' }, { id: 'P2', goal: 'third' }]) },
    { structured: commander({ decision: 'PASS_CURRENT_STEP' }) },
    { interrupted: true, reason: 'review interrupted' },
  ]).script('executor', [
    { output: 'P0 result', changedFiles: ['first.ts'], testSummary: ['first tests pass'] },
    { output: 'P1 result', changedFiles: ['second.ts'], testSummary: ['second tests pass'] },
  ])
  assert.equal((await make(host, dir).bootstrap({ goal: 'three steps', approved_loop_count: 5 })).phase, 'EVALUATE')
  const persisted = store.readState()!
  assert.equal(persisted.step_results?.length, 2)
  host.script('commander', [
    { structured: commander({ decision: 'PASS_CURRENT_STEP' }) },
    { structured: commander({ decision: 'PASS_CURRENT_STEP' }) },
    { structured: commander({ decision: 'SUCCESS' }) },
  ]).script('executor', [{ output: 'P2 result', changedFiles: ['third.ts'], testSummary: ['third tests pass'] }])
  assert.equal((await new OrbitSupervisor(store, host, config).run(persisted)).phase, 'SUCCESS')
  const final = host.scriptsFor('commander').find((entry) => entry.request.commanderMode === 'FINAL_EVALUATE')!.request.prompt
  for (const value of ['P0 result', 'P1 result', 'P2 result', 'first.ts', 'second.ts', 'third.ts', 'first tests pass', 'second tests pass', 'third tests pass']) {
    assert.ok(final.includes(value), `FINAL must retain ${value}`)
  }
  const coldReview = host.scriptsFor('commander').filter((entry) => entry.request.commanderMode === 'STEP_EVALUATE')[2]!.request.prompt
  assert.ok(coldReview.includes('P1 result'))
  assert.equal(host.scriptsFor('watchdog').length, 0)
  cleanup()
})

test('v0.6.2 persistent roles reuse one Commander and one Executor when grants stay stable', async () => {
  const { dir, cleanup } = project()
  const host = new FakeHost()
  host
    .script('commander', [
      { structured: plan([{ id: 'P0', goal: 'a' }, { id: 'P1', goal: 'b' }, { id: 'P2', goal: 'c' }]) },
      { structured: commander({ decision: 'PASS_CURRENT_STEP' }) },
      { structured: commander({ decision: 'PASS_CURRENT_STEP' }) },
      { structured: commander({ decision: 'PASS_CURRENT_STEP' }) },
      { structured: commander({ decision: 'SUCCESS', summary: 'done' }) },
    ])
    .script('executor', [
      { output: 'a' },
      { output: 'b' },
      { output: 'c' },
    ])

  const result = await make(host, dir).bootstrap({ goal: 'persistent proof', approved_loop_count: 5 })
  assert.equal(result.phase, 'SUCCESS')

  const commanders = host.scriptsFor('commander')
  const executors = host.scriptsFor('executor')
  assert.equal(new Set(commanders.map((entry) => entry.childId)).size, 1, 'one Commander Session must survive PLAN/reviews/FINAL')
  assert.equal(new Set(executors.map((entry) => entry.childId)).size, 1, 'one Executor Session must survive same-grant steps')
  assert.ok(commanders.slice(1).every((entry) => entry.request.resumeOf === commanders[0]?.childId))
  assert.ok(executors.slice(1).every((entry) => entry.request.resumeOf === executors[0]?.childId))

  const state = new OrbitStateStore(dir).readState()
  assert.equal(state?.role_sessions?.commander?.turns, 5)
  assert.equal(state?.role_sessions?.commander?.generation, 1)
  assert.equal(state?.role_sessions?.executor?.turns, 3)
  assert.equal(state?.role_sessions?.executor?.generation, 1)
  cleanup()
})

test('v0.6.2 rotates Executor only when the tool grant changes', async () => {
  const { dir, cleanup } = project()
  const host = new FakeHost()
  host
    .script('commander', [
      { structured: plan([
        { id: 'P0', goal: 'read' },
        { id: 'P1', goal: 'edit', capabilities: ['filesystem', 'shell'] },
      ]) },
      { structured: commander({ decision: 'PASS_CURRENT_STEP' }) },
      { structured: commander({ decision: 'PASS_CURRENT_STEP' }) },
      { structured: commander({ decision: 'SUCCESS' }) },
    ])
    .script('executor', [{ output: 'read' }, { output: 'edited' }])

  assert.equal((await make(host, dir).bootstrap({ goal: 'grant rotation', approved_loop_count: 4 })).phase, 'SUCCESS')
  const executors = host.scriptsFor('executor')
  assert.equal(executors.length, 2)
  assert.notEqual(executors[0]?.childId, executors[1]?.childId)
  assert.equal(executors[1]?.request.resumeOf, undefined)

  const state = new OrbitStateStore(dir).readState()
  assert.equal(state?.role_sessions?.executor?.generation, 2)
  assert.equal(state?.role_sessions?.executor?.resets, 1)
  assert.equal(state?.role_sessions?.executor?.last_reset_reason, 'EXECUTOR_TOOL_GRANT_CHANGED')
  cleanup()
})

test('Commander RESET request deterministically rotates the persistent Executor', async () => {
  const { dir, cleanup } = project()
  const host = new FakeHost()
  host
    .script('commander', [
      { structured: plan([{ id: 'P0', goal: 'a' }, { id: 'P1', goal: 'b' }]) },
      { structured: commander({ decision: 'PASS_CURRENT_STEP', executor_session: 'RESET' }) },
      { structured: commander({ decision: 'PASS_CURRENT_STEP' }) },
      { structured: commander({ decision: 'SUCCESS' }) },
    ])
    .script('executor', [{ output: 'a' }, { output: 'b' }])

  assert.equal((await make(host, dir).bootstrap({ goal: 'commander reset', approved_loop_count: 4 })).phase, 'SUCCESS')
  const executors = host.scriptsFor('executor')
  assert.equal(executors.length, 2)
  assert.notEqual(executors[0]?.childId, executors[1]?.childId)
  const state = new OrbitStateStore(dir).readState()
  assert.equal(state?.role_sessions?.executor?.resets, 1)
  assert.equal(state?.role_sessions?.executor?.last_reset_reason, 'COMMANDER_REQUEST')
  cleanup()
})
