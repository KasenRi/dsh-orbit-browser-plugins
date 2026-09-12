import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  assertCommanderDecision,
  assertGuardWatchdogDecision,
  assertStrategyDecision,
  assertTimeoutDecision,
  assertWatchdogDecision,
  baseStepIdOf,
  correctionDepthOf,
  normalizeCapabilities,
  normalizePlan,
  parseJsonObject,
} from '../src/decisions.ts'

test('parses JSON inside code fences', () => {
  const parsed = parseJsonObject<{ a: number }>('here\n```json\n{"a":1}\n```\ntrailing', 'X')
  assert.equal(parsed.a, 1)
})

test('rejects non-JSON output with a labeled error', () => {
  assert.throws(() => parseJsonObject('no json', 'COMMANDER_PLAN'), /COMMANDER_PLAN_OUTPUT_INVALID/)
})

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

test('enforces step and final decision boundaries', () => {
  assert.throws(() => assertCommanderDecision({ decision: 'SUCCESS' }, 'STEP_EVALUATE'), /cannot return SUCCESS/)
  assert.throws(() => assertCommanderDecision({ decision: 'PASS_CURRENT_STEP' }, 'FINAL_EVALUATE'), /cannot return PASS_CURRENT_STEP/)
  assert.equal(assertCommanderDecision({ decision: 'SUCCESS' }, 'FINAL_EVALUATE').decision, 'SUCCESS')
})

test('enforces strategy / timeout / watchdog boundaries', () => {
  assert.throws(() => assertStrategyDecision({ decision: 'SUCCESS' as never }), /COMMANDER_STRATEGY_DECISION_INVALID/)
  assert.throws(() => assertStrategyDecision({ decision: 'REPLACE_CURRENT_STEP' }), /replacement_goal is required/)
  assert.throws(() => assertTimeoutDecision({ decision: 'SUCCESS' as never }), /COMMANDER_TIMEOUT_WATCHDOG_DECISION_INVALID/)
  assert.throws(() => assertWatchdogDecision({ decision: 'BAD' as never }), /SMART_WATCHDOG_RUNTIME_DECISION_INVALID/)
  assert.throws(() => assertGuardWatchdogDecision({ decision: 'BAD' as never }), /SMART_WATCHDOG_GUARD_DECISION_INVALID/)
})

test('correction depth and base id helpers', () => {
  assert.equal(correctionDepthOf('P1'), 0)
  assert.equal(correctionDepthOf('P1-2'), 1)
  assert.equal(correctionDepthOf('P1-3'), 2)
  assert.equal(baseStepIdOf('P1-3'), 'P1')
})
