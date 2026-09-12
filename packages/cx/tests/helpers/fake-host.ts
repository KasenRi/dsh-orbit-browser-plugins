import type { CxHost, RoleHandle, RoleRunRequest, RoleRunResult } from '../../src/host.ts'

export interface RoleScript {
  output?: string
  interrupted?: boolean
  reason?: string
  childId?: string
  pending?: boolean
  changedFiles?: string[]
  testSummary?: string[]
}

export interface StartedRole {
  role: string
  label: string
  request: RoleRunRequest
  childId?: string
}

/** Virtual-clock, scripted CxHost for deterministic supervisor tests. */
export class FakeHost implements CxHost {
  clock = 0
  readonly sleepCalls: number[] = []
  readonly interruptCalls: Array<{ childId?: string; reason: string }> = []
  readonly started: StartedRole[] = []
  readonly tools = new Set<string>(['agent_browser'])
  drivers: string[] = []
  changed: string[] = []
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

  async sleep(ms: number): Promise<void> {
    this.sleepCalls.push(ms)
    this.clock += ms
  }

  async startRole(request: RoleRunRequest): Promise<RoleHandle> {
    const queue = this.queues.get(request.role)
    const script = queue?.shift()
    if (!script) throw new Error(`FakeHost: no script left for role ${request.role} (${request.label})`)
    const childId = script.childId ?? `${request.role}-${this.started.length + 1}`
    this.started.push({ role: request.role, label: request.label, request, childId })
    if (script.pending) {
      return { childId, result: new Promise<RoleRunResult>(() => undefined) }
    }
    return {
      childId,
      result: Promise.resolve({
        childId,
        output: script.output ?? '',
        interrupted: script.interrupted === true,
        ...(script.reason ? { reason: script.reason } : {}),
        ...(script.changedFiles ? { changedFiles: script.changedFiles } : {}),
        ...(script.testSummary ? { testSummary: script.testSummary } : {}),
      }),
    }
  }

  async interruptRole(handle: RoleHandle, reason: string): Promise<void> {
    this.interruptCalls.push({ childId: handle.childId, reason })
  }

  async releaseRole(): Promise<void> {}

  hasTool(name: string): boolean {
    return this.tools.has(name)
  }

  async otherMutationDrivers(): Promise<string[]> {
    return this.drivers
  }

  changedFiles(): string[] {
    return this.changed
  }
}
