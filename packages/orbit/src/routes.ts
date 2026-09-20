/** Effective route resolution for a new Orbit run. */

import { DEFAULT_MAX_MOA_STEPS, DEFAULT_MOA_CANDIDATES, type OrbitMoaPolicy, type OrbitMoaPriceRow, type OrbitRoute, type OrbitRole, type OrbitRoutes } from './types.ts'

export type OrbitConfiguredRoutes = Partial<Record<OrbitRole, OrbitRoute>>

/** The `orbit` settings section: the two roles Orbit stores itself. */
export interface OrbitMoaRouteSettings {
  enabled?: boolean
  candidateCount?: number
  peerCritique?: boolean
  maxMoaSteps?: number
  candidates?: OrbitRoute[]
  judge?: OrbitRoute
}

export interface OrbitRouteSettings {
  commander?: OrbitRoute
  watchdog?: OrbitRoute
  moa?: OrbitMoaRouteSettings
}

/** Structural view of a model selection (Host `ModelSelection` / header config). */
export interface ModelSelectionLike {
  provider?: unknown
  model?: unknown
  reasoningEffort?: unknown
}

export interface SessionModelStateLike {
  lastUsed?: ModelSelectionLike | null
  pending?: ModelSelectionLike | null
}

export interface SessionHeaderLike {
  config?: ModelSelectionLike | undefined
  adapterDefaults?: { reasoningEffort?: unknown } | undefined
}

interface ProjectionRegistryLike {
  stateOf?: (session: unknown, key: string) => unknown
}

interface AgentDefaultModelLike {
  currentSelection?: () => unknown
}

export function projectionRegistryOf(ctx: unknown): ProjectionRegistryLike | undefined {
  const reflect = (ctx as { reflect?: { get(name: string, strict?: boolean): unknown } } | undefined)?.reflect
  const registry = reflect?.get('sessionProjections')
  return registry !== null && typeof registry === 'object' ? (registry as ProjectionRegistryLike) : undefined
}

export function sessionModelStateOf(ctx: unknown, session: unknown): SessionModelStateLike | undefined {
  const state = projectionRegistryOf(ctx)?.stateOf?.(session, 'modelSelection')
  return state !== null && typeof state === 'object' ? (state as SessionModelStateLike) : undefined
}

/** Read-only access to DSH's deployment model selection. */
export function agentDefaultSelectionOf(ctx: unknown): ModelSelectionLike | undefined {
  const reflect = (ctx as { reflect?: { get(name: string, strict?: boolean): unknown } } | undefined)?.reflect
  const service = reflect?.get('agentDefaultModel') as AgentDefaultModelLike | undefined
  if (service?.currentSelection === undefined) return undefined
  try {
    const selection = service.currentSelection()
    return selection !== null && typeof selection === 'object' ? (selection as ModelSelectionLike) : undefined
  } catch {
    return undefined
  }
}

export interface SessionSelectionSources {
  sessionModel?: SessionModelStateLike | undefined
  requestHeader?: SessionHeaderLike | undefined
  agentDefault?: ModelSelectionLike | undefined
}

/** DSH selection intent: pending choice, last request, then deployment default. */
export function sessionModelSelectionOf(sources: SessionSelectionSources): ModelSelectionLike | undefined {
  const pending = sources.sessionModel?.pending
  if (pending !== undefined && pending !== null) return pending
  const header = sources.requestHeader
  if (header?.config !== undefined) {
    const effort = header.config.reasoningEffort
    const adapterDefaultEffort = header.adapterDefaults?.reasoningEffort === true
    return {
      provider: header.config.provider,
      model: header.config.model,
      ...(effort === undefined || effort === '' || adapterDefaultEffort ? {} : { reasoningEffort: effort }),
    }
  }
  return sources.agentDefault
}

/** Normalize a user-owned selection; whitespace and malformed effort are invalid. */
export function routeFromSelection(selection: ModelSelectionLike | undefined): OrbitRoute | undefined {
  if (selection === undefined) return undefined
  const provider = typeof selection.provider === 'string' ? selection.provider.trim() : ''
  const model = typeof selection.model === 'string' ? selection.model.trim() : ''
  if (provider === '' || model === '') return undefined
  const effort = selection.reasoningEffort
  if (effort !== undefined && typeof effort !== 'string') return undefined
  return {
    provider,
    model,
    ...(typeof effort === 'string' && effort.trim() !== '' ? { reasoningEffort: effort.trim() } : {}),
  }
}

export interface ResolveMoaPolicyInput {
  settings?: OrbitMoaRouteSettings
  config?: OrbitMoaRouteSettings
  prices?: Record<string, OrbitMoaPriceRow>
}

/** Resolve the optional MoA policy for a NEW run. No model is guessed or inherited. */
export function resolveMoaPolicy(input: ResolveMoaPolicyInput): OrbitMoaPolicy | undefined {
  const enabled = input.settings?.enabled ?? input.config?.enabled ?? false
  if (!enabled) return undefined
  const candidateCount = input.settings?.candidateCount ?? input.config?.candidateCount ?? DEFAULT_MOA_CANDIDATES
  const peerCritique = input.settings?.peerCritique ?? input.config?.peerCritique ?? false
  const maxMoaSteps = input.settings?.maxMoaSteps ?? input.config?.maxMoaSteps ?? DEFAULT_MAX_MOA_STEPS
  const rawCandidates = input.settings?.candidates?.length ? input.settings.candidates : input.config?.candidates ?? []
  const candidates = rawCandidates.map((route) => routeFromSelection(route)).filter((route): route is OrbitRoute => route !== undefined)
  const judge = routeFromSelection(input.settings?.judge) ?? routeFromSelection(input.config?.judge)
  if (!Number.isSafeInteger(candidateCount) || candidateCount < 2 || candidateCount > 4) {
    throw new Error('ORBIT_MOA_CANDIDATE_COUNT_INVALID: 候选数量必须为 2-4。')
  }
  if (candidates.length < candidateCount || judge === undefined) {
    throw new Error('ORBIT_MOA_MODEL_CONFIGURATION_REQUIRED: 请为所有 MoA 候选和 Judge 选择模型。')
  }
  return {
    enabled: true,
    candidate_count: candidateCount,
    peer_critique: peerCritique,
    max_moa_steps: maxMoaSteps,
    candidates: candidates.slice(0, candidateCount),
    judge,
    ...(input.prices && Object.keys(input.prices).length > 0 ? { prices: structuredClone(input.prices) } : {}),
  }
}

export interface EffectiveRoutesInput {
  /** Explicit profile/headless fallback only; the package default is empty. */
  configRoutes?: OrbitConfiguredRoutes | undefined
  settings?: OrbitRouteSettings | undefined
  sessionSelection?: ModelSelectionLike | undefined
  hasSession?: boolean
}

const ROLE_LABELS: Partial<Record<OrbitRole, string>> = {
  commander: 'Commander',
  executor: 'Executor',
  watchdog: 'Watchdog',
}

/** Resolve all three routes or fail before a durable run is created. */
export function resolveEffectiveRoutes(input: EffectiveRoutesInput): OrbitRoutes {
  const routes: Partial<OrbitRoutes> = {
    commander: routeFromSelection(input.settings?.commander) ?? routeFromSelection(input.configRoutes?.commander),
    executor: input.hasSession === true || input.sessionSelection !== undefined
      ? routeFromSelection(input.sessionSelection)
      : routeFromSelection(input.configRoutes?.executor),
    watchdog: routeFromSelection(input.settings?.watchdog) ?? routeFromSelection(input.configRoutes?.watchdog),
  }
  const missing = (['commander', 'executor', 'watchdog'] as const).filter((role) => routes[role] === undefined)
  if (missing.length > 0) {
    throw new Error(
      `ORBIT_ROLE_MODEL_CONFIGURATION_REQUIRED: Orbit 尚未完成角色模型配置：${missing.map((role) => `${ROLE_LABELS[role]} 未选择`).join('；')}。` +
      '请先在 Orbit 模型菜单中选择；无 Web 设置界面的 profile 可显式配置 routes。',
    )
  }
  return structuredClone(routes as OrbitRoutes)
}

interface HeaderLike { config?: ModelSelectionLike | undefined }
interface SessionLike { requestHeader?: () => HeaderLike | undefined }
interface AgentLike { session?: SessionLike | undefined }

export function sessionSelectionOf(agent: AgentLike | undefined): ModelSelectionLike | undefined {
  return agent?.session?.requestHeader?.()?.config
}
