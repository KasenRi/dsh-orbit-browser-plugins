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

export function parseJsonObject<T>(text: string, label: string): T {
  const withoutFence = text.replace(/```(?:json)?/gi, '')
  const start = withoutFence.indexOf('{')
  const end = withoutFence.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error(`${label}_OUTPUT_INVALID: no JSON object found`)
  try {
    return JSON.parse(withoutFence.slice(start, end + 1)) as T
  } catch (error) {
    throw new Error(`${label}_OUTPUT_INVALID: ${error instanceof Error ? error.message : String(error)}`)
  }
}

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
