import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CxStateStore } from '../src/state-store.ts'
import { CxSupervisor, type CxSupervisorConfig } from '../src/supervisor.ts'
import { FakeHost } from './helpers/fake-host.ts'

const config: CxSupervisorConfig = {
  defaultRoutes: {
    commander: { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'high' },
    executor: { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'high' },
    watchdog: { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'low' },
  },
  browserTools: ['agent_browser'],
  commanderReadOnlyTools: ['read', 'read_image', 'glob', 'grep', 'web_search', 'web_fetch'],
  watchdogTools: ['read', 'read_image', 'glob', 'grep'],
}

function project(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cx-test-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

function make(host: FakeHost, dir: string): CxSupervisor {
  return new CxSupervisor(new CxStateStore(dir), host, config)
}

const plan = (steps: Array<{ id: string; goal: string; capabilities?: string[] }>, summary = 'plan') =>
  JSON.stringify({ summary, steps })

const commander = (decision: Record<string, unknown>) => JSON.stringify(decision)

test('PLAN -> EXECUTE -> EVALUATE -> SUCCESS', async () => {
  const { dir, cleanup } = project()
  const host = new FakeHost()
  host
    .script('commander', [
      { output: plan([{ id: 'P1', goal: 'do a' }]) },
      { output: commander({ decision: 'PASS_CURRENT_STEP' }) },
      { output: commander({ decision: 'SUCCESS' }) },
    ])
    .script('executor', [{ output: 'did a', childId: 'e1' }])
  const result = await make(host, dir).bootstrap({ goal: 'ship feature', approved_loop_count: 5 })
  assert.equal(result.ok, true)
  assert.equal(result.phase, 'SUCCESS')
  assert.equal(result.data?.['loop'] && (result.data['loop'] as { used: number }).used, 1)
  cleanup()
})

test('STEP_EVALUATE rejects SUCCESS', async () => {
  const { dir, cleanup } = project()
  const host = new FakeHost()
  host
    .script('commander', [{ output: plan([{ id: 'P1', goal: 'a' }]) }, { output: commander({ decision: 'SUCCESS' }) }])
    .script('executor', [{ output: 'done', childId: 'e1' }])
  const result = await make(host, dir).bootstrap({ goal: 'x', approved_loop_count: 5 })
  assert.equal(result.phase, 'NEEDS_USER')
  assert.match(String(result.data?.['last_error']), /COMMANDER_EVALUATION_DECISION_INVALID_FOR_MODE/)
  cleanup()
})

test('FINAL_EVALUATE rejects PASS_CURRENT_STEP', async () => {
  const { dir, cleanup } = project()
  const host = new FakeHost()
  host
    .script('commander', [
      { output: plan([{ id: 'P1', goal: 'a' }]) },
      { output: commander({ decision: 'PASS_CURRENT_STEP' }) },
      { output: commander({ decision: 'PASS_CURRENT_STEP' }) },
    ])
    .script('executor', [{ output: 'done', childId: 'e1' }])
  const result = await make(host, dir).bootstrap({ goal: 'x', approved_loop_count: 5 })
  assert.equal(result.phase, 'NEEDS_USER')
  cleanup()
})

test('bounded corrections reach CORRECTION_LIMIT_REACHED', async () => {
  const { dir, cleanup } = project()
  const host = new FakeHost()
  host
    .script('commander', [
      { output: plan([{ id: 'P1', goal: 'a' }]) },
      { output: commander({ decision: 'CORRECT_CURRENT_STEP', next_step_goal: 'fix1' }) },
      { output: commander({ decision: 'CORRECT_CURRENT_STEP', next_step_goal: 'fix2' }) },
      { output: commander({ decision: 'KEEP_APPROACH' }) },
      { output: commander({ decision: 'CORRECT_CURRENT_STEP', next_step_goal: 'fix3' }) },
    ])
    .script('executor', [{ output: 'e', childId: 'e1' }, { output: 'e', childId: 'e2' }, { output: 'e', childId: 'e3' }])
    .script('watchdog', [{ output: commander({ question: 'simpler route?' }) }])
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
      { output: plan([{ id: 'P1', goal: 'a' }, { id: 'P2', goal: 'b' }, { id: 'P3', goal: 'c' }, { id: 'P4', goal: 'd' }]) },
      { output: commander({ decision: 'CORRECT_CURRENT_STEP', next_step_goal: 'fix1' }) },
      { output: commander({ decision: 'CORRECT_CURRENT_STEP', next_step_goal: 'fix2' }) },
    ])
    .script('executor', [{ output: 'e', childId: 'e1' }, { output: 'e', childId: 'e2' }])
  const result = await make(host, dir).bootstrap({ goal: 'x', approved_loop_count: 5 })
  assert.equal(result.data?.['last_error'], 'LOOP_BUDGET_RESERVED_FOR_LATER_STEPS')
  cleanup()
})

test('strategy REPLACE_CURRENT_STEP replaces goal', async () => {
  const { dir, cleanup } = project()
  const host = new FakeHost()
  host
    .script('commander', [
      { output: plan([{ id: 'P1', goal: 'a' }]) },
      { output: commander({ decision: 'CORRECT_CURRENT_STEP', next_step_goal: 'fix1' }) },
      { output: commander({ decision: 'CORRECT_CURRENT_STEP', next_step_goal: 'fix2' }) },
      { output: commander({ decision: 'REPLACE_CURRENT_STEP', replacement_goal: 'alt route' }) },
      { output: commander({ decision: 'CORRECT_CURRENT_STEP', next_step_goal: 'fix3' }) },
    ])
    .script('executor', [{ output: 'e', childId: 'e1' }, { output: 'e', childId: 'e2' }, { output: 'e', childId: 'e3' }])
    .script('watchdog', [{ output: commander({ question: 'is this tunnel vision?' }) }])
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
      { output: plan([{ id: 'P1', goal: 'a' }]) },
      { output: commander({ decision: 'PASS_CURRENT_STEP' }) },
      { output: commander({ decision: 'SUCCESS' }) },
    ])
    .script('executor', [
      { output: '', interrupted: true, reason: 'timed-out', childId: 'exec-1' },
      { output: 'recovered', childId: 'exec-1' },
    ])
    .script('watchdog', [{ output: commander({ decision: 'RESUME_CHILD' }) }])
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
      { output: plan([{ id: 'P1', goal: 'a' }]) },
      { output: commander({ decision: 'PASS_CURRENT_STEP' }) },
      { output: commander({ decision: 'SUCCESS' }) },
    ])
    .script('executor', [
      { output: '', interrupted: true, reason: 'child anomaly', childId: 'exec-1' },
      { output: 'fresh', childId: 'exec-2' },
    ])
    .script('watchdog', [{ output: commander({ decision: 'RESTART_STEP' }) }])
  await make(host, dir).bootstrap({ goal: 'x', approved_loop_count: 5 })
  assert.ok(host.interruptCalls.some((call) => call.childId === 'exec-1' && call.reason === 'CX_RESTART_STEP'))
  const executors = host.scriptsFor('executor')
  assert.equal(executors[1]?.request.resumeOf, undefined)
  cleanup()
})

test('runtime watchdog caps at two calls per step', async () => {
  const { dir, cleanup } = project()
  const host = new FakeHost()
  host
    .script('commander', [{ output: plan([{ id: 'P1', goal: 'a' }]) }])
    .script('executor', [
      { output: '', interrupted: true, reason: 'r1' },
      { output: '', interrupted: true, reason: 'r2' },
      { output: '', interrupted: true, reason: 'r3' },
    ])
    .script('watchdog', [{ output: commander({ decision: 'RESUME_CHILD' }) }, { output: commander({ decision: 'RESUME_CHILD' }) }])
  const result = await make(host, dir).bootstrap({ goal: 'x', approved_loop_count: 5 })
  assert.equal(result.phase, 'NEEDS_USER')
  assert.equal(host.scriptsFor('watchdog').length, 2)
  cleanup()
})

test('commander adaptive timeout reviews then hard ceiling interrupts same child', async () => {
  const { dir, cleanup } = project()
  const host = new FakeHost()
  host
    .script('commander', [
      { output: plan([{ id: 'P1', goal: 'a' }]) },
      { pending: true, childId: 'cmd-1' },
      { output: commander({ decision: 'PASS_CURRENT_STEP' }) },
      { output: commander({ decision: 'SUCCESS' }) },
    ])
    .script('executor', [{ output: 'done', childId: 'e1' }])
    .script('watchdog', [
      { output: commander({ decision: 'EXTEND' }) },
      { output: commander({ decision: 'EXTEND' }) },
    ])
  const result = await make(host, dir).bootstrap({ goal: 'x', approved_loop_count: 5 })
  assert.deepEqual(host.sleepCalls.slice(0, 3), [360000, 240000, 240000])
  assert.ok(host.interruptCalls.some((call) => call.reason === 'COMMANDER_HARD_TIMEOUT' && call.childId === 'cmd-1'))
  assert.equal(result.phase, 'SUCCESS')
  cleanup()
})

test('commander timeout watchdog unavailable: EXTEND then INTERRUPT', async () => {
  const { dir, cleanup } = project()
  const host = new FakeHost()
  host
    .script('commander', [
      { output: plan([{ id: 'P1', goal: 'a' }]) },
      { pending: true, childId: 'cmd-1' },
      { output: commander({ decision: 'PASS_CURRENT_STEP' }) },
      { output: commander({ decision: 'SUCCESS' }) },
    ])
    .script('executor', [{ output: 'done', childId: 'e1' }])
  const result = await make(host, dir).bootstrap({ goal: 'x', approved_loop_count: 5 })
  assert.deepEqual(host.sleepCalls.slice(0, 2), [360000, 240000])
  assert.equal(host.scriptsFor('watchdog').length, 0)
  cleanup()
})

test('parent abort short-circuits', async () => {
  const { dir, cleanup } = project()
  const host = new FakeHost()
  const controller = new AbortController()
  controller.abort()
  const result = await make(host, dir).bootstrap({ goal: 'x', approved_loop_count: 5 }, controller.signal)
  assert.equal(result.ok, false)
  assert.equal(result.message, 'CX_ABORTED')
  cleanup()
})

test('recoverable guard escalation: block_continue -> watchdog -> needs_user', async () => {
  const { dir, cleanup } = project()
  const host = new FakeHost()
  host.script('watchdog', [
    { output: commander({ decision: 'RETRY_DIFFERENTLY', instruction: 'try another way' }) },
    { output: commander({ decision: 'NEEDS_USER' }) },
  ])
  const supervisor = make(host, dir)
  const state = supervisor.createState({ goal: 'x', approved_loop_count: 5 })
  state.phase = 'EXECUTE'
  state.status = 'running'
  state.plan = { summary: 'p', steps: [{ id: 'P1', goal: 'a', status: 'running' }] }
  state.current_step = { id: 'P1', attempt: 1 }
  new CxStateStore(dir).writeState(state)

  const first = await supervisor.recordGuardBlock('secret_operation', 'printenv')
  assert.equal(first.disposition, 'block_continue')
  assert.equal(first.watchdog_calls, 0)
  assert.equal(new CxStateStore(dir).readState()?.phase, 'EXECUTE')

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
      { output: plan([{ id: 'P1', goal: 'code' }, { id: 'P2', goal: 'verify page', capabilities: ['browser'] }]) },
      { output: commander({ decision: 'PASS_CURRENT_STEP' }) },
      { output: commander({ decision: 'PASS_CURRENT_STEP' }) },
      { output: commander({ decision: 'SUCCESS' }) },
    ])
    .script('executor', [{ output: 'a', childId: 'e1' }, { output: 'b', childId: 'e2' }])
  await make(host, dir).bootstrap({ goal: 'x', approved_loop_count: 5 })
  const executors = host.scriptsFor('executor')
  assert.ok(executors[0]?.request.toolFilter?.deny?.includes('agent_browser'))
  assert.equal(executors[1]?.request.toolFilter, undefined)
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
      { output: plan([{ id: 'P1', goal: 'verify page', capabilities: ['browser'] }]) },
      { output: commander({ decision: 'NEEDS_USER' }) },
    ])
  const result = await make(host, dir).bootstrap({ goal: 'x', approved_loop_count: 5 })
  assert.equal(result.phase, 'NEEDS_USER')
  assert.equal(host.scriptsFor('executor').length, 0)
  cleanup()
})
