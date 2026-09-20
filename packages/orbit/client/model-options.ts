/**
 * Pure helpers over the shared Session ModelDirectory and the Orbit settings
 * mirror. The directory stays the single authority for the Executor; Orbit
 * settings stay the single authority for Commander/Watchdog.
 */

import type { ModelSelection } from '@deepseek-ai/dsh-api-remotes/client'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ModelDirectoryState } from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type {} from '@deepseek-ai/dsh-session-projection/types'

/** One stored role route (`OrbitRoute` without transport-only fields). */
export interface OrbitRouteValue {
  provider: string
  model: string
  reasoningEffort?: string
}

/** The roles the Orbit control edits. */
export type OrbitRoleName = 'commander' | 'executor' | 'watchdog' | 'moa-candidate-1' | 'moa-candidate-2' | 'moa-candidate-3' | 'moa-candidate-4' | 'moa-judge'

type ModelEntry = ModelDirectoryState['groups'][number]['models'][number]

/** Per-Session Orbit enable state, folded by the host from `/orbit-toggle` records. */
export interface OrbitSessionState {
  readonly enabled: boolean
}

export interface OrbitRuntimeUsage {
  readonly input_tokens: number
  readonly output_tokens: number
  readonly total_tokens: number
  readonly cache_read_tokens?: number
  readonly cache_write_tokens?: number
  readonly cost_usd?: number
}

export interface OrbitRuntimeState {
  readonly runId: string
  readonly phase: string
  readonly status: string
  readonly loop: { readonly used: number; readonly max: number }
  readonly currentStep?: { readonly id: string; readonly attempt: number; readonly executionMode: 'SINGLE' | 'MOA' }
  readonly moa?: {
    readonly phase: string
    readonly candidates: ReadonlyArray<{
      readonly index: number
      readonly provider: string
      readonly model: string
      readonly ok: boolean
      readonly files: number
      readonly usage?: OrbitRuntimeUsage
    }>
    readonly judgeModel?: string
    readonly winningCandidate?: number
    readonly winnerModel?: string
    readonly totalUsage?: OrbitRuntimeUsage
  }
  readonly updatedAt: string
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Per-Session Orbit enable state folded from `/orbit-toggle` records. */
    orbitSession: OrbitSessionState
    /** Bounded Orbit runtime state for the owning Session. */
    orbitRuntime: OrbitRuntimeState | null
  }
  interface SessionProjectionMap {
    /** Per-Session Orbit enable state as this control reads it. */
    orbitSession: OrbitSessionState
    /** Bounded Orbit runtime state as this control reads it. */
    orbitRuntime: OrbitRuntimeState | null
  }
}

/** Mirror of the `orbit` settings namespace, React-free. */
export interface OrbitMoaSettingsValue {
  enabled: boolean
  candidateCount: number
  peerCritique: boolean
  maxMoaSteps: number
  candidates: OrbitRouteValue[]
  judge?: OrbitRouteValue
}

export interface OrbitSettingsState {
  status: 'loading' | 'ready' | 'error'
  commander?: OrbitRouteValue
  watchdog?: OrbitRouteValue
  moa: OrbitMoaSettingsValue
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
  /** Persist one non-Executor route; never touches the Session model. */
  writeRole: (role: Exclude<OrbitRoleName, 'executor'>, route: OrbitRouteValue) => Promise<boolean>
  /** Persist bounded MoA policy values. */
  writeMoaPolicy: (patch: Partial<Pick<OrbitMoaSettingsValue, 'enabled' | 'candidateCount' | 'peerCritique' | 'maxMoaSteps'>>) => Promise<boolean>
  /** Toggle the current Session's Orbit default (host command, durable record). */
  setOrbitEnabled: (enabled: boolean) => Promise<boolean>
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

/** One effort option as the Orbit picker shows it. */
export interface OrbitEffortOption {
  id: string
  name: string
}

/**
 * Effort options for one model: exactly the DSH model metadata's explicit
 * `reasoning.efforts`. A model without reasoning metadata yields none; the
 * picker then offers only Provider default.
 */
export function effortsOf(model: ModelEntry | undefined): OrbitEffortOption[] {
  const explicit = model?.reasoning?.efforts ?? []
  return explicit.map((effort) => ({ id: effort.id, name: effort.name }))
}

/** Human effort label for a stored effort id; falls back to the raw id. */
export function effortLabelOf(model: ModelEntry | undefined, effort: string | undefined): string | undefined {
  if (effort === undefined || effort === '') return undefined
  const explicit = model?.reasoning?.efforts.find((entry) => entry.id === effort)
  if (explicit !== undefined) return explicit.name
  return effort
}

/** Display name for a stored route: catalog name, then its model id. */
export function routeLabelOf(state: ModelDirectoryState, route: OrbitRouteValue | undefined): string | undefined {
  if (route === undefined) return undefined
  return modelOf(state, route)?.name ?? route.model
}

/**
 * Route for a freshly picked model: no reasoning effort is adopted, not even
 * the catalog metadata's `defaultEffort`. Provider default means the absent
 * effort, and a previous model's effort is never inherited.
 */
export function routeForModel(provider: string, model: ModelEntry): OrbitRouteValue {
  return {
    provider,
    model: model.id,
  }
}

/**
 * Selection for the shared Session directory: re-selecting the same model
 * keeps its current effort; any model change drops the effort (Provider
 * default) instead of adopting `defaultEffort` or the previous model's effort.
 */
export function selectionForModel(state: ModelDirectoryState, provider: string, model: ModelEntry): ModelSelection {
  const sameRoute = state.current?.provider === provider && state.current.model === model.id
  const effort = sameRoute ? state.current?.reasoningEffort : undefined
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

/**
 * Effort rows for one model: Provider default (an undefined effort) first,
 * then the model's explicit metadata efforts, if any.
 */
export function effortChoicesOf(model: ModelEntry | undefined, providerDefaultLabel: string): OrbitEffortChoice[] {
  return [
    { id: 'provider-default', label: providerDefaultLabel, effort: undefined },
    ...effortsOf(model).map((effort) => ({ id: `effort:${effort.id}`, label: effort.name, effort: effort.id })),
  ]
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
