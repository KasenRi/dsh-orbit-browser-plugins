import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OrbitStateStore, driverOwnershipFor } from '../src/state-store.ts'
import { OrbitSupervisor, type OrbitSupervisorConfig } from '../src/supervisor.ts'
import { FakeHost } from './helpers/fake-host.ts'

const config: OrbitSupervisorConfig = {
  defaultRoutes: {
    commander: { provider: 'provider-a', model: 'm' },
    executor: { provider: 'provider-a', model: 'm' },
    watchdog: { provider: 'provider-a', model: 'm' },
  },
  browserTools: ['agent_browser'],
  commanderReadOnlyTools: ['read'],
  watchdogTools: ['read'],
  executorTools: ['read', 'bash', 'write'],
}

test('atomic write increments revision and leaves no lock or temp files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-orbit-store-'))
  const store = new OrbitStateStore(dir)
  const state = new OrbitSupervisor(store, new FakeHost(), config).createState({ goal: 'g', approved_loop_count: 3 })
  store.writeState(state)
  const first = store.readState()
  const firstRevision = first?.state_revision
  store.writeState(first!)
  const second = store.readState()
  assert.equal(firstRevision, 1)
  assert.equal(second?.state_revision, 2)
  const entries = readdirSync(join(dir, '.cx'))
  assert.ok(!entries.some((entry) => entry.includes('.tmp')))
  assert.ok(!existsSync(join(dir, '.cx', 'controller.lock')))
  rmSync(dir, { recursive: true, force: true })
})

test('driver ownership derives from phase and status', () => {
  assert.equal(driverOwnershipFor('SUCCESS', 'success'), 'CLOSED')
  assert.equal(driverOwnershipFor('STOPPED', 'stopped'), 'CLOSED')
  assert.equal(driverOwnershipFor('BUDGET_EXHAUSTED', 'budget_exhausted'), 'CLOSED')
  assert.equal(driverOwnershipFor('NEEDS_USER', 'needs_user'), 'AWAITING_USER')
  assert.equal(driverOwnershipFor('EXECUTE', 'running'), 'ACTIVE')
})

test('redacts secret-looking values before writing state', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-orbit-store-'))
  const store = new OrbitStateStore(dir)
  const state = new OrbitSupervisor(store, new FakeHost(), config).createState({ goal: 'g', approved_loop_count: 3 })
  state.last_error = 'api_key=supersecret'
  store.writeState(state)
  const raw = store.readState() as unknown as Record<string, unknown>
  assert.doesNotMatch(JSON.stringify(raw), /supersecret/)
  rmSync(dir, { recursive: true, force: true })
})

test('blocks run when another mutation driver owns the workspace', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-orbit-store-'))
  const host = new FakeHost()
  host.drivers = ['autoresearch']
  const result = await new OrbitSupervisor(new OrbitStateStore(dir), host, config).bootstrap({ goal: 'x', approved_loop_count: 3 })
  assert.equal(result.ok, false)
  assert.match(String(result.message), /ORBIT_MUTATION_DRIVER_CONFLICT/)
  rmSync(dir, { recursive: true, force: true })
})

test('active run with a different goal is rejected', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-orbit-store-'))
  const host = new FakeHost()
  host
    .script('commander', [
      { output: JSON.stringify({ summary: 's', steps: [{ id: 'P1', goal: 'a' }] }) },
      { output: JSON.stringify({ decision: 'PASS_CURRENT_STEP' }) },
      { output: JSON.stringify({ decision: 'SUCCESS' }) },
    ])
    .script('executor', [{ output: 'e', childId: 'e1' }])
  const store = new OrbitStateStore(dir)
  const supervisor = new OrbitSupervisor(store, host, config)
  await supervisor.bootstrap({ goal: 'first', approved_loop_count: 3 })
  // Reopen a fresh terminal run then attempt a different active goal.
  const state = store.readState()!
  state.phase = 'EXECUTE'
  state.status = 'running'
  state.goal = 'first'
  store.writeState(state)
  const conflict = await supervisor.bootstrap({ goal: 'second', approved_loop_count: 3 })
  assert.equal(conflict.ok, false)
  assert.match(String(conflict.message), /ORBIT_ACTIVE_RUN_EXISTS/)
  rmSync(dir, { recursive: true, force: true })
})

test('invalid and future state are never treated as an empty run', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-orbit-invalid-state-'))
  const store = new OrbitStateStore(dir)
  mkdirSync(join(dir, '.cx'), { recursive: true })
  writeFileSync(store.statePath, '{broken')
  assert.throws(() => store.readState(), /ORBIT_STATE_INVALID/)
  writeFileSync(store.statePath, JSON.stringify({ schema_version: 999 }))
  assert.throws(() => store.readState(), /ORBIT_STATE_SCHEMA_UNSUPPORTED/)
  rmSync(dir, { recursive: true, force: true })
})
