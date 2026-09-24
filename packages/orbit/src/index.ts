import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-settings'
import { AssistantStreamAccumulator, boundContextSummary, createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import z from '@deepseek-ai/schemastery'
import { installOrbitGestureBoundary, registerOrbitCommand, registerOrbitToggleCommand } from './activation.ts'
import { createOrbitPreExecuteHandler } from './pipeline-guard.ts'
import { agentDefaultSelectionOf, resolveEffectiveRoutes, resolveMoaPolicy, sessionModelSelectionOf, sessionModelStateOf, type OrbitMoaRouteSettings, type OrbitRouteSettings } from './routes.ts'
import { installOrbitSessionProjection, orbitEnabledOf } from './session-state.ts'
import { OrbitService, type OrbitPluginConfig } from './service.ts'
import { createOrbitTool } from './tool.ts'
import type { OrbitActionResult, OrbitRoute } from './types.ts'
import type { OrbitConfiguredRoutes } from './routes.ts'

export const name = 'dsh-orbit'
export const inject = ['tools', 'agents', 'subagents', 'sessions']

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
export const OrbitMoaSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  candidateCount: z.natural().default(3),
  peerCritique: z.boolean().default(false),
  maxMoaSteps: z.natural().default(2),
  candidates: z.array(RoleRoute).default([]),
  judge: RoleRoute,
})

export const OrbitRouteSettingsSchema = z.object({
  commander: RoleRoute,
  watchdog: RoleRoute,
  moa: OrbitMoaSettingsSchema,
})

export const Config = z.object({
  projectDir: z.string(),
  routes: z
    .object({
      commander: Route,
      executor: Route,
      watchdog: Route,
    })
    .default({} as never),
  moa: OrbitMoaSettingsSchema.default({} as never),
  browserTools: z.array(z.string()).default(['agent_browser']),
  commanderReadOnlyTools: z.array(z.string()).default(['read', 'read_image', 'glob', 'grep', 'web_search', 'web_fetch']),
  watchdogTools: z.array(z.string()).default(['read', 'read_image', 'glob', 'grep']),
  executorTools: z
    .array(z.string())
    .default(['read', 'read_image', 'glob', 'grep']),
  executorTimeoutMs: z.natural().default(480_000),
  heartbeatEnabled: z.boolean().default(true),
  heartbeatIntervalMs: z.natural().default(120_000),
  heartbeatHealthyIntervalMs: z.natural().default(180_000),
  heartbeatSuspectIntervalMs: z.natural().default(60_000),
  finalAuditEnabled: z.boolean().default(true),
  registerTool: z.boolean().default(true),
  registerGuards: z.boolean().default(true),
  slashCommand: z.boolean().default(true),
})

export interface OrbitConfigShape {
  projectDir?: string
  routes: OrbitConfiguredRoutes
  moa: OrbitMoaRouteSettings
  browserTools: string[]
  commanderReadOnlyTools: string[]
  watchdogTools: string[]
  executorTools: string[]
  executorTimeoutMs: number
  heartbeatEnabled: boolean
  heartbeatIntervalMs: number
  heartbeatHealthyIntervalMs: number
  heartbeatSuspectIntervalMs: number
  finalAuditEnabled: boolean
  registerTool: boolean
  registerGuards: boolean
  slashCommand: boolean
}

interface GoalsLike {
  get(agent: unknown): { phase?: string } | undefined
}

export function apply(ctx: Context, config: OrbitConfigShape): void {
  // Orbit settings bridge. The package ships no model defaults; only explicit
  // profile routes can act as a headless compatibility fallback.
  let readRouteSettings: () => OrbitRouteSettings | undefined = () => undefined
  let readMoaPrices: () => Record<string, { input: number; output: number; cacheHit?: number }> | undefined = () => undefined
  ctx.inject(['settings'], (settingsCtx) => {
    const scope = settingsCtx.settings.register('orbit', OrbitRouteSettingsSchema, {
      base: {
        commander: { provider: '', model: '', reasoningEffort: '' },
        watchdog: { provider: '', model: '', reasoningEffort: '' },
        moa: {
          enabled: config.moa.enabled ?? false,
          candidateCount: config.moa.candidateCount ?? 3,
          peerCritique: config.moa.peerCritique ?? false,
          maxMoaSteps: config.moa.maxMoaSteps ?? 2,
          candidates: (config.moa.candidates ?? []).map((route) => ({
            provider: route.provider,
            model: route.model,
            reasoningEffort: route.reasoningEffort ?? '',
          })),
          judge: config.moa.judge
            ? { provider: config.moa.judge.provider, model: config.moa.judge.model, reasoningEffort: config.moa.judge.reasoningEffort ?? '' }
            : { provider: '', model: '', reasoningEffort: '' },
        },
      },
    })
    readRouteSettings = () => scope.get()
    readMoaPrices = () => {
      const value = settingsCtx.settings.get('dsh-moa') as { prices?: Record<string, { input: number; output: number; cacheHit?: number }> } | undefined
      return value?.prices
    }
    settingsCtx.effect(() => () => {
      readRouteSettings = () => undefined
      readMoaPrices = () => undefined
    })
  })

  // A NEW run resolves its three routes exactly once: Commander/Watchdog from
  // the Orbit settings (base = config), Executor from the initiating Session's
  // current model with DSH `selectionFor(agent)` semantics (pending choice →
  // logged header → deployment default). Explicit config routes are only for
  // sessions without a DSH model source. Existing runs resume from frozen routes.
  const resolveRoutes = () => {
    const agent = ctx.agents.currentInitiator()
    return resolveEffectiveRoutes({
      configRoutes: config.routes,
      settings: readRouteSettings(),
      hasSession: agent !== undefined,
      sessionSelection: sessionModelSelectionOf({
        sessionModel: sessionModelStateOf(ctx, agent?.session),
        requestHeader: agent?.session?.requestHeader?.(),
        agentDefault: agent === undefined ? undefined : agentDefaultSelectionOf(ctx),
      }),
    })
  }

  // The DSH Session driving the current operation: a new run records it, and
  // only that Session may answer the run's NEEDS_USER question.
  const resolveMoaPolicyForRun = () => resolveMoaPolicy({
    settings: readRouteSettings()?.moa,
    config: config.moa,
    ...(readMoaPrices() ? { prices: readMoaPrices() } : {}),
  })

  const resolveOwnerSessionId = (): string | undefined => {
    const agent = ctx.agents.currentInitiator()
    return agent === undefined ? undefined : String(agent.session.id)
  }

  const serviceConfig: OrbitPluginConfig = {
    routes: config.routes,
    resolveRoutes,
    resolveMoaPolicy: resolveMoaPolicyForRun,
    resolveOwnerSessionId,
    browserTools: config.browserTools,
    commanderReadOnlyTools: config.commanderReadOnlyTools,
    watchdogTools: config.watchdogTools,
    executorTools: config.executorTools,
    executorTimeoutMs: config.executorTimeoutMs,
    heartbeatEnabled: config.heartbeatEnabled ?? true,
    heartbeatIntervalMs: config.heartbeatIntervalMs ?? 120_000,
    heartbeatHealthyIntervalMs: config.heartbeatHealthyIntervalMs ?? 180_000,
    heartbeatSuspectIntervalMs: config.heartbeatSuspectIntervalMs ?? 60_000,
    finalAuditEnabled: config.finalAuditEnabled ?? true,
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
    competingMutationBlock: (agent, messages) => {
      const cwd = agent.session.header.cwd ?? process.cwd()
      if (!service.hasActiveRun(cwd)) return undefined
      const latest = [...messages].reverse().find((message) => message.source.kind === 'user')
      const text = latest?.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n').trimStart() ?? ''
      return /^\/moa(?=$|[\t\n\r ])/u.test(text)
        ? 'ORBIT_MUTATION_DRIVER_CONFLICT: 当前 workspace 已由 Orbit 持有，不能同时启动独立 /moa。请先完成或停止当前 Orbit Run。'
        : undefined
    },
    onBlocked: (agent, reason) => appendOrbitNotice(agent.session, reason),
    activate: async (agent, goal, position, signal) => {
      const cwd = agent.session.header.cwd ?? process.cwd()
      let result: OrbitActionResult
      try {
        // The initiator scope makes the run's children belong to this Agent;
        // the parent model is never asked to decide or to run the task.
        result = await ctx.agents.withInitiator(agent, () => service.run({ goal }, cwd, signal, String(agent.session.id)))
      } catch (error) {
        appendOrbitNotice(agent.session, `Orbit 启动失败：${error instanceof Error ? error.message : String(error)}`)
        return
      }
      if (result.ok && result.phase === 'SUCCESS' && result.final_output !== undefined) {
        appendOrbitFinalOutput(agent.session, position, result.final_output)
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

  {
    const handler = createOrbitPreExecuteHandler(service, {
      contentGuards: config.registerGuards,
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

/** Append the existing Final Commander answer as this consumed turn's sole assistant result. */
function appendOrbitFinalOutput(
  session: Session,
  position: { turn: number; step: number },
  output: NonNullable<OrbitActionResult['final_output']>,
): void {
  const message = createAssistantMessage({
    content: [{ type: 'text', text: output.text }],
    source: { provider: output.provider, model: output.model },
  })
  const stream = new AssistantStreamAccumulator()
  const time = Date.now()
  stream.push({ time, chunk: { type: 'block-start', index: 0, blockType: 'text' } })
  stream.push({ time, chunk: { type: 'text-delta', index: 0, text: output.text } })
  stream.push({ time, chunk: { type: 'block-end', index: 0, block: { type: 'text', text: output.text } } })
  stream.push({ time, chunk: { type: 'finish', reason: { kind: 'stop' } } })

  session.append('step/start', position)
  try {
    session.append('assistant/message', { ...position, message, stream: [...stream.snapshot()] }, { surfaceOp: 'append' })
  } finally {
    session.append('step/end', position)
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
  if (result.message?.startsWith('ORBIT_NEEDS_USER_OTHER_SESSION') === true || result.message?.startsWith('ORBIT_NEEDS_USER_OWNER_UNKNOWN') === true) {
    // Another Session owns the waiting run: report instead of consuming the
    // message as its reply.
    return result.message
  }
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
