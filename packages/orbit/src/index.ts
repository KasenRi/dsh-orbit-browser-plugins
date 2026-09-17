import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-settings'
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import z from '@deepseek-ai/schemastery'
import { installOrbitGestureBoundary, registerOrbitCommand, registerOrbitToggleCommand } from './activation.ts'
import { estimateLoopCount } from './kernel.ts'
import { createOrbitPreExecuteHandler } from './pipeline-guard.ts'
import { resolveEffectiveRoutes, sessionModelStateOf, sessionSelectionOf, type OrbitRouteSettings } from './routes.ts'
import { installOrbitSessionProjection, orbitEnabledOf } from './session-state.ts'
import { OrbitService, type OrbitPluginConfig } from './service.ts'
import { createOrbitTool } from './tool.ts'
import type { OrbitActionResult, OrbitRoute, OrbitRoutes } from './types.ts'

/**
 * Minimum loop budget for a hard-activated run. The Commander is asked for a
 * 2-5 step plan and every executed step consumes one loop slot, so the host
 * must grant a budget that can finish a full plan; the goal complexity
 * estimate raises it further when the goal asks for more.
 */
const HARD_ACTIVATION_MIN_LOOPS = 5

export const name = 'dsh-orbit'
export const inject = ['tools', 'agents', 'subagents']

const Route = z.object({
  provider: z.string(),
  model: z.string(),
  reasoningEffort: z.string(),
})

const RoleRoute = z.object({
  provider: z.string().default(''),
  model: z.string().default(''),
  reasoningEffort: z.string().default(''),
})

/** `orbit` settings namespace: the two role routes Orbit persists itself. */
export const OrbitRouteSettingsSchema = z.object({
  commander: RoleRoute,
  watchdog: RoleRoute,
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
  // Orbit settings bridge: register the `orbit` namespace with the composition
  // routes as its base/default, so a user who never opens the model UI keeps
  // today's behavior exactly. Lazily injected: minimal/headless compositions
  // without a settings provider keep running from `config.routes`.
  let routeSettings: OrbitRouteSettings | undefined
  ctx.inject(['settings'], (settingsCtx) => {
    const baseRoute = (route: OrbitRoute): { provider: string; model: string; reasoningEffort: string } => ({
      provider: route.provider,
      model: route.model,
      reasoningEffort: route.reasoningEffort ?? '',
    })
    const scope = settingsCtx.settings.register('orbit', OrbitRouteSettingsSchema, {
      base: {
        commander: baseRoute(config.routes.commander),
        watchdog: baseRoute(config.routes.watchdog),
      },
    })
    const sync = (): void => {
      routeSettings = scope.get()
    }
    sync()
    scope.watch(() => {
      sync()
    })
  })

  // A NEW run resolves its three routes exactly once: Commander/Watchdog from
  // the Orbit settings (base = config), Executor from the initiating Session's
  // durable `modelSelection` projection (pending → lastUsed), with the public
  // request-header seam and the config route as compatibility fallbacks for
  // surfaces without one. Existing runs resume from their frozen
  // `state.routes`.
  const resolveRoutes = (): OrbitRoutes => {
    const agent = ctx.agents.currentInitiator()
    return resolveEffectiveRoutes({
      configRoutes: config.routes,
      settings: routeSettings,
      sessionModel: sessionModelStateOf(ctx, agent?.session),
      sessionSelection: sessionSelectionOf(agent),
    })
  }

  const serviceConfig: OrbitPluginConfig = {
    routes: config.routes,
    resolveRoutes,
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

  // Slash-command registration is its own switch: the `/agent-orbit` command
  // (surfaces in the Web GUI slash menu through the Harness commands client)
  // rides `slashCommand`, while the per-chat toggle command and the host
  // activation boundary below never depend on it. `commands` is registered
  // lazily: a minimal composition without the command registry keeps Orbit
  // fully functional — the fiber never pends on it, and the activation
  // boundary (explicit `/agent-orbit` messages and enabled-Session ordinary
  // messages) still runs.
  ctx.inject(['commands'], (commandCtx) => {
    registerOrbitToggleCommand(commandCtx)
    if (config.slashCommand) registerOrbitCommand(commandCtx)
  })

  installOrbitGestureBoundary(ctx, {
    sessionEnabled: (session) => orbitEnabledOf(ctx, session),
    activate: async (agent, goal, signal) => {
      const cwd = agent.session.header.cwd ?? process.cwd()
      let result: OrbitActionResult
      try {
        // The initiator scope makes the run's children belong to this Agent;
        // the parent model is never asked to decide or to run the task.
        result = await ctx.agents.withInitiator(agent, () => service.run({
          goal,
          approved_loop_count: Math.max(estimateLoopCount(goal), HARD_ACTIVATION_MIN_LOOPS),
        }, cwd, signal))
      } catch (error) {
        appendOrbitNotice(agent.session, `Orbit 启动失败：${error instanceof Error ? error.message : String(error)}`)
        return
      }
      const notice = activationNotice(result)
      if (notice !== undefined) appendOrbitNotice(agent.session, notice)
    },
  })

  // Per-Session Orbit enable state: natively durable through the Session log
  // and the projection registry. Minimal compositions without the registry
  // keep the feature inert (OFF) while `/agent-orbit` keeps working.
  ctx.inject(['sessionProjections'], (projectionCtx) => {
    installOrbitSessionProjection(projectionCtx)
  })

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

/**
 * One durable, user-visible Orbit notice. The DSH `plugin` + `form: 'notice'`
 * source renders as a collapsed notice row instead of a user message, and the
 * text stays part of the conversation so the next turn can read the outcome.
 */
function appendOrbitNotice(session: Session, text: string): void {
  session.append(
    'user/message',
    createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'plugin', plugin: 'dsh-orbit', form: 'notice', summary: boundContextSummary(text) },
    }),
    { surfaceOp: 'append' },
  )
}

/**
 * What the user must see when a hard-activated turn did not simply succeed:
 * the waiting run's question, a refused start, or an unfinished run. The
 * host stays the only mutation driver; the notice is reporting, never a
 * hand-back of execution to the parent model.
 */
function activationNotice(result: OrbitActionResult): string | undefined {
  if (result.ok && result.phase !== 'NEEDS_USER') return undefined
  const lastError = result.data?.['last_error']
  const reason = result.message ?? (typeof lastError === 'string' && lastError !== '' ? lastError : undefined)
  if (result.phase === 'NEEDS_USER') {
    return reason !== undefined && !reason.startsWith('COMMANDER_')
      ? `Orbit 需要你的回复：${reason}`
      : 'Orbit 需要你的回复：请回复当前运行需要的信息。'
  }
  if (result.message?.startsWith('ORBIT_ACTIVE_RUN_EXISTS') === true) {
    return `Orbit 未接受这条新任务：${result.message}`
  }
  const phase = result.phase ?? 'UNKNOWN'
  return `Orbit 运行未完成（phase=${phase}）${reason !== undefined ? `：${reason}` : ''}`
}
