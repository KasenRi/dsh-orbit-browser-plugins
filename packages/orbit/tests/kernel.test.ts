import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  baseStepIdOf,
  correctionBlockCode,
  correctionDepthOf,
  estimateLoopCount,
  explicitLoopBudget,
  hashGoal,
  isBaseStepId,
  normalizeAppend,
  normalizeCapabilities,
  normalizePlan,
  updateLoopBudget,
} from '../src/kernel.ts'
import type { OrbitState } from '../src/types.ts'

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
  assert.deepEqual(plan.steps[1]?.capabilities, ['browser', 'web-api-recon'])
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

test('estimates loop budget deterministically from the goal', () => {
  assert.equal(estimateLoopCount('migrate the production database'), 6)
  assert.equal(estimateLoopCount('ship a UI integration feature'), 4)
  assert.equal(estimateLoopCount('add a multi-file feature'), 3)
  assert.equal(estimateLoopCount('fix this bug'), 2)
  assert.equal(estimateLoopCount('say hello'), 1)
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
    { goal: 'do z', capabilities: ['browser', 'web-api-recon'] },
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
