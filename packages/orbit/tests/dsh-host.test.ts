import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DshOrbitHost } from '../src/dsh-host.ts'

test('hasTool resolves tools on the initiating agent scope', () => {
  const agent = { id: 'agent-1' }
  const scoped = new Map<string, unknown>([['read', {}], ['glob', {}]])
  const globalOnly = new Map<string, unknown>([['orbit_controller', {}]])
  const ctx = {
    agents: {
      currentInitiator: () => agent,
      requireInitiator: () => agent,
    },
    tools: {
      get: (name: string, scope?: unknown) => (scope === agent ? scoped.get(name) : globalOnly.get(name)),
    },
  }
  const host = new DshOrbitHost(ctx as never)
  assert.equal(host.hasTool('read'), true)
  assert.equal(host.hasTool('glob'), true)
  assert.equal(host.hasTool('orbit_controller'), false)
  assert.equal(host.hasTool('missing'), false)
})

test('hasTool falls back to the global view without an initiator', () => {
  const ctx = {
    agents: {
      currentInitiator: () => undefined,
      requireInitiator: () => {
        throw new Error('no initiator')
      },
    },
    tools: {
      get: (name: string, scope?: unknown) => (scope === undefined && name === 'orbit_controller' ? {} : undefined),
    },
  }
  const host = new DshOrbitHost(ctx as never)
  assert.equal(host.hasTool('orbit_controller'), true)
  assert.equal(host.hasTool('read'), false)
})

test('workspace mutation lease serializes writable turns across Sessions', async () => {
  const host = new DshOrbitHost({} as never)
  const events: string[] = []
  let releaseFirst!: () => void
  let markFirstStarted!: () => void
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
  const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve })

  const first = host.withWorkspaceMutationLease('/tmp/orbit-shared', undefined, async () => {
    events.push('first-start')
    markFirstStarted()
    await firstGate
    events.push('first-end')
  })
  await firstStarted
  const second = host.withWorkspaceMutationLease('/tmp/orbit-shared', undefined, async () => {
    events.push('second-start')
    events.push('second-end')
  })

  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.deepEqual(events, ['first-start'], 'the second writable turn must wait for the first lease')
  releaseFirst()
  await Promise.all([first, second])
  assert.deepEqual(events, ['first-start', 'first-end', 'second-start', 'second-end'])
})

test('an aborted queued workspace mutation lease does not block later Sessions', async () => {
  const host = new DshOrbitHost({} as never)
  let releaseFirst!: () => void
  let markFirstStarted!: () => void
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
  const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve })
  const first = host.withWorkspaceMutationLease('/tmp/orbit-shared-abort', undefined, async () => {
    markFirstStarted()
    await firstGate
  })
  await firstStarted

  const controller = new AbortController()
  const queued = host.withWorkspaceMutationLease('/tmp/orbit-shared-abort', controller.signal, async () => undefined)
  controller.abort()
  await assert.rejects(queued, /ORBIT_ABORTED/)

  releaseFirst()
  await first
  let thirdRan = false
  await host.withWorkspaceMutationLease('/tmp/orbit-shared-abort', undefined, async () => { thirdRan = true })
  assert.equal(thirdRan, true)
})
