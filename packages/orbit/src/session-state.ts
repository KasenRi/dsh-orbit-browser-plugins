/**
 * Per-Session Orbit enable state, native to DeepSeek Harness.
 *
 * The write is the ordinary `/orbit-toggle on|off` command: the commands
 * runtime appends its own `command/run` record to the Session log (a known
 * event type, durable with the Session). The state is a session projection
 * unit folding those records, so it is per-Session by construction, survives
 * reloads with the log, and reaches the browser through the normal projection
 * wire — no separate store, no Orbit settings entry, no `.cx/state.json`.
 *
 * This is UI/runtime preference state for one chat, never the durable
 * execution state of an Orbit run.
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-commands'
import type { Session } from '@deepseek-ai/dsh-session'
import type { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-session-projection/types'
import type {} from '@deepseek-ai/dsh-session/types'
import type { OrbitMoaUsage, OrbitState } from './types.ts'

/** The command whose `command/run` records carry the toggle. */
export const ORBIT_TOGGLE_COMMAND = 'orbit-toggle'
/** The projection key carrying the per-Session enable state. */
export const ORBIT_SESSION_KEY = 'orbitSession'
/** Projection key carrying a bounded live/durable Orbit execution snapshot. */
export const ORBIT_RUNTIME_KEY = 'orbitRuntime'

/** Per-Session Orbit enable state (the projection's whole value). */
export interface OrbitSessionState {
  readonly enabled: boolean
}

export interface OrbitRuntimeCandidateState {
  readonly index: number
  readonly provider: string
  readonly model: string
  readonly ok: boolean
  readonly files: number
  readonly usage?: OrbitMoaUsage
}

export interface OrbitRuntimeState {
  readonly runId: string
  readonly phase: OrbitState['phase']
  readonly status: OrbitState['status']
  readonly loop: { readonly used: number; readonly max: number }
  readonly currentStep?: {
    readonly id: string
    readonly attempt: number
    readonly executionMode: 'SINGLE' | 'MOA'
  }
  readonly moa?: {
    readonly phase: NonNullable<OrbitState['moa_step']>['phase']
    readonly candidates: readonly OrbitRuntimeCandidateState[]
    readonly judgeModel?: string
    readonly winningCandidate?: number
    readonly winnerModel?: string
    readonly totalUsage?: OrbitMoaUsage
  }
  readonly updatedAt: string
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Per-Session Orbit enable state folded from `/orbit-toggle` records. */
    orbitSession: OrbitSessionState
    /** Bounded Orbit runtime state; null before the Session owns a Run. */
    orbitRuntime: OrbitRuntimeState | null
  }
  interface SessionProjectionMap {
    /** Per-Session Orbit enable state as the browser reads it. */
    orbitSession: OrbitSessionState
    /** Bounded Orbit runtime state as the browser reads it. */
    orbitRuntime: OrbitRuntimeState | null
  }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Orbit-owned bounded runtime snapshot for UI projection and reconnect. */
    'orbit/runtime': OrbitRuntimeState
  }
}

/**
 * Parse one `/orbit-toggle` argument; `undefined` when it names neither state,
 * so a malformed toggle never flips the switch as a side effect.
 */
export function parseOrbitToggle(rawInput: string): boolean | undefined {
  const argument = rawInput.trim().toLowerCase()
  if (argument === 'on') return true
  if (argument === 'off') return false
  return undefined
}

/**
 * Fold one Session event into the enable state. A new Session starts OFF;
 * every unrelated event keeps the same state reference so the projection
 * drive does no downstream work.
 */
export function foldOrbitSession(state: OrbitSessionState, event: { type: string; data: unknown }): OrbitSessionState {
  if (event.type !== 'command/run') return state
  const data = event.data as { name?: unknown; args?: unknown } | null | undefined
  if (data?.name !== ORBIT_TOGGLE_COMMAND) return state
  const enabled = parseOrbitToggle(typeof data.args === 'string' ? data.args : '')
  if (enabled === undefined || enabled === state.enabled) return state
  return { enabled }
}

/**
 * Minimal `ZodType`-shaped validator for the projection schemas. The registry
 * only ever calls `parse`, and Orbit must not add a `zod` runtime dependency
 * that a strict package manager would not hoist for the plugin.
 */
function orbitSessionSchema(): { parse(value: unknown): OrbitSessionState } {
  return {
    parse(value: unknown): OrbitSessionState {
      const enabled = (value as { enabled?: unknown } | null | undefined)?.enabled
      if (typeof enabled !== 'boolean') throw new Error('orbitSession projection value must be { enabled: boolean }')
      return { enabled }
    },
  }
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function usageFrom(value: unknown): OrbitMoaUsage | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const input = finiteNumber(record['input_tokens'])
  const output = finiteNumber(record['output_tokens'])
  const total = finiteNumber(record['total_tokens'])
  if (input === undefined || output === undefined || total === undefined) return undefined
  const cacheRead = finiteNumber(record['cache_read_tokens'])
  const cacheWrite = finiteNumber(record['cache_write_tokens'])
  const cost = finiteNumber(record['cost_usd'])
  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: total,
    ...(cacheRead === undefined ? {} : { cache_read_tokens: cacheRead }),
    ...(cacheWrite === undefined ? {} : { cache_write_tokens: cacheWrite }),
    ...(cost === undefined ? {} : { cost_usd: cost }),
  }
}

function orbitRuntimeSchema(): { parse(value: unknown): OrbitRuntimeState | null } {
  return {
    parse(value: unknown): OrbitRuntimeState | null {
      if (value === null) return null
      if (typeof value !== 'object' || Array.isArray(value)) throw new Error('orbitRuntime projection value must be an object or null')
      const record = value as Record<string, unknown>
      const runId = typeof record['runId'] === 'string' ? record['runId'] : undefined
      const phase = typeof record['phase'] === 'string' ? record['phase'] : undefined
      const status = typeof record['status'] === 'string' ? record['status'] : undefined
      const updatedAt = typeof record['updatedAt'] === 'string' ? record['updatedAt'] : undefined
      const loopRaw = record['loop'] as Record<string, unknown> | undefined
      const used = finiteNumber(loopRaw?.['used'])
      const max = finiteNumber(loopRaw?.['max'])
      if (!runId || !phase || !status || !updatedAt || used === undefined || max === undefined) {
        throw new Error('orbitRuntime projection value is incomplete')
      }
      const allowedPhases = new Set(['PLAN', 'EXECUTE', 'EVALUATE', 'SUCCESS', 'NEEDS_USER', 'BUDGET_EXHAUSTED', 'STOPPED'])
      const allowedStatuses = new Set(['running', 'success', 'stopped', 'needs_user', 'budget_exhausted'])
      if (!allowedPhases.has(phase) || !allowedStatuses.has(status)) throw new Error('orbitRuntime projection value has invalid phase/status')

      const currentRaw = record['currentStep'] as Record<string, unknown> | undefined
      const currentId = typeof currentRaw?.['id'] === 'string' ? currentRaw['id'] : undefined
      const currentAttempt = finiteNumber(currentRaw?.['attempt'])
      const currentMode = currentRaw?.['executionMode'] === 'MOA' ? 'MOA' : currentRaw?.['executionMode'] === 'SINGLE' ? 'SINGLE' : undefined

      const moaRaw = record['moa'] as Record<string, unknown> | undefined
      let moa: OrbitRuntimeState['moa'] | undefined
      if (moaRaw) {
        const moaPhase = typeof moaRaw['phase'] === 'string' ? moaRaw['phase'] : undefined
        const allowedMoa = new Set(['FANOUT', 'JUDGE', 'SELECTED', 'PROMOTING', 'PROMOTED', 'FAILED'])
        if (!moaPhase || !allowedMoa.has(moaPhase)) throw new Error('orbitRuntime MoA phase is invalid')
        const candidatesRaw = Array.isArray(moaRaw['candidates']) ? moaRaw['candidates'] : []
        const candidates = candidatesRaw.flatMap((entry): OrbitRuntimeCandidateState[] => {
          if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return []
          const item = entry as Record<string, unknown>
          const index = finiteNumber(item['index'])
          const provider = typeof item['provider'] === 'string' ? item['provider'] : undefined
          const model = typeof item['model'] === 'string' ? item['model'] : undefined
          const files = finiteNumber(item['files'])
          if (index === undefined || !provider || !model || typeof item['ok'] !== 'boolean' || files === undefined) return []
          return [{ index, provider, model, ok: item['ok'], files, ...(usageFrom(item['usage']) ? { usage: usageFrom(item['usage']) } : {}) }]
        })
        moa = {
          phase: moaPhase as NonNullable<OrbitRuntimeState['moa']>['phase'],
          candidates,
          ...(typeof moaRaw['judgeModel'] === 'string' ? { judgeModel: moaRaw['judgeModel'] } : {}),
          ...(finiteNumber(moaRaw['winningCandidate']) === undefined ? {} : { winningCandidate: finiteNumber(moaRaw['winningCandidate']) }),
          ...(typeof moaRaw['winnerModel'] === 'string' ? { winnerModel: moaRaw['winnerModel'] } : {}),
          ...(usageFrom(moaRaw['totalUsage']) ? { totalUsage: usageFrom(moaRaw['totalUsage']) } : {}),
        }
      }

      return {
        runId,
        phase: phase as OrbitState['phase'],
        status: status as OrbitState['status'],
        loop: { used, max },
        ...(currentId && currentAttempt !== undefined && currentMode ? { currentStep: { id: currentId, attempt: currentAttempt, executionMode: currentMode } } : {}),
        ...(moa ? { moa } : {}),
        updatedAt,
      }
    },
  }
}

/** Build the bounded runtime view persisted into the owning Session. */
export function orbitRuntimeFromState(state: OrbitState): OrbitRuntimeState {
  const step = state.current_step === undefined ? undefined : state.plan.steps.find((candidate) => candidate.id === state.current_step?.id)
  const moa = state.moa_step
  return {
    runId: state.run_id,
    phase: state.phase,
    status: state.status,
    loop: { used: state.loop.used, max: state.loop.max },
    ...(state.current_step && step ? {
      currentStep: {
        id: state.current_step.id,
        attempt: state.current_step.attempt,
        executionMode: step.execution_mode === 'MOA' ? 'MOA' : 'SINGLE',
      },
    } : {}),
    ...(moa ? {
      moa: {
        phase: moa.phase,
        candidates: moa.candidates.slice(0, 4).map((candidate) => ({
          index: candidate.index,
          provider: candidate.provider,
          model: candidate.model,
          ok: candidate.ok,
          files: candidate.files.length,
          ...(candidate.usage ? { usage: candidate.usage } : {}),
        })),
        ...(state.moa_policy?.judge ? { judgeModel: `${state.moa_policy.judge.provider}/${state.moa_policy.judge.model}` } : {}),
        ...(moa.winning_candidate === undefined ? {} : { winningCandidate: moa.winning_candidate }),
        ...(moa.winner_model ? { winnerModel: moa.winner_model } : {}),
        ...(moa.total_usage ? { totalUsage: moa.total_usage } : {}),
      },
    } : {}),
    updatedAt: state.updated_at,
  }
}

export function foldOrbitRuntime(state: OrbitRuntimeState | null, event: { type: string; data: unknown }): OrbitRuntimeState | null {
  if (event.type !== 'orbit/runtime') return state
  try {
    return orbitRuntimeSchema().parse(event.data)
  } catch {
    return state
  }
}

/** Register the per-Session enable and runtime projections on the session projection registry. */
export function installOrbitSessionProjection(ctx: Context): void {
  ctx.sessionProjections.register({
    key: ORBIT_SESSION_KEY,
    stateSchema: orbitSessionSchema() as never,
    init: () => ({ enabled: false }),
    apply: (state, event) => foldOrbitSession(state, event),
    wire: {
      viewSchema: orbitSessionSchema() as never,
      view: (state) => ({ enabled: state.enabled }),
    },
    stateVersion: 1,
  })
  ctx.sessionProjections.register({
    key: ORBIT_RUNTIME_KEY,
    stateSchema: orbitRuntimeSchema() as never,
    init: () => null,
    apply: (state, event) => foldOrbitRuntime(state, event),
    wire: {
      viewSchema: orbitRuntimeSchema() as never,
      view: (state) => state,
    },
    stateVersion: 1,
  })
}

/** Whether the Session currently defaults ordinary messages into Orbit. */
export function orbitEnabledOf(ctx: Context, session: Session): boolean {
  const reflect = (ctx as unknown as { reflect?: { get(name: string, strict?: boolean): unknown } }).reflect
  const registry = reflect?.get('sessionProjections') as SessionProjectionRegistry | undefined
  return registry?.stateOf(session, ORBIT_SESSION_KEY)?.enabled === true
}
