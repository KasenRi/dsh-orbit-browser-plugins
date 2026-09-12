import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  assertCommanderDecision,
  assertStrategyDecision,
  assertTimeoutDecision,
  assertWatchdogDecision,
  assertGuardWatchdogDecision,
  baseStepIdOf,
  correctionDepthOf,
  isBaseStepId,
  normalizeCapabilities,
  normalizePlan,
  parseJsonObject,
  type EvaluationMode,
} from './decisions.ts'
import type { OrbitHost, RoleHandle, RoleRunResult, RoleToolFilter } from './host.ts'
import { truncateSafe } from './sanitize.ts'
import { OrbitStateStore } from './state-store.ts'
import {
  COMMANDER_EXTENSION_MS,
  COMMANDER_HARD_CEILING_MS,
  COMMANDER_SOFT_DEADLINE_MS,
  DEFAULT_CAPABILITIES,
  EXECUTOR_TIMEOUT_MS,
  GUARD_ESCALATION_THRESHOLD,
  GUARD_FIRST_INSTRUCTION,
  GUARD_NEEDS_USER_INSTRUCTION,
  GUARD_RECOVERY_CAP,
  GUARD_REPEAT_INSTRUCTION,
  GUARD_RETRY_INSTRUCTION,
  MAX_CORRECTION_DEPTH,
  MAX_EXECUTOR_INTERRUPT_RETRIES,
  MAX_WATCHDOG_CALLS_PER_STEP,
  WATCHDOG_TIMEOUT_MS,
  type CommanderDecision,
  type CommanderMode,
  type OrbitActionResult,
  type OrbitPlanStep,
  type OrbitState,
  type OrbitTelemetry,
  type GuardCode,
  type GuardWatchdogDecision,
  type StrategyDecision,
  type TimeoutDecision,
  type WatchdogDecision,
} from './types.ts'

export interface OrbitSupervisorConfig {
  defaultRoutes: OrbitState['routes']
  browserTools: readonly string[]
  commanderReadOnlyTools: readonly string[]
  watchdogTools: readonly string[]
  executorTools: readonly string[]
  executorTimeoutMs?: number
  watchdogTimeoutMs?: number
}

export interface OrbitRunInput {
  goal?: string
  preset?: string
  approved_loop_count?: number
  max_loops?: number
  user_hard_constraints?: string[]
  github_allowed?: boolean
  run_id?: string
  timeout_ms?: number
}

export interface GuardBlockOutcome {
  disposition: 'block_continue' | 'block_needs_user'
  code: GuardCode
  count: number
  watchdog_calls: number
  instruction: string
}

type SupervisedResult =
  | { kind: 'output'; output: string }
  | { kind: 'interrupted'; reason: string }
  | { kind: 'needs_user'; reason: string }

type StrategyOutcome =
  | { kind: 'keep' }
  | { kind: 'replace'; replacementGoal: string }
  | { kind: 'needs_user'; reason: string }
  | { kind: 'interrupted'; reason: string }

interface AuxRoleRequest {
  role: 'watchdog' | 'commander'
  label: string
  prompt: string
  signal?: AbortSignal
  timeoutMs?: number
}

const COMMANDER_PLAN_PROMPT = (goal: string, constraints: readonly string[]) => `You are the Orbit Commander. Produce the smallest set of 2-5 logical engineering steps for this goal.
Return ONLY JSON: {"summary":"...","steps":[{"id":"P0","goal":"...","capabilities":[]}]}
Rules: ordinary engineering steps must omit capabilities. Add capability "browser" only when the step must drive a real web page, and "web-api-recon" when it must analyze captured network/API traffic. Keep it minimal.
Goal: ${goal}
Hard constraints: ${constraints.join('; ') || 'none'}`

const COMMANDER_STEP_PROMPT = (
  goal: string,
  step: OrbitPlanStep,
  evidence: string,
  state: OrbitState,
) => `You are the Orbit Commander doing STEP_EVALUATE. Verify the real project state; do not trust the Executor summary blindly.
Allowed decisions ONLY: PASS_CURRENT_STEP | CORRECT_CURRENT_STEP | NEEDS_USER.
- CORRECT_CURRENT_STEP requires next_step_goal (optional next_step_capabilities).
Return ONLY JSON: {"decision":"...","reason":"...","next_step_goal":"...","next_step_capabilities":[]}
Original goal: ${goal}
Current step ${step.id}: ${step.goal}
Iteration counters: loop ${state.loop.used}/${state.loop.max}
Executor evidence:
${evidence}`

const COMMANDER_FINAL_PROMPT = (goal: string, plan: OrbitState['plan'], evidence: string, state: OrbitState) =>
  `You are the Orbit Commander doing FINAL_EVALUATE. All planned steps are done. Decide whether the original goal is truly satisfied against the real project state.
Allowed decisions ONLY: SUCCESS | APPEND | NEEDS_USER.
- APPEND requires next_steps (array) or next_step_goal; appends are bounded by the remaining loop budget.
Return ONLY JSON: {"decision":"...","summary":"...","next_steps":[{"goal":"...","capabilities":[]}]}
Original goal: ${goal}
Plan summary: ${plan.summary}
Steps: ${plan.steps.map((step) => `${step.id}:${step.goal}[${step.status}]`).join('; ')}
Loop: ${state.loop.used}/${state.loop.max}
Evidence:
${evidence}`

const COMMANDER_STRATEGY_PROMPT = (goal: string, base: string, challenge: string, state: OrbitState) =>
  `You are the Orbit Commander reconsidering strategy after a repeated correction on ${base} (STRATEGY_RECONSIDER).
Allowed decisions ONLY: KEEP_APPROACH | REPLACE_CURRENT_STEP | NEEDS_USER.
- REPLACE_CURRENT_STEP requires replacement_goal.
Return ONLY JSON: {"decision":"...","reason":"...","replacement_goal":"..."}
Goal: ${goal}
Loop: ${state.loop.used}/${state.loop.max}
Watchdog challenge: ${challenge}`

const WATCHDOG_RUNTIME_PROMPT = (step: OrbitPlanStep, reason: string, telemetry: OrbitTelemetry | undefined) =>
  `You are the Orbit Smart Watchdog doing RUNTIME_DIAGNOSE. Diagnose only the current runtime anomaly. Do not review code quality.
Allowed decisions ONLY: RESUME_CHILD | RESTART_STEP | NEEDS_USER | RUNTIME_BUG.
Return ONLY JSON: {"decision":"...","reason":"..."}
Failed step ${step.id}: ${step.goal}
Runtime anomaly: ${reason}
Telemetry: ${JSON.stringify(telemetry ?? {})}`

const WATCHDOG_STRATEGY_PROMPT = (step: OrbitPlanStep, reason: string, state: OrbitState) =>
  `You are the Orbit Smart Watchdog doing STRATEGY_CHALLENGE. Ask: is the current approach tunnel vision? Is this blocker truly required? Is there a simpler route?
Return ONLY JSON: {"question":"..."}
Step ${step.id}: ${step.goal}
Repeated correction: ${reason}
Loop: ${state.loop.used}/${state.loop.max}`

const WATCHDOG_GUARD_PROMPT = (code: GuardCode, count: number, stepId: string) =>
  `You are the Orbit Smart Watchdog doing GUARD_ESCALATION. A safety guard blocked a tool ${count} times.
Allowed decisions ONLY: RETRY_DIFFERENTLY | NEEDS_USER.
Return ONLY JSON: {"decision":"...","instruction":"..."}
Guard code: ${code}
Step: ${stepId}`

const WATCHDOG_TIMEOUT_PROMPT = (mode: CommanderMode, elapsed: number, extensions: number, telemetry: OrbitTelemetry | undefined) =>
  `You are the Orbit Smart Watchdog doing COMMANDER_TIMEOUT_REVIEW. The Commander has run ${elapsed}ms with ${extensions} extension(s).
Allowed decisions ONLY: EXTEND | INTERRUPT | NEEDS_USER.
Return ONLY JSON: {"decision":"...","reason":"..."}
Mode: ${mode}
Telemetry: ${JSON.stringify(telemetry ?? {})}`

type CommanderOutcome =
  | { kind: 'decision'; decision: CommanderDecision }
  | { kind: 'interrupted'; reason: string }
  | { kind: 'needs_user'; reason: string }

export class OrbitSupervisor {
  private readonly store: OrbitStateStore
  private readonly host: OrbitHost
  private readonly config: OrbitSupervisorConfig

  constructor(store: OrbitStateStore, host: OrbitHost, config: OrbitSupervisorConfig) {
    this.store = store
    this.host = host
    this.config = config
  }

  private now(): number {
    return this.host.now()
  }

  createState(input: OrbitRunInput): OrbitState {
    const runId = typeof input.run_id === 'string' && input.run_id.length > 0 ? input.run_id : randomUUID()
    const max = this.explicitLoopBudget(input) ?? this.estimateLoopCount(input.goal ?? '')
    const goal = (input.goal ?? '').trim()
    return {
      schema_version: 2,
      active_run_id: runId,
      run_id: runId,
      phase: 'PLAN',
      status: 'running',
      driver_ownership: 'ACTIVE',
      state_revision: 0,
      updated_at: new Date(this.now()).toISOString(),
      goal,
      goal_hash: hashGoal(goal),
      preset: input.preset ?? 'orbit-lite',
      routes: this.config.defaultRoutes,
      loop: { used: 0, max },
      approved_loop_count: max,
      remaining_budget: max,
      loop_count: 0,
      plan: { summary: '', steps: [] },
      changed_files: [],
      test_summary: [],
      last_error: null,
      user_hard_constraints: input.user_hard_constraints ? [...input.user_hard_constraints] : [],
      github_allowed: input.github_allowed === true,
      interruption_retries: 0,
    }
  }

  private explicitLoopBudget(input: OrbitRunInput): number | undefined {
    const raw = input.approved_loop_count ?? input.max_loops
    if (raw === undefined) return undefined
    if (!Number.isSafeInteger(raw) || raw <= 0) throw new Error('ORBIT_LOOP_BUDGET_INVALID: approved_loop_count must be a positive integer')
    if (raw > 10) throw new Error('ORBIT_LOOP_BUDGET_INVALID: approved_loop_count above 10 requires an explicit execution request')
    return raw
  }

  estimateLoopCount(goal: string): number {
    const text = goal.toLowerCase()
    if (/critical|migrate|migration|production|架构|重构/.test(text)) return 6
    if (/integration|联调|ui|high/.test(text)) return 4
    if (/feature|多文件|multi-file/.test(goal)) return 3
    if (/bug|fix|test/.test(text)) return 2
    return 1
  }

  private updateLoopBudget(state: OrbitState, budget: number): void {
    if (budget < state.loop.used) throw new Error(`ORBIT_LOOP_BUDGET_BELOW_USED: requested ${budget}, already used ${state.loop.used}`)
    state.approved_loop_count = budget
    state.loop = { used: state.loop.used, max: budget }
    state.loop_count = state.loop.used
    state.remaining_budget = Math.max(0, budget - state.loop.used)
  }

  async bootstrap(input: OrbitRunInput, signal?: AbortSignal): Promise<OrbitActionResult> {
    const requestedGoal = (input.goal ?? '').trim()
    let state = this.store.readState()
    const raw = this.store.readRawState()
    const legacy = raw !== null && raw['schema_version'] !== 2

    if (legacy && requestedGoal) {
      state = this.store.writeState(this.createState(input))
    } else if (!state) {
      if (!requestedGoal) return { ok: false, action: 'run', message: 'ORBIT_GOAL_REQUIRED: provide a goal to start a run.' }
      state = this.store.writeState(this.createState(input))
    } else if (input.run_id && input.run_id !== state.run_id && !legacy) {
      return { ok: false, action: 'run', message: `ORBIT_RUN_NOT_FOUND: ${input.run_id}` }
    }

    if (['SUCCESS', 'STOPPED', 'BUDGET_EXHAUSTED'].includes(state.phase) && requestedGoal) {
      state = this.store.writeState(this.createState(input))
    }
    if (!legacy && requestedGoal && state.goal && state.goal !== requestedGoal) {
      return {
        ok: false,
        action: 'run',
        run_id: state.run_id,
        message: 'ORBIT_ACTIVE_RUN_EXISTS: current Lite run owns this project; resume it or stop it before starting a different goal.',
      }
    }
    if (state.phase === 'NEEDS_USER' && requestedGoal) {
      state.status = 'running'
      state.phase = 'EXECUTE'
      this.store.writeState(state)
    }
    return this.run(state, signal)
  }

  async run(state: OrbitState, signal?: AbortSignal): Promise<OrbitActionResult> {
    if (signal?.aborted) return this.result(state, false, 'ORBIT_ABORTED')
    const projectDir = join(this.store.stateDir, '..')
    const competitors = await this.host.otherMutationDrivers(projectDir)
    if (competitors.length > 0) {
      return {
        ok: false,
        action: 'run',
        run_id: state.run_id,
        phase: state.phase,
        status: state.status,
        message: `ORBIT_MUTATION_DRIVER_CONFLICT: ${competitors.join(', ')} already owns mutation in this workspace.`,
      }
    }

    if (state.phase === 'NEEDS_USER') return this.result(state, true, 'ORBIT_AWAITING_USER')
    if (state.phase === 'SUCCESS') return this.result(state, true)
    if (state.phase === 'STOPPED') return this.result(state, true)
    if (state.phase === 'BUDGET_EXHAUSTED') return this.result(state, true)

    if (state.plan.steps.length === 0 && state.phase === 'PLAN') {
      const planOutcome = await this.makePlan(state, signal)
      if (planOutcome) return planOutcome
    }

    if (state.phase === 'EVALUATE' && state.child?.status === 'completed' && state.current_step) {
      const step = state.plan.steps.find((candidate) => candidate.id === state.current_step?.id)
      if (!step) {
        state.phase = 'NEEDS_USER'
        state.status = 'needs_user'
        state.last_error = 'EVALUATE_STEP_MISSING'
        this.store.writeState(state)
        return this.result(state, false)
      }
      const outcome = await this.commanderEvaluate(state, step, false, signal)
      const applied = await this.applyCommanderOutcome(state, outcome, step, false, signal)
      if (applied) return applied
      return this.run(state, signal)
    }

    const step =
      state.plan.steps.find((candidate) => candidate.status === 'running') ??
      state.plan.steps.find((candidate) => candidate.status === 'pending')

    if (!step) {
      const outcome = await this.commanderEvaluate(state, undefined, true, signal)
      const applied = await this.applyCommanderOutcome(state, outcome, undefined, true, signal)
      if (applied) return applied
      return this.run(state, signal)
    }

    if (state.loop.used >= state.loop.max) {
      state.phase = 'BUDGET_EXHAUSTED'
      state.status = 'budget_exhausted'
      state.last_error = 'LOOP_BUDGET_EXHAUSTED'
      this.store.writeState(state)
      return this.result(state, false)
    }

    step.status = 'running'
    state.current_step = { id: step.id, attempt: state.current_step?.id === step.id ? state.current_step.attempt + 1 : 1 }
    state.phase = 'EXECUTE'
    state.status = 'running'
    this.store.writeState(state)

    const executed = await this.executeStep(state, step, signal)
    if (executed.done) return this.result(state, executed.ok, executed.message)
    return this.run(state, signal)
  }

  // ── tool scoping ───────────────────────────────────────────────────────────

  /**
   * Build an allow-filter from configured names, keeping only tools that are
   * actually registered (an unknown name makes `tools.restrict()` fail).
   */
  private toolAllow(names: readonly string[], label: string): RoleToolFilter {
    const allowed = names.filter((name) => this.host.hasTool(name))
    if (allowed.length === 0) {
      throw new Error(`ORBIT_TOOL_FILTER_EMPTY: none of [${names.join(', ')}] are registered for ${label}`)
    }
    return { allow: allowed }
  }

  // ── commander supervised path ──────────────────────────────────────────────

  private async makePlan(state: OrbitState, signal?: AbortSignal): Promise<OrbitActionResult | undefined> {
    const outcome = await this.runCommander(
      state,
      'PLAN',
      COMMANDER_PLAN_PROMPT(state.goal, state.user_hard_constraints),
      signal,
    )
    if (outcome.kind === 'needs_user') return this.setNeedsUser(state, outcome.reason)
    if (outcome.kind === 'interrupted') {
      state.phase = 'PLAN'
      state.status = 'running'
      state.last_error = truncateSafe(outcome.reason, 500)
      this.store.writeState(state)
      return this.result(state, false, outcome.reason)
    }
    try {
      const plan = normalizePlan(parseJsonObject<{ summary?: unknown; steps?: unknown }>(outcome.output, 'COMMANDER_PLAN'))
      state.plan = plan
      state.phase = 'EXECUTE'
      state.status = 'running'
      this.store.writeState(state)
      return undefined
    } catch (error) {
      const reason = truncateSafe(error instanceof Error ? error.message : String(error), 500)
      state.phase = 'PLAN'
      state.status = 'running'
      state.last_error = reason
      this.store.writeState(state)
      return this.result(state, false, reason)
    }
  }

  private async commanderEvaluate(
    state: OrbitState,
    step: OrbitPlanStep | undefined,
    final: boolean,
    signal?: AbortSignal,
  ): Promise<CommanderOutcome> {
    const mode: EvaluationMode = final ? 'FINAL_EVALUATE' : 'STEP_EVALUATE'
    const evidence = state.commander?.summary ?? state.last_error ?? 'no evidence recorded'
    const prompt = final
      ? COMMANDER_FINAL_PROMPT(state.goal, state.plan, evidence, state)
      : COMMANDER_STEP_PROMPT(state.goal, step as OrbitPlanStep, evidence, state)
    const outcome = await this.runCommander(state, mode, prompt, signal)
    if (outcome.kind === 'needs_user') return { kind: 'needs_user', reason: outcome.reason }
    if (outcome.kind === 'interrupted') return { kind: 'interrupted', reason: outcome.reason }
    try {
      const decision = parseJsonObject<CommanderDecision>(outcome.output, 'COMMANDER_EVALUATION')
      return { kind: 'decision', decision: assertCommanderDecision(decision, mode) }
    } catch (error) {
      // Invalid/temporary output is recoverable; it must not become NEEDS_USER.
      return { kind: 'interrupted', reason: truncateSafe(error instanceof Error ? error.message : String(error), 500) }
    }
  }

  /**
   * The single adaptive Commander runner for PLAN, STEP_EVALUATE, FINAL_EVALUATE
   * and STRATEGY_RECONSIDER. 360s/600s soft reviews, 840s deterministic ceiling;
   * EXTEND always keeps the same child.
   */
  private async runCommander(
    state: OrbitState,
    mode: CommanderMode,
    prompt: string,
    signal?: AbortSignal,
  ): Promise<SupervisedResult> {
    const startedAt = this.now()
    let handle: RoleHandle
    try {
      handle = await this.host.startRole({
        role: 'commander',
        label: `commander-${mode.toLowerCase()}`,
        prompt,
        route: state.routes.commander,
        toolFilter: this.toolAllow(this.config.commanderReadOnlyTools, `commander ${mode}`),
        ...(signal ? { signal } : {}),
      })
    } catch (error) {
      return { kind: 'interrupted', reason: truncateSafe(error instanceof Error ? error.message : String(error), 500) }
    }

    try {
      for (let extensions = 0; ; ) {
        const deadline =
          extensions === 0
            ? COMMANDER_SOFT_DEADLINE_MS
            : extensions === 1
              ? COMMANDER_SOFT_DEADLINE_MS + COMMANDER_EXTENSION_MS
              : COMMANDER_HARD_CEILING_MS
        const remaining = Math.max(0, deadline - (this.now() - startedAt))
        const raced = await this.raceWithSleep(handle.result, remaining, signal)
        if (raced.kind === 'work') {
          if (raced.value.interrupted) return { kind: 'interrupted', reason: raced.value.reason ?? `${mode}_INTERRUPTED` }
          return { kind: 'output', output: raced.value.output }
        }
        if (raced.kind === 'aborted' || signal?.aborted) {
          await this.cancelHandle(handle, 'ORBIT_ABORTED')
          return { kind: 'interrupted', reason: 'ORBIT_ABORTED' }
        }
        if (extensions >= 2) {
          await this.cancelHandle(handle, 'COMMANDER_HARD_TIMEOUT')
          return { kind: 'interrupted', reason: 'COMMANDER_HARD_TIMEOUT' }
        }
        const review = await this.commanderTimeoutReview(state, mode, this.now() - startedAt, extensions, handle, signal)
        if (review.decision === 'EXTEND') {
          extensions += 1
          continue
        }
        await this.cancelHandle(handle, review.decision === 'NEEDS_USER' ? 'COMMANDER_NEEDS_USER' : 'COMMANDER_TIMEOUT_INTERRUPTED')
        if (review.decision === 'NEEDS_USER') return { kind: 'needs_user', reason: review.reason ?? 'COMMANDER_TIMEOUT_NEEDS_USER' }
        return { kind: 'interrupted', reason: 'COMMANDER_TIMEOUT_INTERRUPTED' }
      }
    } finally {
      await this.disposeHandle(handle)
    }
  }

  private async commanderTimeoutReview(
    state: OrbitState,
    mode: CommanderMode,
    elapsed: number,
    extensions: number,
    commanderHandle: RoleHandle,
    signal?: AbortSignal,
  ): Promise<TimeoutDecision> {
    // Telemetry must describe the *current* Commander child, never a past Executor.
    const telemetry = await commanderHandle.runtimeSnapshot?.()
    const result = await this.runAuxRole(state, {
      role: 'watchdog',
      label: 'watchdog-commander-timeout',
      prompt: WATCHDOG_TIMEOUT_PROMPT(mode, elapsed, extensions, telemetry),
      ...(signal ? { signal } : {}),
    })
    if (!result || result.interrupted) {
      return { decision: extensions === 0 ? 'EXTEND' : 'INTERRUPT', reason: 'Smart Watchdog unavailable' }
    }
    try {
      return assertTimeoutDecision(parseJsonObject<TimeoutDecision>(result.output, 'COMMANDER_TIMEOUT_WATCHDOG'))
    } catch {
      return { decision: extensions === 0 ? 'EXTEND' : 'INTERRUPT', reason: 'Smart Watchdog invalid output' }
    }
  }

  // ── executor runtime ───────────────────────────────────────────────────────

  private async executeStep(
    state: OrbitState,
    step: OrbitPlanStep,
    signal?: AbortSignal,
  ): Promise<{ done: boolean; ok: boolean; message?: string }> {
    const capabilities = step.capabilities ?? []
    if (capabilities.includes('browser') && !this.host.hasTool(this.config.browserTools[0] ?? 'agent_browser')) {
      state.child = { status: 'completed' }
      state.last_error = 'BROWSER_CAPABILITY_UNAVAILABLE'
      state.commander = {
        last_decision: state.commander?.last_decision,
        summary: `Executor could not run step ${step.id}: BROWSER_CAPABILITY_UNAVAILABLE (agent_browser tool is not registered).`,
      }
      state.phase = 'EVALUATE'
      this.store.writeState(state)
      return { done: false, ok: false }
    }

    let toolFilter: RoleToolFilter
    try {
      const capabilityTools = capabilities.includes('browser') ? [...this.config.browserTools] : []
      toolFilter = this.toolAllow([...this.config.executorTools, ...capabilityTools], `executor ${step.id}`)
    } catch (error) {
      const reason = truncateSafe(error instanceof Error ? error.message : String(error), 500)
      state.phase = 'NEEDS_USER'
      state.status = 'needs_user'
      state.last_error = reason
      this.store.writeState(state)
      return { done: true, ok: false, message: reason }
    }

    let handle: RoleHandle
    try {
      handle = await this.host.startRole({
        role: 'executor',
        label: `executor-${step.id}`,
        prompt: this.executorPrompt(state, step),
        route: state.routes.executor,
        toolFilter,
        capabilities,
        ...(signal ? { signal } : {}),
        ...(state.child?.id && state.child.status === 'interrupted' ? { resumeOf: state.child.id } : {}),
      })
    } catch (error) {
      const reason = truncateSafe(error instanceof Error ? error.message : String(error), 500)
      state.last_error = reason
      state.phase = 'NEEDS_USER'
      state.status = 'needs_user'
      this.store.writeState(state)
      return { done: true, ok: false, message: reason }
    }

    const result = await this.awaitExecutor(handle, signal)

    if (result.interrupted) {
      state.child = { ...(result.childId ? { id: result.childId } : {}), status: 'interrupted' }
      state.last_error = truncateSafe(result.reason ?? 'EXECUTOR_INTERRUPTED', 500)
      state.phase = 'EXECUTE'
      state.status = 'running'
      const retries = state.interruption_retries + 1
      state.interruption_retries = retries
      this.store.writeState(state)

      if (signal?.aborted) return { done: true, ok: false, message: 'ORBIT_ABORTED' }
      if (result.reason === 'USER_HARD_SCOPE_VIOLATION') {
        state.phase = 'NEEDS_USER'
        state.status = 'needs_user'
        this.store.writeState(state)
        return { done: true, ok: false, message: 'USER_HARD_SCOPE_VIOLATION' }
      }
      const recovery = await this.runtimeWatchdog(state, step, result, retries, signal)
      if (recovery === 'needs_user') {
        state.phase = 'NEEDS_USER'
        state.status = 'needs_user'
        this.store.writeState(state)
        return { done: true, ok: false, message: state.last_error ?? undefined }
      }
      if (recovery === 'resume' && result.childId) {
        state.child = { id: result.childId, status: 'interrupted' }
        this.store.writeState(state)
        return { done: false, ok: false }
      }
      if (recovery === 'restart') {
        await this.cancelHandle(handle, 'ORBIT_RESTART_STEP')
        await this.disposeHandle(handle)
        state.child = undefined
        state.interruption_retries = 0
        this.store.writeState(state)
        return { done: false, ok: false }
      }
      if (retries >= MAX_EXECUTOR_INTERRUPT_RETRIES) {
        state.phase = 'NEEDS_USER'
        state.status = 'needs_user'
        state.last_error = `EXECUTOR_INTERRUPTED: ${state.last_error ?? ''}`
        this.store.writeState(state)
        return { done: true, ok: false, message: state.last_error ?? undefined }
      }
      return { done: false, ok: false }
    }

    state.child = { ...(result.childId ? { id: result.childId } : {}), status: 'completed' }
    state.interruption_retries = 0
    state.loop = { used: state.loop.used + 1, max: state.loop.max }
    state.loop_count = state.loop.used
    state.remaining_budget = Math.max(0, state.loop.max - state.loop.used)
    state.changed_files = result.changedFiles ?? this.host.changedFiles(join(this.store.stateDir, '..'))
    state.test_summary = result.testSummary ?? []
    state.last_error = null
    state.commander = {
      last_decision: state.commander?.last_decision,
      summary: truncateSafe(result.output, 2000),
    }
    state.phase = 'EVALUATE'
    state.status = 'running'
    this.store.writeState(state)
    await this.disposeHandle(handle)
    return { done: false, ok: false }
  }

  /** Deterministic executor runtime timeout; a timeout does not destroy the child. */
  private async awaitExecutor(handle: RoleHandle, signal?: AbortSignal): Promise<RoleRunResult> {
    const timeoutMs = this.config.executorTimeoutMs ?? EXECUTOR_TIMEOUT_MS
    const raced = await this.raceWithSleep(handle.result, timeoutMs, signal)
    if (raced.kind === 'work') return raced.value
    const telemetry = await handle.runtimeSnapshot?.()
    return {
      ...(handle.childId ? { childId: handle.childId } : {}),
      output: '',
      interrupted: true,
      reason: raced.kind === 'aborted' ? 'ORBIT_ABORTED' : 'EXECUTOR_TIMEOUT',
      ...(telemetry ? { telemetry } : {}),
    }
  }

  private executorPrompt(state: OrbitState, step: OrbitPlanStep): string {
    const lines = [
      'You are the Orbit Executor. Implement exactly the current step with real tools and real verification.',
      `Current step ${step.id}: ${step.goal}`,
      `Working directory: ${join(this.store.stateDir, '..')}`,
      `Hard constraints: ${state.user_hard_constraints.join('; ') || 'none'}`,
    ]
    if ((step.capabilities ?? []).length > 0) lines.push(`Capabilities: ${(step.capabilities ?? []).join(', ')}`)
    lines.push('Return a compact evidence summary: what changed, commands/tests run, and residual risks.')
    return lines.join('\n')
  }

  // ── decision application ───────────────────────────────────────────────────

  private async applyCommanderOutcome(
    state: OrbitState,
    outcome: CommanderOutcome,
    step: OrbitPlanStep | undefined,
    final: boolean,
    signal?: AbortSignal,
  ): Promise<OrbitActionResult | undefined> {
    state.guard_recovery = undefined

    if (outcome.kind === 'interrupted') {
      // Recoverable: the run stops and a later resume retries the same phase.
      state.last_error = truncateSafe(outcome.reason, 500)
      this.store.writeState(state)
      return this.result(state, false, outcome.reason)
    }
    if (outcome.kind === 'needs_user') return this.setNeedsUser(state, outcome.reason)
    const decision = outcome.decision

    if (decision.decision === 'NEEDS_USER') {
      state.commander = { last_decision: decision.decision, summary: state.commander?.summary }
      return this.setNeedsUser(state, decision.reason ?? 'COMMANDER_NEEDS_USER')
    }

    if (decision.decision === 'SUCCESS') {
      state.phase = 'SUCCESS'
      state.status = 'success'
      state.commander = { last_decision: decision.decision, summary: decision.summary ?? state.commander?.summary }
      this.store.writeState(state)
      return this.result(state, true)
    }

    if (decision.decision === 'PASS_CURRENT_STEP') {
      if (step) step.status = 'passed'
      state.commander = { last_decision: decision.decision, summary: decision.summary ?? state.commander?.summary }
      state.phase = 'EXECUTE'
      state.status = 'running'
      this.store.writeState(state)
      return undefined
    }

    if (decision.decision === 'CORRECT_CURRENT_STEP') {
      return this.applyCorrection(state, step as OrbitPlanStep, decision, signal)
    }

    if (decision.decision === 'APPEND') {
      const remaining = state.loop.max - state.loop.used
      const appended = this.normalizeAppend(decision)
      if (appended.length === 0) return this.setNeedsUser(state, 'COMMANDER_EVALUATION_OUTPUT_INVALID: append needs next_steps or next_step_goal')
      if (remaining <= 0) {
        state.phase = 'BUDGET_EXHAUSTED'
        state.status = 'budget_exhausted'
        this.store.writeState(state)
        return this.result(state, false)
      }
      for (const item of appended.slice(0, remaining)) {
        const index = state.plan.steps.filter((candidate) => isBaseStepId(candidate.id)).length
        state.plan.steps.push({ id: `P${index}`, goal: item.goal, ...(item.capabilities ? { capabilities: item.capabilities } : {}), status: 'pending' })
      }
      state.commander = { last_decision: decision.decision, summary: decision.summary ?? state.commander?.summary }
      state.phase = 'EXECUTE'
      state.status = 'running'
      this.store.writeState(state)
      return undefined
    }

    // FINAL_EVALUATE must not return PASS/CORRECT; assertCommanderDecision already rejects it.
    return this.setNeedsUser(state, 'COMMANDER_FINAL_DECISION_INVALID')
  }

  private setNeedsUser(state: OrbitState, reason: string): OrbitActionResult {
    state.phase = 'NEEDS_USER'
    state.status = 'needs_user'
    state.last_error = truncateSafe(reason, 500)
    this.store.writeState(state)
    return this.result(state, false)
  }

  private normalizeAppend(decision: CommanderDecision): Array<{ goal: string; capabilities?: OrbitPlanStep['capabilities'] }> {
    const items: Array<{ goal: string; capabilities?: OrbitPlanStep['capabilities'] }> = []
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

  private async applyCorrection(
    state: OrbitState,
    step: OrbitPlanStep,
    decision: CommanderDecision,
    signal?: AbortSignal,
  ): Promise<OrbitActionResult | undefined> {
    if (!step || !decision.next_step_goal) {
      return this.setNeedsUser(state, 'COMMANDER_EVALUATION_OUTPUT_INVALID: correction needs next_step_goal')
    }
    const base = baseStepIdOf(step.id)
    const correctionDepth = correctionDepthOf(step.id)
    const remaining = Math.max(0, state.loop.max - state.loop.used)
    const reservedForLaterStages = state.plan.steps.filter((candidate) => isBaseStepId(candidate.id) && candidate.status === 'pending').length

    if (correctionDepth >= MAX_CORRECTION_DEPTH) {
      state.last_error = 'CORRECTION_LIMIT_REACHED'
      return this.setNeedsUser(state, 'CORRECTION_LIMIT_REACHED')
    }
    if (remaining <= reservedForLaterStages) {
      state.last_error = 'LOOP_BUDGET_RESERVED_FOR_LATER_STEPS'
      return this.setNeedsUser(state, 'LOOP_BUDGET_RESERVED_FOR_LATER_STEPS')
    }

    let nextGoal = decision.next_step_goal
    if (correctionDepth === 1 && state.strategy_challenge?.base_step_id !== base) {
      const reconsider = await this.strategyChallenge(state, base, step, decision.reason ?? 'repeated correction', signal)
      if (reconsider.kind === 'needs_user') return this.setNeedsUser(state, reconsider.reason)
      if (reconsider.kind === 'interrupted') {
        // Temporary failure: keep the run resumable and do NOT consume the challenge.
        state.phase = 'EVALUATE'
        state.status = 'running'
        state.last_error = truncateSafe(reconsider.reason, 500)
        this.store.writeState(state)
        return this.result(state, false, reconsider.reason)
      }
      if (reconsider.kind === 'replace') nextGoal = reconsider.replacementGoal
    }

    step.status = 'needs_correction'
    const number = correctionDepth + 2
    const insertAt = state.plan.steps.indexOf(step) + 1
    const correctionCapabilities = normalizeCapabilities(decision.next_step_capabilities) ?? step.capabilities
    state.plan.steps.splice(insertAt, 0, {
      id: `${base}-${number}`,
      goal: nextGoal,
      ...(correctionCapabilities ? { capabilities: correctionCapabilities } : {}),
      status: 'pending',
    })
    state.phase = 'EXECUTE'
    state.status = 'running'
    this.store.writeState(state)
    return undefined
  }

  private async strategyChallenge(
    state: OrbitState,
    base: string,
    step: OrbitPlanStep,
    reason: string,
    signal?: AbortSignal,
  ): Promise<StrategyOutcome> {
    const challengeResult = await this.runAuxRole(state, {
      role: 'watchdog',
      label: 'watchdog-strategy',
      prompt: WATCHDOG_STRATEGY_PROMPT(step, reason, state),
      ...(signal ? { signal } : {}),
    })
    if (!challengeResult || challengeResult.interrupted) {
      return { kind: 'interrupted', reason: 'SMART_WATCHDOG_UNAVAILABLE' }
    }
    let challenge = ''
    try {
      const parsed = parseJsonObject<{ question?: unknown }>(challengeResult.output, 'SMART_WATCHDOG_STRATEGY')
      challenge = String(parsed.question ?? '').trim()
    } catch (error) {
      return { kind: 'interrupted', reason: truncateSafe(error instanceof Error ? error.message : String(error), 500) }
    }
    if (!challenge) return { kind: 'interrupted', reason: 'SMART_WATCHDOG_STRATEGY_OUTPUT_INVALID: question is required' }

    const outcome = await this.runCommander(
      state,
      'STRATEGY_RECONSIDER',
      COMMANDER_STRATEGY_PROMPT(state.goal, base, challenge, state),
      signal,
    )
    if (outcome.kind === 'needs_user') return { kind: 'needs_user', reason: outcome.reason }
    if (outcome.kind === 'interrupted') return { kind: 'interrupted', reason: outcome.reason }
    try {
      const decision = assertStrategyDecision(parseJsonObject<StrategyDecision>(outcome.output, 'COMMANDER_STRATEGY'))
      if (decision.decision === 'NEEDS_USER') return { kind: 'needs_user', reason: decision.reason ?? 'COMMANDER_STRATEGY_NEEDS_USER' }
      state.strategy_challenge = { base_step_id: base, used: true }
      if (decision.decision === 'REPLACE_CURRENT_STEP') return { kind: 'replace', replacementGoal: decision.replacement_goal as string }
      return { kind: 'keep' }
    } catch (error) {
      return { kind: 'interrupted', reason: truncateSafe(error instanceof Error ? error.message : String(error), 500) }
    }
  }

  private async runtimeWatchdog(
    state: OrbitState,
    step: OrbitPlanStep,
    result: RoleRunResult,
    retries: number,
    signal?: AbortSignal,
  ): Promise<'resume' | 'restart' | 'needs_user' | 'fallback'> {
    const previous = state.smart_watchdog?.step_id === step.id ? state.smart_watchdog : undefined
    const calls = previous?.calls ?? 0
    if (calls >= MAX_WATCHDOG_CALLS_PER_STEP) {
      state.smart_watchdog = { step_id: step.id, calls, last_decision: 'CAP_REACHED', last_reason: state.last_error?.slice(0, 500) }
      this.store.writeState(state)
      return 'needs_user'
    }
    state.smart_watchdog = {
      step_id: step.id,
      calls: calls + 1,
      last_reason: truncateSafe(result.reason ?? state.last_error ?? '', 500),
    }
    this.store.writeState(state)

    const watchdogResult = await this.runAuxRole(state, {
      role: 'watchdog',
      label: 'watchdog-runtime',
      prompt: WATCHDOG_RUNTIME_PROMPT(step, result.reason ?? 'runtime failure', result.telemetry),
      ...(signal ? { signal } : {}),
    })
    if (!watchdogResult || watchdogResult.interrupted) {
      state.smart_watchdog.last_decision = 'UNAVAILABLE'
      this.store.writeState(state)
      return 'fallback'
    }

    let diagnosis: WatchdogDecision
    try {
      diagnosis = assertWatchdogDecision(parseJsonObject<WatchdogDecision>(watchdogResult.output, 'SMART_WATCHDOG_RUNTIME'))
    } catch {
      state.smart_watchdog.last_decision = 'UNAVAILABLE'
      this.store.writeState(state)
      return 'fallback'
    }

    state.smart_watchdog.last_decision = diagnosis.decision
    this.store.writeState(state)

    if (diagnosis.decision === 'NEEDS_USER' || diagnosis.decision === 'RUNTIME_BUG') return 'needs_user'
    if (diagnosis.decision === 'RESUME_CHILD') {
      return result.childId && retries < MAX_EXECUTOR_INTERRUPT_RETRIES ? 'resume' : 'fallback'
    }
    return state.current_step?.id === step.id && !signal?.aborted && retries < MAX_EXECUTOR_INTERRUPT_RETRIES ? 'restart' : 'fallback'
  }

  // ── guards ─────────────────────────────────────────────────────────────────

  async recordGuardBlock(code: GuardCode, reason: string): Promise<GuardBlockOutcome> {
    const state = this.store.readState()
    if (!state) return { disposition: 'block_continue', code, count: 0, watchdog_calls: 0, instruction: GUARD_FIRST_INSTRUCTION }
    const stepId = state.current_step?.id ?? state.plan.steps.find((candidate) => candidate.status === 'running')?.id ?? ''
    const previous = state.guard_recovery
    const same = previous?.step_id === stepId && previous?.code === code
    const count = (same ? previous.count : 0) + 1
    state.guard_recovery = { step_id: stepId, code, count }
    this.store.writeState(state)

    if (count < GUARD_ESCALATION_THRESHOLD) {
      return {
        disposition: 'block_continue',
        code,
        count,
        watchdog_calls: 0,
        instruction: count >= 2 ? GUARD_REPEAT_INSTRUCTION : GUARD_FIRST_INSTRUCTION,
      }
    }
    if (count > GUARD_RECOVERY_CAP) return this.guardNeedsUser(state, code, reason, count)

    const watchdog = await this.guardEscalation(state, code, count)
    if (watchdog.decision === 'NEEDS_USER') return this.guardNeedsUser(state, code, reason, count, watchdog.instruction)
    return { disposition: 'block_continue', code, count, watchdog_calls: 1, instruction: watchdog.instruction ?? GUARD_RETRY_INSTRUCTION }
  }

  private async guardEscalation(state: OrbitState, code: GuardCode, count: number): Promise<GuardWatchdogDecision> {
    const result = await this.runAuxRole(state, {
      role: 'watchdog',
      label: 'watchdog-guard',
      prompt: WATCHDOG_GUARD_PROMPT(code, count, state.current_step?.id ?? ''),
    })
    if (!result || result.interrupted) return this.guardWatchdogFallback(count)
    try {
      return assertGuardWatchdogDecision(parseJsonObject<GuardWatchdogDecision>(result.output, 'SMART_WATCHDOG_GUARD'))
    } catch {
      return this.guardWatchdogFallback(count)
    }
  }

  private guardWatchdogFallback(count: number): GuardWatchdogDecision {
    return count >= GUARD_RECOVERY_CAP
      ? { decision: 'NEEDS_USER', instruction: GUARD_NEEDS_USER_INSTRUCTION }
      : { decision: 'RETRY_DIFFERENTLY', instruction: GUARD_RETRY_INSTRUCTION }
  }

  private guardNeedsUser(state: OrbitState, code: GuardCode, reason: string, count: number, instruction?: string): GuardBlockOutcome {
    state.phase = 'NEEDS_USER'
    state.status = 'needs_user'
    state.last_error = `ORBIT_GUARD_ESCALATION: ${reason.slice(0, 300)}`
    this.store.writeState(state)
    return { disposition: 'block_needs_user', code, count, watchdog_calls: 0, instruction: instruction ?? GUARD_NEEDS_USER_INSTRUCTION }
  }

  // ── role lifecycle helpers ─────────────────────────────────────────────────

  /**
   * One-shot auxiliary role (watchdogs and similar). Always releases the handle,
   * even on interruption or timeout.
   */
  private async runAuxRole(state: OrbitState, request: AuxRoleRequest): Promise<RoleRunResult | undefined> {
    const names = request.role === 'watchdog' ? this.config.watchdogTools : this.config.commanderReadOnlyTools
    let handle: RoleHandle | undefined
    try {
      handle = await this.host.startRole({
        role: request.role,
        label: request.label,
        prompt: request.prompt,
        route: state.routes[request.role],
        toolFilter: this.toolAllow(names, request.role),
        ...(request.signal ? { signal: request.signal } : {}),
      })
      const timeoutMs = request.timeoutMs ?? this.config.watchdogTimeoutMs ?? WATCHDOG_TIMEOUT_MS
      const raced = await this.raceWithSleep(handle.result, timeoutMs, request.signal)
      if (raced.kind === 'work') return raced.value
      await this.cancelHandle(handle, raced.kind === 'aborted' ? 'ORBIT_ABORTED' : 'WATCHDOG_TIMEOUT')
      return {
        ...(handle.childId ? { childId: handle.childId } : {}),
        output: '',
        interrupted: true,
        reason: raced.kind === 'aborted' ? 'ORBIT_ABORTED' : 'WATCHDOG_TIMEOUT',
      }
    } catch {
      return undefined
    } finally {
      if (handle) await this.disposeHandle(handle)
    }
  }

  private async cancelHandle(handle: RoleHandle, reason: string): Promise<void> {
    try {
      if (handle.cancel) await handle.cancel(reason)
      else await this.host.interruptRole(handle, reason)
    } catch {
      // cancellation is best-effort; dispose still runs
    }
  }

  private async disposeHandle(handle: RoleHandle): Promise<void> {
    try {
      if (handle.dispose) await handle.dispose()
      else await this.host.releaseRole(handle)
    } catch {
      // idempotent cleanup
    }
  }

  /** Race a work promise against a sleeping deadline, aborting the timer cleanly. */
  private async raceWithSleep<T>(
    work: Promise<T>,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<{ kind: 'work'; value: T } | { kind: 'timeout' } | { kind: 'aborted' }> {
    const controller = new AbortController()
    const onAbort = (): void => controller.abort()
    signal?.addEventListener('abort', onAbort, { once: true })
    const timeout = this.host
      .sleep(timeoutMs, controller.signal)
      .then(() => ({ kind: 'timeout' as const }))
      .catch(() => ({ kind: 'aborted' as const }))
    try {
      return await Promise.race([
        work.then((value) => {
          controller.abort()
          return { kind: 'work' as const, value }
        }),
        timeout,
      ])
    } finally {
      controller.abort()
      signal?.removeEventListener('abort', onAbort)
    }
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────

  stop(action: string, runId?: string): OrbitActionResult {
    const state = this.store.readState()
    if (!state) return { ok: false, action, message: 'ORBIT_RUN_NOT_FOUND: no active run.' }
    if (runId && runId !== state.run_id) return { ok: false, action, message: `ORBIT_RUN_NOT_FOUND: ${runId}` }
    state.phase = 'STOPPED'
    state.status = 'stopped'
    this.store.writeState(state)
    return this.result(state, true)
  }

  async status(): Promise<OrbitActionResult> {
    const state = this.store.readState()
    if (!state) return { ok: false, action: 'status', message: 'ORBIT_RUN_NOT_FOUND: no run state.' }
    return this.result(state, true)
  }

  private result(state: OrbitState, ok: boolean, message?: string): OrbitActionResult {
    // Tool output must be lossless JSON: optional state fields are omitted, not
    // emitted as `undefined`.
    const data = {
      goal: state.goal,
      preset: state.preset,
      loop: state.loop,
      remaining_budget: state.remaining_budget,
      current_step: state.current_step,
      child: state.child,
      plan: state.plan,
      commander: state.commander,
      smart_watchdog: state.smart_watchdog,
      strategy_challenge: state.strategy_challenge,
      guard_recovery: state.guard_recovery,
      last_error: state.last_error,
      changed_files: state.changed_files,
      test_summary: state.test_summary,
      driver_ownership: state.driver_ownership,
      state_revision: state.state_revision,
    }
    return {
      ok,
      action: 'run',
      run_id: state.run_id,
      phase: state.phase,
      status: state.status,
      ...(message ? { message } : {}),
      data: Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined)),
    }
  }
}

function hashGoal(goal: string): string {
  let hash = 0
  for (let index = 0; index < goal.length; index += 1) {
    hash = (hash * 31 + goal.charCodeAt(index)) | 0
  }
  return `g${(hash >>> 0).toString(16)}`
}

export { DEFAULT_CAPABILITIES }
