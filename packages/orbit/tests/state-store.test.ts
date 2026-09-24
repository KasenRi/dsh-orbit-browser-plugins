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

test('session-scoped state keeps independent active runs in one project', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-orbit-session-store-'))
  const configA: OrbitSupervisorConfig = { ...config, resolveOwnerSessionId: () => 'session-a' }
  const configB: OrbitSupervisorConfig = { ...config, resolveOwnerSessionId: () => 'session-b' }
  const storeA = new OrbitStateStore(dir, undefined, 'session-a')
  const storeB = new OrbitStateStore(dir, undefined, 'session-b')
  const stateA = new OrbitSupervisor(storeA, new FakeHost(), configA).createState({ goal: 'goal-a', approved_loop_count: 3 })
  const stateB = new OrbitSupervisor(storeB, new FakeHost(), configB).createState({ goal: 'goal-b', approved_loop_count: 3 })
  storeA.writeState(stateA)
  storeB.writeState(stateB)
  assert.notEqual(storeA.statePath, storeB.statePath)
  assert.equal(storeA.readState()?.goal, 'goal-a')
  assert.equal(storeB.readState()?.goal, 'goal-b')
  assert.equal(storeA.readState()?.owner_session_id, 'session-a')
  assert.equal(storeB.readState()?.owner_session_id, 'session-b')
  assert.equal(OrbitStateStore.hasAnyActiveRun(dir), true)
  rmSync(dir, { recursive: true, force: true })
})

test('v0.6.5 root state migrates to the owning Session path on the next write', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-orbit-session-migrate-'))
  const configA: OrbitSupervisorConfig = { ...config, resolveOwnerSessionId: () => 'session-a' }
  const legacyStore = new OrbitStateStore(dir)
  const legacy = new OrbitSupervisor(legacyStore, new FakeHost(), configA).createState({ goal: 'legacy-owned', approved_loop_count: 3 })
  legacyStore.writeState(legacy)
  assert.ok(existsSync(legacyStore.statePath))

  const scoped = new OrbitStateStore(dir, undefined, 'session-a')
  assert.equal(scoped.readState()?.goal, 'legacy-owned', 'owning Session must see the old root state')
  scoped.writeState(scoped.readState()!)
  assert.ok(existsSync(scoped.statePath))
  assert.ok(!existsSync(legacyStore.statePath), 'legacy root state is removed after successful scoped migration')
  assert.equal(scoped.readState()?.owner_session_id, 'session-a')
  rmSync(dir, { recursive: true, force: true })
})

test('explicit compatibility adoption moves an ownerless legacy root state into the current Session', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-orbit-ownerless-adopt-'))
  const legacyStore = new OrbitStateStore(dir)
  const legacy = new OrbitSupervisor(legacyStore, new FakeHost(), config).createState({ goal: 'ownerless', approved_loop_count: 3 })
  legacyStore.writeState(legacy)
  assert.equal(legacyStore.readState()?.owner_session_id, undefined)

  const scoped = new OrbitStateStore(dir, undefined, 'session-a')
  const adopted = scoped.adoptOwnerlessLegacyState()
  assert.equal(adopted?.owner_session_id, 'session-a')
  assert.equal(scoped.readState()?.goal, 'ownerless')
  assert.ok(existsSync(scoped.statePath))
  assert.ok(!existsSync(legacyStore.statePath))
  rmSync(dir, { recursive: true, force: true })
})

test('a different Session ignores another Session legacy root state', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-orbit-session-foreign-'))
  const configA: OrbitSupervisorConfig = { ...config, resolveOwnerSessionId: () => 'session-a' }
  const legacyStore = new OrbitStateStore(dir)
  legacyStore.writeState(new OrbitSupervisor(legacyStore, new FakeHost(), configA).createState({ goal: 'owned-by-a', approved_loop_count: 3 }))
  const storeB = new OrbitStateStore(dir, undefined, 'session-b')
  assert.equal(storeB.readState(), null)
  assert.equal(OrbitStateStore.hasAnyActiveRun(dir), true, 'global mutation fence still sees the foreign active run')
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

test('schema 2 durable state remains readable and upgrades to schema 5 on the next write', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-orbit-schema2-state-'))
  const store = new OrbitStateStore(dir)
  const state = new OrbitSupervisor(store, new FakeHost(), config).createState({ goal: 'legacy', approved_loop_count: 3 })
  mkdirSync(join(dir, '.cx'), { recursive: true })
  writeFileSync(store.statePath, JSON.stringify({ ...state, schema_version: 2 }))
  const legacy = store.readState()
  assert.equal((legacy as unknown as { schema_version: number }).schema_version, 2)
  assert.equal(legacy?.goal, 'legacy')
  store.writeState(legacy!)
  assert.equal(store.readState()?.schema_version, 5)
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
