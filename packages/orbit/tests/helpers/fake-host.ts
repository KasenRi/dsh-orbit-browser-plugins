import type { EvidenceToolFact } from '../../src/evidence.ts'
import type { OrbitHost, RoleHandle, RoleRunRequest, RoleRunResult, RoleToolFilter } from '../../src/host.ts'
import type { TurnSettlement } from '../../src/settlement.ts'
import type { OrbitTelemetry } from '../../src/types.ts'
import type { OrbitRole, OrbitRoute } from '../../src/types.ts'

export interface RoleScript {
  output?: string
  visibleOutput?: string
  structured?: unknown
  interrupted?: boolean
  reason?: string
  childId?: string
  pending?: boolean
  changedFiles?: string[]
  testSummary?: string[]
  toolEvidence?: EvidenceToolFact[]
  settlement?: TurnSettlement
}

export interface StartedRole {
  role: string
  label: string
  request: RoleRunRequest
  childId?: string
  toolFilter?: RoleToolFilter
}

/** Virtual-clock, scripted OrbitHost for deterministic supervisor tests. */
export class FakeHost implements OrbitHost {
  clock = 0
  readonly sleepCalls: number[] = []
  readonly interruptCalls: Array<{ childId?: string; reason: string }> = []
  readonly cancelled: Array<{ childId?: string; reason: string }> = []
  readonly disposed: Array<string | undefined> = []
  readonly snapshots: Array<{ childId?: string; telemetry: OrbitTelemetry }> = []
  readonly started: StartedRole[] = []
  readonly tools = new Set<string>(['read', 'glob', 'grep', 'bash', 'write', 'edit', 'agent_browser'])
  drivers: string[] = []
  changed: string[] = []
  routeIssues: string[] = []
  private readonly queues = new Map<string, RoleScript[]>()

  script(role: string, scripts: RoleScript[]): this {
    this.queues.set(role, [...(this.queues.get(role) ?? []), ...scripts])
    return this
  }

  scriptsFor(role: string): StartedRole[] {
    return this.started.filter((entry) => entry.role === role)
  }

  now(): number {
    return this.clock
  }

  async sleep(ms: number, signal?: AbortSignal): Promise<void> {
    // Yield first so an already-settled work promise wins the race; only then
    // record/advance virtual time. Aborted timers never count.
    await new Promise<void>((resolve) => setImmediate(resolve))
    if (signal?.aborted) throw new Error('ORBIT_ABORTED')
    this.sleepCalls.push(ms)
    this.clock += ms
  }

  async startRole(request: RoleRunRequest): Promise<RoleHandle> {
    const queue = this.queues.get(request.role)
    const script = queue?.shift()
    if (!script) throw new Error(`FakeHost: no script left for role ${request.role} (${request.label})`)
    const childId = script.childId ?? `${request.role}-${this.started.length + 1}`
    this.started.push({
      role: request.role,
      label: request.label,
      request,
      childId,
      ...(request.toolFilter ? { toolFilter: request.toolFilter } : {}),
    })
    const handle: RoleHandle = {
      childId,
      result: script.pending
        ? new Promise<RoleRunResult>(() => undefined)
        : Promise.resolve({
            childId,
            output: script.output ?? '',
            ...(script.visibleOutput !== undefined ? { visibleOutput: script.visibleOutput } : {}),
            interrupted: script.interrupted === true,
            ...(script.structured !== undefined ? { structured: script.structured } : {}),
            ...(script.reason ? { reason: script.reason } : {}),
            ...(script.changedFiles ? { changedFiles: script.changedFiles } : {}),
            ...(script.testSummary ? { testSummary: script.testSummary } : {}),
            ...(script.toolEvidence ? { toolEvidence: script.toolEvidence } : {}),
            ...(script.settlement ? { settlement: script.settlement } : {}),
          }),
      cancel: async (reason: string) => {
        this.cancelled.push({ childId, reason })
        this.interruptCalls.push({ childId, reason })
      },
      dispose: async () => {
        this.disposed.push(childId)
      },
      runtimeSnapshot: async () => {
        const telemetry: OrbitTelemetry = {
          status: 'running',
          current_tool: `tool-of-${childId}`,
          turn_count: 1,
          tool_count: 1,
        }
        this.snapshots.push({ childId, telemetry })
        return telemetry
      },
    }
    return handle
  }

  async interruptRole(handle: RoleHandle, reason: string): Promise<void> {
    this.interruptCalls.push({ childId: handle.childId, reason })
  }

  async releaseRole(): Promise<void> {}

  hasTool(name: string): boolean {
    return this.tools.has(name)
  }

  async validateRoutes(_routes: Readonly<Record<OrbitRole, OrbitRoute>>): Promise<string[]> {
    return [...this.routeIssues]
  }

  isMutationAuthorized(): boolean {
    return true
  }

  async otherMutationDrivers(): Promise<string[]> {
    return this.drivers
  }

  changedFiles(): string[] {
    return this.changed
  }
}
