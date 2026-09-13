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
