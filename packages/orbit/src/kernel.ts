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
  MAX_WATCHDOG_CALLS_PER_STEP,
  MIN_PLAN_STEPS,
  ORBIT_SCHEMA_VERSION,
  type CommanderDecision,
  type GuardCode,
  type OrbitCapability,
  type OrbitPlanStep,
  type OrbitRoutes,
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

// ── deterministic state transitions ─────────────────────────────────────────
//
// Every function below is the Orbit rule for one domain transition: phase,
// status, plan, step status, loop consumption, or recovery bookkeeping. The
// supervisor supplies runtime facts (clock, ids, routes, executor results) and
// persists the returned state; the rules themselves live here.

export interface InitialStateInput {
  runId: string
  now: number
  goal: string
  preset?: string
  routes: OrbitRoutes
  approvedLoopCount?: number
  maxLoops?: number
  userHardConstraints?: readonly string[]
  githubAllowed: boolean
}

export function createInitialState(input: InitialStateInput): OrbitState {
  const max =
    explicitLoopBudget({ approved_loop_count: input.approvedLoopCount, max_loops: input.maxLoops }) ??
    estimateLoopCount(input.goal)
  return {
    schema_version: ORBIT_SCHEMA_VERSION,
    active_run_id: input.runId,
    run_id: input.runId,
    phase: 'PLAN',
    status: 'running',
    driver_ownership: 'ACTIVE',
    state_revision: 0,
    updated_at: new Date(input.now).toISOString(),
    goal: input.goal,
    goal_hash: hashGoal(input.goal),
    preset: input.preset ?? 'orbit-lite',
    routes: input.routes,
    loop: { used: 0, max },
    approved_loop_count: max,
    remaining_budget: max,
    loop_count: 0,
    plan: { summary: '', steps: [] },
    changed_files: [],
    test_summary: [],
    last_error: null,
    user_hard_constraints: input.userHardConstraints ? [...input.userHardConstraints] : [],
    github_allowed: input.githubAllowed === true,
    interruption_retries: 0,
  }
}

/** A user answers a NEEDS_USER run with the same goal: execution continues. */
export function resumeFromNeedsUser(state: OrbitState): void {
  state.phase = 'EXECUTE'
  state.status = 'running'
}

/** Accept the Commander plan and move to execution. */
export function applyPlan(state: OrbitState, plan: { summary: string; steps: OrbitPlanStep[] }): void {
  state.plan = plan
  state.phase = 'EXECUTE'
  state.status = 'running'
}

/** PLAN failed or was interrupted: stay resumable in PLAN with the reason. */
export function recordPlanFailure(state: OrbitState, reason: string): void {
  state.phase = 'PLAN'
  state.status = 'running'
  state.last_error = reason
}

/** Start one step: mark it running, bump its attempt, enter EXECUTE. */
export function beginStep(state: OrbitState, step: OrbitPlanStep): void {
  step.status = 'running'
  state.current_step = {
    id: step.id,
    attempt: state.current_step?.id === step.id ? state.current_step.attempt + 1 : 1,
  }
  state.phase = 'EXECUTE'
  state.status = 'running'
}

/** The Executor cannot run (capability missing): record a completed child shell for evaluation. */
export function applyExecutorCapabilityUnavailable(state: OrbitState, stepId: string): void {
  state.child = { status: 'completed' }
  state.last_error = 'BROWSER_CAPABILITY_UNAVAILABLE'
  state.commander = {
    last_decision: state.commander?.last_decision,
    summary: `Executor could not run step ${stepId}: BROWSER_CAPABILITY_UNAVAILABLE (agent_browser tool is not registered).`,
  }
  state.phase = 'EVALUATE'
}

export interface ExecutorInterruptInput {
  childId?: string
  /** Already redacted and truncated by the caller. */
  lastError: string
}

/** Record an interrupted Executor attempt and return the new retry count. */
export function applyExecutorInterrupted(state: OrbitState, input: ExecutorInterruptInput): number {
  state.child = { ...(input.childId ? { id: input.childId } : {}), status: 'interrupted' }
  state.last_error = input.lastError
  state.phase = 'EXECUTE'
  state.status = 'running'
  state.interruption_retries += 1
  return state.interruption_retries
}

/** Watchdog says RESUME_CHILD: keep the child id for a later resume. */
export function applyExecutorResume(state: OrbitState, childId: string): void {
  state.child = { id: childId, status: 'interrupted' }
}

/** Watchdog says RESTART_STEP: drop the child and reset the retry budget. */
export function clearExecutorChild(state: OrbitState): void {
  state.child = undefined
  state.interruption_retries = 0
}

export interface ExecutorSuccessInput {
  childId?: string
  /** Already redacted and truncated by the caller. */
  summary: string
  changedFiles: string[]
  testSummary: string[]
}

/** Apply a real Executor success: consume one loop slot, then enter EVALUATE. */
export function applyExecutorSuccess(state: OrbitState, input: ExecutorSuccessInput): void {
  state.child = { ...(input.childId ? { id: input.childId } : {}), status: 'completed' }
  state.interruption_retries = 0
  state.loop = { used: state.loop.used + 1, max: state.loop.max }
  state.loop_count = state.loop.used
  state.remaining_budget = Math.max(0, state.loop.max - state.loop.used)
  state.changed_files = input.changedFiles
  state.test_summary = input.testSummary
  state.last_error = null
  state.commander = {
    last_decision: state.commander?.last_decision,
    summary: input.summary,
  }
  state.phase = 'EVALUATE'
  state.status = 'running'
}

/** STEP_EVALUATE says PASS_CURRENT_STEP: mark the step and go back to EXECUTE. */
export function applyStepPass(state: OrbitState, step: OrbitPlanStep | undefined, summary?: string): void {
  if (step) step.status = 'passed'
  state.commander = { last_decision: 'PASS_CURRENT_STEP', summary: summary ?? state.commander?.summary }
  state.phase = 'EXECUTE'
  state.status = 'running'
}

/** FINAL_EVALUATE says SUCCESS: the run is done. */
export function applyFinalSuccess(state: OrbitState, summary?: string): void {
  state.commander = { last_decision: 'SUCCESS', summary: summary ?? state.commander?.summary }
  state.phase = 'SUCCESS'
  state.status = 'success'
}

/** FINAL_EVALUATE says NEEDS_USER: record the decision, then pause the run. */
export function applyCommanderNeedsUser(state: OrbitState, reason: string): void {
  state.commander = { last_decision: 'NEEDS_USER', summary: state.commander?.summary }
  enterNeedsUser(state, reason)
}

export type FinalAppendOutcome = 'appended' | 'invalid' | 'budget_exhausted'

/** FINAL_EVALUATE says APPEND: append bounded new base steps, or explain why not. */
export function applyFinalAppend(state: OrbitState, decision: CommanderDecision): FinalAppendOutcome {
  const remaining = state.loop.max - state.loop.used
  const appended = normalizeAppend(decision)
  if (appended.length === 0) return 'invalid'
  if (remaining <= 0) {
    enterBudgetExhausted(state)
    return 'budget_exhausted'
  }
  for (const item of appended.slice(0, remaining)) {
    const index = state.plan.steps.filter((candidate) => isBaseStepId(candidate.id)).length
    state.plan.steps.push({
      id: `P${index}`,
      goal: item.goal,
      ...(item.capabilities ? { capabilities: item.capabilities } : {}),
      status: 'pending',
    })
  }
  state.commander = { last_decision: 'APPEND', summary: decision.summary ?? state.commander?.summary }
  state.phase = 'EXECUTE'
  state.status = 'running'
  return 'appended'
}

export interface CorrectionStepInput {
  /** The goal to insert; a strategy replacement has already been applied by the caller. */
  nextGoal: string
  /** Raw capabilities from the Commander decision; falls back to the corrected step. */
  capabilities?: unknown
}

/** CORRECT_CURRENT_STEP: insert the next correction step after the corrected one. */
export function applyCorrectionStep(state: OrbitState, step: OrbitPlanStep, input: CorrectionStepInput): void {
  const base = baseStepIdOf(step.id)
  step.status = 'needs_correction'
  const number = correctionDepthOf(step.id) + 2
  const insertAt = state.plan.steps.indexOf(step) + 1
  const correctionCapabilities = normalizeCapabilities(input.capabilities) ?? step.capabilities
  state.plan.steps.splice(insertAt, 0, {
    id: `${base}-${number}`,
    goal: input.nextGoal,
    ...(correctionCapabilities ? { capabilities: correctionCapabilities } : {}),
    status: 'pending',
  })
  state.phase = 'EXECUTE'
  state.status = 'running'
}

/** A STRATEGY_RECONSIDER attempt failed temporarily: stay resumable in EVALUATE. */
export function restoreEvaluationState(state: OrbitState, lastError?: string): void {
  state.phase = 'EVALUATE'
  state.status = 'running'
  if (lastError !== undefined) state.last_error = lastError
}

/** Mark the bounded per-base strategy challenge as consumed. */
export function markStrategyChallengeUsed(state: OrbitState, baseStepId: string): void {
  state.strategy_challenge = { base_step_id: baseStepId, used: true }
}

/** The run pauses for user guidance; callers may keep an already-recorded error. */
export function enterNeedsUser(state: OrbitState, lastError?: string): void {
  state.phase = 'NEEDS_USER'
  state.status = 'needs_user'
  if (lastError !== undefined) state.last_error = lastError
}

/** The loop budget cannot pay for more work. */
export function enterBudgetExhausted(state: OrbitState, lastError?: string): void {
  state.phase = 'BUDGET_EXHAUSTED'
  state.status = 'budget_exhausted'
  if (lastError !== undefined) state.last_error = lastError
}

/** The user closed the run. */
export function stopRun(state: OrbitState): void {
  state.phase = 'STOPPED'
  state.status = 'stopped'
}

export interface WatchdogAttemptReasons {
  /** Recorded instead of consuming a call when the per-step cap is already reached. */
  atCap: string | undefined
  /** Recorded when a new attempt is admitted. */
  attempt: string
}

/**
 * Record one Smart Watchdog attempt for a step and report whether the per-step
 * call cap was already reached. At the cap the attempt is not consumed.
 */
export function openWatchdogAttempt(state: OrbitState, stepId: string, reasons: WatchdogAttemptReasons): boolean {
  const previous = state.smart_watchdog?.step_id === stepId ? state.smart_watchdog : undefined
  const calls = previous?.calls ?? 0
  if (calls >= MAX_WATCHDOG_CALLS_PER_STEP) {
    state.smart_watchdog = {
      step_id: stepId,
      calls,
      last_decision: 'CAP_REACHED',
      last_reason: reasons.atCap,
    }
    return true
  }
  state.smart_watchdog = { step_id: stepId, calls: calls + 1, last_reason: reasons.attempt }
  return false
}

/** Record the Smart Watchdog's last verdict (or unavailability). */
export function recordWatchdogDecision(state: OrbitState, decision: string): void {
  if (state.smart_watchdog) state.smart_watchdog.last_decision = decision
}

/** Count one guard block for the current step+code pair and record it. */
export function recordGuardRecovery(state: OrbitState, stepId: string, code: GuardCode): number {
  const previous = state.guard_recovery
  const same = previous?.step_id === stepId && previous?.code === code
  const count = (same ? previous.count : 0) + 1
  state.guard_recovery = { step_id: stepId, code, count }
  return count
}

/** A new Commander outcome starts a fresh guard-recovery window. */
export function clearGuardRecovery(state: OrbitState): void {
  state.guard_recovery = undefined
}
