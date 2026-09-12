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
