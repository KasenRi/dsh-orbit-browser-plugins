/**
 * Effective route resolution for a new Orbit run.
 *
 * Orbit stores only Commander and Watchdog itself (`orbit` settings namespace,
 * falling back to the composition `config.routes`). The Executor follows the
 * initiating Session's current model selection, read through the public
 * request-header seam, and falls back to `config.routes.executor` on surfaces
 * without one (headless, CLI, minimal profiles, tests). Resolution happens
 * exactly once per new run and is frozen into `state.routes`.
 */

import type { OrbitRoute, OrbitRoutes } from './types.ts'

/** The `orbit` settings section: the two roles Orbit stores itself. */
export interface OrbitRouteSettings {
  commander?: OrbitRoute
  watchdog?: OrbitRoute
}

/** Structural view of a model selection (Host `ModelSelection` / header config). */
export interface ModelSelectionLike {
  provider?: unknown
  model?: unknown
  reasoningEffort?: unknown
}

/**
 * Normalize one provider/model/effort candidate into a complete route.
 * @param selection - candidate fields from settings, the session header, or tests.
 * @returns the complete route, or undefined when provider/model are unusable.
 */
export function routeFromSelection(selection: ModelSelectionLike | undefined): OrbitRoute | undefined {
  if (selection === undefined) return undefined
  const { provider, model, reasoningEffort } = selection
  if (typeof provider !== 'string' || provider === '') return undefined
  if (typeof model !== 'string' || model === '') return undefined
  return {
    provider,
    model,
    ...(typeof reasoningEffort === 'string' && reasoningEffort !== '' ? { reasoningEffort } : {}),
  }
}

export interface EffectiveRoutesInput {
  /** Role routes declared by the composition config; the fallback layer. */
  configRoutes: OrbitRoutes
  /** Resolved `orbit` settings section when the settings provider is attached. */
  settings?: OrbitRouteSettings | undefined
  /** Initiating agent's current session selection, when readable. */
  sessionSelection?: ModelSelectionLike | undefined
}

/**
 * Resolve the three role routes for a NEW run:
 * Commander = settings (base = config) → config; Executor = session selection
 * → config; Watchdog = settings (base = config) → config.
 * @param input - config fallback, settings section, and session selection.
 * @returns the complete frozen route set.
 */
export function resolveEffectiveRoutes(input: EffectiveRoutesInput): OrbitRoutes {
  return {
    commander: routeFromSelection(input.settings?.commander) ?? input.configRoutes.commander,
    executor: routeFromSelection(input.sessionSelection) ?? input.configRoutes.executor,
    watchdog: routeFromSelection(input.settings?.watchdog) ?? input.configRoutes.watchdog,
  }
}

interface HeaderLike {
  config?: ModelSelectionLike | undefined
}

interface SessionLike {
  requestHeader?: () => HeaderLike | undefined
}

interface AgentLike {
  session?: SessionLike | undefined
}

/**
 * Read the initiating Session's current model selection from the public
 * request-header seam (`Agent.session.requestHeader().config`).
 * @param agent - initiating agent, or undefined outside a boundary.
 * @returns the selection route, or undefined when no header exists.
 */
export function sessionSelectionOf(agent: AgentLike | undefined): OrbitRoute | undefined {
  return routeFromSelection(agent?.session?.requestHeader?.()?.config)
}
