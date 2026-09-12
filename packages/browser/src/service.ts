import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import { defaultCommandExecutor, resolveExecutable } from './cli.ts'
import { resolveRunnerConfig, type BrowserPluginConfig } from './config.ts'
import { runDoctor, type DoctorReport } from './doctor.ts'
import { BrowserRunner, type BrowserRunnerDeps } from './runner.ts'
import type { AgentBrowserInput, AgentBrowserResult, RunContext } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    browserAutomation: BrowserAutomationService
  }
}

export interface BrowserServiceDeps extends BrowserRunnerDeps {}

/**
 * Controlled browser automation service. The model-facing `agent_browser` tool
 * is only an adapter over this service; other plugins consume `ctx.browserAutomation`.
 */
export class BrowserAutomationService extends Service {
  private readonly runner: BrowserRunner
  private readonly config: BrowserPluginConfig
  private readonly deps: BrowserServiceDeps

  constructor(ctx: Context, config: BrowserPluginConfig, deps: BrowserServiceDeps = {}) {
    super(ctx, 'browserAutomation')
    this.config = config
    this.deps = deps
    this.runner = new BrowserRunner(resolveRunnerConfig(config), deps)
  }

  run(input: AgentBrowserInput, context: RunContext): Promise<AgentBrowserResult> {
    return this.runner.run(input, context)
  }

  async doctor(): Promise<DoctorReport> {
    const executable =
      this.deps.commandPath ?? resolveExecutable(this.config.command, (this.deps.env ?? process.env).PATH)
    return runDoctor({
      cwd: process.cwd(),
      env: this.deps.env ?? process.env,
      executor: this.deps.executor ?? defaultCommandExecutor,
      ...(executable ? { executable } : {}),
      requiresAllowedDomains: (this.config.allowedDomains ?? []).length > 0,
    })
  }

  inspectSession(sessionName: string): ReturnType<BrowserRunner['inspectSession']> {
    return this.runner.inspectSession(sessionName)
  }

  close(sessionName?: string): Promise<void> {
    return this.runner.close(sessionName)
  }
}
