import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { installOrbitGestureBoundary, registerOrbitCommand } from './activation.ts'
import { createOrbitPreExecuteHandler } from './pipeline-guard.ts'
import { OrbitService, type OrbitPluginConfig } from './service.ts'
import { createOrbitTool } from './tool.ts'
import type { OrbitRoute } from './types.ts'

export const name = 'dsh-orbit'
export const inject = ['tools', 'agents', 'subagents']

const Route = z.object({
  provider: z.string(),
  model: z.string(),
  reasoningEffort: z.string(),
})

export const Config = z.object({
  projectDir: z.string(),
  routes: z
    .object({
      commander: Route,
      executor: Route,
      watchdog: Route,
    })
    .default({
      commander: { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'high' },
      executor: { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'high' },
      watchdog: { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'low' },
    }),
  browserTools: z.array(z.string()).default(['agent_browser']),
  commanderReadOnlyTools: z.array(z.string()).default(['read', 'read_image', 'glob', 'grep', 'web_search', 'web_fetch']),
  watchdogTools: z.array(z.string()).default(['read', 'read_image', 'glob', 'grep']),
  executorTools: z
    .array(z.string())
    .default(['read', 'read_image', 'glob', 'grep', 'bash', 'write', 'edit', 'str_replace_editor', 'web_search', 'web_fetch']),
  executorTimeoutMs: z.natural().default(480_000),
  registerTool: z.boolean().default(true),
  registerGuards: z.boolean().default(true),
  slashCommand: z.boolean().default(true),
})

export interface OrbitConfigShape {
  projectDir?: string
  routes: { commander: OrbitRoute; executor: OrbitRoute; watchdog: OrbitRoute }
  browserTools: string[]
  commanderReadOnlyTools: string[]
  watchdogTools: string[]
  executorTools: string[]
  executorTimeoutMs: number
  registerTool: boolean
  registerGuards: boolean
  slashCommand: boolean
}

interface GoalsLike {
  get(agent: unknown): { phase?: string } | undefined
}

export function apply(ctx: Context, config: OrbitConfigShape): void {
  const serviceConfig: OrbitPluginConfig = {
    routes: config.routes,
    browserTools: config.browserTools,
    commanderReadOnlyTools: config.commanderReadOnlyTools,
    watchdogTools: config.watchdogTools,
    executorTools: config.executorTools,
    executorTimeoutMs: config.executorTimeoutMs,
    ...(config.projectDir ? { projectDir: config.projectDir } : {}),
  }
  const service = new OrbitService(ctx, serviceConfig)
  ctx.effect(() => () => undefined, 'dsh-orbit.service')

  // Legacy alias: the same OrbitService instance is reachable as `ctx.cx`.
  ctx.provide('cx', service)

  if (config.registerTool) {
    ctx.tools.register(createOrbitTool(ctx))
    ctx.tools.register(createOrbitTool(ctx, { legacy: true }))
  }

  // Deterministic activation surfaces: the closed-namespace `/agent-orbit`
  // host command (surfaces in the Web GUI slash menu through the Harness
  // commands client) and the genuine-user-message gesture boundary for
  // surfaces without command adjudication (headless CLI). Both default on.
  //
  // `commands` is registered lazily, not a required inject: every standard
  // profile mounts it, but a minimal composition that omits the command
  // registry keeps Orbit fully functional — the fiber never pends on it and
  // simply never gains the slash command, while the gesture boundary still
  // works.
  if (config.slashCommand) {
    ctx.inject(['commands'], (commandCtx) => {
      registerOrbitCommand(commandCtx)
    })
    installOrbitGestureBoundary(ctx)
  }

  if (config.registerGuards) {
    const handler = createOrbitPreExecuteHandler(service, {
      competingDriver: (agent) => {
        const reflect = (ctx as unknown as { reflect?: { get(name: string, strict?: boolean): unknown } }).reflect
        const goals = reflect?.get('goals') as GoalsLike | undefined
        if (goals && agent) {
          try {
            const goal = goals.get(agent)
            if (goal?.phase === 'active') return 'goal'
          } catch {
            return undefined
          }
        }
        return undefined
      },
    })
    ctx.on('tools/pre-execute', (exec, next) => handler(exec as never, next as never) as never)
  }
}
