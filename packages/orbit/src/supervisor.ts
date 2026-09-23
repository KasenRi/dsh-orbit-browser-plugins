import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import { buildEvidenceBundle, buildStepResult, formatStepResults, formatEvidenceBundle, type OrbitEvidenceBundle } from './evidence.ts'
import {
  assertCommanderDecision,
  assertStrategyDecision,
  assertTimeoutDecision,
  assertWatchdogDecision,
  assertGuardWatchdogDecision,
  assertHeartbeatDecision,
  assertFinalAuditDecision,
  COMMANDER_FINAL_EVALUATE_SCHEMA,
  COMMANDER_PLAN_SCHEMA,
  COMMANDER_STEP_EVALUATE_SCHEMA,
  COMMANDER_STRATEGY_SCHEMA,
  WATCHDOG_GUARD_SCHEMA,
  WATCHDOG_HEARTBEAT_SCHEMA,
  WATCHDOG_FINAL_AUDIT_SCHEMA,
  WATCHDOG_RUNTIME_SCHEMA,
  WATCHDOG_STRATEGY_SCHEMA,
  WATCHDOG_TIMEOUT_SCHEMA,
  type EvaluationMode,
} from './decisions.ts'
import { ORBIT_COMMANDER_DECISION_TOOL, ORBIT_RUN_COMPLETE_TOOL, type ModelRunUsage, type OrbitHost, type RoleHandle, type RoleRunResult, type RoleToolFilter } from './host.ts'
import { OrbitMoaAdapter, type OrbitMoaAdapterLike } from './moa-adapter.ts'
import {
  applyCommanderNeedsUser,
  applyCorrectionStep,
  applyExecutorCapabilityUnavailable,
  applyExecutorInterrupted,
  applyExecutorResume,
  applyExecutorSuccess,
  applyFinalAppend,
  applyFinalAuditApproved,
  applyFinalAuditBlocked,
  applyFinalCandidate,
  applyFinalSuccess,
  applyTerminalConfirmation,
  completionGateIssue,
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
  ensureAutomaticLoopBudgetForPlan,
  hashGoal,
  markStrategyChallengeUsed,
  markMeaningfulProgress,
  normalizePlan,
  assertMoaPlanWithinPolicy,
  normalizeExecutionMode,
  openWatchdogAttempt,
  recordGuardRecovery,
  recordPlanFailure,
  recordWatchdogDecision,
  restoreEvaluationState,
  resumeFromNeedsUser,
  stopRun,
  upsertStepResult,
  normalizeCapabilities,
} from './kernel.ts'
import { truncateSafe } from './sanitize.ts'
import { OrbitStateStore } from './state-store.ts'
import { executorToolsFor, EXECUTOR_READ_ONLY_TOOLS, READ_ONLY_ROLE_TOOLS } from './capabilities.ts'
import {
  COMMANDER_EXTENSION_MS,
  COMMANDER_HARD_CEILING_MS,
  COMMANDER_SOFT_DEADLINE_MS,
  DEFAULT_CAPABILITIES,
  DEFAULT_HEARTBEAT_HEALTHY_INTERVAL_MS,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_HEARTBEAT_SUSPECT_INTERVAL_MS,
  EXECUTOR_TIMEOUT_MS,
  GUARD_ESCALATION_THRESHOLD,
  GUARD_FIRST_INSTRUCTION,
  GUARD_NEEDS_USER_INSTRUCTION,
  GUARD_RECOVERY_CAP,
  GUARD_REPEAT_INSTRUCTION,
  GUARD_RETRY_INSTRUCTION,
  MAX_EXECUTOR_INTERRUPT_RETRIES,
  MAX_FINAL_AUDIT_BLOCKS,
  MAX_WATCHDOG_CALLS_PER_STEP,
  WATCHDOG_TIMEOUT_MS,
  type CommanderDecision,
  type CommanderMode,
  type OrbitActionResult,
  type OrbitMoaPolicy,
  type OrbitMoaUsage,
  type OrbitPlanStep,
  type OrbitState,
  type OrbitTelemetry,
  type GuardCode,
  type GuardWatchdogDecision,
  type HeartbeatDecision,
  type FinalAuditDecision,
  type StrategyDecision,
  type TimeoutDecision,
  type WatchdogDecision,
  type TerminalCompletionSubmission,
} from './types.ts'
import { resolveEffectiveRoutes, type OrbitConfiguredRoutes } from './routes.ts'

export interface OrbitSupervisorConfig {
  defaultRoutes?: OrbitConfiguredRoutes
  /**
   * Resolve the role routes for a NEW run (settings + session selection).
   * Explicit profile routes are the headless fallback; an existing run always
   * resumes from its frozen `state.routes` and never calls this.
   */
  resolveRoutes?: () => OrbitState['routes']
  /** Resolve and freeze MoA policy/routes for a NEW run. */
  resolveMoaPolicy?: () => OrbitMoaPolicy | undefined
  /** Optional test seam; production uses the dsh-moa compatibility adapter. */
  moaAdapter?: OrbitMoaAdapterLike
  /**
   * Resolve the DSH Session driving the current operation. A NEW run records
   * it as `owner_session_id`; a NEEDS_USER continuation is only accepted when
   * the same Session asks again. Compositions without this seam cannot prove
   * ownership, so a waiting run is never resumed automatically.
   */
  resolveOwnerSessionId?: () => string | undefined
  browserTools: readonly string[]
  commanderReadOnlyTools: readonly string[]
  watchdogTools: readonly string[]
  executorTools: readonly string[]
  executorTimeoutMs?: number
  watchdogTimeoutMs?: number
  heartbeatEnabled?: boolean
  heartbeatIntervalMs?: number
  heartbeatHealthyIntervalMs?: number
  heartbeatSuspectIntervalMs?: number
  finalAuditEnabled?: boolean
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

type HeartbeatTarget = 'commander' | 'executor' | 'moa'

type HeartbeatWaitResult<T> =
  | { kind: 'work'; value: T }
  | { kind: 'timeout' }
  | { kind: 'aborted' }
  | { kind: 'restart_step'; reason: string }
  | { kind: 'rotate_commander'; reason: string }
  | { kind: 'needs_user'; reason: string }
  | { kind: 'runtime_bug'; reason: string }

const COMMANDER_PLAN_PROMPT = (goal: string, constraints: readonly string[], userReply: string, moaPolicy?: OrbitMoaPolicy) => `你是 Orbit 指挥官（Commander），当前阶段：PLAN。
请为下述目标制定最小化的 1-5 个逻辑工程步骤。
规则：基础读取不声明 capabilities；修改文件使用 "filesystem"，执行命令使用 "shell"，访问网页/API 使用 "web"，驱动真实浏览器使用 "browser"。只选择当前步骤真正需要的能力，可组合，保持最小化。
execution_mode 只能是 SINGLE 或 MOA。普通、确定性步骤使用 SINGLE；只有存在明显多解、高不确定性且独立候选比较能提高质量时才使用 MOA。${moaPolicy ? `当前 Run 已启用 MoA，最多 ${moaPolicy.max_moa_steps} 个 MOA 步骤，候选数固定为 ${moaPolicy.candidate_count}。` : '当前 Run 未启用 MoA，所有步骤必须使用 SINGLE。'}
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
证据语义：[TRUSTED_TOOL_EVENTS] 来自 Orbit Supervisor 对当前已结算 DSH tool/call + tool/result 的确定性提取，可视为真实发生过的工具事件；其中 tests 是从真实 shell 命令（包括 run_code 内可确定识别的字面 tools.bash 命令）与对应 tool/result 提取的测试证据。[EXECUTOR_SUMMARY_UNVERIFIED] 仍只是执行员自述，不能单独作为 PASS 依据。若可信工具事件已经包含所需 stdout/exit code/测试汇总，不要仅为了重复验证而要求 Commander 自己获得 shell 或创建临时证据文件。
允许的 decision 仅限：PASS_CURRENT_STEP | CORRECT_CURRENT_STEP | NEEDS_USER。
- CORRECT_CURRENT_STEP 必须给出具体的下一步目标（可选 capabilities）。
请通过结构化结果协议提交最终判断。
你的自然语言输出、推理说明和总结默认全部使用简体中文；decision 枚举、代码、命令、路径、provider/model ID 等机器标识保持原样。
原始目标：${goal}
当前步骤 ${step.id}：${step.goal}
执行模式：${normalizeExecutionMode(step.execution_mode)}
迭代计数：loop ${state.loop.used}/${state.loop.max}${userReplyLine(state)}
${state.heartbeat_watchdog?.strategy_review_requested ? `Heartbeat Watchdog 请求策略复核：${state.heartbeat_watchdog.last_reason ?? '请重新审视当前思路是否陷入重复或隧道视野。'}\n` : ''}Supervisor 执行证据：
${evidence}`

const COMMANDER_FINAL_PROMPT = (goal: string, plan: OrbitState['plan'], evidence: string, state: OrbitState) =>
  `你是 Orbit 指挥官（Commander），当前阶段：FINAL_EVALUATE。
所有计划步骤均已执行完毕。请依据真实项目状态判断原始目标是否真正达成。
证据语义：步骤 evidence 中的 [TRUSTED_TOOL_EVENTS] 来自 Orbit Supervisor 对已结算 DSH tool/call + tool/result 的确定性提取，可作为真实工具执行事实；[EXECUTOR_SUMMARY_UNVERIFIED] 只是模型总结。已有可信 stdout/exit code/测试汇总时，不要仅为了重复验证而要求 Commander 自己获得 shell 或额外落盘证据。
允许的 decision 仅限：SUCCESS | APPEND | NEEDS_USER。
- APPEND 必须给出新增步骤或下一步目标；追加受剩余 loop 预算限制。
请通过结构化结果协议提交最终判断。
你的自然语言输出、推理说明和总结默认全部使用简体中文；decision 枚举、代码、命令、路径、provider/model ID 等机器标识保持原样。
原始目标：${goal}
计划摘要：${plan.summary}
步骤：${plan.steps.map((step) => `${step.id}:${step.goal}[${step.status}/${normalizeExecutionMode(step.execution_mode)}]`).join('; ')}
Loop：${state.loop.used}/${state.loop.max}${userReplyLine(state)}
${state.commander?.remaining_gap ? `Final Watchdog 上次阻止关闭的缺口：${state.commander.remaining_gap}\n` : ''}Supervisor 执行证据：
${evidence}`

/**
 * The durable user reply line for role prompts. The reply is the user's answer
 * to a NEEDS_USER question and never replaces the original goal.
 */
function sumMoaUsage(items: Array<OrbitMoaUsage | undefined>): OrbitMoaUsage | undefined {
  const present = items.filter((item): item is OrbitMoaUsage => item !== undefined)
  if (present.length === 0) return undefined
  const costItems = present.filter((item) => item.cost_usd !== undefined)
  const completeCost = costItems.length === present.length
  return {
    input_tokens: present.reduce((sum, item) => sum + item.input_tokens, 0),
    output_tokens: present.reduce((sum, item) => sum + item.output_tokens, 0),
    total_tokens: present.reduce((sum, item) => sum + item.total_tokens, 0),
    ...(present.some((item) => item.cache_read_tokens !== undefined) ? { cache_read_tokens: present.reduce((sum, item) => sum + (item.cache_read_tokens ?? 0), 0) } : {}),
    ...(present.some((item) => item.cache_write_tokens !== undefined) ? { cache_write_tokens: present.reduce((sum, item) => sum + (item.cache_write_tokens ?? 0), 0) } : {}),
    ...(completeCost ? { cost_usd: Number(costItems.reduce((sum, item) => sum + (item.cost_usd ?? 0), 0).toFixed(6)) } : {}),
  }
}

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

const WATCHDOG_HEARTBEAT_PROMPT = (snapshot: Record<string, unknown>) =>
  `你是 Orbit 心跳监控模型（Heartbeat Watchdog），当前阶段：HEARTBEAT_REVIEW。
你的职责是主动检查 Orbit 是否仍在健康推进，而不是评审代码风格，也不是重新规划任务。
允许的 decision 仅限：HEALTHY | WAIT | RESTART_STEP | ROTATE_COMMANDER | STRATEGY_REVIEW | NEEDS_USER | RUNTIME_BUG。
规则：
- HEALTHY：存在明确、持续的有效进展，无需干预。
- WAIT：当前较慢或暂时缺少新事件，但仍有合理理由继续等待；下一次心跳应更快复查。
- RESTART_STEP：当前 Executor 明显卡死/失活，且重启当前 Step 比继续等待更安全。
- ROTATE_COMMANDER：当前 Commander 明显卡死/协议失效，应更换 Commander Session 后重试同一阶段。
- STRATEGY_REVIEW：系统仍活着，但出现反复/隧道视野；在下一次 Commander 评估时强制重新审视策略。
- NEEDS_USER：继续执行必须依赖用户信息或授权。
- RUNTIME_BUG：发现状态机/Session/Invariant 异常，继续自动执行风险过高。
不要监控 Watchdog 自己，不要直接执行项目操作，不要自行改变状态；只提交结构化判断。
你的自然语言输出默认使用简体中文；decision 枚举、代码、命令、路径、provider/model ID 等机器标识保持原样。
Supervisor 健康快照：${JSON.stringify(snapshot)}`

const WATCHDOG_FINAL_AUDIT_PROMPT = (goal: string, state: OrbitState, fingerprint: string) =>
  `你是 Orbit 最终关闭审计 Watchdog，当前阶段：FINAL_AUDIT。
Commander 已认为目标完成，但 Run 尚未关闭。请独立检查是否允许进入最终停机确认。
你只能依据原始目标、计划状态、durable step_results / trusted evidence、当前错误和角色状态判断；不要重新执行任务。
允许的 decision 仅限：APPROVE_CLOSE | BLOCK_CLOSE | NEEDS_USER | RUNTIME_BUG。
- APPROVE_CLOSE：原始目标已经有充分证据达成，且没有明显未完成工作。
- BLOCK_CLOSE：证据不足或仍存在明确缺口；reason 必须说明缺口，后续由 Commander 决定 APPEND / NEEDS_USER。
- NEEDS_USER：最终闭环需要用户信息或确认。
- RUNTIME_BUG：状态机/Session/invariant 异常，不能安全关闭。
请通过结构化结果协议提交最终判断。
目标：${goal}
审计指纹：${fingerprint}
状态摘要：${JSON.stringify({
    phase: state.phase,
    loop: state.loop,
    plan: state.plan,
    step_results: state.step_results,
    last_error: state.last_error,
    recovered_error: state.recovered_error,
    role_sessions: state.role_sessions,
    moa_step: state.moa_step,
  })}`

const COMMANDER_TERMINAL_CONFIRM_PROMPT = (goal: string, auditReason: string | undefined) =>
  `你是 Orbit 指挥官（Commander），当前阶段：TERMINAL_CONFIRM。
原始目标已经完成计划步骤，且 Final Watchdog 已批准进入最终停机确认。
现在只进行生命周期终止确认，不要重新执行项目，不要重新规划，不要调用读取/写入/shell/web/browser 工具。
如果你确认：原始目标已达成、没有未完成步骤、不需要追加工作、不需要用户输入，请调用 orbit_run_complete 并提交 signal=COMPLETE。
如果你认为仍不应停止，请调用 orbit_run_complete 并提交 signal=NOT_COMPLETE，同时说明 reason。
普通文本（包括“完成”二字）绝不能替代这个工具调用。
原始目标：${goal}
Final Watchdog：APPROVE_CLOSE${auditReason ? `；${auditReason}` : ''}`

type CommanderOutcome =
  | { kind: 'decision'; decision: CommanderDecision; output: string }
  | { kind: 'interrupted'; reason: string }
  | { kind: 'needs_user'; reason: string }

export class OrbitSupervisor {
  private readonly store: OrbitStateStore
  private readonly host: OrbitHost
  private readonly config: OrbitSupervisorConfig
  private readonly moa: OrbitMoaAdapterLike
  /** Evidence for the step that just settled; never persisted into state.json. */
  private stepEvidence?: { stepId: string; bundle: OrbitEvidenceBundle }

  constructor(store: OrbitStateStore, host: OrbitHost, config: OrbitSupervisorConfig) {
    this.store = store
    this.host = host
    this.config = config
    this.moa = config.moaAdapter ?? new OrbitMoaAdapter(host)
  }

  private now(): number {
    return this.host.now()
  }

  createState(input: OrbitRunInput): OrbitState {
    const ownerSessionId = this.config.resolveOwnerSessionId?.()
    const moaPolicy = this.config.resolveMoaPolicy?.()
    const state = createInitialState({
      runId: typeof input.run_id === 'string' && input.run_id.length > 0 ? input.run_id : randomUUID(),
      now: this.now(),
      goal: (input.goal ?? '').trim(),
      ...(input.preset !== undefined ? { preset: input.preset } : {}),
      routes: this.resolveNewRoutes(),
      ...(moaPolicy ? { moaPolicy } : {}),
      ...(input.approved_loop_count !== undefined ? { approvedLoopCount: input.approved_loop_count } : {}),
      ...(input.max_loops !== undefined ? { maxLoops: input.max_loops } : {}),
      ...(input.user_hard_constraints ? { userHardConstraints: input.user_hard_constraints } : {}),
      githubAllowed: input.github_allowed === true,
      ...(ownerSessionId === undefined ? {} : { ownerSessionId }),
    })
    const interval = Math.max(1_000, this.config.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS)
    const healthyInterval = Math.max(interval, this.config.heartbeatHealthyIntervalMs ?? DEFAULT_HEARTBEAT_HEALTHY_INTERVAL_MS)
    const suspectInterval = Math.max(1_000, Math.min(interval, this.config.heartbeatSuspectIntervalMs ?? DEFAULT_HEARTBEAT_SUSPECT_INTERVAL_MS))
    state.heartbeat_watchdog = {
      enabled: this.config.heartbeatEnabled === true,
      sequence: 0,
      interval_ms: interval,
      healthy_interval_ms: healthyInterval,
      suspect_interval_ms: suspectInterval,
      healthy_streak: 0,
      anomaly_streak: 0,
      observed_progress_seq: state.progress?.seq ?? 0,
      next_at: new Date(this.now() + interval).toISOString(),
    }
    return state
  }

  private resolveNewRoutes(): OrbitState['routes'] {
    if (this.config.resolveRoutes) return this.config.resolveRoutes()
    return resolveEffectiveRoutes({ configRoutes: this.config.defaultRoutes })
  }

  private async preflightRoutes(state: Pick<OrbitState, 'routes' | 'moa_policy'>, signal?: AbortSignal): Promise<string | undefined> {
    const routes: Record<string, import('./types.ts').OrbitRoute> = { ...state.routes }
    const policy = state.moa_policy
    if (policy) {
      policy.candidates.forEach((route, index) => { routes['moa_candidate_' + (index + 1)] = route })
      routes.moa_judge = policy.judge
    }
    const issues = await this.host.validateRoutes(routes, signal)
    if (issues.length > 0) return `ORBIT_ROLE_MODEL_UNAVAILABLE: ${issues.join('；')}。请重新选择可用模型。`
    if (policy) {
      const availability = await this.moa.availability()
      if (!availability.available) return availability.reason ?? 'ORBIT_MOA_UNAVAILABLE'
    }
    return undefined
  }

  async bootstrap(input: OrbitRunInput, signal?: AbortSignal): Promise<OrbitActionResult> {
    if (signal?.aborted) return { ok: false, action: 'run', message: 'ORBIT_ABORTED' }
    const competitors = await this.host.otherMutationDrivers(join(this.store.stateDir, '..'))
    if (competitors.length > 0) return {
      ok: false, action: 'run', message: `ORBIT_MUTATION_DRIVER_CONFLICT: ${competitors.join(', ')} 已持有此 workspace 的修改权。`,
    }
    const requestedGoal = (input.goal ?? '').trim()
    let state = this.store.readState()
    const raw = this.store.readRawState()
    const legacy = raw !== null && Number(raw['schema_version'] ?? 0) < 2

    if (legacy && requestedGoal) {
      let created: OrbitState
      try { created = this.createState(input) } catch (error) {
        return { ok: false, action: 'run', message: error instanceof Error ? error.message : String(error) }
      }
      const invalid = await this.preflightRoutes(created, signal)
      if (invalid) return { ok: false, action: 'run', message: invalid }
      state = this.store.writeState(created)
    } else if (!state) {
      if (!requestedGoal) return { ok: false, action: 'run', message: 'ORBIT_GOAL_REQUIRED: 请提供要执行的目标。' }
      let created: OrbitState
      try { created = this.createState(input) } catch (error) {
        return { ok: false, action: 'run', message: error instanceof Error ? error.message : String(error) }
      }
      const invalid = await this.preflightRoutes(created, signal)
      if (invalid) return { ok: false, action: 'run', message: invalid }
      state = this.store.writeState(created)
    } else if (input.run_id && input.run_id !== state.run_id && !legacy) {
      return { ok: false, action: 'run', message: `ORBIT_RUN_NOT_FOUND: ${input.run_id}` }
    }

    if (['SUCCESS', 'STOPPED', 'BUDGET_EXHAUSTED'].includes(state.phase) && requestedGoal) {
      let created: OrbitState
      try { created = this.createState(input) } catch (error) {
        return { ok: false, action: 'run', message: error instanceof Error ? error.message : String(error) }
      }
      const invalid = await this.preflightRoutes(created, signal)
      if (invalid) return { ok: false, action: 'run', message: invalid }
      state = this.store.writeState(created)
    }
    if (state.phase === 'NEEDS_USER' && requestedGoal) {
      // A reply to the Commander's question is not a new goal: keep the run,
      // its original goal and its frozen routes, and carry the reply durably —
      // but only from the Session that owns the run. Another Session's message
      // must never be consumed as this run's reply.
      const owner = state.owner_session_id
      const incoming = this.config.resolveOwnerSessionId?.()
      if (owner === undefined) {
        return {
          ok: false, action: 'run', run_id: state.run_id, phase: state.phase,
          message: `ORBIT_NEEDS_USER_OWNER_UNKNOWN: 这是升级前遗留 Run ${state.run_id}，无法安全判断所属 Session。请显式 resume，或 stop 后重新开始。`,
        }
      }
      if (incoming === undefined || incoming !== owner) {
        return {
          ok: false,
          action: 'run',
          run_id: state.run_id,
          phase: state.phase,
          message:
            `ORBIT_NEEDS_USER_OTHER_SESSION: Run ${state.run_id}（goal: ${truncateSafe(state.goal, 120)}）仍在等待所属 Session 的用户回复；` +
            '当前消息未被当作回复。请在原 Session 回复，或显式 stop/resume。',
        }
      }
      resumeFromNeedsUser(state, requestedGoal)
      this.store.writeState(state)
    } else if (!legacy && requestedGoal && state.goal && state.goal !== requestedGoal) {
      return {
        ok: false,
        action: 'run',
        run_id: state.run_id,
        message: 'ORBIT_ACTIVE_RUN_EXISTS: 当前项目已有活动中的 Orbit Run，请先继续或停止该 Run。',
      }
    }
    return this.run(state, signal)
  }

  async run(state: OrbitState, signal?: AbortSignal, preflight = true): Promise<OrbitActionResult> {
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
        message: `ORBIT_MUTATION_DRIVER_CONFLICT: ${competitors.join(', ')} 已持有此 workspace 的修改权。`,
      }
    }

    if (state.phase === 'NEEDS_USER') return this.result(state, true, 'ORBIT_AWAITING_USER')
    if (state.phase === 'SUCCESS') return this.result(state, true)
    if (state.phase === 'STOPPED') return this.result(state, true)
    if (state.phase === 'BUDGET_EXHAUSTED') return this.result(state, true)

    if (preflight) {
      const routeIssue = await this.preflightRoutes(state, signal)
      if (routeIssue) return this.result(state, false, routeIssue)
    }

    const hadHeartbeat = state.heartbeat_watchdog !== undefined && state.progress !== undefined
    this.ensureHeartbeatState(state)
    if (!hadHeartbeat) this.store.writeState(state)

    if (state.phase === 'FINAL_VERIFY') {
      const audited = await this.runFinalAudit(state, signal)
      if (audited) return audited
      return this.run(state, signal, false)
    }

    if (state.phase === 'TERMINAL_CONFIRM') {
      const confirmed = await this.runTerminalConfirm(state, signal)
      if (confirmed) return confirmed
      return this.run(state, signal, false)
    }

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
      return this.run(state, signal, false)
    }

    const step =
      state.plan.steps.find((candidate) => candidate.status === 'running') ??
      state.plan.steps.find((candidate) => candidate.status === 'pending')

    if (!step) {
      const outcome = await this.commanderEvaluate(state, undefined, true, signal)
      const applied = await this.applyCommanderOutcome(state, outcome, undefined, true, signal)
      if (applied) return applied
      return this.run(state, signal, false)
    }

    if (state.loop.used >= state.loop.max) {
      enterBudgetExhausted(state, 'LOOP_BUDGET_EXHAUSTED')
      this.store.writeState(state)
      return this.result(state, false)
    }

    beginStep(state, step)
    this.markProgress(state)
    this.store.writeState(state)

    const executed = await this.executeStep(state, step, signal)
    if (executed.done) return this.result(state, executed.ok, executed.message)
    return this.run(state, signal, false)
  }

  // ── tool scoping ───────────────────────────────────────────────────────────

  /**
   * Build an allow-filter from configured names, keeping only tools that are
   * actually registered (an unknown name makes `tools.restrict()` fail).
   */
  private toolAllow(names: readonly string[], label: string): RoleToolFilter {
    const allowed = names.filter((name) => this.host.hasTool(name))
    if (allowed.length === 0) {
      throw new Error(`ORBIT_TOOL_FILTER_EMPTY: ${label} 没有任何已注册的允许工具：[${names.join(', ')}]`)
    }
    return { allow: allowed }
  }

  private grantFingerprint(filter: RoleToolFilter): string {
    return [...(filter.allow ?? [])].sort().join('|')
  }

  private resumeRoleId(state: OrbitState, role: 'commander' | 'executor', fingerprint?: string): string | undefined {
    const session = state.role_sessions?.[role]
    if (!session || session.needs_rotation === true) return undefined
    if (role === 'executor' && fingerprint !== undefined && session.grant_fingerprint !== fingerprint) return undefined
    return session.child_id || undefined
  }

  private bindRoleSession(
    state: OrbitState,
    role: 'commander' | 'executor',
    childId: string,
    options: { fingerprint?: string; stepId?: string } = {},
  ): void {
    state.role_sessions ??= {}
    const previous = state.role_sessions[role]
    const same = previous?.child_id === childId && previous.needs_rotation !== true
    const next = same
      ? previous
      : {
          child_id: childId,
          generation: (previous?.generation ?? 0) + 1,
          turns: 0,
          resets: previous?.resets ?? 0,
          ...(previous?.last_reset_reason ? { last_reset_reason: previous.last_reset_reason } : {}),
          ...(previous?.usage ? { usage: previous.usage } : {}),
        }
    next.child_id = childId
    next.needs_rotation = false
    if (options.fingerprint !== undefined) next.grant_fingerprint = options.fingerprint
    if (options.stepId !== undefined) next.last_step_id = options.stepId
    state.role_sessions[role] = next
  }

  private rotateRoleSession(state: OrbitState, role: 'commander' | 'executor', reason: string): void {
    const current = state.role_sessions?.[role]
    if (!current) return
    current.needs_rotation = true
    current.resets += 1
    current.last_reset_reason = truncateSafe(reason, 160)
  }

  private recordRoleTurn(
    state: OrbitState,
    role: 'commander' | 'executor',
    usage?: ModelRunUsage,
    stepId?: string,
  ): void {
    const current = state.role_sessions?.[role]
    if (!current) return
    current.turns += 1
    if (stepId !== undefined) current.last_step_id = stepId
    if (!usage) return
    const prior = current.usage ?? { input_tokens: 0, output_tokens: 0, total_tokens: 0 }
    current.usage = {
      input_tokens: prior.input_tokens + usage.inputTokens,
      output_tokens: prior.output_tokens + usage.outputTokens,
      total_tokens: prior.total_tokens + (usage.totalTokens ?? usage.inputTokens + usage.outputTokens),
      ...(prior.cache_read_tokens !== undefined || usage.cacheReadTokens !== undefined
        ? { cache_read_tokens: (prior.cache_read_tokens ?? 0) + (usage.cacheReadTokens ?? 0) }
        : {}),
      ...(prior.cache_write_tokens !== undefined || usage.cacheWriteTokens !== undefined
        ? { cache_write_tokens: (prior.cache_write_tokens ?? 0) + (usage.cacheWriteTokens ?? 0) }
        : {}),
    }
  }

  private markProgress(state: OrbitState): void {
    markMeaningfulProgress(state, this.now())
  }

  private ensureHeartbeatState(state: OrbitState): NonNullable<OrbitState['heartbeat_watchdog']> {
    if (!state.progress) state.progress = { seq: 0, at: new Date(this.now()).toISOString() }
    if (!state.heartbeat_watchdog) {
      const interval = Math.max(1_000, this.config.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS)
      const healthyInterval = Math.max(interval, this.config.heartbeatHealthyIntervalMs ?? DEFAULT_HEARTBEAT_HEALTHY_INTERVAL_MS)
      const suspectInterval = Math.max(1_000, Math.min(interval, this.config.heartbeatSuspectIntervalMs ?? DEFAULT_HEARTBEAT_SUSPECT_INTERVAL_MS))
      state.heartbeat_watchdog = {
        enabled: this.config.heartbeatEnabled === true,
        sequence: 0,
        interval_ms: interval,
        healthy_interval_ms: healthyInterval,
        suspect_interval_ms: suspectInterval,
        healthy_streak: 0,
        anomaly_streak: 0,
        observed_progress_seq: state.progress.seq,
        next_at: new Date(this.now() + interval).toISOString(),
      }
    }
    return state.heartbeat_watchdog
  }

  private runtimeSignature(telemetry: OrbitTelemetry | undefined): string {
    if (!telemetry) return 'none'
    return hashGoal(JSON.stringify({
      status: telemetry.status,
      current_tool: telemetry.current_tool,
      tool_count: telemetry.tool_count,
      turn_count: telemetry.turn_count,
      activity_state: telemetry.activity_state,
      recent_output: telemetry.recent_output?.slice(-800),
    }))
  }

  private heartbeatTargetFingerprint(
    state: OrbitState,
    target: HeartbeatTarget,
    childId?: string,
  ): string {
    return hashGoal(JSON.stringify({
      run_id: state.run_id,
      phase: state.phase,
      step: state.current_step,
      progress_seq: state.progress?.seq ?? 0,
      child: state.child,
      target,
      child_id: childId,
      commander: state.role_sessions?.commander
        ? {
            child_id: state.role_sessions.commander.child_id,
            generation: state.role_sessions.commander.generation,
            needs_rotation: state.role_sessions.commander.needs_rotation,
          }
        : undefined,
      executor: state.role_sessions?.executor
        ? {
            child_id: state.role_sessions.executor.child_id,
            generation: state.role_sessions.executor.generation,
            needs_rotation: state.role_sessions.executor.needs_rotation,
            last_step_id: state.role_sessions.executor.last_step_id,
          }
        : undefined,
      moa: state.moa_step ? { step_id: state.moa_step.step_id, phase: state.moa_step.phase } : undefined,
    }))
  }

  private completionFingerprint(state: OrbitState): string {
    return hashGoal(JSON.stringify({
      run_id: state.run_id,
      progress_seq: state.progress?.seq ?? 0,
      plan: state.plan.steps.map((step) => ({ id: step.id, status: step.status })),
      results: (state.step_results ?? []).map((result) => ({
        step_id: result.step_id,
        attempt: result.attempt,
        test_summary: result.test_summary,
        changed_files: result.changed_files,
        evidence: result.evidence,
      })),
      child: state.child,
      pending_user_reply: state.pending_user_reply,
      executor_generation: state.role_sessions?.executor?.generation,
      executor_child: state.role_sessions?.executor?.child_id,
      moa: state.moa_step ? { step_id: state.moa_step.step_id, phase: state.moa_step.phase } : undefined,
    }))
  }

  private invariantIssues(state: OrbitState): string[] {
    const issues: string[] = []
    const running = state.plan.steps.filter((step) => step.status === 'running')
    if (running.length > 1) issues.push('ORBIT_INVARIANT_MULTIPLE_RUNNING_STEPS')
    if (state.phase === 'EVALUATE' && state.current_step && !state.plan.steps.some((step) => step.id === state.current_step?.id)) {
      issues.push('ORBIT_INVARIANT_CURRENT_STEP_MISSING')
    }
    if (state.phase === 'SUCCESS' && (state.status !== 'success' || state.driver_ownership !== 'CLOSED')) {
      issues.push('ORBIT_INVARIANT_SUCCESS_NOT_CLOSED')
    }
    if (state.phase === 'FINAL_VERIFY' || state.phase === 'TERMINAL_CONFIRM') {
      if (state.plan.steps.some((step) => step.status !== 'passed')) issues.push('ORBIT_INVARIANT_FINAL_WITH_UNPASSED_STEP')
    }
    if (state.role_sessions?.executor?.needs_rotation === false && !state.role_sessions.executor.child_id) {
      issues.push('ORBIT_INVARIANT_EXECUTOR_ID_MISSING')
    }
    return issues
  }

  private heartbeatSnapshot(
    state: OrbitState,
    target: HeartbeatTarget,
    telemetry: OrbitTelemetry | undefined,
    childId?: string,
  ): Record<string, unknown> {
    const heartbeat = this.ensureHeartbeatState(state)
    const now = this.now()
    const progressAt = Date.parse(state.progress?.at ?? '')
    const previousRuntimeSignature = heartbeat.last_runtime_signature
    const runtimeSignature = this.runtimeSignature(telemetry)
    return {
      run: {
        run_id: state.run_id,
        phase: state.phase,
        status: state.status,
        loop: state.loop,
      },
      target,
      step: state.current_step,
      progress: {
        seq: state.progress?.seq ?? 0,
        last_progress_age_ms: Number.isNaN(progressAt) ? undefined : Math.max(0, now - progressAt),
        changed_since_last_heartbeat: (state.progress?.seq ?? 0) !== (heartbeat.observed_progress_seq ?? -1),
      },
      runtime: {
        child_id: childId,
        telemetry: telemetry ?? {},
        changed_since_last_heartbeat: previousRuntimeSignature !== undefined && previousRuntimeSignature !== runtimeSignature,
      },
      commander: state.role_sessions?.commander,
      executor: state.role_sessions?.executor,
      moa: state.moa_step,
      invariants: this.invariantIssues(state),
      last_error: state.last_error,
    }
  }

  private scheduleNextHeartbeat(state: OrbitState, decision: HeartbeatDecision['decision'] | 'STALE_HEARTBEAT' | 'UNAVAILABLE'): void {
    const heartbeat = this.ensureHeartbeatState(state)
    let delay = heartbeat.interval_ms
    if (decision === 'HEALTHY') {
      heartbeat.healthy_streak += 1
      heartbeat.anomaly_streak = 0
      delay = heartbeat.healthy_streak >= 3 ? heartbeat.healthy_interval_ms : heartbeat.interval_ms
    } else if (decision === 'STALE_HEARTBEAT') {
      delay = heartbeat.interval_ms
    } else {
      heartbeat.healthy_streak = 0
      heartbeat.anomaly_streak += 1
      delay = heartbeat.suspect_interval_ms
    }
    heartbeat.next_at = new Date(this.now() + delay).toISOString()
  }

  private async heartbeatReview(
    state: OrbitState,
    target: HeartbeatTarget,
    telemetry: OrbitTelemetry | undefined,
    childId: string | undefined,
    signal?: AbortSignal,
  ): Promise<HeartbeatDecision | undefined> {
    const heartbeat = this.ensureHeartbeatState(state)
    if (!heartbeat.enabled) return undefined

    const snapshot = this.heartbeatSnapshot(state, target, telemetry, childId)
    const before = this.heartbeatTargetFingerprint(state, target, childId)
    heartbeat.sequence += 1
    heartbeat.last_at = new Date(this.now()).toISOString()
    heartbeat.observed_progress_seq = state.progress?.seq ?? 0
    heartbeat.last_runtime_signature = this.runtimeSignature(telemetry)
    this.store.writeState(state)

    const result = await this.runAuxRole(state, {
      role: 'watchdog',
      label: 'watchdog-heartbeat',
      prompt: WATCHDOG_HEARTBEAT_PROMPT(snapshot),
      outputSchema: WATCHDOG_HEARTBEAT_SCHEMA,
      ...(signal ? { signal } : {}),
    })
    if (!result || result.interrupted || result.structured === undefined) {
      heartbeat.last_decision = 'UNAVAILABLE'
      heartbeat.last_reason = truncateSafe(result?.reason ?? 'HEARTBEAT_WATCHDOG_UNAVAILABLE', 300)
      this.scheduleNextHeartbeat(state, 'UNAVAILABLE')
      this.store.writeState(state)
      return undefined
    }

    let decision: HeartbeatDecision
    try {
      decision = assertHeartbeatDecision(result.structured as HeartbeatDecision)
    } catch (error) {
      heartbeat.last_decision = 'UNAVAILABLE'
      heartbeat.last_reason = truncateSafe(error instanceof Error ? error.message : String(error), 300)
      this.scheduleNextHeartbeat(state, 'UNAVAILABLE')
      this.store.writeState(state)
      return undefined
    }

    if (before !== this.heartbeatTargetFingerprint(state, target, childId)) {
      heartbeat.last_decision = 'STALE_HEARTBEAT'
      heartbeat.last_reason = '运行状态已在 Watchdog 返回前发生变化，丢弃旧决策。'
      this.scheduleNextHeartbeat(state, 'STALE_HEARTBEAT')
      this.store.writeState(state)
      return undefined
    }

    heartbeat.last_decision = decision.decision
    heartbeat.last_reason = decision.reason ? truncateSafe(decision.reason, 300) : undefined
    if (decision.decision === 'STRATEGY_REVIEW') heartbeat.strategy_review_requested = true
    this.scheduleNextHeartbeat(state, decision.decision)
    this.store.writeState(state)
    return decision
  }

  private async waitWithHeartbeat<T>(
    state: OrbitState,
    target: HeartbeatTarget,
    work: Promise<T>,
    timeoutMs: number,
    signal?: AbortSignal,
    handle?: RoleHandle,
  ): Promise<HeartbeatWaitResult<T>> {
    const heartbeat = this.ensureHeartbeatState(state)
    const deadline = this.now() + Math.max(0, timeoutMs)
    let settled = false
    const tracked = work.then(
      (value) => {
        settled = true
        return { ok: true as const, value }
      },
      (error: unknown) => {
        settled = true
        return { ok: false as const, error }
      },
    )

    for (;;) {
      if (signal?.aborted) return { kind: 'aborted' }
      const remaining = Math.max(0, deadline - this.now())
      if (remaining <= 0) return { kind: 'timeout' }

      const nextAt = heartbeat.enabled ? Date.parse(heartbeat.next_at ?? '') : Number.NaN
      const untilHeartbeat = heartbeat.enabled && !Number.isNaN(nextAt) ? Math.max(0, nextAt - this.now()) : remaining
      const raced = await this.raceWithSleep(tracked, Math.min(remaining, untilHeartbeat), signal)
      if (raced.kind === 'work') {
        if (!raced.value.ok) throw raced.value.error
        return { kind: 'work', value: raced.value.value }
      }
      if (raced.kind === 'aborted' || signal?.aborted) return { kind: 'aborted' }
      if (this.now() >= deadline) return { kind: 'timeout' }
      if (!heartbeat.enabled) continue

      const telemetry = await handle?.runtimeSnapshot?.()
      const childId = handle?.childId
      const decision = await this.heartbeatReview(state, target, telemetry, childId, signal)
      if (settled) {
        const hb = this.ensureHeartbeatState(state)
        hb.last_decision = 'STALE_HEARTBEAT'
        hb.last_reason = '目标角色已在 Heartbeat 检查期间结算，丢弃 Watchdog 决策。'
        this.scheduleNextHeartbeat(state, 'STALE_HEARTBEAT')
        this.store.writeState(state)
        continue
      }
      if (!decision || decision.decision === 'HEALTHY' || decision.decision === 'WAIT' || decision.decision === 'STRATEGY_REVIEW') continue
      const reason = decision.reason ?? decision.decision
      if (decision.decision === 'RESTART_STEP') {
        if (target === 'commander') return { kind: 'rotate_commander', reason: `Watchdog requested RESTART_STEP while Commander was active: ${reason}` }
        return { kind: 'restart_step', reason }
      }
      if (decision.decision === 'ROTATE_COMMANDER') {
        if (target === 'commander') return { kind: 'rotate_commander', reason }
        this.rotateRoleSession(state, 'commander', `HEARTBEAT_ROTATE_COMMANDER:${truncateSafe(reason, 120)}`)
        this.store.writeState(state)
        continue
      }
      if (decision.decision === 'NEEDS_USER') return { kind: 'needs_user', reason }
      return { kind: 'runtime_bug', reason }
    }
  }

  // ── commander supervised path ──────────────────────────────────────────────

  private async makePlan(state: OrbitState, signal?: AbortSignal): Promise<OrbitActionResult | undefined> {
    const outcome = await this.runCommander(
      state,
      'PLAN',
      COMMANDER_PLAN_PROMPT(state.goal, state.user_hard_constraints, userReplyLine(state), state.moa_policy),
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
      assertMoaPlanWithinPolicy(plan, state.moa_policy)
      applyPlan(state, plan)
      ensureAutomaticLoopBudgetForPlan(state)
      this.markProgress(state)
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
      this.evidenceFor(state, step, final) ?? state.commander?.summary ?? state.last_error ?? '未记录执行证据'
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
      return { kind: 'decision', decision, output: outcome.output }
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
  private evidenceFor(state: OrbitState, step: OrbitPlanStep | undefined, final = false): string | undefined {
    if (final) return formatStepResults(state)
    const stepId = step?.id ?? state.current_step?.id
    if (this.stepEvidence && this.stepEvidence.stepId === stepId) return formatEvidenceBundle(this.stepEvidence.bundle)
    return state.step_results?.find((entry) => entry.step_id === stepId)?.evidence
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
    heartbeatRotations = 0,
  ): Promise<SupervisedResult> {
    const startedAt = this.now()
    const commanderTools = [
      ...this.config.commanderReadOnlyTools.filter((name) => (READ_ONLY_ROLE_TOOLS as readonly string[]).includes(name)),
      ORBIT_COMMANDER_DECISION_TOOL,
      ORBIT_RUN_COMPLETE_TOOL,
    ]
    const toolFilter = this.toolAllow(commanderTools, `commander ${mode}`)
    const resumeOf = this.resumeRoleId(state, 'commander')
    const persistentPrompt = [
      prompt,
      '',
      `持续会话协议：你正在同一个 Orbit Commander Session 中继续工作。不要重新探索已经掌握的项目背景；只补充读取当前判断真正需要的新事实。`,
      `完成判断后必须调用 ${ORBIT_COMMANDER_DECISION_TOOL}，mode 必须是 ${mode}。不要用普通文本代替结构化提交。`,
      '除该内部提交工具外，不要调用任何会修改项目的工具。',
    ].join('\n')
    const start = (childId?: string) => this.host.startRole({
      role: 'commander',
      label: 'orbit-commander',
      prompt: persistentPrompt,
      route: state.routes.commander,
      workspace: join(this.store.stateDir, '..'),
      toolFilter,
      outputSchema,
      persistent: true,
      commanderMode: mode,
      ...(childId ? { resumeOf: childId } : {}),
      ...(signal ? { signal } : {}),
    })
    let handle: RoleHandle
    try {
      handle = await start(resumeOf)
    } catch (error) {
      if (!resumeOf) return { kind: 'interrupted', reason: truncateSafe(error instanceof Error ? error.message : String(error), 500) }
      this.rotateRoleSession(state, 'commander', `COMMANDER_RESUME_FAILED:${truncateSafe(error instanceof Error ? error.message : String(error), 120)}`)
      this.store.writeState(state)
      try {
        handle = await start()
      } catch (retryError) {
        return { kind: 'interrupted', reason: truncateSafe(retryError instanceof Error ? retryError.message : String(retryError), 500) }
      }
    }
    if (handle.childId) {
      this.bindRoleSession(state, 'commander', handle.childId)
      this.store.writeState(state)
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
        const raced = await this.waitWithHeartbeat(state, 'commander', handle.result, remaining, signal, handle)
        if (raced.kind === 'work') {
          this.recordRoleTurn(state, 'commander', raced.value.tokenUsage)
          if (raced.value.interrupted) {
            this.rotateRoleSession(state, 'commander', raced.value.reason ?? `${mode}_INTERRUPTED`)
            this.store.writeState(state)
            return { kind: 'interrupted', reason: raced.value.reason ?? `${mode}_INTERRUPTED` }
          }
          if (raced.value.structured === undefined) {
            this.rotateRoleSession(state, 'commander', `${mode}_STRUCTURED_OUTPUT_MISSING`)
            this.store.writeState(state)
            return { kind: 'interrupted', reason: `${mode}_STRUCTURED_OUTPUT_MISSING` }
          }
          this.store.writeState(state)
          return { kind: 'output', output: raced.value.visibleOutput ?? raced.value.output, structured: raced.value.structured }
        }
        if (raced.kind === 'aborted' || signal?.aborted) {
          await this.cancelHandle(handle, 'ORBIT_ABORTED')
          this.rotateRoleSession(state, 'commander', 'ORBIT_ABORTED')
          this.store.writeState(state)
          return { kind: 'interrupted', reason: 'ORBIT_ABORTED' }
        }
        if (raced.kind === 'rotate_commander') {
          await this.cancelHandle(handle, 'HEARTBEAT_ROTATE_COMMANDER')
          this.rotateRoleSession(state, 'commander', `HEARTBEAT_ROTATE_COMMANDER:${truncateSafe(raced.reason, 120)}`)
          this.store.writeState(state)
          if (heartbeatRotations < 1) {
            return this.runCommander(state, mode, prompt, outputSchema, signal, heartbeatRotations + 1)
          }
          return { kind: 'interrupted', reason: 'HEARTBEAT_COMMANDER_ROTATION_EXHAUSTED' }
        }
        if (raced.kind === 'needs_user' || raced.kind === 'runtime_bug') {
          await this.cancelHandle(handle, raced.kind === 'needs_user' ? 'HEARTBEAT_NEEDS_USER' : 'HEARTBEAT_RUNTIME_BUG')
          this.rotateRoleSession(state, 'commander', raced.kind === 'needs_user' ? 'HEARTBEAT_NEEDS_USER' : 'HEARTBEAT_RUNTIME_BUG')
          this.store.writeState(state)
          return { kind: 'needs_user', reason: raced.reason }
        }
        if (raced.kind === 'restart_step') {
          await this.cancelHandle(handle, 'HEARTBEAT_RESTART_STEP_DURING_COMMANDER')
          this.rotateRoleSession(state, 'commander', 'HEARTBEAT_RESTART_STEP_DURING_COMMANDER')
          this.store.writeState(state)
          return { kind: 'interrupted', reason: 'HEARTBEAT_RESTART_STEP_DURING_COMMANDER' }
        }
        if (extensions >= 2) {
          await this.cancelHandle(handle, 'COMMANDER_HARD_TIMEOUT')
          this.rotateRoleSession(state, 'commander', 'COMMANDER_HARD_TIMEOUT')
          this.store.writeState(state)
          return { kind: 'interrupted', reason: 'COMMANDER_HARD_TIMEOUT' }
        }
        const review = await this.commanderTimeoutReview(state, mode, this.now() - startedAt, extensions, handle, signal)
        if (review.decision === 'EXTEND') {
          extensions += 1
          continue
        }
        await this.cancelHandle(handle, review.decision === 'NEEDS_USER' ? 'COMMANDER_NEEDS_USER' : 'COMMANDER_TIMEOUT_INTERRUPTED')
        this.rotateRoleSession(state, 'commander', review.decision === 'NEEDS_USER' ? 'COMMANDER_NEEDS_USER' : 'COMMANDER_TIMEOUT_INTERRUPTED')
        this.store.writeState(state)
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
      return { decision: extensions === 0 ? 'EXTEND' : 'INTERRUPT', reason: '监控模型暂时不可用' }
    }
    try {
      return assertTimeoutDecision(result.structured as TimeoutDecision)
    } catch {
      return { decision: extensions === 0 ? 'EXTEND' : 'INTERRUPT', reason: '监控模型返回了无效结果' }
    }
  }

  // ── executor runtime ───────────────────────────────────────────────────────

  private async executeStep(
    state: OrbitState,
    step: OrbitPlanStep,
    signal?: AbortSignal,
  ): Promise<{ done: boolean; ok: boolean; message?: string }> {
    if (normalizeExecutionMode(step.execution_mode) === 'MOA') {
      const prepared = await this.prepareMoaStep(state, step, signal)
      if (!prepared.ready) return { done: prepared.done, ok: false, ...(prepared.message ? { message: prepared.message } : {}) }
      return this.executeExecutorStep(state, step, signal, true)
    }
    return this.executeExecutorStep(state, step, signal, false)
  }

  private async prepareMoaStep(
    state: OrbitState,
    step: OrbitPlanStep,
    signal?: AbortSignal,
  ): Promise<{ ready: boolean; done: boolean; message?: string }> {
    const policy = state.moa_policy
    if (!policy) {
      enterNeedsUser(state, 'ORBIT_MOA_UNAVAILABLE: 当前 Run 没有冻结的 MoA 配置。')
      this.store.writeState(state)
      return { ready: false, done: true, message: state.last_error ?? undefined }
    }
    const availability = await this.moa.availability()
    if (!availability.available) {
      enterNeedsUser(state, availability.reason ?? 'ORBIT_MOA_UNAVAILABLE')
      this.store.writeState(state)
      return { ready: false, done: true, message: state.last_error ?? undefined }
    }
    const workspace = join(this.store.stateDir, '..')
    if (state.moa_step?.step_id !== step.id) {
      state.moa_step = {
        step_id: step.id,
        phase: 'FANOUT',
        ...(availability.version ? { adapter_version: availability.version } : {}),
        candidates: [],
        successful_candidates: 0,
        failed_candidates: 0,
      }
      this.store.writeState(state)
    }
    try {
      if (state.moa_step.phase === 'FANOUT') {
        const controller = new AbortController()
        const phaseSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
        const pending = this.moa.fanout({ workspace, runId: state.run_id, step, policy, signal: phaseSignal })
        const waited = await this.waitWithHeartbeat(
          state,
          'moa',
          pending,
          this.config.executorTimeoutMs ?? EXECUTOR_TIMEOUT_MS,
          phaseSignal,
        )
        if (waited.kind !== 'work') {
          controller.abort()
          if (waited.kind === 'restart_step') {
            state.moa_step = {
              ...state.moa_step,
              phase: 'FANOUT',
              candidates: [],
              successful_candidates: 0,
              failed_candidates: 0,
              last_error: `HEARTBEAT_RESTART_STEP:${truncateSafe(waited.reason, 200)}`,
            }
            this.markProgress(state)
            this.store.writeState(state)
            return { ready: false, done: false, message: state.moa_step.last_error }
          }
          if (waited.kind === 'aborted' || signal?.aborted) return { ready: false, done: true, message: 'ORBIT_ABORTED' }
          const reason = waited.kind === 'timeout'
            ? 'ORBIT_MOA_FANOUT_TIMEOUT'
            : waited.kind === 'needs_user' || waited.kind === 'runtime_bug'
              ? waited.reason
              : 'ORBIT_MOA_FANOUT_INTERRUPTED'
          enterNeedsUser(state, truncateSafe(reason, 500))
          this.store.writeState(state)
          return { ready: false, done: true, message: state.last_error ?? reason }
        }
        const fanout = waited.value
        state.moa_step = {
          ...state.moa_step,
          phase: fanout.successful >= 2 ? 'JUDGE' : 'FAILED',
          adapter_version: fanout.adapterVersion,
          candidates: fanout.candidates,
          successful_candidates: fanout.successful,
          failed_candidates: fanout.failed,
          ...(sumMoaUsage(fanout.candidates.map((candidate) => candidate.usage)) ? { total_usage: sumMoaUsage(fanout.candidates.map((candidate) => candidate.usage)) } : {}),
          ...(fanout.successful >= 2 ? {} : { last_error: 'ORBIT_MOA_QUORUM_FAILED: 至少需要 2 个成功候选。' }),
        }
        this.markProgress(state)
        this.store.writeState(state)
      }
      if (state.moa_step.phase === 'FAILED') {
        applyExecutorSuccess(state, {
          summary: state.moa_step.last_error ?? 'ORBIT_MOA_FAILED',
          changedFiles: this.host.changedFiles(workspace),
          testSummary: [state.moa_step.last_error ?? 'ORBIT_MOA_FAILED'],
        })
        upsertStepResult(state, buildStepResult(step.id, state.current_step?.attempt ?? 1, buildEvidenceBundle({ executorOutput: state.moa_step.last_error ?? 'ORBIT_MOA_FAILED' }), state.test_summary))
        this.store.writeState(state)
        return { ready: false, done: false }
      }
      if (state.moa_step.phase === 'JUDGE') {
        const controller = new AbortController()
        const phaseSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
        const pending = this.moa.judge({ workspace, runId: state.run_id, step, policy, candidates: state.moa_step.candidates, signal: phaseSignal })
        const waited = await this.waitWithHeartbeat(
          state,
          'moa',
          pending,
          this.config.executorTimeoutMs ?? EXECUTOR_TIMEOUT_MS,
          phaseSignal,
        )
        if (waited.kind !== 'work') {
          controller.abort()
          if (waited.kind === 'restart_step') {
            state.moa_step = {
              ...state.moa_step,
              phase: 'FANOUT',
              candidates: [],
              successful_candidates: 0,
              failed_candidates: 0,
              last_error: `HEARTBEAT_RESTART_STEP:${truncateSafe(waited.reason, 200)}`,
            }
            this.markProgress(state)
            this.store.writeState(state)
            return { ready: false, done: false, message: state.moa_step.last_error }
          }
          if (waited.kind === 'aborted' || signal?.aborted) return { ready: false, done: true, message: 'ORBIT_ABORTED' }
          const reason = waited.kind === 'timeout'
            ? 'ORBIT_MOA_JUDGE_TIMEOUT'
            : waited.kind === 'needs_user' || waited.kind === 'runtime_bug'
              ? waited.reason
              : 'ORBIT_MOA_JUDGE_INTERRUPTED'
          enterNeedsUser(state, truncateSafe(reason, 500))
          this.store.writeState(state)
          return { ready: false, done: true, message: state.last_error ?? reason }
        }
        const judged = waited.value
        state.moa_step = {
          ...state.moa_step,
          phase: 'SELECTED',
          winning_candidate: judged.winningCandidate,
          winner_model: judged.winnerModel,
          judge_summary: judged.summary,
          ...(judged.usage ? { judge_usage: judged.usage } : {}),
          ...(sumMoaUsage([...state.moa_step.candidates.map((candidate) => candidate.usage), judged.usage]) ? { total_usage: sumMoaUsage([...state.moa_step.candidates.map((candidate) => candidate.usage), judged.usage]) } : {}),
        }
        this.markProgress(state)
        this.store.writeState(state)
      }
      if (state.moa_step.phase === 'SELECTED') {
        state.moa_step.phase = 'PROMOTING'
        this.markProgress(state)
        this.store.writeState(state)
      }
      if (state.moa_step.phase === 'PROMOTING') {
        const winner = state.moa_step.winning_candidate
        if (!winner) throw new Error('ORBIT_MOA_WINNER_MISSING')
        const receipt = await this.moa.promote({ workspace, runId: state.run_id, stepId: step.id, winningCandidate: winner })
        state.moa_step = { ...state.moa_step, phase: 'PROMOTED', promotion_receipt: receipt }
        this.markProgress(state)
        this.store.writeState(state)
      }
      return { ready: state.moa_step.phase === 'PROMOTED', done: false }
    } catch (error) {
      const reason = truncateSafe(error instanceof Error ? error.message : String(error), 500)
      if (state.moa_step) state.moa_step = { ...state.moa_step, phase: 'FAILED', last_error: reason }
      applyExecutorSuccess(state, {
        summary: reason,
        changedFiles: this.host.changedFiles(workspace),
        testSummary: [reason],
      })
      upsertStepResult(state, buildStepResult(
        step.id,
        state.current_step?.attempt ?? 1,
        buildEvidenceBundle({ executorOutput: reason }),
        state.test_summary,
      ))
      this.store.writeState(state)
      return { ready: false, done: false, message: reason }
    }
  }

  private async executeExecutorStep(
    state: OrbitState,
    step: OrbitPlanStep,
    signal: AbortSignal | undefined,
    moaVerification: boolean,
  ): Promise<{ done: boolean; ok: boolean; message?: string }> {
    const capabilities = normalizeCapabilities(step.capabilities) ?? []
    if (capabilities.includes('browser') && !this.config.browserTools.some((tool) => this.host.hasTool(tool))) {
      applyExecutorCapabilityUnavailable(state, step.id)
      upsertStepResult(state, buildStepResult(step.id, state.current_step?.attempt ?? 1, buildEvidenceBundle({
        executorOutput: state.commander?.summary,
      })))
      this.store.writeState(state)
      return { done: false, ok: false }
    }

    let toolFilter: RoleToolFilter
    try {
      toolFilter = this.toolAllow(executorToolsFor(capabilities, this.config.browserTools, this.config.executorTools), `executor ${step.id}`)
    } catch (error) {
      const reason = truncateSafe(error instanceof Error ? error.message : String(error), 500)
      enterNeedsUser(state, reason)
      this.store.writeState(state)
      return { done: true, ok: false, message: reason }
    }

    const fingerprint = this.grantFingerprint(toolFilter)
    const previousExecutor = state.role_sessions?.executor
    if (previousExecutor && previousExecutor.needs_rotation !== true && previousExecutor.grant_fingerprint !== fingerprint) {
      this.rotateRoleSession(state, 'executor', 'EXECUTOR_TOOL_GRANT_CHANGED')
      this.store.writeState(state)
    }
    const resumeOf = this.resumeRoleId(state, 'executor', fingerprint)
      ?? (state.role_sessions?.executor === undefined && state.child?.id && state.child.status === 'interrupted' ? state.child.id : undefined)
    const start = (childId?: string) => this.host.startRole({
      role: 'executor',
      label: 'orbit-executor',
      prompt: this.executorPrompt(state, step, moaVerification),
      route: state.routes.executor,
      workspace: join(this.store.stateDir, '..'),
      toolFilter,
      capabilities,
      persistent: true,
      ...(signal ? { signal } : {}),
      ...(childId ? { resumeOf: childId } : {}),
    })
    let handle: RoleHandle
    try {
      handle = await start(resumeOf)
    } catch (error) {
      if (resumeOf) {
        this.rotateRoleSession(state, 'executor', `EXECUTOR_RESUME_FAILED:${truncateSafe(error instanceof Error ? error.message : String(error), 120)}`)
        this.store.writeState(state)
        try {
          handle = await start()
        } catch (retryError) {
          const reason = truncateSafe(retryError instanceof Error ? retryError.message : String(retryError), 500)
          enterNeedsUser(state, reason)
          this.store.writeState(state)
          return { done: true, ok: false, message: reason }
        }
      } else {
        const reason = truncateSafe(error instanceof Error ? error.message : String(error), 500)
        enterNeedsUser(state, reason)
        this.store.writeState(state)
        return { done: true, ok: false, message: reason }
      }
    }
    if (handle.childId) {
      this.bindRoleSession(state, 'executor', handle.childId, { fingerprint, stepId: step.id })
      this.store.writeState(state)
    }

    const result = await this.awaitExecutor(state, handle, signal)
    this.recordRoleTurn(state, 'executor', result.tokenUsage, step.id)

    if (result.interrupted) {
      const retries = applyExecutorInterrupted(state, {
        ...(result.childId ? { childId: result.childId } : {}),
        lastError: truncateSafe(result.reason ?? 'EXECUTOR_INTERRUPTED', 500),
      })
      this.store.writeState(state)

      if (signal?.aborted) return { done: true, ok: false, message: 'ORBIT_ABORTED' }
      if (result.reason?.startsWith('HEARTBEAT_RESTART_STEP:')) {
        this.rotateRoleSession(state, 'executor', truncateSafe(result.reason, 160))
        clearExecutorChild(state)
        this.markProgress(state)
        this.store.writeState(state)
        return { done: false, ok: false }
      }
      if (result.reason?.startsWith('HEARTBEAT_NEEDS_USER:') || result.reason?.startsWith('HEARTBEAT_RUNTIME_BUG:')) {
        enterNeedsUser(state, truncateSafe(result.reason, 500))
        this.store.writeState(state)
        return { done: true, ok: false, message: result.reason }
      }
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
        this.rotateRoleSession(state, 'executor', 'WATCHDOG_RESTART_STEP')
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

    const moaPrefix = moaVerification && state.moa_step
      ? `MoA Judge 选择：${state.moa_step.winner_model ?? 'unknown'}（候选 ${state.moa_step.winning_candidate ?? '?'}）。\nJudge：${state.moa_step.judge_summary ?? ''}\n`
      : ''
    applyExecutorSuccess(state, {
      ...(result.childId ? { childId: result.childId } : {}),
      summary: truncateSafe(moaPrefix + result.output, 2000),
      changedFiles: result.changedFiles ?? this.host.changedFiles(join(this.store.stateDir, '..')),
      testSummary: result.testSummary ?? [],
    })
    this.stepEvidence = {
      stepId: step.id,
      bundle: buildEvidenceBundle({
        settlement: result.settlement,
        executorOutput: moaPrefix + result.output,
        changedFiles: state.changed_files,
        tools: result.toolEvidence,
        telemetry: result.telemetry,
      }),
    }
    upsertStepResult(state, buildStepResult(step.id, state.current_step?.attempt ?? 1, this.stepEvidence.bundle, state.test_summary))
    this.markProgress(state)
    this.store.writeState(state)
    await this.disposeHandle(handle)
    return { done: false, ok: false }
  }

  /** Deterministic executor runtime timeout; a timeout does not destroy the child. */
  private async awaitExecutor(state: OrbitState, handle: RoleHandle, signal?: AbortSignal): Promise<RoleRunResult> {
    const timeoutMs = this.config.executorTimeoutMs ?? EXECUTOR_TIMEOUT_MS
    const raced = await this.waitWithHeartbeat(state, 'executor', handle.result, timeoutMs, signal, handle)
    if (raced.kind === 'work') return raced.value
    const reason = raced.kind === 'aborted'
      ? 'ORBIT_ABORTED'
      : raced.kind === 'timeout'
        ? 'EXECUTOR_TIMEOUT'
        : raced.kind === 'restart_step'
          ? `HEARTBEAT_RESTART_STEP:${truncateSafe(raced.reason, 200)}`
          : raced.kind === 'needs_user'
            ? `HEARTBEAT_NEEDS_USER:${truncateSafe(raced.reason, 200)}`
            : raced.kind === 'runtime_bug'
              ? `HEARTBEAT_RUNTIME_BUG:${truncateSafe(raced.reason, 200)}`
              : `HEARTBEAT_EXECUTOR_INTERRUPTED:${truncateSafe(raced.reason, 200)}`
    await this.cancelHandle(handle, reason)
    const telemetry = await handle.runtimeSnapshot?.()
    return {
      ...(handle.childId ? { childId: handle.childId } : {}),
      output: '',
      interrupted: true,
      reason,
      ...(telemetry ? { telemetry } : {}),
    }
  }

  private executorPrompt(state: OrbitState, step: OrbitPlanStep, moaVerification = false): string {
    const lines = [
      '你是 Orbit 执行员（Executor）。',
      '你只负责执行当前步骤：不要重新规划整个任务，也不要自行改变当前步骤的目标。',
      '必须使用真实工具完成实际操作，并对结果进行真实验证。',
      '完成后用简体中文提交简洁的执行证据：做了什么、运行了哪些命令/测试、验证结果以及仍存在的风险。',
      '你的自然语言输出、执行说明和总结默认全部使用简体中文；代码、命令、路径、provider/model ID 等机器标识保持原样。',
      `当前步骤 ${step.id}：${step.goal}`,
      ...(moaVerification ? [
        '该步骤已由 MoA 生成多个候选并由 Judge 选出胜者，Supervisor 已确定性地把胜出文件提升到项目目录。',
        '你的职责是对已应用结果做真实验证：检查 diff、运行必要测试，并只在验证发现明确小问题时做最小修正。不要重新运行 MoA，也不要自行选择另一个候选。',
        `MoA 胜出：${state.moa_step?.winner_model ?? 'unknown'} / candidate-${state.moa_step?.winning_candidate ?? '?'}`,
        `胜出候选摘要：${state.moa_step?.candidates.find((candidate) => candidate.index === state.moa_step?.winning_candidate)?.summary ?? '无'}`,
      ] : []),
      `工作目录：${join(this.store.stateDir, '..')}`,
      `硬性约束：${state.user_hard_constraints.join('；') || '无'}`,
    ]
    if (state.pending_user_reply) lines.push(`用户回复（对上一个问题的回答）：${state.pending_user_reply}`)
    if ((step.capabilities ?? []).length > 0) lines.push(`能力：${(step.capabilities ?? []).join(', ')}`)
    return lines.join('\n')
  }

  private async runFinalAudit(state: OrbitState, signal?: AbortSignal): Promise<OrbitActionResult | undefined> {
    const heartbeat = this.ensureHeartbeatState(state)
    const auditInputFingerprint = this.completionFingerprint(state)

    if (this.config.finalAuditEnabled !== true) {
      applyFinalAuditApproved(state)
      this.markProgress(state)
      heartbeat.final_audit = {
        verdict: 'APPROVE_CLOSE',
        at: new Date(this.now()).toISOString(),
        fingerprint: this.completionFingerprint(state),
        reason: 'Final audit disabled by explicit profile configuration.',
        block_count: heartbeat.final_audit?.block_count ?? 0,
      }
      this.store.writeState(state)
      return undefined
    }

    let result: RoleRunResult | undefined
    for (let attempt = 0; attempt < 2; attempt += 1) {
      result = await this.runAuxRole(state, {
        role: 'watchdog',
        label: 'watchdog-final-audit',
        prompt: WATCHDOG_FINAL_AUDIT_PROMPT(state.goal, state, auditInputFingerprint),
        outputSchema: WATCHDOG_FINAL_AUDIT_SCHEMA,
        ...(signal ? { signal } : {}),
      })
      if (result && !result.interrupted && result.structured !== undefined) break
    }

    if (!result || result.interrupted || result.structured === undefined) {
      state.last_error = truncateSafe(result?.reason ?? 'FINAL_AUDIT_WATCHDOG_UNAVAILABLE', 500)
      this.store.writeState(state)
      return this.result(state, false, state.last_error)
    }

    let decision: FinalAuditDecision
    try {
      decision = assertFinalAuditDecision(result.structured as FinalAuditDecision)
    } catch (error) {
      state.last_error = truncateSafe(error instanceof Error ? error.message : String(error), 500)
      this.store.writeState(state)
      return this.result(state, false, state.last_error)
    }

    if (auditInputFingerprint !== this.completionFingerprint(state)) {
      state.last_error = 'FINAL_AUDIT_STALE: Run changed while the final Watchdog was reviewing it.'
      heartbeat.final_audit = {
        verdict: decision.decision,
        at: new Date(this.now()).toISOString(),
        fingerprint: auditInputFingerprint,
        reason: state.last_error,
        block_count: heartbeat.final_audit?.block_count ?? 0,
      }
      this.store.writeState(state)
      return undefined
    }

    if (decision.decision === 'APPROVE_CLOSE') {
      applyFinalAuditApproved(state)
      this.markProgress(state)
      heartbeat.final_audit = {
        verdict: 'APPROVE_CLOSE',
        at: new Date(this.now()).toISOString(),
        fingerprint: this.completionFingerprint(state),
        ...(decision.reason ? { reason: truncateSafe(decision.reason, 500) } : {}),
        block_count: heartbeat.final_audit?.block_count ?? 0,
      }
      if (state.commander?.remaining_gap) state.commander.remaining_gap = undefined
      if (state.last_error) state.recovered_error = state.last_error
      state.last_error = null
      this.store.writeState(state)
      return undefined
    }

    if (decision.decision === 'BLOCK_CLOSE') {
      const blocks = (heartbeat.final_audit?.block_count ?? 0) + 1
      heartbeat.final_audit = {
        verdict: 'BLOCK_CLOSE',
        at: new Date(this.now()).toISOString(),
        fingerprint: auditInputFingerprint,
        reason: truncateSafe(decision.reason ?? 'Final Watchdog blocked closure.', 500),
        block_count: blocks,
      }
      if (blocks >= MAX_FINAL_AUDIT_BLOCKS) {
        enterNeedsUser(state, 'FINAL_AUDIT_BLOCKED_REPEATEDLY: ' + (heartbeat.final_audit.reason ?? ''))
        this.store.writeState(state)
        return this.result(state, false, state.last_error ?? undefined)
      }
      applyFinalAuditBlocked(state, heartbeat.final_audit.reason ?? 'Final Watchdog blocked closure.')
      this.markProgress(state)
      this.store.writeState(state)
      return undefined
    }

    heartbeat.final_audit = {
      verdict: decision.decision,
      at: new Date(this.now()).toISOString(),
      fingerprint: auditInputFingerprint,
      ...(decision.reason ? { reason: truncateSafe(decision.reason, 500) } : {}),
      block_count: heartbeat.final_audit?.block_count ?? 0,
    }
    enterNeedsUser(state, decision.decision + ': ' + (decision.reason ?? 'Final Watchdog requires intervention.'))
    this.store.writeState(state)
    return this.result(state, false, state.last_error ?? undefined)
  }

  private async runTerminalConfirm(
    state: OrbitState,
    signal?: AbortSignal,
    heartbeatRotations = 0,
  ): Promise<OrbitActionResult | undefined> {
    const audit = this.ensureHeartbeatState(state).final_audit
    if (audit?.verdict !== 'APPROVE_CLOSE' || !audit.fingerprint) {
      state.phase = 'FINAL_VERIFY'
      state.status = 'running'
      state.last_error = 'ORBIT_TERMINAL_CONFIRM_WITHOUT_FINAL_AUDIT'
      this.store.writeState(state)
      return undefined
    }

    const commanderTools = [
      ...this.config.commanderReadOnlyTools.filter((name) => (READ_ONLY_ROLE_TOOLS as readonly string[]).includes(name)),
      ORBIT_COMMANDER_DECISION_TOOL,
      ORBIT_RUN_COMPLETE_TOOL,
    ]
    const toolFilter = this.toolAllow(commanderTools, 'commander TERMINAL_CONFIRM')
    const resumeOf = this.resumeRoleId(state, 'commander')
    const start = (childId?: string) => this.host.startRole({
      role: 'commander',
      label: 'orbit-commander',
      prompt: COMMANDER_TERMINAL_CONFIRM_PROMPT(state.goal, audit.reason),
      route: state.routes.commander,
      workspace: join(this.store.stateDir, '..'),
      toolFilter,
      persistent: true,
      terminalConfirm: true,
      ...(childId ? { resumeOf: childId } : {}),
      ...(signal ? { signal } : {}),
    })

    let handle: RoleHandle | undefined
    try {
      try {
        handle = await start(resumeOf)
      } catch (error) {
        if (!resumeOf) throw error
        this.rotateRoleSession(
          state,
          'commander',
          'TERMINAL_CONFIRM_RESUME_FAILED:' + truncateSafe(error instanceof Error ? error.message : String(error), 120),
        )
        this.store.writeState(state)
        handle = await start()
      }

      if (handle.childId) {
        this.bindRoleSession(state, 'commander', handle.childId)
        this.store.writeState(state)
      }

      const raced = await this.waitWithHeartbeat(
        state,
        'commander',
        handle.result,
        COMMANDER_SOFT_DEADLINE_MS,
        signal,
        handle,
      )

      if (raced.kind === 'rotate_commander') {
        await this.cancelHandle(handle, 'HEARTBEAT_ROTATE_COMMANDER')
        this.rotateRoleSession(
          state,
          'commander',
          'HEARTBEAT_ROTATE_COMMANDER:' + truncateSafe(raced.reason, 120),
        )
        this.store.writeState(state)
        if (heartbeatRotations < 1) return this.runTerminalConfirm(state, signal, heartbeatRotations + 1)
        return this.result(state, false, 'HEARTBEAT_COMMANDER_ROTATION_EXHAUSTED')
      }

      if (raced.kind === 'needs_user' || raced.kind === 'runtime_bug') {
        await this.cancelHandle(handle, raced.kind === 'needs_user' ? 'HEARTBEAT_NEEDS_USER' : 'HEARTBEAT_RUNTIME_BUG')
        enterNeedsUser(state, raced.reason)
        this.store.writeState(state)
        return this.result(state, false, raced.reason)
      }

      if (raced.kind !== 'work') {
        const reason = raced.kind === 'aborted' ? 'ORBIT_ABORTED' : 'TERMINAL_CONFIRM_TIMEOUT'
        await this.cancelHandle(handle, reason)
        this.rotateRoleSession(state, 'commander', reason)
        state.last_error = reason
        this.store.writeState(state)
        return this.result(state, false, reason)
      }

      this.recordRoleTurn(state, 'commander', raced.value.tokenUsage)
      if (raced.value.interrupted || raced.value.structured === undefined) {
        const reason = truncateSafe(raced.value.reason ?? 'TERMINAL_CONFIRM_STRUCTURED_OUTPUT_MISSING', 500)
        this.rotateRoleSession(state, 'commander', reason)
        state.last_error = reason
        this.store.writeState(state)
        return this.result(state, false, reason)
      }

      const submission = raced.value.structured as TerminalCompletionSubmission
      if (submission.signal !== 'COMPLETE' && submission.signal !== 'NOT_COMPLETE') {
        state.last_error = 'ORBIT_TERMINAL_CONFIRM_INVALID'
        this.store.writeState(state)
        return this.result(state, false, state.last_error)
      }

      applyTerminalConfirmation(state, submission.signal, this.now(), submission.reason)
      if (submission.signal === 'NOT_COMPLETE') {
        this.markProgress(state)
        this.store.writeState(state)
        return undefined
      }

      const issue = completionGateIssue(state, audit.fingerprint, this.completionFingerprint(state))
      if (issue) {
        state.last_error = issue
        state.terminal_confirmation = undefined
        if (issue === 'ORBIT_COMPLETION_GATE_AUDIT_STALE') {
          state.phase = 'FINAL_VERIFY'
          state.status = 'running'
          this.store.writeState(state)
          return undefined
        }
        enterNeedsUser(state, issue)
        this.store.writeState(state)
        return this.result(state, false, issue)
      }

      applyFinalSuccess(state, state.commander?.summary)
      this.markProgress(state)
      this.store.writeState(state)
      return this.result(state, true, undefined, state.commander?.final_output)
    } catch (error) {
      const reason = truncateSafe(error instanceof Error ? error.message : String(error), 500)
      state.last_error = reason
      this.store.writeState(state)
      return this.result(state, false, reason)
    } finally {
      if (handle) await this.disposeHandle(handle)
    }
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
    if (state.heartbeat_watchdog?.strategy_review_requested) state.heartbeat_watchdog.strategy_review_requested = false
    if (decision.executor_session === 'RESET') this.rotateRoleSession(state, 'executor', 'COMMANDER_REQUEST')

    if (decision.decision === 'NEEDS_USER') {
      applyCommanderNeedsUser(state, decision.reason ?? 'COMMANDER_NEEDS_USER')
      this.markProgress(state)
      this.store.writeState(state)
      return this.result(state, false)
    }

    if (decision.decision === 'SUCCESS') {
      if (this.config.finalAuditEnabled !== true) {
        applyFinalSuccess(state, decision.summary)
        if (outcome.output.trim()) state.commander = { ...state.commander, final_output: outcome.output.trim().slice(0, 8000) }
        this.markProgress(state)
        this.store.writeState(state)
        return this.result(state, true, undefined, outcome.output)
      }
      applyFinalCandidate(state, decision.summary, outcome.output)
      this.markProgress(state)
      this.store.writeState(state)
      return undefined
    }

    if (decision.decision === 'PASS_CURRENT_STEP') {
      applyStepPass(state, step, decision.summary)
      this.markProgress(state)
      this.store.writeState(state)
      return undefined
    }

    if (decision.decision === 'CORRECT_CURRENT_STEP') {
      return this.applyCorrection(state, step as OrbitPlanStep, decision, signal)
    }

    if (decision.decision === 'APPEND') {
      const append = applyFinalAppend(state, decision)
      if (append === 'invalid') {
        return this.setNeedsUser(state, 'COMMANDER_EVALUATION_OUTPUT_INVALID: APPEND 需要 next_steps 或 next_step_goal')
      }
      this.markProgress(state)
      this.store.writeState(state)
      if (append === 'budget_exhausted') return this.result(state, false)
      return undefined
    }

    // FINAL_EVALUATE must not return PASS/CORRECT; assertCommanderDecision already rejects it.
    return this.setNeedsUser(state, 'COMMANDER_FINAL_DECISION_INVALID')
  }

  private setNeedsUser(state: OrbitState, reason: string): OrbitActionResult {
    enterNeedsUser(state, truncateSafe(reason, 500))
    this.markProgress(state)
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
      return this.setNeedsUser(state, 'COMMANDER_EVALUATION_OUTPUT_INVALID: CORRECT_CURRENT_STEP 需要 next_step_goal')
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

    const correctionMode = decision.next_step_execution_mode === undefined
      ? normalizeExecutionMode(step.execution_mode)
      : normalizeExecutionMode(decision.next_step_execution_mode)
    if (correctionMode === 'MOA') {
      const currentMoa = state.plan.steps.filter((candidate) => normalizeExecutionMode(candidate.execution_mode) === 'MOA').length
      if (state.moa_policy === undefined || currentMoa >= state.moa_policy.max_moa_steps) {
        return this.setNeedsUser(state, 'ORBIT_MOA_STEP_BUDGET_EXCEEDED')
      }
    }
    applyCorrectionStep(state, step, {
      nextGoal,
      capabilities: decision.next_step_capabilities,
      executionMode: correctionMode,
    })
    this.markProgress(state)
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
    if (!challenge) return { kind: 'interrupted', reason: 'SMART_WATCHDOG_STRATEGY_OUTPUT_INVALID: 缺少 question' }

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
    const configured = request.role === 'watchdog' ? this.config.watchdogTools : this.config.commanderReadOnlyTools
    const readOnly = request.role === 'watchdog' ? EXECUTOR_READ_ONLY_TOOLS : READ_ONLY_ROLE_TOOLS
    const names = configured.filter((name) => (readOnly as readonly string[]).includes(name))
    let handle: RoleHandle | undefined
    try {
      handle = await this.host.startRole({
        role: request.role,
        label: request.label,
        prompt: request.prompt,
        route: state.routes[request.role],
        workspace: join(this.store.stateDir, '..'),
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
    if (!state) return { ok: false, action, message: 'ORBIT_RUN_NOT_FOUND: 没有活动中的 Run。' }
    if (runId && runId !== state.run_id) return { ok: false, action, message: `ORBIT_RUN_NOT_FOUND: ${runId}` }
    stopRun(state)
    this.store.writeState(state)
    return this.result(state, true)
  }

  async status(): Promise<OrbitActionResult> {
    const state = this.store.readState()
    if (!state) return { ok: false, action: 'status', message: 'ORBIT_RUN_NOT_FOUND: 没有 Run 状态。' }
    return this.result(state, true)
  }

  private result(state: OrbitState, ok: boolean, message?: string, finalOutput?: string): OrbitActionResult {
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
      step_results: state.step_results,
      moa_policy: state.moa_policy,
      moa_step: state.moa_step,
      role_sessions: state.role_sessions,
      progress: state.progress,
      heartbeat_watchdog: state.heartbeat_watchdog,
      terminal_confirmation: state.terminal_confirmation,
      recovered_error: state.recovered_error,
      changed_files: state.changed_files,
      test_summary: state.test_summary,
      driver_ownership: state.driver_ownership,
      state_revision: state.state_revision,
    }
    const displayText = state.phase === 'SUCCESS'
      ? finalOutput?.trim() || state.commander?.final_output?.trim() || state.commander?.summary?.trim()
      : undefined
    return {
      ok,
      action: 'run',
      run_id: state.run_id,
      phase: state.phase,
      status: state.status,
      ...(message ? { message } : {}),
      ...(displayText ? {
        final_output: {
          text: displayText,
          provider: state.routes.commander.provider,
          model: state.routes.commander.model,
        },
      } : {}),
      data: Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined)),
    }
  }
}

export { DEFAULT_CAPABILITIES }
