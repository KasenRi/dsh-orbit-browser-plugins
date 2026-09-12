import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createCxPreExecuteHandler } from './pipeline-guard.ts'
import { CxService, type CxPluginConfig } from './service.ts'
import { createCxTool } from './tool.ts'
import type { CxRoute } from './types.ts'

export const name = 'dsh-cx'
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
})

export interface CxConfigShape {
  projectDir?: string
  routes: { commander: CxRoute; executor: CxRoute; watchdog: CxRoute }
  browserTools: string[]
  commanderReadOnlyTools: string[]
  watchdogTools: string[]
  executorTools: string[]
  executorTimeoutMs: number
  registerTool: boolean
  registerGuards: boolean
}

interface GoalsLike {
  get(agent: unknown): { phase?: string } | undefined
}

export function apply(ctx: Context, config: CxConfigShape): void {
  const serviceConfig: CxPluginConfig = {
    routes: config.routes,
    browserTools: config.browserTools,
    commanderReadOnlyTools: config.commanderReadOnlyTools,
    watchdogTools: config.watchdogTools,
    executorTools: config.executorTools,
    executorTimeoutMs: config.executorTimeoutMs,
    ...(config.projectDir ? { projectDir: config.projectDir } : {}),
  }
  const service = new CxService(ctx, serviceConfig)
  ctx.effect(() => () => undefined, 'dsh-cx.service')

  if (config.registerTool) ctx.tools.register(createCxTool(ctx))

  if (config.registerGuards) {
    const handler = createCxPreExecuteHandler(service, {
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
