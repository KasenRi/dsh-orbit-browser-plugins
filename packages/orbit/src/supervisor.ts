import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import { buildEvidenceBundle, formatEvidenceBundle, type OrbitEvidenceBundle } from './evidence.ts'
import {
  assertCommanderDecision,
  assertStrategyDecision,
  assertTimeoutDecision,
  assertWatchdogDecision,
  assertGuardWatchdogDecision,
  COMMANDER_FINAL_EVALUATE_SCHEMA,
  COMMANDER_PLAN_SCHEMA,
  COMMANDER_STEP_EVALUATE_SCHEMA,
  COMMANDER_STRATEGY_SCHEMA,
  WATCHDOG_GUARD_SCHEMA,
  WATCHDOG_RUNTIME_SCHEMA,
  WATCHDOG_STRATEGY_SCHEMA,
  WATCHDOG_TIMEOUT_SCHEMA,
  type EvaluationMode,
} from './decisions.ts'
import type { OrbitHost, RoleHandle, RoleRunResult, RoleToolFilter } from './host.ts'
import {
  applyCommanderNeedsUser,
  applyCorrectionStep,
  applyExecutorCapabilityUnavailable,
  applyExecutorInterrupted,
  applyExecutorResume,
  applyExecutorSuccess,
  applyFinalAppend,
  applyFinalSuccess,
  applyPlan,
  applyStepPass,
  baseStepIdOf,
  beginStep,
  clearExecutorChild,
  clearGuardRecovery,
  correctionBlockCode,
  correctionDepthOf,
  createInitialState,
  enterBudgetExhausted,
  enterNeedsUser,
  markStrategyChallengeUsed,
  normalizePlan,
  openWatchdogAttempt,
  recordGuardRecovery,
  recordPlanFailure,
  recordWatchdogDecision,
  restoreEvaluationState,
  resumeFromNeedsUser,
  stopRun,
} from './kernel.ts'
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
  /**
   * Resolve the role routes for a NEW run (settings + session selection).
   * Absent or unused falls back to `defaultRoutes`; an existing run always
   * resumes from its frozen `state.routes` and never calls this.
   */
  resolveRoutes?: () => OrbitState['routes']
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
  | { kind: 'output'; output: string; structured: unknown }
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
  /** One-shot decision roles submit their answer through this DSH schema. */
  outputSchema?: ObjectJsonSchema
}

const COMMANDER_PLAN_PROMPT = (goal: string, constraints: readonly string[], userReply: string) => `你是 Orbit 指挥官（Commander），当前阶段：PLAN。
请为下述目标制定最小化的 2-5 个逻辑工程步骤。
规则：普通工程步骤不要声明 capabilities；仅当该步骤必须驱动真实网页时才添加 capability "browser"，仅当必须分析抓取到的网络/API 流量时才添加 "web-api-recon"。保持最小化。
请通过结构化结果协议提交最终计划。
你的自然语言输出、推理说明和总结默认全部使用简体中文；decision 枚举、capability id、代码、命令、路径、provider/model ID 等机器标识保持原样。
目标：${goal}
硬性约束：${constraints.join('；') || '无'}${userReply}`

const COMMANDER_STEP_PROMPT = (
  goal: string,
  step: OrbitPlanStep,
  evidence: string,
  state: OrbitState,
) => `你是 Orbit 指挥官（Commander），当前阶段：STEP_EVALUATE。
请核实真实项目状态，不要只相信执行员的说法；以可验证的执行证据为准。
允许的 decision 仅限：PASS_CURRENT_STEP | CORRECT_CURRENT_STEP | NEEDS_USER。
- CORRECT_CURRENT_STEP 必须给出具体的下一步目标（可选 capabilities）。
请通过结构化结果协议提交最终判断。
你的自然语言输出、推理说明和总结默认全部使用简体中文；decision 枚举、代码、命令、路径、provider/model ID 等机器标识保持原样。
原始目标：${goal}
当前步骤 ${step.id}：${step.goal}
迭代计数：loop ${state.loop.used}/${state.loop.max}${userReplyLine(state)}
执行员证据：
${evidence}`

const COMMANDER_FINAL_PROMPT = (goal: string, plan: OrbitState['plan'], evidence: string, state: OrbitState) =>
  `你是 Orbit 指挥官（Commander），当前阶段：FINAL_EVALUATE。
所有计划步骤均已执行完毕。请依据真实项目状态判断原始目标是否真正达成。
允许的 decision 仅限：SUCCESS | APPEND | NEEDS_USER。
- APPEND 必须给出新增步骤或下一步目标；追加受剩余 loop 预算限制。
请通过结构化结果协议提交最终判断。
你的自然语言输出、推理说明和总结默认全部使用简体中文；decision 枚举、代码、命令、路径、provider/model ID 等机器标识保持原样。
原始目标：${goal}
计划摘要：${plan.summary}
步骤：${plan.steps.map((step) => `${step.id}:${step.goal}[${step.status}]`).join('; ')}
Loop：${state.loop.used}/${state.loop.max}${userReplyLine(state)}
执行员证据：
${evidence}`

/**
 * The durable user reply line for role prompts. The reply is the user's answer
 * to a NEEDS_USER question and never replaces the original goal.
 */
function userReplyLine(state: OrbitState): string {
  return state.pending_user_reply ? `\n用户回复（对上一个问题的回答）：${state.pending_user_reply}` : ''
}

const COMMANDER_STRATEGY_PROMPT = (goal: string, base: string, challenge: string, state: OrbitState) =>
  `你是 Orbit 指挥官（Commander），当前阶段：STRATEGY_RECONSIDER。
步骤 ${base} 已连续修正多次，请重新审视当前策略。
允许的 decision 仅限：KEEP_APPROACH | REPLACE_CURRENT_STEP | NEEDS_USER。
- REPLACE_CURRENT_STEP 必须给出替代目标。
请通过结构化结果协议提交最终判断。
你的自然语言输出、推理说明和总结默认全部使用简体中文；decision 枚举、代码、命令、路径、provider/model ID 等机器标识保持原样。
目标：${goal}
Loop：${state.loop.used}/${state.loop.max}
监控模型质疑：${challenge}`

const WATCHDOG_RUNTIME_PROMPT = (step: OrbitPlanStep, reason: string, telemetry: OrbitTelemetry | undefined) =>
  `你是 Orbit 监控模型（Smart Watchdog），当前阶段：RUNTIME_DIAGNOSE。
只诊断当前运行时异常，不评审代码质量。
允许的 decision 仅限：RESUME_CHILD | RESTART_STEP | NEEDS_USER | RUNTIME_BUG。
请通过结构化结果协议提交最终判断。
你的自然语言输出、推理说明和总结默认全部使用简体中文；decision 枚举、代码、命令、路径、provider/model ID 等机器标识保持原样。
失败步骤 ${step.id}：${step.goal}
运行时异常：${reason}
遥测：${JSON.stringify(telemetry ?? {})}`

const WATCHDOG_STRATEGY_PROMPT = (step: OrbitPlanStep, reason: string, state: OrbitState) =>
  `你是 Orbit 监控模型（Smart Watchdog），当前阶段：STRATEGY_CHALLENGE。
请质疑：当前思路是否陷入隧道视野？这个阻塞是否真的必要？是否存在更简单的路径？
请通过结构化结果协议提交一个聚焦的质疑问题。
你的自然语言输出默认使用简体中文；decision 枚举、代码、命令、路径、provider/model ID 等机器标识保持原样。
步骤 ${step.id}：${step.goal}
重复修正：${reason}
Loop：${state.loop.used}/${state.loop.max}`

const WATCHDOG_GUARD_PROMPT = (code: GuardCode, count: number, stepId: string) =>
  `你是 Orbit 监控模型（Smart Watchdog），当前阶段：GUARD_ESCALATION。
安全护栏已连续 ${count} 次拦截某个工具调用。
允许的 decision 仅限：RETRY_DIFFERENTLY | NEEDS_USER。
请通过结构化结果协议提交最终判断。
你的自然语言输出默认使用简体中文；decision 枚举、代码、命令、路径、provider/model ID 等机器标识保持原样。
护栏代码：${code}
步骤：${stepId}`

const WATCHDOG_TIMEOUT_PROMPT = (mode: CommanderMode, elapsed: number, extensions: number, telemetry: OrbitTelemetry | undefined) =>
  `你是 Orbit 监控模型（Smart Watchdog），当前阶段：COMMANDER_TIMEOUT_REVIEW。
指挥官已运行 ${elapsed}ms，期间延长 ${extensions} 次。
允许的 decision 仅限：EXTEND | INTERRUPT | NEEDS_USER。
请通过结构化结果协议提交最终判断。
你的自然语言输出默认使用简体中文；decision 枚举、代码、命令、路径、provider/model ID 等机器标识保持原样。
模式：${mode}
遥测：${JSON.stringify(telemetry ?? {})}`

type CommanderOutcome =
  | { kind: 'decision'; decision: CommanderDecision }
  | { kind: 'interrupted'; reason: string }
  | { kind: 'needs_user'; reason: string }

export class OrbitSupervisor {
  private readonly store: OrbitStateStore
  private readonly host: OrbitHost
  private readonly config: OrbitSupervisorConfig
  /** Evidence for the step that just settled; never persisted into state.json. */
  private stepEvidence?: { stepId: string; bundle: OrbitEvidenceBundle }

  constructor(store: OrbitStateStore, host: OrbitHost, config: OrbitSupervisorConfig) {
    this.store = store
    this.host = host
    this.config = config
  }

  private now(): number {
    return this.host.now()
  }

  createState(input: OrbitRunInput): OrbitState {
    return createInitialState({
      runId: typeof input.run_id === 'string' && input.run_id.length > 0 ? input.run_id : randomUUID(),
      now: this.now(),
      goal: (input.goal ?? '').trim(),
      ...(input.preset !== undefined ? { preset: input.preset } : {}),
      routes: this.config.resolveRoutes?.() ?? this.config.defaultRoutes,
      ...(input.approved_loop_count !== undefined ? { approvedLoopCount: input.approved_loop_count } : {}),
      ...(input.max_loops !== undefined ? { maxLoops: input.max_loops } : {}),
      ...(input.user_hard_constraints ? { userHardConstraints: input.user_hard_constraints } : {}),
      githubAllowed: input.github_allowed === true,
    })
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
    if (state.phase === 'NEEDS_USER' && requestedGoal) {
      // A reply to the Commander's question is not a new goal: keep the run,
      // its original goal and its frozen routes, and carry the reply durably.
      resumeFromNeedsUser(state, requestedGoal)
      this.store.writeState(state)
    } else if (!legacy && requestedGoal && state.goal && state.goal !== requestedGoal) {
      return {
        ok: false,
        action: 'run',
        run_id: state.run_id,
        message: 'ORBIT_ACTIVE_RUN_EXISTS: current Lite run owns this project; resume it or stop it before starting a different goal.',
      }
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
        enterNeedsUser(state, 'EVALUATE_STEP_MISSING')
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
      enterBudgetExhausted(state, 'LOOP_BUDGET_EXHAUSTED')
      this.store.writeState(state)
      return this.result(state, false)
    }

    beginStep(state, step)
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
      COMMANDER_PLAN_PROMPT(state.goal, state.user_hard_constraints, userReplyLine(state)),
      COMMANDER_PLAN_SCHEMA,
      signal,
    )
    if (outcome.kind === 'needs_user') return this.setNeedsUser(state, outcome.reason)
    if (outcome.kind === 'interrupted') {
      recordPlanFailure(state, truncateSafe(outcome.reason, 500))
      this.store.writeState(state)
      return this.result(state, false, outcome.reason)
    }
    try {
      const plan = normalizePlan(outcome.structured as { summary?: unknown; steps?: unknown })
      applyPlan(state, plan)
      this.store.writeState(state)
      return undefined
    } catch (error) {
      const reason = truncateSafe(error instanceof Error ? error.message : String(error), 500)
      recordPlanFailure(state, reason)
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
    const evidence =
      this.evidenceFor(state, step) ?? state.commander?.summary ?? state.last_error ?? 'no evidence recorded'
    const prompt = final
      ? COMMANDER_FINAL_PROMPT(state.goal, state.plan, evidence, state)
      : COMMANDER_STEP_PROMPT(state.goal, step as OrbitPlanStep, evidence, state)
    const outcome = await this.runCommander(
      state,
      mode,
      prompt,
      final ? COMMANDER_FINAL_EVALUATE_SCHEMA : COMMANDER_STEP_EVALUATE_SCHEMA,
      signal,
    )
    if (outcome.kind === 'needs_user') return { kind: 'needs_user', reason: outcome.reason }
    if (outcome.kind === 'interrupted') return { kind: 'interrupted', reason: outcome.reason }
    try {
      const decision = assertCommanderDecision(outcome.structured as CommanderDecision, mode)
      return { kind: 'decision', decision }
    } catch (error) {
      // Invalid/temporary output is recoverable; it must not become NEEDS_USER.
      return { kind: 'interrupted', reason: truncateSafe(error instanceof Error ? error.message : String(error), 500) }
    }
  }

  /**
   * Format the settled step's evidence bundle. Only the step that just finished
   * qualifies; after a cold resume the bundle is gone and the caller falls back
   * to the durable state summary.
   */
  private evidenceFor(state: OrbitState, step: OrbitPlanStep | undefined): string | undefined {
    const stepId = step?.id ?? state.current_step?.id
    if (!this.stepEvidence || this.stepEvidence.stepId !== stepId) return undefined
    return formatEvidenceBundle(this.stepEvidence.bundle)
  }

  /**
   * The single adaptive Commander runner for PLAN, STEP_EVALUATE, FINAL_EVALUATE
   * and STRATEGY_RECONSIDER. 360s/600s soft reviews, 840s deterministic ceiling;
   * EXTEND always keeps the same child. Decisions arrive as DSH-native
   * structured results; a requested schema without a capture is a failure.
   */
  private async runCommander(
    state: OrbitState,
    mode: CommanderMode,
    prompt: string,
    outputSchema: ObjectJsonSchema,
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
        outputSchema,
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
          if (raced.value.structured === undefined) {
            return { kind: 'interrupted', reason: `${mode}_STRUCTURED_OUTPUT_MISSING` }
          }
          return { kind: 'output', output: raced.value.output, structured: raced.value.structured }
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
      outputSchema: WATCHDOG_TIMEOUT_SCHEMA,
      ...(signal ? { signal } : {}),
    })
    if (!result || result.interrupted) {
      return { decision: extensions === 0 ? 'EXTEND' : 'INTERRUPT', reason: 'Smart Watchdog unavailable' }
    }
    try {
      return assertTimeoutDecision(result.structured as TimeoutDecision)
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
      applyExecutorCapabilityUnavailable(state, step.id)
      this.store.writeState(state)
      return { done: false, ok: false }
    }

    let toolFilter: RoleToolFilter
    try {
      const capabilityTools = capabilities.includes('browser') ? [...this.config.browserTools] : []
      toolFilter = this.toolAllow([...this.config.executorTools, ...capabilityTools], `executor ${step.id}`)
    } catch (error) {
      const reason = truncateSafe(error instanceof Error ? error.message : String(error), 500)
      enterNeedsUser(state, reason)
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
      enterNeedsUser(state, reason)
      this.store.writeState(state)
      return { done: true, ok: false, message: reason }
    }

    const result = await this.awaitExecutor(handle, signal)

    if (result.interrupted) {
      const retries = applyExecutorInterrupted(state, {
        ...(result.childId ? { childId: result.childId } : {}),
        lastError: truncateSafe(result.reason ?? 'EXECUTOR_INTERRUPTED', 500),
      })
      this.store.writeState(state)

      if (signal?.aborted) return { done: true, ok: false, message: 'ORBIT_ABORTED' }
      if (result.reason === 'USER_HARD_SCOPE_VIOLATION') {
        enterNeedsUser(state)
        this.store.writeState(state)
        return { done: true, ok: false, message: 'USER_HARD_SCOPE_VIOLATION' }
      }
      const recovery = await this.runtimeWatchdog(state, step, result, retries, signal)
      if (recovery === 'needs_user') {
        enterNeedsUser(state)
        this.store.writeState(state)
        return { done: true, ok: false, message: state.last_error ?? undefined }
      }
      if (recovery === 'resume' && result.childId) {
        applyExecutorResume(state, result.childId)
        this.store.writeState(state)
        return { done: false, ok: false }
      }
      if (recovery === 'restart') {
        await this.cancelHandle(handle, 'ORBIT_RESTART_STEP')
        await this.disposeHandle(handle)
        clearExecutorChild(state)
        this.store.writeState(state)
        return { done: false, ok: false }
      }
      if (retries >= MAX_EXECUTOR_INTERRUPT_RETRIES) {
        enterNeedsUser(state, `EXECUTOR_INTERRUPTED: ${state.last_error ?? ''}`)
        this.store.writeState(state)
        return { done: true, ok: false, message: state.last_error ?? undefined }
      }
      return { done: false, ok: false }
    }

    applyExecutorSuccess(state, {
      ...(result.childId ? { childId: result.childId } : {}),
      summary: truncateSafe(result.output, 2000),
      changedFiles: result.changedFiles ?? this.host.changedFiles(join(this.store.stateDir, '..')),
      testSummary: result.testSummary ?? [],
    })
    this.stepEvidence = {
      stepId: step.id,
      bundle: buildEvidenceBundle({
        settlement: result.settlement,
        executorOutput: result.output,
        changedFiles: state.changed_files,
        tools: result.toolEvidence,
        telemetry: result.telemetry,
      }),
    }
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
      '你是 Orbit 执行员（Executor）。',
      '你只负责执行当前步骤：不要重新规划整个任务，也不要自行改变当前步骤的目标。',
      '必须使用真实工具完成实际操作，并对结果进行真实验证。',
      '完成后用简体中文提交简洁的执行证据：做了什么、运行了哪些命令/测试、验证结果以及仍存在的风险。',
      '你的自然语言输出、执行说明和总结默认全部使用简体中文；代码、命令、路径、provider/model ID 等机器标识保持原样。',
      `当前步骤 ${step.id}：${step.goal}`,
      `工作目录：${join(this.store.stateDir, '..')}`,
      `硬性约束：${state.user_hard_constraints.join('；') || '无'}`,
    ]
    if (state.pending_user_reply) lines.push(`用户回复（对上一个问题的回答）：${state.pending_user_reply}`)
    if ((step.capabilities ?? []).length > 0) lines.push(`Capabilities: ${(step.capabilities ?? []).join(', ')}`)
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
    clearGuardRecovery(state)

    if (outcome.kind === 'interrupted') {
      // Recoverable: the run stops and a later resume retries the same phase.
      state.last_error = truncateSafe(outcome.reason, 500)
      this.store.writeState(state)
      return this.result(state, false, outcome.reason)
    }
    if (outcome.kind === 'needs_user') return this.setNeedsUser(state, outcome.reason)
    const decision = outcome.decision

    if (decision.decision === 'NEEDS_USER') {
      applyCommanderNeedsUser(state, decision.reason ?? 'COMMANDER_NEEDS_USER')
      this.store.writeState(state)
      return this.result(state, false)
    }

    if (decision.decision === 'SUCCESS') {
      applyFinalSuccess(state, decision.summary)
      this.store.writeState(state)
      return this.result(state, true)
    }

    if (decision.decision === 'PASS_CURRENT_STEP') {
      applyStepPass(state, step, decision.summary)
      this.store.writeState(state)
      return undefined
    }

    if (decision.decision === 'CORRECT_CURRENT_STEP') {
      return this.applyCorrection(state, step as OrbitPlanStep, decision, signal)
    }

    if (decision.decision === 'APPEND') {
      const append = applyFinalAppend(state, decision)
      if (append === 'invalid') {
        return this.setNeedsUser(state, 'COMMANDER_EVALUATION_OUTPUT_INVALID: append needs next_steps or next_step_goal')
      }
      this.store.writeState(state)
      if (append === 'budget_exhausted') return this.result(state, false)
      return undefined
    }

    // FINAL_EVALUATE must not return PASS/CORRECT; assertCommanderDecision already rejects it.
    return this.setNeedsUser(state, 'COMMANDER_FINAL_DECISION_INVALID')
  }

  private setNeedsUser(state: OrbitState, reason: string): OrbitActionResult {
    enterNeedsUser(state, truncateSafe(reason, 500))
    this.store.writeState(state)
    return this.result(state, false)
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
    const blocked = correctionBlockCode(state, step)
    if (blocked) return this.setNeedsUser(state, blocked)

    let nextGoal = decision.next_step_goal
    if (correctionDepth === 1 && state.strategy_challenge?.base_step_id !== base) {
      const reconsider = await this.strategyChallenge(state, base, step, decision.reason ?? 'repeated correction', signal)
      if (reconsider.kind === 'needs_user') return this.setNeedsUser(state, reconsider.reason)
      if (reconsider.kind === 'interrupted') {
        // Temporary failure: keep the run resumable and do NOT consume the challenge.
        restoreEvaluationState(state, truncateSafe(reconsider.reason, 500))
        this.store.writeState(state)
        return this.result(state, false, reconsider.reason)
      }
      if (reconsider.kind === 'replace') nextGoal = reconsider.replacementGoal
    }

    applyCorrectionStep(state, step, {
      nextGoal,
      capabilities: decision.next_step_capabilities,
    })
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
      outputSchema: WATCHDOG_STRATEGY_SCHEMA,
      ...(signal ? { signal } : {}),
    })
    if (!challengeResult || challengeResult.interrupted) {
      return { kind: 'interrupted', reason: 'SMART_WATCHDOG_UNAVAILABLE' }
    }
    if (challengeResult.structured === undefined) {
      return { kind: 'interrupted', reason: 'SMART_WATCHDOG_STRATEGY_STRUCTURED_OUTPUT_MISSING' }
    }
    const challengeValue = challengeResult.structured as { question?: unknown }
    const challenge = typeof challengeValue.question === 'string' ? challengeValue.question.trim() : ''
    if (!challenge) return { kind: 'interrupted', reason: 'SMART_WATCHDOG_STRATEGY_OUTPUT_INVALID: question is required' }

    const outcome = await this.runCommander(
      state,
      'STRATEGY_RECONSIDER',
      COMMANDER_STRATEGY_PROMPT(state.goal, base, challenge, state),
      COMMANDER_STRATEGY_SCHEMA,
      signal,
    )
    if (outcome.kind === 'needs_user') return { kind: 'needs_user', reason: outcome.reason }
    if (outcome.kind === 'interrupted') return { kind: 'interrupted', reason: outcome.reason }
    try {
      const decision = assertStrategyDecision(outcome.structured as StrategyDecision)
      if (decision.decision === 'NEEDS_USER') return { kind: 'needs_user', reason: decision.reason ?? 'COMMANDER_STRATEGY_NEEDS_USER' }
      markStrategyChallengeUsed(state, base)
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
    const capReached = openWatchdogAttempt(state, step.id, {
      atCap: state.last_error?.slice(0, 500),
      attempt: truncateSafe(result.reason ?? state.last_error ?? '', 500),
    })
    if (capReached) {
      this.store.writeState(state)
      return 'needs_user'
    }
    this.store.writeState(state)

    const watchdogResult = await this.runAuxRole(state, {
      role: 'watchdog',
      label: 'watchdog-runtime',
      prompt: WATCHDOG_RUNTIME_PROMPT(step, result.reason ?? 'runtime failure', result.telemetry),
      outputSchema: WATCHDOG_RUNTIME_SCHEMA,
      ...(signal ? { signal } : {}),
    })
    if (!watchdogResult || watchdogResult.interrupted) {
      recordWatchdogDecision(state, 'UNAVAILABLE')
      this.store.writeState(state)
      return 'fallback'
    }

    let diagnosis: WatchdogDecision
    try {
      diagnosis = assertWatchdogDecision(watchdogResult.structured as WatchdogDecision)
    } catch {
      recordWatchdogDecision(state, 'UNAVAILABLE')
      this.store.writeState(state)
      return 'fallback'
    }

    recordWatchdogDecision(state, diagnosis.decision)
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
    const count = recordGuardRecovery(state, stepId, code)
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
      outputSchema: WATCHDOG_GUARD_SCHEMA,
    })
    if (!result || result.interrupted) return this.guardWatchdogFallback(count)
    try {
      return assertGuardWatchdogDecision(result.structured as GuardWatchdogDecision)
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
    enterNeedsUser(state, `ORBIT_GUARD_ESCALATION: ${reason.slice(0, 300)}`)
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
        ...(request.outputSchema ? { outputSchema: request.outputSchema } : {}),
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
    stopRun(state)
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
      pending_user_reply: state.pending_user_reply,
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

export { DEFAULT_CAPABILITIES }
