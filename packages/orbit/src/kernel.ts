/**
 * Deterministic Orbit domain rules.
 *
 * This is the pure rule core: it must not import DSH packages, perform IO,
 * read a clock, or use randomness. Runtime values (routes, timestamps, run ids)
 * are supplied by the supervisor, which owns orchestration and persistence.
 */

import {
  MAX_CORRECTION_DEPTH,
  DEFAULT_LOOP_BUDGET,
  AUTOMATIC_LOOP_RECOVERY_RESERVE,
  MAX_AUTOMATIC_LOOP_BUDGET,
  MAX_PLAN_STEPS,
  MAX_WATCHDOG_CALLS_PER_STEP,
  MIN_PLAN_STEPS,
  MIN_MOA_CANDIDATES,
  MAX_MOA_CANDIDATES,
  DEFAULT_MAX_MOA_STEPS,
  ORBIT_SCHEMA_VERSION,
  type CommanderDecision,
  type GuardCode,
  type OrbitCapability,
  type OrbitExecutionMode,
  type OrbitMoaPolicy,
  type OrbitPlanStep,
  type OrbitRoutes,
  type OrbitState,
  type OrbitStepResult,
} from './types.ts'

/** Capabilities a plan step may request. */
export const ORBIT_CAPABILITIES: readonly OrbitCapability[] = ['filesystem', 'shell', 'web', 'browser']

const STEP_CAPABILITIES = new Set<string>(ORBIT_CAPABILITIES)

const PLAN_STEP_ID = /^P\d+$/u

export function normalizeExecutionMode(value: unknown): OrbitExecutionMode {
  return value === 'MOA' ? 'MOA' : 'SINGLE'
}

export function normalizeMoaPolicy(policy: OrbitMoaPolicy | undefined): OrbitMoaPolicy | undefined {
  if (policy === undefined || policy.enabled !== true) return undefined
  if (!Number.isSafeInteger(policy.candidate_count) || policy.candidate_count < MIN_MOA_CANDIDATES || policy.candidate_count > MAX_MOA_CANDIDATES) {
    throw new Error(`ORBIT_MOA_CANDIDATE_COUNT_INVALID: expected ${MIN_MOA_CANDIDATES}-${MAX_MOA_CANDIDATES}`)
  }
  if (!Number.isSafeInteger(policy.max_moa_steps) || policy.max_moa_steps < 1 || policy.max_moa_steps > MAX_PLAN_STEPS) {
    throw new Error(`ORBIT_MOA_STEP_BUDGET_INVALID: expected 1-${MAX_PLAN_STEPS}`)
  }
  if (policy.candidates.length < policy.candidate_count) {
    throw new Error('ORBIT_MOA_ROUTES_INCOMPLETE: 候选模型数量不足。')
  }
  const candidates = policy.candidates.slice(0, policy.candidate_count).map((route) => structuredClone(route))
  if (candidates.some((route) => !route.provider || !route.model) || !policy.judge?.provider || !policy.judge.model) {
    throw new Error('ORBIT_MOA_ROUTES_INCOMPLETE: 候选模型或 Judge 未完整配置。')
  }
  const prices = policy.prices === undefined
    ? undefined
    : Object.fromEntries(Object.entries(policy.prices).flatMap(([key, row]) => {
        const input = Number(row?.input)
        const output = Number(row?.output)
        const cacheHit = row?.cacheHit === undefined ? undefined : Number(row.cacheHit)
        if (!Number.isFinite(input) || input < 0 || !Number.isFinite(output) || output < 0 || (cacheHit !== undefined && (!Number.isFinite(cacheHit) || cacheHit < 0))) return []
        return [[key, { input, output, ...(cacheHit === undefined ? {} : { cacheHit }) }]]
      }))
  return {
    enabled: true,
    candidate_count: policy.candidate_count,
    peer_critique: policy.peer_critique === true,
    max_moa_steps: policy.max_moa_steps || DEFAULT_MAX_MOA_STEPS,
    candidates,
    judge: structuredClone(policy.judge),
    ...(prices && Object.keys(prices).length > 0 ? { prices } : {}),
  }
}

export function assertMoaPlanWithinPolicy(plan: { steps: OrbitPlanStep[] }, policy: OrbitMoaPolicy | undefined): void {
  const moaSteps = plan.steps.filter((step) => normalizeExecutionMode(step.execution_mode) === 'MOA').length
  if (moaSteps === 0) return
  if (policy === undefined) throw new Error('ORBIT_MOA_UNAVAILABLE: 当前 Run 未启用或未完整配置 MoA。')
  if (moaSteps > policy.max_moa_steps) {
    throw new Error(`ORBIT_MOA_STEP_BUDGET_EXCEEDED: plan requests ${moaSteps}, max is ${policy.max_moa_steps}`)
  }
}

export function normalizeCapabilities(value: unknown): OrbitCapability[] | undefined {
  if (!Array.isArray(value)) return undefined
  const result: OrbitCapability[] = []
  for (const item of value) {
    if (item === 'web-api-recon') {
      for (const legacy of ['web', 'browser'] as const) if (!result.includes(legacy)) result.push(legacy)
      continue
    }
    if (typeof item !== 'string' || !STEP_CAPABILITIES.has(item)) continue
    if (!result.includes(item as OrbitCapability)) result.push(item as OrbitCapability)
  }
  if (result.length === 0) return undefined
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
    const execution_mode = normalizeExecutionMode(record.execution_mode)
    return {
      id,
      goal,
      ...(capabilities ? { capabilities } : {}),
      ...(execution_mode === 'MOA' ? { execution_mode } : {}),
      status: 'pending' as const,
    }
  })
  if (steps.some((step) => !step.goal)) {
    throw new Error('COMMANDER_PLAN_OUTPUT_INVALID: every step needs a goal')
  }
  if (new Set(steps.map((step) => step.id)).size !== steps.length) {
    throw new Error('COMMANDER_PLAN_OUTPUT_INVALID: 步骤 id 不得重复')
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

export function updateLoopBudget(state: OrbitState, budget: number): void {
  if (budget < state.loop.used) throw new Error(`ORBIT_LOOP_BUDGET_BELOW_USED: requested ${budget}, already used ${state.loop.used}`)
  state.approved_loop_count = budget
  state.loop = { used: state.loop.used, max: budget }
  state.loop_count = state.loop.used
  state.remaining_budget = Math.max(0, budget - state.loop.used)
}

/**
 * Deterministic budget for an Orbit-owned run after PLAN is known.
 * Small plans keep the historical floor of five; four/five-step plans gain two
 * bounded recovery slots, with a hard automatic ceiling of seven.
 */
export function automaticLoopBudgetForPlan(stepCount: number): number {
  if (!Number.isSafeInteger(stepCount) || stepCount < MIN_PLAN_STEPS || stepCount > MAX_PLAN_STEPS) {
    throw new Error(`ORBIT_PLAN_STEP_COUNT_INVALID: expected ${MIN_PLAN_STEPS}-${MAX_PLAN_STEPS}, got ${stepCount}`)
  }
  return Math.min(
    MAX_AUTOMATIC_LOOP_BUDGET,
    Math.max(DEFAULT_LOOP_BUDGET, stepCount + AUTOMATIC_LOOP_RECOVERY_RESERVE),
  )
}

/**
 * Expand only Orbit-owned automatic budgets. Explicit user/tool budgets and
 * old states without a recorded mode are never silently increased.
 */
export function ensureAutomaticLoopBudgetForPlan(state: OrbitState): void {
  if (state.loop_budget_mode !== 'automatic') return
  const baseSteps = state.plan.steps.filter((step) => isBaseStepId(step.id)).length
  const target = automaticLoopBudgetForPlan(baseSteps)
  if (target > state.loop.max) updateLoopBudget(state, target)
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
  execution_mode?: OrbitExecutionMode
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
          const execution_mode = normalizeExecutionMode((entry as { execution_mode?: unknown }).execution_mode)
          items.push({ goal, ...(capabilities ? { capabilities } : {}), ...(execution_mode === 'MOA' ? { execution_mode } : {}) })
        }
      }
    }
  }
  if (items.length === 0 && decision.next_step_goal?.trim()) {
    const capabilities = normalizeCapabilities(decision.next_step_capabilities)
    const execution_mode = normalizeExecutionMode(decision.next_step_execution_mode)
    items.push({ goal: decision.next_step_goal.trim(), ...(capabilities ? { capabilities } : {}), ...(execution_mode === 'MOA' ? { execution_mode } : {}) })
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
  moaPolicy?: OrbitMoaPolicy
  approvedLoopCount?: number
  maxLoops?: number
  userHardConstraints?: readonly string[]
  githubAllowed: boolean
  /** DSH Session creating the run; the only Session allowed to answer NEEDS_USER. */
  ownerSessionId?: string
}

export function createInitialState(input: InitialStateInput): OrbitState {
  const explicit = explicitLoopBudget({ approved_loop_count: input.approvedLoopCount, max_loops: input.maxLoops })
  const max = explicit ?? DEFAULT_LOOP_BUDGET
  const moaPolicy = normalizeMoaPolicy(input.moaPolicy)
  return {
    schema_version: ORBIT_SCHEMA_VERSION,
    active_run_id: input.runId,
    run_id: input.runId,
    phase: 'PLAN',
    status: 'running',
    driver_ownership: 'ACTIVE',
    state_revision: 0,
    updated_at: new Date(input.now).toISOString(),
    progress: { seq: 0, at: new Date(input.now).toISOString() },
    goal: input.goal,
    goal_hash: hashGoal(input.goal),
    preset: input.preset ?? 'orbit-lite',
    routes: structuredClone(input.routes),
    ...(moaPolicy ? { moa_policy: moaPolicy } : {}),
    loop: { used: 0, max },
    loop_budget_mode: explicit === undefined ? 'automatic' : 'explicit',
    approved_loop_count: max,
    remaining_budget: max,
    loop_count: 0,
    plan: { summary: '', steps: [] },
    step_results: [],
    changed_files: [],
    test_summary: [],
    last_error: null,
    pending_user_reply: null,
    ...(input.ownerSessionId === undefined ? {} : { owner_session_id: input.ownerSessionId }),
    user_hard_constraints: input.userHardConstraints ? [...input.userHardConstraints] : [],
    github_allowed: input.githubAllowed === true,
    interruption_retries: 0,
  }
}

/** A user answers a NEEDS_USER run: execution continues with the reply kept durable. */
export function resumeFromNeedsUser(state: OrbitState, userReply?: string): void {
  state.phase = 'EXECUTE'
  state.status = 'running'
  const reply = (userReply ?? '').trim()
  if (reply !== '') state.pending_user_reply = reply
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
    summary: `Executor 无法执行步骤 ${stepId}：BROWSER_CAPABILITY_UNAVAILABLE（配置的 Browser 工具不可用）。`,
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

export const MAX_STEP_RESULTS = 10

/** Upsert one bounded durable result without allowing evidence to drive transitions. */
export function upsertStepResult(state: OrbitState, result: OrbitStepResult): void {
  const results = state.step_results ?? []
  const index = results.findIndex((entry) => entry.step_id === result.step_id)
  if (index === -1) results.push(result)
  else results[index] = result
  state.step_results = results.slice(-MAX_STEP_RESULTS)
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

/** Record one piece of meaningful work. Heartbeat persistence alone must never call this. */
export function markMeaningfulProgress(state: OrbitState, now: number): void {
  state.progress = { seq: (state.progress?.seq ?? 0) + 1, at: new Date(now).toISOString() }
}

/** FINAL_EVALUATE says SUCCESS: enter the final audit gate, but do not close yet. */
export function applyFinalCandidate(state: OrbitState, summary?: string, finalOutput?: string): void {
  state.commander = {
    last_decision: 'SUCCESS',
    summary: summary ?? state.commander?.summary,
    ...(state.commander?.remaining_gap ? { remaining_gap: state.commander.remaining_gap } : {}),
    ...(finalOutput?.trim() ? { final_output: finalOutput.trim().slice(0, 8000) } : state.commander?.final_output ? { final_output: state.commander.final_output } : {}),
  }
  state.phase = 'FINAL_VERIFY'
  state.status = 'running'
  state.terminal_confirmation = undefined
}

/** Final Watchdog approved closure; ask the Commander for one explicit terminal signal. */
export function applyFinalAuditApproved(state: OrbitState): void {
  state.phase = 'TERMINAL_CONFIRM'
  state.status = 'running'
}

/** Final Watchdog blocked closure; return to final evaluation with the gap explicit. */
export function applyFinalAuditBlocked(state: OrbitState, reason: string): void {
  state.commander = {
    ...state.commander,
    last_decision: 'FINAL_AUDIT_BLOCKED',
    remaining_gap: reason,
  }
  state.phase = 'EVALUATE'
  state.status = 'running'
  state.current_step = undefined
  state.child = undefined
  state.last_error = reason
  state.terminal_confirmation = undefined
}

/** Record the Commander's narrow terminal signal without closing the Run. */
export function applyTerminalConfirmation(state: OrbitState, signal: 'COMPLETE' | 'NOT_COMPLETE', now: number, reason?: string): void {
  state.terminal_confirmation = {
    signal,
    at: new Date(now).toISOString(),
    ...(reason?.trim() ? { reason: reason.trim().slice(0, 500) } : {}),
  }
  if (signal === 'NOT_COMPLETE') {
    state.commander = { ...state.commander, last_decision: 'NOT_COMPLETE', ...(reason ? { remaining_gap: reason.slice(0, 500) } : {}) }
    state.phase = 'EVALUATE'
    state.status = 'running'
    state.current_step = undefined
    state.child = undefined
  }
}

/** Mechanical completion gate. Models cannot override these invariants. */
export function completionGateIssue(state: OrbitState, auditFingerprint: string, currentFingerprint: string): string | undefined {
  if (state.plan.steps.some((step) => step.status !== 'passed')) return 'ORBIT_COMPLETION_GATE_STEPS_NOT_PASSED'
  if (state.plan.steps.some((step) => step.status === 'pending' || step.status === 'running')) return 'ORBIT_COMPLETION_GATE_ACTIVE_STEP'
  if (state.child?.status === 'running' || state.role_sessions?.executor?.needs_rotation === true) return 'ORBIT_COMPLETION_GATE_EXECUTOR_ACTIVE'
  if (state.phase === 'NEEDS_USER' || state.status === 'needs_user') return 'ORBIT_COMPLETION_GATE_PENDING_USER_REPLY'
  if (state.heartbeat_watchdog?.final_audit?.verdict !== 'APPROVE_CLOSE') return 'ORBIT_COMPLETION_GATE_AUDIT_NOT_APPROVED'
  if (!auditFingerprint || auditFingerprint !== currentFingerprint) return 'ORBIT_COMPLETION_GATE_AUDIT_STALE'
  if (state.terminal_confirmation?.signal !== 'COMPLETE') return 'ORBIT_COMPLETION_GATE_TERMINAL_SIGNAL_MISSING'
  return undefined
}

/** All final gates passed: close success and clear the current error surface. */
export function applyFinalSuccess(state: OrbitState, summary?: string): void {
  state.commander = { ...state.commander, last_decision: 'SUCCESS', summary: summary ?? state.commander?.summary }
  if (state.last_error) state.recovered_error = state.last_error
  state.last_error = null
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
  const currentMoa = state.plan.steps.filter((step) => normalizeExecutionMode(step.execution_mode) === 'MOA').length
  const addedMoa = appended.filter((step) => normalizeExecutionMode(step.execution_mode) === 'MOA').length
  if (addedMoa > 0 && (state.moa_policy === undefined || currentMoa + addedMoa > state.moa_policy.max_moa_steps)) return 'invalid'
  if (remaining <= 0) {
    enterBudgetExhausted(state)
    return 'budget_exhausted'
  }
  for (const item of appended.slice(0, remaining)) {
    let index = state.plan.steps.filter((candidate) => isBaseStepId(candidate.id)).length
    while (state.plan.steps.some((candidate) => candidate.id === `P${index}`)) index += 1
    state.plan.steps.push({
      id: `P${index}`,
      goal: item.goal,
      ...(item.capabilities ? { capabilities: item.capabilities } : {}),
      ...(item.execution_mode === 'MOA' ? { execution_mode: 'MOA' as const } : {}),
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
  /** Raw execution mode; falls back to the corrected step. */
  executionMode?: unknown
}

/** CORRECT_CURRENT_STEP: insert the next correction step after the corrected one. */
export function applyCorrectionStep(state: OrbitState, step: OrbitPlanStep, input: CorrectionStepInput): void {
  const base = baseStepIdOf(step.id)
  step.status = 'needs_correction'
  const number = correctionDepthOf(step.id) + 2
  const insertAt = state.plan.steps.indexOf(step) + 1
  const correctionCapabilities = input.capabilities === undefined
    ? step.capabilities
    : normalizeCapabilities(input.capabilities)
  const correctionMode = input.executionMode === undefined
    ? normalizeExecutionMode(step.execution_mode)
    : normalizeExecutionMode(input.executionMode)
  state.plan.steps.splice(insertAt, 0, {
    id: `${base}-${number}`,
    goal: input.nextGoal,
    ...(correctionCapabilities ? { capabilities: correctionCapabilities } : {}),
    ...(correctionMode === 'MOA' ? { execution_mode: 'MOA' as const } : {}),
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
