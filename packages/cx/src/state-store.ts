import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { redactValue } from './sanitize.ts'
import { CX_SCHEMA_VERSION, type CxDriverOwnership, type CxState } from './types.ts'

const LOCK_TIMEOUT_MS = 5_000
const LOCK_STALE_MS = 30_000
const LOCK_SPIN_MS = 20

export function driverOwnershipFor(phase: CxState['phase'], status: CxState['status']): CxDriverOwnership {
  if (['SUCCESS', 'STOPPED', 'BUDGET_EXHAUSTED'].includes(phase) || ['success', 'stopped', 'budget_exhausted'].includes(status)) {
    return 'CLOSED'
  }
  return phase === 'NEEDS_USER' || status === 'needs_user' ? 'AWAITING_USER' : 'ACTIVE'
}

function nowIso(): string {
  return new Date().toISOString()
}

/**
 * Project-scoped durable store for `.cx/state.json`.
 * Atomic write + short-transaction directory lock + monotonic revision.
 */
export class CxStateStore {
  readonly cxDir: string
  private lockDepth = 0

  constructor(projectDir: string) {
    this.cxDir = join(projectDir, '.cx')
  }

  get statePath(): string {
    return join(this.cxDir, 'state.json')
  }

  transact<T>(operation: () => T): T {
    if (this.lockDepth > 0) return operation()
    mkdirSync(this.cxDir, { recursive: true, mode: 0o700 })
    const lock = join(this.cxDir, 'controller.lock')
    const deadline = Date.now() + LOCK_TIMEOUT_MS
    for (;;) {
      try {
        mkdirSync(lock, { mode: 0o700 })
        writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, hostname: hostname(), acquired_at: nowIso() }), { mode: 0o600 })
        break
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error
        if (isStale(lock) || Date.now() > deadline) {
          if (Date.now() > deadline && !isStale(lock)) throw new Error('CX_STATE_LOCK_TIMEOUT: another controller transaction is active')
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
    try {
      const parsed = JSON.parse(readFileSync(this.statePath, 'utf8')) as unknown
      if (parsed !== null && typeof parsed === 'object') return parsed as Record<string, unknown>
      return null
    } catch {
      return null
    }
  }

  readState(): CxState | null {
    const raw = this.readRawState()
    if (raw === null) return null
    return raw as unknown as CxState
  }

  writeState(state: CxState): CxState {
    return this.transact(() => {
      const current = this.readRawState()
      const revision = Number(current?.['state_revision'] ?? 0) + 1
      const next = {
        ...state,
        schema_version: CX_SCHEMA_VERSION,
        state_revision: revision,
        driver_ownership: driverOwnershipFor(state.phase, state.status),
        updated_at: nowIso(),
      } as CxState
      Object.assign(state, next)
      this.writeJson(this.statePath, next)
      return next
    })
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
