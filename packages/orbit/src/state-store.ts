import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { dirname, join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { redactValue } from './sanitize.ts'
import { ORBIT_SCHEMA_VERSION, type OrbitDriverOwnership, type OrbitState } from './types.ts'

const LOCK_TIMEOUT_MS = 5_000
const LOCK_STALE_MS = 30_000
const LOCK_SPIN_MS = 20

export function driverOwnershipFor(phase: OrbitState['phase'], status: OrbitState['status']): OrbitDriverOwnership {
  if (['SUCCESS', 'STOPPED', 'BUDGET_EXHAUSTED'].includes(phase) || ['success', 'stopped', 'budget_exhausted'].includes(status)) {
    return 'CLOSED'
  }
  return phase === 'NEEDS_USER' || status === 'needs_user' ? 'AWAITING_USER' : 'ACTIVE'
}

function nowIso(): string {
  return new Date().toISOString()
}

function sessionKey(sessionId: string): string {
  return createHash('sha256').update(sessionId).digest('hex').slice(0, 32)
}

/**
 * Durable Orbit state. New DSH-owned runs are scoped by parent Session under
 * `.cx/sessions/<session-key>/state.json`; ownerless/headless compatibility
 * keeps using the historical `.cx/state.json` path.
 *
 * The transaction lock stays project-scoped so state files from concurrent
 * Sessions are still updated atomically with respect to one another.
 */
export class OrbitStateStore {
  readonly stateDir: string
  readonly sessionId?: string
  private lockDepth = 0
  private readonly onWrite?: (state: OrbitState) => void

  constructor(projectDir: string, onWrite?: (state: OrbitState) => void, sessionId?: string) {
    this.stateDir = join(projectDir, '.cx')
    this.onWrite = onWrite
    this.sessionId = sessionId
  }

  get legacyStatePath(): string {
    return join(this.stateDir, 'state.json')
  }

  get statePath(): string {
    return this.sessionId === undefined
      ? this.legacyStatePath
      : join(this.stateDir, 'sessions', sessionKey(this.sessionId), 'state.json')
  }

  /** All durable state files used to decide whether the workspace has any active Orbit run. */
  static statePaths(projectDir: string): string[] {
    const stateDir = join(projectDir, '.cx')
    const paths: string[] = []
    const legacy = join(stateDir, 'state.json')
    if (existsSync(legacy)) paths.push(legacy)
    const sessionsDir = join(stateDir, 'sessions')
    if (!existsSync(sessionsDir)) return paths
    for (const entry of readdirSync(sessionsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const candidate = join(sessionsDir, entry.name, 'state.json')
      if (existsSync(candidate)) paths.push(candidate)
    }
    return paths
  }

  static readStatePath(filePath: string): OrbitState | null {
    if (!existsSync(filePath)) return null
    try {
      const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as unknown
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
      return parsed as OrbitState
    } catch {
      return null
    }
  }

  static hasAnyActiveRun(projectDir: string): boolean {
    return OrbitStateStore.statePaths(projectDir).some((path) => {
      const state = OrbitStateStore.readStatePath(path)
      // An unreadable durable state must fail closed instead of being treated
      // as if no Orbit run owned the workspace.
      return state === null || state.driver_ownership !== 'CLOSED'
    })
  }

  private legacyOwnedBySession(): boolean {
    if (this.sessionId === undefined || !existsSync(this.legacyStatePath)) return false
    const legacy = OrbitStateStore.readStatePath(this.legacyStatePath)
    return legacy?.owner_session_id === this.sessionId
  }

  private sourcePathForRead(): string | undefined {
    if (existsSync(this.statePath)) return this.statePath
    if (this.legacyOwnedBySession()) return this.legacyStatePath
    return undefined
  }

  /**
   * Explicit compatibility path for pre-owner legacy runs. A user-initiated
   * resume may claim an ownerless `.cx/state.json` into the current Session;
   * ordinary new runs never call this, so stale legacy state cannot globally
   * capture unrelated Sessions.
   */
  adoptOwnerlessLegacyState(): OrbitState | null {
    if (this.sessionId === undefined || existsSync(this.statePath) || !existsSync(this.legacyStatePath)) return null
    return this.transact(() => {
      if (existsSync(this.statePath) || !existsSync(this.legacyStatePath)) return null
      let parsed: unknown
      try {
        parsed = JSON.parse(readFileSync(this.legacyStatePath, 'utf8')) as unknown
      } catch (error) {
        throw new Error(`ORBIT_STATE_INVALID: 无法解析 ${this.legacyStatePath}：${error instanceof Error ? error.message : String(error)}`)
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(`ORBIT_STATE_INVALID: ${this.legacyStatePath} 不是有效的对象状态。`)
      }
      const raw = parsed as Record<string, unknown>
      const schema = raw['schema_version']
      if (typeof schema === 'number' && schema > ORBIT_SCHEMA_VERSION) {
        throw new Error(`ORBIT_STATE_SCHEMA_UNSUPPORTED: ${this.legacyStatePath} 使用未来 schema_version=${schema}。`)
      }
      if (raw['owner_session_id'] !== undefined) return null
      const migrated = {
        ...raw,
        owner_session_id: this.sessionId,
        schema_version: ORBIT_SCHEMA_VERSION,
        state_revision: Number(raw['state_revision'] ?? 0) + 1,
        updated_at: nowIso(),
      } as unknown as OrbitState
      this.writeJson(this.statePath, migrated)
      rmSync(this.legacyStatePath, { force: true })
      try { this.onWrite?.(migrated) } catch { /* UI projection must never veto durable state. */ }
      return migrated
    })
  }

  transact<T>(operation: () => T): T {
    if (this.lockDepth > 0) return operation()
    mkdirSync(this.stateDir, { recursive: true, mode: 0o700 })
    const lock = join(this.stateDir, 'controller.lock')
    const deadline = Date.now() + LOCK_TIMEOUT_MS
    for (;;) {
      try {
        mkdirSync(lock, { mode: 0o700 })
        writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, hostname: hostname(), acquired_at: nowIso() }), { mode: 0o600 })
        break
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error
        if (isStale(lock) || Date.now() > deadline) {
          if (Date.now() > deadline && !isStale(lock)) throw new Error('ORBIT_STATE_LOCK_TIMEOUT: another controller transaction is active')
          rmSync(lock, { recursive: true, force: true })
          continue
        }
        sleepSync(LOCK_SPIN_MS)
      }
    }
    this.lockDepth += 1
    try {
      return operation()
    } finally {
      this.lockDepth -= 1
      rmSync(lock, { recursive: true, force: true })
    }
  }

  readRawState(): Record<string, unknown> | null {
    const sourcePath = this.sourcePathForRead()
    if (sourcePath === undefined) return null
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(sourcePath, 'utf8')) as unknown
    } catch (error) {
      throw new Error(`ORBIT_STATE_INVALID: 无法解析 ${sourcePath}：${error instanceof Error ? error.message : String(error)}`)
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`ORBIT_STATE_INVALID: ${sourcePath} 不是有效的对象状态。`)
    }
    const schema = (parsed as Record<string, unknown>)['schema_version']
    if (typeof schema === 'number' && schema > ORBIT_SCHEMA_VERSION) {
      throw new Error(`ORBIT_STATE_SCHEMA_UNSUPPORTED: ${sourcePath} 使用未来 schema_version=${schema}。`)
    }
    return parsed as Record<string, unknown>
  }

  readState(): OrbitState | null {
    const raw = this.readRawState()
    if (raw === null) return null
    return raw as unknown as OrbitState
  }

  writeState(state: OrbitState): OrbitState {
    const next = this.transact(() => {
      const current = this.readRawState()
      const revision = Number(current?.['state_revision'] ?? 0) + 1
      const updated = {
        ...state,
        schema_version: ORBIT_SCHEMA_VERSION,
        state_revision: revision,
        driver_ownership: driverOwnershipFor(state.phase, state.status),
        updated_at: nowIso(),
      } as OrbitState
      Object.assign(state, updated)
      this.writeJson(this.statePath, updated)
      // v0.6.5 and older stored the owning Session's run at `.cx/state.json`.
      // Once that same Session writes again, the state is safely migrated into
      // its scoped path so another Session is no longer blocked by it.
      if (this.sessionId !== undefined && this.legacyOwnedBySession() && this.legacyStatePath !== this.statePath) {
        rmSync(this.legacyStatePath, { force: true })
      }
      return updated
    })
    try { this.onWrite?.(next) } catch { /* UI projection must never veto durable state. */ }
    return next
  }

  writeJson(filePath: string, value: unknown): void {
    mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 })
    const temp = `${filePath}.${randomUUID()}.tmp`
    writeFileSync(temp, `${JSON.stringify(redactValue(value), null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    renameSync(temp, filePath)
  }
}

function isStale(lock: string): boolean {
  try {
    const owner = JSON.parse(readFileSync(join(lock, 'owner.json'), 'utf8')) as { pid?: number; acquired_at?: string }
    if (typeof owner.pid === 'number') {
      try {
        process.kill(owner.pid, 0)
      } catch {
        return true
      }
    }
    const acquired = Date.parse(owner.acquired_at ?? '')
    if (!Number.isNaN(acquired) && Date.now() - acquired > LOCK_STALE_MS) return true
    statSync(lock)
    return false
  } catch {
    return true
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}
