import type { ObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import {
  MAX_PLAN_STEPS,
  MIN_PLAN_STEPS,
  type OrbitCapability,
  type OrbitPlanStep,
  type CommanderDecision,
  type CommanderDecisionKind,
  type StrategyDecision,
  type TimeoutDecision,
  type WatchdogDecision,
  type GuardWatchdogDecision,
} from './types.ts'

// ── DSH-native structured decision schemas ───────────────────────────────────
//
// The model submits its decision through the DSH structured-output protocol and
// the provider validates it against one of these schemas. They are written in
// the enforced JSON Schema subset (dsh-tools `assertObjectJsonSchema`), keep only
// format-level rules (types, required fields, legal enums), and leave Orbit's
// domain rules (plan size, correction depth, budget) to the checks below.

const CAPABILITY_ENUM = ['browser', 'web-api-recon']

/** Plan steps are object-rooted; capabilities stay optional per step. */
export const COMMANDER_PLAN_SCHEMA: ObjectJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'steps'],
  properties: {
    summary: { type: 'string', description: 'One-sentence plan summary.' },
    steps: {
      type: 'array',
      description: '2-5 logical engineering steps.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['goal'],
        properties: {
          id: { type: 'string', description: 'Stable id such as P0.' },
          goal: { type: 'string' },
          capabilities: { type: 'array', items: { type: 'string', enum: CAPABILITY_ENUM } },
        },
      },
    },
  },
}

export const COMMANDER_STEP_EVALUATE_SCHEMA: ObjectJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['decision'],
  properties: {
    decision: { type: 'string', enum: ['PASS_CURRENT_STEP', 'CORRECT_CURRENT_STEP', 'NEEDS_USER'] },
    reason: { type: 'string' },
    next_step_goal: { type: 'string' },
    next_step_capabilities: { type: 'array', items: { type: 'string', enum: CAPABILITY_ENUM } },
  },
}

export const COMMANDER_FINAL_EVALUATE_SCHEMA: ObjectJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['decision'],
  properties: {
    decision: { type: 'string', enum: ['SUCCESS', 'APPEND', 'NEEDS_USER'] },
    summary: { type: 'string' },
    next_step_goal: { type: 'string' },
    next_step_capabilities: { type: 'array', items: { type: 'string', enum: CAPABILITY_ENUM } },
    next_steps: {
      type: 'array',
      items: {
        oneOf: [
          { type: 'string' },
          {
            type: 'object',
            additionalProperties: false,
            required: ['goal'],
            properties: {
              goal: { type: 'string' },
              capabilities: { type: 'array', items: { type: 'string', enum: CAPABILITY_ENUM } },
            },
          },
        ],
      },
    },
  },
}

export const COMMANDER_STRATEGY_SCHEMA: ObjectJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['decision'],
  properties: {
    decision: { type: 'string', enum: ['KEEP_APPROACH', 'REPLACE_CURRENT_STEP', 'NEEDS_USER'] },
    reason: { type: 'string' },
    replacement_goal: { type: 'string' },
  },
}

export const WATCHDOG_RUNTIME_SCHEMA: ObjectJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['decision'],
  properties: {
    decision: { type: 'string', enum: ['RESUME_CHILD', 'RESTART_STEP', 'NEEDS_USER', 'RUNTIME_BUG'] },
    reason: { type: 'string' },
  },
}

export const WATCHDOG_STRATEGY_SCHEMA: ObjectJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['question'],
  properties: {
    question: { type: 'string', description: 'The single strategy question to put to the Commander.' },
  },
}

export const WATCHDOG_GUARD_SCHEMA: ObjectJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['decision'],
  properties: {
    decision: { type: 'string', enum: ['RETRY_DIFFERENTLY', 'NEEDS_USER'] },
    instruction: { type: 'string' },
  },
}

export const WATCHDOG_TIMEOUT_SCHEMA: ObjectJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['decision'],
  properties: {
    decision: { type: 'string', enum: ['EXTEND', 'INTERRUPT', 'NEEDS_USER'] },
    reason: { type: 'string' },
  },
}

export const ORBIT_DECISION_SCHEMAS = {
  COMMANDER_PLAN_SCHEMA,
  COMMANDER_STEP_EVALUATE_SCHEMA,
  COMMANDER_FINAL_EVALUATE_SCHEMA,
  COMMANDER_STRATEGY_SCHEMA,
  WATCHDOG_RUNTIME_SCHEMA,
  WATCHDOG_STRATEGY_SCHEMA,
  WATCHDOG_GUARD_SCHEMA,
  WATCHDOG_TIMEOUT_SCHEMA,
} as const

const STEP_CAPABILITIES = new Set<string>(['browser', 'web-api-recon'])

export function normalizeCapabilities(value: unknown): OrbitCapability[] | undefined {
  if (!Array.isArray(value)) return undefined
  const result: OrbitCapability[] = []
  for (const item of value) {
    if (typeof item !== 'string' || !STEP_CAPABILITIES.has(item)) continue
    if (!result.includes(item as OrbitCapability)) result.push(item as OrbitCapability)
  }
  if (result.length === 0) return undefined
  if (result.includes('web-api-recon') && !result.includes('browser')) result.unshift('browser')
  return result
}

export interface CommanderPlan {
  summary?: unknown
  steps?: unknown
}

export function normalizePlan(plan: CommanderPlan): { summary: string; steps: OrbitPlanStep[] } {
  if (!Array.isArray(plan.steps) || plan.steps.length < MIN_PLAN_STEPS || plan.steps.length > MAX_PLAN_STEPS) {
    throw new Error(`COMMANDER_PLAN_OUTPUT_INVALID: steps must contain ${MIN_PLAN_STEPS}-${MAX_PLAN_STEPS} entries`)
  }
  const steps: OrbitPlanStep[] = plan.steps.map((item, index) => {
    const record = (item ?? {}) as Record<string, unknown>
    const rawId = typeof record.id === 'string' ? record.id : ''
    const id = /^P\d+$/u.test(rawId) ? rawId : `P${index}`
    const goal = String(record.goal ?? '').trim()
    const capabilities = normalizeCapabilities(record.capabilities)
    return {
      id,
      goal,
      ...(capabilities ? { capabilities } : {}),
      status: 'pending' as const,
    }
  })
  if (steps.some((step) => !step.goal)) {
    throw new Error('COMMANDER_PLAN_OUTPUT_INVALID: every step needs a goal')
  }
  return { summary: String(plan.summary ?? '').slice(0, 1000), steps }
}

export type EvaluationMode = 'STEP_EVALUATE' | 'FINAL_EVALUATE'

const STEP_DECISIONS: readonly CommanderDecisionKind[] = ['PASS_CURRENT_STEP', 'CORRECT_CURRENT_STEP', 'NEEDS_USER']
const FINAL_DECISIONS: readonly CommanderDecisionKind[] = ['SUCCESS', 'APPEND', 'NEEDS_USER']

export function assertCommanderDecision(decision: CommanderDecision, mode: EvaluationMode): CommanderDecision {
  const allowed = mode === 'FINAL_EVALUATE' ? FINAL_DECISIONS : STEP_DECISIONS
  if (!allowed.includes(decision.decision)) {
    throw new Error(`COMMANDER_EVALUATION_DECISION_INVALID_FOR_MODE: ${mode} cannot return ${decision.decision}`)
  }
  return decision
}

export function assertStrategyDecision(decision: StrategyDecision): StrategyDecision {
  const allowed = ['KEEP_APPROACH', 'REPLACE_CURRENT_STEP', 'NEEDS_USER']
  if (!allowed.includes(decision.decision)) {
    throw new Error(`COMMANDER_STRATEGY_DECISION_INVALID: ${decision.decision}`)
  }
  if (decision.decision === 'REPLACE_CURRENT_STEP' && !decision.replacement_goal?.trim()) {
    throw new Error('COMMANDER_STRATEGY_OUTPUT_INVALID: replacement_goal is required')
  }
  return decision
}

export function assertTimeoutDecision(decision: TimeoutDecision): TimeoutDecision {
  const allowed = ['EXTEND', 'INTERRUPT', 'NEEDS_USER']
  if (!allowed.includes(decision.decision)) {
    throw new Error(`COMMANDER_TIMEOUT_WATCHDOG_DECISION_INVALID: ${decision.decision}`)
  }
  return decision
}

export function assertWatchdogDecision(decision: WatchdogDecision): WatchdogDecision {
  const allowed = ['RESUME_CHILD', 'RESTART_STEP', 'NEEDS_USER', 'RUNTIME_BUG']
  if (!allowed.includes(decision.decision)) {
    throw new Error(`SMART_WATCHDOG_RUNTIME_DECISION_INVALID: ${decision.decision}`)
  }
  return decision
}

export function assertGuardWatchdogDecision(decision: GuardWatchdogDecision): GuardWatchdogDecision {
  const allowed = ['RETRY_DIFFERENTLY', 'NEEDS_USER']
  if (!allowed.includes(decision.decision)) {
    throw new Error(`SMART_WATCHDOG_GUARD_DECISION_INVALID: ${decision.decision}`)
  }
  return decision
}

export function correctionDepthOf(stepId: string): number {
  const suffix = stepId.split('-', 2)[1]
  return suffix ? Number(suffix) - 1 : 0
}

export function baseStepIdOf(stepId: string): string {
  return stepId.split('-', 2)[0] ?? stepId
}

export function isBaseStepId(stepId: string): boolean {
  return /^P\d+$/u.test(stepId)
}
