import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createOrbitPreExecuteHandler, type PreExecuteDecision } from '../src/pipeline-guard.ts'
import type { OrbitService } from '../src/service.ts'
import type { GuardBlockOutcome } from '../src/supervisor.ts'
import type { GuardCode } from '../src/types.ts'

function stubService(active: boolean, onBlock: (code: GuardCode) => void): OrbitService {
  return {
    hasActiveRun: () => active,
    ownerSessionIdForAgent: () => 'session-test',
    githubAllowed: () => false,
    browserToolNames: () => ['agent_browser'],
    isMutationAuthorized: () => true,
    recordGuardBlock: async (code: GuardCode): Promise<GuardBlockOutcome> => {
      onBlock(code)
      return { disposition: 'block_continue', code, count: 1, watchdog_calls: 0, instruction: 'use a safer approach' }
    },
  } as unknown as OrbitService
}

test('recoverable guard blocks one call and lets a safe call proceed', async () => {
  const blocked: GuardCode[] = []
  const handler = createOrbitPreExecuteHandler(stubService(true, (code) => blocked.push(code)))
  const allow: PreExecuteDecision = { kind: 'allow' }

  const denied = await handler({ name: 'bash', arguments: { command: 'printenv' } }, async () => allow)
  assert.equal(denied.kind, 'deny')
  if (denied.kind === 'deny') {
    assert.match(denied.reason, /secret_operation/)
    assert.match(denied.reason, /use a safer approach/)
  }

  // The turn continues and a second, safe tool call proceeds.
  const safe = await handler({ name: 'bash', arguments: { command: 'git status --short' } }, async () => allow)
  assert.deepEqual(safe, { kind: 'allow' })

  // .cx writes are blocked for write tools as well.
  const stateWrite = await handler({ name: 'write', arguments: { path: '.cx/state.json' }, agent: { session: { header: { cwd: '/proj' } } } }, async () => allow)
  assert.equal(stateWrite.kind, 'deny')

  assert.deepEqual(blocked, ['secret_operation', 'durable_state_write'])
})

test('guard is inert when no Orbit run owns the project', async () => {
  let recorded = 0
  const handler = createOrbitPreExecuteHandler(stubService(false, () => (recorded += 1)))
  const decision = await handler({ name: 'bash', arguments: { command: 'printenv' } }, async () => ({ kind: 'allow' }))
  assert.deepEqual(decision, { kind: 'allow' })
  assert.equal(recorded, 0)
})

test('Orbit blocks other top-level mutation drivers while it owns the workspace', async () => {
  const handler = createOrbitPreExecuteHandler(stubService(true, () => undefined))
  for (const name of ['create_goal', 'ralph', 'workflow']) {
    const decision = await handler({ name, arguments: {} }, async () => ({ kind: 'allow' }))
    assert.equal(decision.kind, 'deny')
    if (decision.kind === 'deny') assert.match(decision.reason, /ORBIT_MUTATION_DRIVER_CONFLICT/)
  }
  // Read-only delegation stays available.
  assert.deepEqual(await handler({ name: 'subagent', arguments: {} }, async () => ({ kind: 'allow' })), { kind: 'allow' })
  assert.deepEqual(await handler({ name: 'read', arguments: {} }, async () => ({ kind: 'allow' })), { kind: 'allow' })
})

test('cx_controller run is denied while another mutation driver is active', async () => {
  let driverChecks = 0
  const handler = createOrbitPreExecuteHandler(stubService(false, () => undefined), {
    competingDriver: () => {
      driverChecks += 1
      return 'goal'
    },
  })
  const denied = await handler({ name: 'cx_controller', arguments: { action: 'run' } }, async () => ({ kind: 'allow' }))
  assert.equal(denied.kind, 'deny')
  if (denied.kind === 'deny') assert.match(denied.reason, /goal/)

  const status = await handler({ name: 'cx_controller', arguments: { action: 'status' } }, async () => ({ kind: 'allow' }))
  assert.deepEqual(status, { kind: 'allow' })
  assert.equal(driverChecks, 1)
})

test('workspace mutation fence denies unrelated Agents but permits the owned Executor and read tools', async () => {
  let blocked = 0
  const service = stubService(true, () => { blocked += 1 })
  Object.assign(service, {
    browserToolNames: () => ['custom_browser'],
    isMutationAuthorized: (agent: { id?: string }) => agent?.id === 'orbit-executor',
  })
  const handler = createOrbitPreExecuteHandler(service)
  for (const name of ['bash', 'write', 'edit', 'str_replace_editor', 'custom_browser', 'create_goal', 'ralph', 'workflow']) {
    const result = await handler({ name, agent: { id: 'other-subagent' }, arguments: {} }, async () => ({ kind: 'allow' }))
    assert.equal(result.kind, 'deny')
    if (result.kind === 'deny') assert.match(result.reason, /ORBIT_MUTATION_DRIVER_CONFLICT/)
  }
  assert.equal(blocked, 0, 'ownership denial must not alter guard recovery counters')
  for (const name of ['write', 'bash', 'custom_browser']) {
    assert.equal((await handler({ name, agent: { id: 'orbit-executor' }, arguments: {} }, async () => ({ kind: 'allow' }))).kind, 'allow')
  }
  for (const name of ['read', 'grep']) assert.equal((await handler({ name, agent: { id: 'parent' } }, async () => ({ kind: 'allow' }))).kind, 'allow')
  const durableWrite = await handler({ name: 'custom_browser', agent: { id: 'orbit-executor' }, arguments: { outputPath: '.cx/state.json' } }, async () => ({ kind: 'allow' }))
  assert.equal(durableWrite.kind, 'deny')
})
