/** Durable Orbit state and decision vocabulary. */

export const ORBIT_SCHEMA_VERSION = 4 as const

export type OrbitPhase =
  | 'PLAN'
  | 'EXECUTE'
  | 'EVALUATE'
  | 'SUCCESS'
  | 'NEEDS_USER'
  | 'BUDGET_EXHAUSTED'
  | 'STOPPED'

export type OrbitStatus = 'running' | 'success' | 'stopped' | 'needs_user' | 'budget_exhausted'

export type OrbitDriverOwnership = 'ACTIVE' | 'PAUSED' | 'AWAITING_USER' | 'CLOSED'

export type OrbitRole = 'commander' | 'executor' | 'watchdog' | 'moa_candidate' | 'moa_judge'

export type OrbitCapability = 'filesystem' | 'shell' | 'web' | 'browser'

export type OrbitStepStatus = 'pending' | 'running' | 'passed' | 'needs_correction' | 'skipped'

export type OrbitExecutionMode = 'SINGLE' | 'MOA'

export interface OrbitPlanStep {
  id: string
  goal: string
  capabilities?: OrbitCapability[]
  execution_mode?: OrbitExecutionMode
  status: OrbitStepStatus
}

export interface OrbitMoaPriceRow {
  input: number
  output: number
  cacheHit?: number
}

export interface OrbitMoaUsage {
  input_tokens: number
  output_tokens: number
  total_tokens: number
  cache_read_tokens?: number
  cache_write_tokens?: number
  cost_usd?: number
}

export interface OrbitMoaPolicy {
  enabled: boolean
  candidate_count: number
  peer_critique: boolean
  max_moa_steps: number
  candidates: OrbitRoute[]
  judge: OrbitRoute
  /** Optional user-configured dsh-moa prices, frozen with the Run for stable accounting. */
  prices?: Record<string, OrbitMoaPriceRow>
}

export type OrbitMoaPhase = 'FANOUT' | 'JUDGE' | 'SELECTED' | 'PROMOTING' | 'PROMOTED' | 'FAILED'

export interface OrbitMoaCandidateResult {
  index: number
  provider: string
  model: string
  ok: boolean
  summary: string
  files: string[]
  usage?: OrbitMoaUsage
  error?: string
}

export interface OrbitMoaPromotionReceipt {
  files: Array<{ path: string; candidate_sha256: string; promoted_sha256: string }>
  promoted_at: string
}

export interface OrbitMoaStepState {
  step_id: string
  phase: OrbitMoaPhase
  adapter_version?: string
  candidates: OrbitMoaCandidateResult[]
  successful_candidates: number
  failed_candidates: number
  judge_summary?: string
  winning_candidate?: number
  winner_model?: string
  judge_usage?: OrbitMoaUsage
  total_usage?: OrbitMoaUsage
  promotion_receipt?: OrbitMoaPromotionReceipt
  last_error?: string
}

export type GuardCode =
  | 'github_remote_write'
  | 'destructive_operation'
  | 'production_operation'
  | 'secret_operation'
  | 'durable_state_write'

export type GuardDisposition = 'block_continue' | 'block_needs_user'

export interface OrbitRoute {
  provider: string
  model: string
  reasoningEffort?: string
}

export interface OrbitRoutes {
  commander: OrbitRoute
  executor: OrbitRoute
  watchdog: OrbitRoute
}

/** Bounded execution evidence retained for one logical plan step. */
export interface OrbitStepResult {
  step_id: string
  attempt: number
  summary: string
  changed_files: string[]
  test_summary: string[]
  evidence: string
}

export interface OrbitRoleSessionUsage {
  input_tokens: number
  output_tokens: number
  total_tokens: number
  cache_read_tokens?: number
  cache_write_tokens?: number
}

export interface OrbitRoleSessionState {
  child_id: string
  generation: number
  turns: number
  resets: number
  grant_fingerprint?: string
  last_step_id?: string
  last_reset_reason?: string
  needs_rotation?: boolean
  usage?: OrbitRoleSessionUsage
}

export interface OrbitRoleSessions {
  commander?: OrbitRoleSessionState
  executor?: OrbitRoleSessionState
}

export interface OrbitState extends Record<string, unknown> {
  schema_version: typeof ORBIT_SCHEMA_VERSION
  active_run_id: string
  run_id: string
  phase: OrbitPhase
  status: OrbitStatus
  driver_ownership: OrbitDriverOwnership
  state_revision: number
  updated_at: string
  goal: string
  goal_hash: string
  preset: string
  routes: OrbitRoutes
  /** Durable Commander/Executor conversation identities for this Run. */
  role_sessions?: OrbitRoleSessions
  /** Frozen MoA policy for this Run. Absent on legacy states and when MoA is disabled. */
  moa_policy?: OrbitMoaPolicy
  /** Durable state for the currently or most recently executed MoA step. */
  moa_step?: OrbitMoaStepState
  loop: { used: number; max: number }
  /** New runs record whether the loop cap came from Orbit or an explicit caller. Old states may omit it. */
  loop_budget_mode?: 'automatic' | 'explicit'
  approved_loop_count: number
  remaining_budget: number
  loop_count: number
  plan: { summary: string; steps: OrbitPlanStep[] }
  step_results?: OrbitStepResult[]
  current_step?: { id: string; attempt: number }
  child?: { id?: string; status: 'running' | 'completed' | 'interrupted' | 'unknown' }
  commander?: { last_decision?: string; summary?: string; remaining_gap?: string }
  changed_files: string[]
  test_summary: string[]
  last_error: string | null
  /**
   * Latest user reply that resumed a NEEDS_USER run. The original `goal` is
   * never rewritten; this durable field is what the Commander and Executor
   * read while the run continues. Absent on runs created before the field.
   */
  pending_user_reply?: string | null
  /**
   * DSH Session that created this run. A NEEDS_USER continuation is only
   * accepted from this exact Session; another Session's message is never
   * treated as the run's reply. Absent on runs created before the field.
   */
  owner_session_id?: string
  user_hard_constraints: string[]
  github_allowed: boolean
  smart_watchdog?: { step_id?: string; calls: number; last_decision?: string; last_reason?: string }
  strategy_challenge?: { base_step_id: string; used: boolean }
  guard_recovery?: { step_id: string; code: GuardCode; count: number }
  interruption_retries: number
}

export type CommanderDecisionKind =
  | 'PASS_CURRENT_STEP'
  | 'CORRECT_CURRENT_STEP'
  | 'APPEND'
  | 'SUCCESS'
  | 'NEEDS_USER'

export type StrategyDecisionKind = 'KEEP_APPROACH' | 'REPLACE_CURRENT_STEP' | 'NEEDS_USER'

export type TimeoutDecisionKind = 'EXTEND' | 'INTERRUPT' | 'NEEDS_USER'

export type WatchdogDecisionKind = 'RESUME_CHILD' | 'RESTART_STEP' | 'NEEDS_USER' | 'RUNTIME_BUG'

export type GuardWatchdogDecisionKind = 'RETRY_DIFFERENTLY' | 'NEEDS_USER'

export interface CommanderDecision {
  decision: CommanderDecisionKind
  reason?: string
  summary?: string
  next_step_goal?: string
  next_step_capabilities?: unknown
  next_step_execution_mode?: unknown
  next_steps?: Array<string | { goal: string; capabilities?: unknown; execution_mode?: unknown }>
  /** Default KEEP; RESET asks the Supervisor to rotate the persistent Executor before its next turn. */
  executor_session?: 'KEEP' | 'RESET'
}

export interface StrategyDecision {
  decision: StrategyDecisionKind
  reason?: string
  replacement_goal?: string
}

export interface TimeoutDecision {
  decision: TimeoutDecisionKind
  reason?: string
}

export interface WatchdogDecision {
  decision: WatchdogDecisionKind
  reason?: string
}

export interface GuardWatchdogDecision {
  decision: GuardWatchdogDecisionKind
  instruction?: string
}

export interface OrbitTelemetry {
  status?: 'idle' | 'running' | 'unknown'
  current_tool?: string
  tool_count?: number
  turn_count?: number
  activity_state?: string
  duration_ms?: number
  recent_output?: string
}

export interface OrbitActionResult {
  ok: boolean
  action: string
  run_id?: string
  phase?: OrbitPhase
  status?: OrbitStatus
  message?: string
  /** Presentation-only Final Commander result; never persisted as state. */
  final_output?: {
    text: string
    provider: string
    model: string
  }
  data?: Record<string, unknown>
}

export const COMMANDER_SOFT_DEADLINE_MS = 6 * 60_000
export const COMMANDER_EXTENSION_MS = 4 * 60_000
export const COMMANDER_HARD_CEILING_MS = 14 * 60_000

export const EXECUTOR_TIMEOUT_MS = 8 * 60_000
export const WATCHDOG_TIMEOUT_MS = 2 * 60_000

export type CommanderMode = 'PLAN' | 'STEP_EVALUATE' | 'FINAL_EVALUATE' | 'STRATEGY_RECONSIDER'

export const GUARD_ESCALATION_THRESHOLD = 3
export const GUARD_RECOVERY_CAP = 4
export const MAX_CORRECTION_DEPTH = 2
export const MAX_WATCHDOG_CALLS_PER_STEP = 2
export const MAX_EXECUTOR_INTERRUPT_RETRIES = 2
export const MAX_PLAN_STEPS = 5
export const MIN_PLAN_STEPS = 1
export const MIN_MOA_CANDIDATES = 2
export const MAX_MOA_CANDIDATES = 4
export const DEFAULT_MOA_CANDIDATES = 3
export const DEFAULT_MAX_MOA_STEPS = 2
export const DEFAULT_LOOP_BUDGET = 5
/** Automatic runs reserve two bounded execution slots beyond the accepted base plan. */
export const AUTOMATIC_LOOP_RECOVERY_RESERVE = 2
export const MAX_AUTOMATIC_LOOP_BUDGET = MAX_PLAN_STEPS + AUTOMATIC_LOOP_RECOVERY_RESERVE

export const GUARD_FIRST_INSTRUCTION =
  '请改用更安全的方法继续当前任务，不要原样重试刚被阻断的操作。'
export const GUARD_REPEAT_INSTRUCTION =
  '同一操作再次被阻断。请停止重复，并选择不同的安全方案。'
export const GUARD_RETRY_INSTRUCTION =
  '之前的方案反复触发 Orbit 安全护栏。请改用不同的安全方案，不要重试被阻断的操作。'
export const GUARD_NEEDS_USER_INSTRUCTION =
  '受限操作可能是完成目标所必需的。Orbit 已暂停并等待用户指引。'

export const DEFAULT_CAPABILITIES: readonly OrbitCapability[] = ['filesystem', 'shell', 'web', 'browser']
