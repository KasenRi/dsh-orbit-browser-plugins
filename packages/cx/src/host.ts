import type { CxRole, CxRoute, CxTelemetry } from './types.ts'

export interface RoleToolFilter {
  allow?: readonly string[]
  deny?: readonly string[]
}

export interface RoleRunRequest {
  role: CxRole
  label: string
  prompt: string
  route: CxRoute
  toolFilter?: RoleToolFilter
  capabilities?: readonly string[]
  signal?: AbortSignal
  resumeOf?: string
}

export interface RoleRunResult {
  childId?: string
  output: string
  interrupted: boolean
  reason?: string
  capabilityUnavailable?: string
  telemetry?: CxTelemetry
  changedFiles?: string[]
  testSummary?: string[]
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
  runtimeSnapshot?: () => Promise<CxTelemetry>
}

/** DSH-facing seam. The supervisor only depends on this, never on subagent internals. */
export interface CxHost {
  now(): number
  sleep(ms: number, signal?: AbortSignal): Promise<void>
  startRole(request: RoleRunRequest): Promise<RoleHandle>
  interruptRole(handle: RoleHandle, reason: string): Promise<void>
  releaseRole(handle: RoleHandle): Promise<void>
  hasTool(name: string): boolean
  otherMutationDrivers(cwd: string): Promise<string[]>
  changedFiles(cwd: string): string[]
}
