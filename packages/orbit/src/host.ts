import type { ObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import type { EvidenceToolFact } from './evidence.ts'
import type { TurnSettlement } from './settlement.ts'
import type { OrbitRole, OrbitRoute, OrbitTelemetry } from './types.ts'

export interface RoleToolFilter {
  allow?: readonly string[]
  deny?: readonly string[]
}

export interface RoleRunRequest {
  role: OrbitRole
  label: string
  prompt: string
  route: OrbitRoute
  workspace?: string
  runId?: string
  stepId?: string
  toolFilter?: RoleToolFilter
  capabilities?: readonly string[]
  signal?: AbortSignal
  resumeOf?: string
  /**
   * DSH-native structured output request for one-shot decision roles
   * (Commander/Watchdog). The provider validates the child's capture against
   * this schema; the value arrives as {@link RoleRunResult.structured}.
   */
  outputSchema?: ObjectJsonSchema
}

export interface RoleRunResult {
  childId?: string
  output: string
  interrupted: boolean
  reason?: string
  capabilityUnavailable?: string
  /** Validated structured capture when `outputSchema` was requested and satisfied. */
  structured?: unknown
  telemetry?: OrbitTelemetry
  changedFiles?: string[]
  testSummary?: string[]
  /** Current-turn tool facts extracted from the child's real session events. */
  toolEvidence?: EvidenceToolFact[]
  /** Durable settlement of the child's final turn when the host can read one. */
  settlement?: TurnSettlement
  usage?: { turns?: number; tools?: number }
}

export interface RoleHandle {
  childId?: string
  result: Promise<RoleRunResult>
  /**
   * Real lifecycle control for the role's child. For one-shot roles this aborts
   * the launch signal and disposes the run; for continuable roles it interrupts
   * the child while keeping it alive for a later resume.
   */
  cancel?: (reason: string) => Promise<void>
  /** Release the handle's resources. One-shot: dispose; continuable: drain. */
  dispose?: () => Promise<void>
  /** Bounded runtime telemetry for this exact handle (not a previous role). */
  runtimeSnapshot?: () => Promise<OrbitTelemetry>
}

/** DSH-facing seam. The supervisor only depends on this, never on subagent internals. */
export interface OrbitHost {
  now(): number
  sleep(ms: number, signal?: AbortSignal): Promise<void>
  startRole(request: RoleRunRequest): Promise<RoleHandle>
  interruptRole(handle: RoleHandle, reason: string): Promise<void>
  releaseRole(handle: RoleHandle): Promise<void>
  hasTool(name: string): boolean
  /** Validate frozen routes against the current DSH LLM registry. */
  validateRoutes(routes: Readonly<Record<OrbitRole, OrbitRoute>>, signal?: AbortSignal): Promise<string[]>
  /** Whether this exact Agent is the currently authorized Orbit Executor. */
  isMutationAuthorized(agent: unknown, cwd: string, tool: string): boolean
  otherMutationDrivers(cwd: string): Promise<string[]>
  changedFiles(cwd: string): string[]
}
