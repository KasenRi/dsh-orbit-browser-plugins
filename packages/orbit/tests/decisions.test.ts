import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assertObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import {
  assertCommanderDecision,
  assertGuardWatchdogDecision,
  assertStrategyDecision,
  assertTimeoutDecision,
  assertWatchdogDecision,
  ORBIT_DECISION_SCHEMAS,
} from '../src/decisions.ts'

test('every decision schema is inside the enforced DSH subset', () => {
  for (const [name, schema] of Object.entries(ORBIT_DECISION_SCHEMAS)) {
    assert.doesNotThrow(() => assertObjectJsonSchema(schema), `${name} must be a valid ObjectJsonSchema`)
  }
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
