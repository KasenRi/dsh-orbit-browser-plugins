import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  applyCommanderNeedsUser,
  applyCorrectionStep,
  applyExecutorCapabilityUnavailable,
  applyExecutorInterrupted,
  applyExecutorResume,
  applyExecutorSuccess,
  applyFinalAppend,
  applyFinalSuccess,
  applyPlan,
  applyStepPass,
  baseStepIdOf,
  beginStep,
  clearExecutorChild,
  clearGuardRecovery,
  correctionBlockCode,
  correctionDepthOf,
  createInitialState,
  enterBudgetExhausted,
  enterNeedsUser,
  explicitLoopBudget,
  hashGoal,
  isBaseStepId,
  markStrategyChallengeUsed,
  normalizeAppend,
  normalizeCapabilities,
  normalizePlan,
  openWatchdogAttempt,
  recordGuardRecovery,
  recordPlanFailure,
  recordWatchdogDecision,
  restoreEvaluationState,
  resumeFromNeedsUser,
  stopRun,
  updateLoopBudget,
} from '../src/kernel.ts'
import type { OrbitPlanStep, OrbitState } from '../src/types.ts'

const ROUTES = {
  commander: { provider: 'p', model: 'm' },
  executor: { provider: 'p', model: 'm' },
  watchdog: { provider: 'p', model: 'm' },
}

const step = (id: string, goal = 'g'): OrbitPlanStep => ({ id, goal, status: 'pending' })

function state(overrides: Partial<OrbitState> = {}): OrbitState {
  return {
    schema_version: 2,
    active_run_id: 'r1',
    run_id: 'r1',
    phase: 'EXECUTE',
    status: 'running',
    driver_ownership: 'ACTIVE',
    state_revision: 0,
    updated_at: '2026-01-01T00:00:00.000Z',
    goal: 'g',
    goal_hash: 'h',
    preset: 'orbit-lite',
    routes: { commander: { provider: 'p', model: 'm' }, executor: { provider: 'p', model: 'm' }, watchdog: { provider: 'p', model: 'm' } },
    loop: { used: 0, max: 3 },
    approved_loop_count: 3,
    remaining_budget: 3,
    loop_count: 0,
    plan: { summary: '', steps: [] },
    changed_files: [],
    test_summary: [],
    last_error: null,
    user_hard_constraints: [],
    github_allowed: false,
    interruption_retries: 0,
    ...overrides,
  }
}

test('normalizes plan steps and capabilities', () => {
  const plan = normalizePlan({
    summary: 's',
    steps: [
      { id: 'P0', goal: 'a' },
      { id: 'bad', goal: 'b', capabilities: ['web-api-recon'] },
    ],
  })
  assert.equal(plan.steps[0]?.id, 'P0')
  assert.equal(plan.steps[1]?.id, 'P1')
  assert.deepEqual(plan.steps[1]?.capabilities, ['web', 'browser'])
})

test('rejects plan with too many steps', () => {
  assert.throws(
    () => normalizePlan({ steps: Array.from({ length: 6 }, (_, index) => ({ id: `P${index}`, goal: 'g' })) }),
    /COMMANDER_PLAN_OUTPUT_INVALID/,
  )
})

test('rejects plan step without a goal', () => {
  assert.throws(() => normalizePlan({ steps: [{ id: 'P0', goal: '' }] }), /every step needs a goal/)
})

test('capability normalization drops unknown entries', () => {
  assert.deepEqual(normalizeCapabilities(['browser', 'nonsense', 'browser']), ['browser'])
  assert.equal(normalizeCapabilities([]), undefined)
  assert.equal(normalizeCapabilities('browser'), undefined)
})

test('correction depth and base id helpers', () => {
  assert.equal(correctionDepthOf('P1'), 0)
  assert.equal(correctionDepthOf('P1-2'), 1)
  assert.equal(correctionDepthOf('P1-3'), 2)
  assert.equal(baseStepIdOf('P1-3'), 'P1')
  assert.equal(isBaseStepId('P1'), true)
  assert.equal(isBaseStepId('P1-2'), false)
})

test('validates the explicit loop budget', () => {
  assert.equal(explicitLoopBudget({ approved_loop_count: 4 }), 4)
  assert.equal(explicitLoopBudget({ max_loops: 2 }), 2)
  assert.equal(explicitLoopBudget({}), undefined)
  assert.throws(() => explicitLoopBudget({ approved_loop_count: 0 }), /ORBIT_LOOP_BUDGET_INVALID/)
  assert.throws(() => explicitLoopBudget({ approved_loop_count: 2.5 }), /ORBIT_LOOP_BUDGET_INVALID/)
  assert.throws(() => explicitLoopBudget({ approved_loop_count: 11 }), /above 10/)
})

test('uses one predictable default loop budget regardless of goal wording', () => {
  for (const goal of ['production migration', 'UI integration', 'fix bug', 'say hello']) {
    const initial = createInitialState({ runId: goal, now: 0, goal, routes: ROUTES, githubAllowed: false })
    assert.equal(initial.loop.max, 5)
  }
})

test('updates the loop budget without losing used slots', () => {
  const current = state({ loop: { used: 2, max: 3 }, loop_count: 2, remaining_budget: 1 })
  updateLoopBudget(current, 5)
  assert.equal(current.loop.max, 5)
  assert.equal(current.loop.used, 2)
  assert.equal(current.approved_loop_count, 5)
  assert.equal(current.loop_count, 2)
  assert.equal(current.remaining_budget, 3)
  assert.throws(() => updateLoopBudget(current, 1), /ORBIT_LOOP_BUDGET_BELOW_USED/)
})

test('normalizes APPEND decisions into plan steps', () => {
  assert.deepEqual(normalizeAppend({ decision: 'APPEND', next_steps: ['do x', { goal: 'do y', capabilities: ['browser'] }] }), [
    { goal: 'do x' },
    { goal: 'do y', capabilities: ['browser'] },
  ])
  assert.deepEqual(normalizeAppend({ decision: 'APPEND', next_step_goal: 'do z', next_step_capabilities: ['web-api-recon'] }), [
    { goal: 'do z', capabilities: ['web', 'browser'] },
  ])
  assert.deepEqual(normalizeAppend({ decision: 'APPEND', next_steps: [{ goal: '' }, '   '] }), [])
})

test('blocks corrections deterministically at the depth limit', () => {
  const plan = { summary: '', steps: [{ id: 'P1-3', goal: 'g', status: 'running' as const }] }
  assert.equal(correctionBlockCode(state({ plan }), plan.steps[0]!), 'CORRECTION_LIMIT_REACHED')
})

test('blocks corrections when the budget is reserved for later steps', () => {
  const plan = {
    summary: '',
    steps: [
      { id: 'P1', goal: 'a', status: 'running' as const },
      { id: 'P2', goal: 'b', status: 'pending' as const },
    ],
  }
  assert.equal(correctionBlockCode(state({ plan, loop: { used: 1, max: 2 }, remaining_budget: 1 }), plan.steps[0]!), 'LOOP_BUDGET_RESERVED_FOR_LATER_STEPS')
  assert.equal(correctionBlockCode(state({ plan, loop: { used: 1, max: 3 }, remaining_budget: 2 }), plan.steps[0]!), undefined)
})

test('hashGoal is deterministic', () => {
  assert.equal(hashGoal('same goal'), hashGoal('same goal'))
  assert.notEqual(hashGoal('goal a'), hashGoal('goal b'))
})

// ── deterministic state transitions ─────────────────────────────────────────

test('initial state follows the kernel rules', () => {
  const initial = createInitialState({
    runId: 'run-1',
    now: Date.UTC(2026, 0, 2, 3, 4, 5),
    goal: 'fix a bug',
    routes: ROUTES,
    approvedLoopCount: 4,
    userHardConstraints: ['no push'],
    githubAllowed: true,
  })
  assert.equal(initial.schema_version, 2)
  assert.equal(initial.run_id, 'run-1')
  assert.equal(initial.active_run_id, 'run-1')
  assert.equal(initial.phase, 'PLAN')
  assert.equal(initial.status, 'running')
  assert.equal(initial.driver_ownership, 'ACTIVE')
  assert.equal(initial.goal_hash, hashGoal('fix a bug'))
  assert.equal(initial.updated_at, '2026-01-02T03:04:05.000Z')
  assert.deepEqual(initial.loop, { used: 0, max: 4 })
  assert.equal(initial.remaining_budget, 4)
  assert.equal(initial.loop_count, 0)
  assert.deepEqual(initial.plan, { summary: '', steps: [] })
  assert.deepEqual(initial.user_hard_constraints, ['no push'])
  assert.equal(initial.github_allowed, true)
  assert.equal(initial.interruption_retries, 0)
})

test('initial state uses the fixed default budget when none is explicit', () => {
  const initial = createInitialState({ runId: 'r', now: 0, goal: 'ship a UI integration', routes: ROUTES, githubAllowed: false })
  assert.equal(initial.loop.max, 5)
})

test('resumeFromNeedsUser re-enters EXECUTE', () => {
  const current = state({ phase: 'NEEDS_USER', status: 'needs_user' })
  resumeFromNeedsUser(current)
  assert.equal(current.phase, 'EXECUTE')
  assert.equal(current.status, 'running')
})

test('plan acceptance and failure transitions', () => {
  const current = state({ phase: 'PLAN' })
  const plan = { summary: 's', steps: [step('P0')] }
  applyPlan(current, plan)
  assert.equal(current.plan, plan)
  assert.equal(current.phase, 'EXECUTE')
  assert.equal(current.status, 'running')

  recordPlanFailure(current, 'COMMANDER_PLAN_OUTPUT_INVALID')
  assert.equal(current.phase, 'PLAN')
  assert.equal(current.status, 'running')
  assert.equal(current.last_error, 'COMMANDER_PLAN_OUTPUT_INVALID')
})

test('beginStep starts the step, tracks attempts, and enters EXECUTE', () => {
  const current = state({ phase: 'PLAN' })
  const target = step('P1')
  beginStep(current, target)
  assert.equal(target.status, 'running')
  assert.deepEqual(current.current_step, { id: 'P1', attempt: 1 })
  assert.equal(current.phase, 'EXECUTE')
  assert.equal(current.status, 'running')

  beginStep(current, target)
  assert.deepEqual(current.current_step, { id: 'P1', attempt: 2 })
})

test('capability unavailable records a completed shell for evaluation', () => {
  const current = state()
  applyExecutorCapabilityUnavailable(current, 'P2')
  assert.deepEqual(current.child, { status: 'completed' })
  assert.equal(current.last_error, 'BROWSER_CAPABILITY_UNAVAILABLE')
  assert.match(current.commander?.summary ?? '', /步骤 P2/)
  assert.equal(current.phase, 'EVALUATE')
})

test('executor interruption consumes a retry and keeps EXECUTE resumable', () => {
  const current = state({ interruption_retries: 1 })
  const retries = applyExecutorInterrupted(current, { childId: 'e1', lastError: 'EXECUTOR_TIMEOUT' })
  assert.equal(retries, 2)
  assert.equal(current.interruption_retries, 2)
  assert.deepEqual(current.child, { id: 'e1', status: 'interrupted' })
  assert.equal(current.last_error, 'EXECUTOR_TIMEOUT')
  assert.equal(current.phase, 'EXECUTE')
  assert.equal(current.status, 'running')
})

test('executor resume keeps the child, restart clears it', () => {
  const current = state({ interruption_retries: 2 })
  applyExecutorResume(current, 'e1')
  assert.deepEqual(current.child, { id: 'e1', status: 'interrupted' })
  assert.equal(current.interruption_retries, 2)

  clearExecutorChild(current)
  assert.equal(current.child, undefined)
  assert.equal(current.interruption_retries, 0)
})

test('executor success consumes one loop slot and enters EVALUATE', () => {
  const current = state({ loop: { used: 1, max: 3 }, loop_count: 1, remaining_budget: 2, interruption_retries: 2 })
  applyExecutorSuccess(current, {
    childId: 'e1',
    summary: 'did work',
    changedFiles: ['src/a.ts'],
    testSummary: ['npm test ok'],
  })
  assert.deepEqual(current.child, { id: 'e1', status: 'completed' })
  assert.equal(current.interruption_retries, 0)
  assert.deepEqual(current.loop, { used: 2, max: 3 })
  assert.equal(current.loop_count, 2)
  assert.equal(current.remaining_budget, 1)
  assert.deepEqual(current.changed_files, ['src/a.ts'])
  assert.deepEqual(current.test_summary, ['npm test ok'])
  assert.equal(current.last_error, null)
  assert.equal(current.commander?.summary, 'did work')
  assert.equal(current.phase, 'EVALUATE')
  assert.equal(current.status, 'running')
})

test('step pass marks the step and returns to EXECUTE', () => {
  const target = step('P1')
  const current = state({ plan: { summary: '', steps: [target] } })
  applyStepPass(current, target, 'looks good')
  assert.equal(target.status, 'passed')
  assert.equal(current.commander?.last_decision, 'PASS_CURRENT_STEP')
  assert.equal(current.commander?.summary, 'looks good')
  assert.equal(current.phase, 'EXECUTE')
  assert.equal(current.status, 'running')
})

test('final success closes the run', () => {
  const current = state()
  applyFinalSuccess(current, 'goal met')
  assert.equal(current.commander?.last_decision, 'SUCCESS')
  assert.equal(current.commander?.summary, 'goal met')
  assert.equal(current.phase, 'SUCCESS')
  assert.equal(current.status, 'success')
})

test('commander NEEDS_USER records the decision and pauses', () => {
  const current = state()
  applyCommanderNeedsUser(current, 'needs a decision')
  assert.equal(current.commander?.last_decision, 'NEEDS_USER')
  assert.equal(current.phase, 'NEEDS_USER')
  assert.equal(current.status, 'needs_user')
  assert.equal(current.last_error, 'needs a decision')
})

test('final append adds bounded base steps', () => {
  const current = state({ loop: { used: 1, max: 3 }, remaining_budget: 2 })
  const outcome = applyFinalAppend(current, {
    decision: 'APPEND',
    next_steps: ['first', { goal: 'second', capabilities: ['browser'] }],
    summary: 'more work',
  })
  assert.equal(outcome, 'appended')
  assert.deepEqual(
    current.plan.steps.map((entry) => [entry.id, entry.goal, entry.status, entry.capabilities]),
    [
      ['P0', 'first', 'pending', undefined],
      ['P1', 'second', 'pending', ['browser']],
    ],
  )
  assert.equal(current.commander?.last_decision, 'APPEND')
  assert.equal(current.phase, 'EXECUTE')
  assert.equal(current.status, 'running')
})

test('final append rejects empty decisions and exhausts the budget without a quota', () => {
  const empty = state()
  assert.equal(applyFinalAppend(empty, { decision: 'APPEND' }), 'invalid')
  assert.equal(empty.phase, 'EXECUTE')

  const spent = state({ loop: { used: 3, max: 3 }, remaining_budget: 0 })
  assert.equal(applyFinalAppend(spent, { decision: 'APPEND', next_step_goal: 'x' }), 'budget_exhausted')
  assert.equal(spent.phase, 'BUDGET_EXHAUSTED')
  assert.equal(spent.status, 'budget_exhausted')
  assert.equal(spent.loop_count, 0)
})

test('append caps added steps at the remaining budget', () => {
  const current = state({ loop: { used: 2, max: 3 }, remaining_budget: 1 })
  const outcome = applyFinalAppend(current, {
    decision: 'APPEND',
    next_steps: ['a', 'b', 'c'],
  })
  assert.equal(outcome, 'appended')
  assert.deepEqual(
    current.plan.steps.map((entry) => entry.goal),
    ['a'],
  )
})

test('correction inserts P1-2 then P1-3 with inherited capabilities', () => {
  const first: OrbitPlanStep = { ...step('P1'), capabilities: ['browser'] }
  const current = state({ plan: { summary: '', steps: [first] } })
  applyCorrectionStep(current, first, { nextGoal: 'fix once' })
  assert.equal(first.status, 'needs_correction')
  assert.deepEqual(
    current.plan.steps.map((entry) => entry.id),
    ['P1', 'P1-2'],
  )
  assert.equal(current.plan.steps[1]?.goal, 'fix once')
  assert.deepEqual(current.plan.steps[1]?.capabilities, ['browser'])
  assert.equal(current.phase, 'EXECUTE')
  assert.equal(current.status, 'running')

  const correction = current.plan.steps[1]!
  correction.status = 'running'
  applyCorrectionStep(current, correction, { nextGoal: 'fix twice', capabilities: ['web-api-recon'] })
  assert.deepEqual(
    current.plan.steps.map((entry) => entry.id),
    ['P1', 'P1-2', 'P1-3'],
  )
  assert.equal(current.plan.steps[2]?.goal, 'fix twice')
  assert.deepEqual(current.plan.steps[2]?.capabilities, ['web', 'browser'])
})

test('strategy challenge bookkeeping and evaluation restore', () => {
  const current = state({ phase: 'EVALUATE' })
  markStrategyChallengeUsed(current, 'P1')
  assert.deepEqual(current.strategy_challenge, { base_step_id: 'P1', used: true })

  restoreEvaluationState(current, 'SMART_WATCHDOG_UNAVAILABLE')
  assert.equal(current.phase, 'EVALUATE')
  assert.equal(current.status, 'running')
  assert.equal(current.last_error, 'SMART_WATCHDOG_UNAVAILABLE')
})

test('needs user and budget exhausted transitions', () => {
  const paused = state()
  enterNeedsUser(paused, 'reason')
  assert.equal(paused.phase, 'NEEDS_USER')
  assert.equal(paused.status, 'needs_user')
  assert.equal(paused.last_error, 'reason')

  const kept = state({ last_error: 'kept' })
  enterNeedsUser(kept)
  assert.equal(kept.last_error, 'kept')

  const spent = state()
  enterBudgetExhausted(spent, 'LOOP_BUDGET_EXHAUSTED')
  assert.equal(spent.phase, 'BUDGET_EXHAUSTED')
  assert.equal(spent.status, 'budget_exhausted')
  assert.equal(spent.last_error, 'LOOP_BUDGET_EXHAUSTED')

  const quiet = state({ last_error: 'old' })
  enterBudgetExhausted(quiet)
  assert.equal(quiet.last_error, 'old')
})

test('stop closes the run', () => {
  const current = state()
  stopRun(current)
  assert.equal(current.phase, 'STOPPED')
  assert.equal(current.status, 'stopped')
})

test('watchdog attempts cap at the per-step limit and record verdicts', () => {
  const current = state()
  assert.equal(openWatchdogAttempt(current, 'P1', { atCap: undefined, attempt: 'first' }), false)
  assert.deepEqual(current.smart_watchdog, { step_id: 'P1', calls: 1, last_reason: 'first' })

  assert.equal(openWatchdogAttempt(current, 'P1', { atCap: undefined, attempt: 'second' }), false)
  assert.equal(current.smart_watchdog?.calls, 2)

  const capped = openWatchdogAttempt(current, 'P1', { atCap: 'last error', attempt: 'third' })
  assert.equal(capped, true)
  assert.deepEqual(current.smart_watchdog, { step_id: 'P1', calls: 2, last_decision: 'CAP_REACHED', last_reason: 'last error' })

  recordWatchdogDecision(current, 'RESTART_STEP')
  assert.equal(current.smart_watchdog?.last_decision, 'RESTART_STEP')

  // A different step owns a fresh counter.
  assert.equal(openWatchdogAttempt(current, 'P2', { atCap: undefined, attempt: 'fresh' }), false)
  assert.deepEqual(current.smart_watchdog, { step_id: 'P2', calls: 1, last_reason: 'fresh' })
})

test('guard recovery counts per step and code, and clears on decision', () => {
  const current = state()
  assert.equal(recordGuardRecovery(current, 'P1', 'destructive_operation'), 1)
  assert.equal(recordGuardRecovery(current, 'P1', 'destructive_operation'), 2)
  assert.equal(recordGuardRecovery(current, 'P1', 'secret_operation'), 1)
  assert.equal(recordGuardRecovery(current, 'P2', 'destructive_operation'), 1)

  clearGuardRecovery(current)
  assert.equal(current.guard_recovery, undefined)
})
