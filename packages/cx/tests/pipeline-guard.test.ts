import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createCxPreExecuteHandler, type PreExecuteDecision } from '../src/pipeline-guard.ts'
import type { CxService } from '../src/service.ts'
import type { GuardBlockOutcome } from '../src/supervisor.ts'
import type { GuardCode } from '../src/types.ts'

function stubService(active: boolean, onBlock: (code: GuardCode) => void): CxService {
  return {
    hasActiveRun: () => active,
    githubAllowed: () => false,
    recordGuardBlock: async (code: GuardCode): Promise<GuardBlockOutcome> => {
      onBlock(code)
      return { disposition: 'block_continue', code, count: 1, watchdog_calls: 0, instruction: 'use a safer approach' }
    },
  } as unknown as CxService
}

test('recoverable guard blocks one call and lets a safe call proceed', async () => {
  const blocked: GuardCode[] = []
  const handler = createCxPreExecuteHandler(stubService(true, (code) => blocked.push(code)))
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
  const cxWrite = await handler({ name: 'write', arguments: { path: '.cx/state.json' }, agent: { session: { header: { cwd: '/proj' } } } }, async () => allow)
  assert.equal(cxWrite.kind, 'deny')

  assert.deepEqual(blocked, ['secret_operation', 'durable_state_write'])
})

test('guard is inert when no CX run owns the project', async () => {
  let recorded = 0
  const handler = createCxPreExecuteHandler(stubService(false, () => (recorded += 1)))
  const decision = await handler({ name: 'bash', arguments: { command: 'printenv' } }, async () => ({ kind: 'allow' }))
  assert.deepEqual(decision, { kind: 'allow' })
  assert.equal(recorded, 0)
})
