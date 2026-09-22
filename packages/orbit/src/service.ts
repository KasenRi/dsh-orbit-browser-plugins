import { accessSync, constants, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-subagent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { DshOrbitHost } from './dsh-host.ts'
import { createCommanderDecisionTool } from './commander-tool.ts'
import { ORBIT_COMMANDER_DECISION_TOOL } from './host.ts'
import { OrbitMoaAdapter } from './moa-adapter.ts'
import { OrbitStateStore } from './state-store.ts'
import { OrbitSupervisor, type OrbitRunInput, type GuardBlockOutcome } from './supervisor.ts'
import type { OrbitActionResult, OrbitMoaPolicy, OrbitRoutes, GuardCode } from './types.ts'
import type { OrbitConfiguredRoutes } from './routes.ts'
import { orbitRuntimeFromState } from './session-state.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Canonical Orbit service. */
    orbit: OrbitService
    /** @deprecated Legacy CX (now Orbit) alias for the same {@link OrbitService} instance. */
    cx: OrbitService
  }
}

export interface OrbitPluginConfig {
  projectDir?: string
  routes: OrbitConfiguredRoutes
  /**
   * Resolve the role routes for a NEW run (settings + session selection).
   * Optional so minimal/headless compositions keep using `routes` unchanged.
   */
  resolveRoutes?: () => OrbitRoutes
  /** Freeze optional MoA candidates/Judge and bounded policy for a NEW run. */
  resolveMoaPolicy?: () => OrbitMoaPolicy | undefined
  /**
   * Resolve the DSH Session driving the current operation. A new run records
   * it and only that Session may answer its NEEDS_USER question.
   */
  resolveOwnerSessionId?: () => string | undefined
  browserTools: string[]
  commanderReadOnlyTools: string[]
  watchdogTools: string[]
  executorTools: string[]
  executorTimeoutMs?: number
}

export interface OrbitDoctorReport {
  status: 'pass' | 'warn' | 'fail'
  generatedAt: string
  checks: Array<{ name: string; status: 'pass' | 'warn' | 'fail'; detail: string }>
}

export class OrbitService extends Service {
  private readonly root: Context
  private readonly host: DshOrbitHost
  private readonly config: OrbitPluginConfig
  private readonly executions = new Map<string, { controller: AbortController; result: Promise<OrbitActionResult> }>()

  constructor(ctx: Context, config: OrbitPluginConfig) {
    super(ctx, 'orbit')
    this.root = ctx
    this.host = new DshOrbitHost(ctx)
    this.config = config
    if (ctx.tools.get(ORBIT_COMMANDER_DECISION_TOOL) === undefined) {
      ctx.tools.register(createCommanderDecisionTool((agent, submission) => this.host.captureCommanderDecision(agent, submission)))
    }
  }

  private publishRuntime(state: import('./types.ts').OrbitState): void {
    const owner = state.owner_session_id
    if (!owner) return
    const session = this.root.sessions.get(SessionId(owner))
    if (!session) return
    session.append('orbit/runtime', orbitRuntimeFromState(state))
  }

  supervisorFor(projectDir: string): OrbitSupervisor {
    return new OrbitSupervisor(new OrbitStateStore(projectDir, (state) => this.publishRuntime(state)), this.host, {
      defaultRoutes: this.config.routes,
      ...(this.config.resolveRoutes ? { resolveRoutes: this.config.resolveRoutes } : {}),
      ...(this.config.resolveMoaPolicy ? { resolveMoaPolicy: this.config.resolveMoaPolicy } : {}),
      ...(this.config.resolveOwnerSessionId ? { resolveOwnerSessionId: this.config.resolveOwnerSessionId } : {}),
      browserTools: this.config.browserTools,
      commanderReadOnlyTools: this.config.commanderReadOnlyTools,
      watchdogTools: this.config.watchdogTools,
      executorTools: this.config.executorTools,
      ...(this.config.executorTimeoutMs ? { executorTimeoutMs: this.config.executorTimeoutMs } : {}),
    })
  }

  private resolveProjectDir(projectDir?: string): string {
    return resolve(projectDir ?? this.config.projectDir ?? process.cwd())
  }

  run(input: OrbitRunInput, projectDir?: string, signal?: AbortSignal): Promise<OrbitActionResult> {
    const dir = this.resolveProjectDir(projectDir)
    return this.execute(dir, signal, (activeSignal) => this.supervisorFor(dir).bootstrap(input, activeSignal))
  }

  private async execute(dir: string, signal: AbortSignal | undefined, operation: (signal: AbortSignal) => Promise<OrbitActionResult>): Promise<OrbitActionResult> {
    if (this.executions.has(dir)) return { ok: false, action: 'run', message: 'ORBIT_MUTATION_DRIVER_CONFLICT: 此 workspace 已有 Orbit 执行中的调用。' }
    const controller = new AbortController()
    const abort = (): void => controller.abort()
    if (signal?.aborted) controller.abort()
    signal?.addEventListener('abort', abort, { once: true })
    const result = Promise.resolve().then(() => operation(controller.signal))
    this.executions.set(dir, { controller, result })
    try {
      const settled = await result
      if (settled.phase === 'SUCCESS' || settled.phase === 'STOPPED' || settled.phase === 'BUDGET_EXHAUSTED' || settled.message === 'ORBIT_ABORTED') {
        await this.host.revokeWorkspace(dir)
      }
      return settled
    } catch (error) {
      await this.host.revokeWorkspace(dir)
      throw error
    } finally {
      signal?.removeEventListener('abort', abort)
      this.executions.delete(dir)
    }
  }

  async resume(input: OrbitRunInput, projectDir?: string, signal?: AbortSignal): Promise<OrbitActionResult> {
    const dir = this.resolveProjectDir(projectDir)
    const state = new OrbitStateStore(dir).readState()
    if (!state) return { ok: false, action: 'resume', message: 'ORBIT_RUN_NOT_FOUND: 没有可继续的持久化 Run。' }
    const supervisor = this.supervisorFor(dir)
    if (input.run_id && input.run_id !== state.run_id) return { ok: false, action: 'resume', message: 'ORBIT_RUN_NOT_FOUND: Run id 不匹配。' }
    if (state.phase === 'NEEDS_USER') {
      if (state.owner_session_id !== undefined) return this.run(input, dir, signal)
      // Explicit resume is the only ownerless compatibility path; it never
      // adopts the caller or stores its message as a user reply.
      state.phase = state.plan.steps.length === 0 ? 'PLAN' : 'EXECUTE'
      state.status = 'running'
    }
    return this.execute(dir, signal, (activeSignal) => supervisor.run(state, activeSignal))
  }

  async stop(runId?: string, projectDir?: string): Promise<OrbitActionResult> {
    const dir = this.resolveProjectDir(projectDir)
    const state = new OrbitStateStore(dir).readState()
    if (runId && state?.run_id !== runId) return { ok: false, action: 'stop', message: 'ORBIT_RUN_NOT_FOUND: Run id 不匹配。' }
    const active = this.executions.get(dir)
    active?.controller.abort()
    if (active) await active.result.catch(() => undefined)
    await this.host.revokeWorkspace(dir)
    return this.supervisorFor(dir).stop('stop', runId)
  }

  status(projectDir?: string): Promise<OrbitActionResult> {
    return this.supervisorFor(this.resolveProjectDir(projectDir)).status()
  }

  recordGuardBlock(code: GuardCode, reason: string, projectDir?: string): Promise<GuardBlockOutcome> {
    return this.supervisorFor(this.resolveProjectDir(projectDir)).recordGuardBlock(code, reason)
  }

  hasActiveRun(projectDir?: string): boolean {
    const state = new OrbitStateStore(this.resolveProjectDir(projectDir)).readState()
    return state !== null && state.driver_ownership !== 'CLOSED'
  }

  isMutationAuthorized(agent: unknown, tool: string, projectDir?: string): boolean {
    return this.host.isMutationAuthorized(agent, this.resolveProjectDir(projectDir), tool)
  }

  browserToolNames(): readonly string[] {
    return this.config.browserTools
  }

  githubAllowed(projectDir?: string): boolean {
    const state = new OrbitStateStore(this.resolveProjectDir(projectDir)).readState()
    return state?.github_allowed === true
  }

  async doctor(projectDir?: string): Promise<OrbitDoctorReport> {
    const dir = this.resolveProjectDir(projectDir)
    const checks: OrbitDoctorReport['checks'] = []
    try {
      accessSync(existsSync(`${dir}/.cx`) ? `${dir}/.cx` : dir, constants.W_OK)
      checks.push({ name: 'state-storage', status: 'pass', detail: '状态存储目录可写' })
    } catch (error) {
      checks.push({ name: 'state-storage', status: 'fail', detail: String(error) })
    }
    checks.push({ name: 'subagent-service', status: this.ctx.subagents ? 'pass' : 'fail', detail: this.ctx.subagents ? 'ctx.subagents available' : 'ctx.subagents missing' })
    checks.push({ name: 'tools-service', status: this.ctx.tools ? 'pass' : 'fail', detail: this.ctx.tools ? 'ctx.tools available' : 'ctx.tools missing' })
    const browserTool = this.config.browserTools[0] ?? 'agent_browser'
    const browserAvailable = this.host.hasTool(browserTool)
    checks.push({
      name: 'browser-capability',
      status: browserAvailable ? 'pass' : 'warn',
      detail: browserAvailable ? `${browserTool} registered` : `${browserTool} unavailable; browser steps will fail with BROWSER_CAPABILITY_UNAVAILABLE`,
    })
    const executorRegistered = this.config.executorTools.filter((tool) => this.host.hasTool(tool))
    checks.push({
      name: 'executor-writer-scope',
      status: executorRegistered.length > 0 ? 'pass' : 'fail',
      detail: executorRegistered.length > 0 ? `executor allowlist: ${executorRegistered.join(', ')}` : 'no configured executor tool is registered',
    })
    const driverTools = ['create_goal', 'ralph', 'workflow'].filter((tool) => this.host.hasTool(tool))
    checks.push({
      name: 'mutation-driver-hook',
      status: 'pass',
      detail:
        driverTools.length > 0
          ? `Orbit mutation guard will deny ${driverTools.join(', ')} while a run is active`
          : 'no top-level mutation driver tool is registered in this profile',
    })
    checks.push({
      name: 'host-adapter-lifecycle',
      status: 'pass',
      detail: 'DshOrbitHost provides cancel/dispose/runtimeSnapshot for every role handle',
    })
    const reflect = this.ctx.reflect
    checks.push({ name: 'model-registry', status: reflect.get('llm') ? 'pass' : 'fail', detail: '使用 DSH 当前 LLM registry 校验模型，不内置角色模型。' })
    checks.push({ name: 'orbit-settings', status: reflect.get('settings') ? 'pass' : 'warn', detail: 'Commander / Watchdog / MoA 使用用户 Orbit 设置或显式 profile routes。' })
    try {
      const policy = this.config.resolveMoaPolicy?.()
      const availability = await new OrbitMoaAdapter(this.host).availability()
      checks.push({
        name: 'moa-integration',
        status: policy && !availability.available ? 'warn' : 'pass',
        detail: availability.available
          ? `@goodandready/dsh-moa ${availability.version ?? ''} 可用；Orbit 使用隔离候选、Judge 选优和受控 Promotion。`
          : policy
            ? availability.reason ?? 'MoA 不可用'
            : 'MoA 未启用；Orbit 单 Executor 模式不受影响。',
      })
    } catch (error) {
      checks.push({ name: 'moa-integration', status: 'warn', detail: String(error) })
    }
    try {
      const routes = this.config.resolveRoutes?.()
      const issues = routes ? await this.host.validateRoutes({ ...routes }) : ['未配置模型解析来源']
      checks.push({ name: 'role-model-configuration', status: issues.length ? 'warn' : 'pass', detail: issues.join('；') || '三角色用户模型配置可用。' })
    } catch (error) {
      checks.push({ name: 'role-model-configuration', status: 'warn', detail: String(error) })
    }
    checks.push({ name: 'tested-dsh-version', status: 'pass', detail: 'tested against @deepseek-ai/dsh 0.1.5-rc.2' })
    const status = checks.some((check) => check.status === 'fail') ? 'fail' : checks.some((check) => check.status === 'warn') ? 'warn' : 'pass'
    return { status, generatedAt: new Date().toISOString(), checks }
  }
}
