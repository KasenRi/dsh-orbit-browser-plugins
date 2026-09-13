/**
 * Pure helpers over the shared Session ModelDirectory and the Orbit settings
 * mirror. The directory stays the single authority for the Executor; Orbit
 * settings stay the single authority for Commander/Watchdog.
 */

import type { ModelSelection } from '@deepseek-ai/dsh-api-remotes/client'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ModelDirectoryState } from '@deepseek-ai/dsh-client-ui-model-selection/client'

/** One stored role route (`OrbitRoute` without transport-only fields). */
export interface OrbitRouteValue {
  provider: string
  model: string
  reasoningEffort?: string
}

/** The roles the Orbit control edits. */
export type OrbitRoleName = 'commander' | 'executor' | 'watchdog'

type ModelEntry = ModelDirectoryState['groups'][number]['models'][number]

/** Mirror of the `orbit` settings namespace, React-free. */
export interface OrbitSettingsState {
  status: 'loading' | 'ready' | 'error'
  commander?: OrbitRouteValue
  watchdog?: OrbitRouteValue
  revision?: number
  error?: string
}

/** Business face the Orbit slot component is injected with. */
export interface OrbitModelInjected {
  /** Whether this Session supports Agent-bound model inspection (not an addressed subagent). */
  available: boolean
  /** The Session's shared model directory store (the native seat's own state). */
  directory: SnapshotStore<ModelDirectoryState>
  /** Orbit's server-authoritative settings mirror. */
  settings: SnapshotStore<OrbitSettingsState>
  /** Load the shared advisory catalog. */
  loadModels: () => void
  /** Submit one selection through the shared directory (native two-way sync). */
  selectModel: (selection: ModelSelection) => Promise<boolean>
  /** Persist one Commander/Watchdog route; never touches the Session model. */
  writeRole: (role: 'commander' | 'watchdog', route: OrbitRouteValue) => Promise<boolean>
  /** Re-read the `orbit` settings namespace after a failure. */
  reloadSettings: () => void
}

/** Find one catalog model for a stored route. */
export function modelOf(state: ModelDirectoryState, route: OrbitRouteValue | undefined): ModelEntry | undefined {
  if (route === undefined) return undefined
  for (const group of state.groups) {
    if (group.id !== route.provider) continue
    for (const model of group.models) {
      if (model.id === route.model) return model
    }
  }
  return undefined
}

/** Human effort label for a stored effort id; falls back to the raw id. */
export function effortLabelOf(model: ModelEntry | undefined, effort: string | undefined): string | undefined {
  if (effort === undefined || effort === '') return undefined
  return model?.reasoning?.efforts.find((entry) => entry.id === effort)?.name ?? effort
}

/** Display name for a stored route: catalog name, then its model id. */
export function routeLabelOf(state: ModelDirectoryState, route: OrbitRouteValue | undefined): string | undefined {
  if (route === undefined) return undefined
  return modelOf(state, route)?.name ?? route.model
}

/**
 * Route for a freshly picked model: the model's own default effort. A model
 * without effort metadata yields no effort — a previous model's effort is
 * never inherited.
 */
export function routeForModel(provider: string, model: ModelEntry): OrbitRouteValue {
  const defaultEffort = model.reasoning?.defaultEffort
  return {
    provider,
    model: model.id,
    ...(defaultEffort === undefined ? {} : { reasoningEffort: defaultEffort }),
  }
}

/**
 * Selection for the shared Session directory: preserve the current effort
 * when the route did not change, otherwise use the picked model's default.
 */
export function selectionForModel(state: ModelDirectoryState, provider: string, model: ModelEntry): ModelSelection {
  const sameRoute = state.current?.provider === provider && state.current.model === model.id
  const effort = sameRoute
    ? state.current?.reasoningEffort ?? model.reasoning?.defaultEffort
    : model.reasoning?.defaultEffort
  return {
    provider,
    model: model.id,
    ...(effort === undefined ? {} : { reasoningEffort: effort }),
  }
}

export interface OrbitEffortChoice {
  id: string
  label: string
  effort?: string
}

/** Effort rows for one model; empty when the adapter publishes none. */
export function effortChoicesOf(model: ModelEntry | undefined, providerDefaultLabel: string): OrbitEffortChoice[] {
  const reasoning = model?.reasoning
  if (reasoning === undefined) return []
  const choices: OrbitEffortChoice[] = []
  if (reasoning.defaultEffort !== undefined) {
    choices.push({ id: 'provider-default', label: providerDefaultLabel, effort: undefined })
  }
  for (const effort of reasoning.efforts) {
    choices.push({ id: `effort:${effort.id}`, label: effort.name, effort: effort.id })
  }
  return choices
}

/** Normalize one settings wire value into a complete route. */
export function routeFromSettingsValue(value: unknown): OrbitRouteValue | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  const provider = record['provider']
  const model = record['model']
  if (typeof provider !== 'string' || provider === '') return undefined
  if (typeof model !== 'string' || model === '') return undefined
  const reasoningEffort = record['reasoningEffort']
  return {
    provider,
    model,
    ...(typeof reasoningEffort === 'string' && reasoningEffort !== '' ? { reasoningEffort } : {}),
  }
}
