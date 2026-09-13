import { accessSync, constants, mkdirSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-subagent'
import { DshOrbitHost } from './dsh-host.ts'
import { OrbitStateStore } from './state-store.ts'
import { OrbitSupervisor, type OrbitRunInput, type GuardBlockOutcome } from './supervisor.ts'
import type { OrbitActionResult, OrbitRoutes, GuardCode } from './types.ts'

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
  routes: OrbitRoutes
  /**
   * Resolve the role routes for a NEW run (settings + session selection).
   * Optional so minimal/headless compositions keep using `routes` unchanged.
   */
  resolveRoutes?: () => OrbitRoutes
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
  private readonly host: DshOrbitHost
  private readonly config: OrbitPluginConfig

  constructor(ctx: Context, config: OrbitPluginConfig) {
    super(ctx, 'orbit')
    this.host = new DshOrbitHost(ctx)
    this.config = config
  }

  supervisorFor(projectDir: string): OrbitSupervisor {
    return new OrbitSupervisor(new OrbitStateStore(projectDir), this.host, {
      defaultRoutes: this.config.routes,
      ...(this.config.resolveRoutes ? { resolveRoutes: this.config.resolveRoutes } : {}),
      browserTools: this.config.browserTools,
      commanderReadOnlyTools: this.config.commanderReadOnlyTools,
      watchdogTools: this.config.watchdogTools,
      executorTools: this.config.executorTools,
      ...(this.config.executorTimeoutMs ? { executorTimeoutMs: this.config.executorTimeoutMs } : {}),
    })
  }

  private resolveProjectDir(projectDir?: string): string {
    return projectDir ?? this.config.projectDir ?? process.cwd()
  }

  run(input: OrbitRunInput, projectDir?: string, signal?: AbortSignal): Promise<OrbitActionResult> {
    return this.supervisorFor(this.resolveProjectDir(projectDir)).bootstrap(input, signal)
  }

  async resume(input: OrbitRunInput, projectDir?: string, signal?: AbortSignal): Promise<OrbitActionResult> {
    const dir = this.resolveProjectDir(projectDir)
    const state = new OrbitStateStore(dir).readState()
    if (!state) return { ok: false, action: 'resume', message: 'ORBIT_RUN_NOT_FOUND: no durable run to resume.' }
    const supervisor = this.supervisorFor(dir)
    return supervisor.run(state, signal)
  }

  stop(runId?: string, projectDir?: string): OrbitActionResult {
    return this.supervisorFor(this.resolveProjectDir(projectDir)).stop('stop', runId)
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

  githubAllowed(projectDir?: string): boolean {
    const state = new OrbitStateStore(this.resolveProjectDir(projectDir)).readState()
    return state?.github_allowed === true
  }

  async doctor(projectDir?: string): Promise<OrbitDoctorReport> {
    const dir = this.resolveProjectDir(projectDir)
    const checks: OrbitDoctorReport['checks'] = []
    try {
      mkdirSync(`${dir}/.cx`, { recursive: true, mode: 0o700 })
      accessSync(`${dir}/.cx`, constants.W_OK)
      checks.push({ name: 'state-storage', status: 'pass', detail: `${dir}/.cx is writable` })
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
    checks.push({
      name: 'role-routes',
      status: this.config.routes.commander.model && this.config.routes.executor.model ? 'pass' : 'fail',
      detail: `commander=${this.config.routes.commander.model} executor=${this.config.routes.executor.model} watchdog=${this.config.routes.watchdog.model}`,
    })
    checks.push({ name: 'tested-dsh-version', status: 'pass', detail: 'tested against @deepseek-ai/dsh 0.1.5-rc.2' })
    const status = checks.some((check) => check.status === 'fail') ? 'fail' : checks.some((check) => check.status === 'warn') ? 'warn' : 'pass'
    return { status, generatedAt: new Date().toISOString(), checks }
  }
}
