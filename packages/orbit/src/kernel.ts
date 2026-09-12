/**
 * Deterministic Orbit domain rules.
 *
 * This is the pure rule core: it must not import DSH packages, perform IO,
 * read a clock, or use randomness. Runtime values (routes, timestamps, run ids)
 * are supplied by the supervisor, which owns orchestration and persistence.
 */

import {
  MAX_CORRECTION_DEPTH,
  MAX_PLAN_STEPS,
  MIN_PLAN_STEPS,
  type CommanderDecision,
  type OrbitCapability,
  type OrbitPlanStep,
  type OrbitState,
} from './types.ts'

/** Capabilities a plan step may request. */
export const ORBIT_CAPABILITIES: readonly OrbitCapability[] = ['browser', 'web-api-recon']

const STEP_CAPABILITIES = new Set<string>(ORBIT_CAPABILITIES)

const PLAN_STEP_ID = /^P\d+$/u

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
    const id = PLAN_STEP_ID.test(rawId) ? rawId : `P${index}`
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

export function correctionDepthOf(stepId: string): number {
  const suffix = stepId.split('-', 2)[1]
  return suffix ? Number(suffix) - 1 : 0
}

export function baseStepIdOf(stepId: string): string {
  return stepId.split('-', 2)[0] ?? stepId
}

export function isBaseStepId(stepId: string): boolean {
  return PLAN_STEP_ID.test(stepId)
}

export interface OrbitLoopBudgetInput {
  approved_loop_count?: number
  max_loops?: number
}

export function explicitLoopBudget(input: OrbitLoopBudgetInput): number | undefined {
  const raw = input.approved_loop_count ?? input.max_loops
  if (raw === undefined) return undefined
  if (!Number.isSafeInteger(raw) || raw <= 0) throw new Error('ORBIT_LOOP_BUDGET_INVALID: approved_loop_count must be a positive integer')
  if (raw > 10) throw new Error('ORBIT_LOOP_BUDGET_INVALID: approved_loop_count above 10 requires an explicit execution request')
  return raw
}

export function estimateLoopCount(goal: string): number {
  const text = goal.toLowerCase()
  if (/critical|migrate|migration|production|架构|重构/.test(text)) return 6
  if (/integration|联调|ui|high/.test(text)) return 4
  if (/feature|多文件|multi-file/.test(goal)) return 3
  if (/bug|fix|test/.test(text)) return 2
  return 1
}

export function updateLoopBudget(state: OrbitState, budget: number): void {
  if (budget < state.loop.used) throw new Error(`ORBIT_LOOP_BUDGET_BELOW_USED: requested ${budget}, already used ${state.loop.used}`)
  state.approved_loop_count = budget
  state.loop = { used: state.loop.used, max: budget }
  state.loop_count = state.loop.used
  state.remaining_budget = Math.max(0, budget - state.loop.used)
}

export function hashGoal(goal: string): string {
  let hash = 0
  for (let index = 0; index < goal.length; index += 1) {
    hash = (hash * 31 + goal.charCodeAt(index)) | 0
  }
  return `g${(hash >>> 0).toString(16)}`
}

export interface AppendedStep {
  goal: string
  capabilities?: OrbitCapability[]
}

/** Normalize an APPEND decision into bounded, deduplicated new plan steps. */
export function normalizeAppend(decision: CommanderDecision): AppendedStep[] {
  const items: AppendedStep[] = []
  if (Array.isArray(decision.next_steps)) {
    for (const entry of decision.next_steps) {
      if (typeof entry === 'string' && entry.trim()) items.push({ goal: entry.trim() })
      else if (entry && typeof entry === 'object') {
        const goal = String((entry as { goal?: unknown }).goal ?? '').trim()
        if (goal) {
          const capabilities = normalizeCapabilities((entry as { capabilities?: unknown }).capabilities)
          items.push({ goal, ...(capabilities ? { capabilities } : {}) })
        }
      }
    }
  }
  if (items.length === 0 && decision.next_step_goal?.trim()) {
    const capabilities = normalizeCapabilities(decision.next_step_capabilities)
    items.push({ goal: decision.next_step_goal.trim(), ...(capabilities ? { capabilities } : {}) })
  }
  return items
}

export type CorrectionBlockCode = 'CORRECTION_LIMIT_REACHED' | 'LOOP_BUDGET_RESERVED_FOR_LATER_STEPS'

/** Why a correction step cannot be inserted, if the deterministic budget rules say so. */
export function correctionBlockCode(state: OrbitState, step: OrbitPlanStep): CorrectionBlockCode | undefined {
  if (correctionDepthOf(step.id) >= MAX_CORRECTION_DEPTH) return 'CORRECTION_LIMIT_REACHED'
  const remaining = Math.max(0, state.loop.max - state.loop.used)
  const reservedForLaterStages = state.plan.steps.filter(
    (candidate) => isBaseStepId(candidate.id) && candidate.status === 'pending',
  ).length
  if (remaining <= reservedForLaterStages) return 'LOOP_BUDGET_RESERVED_FOR_LATER_STEPS'
  return undefined
}
