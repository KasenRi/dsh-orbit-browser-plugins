import { basename, join } from 'node:path'
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
import { guardReason } from './guard.ts'
import type { CxHost, RoleHandle, RoleRunResult } from './host.ts'
import { redactText, truncateSafe } from './sanitize.ts'
import { CxStateStore } from './state-store.ts'
import {
  COMMANDER_EXTENSION_MS,
  COMMANDER_HARD_CEILING_MS,
  COMMANDER_SOFT_DEADLINE_MS,
  DEFAULT_CAPABILITIES,
  GUARD_ESCALATION_THRESHOLD,
  GUARD_FIRST_INSTRUCTION,
  GUARD_NEEDS_USER_INSTRUCTION,
  GUARD_RECOVERY_CAP,
  GUARD_REPEAT_INSTRUCTION,
  GUARD_RETRY_INSTRUCTION,
  MAX_CORRECTION_DEPTH,
  MAX_EXECUTOR_INTERRUPT_RETRIES,
  MAX_WATCHDOG_CALLS_PER_STEP,
  type CxActionResult,
  type CxPlanStep,
  type CxState,
  type CxTelemetry,
  type CommanderDecision,
  type GuardCode,
  type GuardWatchdogDecision,
  type StrategyDecision,
  type TimeoutDecision,
  type WatchdogDecision,
} from './types.ts'

export interface CxSupervisorConfig {
  defaultRoutes: CxState['routes']
  browserTools: readonly string[]
  commanderReadOnlyTools: readonly string[]
  watchdogTools: readonly string[]
}

export interface CxRunInput {
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

const COMMANDER_PLAN_PROMPT = (goal: string, constraints: readonly string[]) => `You are the CX Commander. Produce the smallest set of 2-5 logical engineering steps for this goal.
Return ONLY JSON: {"summary":"...","steps":[{"id":"P0","goal":"...","capabilities":[]}]}
Rules: ordinary engineering steps must omit capabilities. Add capability "browser" only when the step must drive a real web page, and "web-api-recon" when it must analyze captured network/API traffic. Keep it minimal.
Goal: ${goal}
Hard constraints: ${constraints.join('; ') || 'none'}`

const COMMANDER_STEP_PROMPT = (
  goal: string,
  step: CxPlanStep,
  evidence: string,
  state: CxState,
) => `You are the CX Commander doing STEP_EVALUATE. Verify the real project state; do not trust the Executor summary blindly.
Allowed decisions ONLY: PASS_CURRENT_STEP | CORRECT_CURRENT_STEP | NEEDS_USER.
- CORRECT_CURRENT_STEP requires next_step_goal (optional next_step_capabilities).
Return ONLY JSON: {"decision":"...","reason":"...","next_step_goal":"...","next_step_capabilities":[]}
Original goal: ${goal}
Current step ${step.id}: ${step.goal}
Iteration counters: loop ${state.loop.used}/${state.loop.max}
Executor evidence:
${evidence}`

const COMMANDER_FINAL_PROMPT = (goal: string, plan: CxState['plan'], evidence: string, state: CxState) =>
  `You are the CX Commander doing FINAL_EVALUATE. All planned steps are done. Decide whether the original goal is truly satisfied against the real project state.
Allowed decisions ONLY: SUCCESS | APPEND | NEEDS_USER.
- APPEND requires next_steps (array) or next_step_goal; appends are bounded by the remaining loop budget.
Return ONLY JSON: {"decision":"...","summary":"...","next_steps":[{"goal":"...","capabilities":[]}]}
Original goal: ${goal}
Plan summary: ${plan.summary}
Steps: ${plan.steps.map((step) => `${step.id}:${step.goal}[${step.status}]`).join('; ')}
Loop: ${state.loop.used}/${state.loop.max}
Evidence:
${evidence}`

const COMMANDER_STRATEGY_PROMPT = (goal: string, base: string, challenge: string, state: CxState) =>
  `You are the CX Commander reconsidering strategy after a repeated correction on ${base}.
Allowed decisions ONLY: KEEP_APPROACH | REPLACE_CURRENT_STEP | NEEDS_USER.
- REPLACE_CURRENT_STEP requires replacement_goal.
Return ONLY JSON: {"decision":"...","reason":"...","replacement_goal":"..."}
Goal: ${goal}
Loop: ${state.loop.used}/${state.loop.max}
Watchdog challenge: ${challenge}`

const WATCHDOG_RUNTIME_PROMPT = (step: CxPlanStep, reason: string, telemetry: CxTelemetry | undefined) =>
  `You are the CX Smart Watchdog doing RUNTIME_DIAGNOSE. Diagnose only the current runtime anomaly. Do not review code quality.
Allowed decisions ONLY: RESUME_CHILD | RESTART_STEP | NEEDS_USER | RUNTIME_BUG.
Return ONLY JSON: {"decision":"...","reason":"..."}
Failed step ${step.id}: ${step.goal}
Runtime anomaly: ${reason}
Telemetry: ${JSON.stringify(telemetry ?? {})}`

const WATCHDOG_STRATEGY_PROMPT = (step: CxPlanStep, reason: string, state: CxState) =>
  `You are the CX Smart Watchdog doing STRATEGY_CHALLENGE. Ask: is the current approach tunnel vision? Is this blocker truly required? Is there a simpler route?
Return ONLY JSON: {"question":"..."}
Step ${step.id}: ${step.goal}
Repeated correction: ${reason}
Loop: ${state.loop.used}/${state.loop.max}`

const WATCHDOG_GUARD_PROMPT = (code: GuardCode, count: number, stepId: string) =>
  `You are the CX Smart Watchdog doing GUARD_ESCALATION. A safety guard blocked a tool ${count} times.
Allowed decisions ONLY: RETRY_DIFFERENTLY | NEEDS_USER.
Return ONLY JSON: {"decision":"...","instruction":"..."}
Guard code: ${code}
Step: ${stepId}`

const WATCHDOG_TIMEOUT_PROMPT = (mode: string, elapsed: number, extensions: number, telemetry: CxTelemetry | undefined) =>
  `You are the CX Smart Watchdog doing COMMANDER_TIMEOUT_REVIEW. The Commander has run ${elapsed}ms with ${extensions} extension(s).
Allowed decisions ONLY: EXTEND | INTERRUPT | NEEDS_USER.
Return ONLY JSON: {"decision":"...","reason":"..."}
Mode: ${mode}
Telemetry: ${JSON.stringify(telemetry ?? {})}`

type CommanderOutcome =
  | { kind: 'decision'; decision: CommanderDecision }
  | { kind: 'interrupted'; reason: string }
  | { kind: 'needs_user'; reason: string }

export class CxSupervisor {
  private readonly store: CxStateStore
  private readonly host: CxHost
  private readonly config: CxSupervisorConfig
  private lastTelemetry: CxTelemetry | undefined

  constructor(store: CxStateStore, host: CxHost, config: CxSupervisorConfig) {
    this.store = store
    this.host = host
    this.config = config
  }

  private now(): number {
    return this.host.now()
  }

  createState(input: CxRunInput): CxState {
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
      preset: input.preset ?? 'cx-lite',
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

  private explicitLoopBudget(input: CxRunInput): number | undefined {
    const raw = input.approved_loop_count ?? input.max_loops
    if (raw === undefined) return undefined
    if (!Number.isSafeInteger(raw) || raw <= 0) throw new Error('CX_LOOP_BUDGET_INVALID: approved_loop_count must be a positive integer')
    if (raw > 10) throw new Error('CX_LOOP_BUDGET_INVALID: approved_loop_count above 10 requires an explicit execution request')
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

  private updateLoopBudget(state: CxState, budget: number): void {
    if (budget < state.loop.used) throw new Error(`CX_LOOP_BUDGET_BELOW_USED: requested ${budget}, already used ${state.loop.used}`)
    state.approved_loop_count = budget
    state.loop = { used: state.loop.used, max: budget }
    state.loop_count = state.loop.used
    state.remaining_budget = Math.max(0, budget - state.loop.used)
  }

  async bootstrap(input: CxRunInput, signal?: AbortSignal): Promise<CxActionResult> {
    const requestedGoal = (input.goal ?? '').trim()
    let state = this.store.readState()
    const raw = this.store.readRawState()
    const legacy = raw !== null && raw['schema_version'] !== 2

    if (legacy && requestedGoal) {
      state = this.store.writeState(this.createState(input))
    } else if (!state) {
      if (!requestedGoal) return { ok: false, action: 'run', message: 'CX_GOAL_REQUIRED: provide a goal to start a run.' }
      state = this.store.writeState(this.createState(input))
    } else if (input.run_id && input.run_id !== state.run_id && !legacy) {
      return { ok: false, action: 'run', message: `CX_RUN_NOT_FOUND: ${input.run_id}` }
    }

    if (['SUCCESS', 'STOPPED', 'BUDGET_EXHAUSTED'].includes(state.phase) && requestedGoal) {
      state = this.store.writeState(this.createState(input))
    }
    if (!legacy && requestedGoal && state.goal && state.goal !== requestedGoal) {
      return {
        ok: false,
        action: 'run',
        run_id: state.run_id,
        message: 'CX_ACTIVE_RUN_EXISTS: current Lite run owns this project; resume it or stop it before starting a different goal.',
      }
    }
    if (state.phase === 'NEEDS_USER' && requestedGoal) {
      state.status = 'running'
      state.phase = 'EXECUTE'
      this.store.writeState(state)
    }
    return this.run(state, signal)
  }

  async run(state: CxState, signal?: AbortSignal): Promise<CxActionResult> {
    if (signal?.aborted) return this.result(state, false, 'CX_ABORTED')
    const projectDir = join(this.store.cxDir, '..')
    const competitors = await this.host.otherMutationDrivers(projectDir)
    if (competitors.length > 0) {
      return {
        ok: false,
        action: 'run',
        run_id: state.run_id,
        phase: state.phase,
        status: state.status,
        message: `CX_MUTATION_DRIVER_CONFLICT: ${competitors.join(', ')} already owns mutation in this workspace.`,
      }
    }

    if (state.phase === 'NEEDS_USER') return this.result(state, true, 'CX_AWAITING_USER')
    if (state.phase === 'SUCCESS') return this.result(state, true)
    if (state.phase === 'STOPPED') return this.result(state, true)
    if (state.phase === 'BUDGET_EXHAUSTED') return this.result(state, true)

    if (state.plan.steps.length === 0) {
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
    if (executed.done) return this.result(state, executed.ok)
    return this.run(state, signal)
  }

  private async makePlan(state: CxState, signal?: AbortSignal): Promise<CxActionResult | undefined> {
    const handle = await this.host.startRole({
      role: 'commander',
      label: 'commander-plan',
      prompt: COMMANDER_PLAN_PROMPT(state.goal, state.user_hard_constraints),
      route: state.routes.commander,
      toolFilter: { allow: this.config.commanderReadOnlyTools },
      ...(signal ? { signal } : {}),
    })
    const result = await handle.result
    if (result.interrupted) {
      state.last_error = redactText(result.reason ?? 'COMMANDER_PLAN_INTERRUPTED')
      state.phase = 'PLAN'
      this.store.writeState(state)
      return this.result(state, false)
    }
    try {
      const plan = normalizePlan(parseJsonObject<{ summary?: unknown; steps?: unknown }>(result.output, 'COMMANDER_PLAN'))
      state.plan = plan
      state.phase = 'EXECUTE'
      state.status = 'running'
      this.store.writeState(state)
      return undefined
    } catch (error) {
      state.phase = 'NEEDS_USER'
      state.status = 'needs_user'
      state.last_error = truncateSafe(error instanceof Error ? error.message : String(error), 500)
      this.store.writeState(state)
      return this.result(state, false)
    }
  }

  private async executeStep(state: CxState, step: CxPlanStep, signal?: AbortSignal): Promise<{ done: boolean; ok: boolean }> {
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

    const toolFilter = capabilities.includes('browser')
      ? undefined
      : { deny: [...this.config.browserTools] }

    const handle = await this.host.startRole({
      role: 'executor',
      label: `executor-${step.id}`,
      prompt: this.executorPrompt(state, step),
      route: state.routes.executor,
      ...(toolFilter ? { toolFilter } : {}),
      capabilities,
      ...(signal ? { signal } : {}),
      ...(state.child?.id && state.child.status === 'interrupted' && state.child.id ? { resumeOf: state.child.id } : {}),
    })
    const result = await handle.result
    this.lastTelemetry = result.telemetry

    if (result.interrupted) {
      state.child = { ...(result.childId ? { id: result.childId } : {}), status: 'interrupted' }
      state.last_error = redactText(result.reason ?? 'EXECUTOR_INTERRUPTED')
      state.phase = 'EXECUTE'
      state.status = 'running'
      const retries = state.interruption_retries + 1
      state.interruption_retries = retries
      this.store.writeState(state)

      if (signal?.aborted) return { done: false, ok: false }
      if (result.reason === 'USER_HARD_SCOPE_VIOLATION') {
        state.phase = 'NEEDS_USER'
        state.status = 'needs_user'
        this.store.writeState(state)
        return { done: true, ok: false }
      }
      const recovery = await this.runtimeWatchdog(state, step, result, retries, signal)
      if (recovery === 'needs_user') {
        state.phase = 'NEEDS_USER'
        state.status = 'needs_user'
        this.store.writeState(state)
        return { done: true, ok: false }
      }
      if (recovery === 'resume' && result.childId) {
        state.child = { id: result.childId, status: 'interrupted' }
        this.store.writeState(state)
        return { done: false, ok: false }
      }
      if (recovery === 'restart') {
        if (handle.childId || result.childId) {
          await this.host.interruptRole(handle, 'CX_RESTART_STEP')
        }
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
        return { done: true, ok: false }
      }
      return { done: false, ok: false }
    }

    state.child = { ...(result.childId ? { id: result.childId } : {}), status: 'completed' }
    state.interruption_retries = 0
    state.loop = { used: state.loop.used + 1, max: state.loop.max }
    state.loop_count = state.loop.used
    state.remaining_budget = Math.max(0, state.loop.max - state.loop.used)
    state.changed_files = result.changedFiles ?? this.host.changedFiles(join(this.store.cxDir, '..'))
    state.test_summary = result.testSummary ?? []
    state.last_error = null
    state.commander = {
      last_decision: state.commander?.last_decision,
      summary: truncateSafe(redactText(result.output), 2000),
    }
    state.phase = 'EVALUATE'
    state.status = 'running'
    this.store.writeState(state)
    await this.host.releaseRole(handle)
    return { done: false, ok: false }
  }

  private executorPrompt(state: CxState, step: CxPlanStep): string {
    const lines = [
      'You are the CX Executor. Implement exactly the current step with real tools and real verification.',
      `Current step ${step.id}: ${step.goal}`,
      `Working directory: ${join(this.store.cxDir, '..')}`,
      `Hard constraints: ${state.user_hard_constraints.join('; ') || 'none'}`,
    ]
    if ((step.capabilities ?? []).length > 0) lines.push(`Capabilities: ${(step.capabilities ?? []).join(', ')}`)
    lines.push('Return a compact evidence summary: what changed, commands/tests run, and residual risks.')
    return lines.join('\n')
  }

  private async commanderEvaluate(
    state: CxState,
    step: CxPlanStep | undefined,
    final: boolean,
    signal?: AbortSignal,
  ): Promise<CommanderOutcome> {
    const mode: EvaluationMode = final ? 'FINAL_EVALUATE' : 'STEP_EVALUATE'
    const evidence = state.commander?.summary ?? state.last_error ?? 'no evidence recorded'
    const prompt = final
      ? COMMANDER_FINAL_PROMPT(state.goal, state.plan, evidence, state)
      : COMMANDER_STEP_PROMPT(state.goal, step as CxPlanStep, evidence, state)
    return this.runCommander(state, prompt, mode, signal)
  }

  private async runCommander(
    state: CxState,
    prompt: string,
    mode: EvaluationMode,
    signal?: AbortSignal,
  ): Promise<CommanderOutcome> {
    const startedAt = this.now()
    const handle = await this.host.startRole({
      role: 'commander',
      label: `commander-${mode.toLowerCase()}`,
      prompt,
      route: state.routes.commander,
      toolFilter: { allow: this.config.commanderReadOnlyTools },
      ...(signal ? { signal } : {}),
    })

    for (let extensions = 0; ; ) {
      const deadline =
        extensions === 0
          ? COMMANDER_SOFT_DEADLINE_MS
          : extensions === 1
            ? COMMANDER_SOFT_DEADLINE_MS + COMMANDER_EXTENSION_MS
            : COMMANDER_HARD_CEILING_MS
      const remaining = Math.max(0, deadline - (this.now() - startedAt))
      const outcome = await Promise.race([
        handle.result.then((value) => ({ value }) as const),
        this.host.sleep(remaining, signal).then(() => ({ deadline: true }) as const),
      ])
      if ('value' in outcome) {
        if (outcome.value.interrupted) return { kind: 'interrupted', reason: outcome.value.reason ?? 'COMMANDER_INTERRUPTED' }
        try {
          const decision = parseJsonObject<CommanderDecision>(outcome.value.output, 'COMMANDER_EVALUATION')
          return { kind: 'decision', decision: assertCommanderDecision(decision, mode) }
        } catch (error) {
          return { kind: 'needs_user', reason: truncateSafe(error instanceof Error ? error.message : String(error), 500) }
        }
      }
      if (signal?.aborted) {
        await this.host.interruptRole(handle, 'CX_ABORTED')
        return { kind: 'interrupted', reason: 'CX_ABORTED' }
      }
      if (extensions >= 2) {
        await this.host.interruptRole(handle, 'COMMANDER_HARD_TIMEOUT')
        return { kind: 'interrupted', reason: 'COMMANDER_HARD_TIMEOUT' }
      }
      const review = await this.commanderTimeoutReview(state, mode, this.now() - startedAt, extensions, signal)
      if (review.decision === 'EXTEND') {
        extensions += 1
        continue
      }
      await this.host.interruptRole(handle, review.decision === 'NEEDS_USER' ? 'COMMANDER_NEEDS_USER' : 'COMMANDER_TIMEOUT_INTERRUPTED')
      if (review.decision === 'NEEDS_USER') return { kind: 'needs_user', reason: review.reason ?? 'COMMANDER_TIMEOUT_NEEDS_USER' }
      return { kind: 'interrupted', reason: 'COMMANDER_TIMEOUT_INTERRUPTED' }
    }
  }

  private async commanderTimeoutReview(
    state: CxState,
    mode: EvaluationMode,
    elapsed: number,
    extensions: number,
    signal?: AbortSignal,
  ): Promise<TimeoutDecision> {
    try {
      const handle = await this.host.startRole({
        role: 'watchdog',
        label: 'watchdog-commander-timeout',
        prompt: WATCHDOG_TIMEOUT_PROMPT(mode, elapsed, extensions, this.lastTelemetry),
        route: state.routes.watchdog,
        toolFilter: { allow: this.config.watchdogTools },
        ...(signal ? { signal } : {}),
      })
      const result = await handle.result
      await this.host.releaseRole(handle)
      if (result.interrupted) return { decision: extensions === 0 ? 'EXTEND' : 'INTERRUPT', reason: 'Smart Watchdog interrupted' }
      return assertTimeoutDecision(parseJsonObject<TimeoutDecision>(result.output, 'COMMANDER_TIMEOUT_WATCHDOG'))
    } catch {
      return { decision: extensions === 0 ? 'EXTEND' : 'INTERRUPT', reason: 'Smart Watchdog unavailable' }
    }
  }

  private async applyCommanderOutcome(
    state: CxState,
    outcome: CommanderOutcome,
    step: CxPlanStep | undefined,
    final: boolean,
    signal?: AbortSignal,
  ): Promise<CxActionResult | undefined> {
    state.guard_recovery = undefined

    if (outcome.kind === 'interrupted') {
      state.last_error = truncateSafe(outcome.reason, 500)
      this.store.writeState(state)
      return undefined
    }
    if (outcome.kind === 'needs_user') {
      state.phase = 'NEEDS_USER'
      state.status = 'needs_user'
      state.last_error = truncateSafe(outcome.reason, 500)
      this.store.writeState(state)
      return this.result(state, false)
    }
    const decision = outcome.decision

    if (decision.decision === 'NEEDS_USER') {
      state.phase = 'NEEDS_USER'
      state.status = 'needs_user'
      state.commander = { last_decision: decision.decision, summary: state.commander?.summary }
      state.last_error = truncateSafe(decision.reason ?? 'COMMANDER_NEEDS_USER', 500)
      this.store.writeState(state)
      return this.result(state, false)
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
      return this.applyCorrection(state, step as CxPlanStep, decision, signal)
    }

    if (decision.decision === 'APPEND') {
      const remaining = state.loop.max - state.loop.used
      const appended = this.normalizeAppend(decision)
      if (appended.length === 0) {
        state.phase = 'NEEDS_USER'
        state.status = 'needs_user'
        state.last_error = 'COMMANDER_EVALUATION_OUTPUT_INVALID: append needs next_steps or next_step_goal'
        this.store.writeState(state)
        return this.result(state, false)
      }
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
    state.phase = 'NEEDS_USER'
    state.status = 'needs_user'
    state.last_error = 'COMMANDER_FINAL_DECISION_INVALID'
    this.store.writeState(state)
    return this.result(state, false)
  }

  private normalizeAppend(decision: CommanderDecision): Array<{ goal: string; capabilities?: CxPlanStep['capabilities'] }> {
    const items: Array<{ goal: string; capabilities?: CxPlanStep['capabilities'] }> = []
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
    state: CxState,
    step: CxPlanStep,
    decision: CommanderDecision,
    signal?: AbortSignal,
  ): Promise<CxActionResult | undefined> {
    if (!step || !decision.next_step_goal) {
      state.phase = 'NEEDS_USER'
      state.status = 'needs_user'
      state.last_error = 'COMMANDER_EVALUATION_OUTPUT_INVALID: correction needs next_step_goal'
      this.store.writeState(state)
      return this.result(state, false)
    }
    const base = baseStepIdOf(step.id)
    const correctionDepth = correctionDepthOf(step.id)
    const remaining = Math.max(0, state.loop.max - state.loop.used)
    const reservedForLaterStages = state.plan.steps.filter((candidate) => isBaseStepId(candidate.id) && candidate.status === 'pending').length

    if (correctionDepth >= MAX_CORRECTION_DEPTH) {
      state.phase = 'NEEDS_USER'
      state.status = 'needs_user'
      state.last_error = 'CORRECTION_LIMIT_REACHED'
      this.store.writeState(state)
      return this.result(state, false)
    }
    if (remaining <= reservedForLaterStages) {
      state.phase = 'NEEDS_USER'
      state.status = 'needs_user'
      state.last_error = 'LOOP_BUDGET_RESERVED_FOR_LATER_STEPS'
      this.store.writeState(state)
      return this.result(state, false)
    }

    let nextGoal = decision.next_step_goal
    if (correctionDepth === 1 && state.strategy_challenge?.base_step_id !== base) {
      const reconsider = await this.strategyChallenge(state, base, step, decision.reason ?? 'repeated correction', signal)
      if (reconsider.kind === 'needs_user') {
        state.phase = 'NEEDS_USER'
        state.status = 'needs_user'
        state.last_error = truncateSafe(reconsider.reason, 500)
        this.store.writeState(state)
        return this.result(state, false)
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
    state: CxState,
    base: string,
    step: CxPlanStep,
    reason: string,
    signal?: AbortSignal,
  ): Promise<{ kind: 'keep' } | { kind: 'replace'; replacementGoal: string } | { kind: 'needs_user'; reason: string }> {
    let challenge = ''
    try {
      const handle = await this.host.startRole({
        role: 'watchdog',
        label: 'watchdog-strategy',
        prompt: WATCHDOG_STRATEGY_PROMPT(step, reason, state),
        route: state.routes.watchdog,
        toolFilter: { allow: this.config.watchdogTools },
        ...(signal ? { signal } : {}),
      })
      const result = await handle.result
      await this.host.releaseRole(handle)
      if (result.interrupted) return { kind: 'needs_user', reason: 'SMART_WATCHDOG_INTERRUPTED' }
      const parsed = parseJsonObject<{ question?: unknown }>(result.output, 'SMART_WATCHDOG_STRATEGY')
      challenge = String(parsed.question ?? '').trim()
      if (!challenge) return { kind: 'needs_user', reason: 'SMART_WATCHDOG_STRATEGY_OUTPUT_INVALID: question is required' }
    } catch (error) {
      return { kind: 'needs_user', reason: truncateSafe(error instanceof Error ? error.message : String(error), 500) }
    }

    try {
      const handle = await this.host.startRole({
        role: 'commander',
        label: 'commander-strategy-reconsider',
        prompt: COMMANDER_STRATEGY_PROMPT(state.goal, base, challenge, state),
        route: state.routes.commander,
        toolFilter: { allow: this.config.commanderReadOnlyTools },
        ...(signal ? { signal } : {}),
      })
      const result = await handle.result
      await this.host.releaseRole(handle)
      if (result.interrupted) return { kind: 'needs_user', reason: 'COMMANDER_STRATEGY_INTERRUPTED' }
      const decision = assertStrategyDecision(parseJsonObject<StrategyDecision>(result.output, 'COMMANDER_STRATEGY'))
      if (decision.decision === 'NEEDS_USER') return { kind: 'needs_user', reason: decision.reason ?? 'COMMANDER_STRATEGY_NEEDS_USER' }
      state.strategy_challenge = { base_step_id: base, used: true }
      if (decision.decision === 'REPLACE_CURRENT_STEP') return { kind: 'replace', replacementGoal: decision.replacement_goal as string }
      return { kind: 'keep' }
    } catch (error) {
      return { kind: 'needs_user', reason: truncateSafe(error instanceof Error ? error.message : String(error), 500) }
    }
  }

  private async runtimeWatchdog(
    state: CxState,
    step: CxPlanStep,
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

    let diagnosis: WatchdogDecision
    try {
      const handle = await this.host.startRole({
        role: 'watchdog',
        label: 'watchdog-runtime',
        prompt: WATCHDOG_RUNTIME_PROMPT(step, result.reason ?? 'runtime failure', result.telemetry),
        route: state.routes.watchdog,
        toolFilter: { allow: this.config.watchdogTools },
        ...(signal ? { signal } : {}),
      })
      const watchdogResult = await handle.result
      await this.host.releaseRole(handle)
      if (watchdogResult.interrupted) {
        state.smart_watchdog.last_decision = 'UNAVAILABLE'
        this.store.writeState(state)
        return 'fallback'
      }
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
    // RESTART_STEP
    return state.current_step?.id === step.id && !signal?.aborted && retries < MAX_EXECUTOR_INTERRUPT_RETRIES ? 'restart' : 'fallback'
  }

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

  private async guardEscalation(state: CxState, code: GuardCode, count: number): Promise<GuardWatchdogDecision> {
    try {
      const handle = await this.host.startRole({
        role: 'watchdog',
        label: 'watchdog-guard',
        prompt: WATCHDOG_GUARD_PROMPT(code, count, state.current_step?.id ?? ''),
        route: state.routes.watchdog,
        toolFilter: { allow: this.config.watchdogTools },
      })
      const result = await handle.result
      await this.host.releaseRole(handle)
      if (result.interrupted) return this.guardWatchdogFallback(count)
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

  private guardNeedsUser(state: CxState, code: GuardCode, reason: string, count: number, instruction?: string): GuardBlockOutcome {
    state.phase = 'NEEDS_USER'
    state.status = 'needs_user'
    state.last_error = `CX_GUARD_ESCALATION: ${redactText(reason).slice(0, 300)}`
    this.store.writeState(state)
    return { disposition: 'block_needs_user', code, count, watchdog_calls: 0, instruction: instruction ?? GUARD_NEEDS_USER_INSTRUCTION }
  }

  stop(action: string, runId?: string): CxActionResult {
    const state = this.store.readState()
    if (!state) return { ok: false, action, message: 'CX_RUN_NOT_FOUND: no active run.' }
    if (runId && runId !== state.run_id) return { ok: false, action, message: `CX_RUN_NOT_FOUND: ${runId}` }
    state.phase = 'STOPPED'
    state.status = 'stopped'
    this.store.writeState(state)
    return this.result(state, true)
  }

  async status(): Promise<CxActionResult> {
    const state = this.store.readState()
    if (!state) return { ok: false, action: 'status', message: 'CX_RUN_NOT_FOUND: no run state.' }
    return this.result(state, true)
  }

  private result(state: CxState, ok: boolean, message?: string): CxActionResult {
    return {
      ok,
      action: 'run',
      run_id: state.run_id,
      phase: state.phase,
      status: state.status,
      ...(message ? { message } : {}),
      data: {
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
      },
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
function guardReasonReexport(decision: Parameters<typeof guardReason>[0]): string {
  return guardReason(decision)
}
void guardReasonReexport
void basename
