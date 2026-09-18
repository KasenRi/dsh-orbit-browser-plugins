import { describe, expect, it, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ModelDirectoryState } from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type { ModelSelection } from '@deepseek-ai/dsh-api-remotes/client'
import { apply, inject, ORBIT_SETTINGS_NS } from '../index.ts'
import type { OrbitModelInjected, OrbitRouteValue } from '../model-options.ts'

interface Registration {
  key: string
  name: string
  id?: string
  order?: number
  locale?: string
  inject?: (sessionId: string) => OrbitModelInjected
  component?: unknown
}

interface FakeScope {
  slots: {
    inject: (key: string, callback: () => unknown) => void
    register: (definition: Record<string, unknown>, component: unknown) => () => void
  }
  modelDirectories: { directoryFor: (sessionId: string) => { store: unknown; load: () => Promise<unknown>; select: (selection: ModelSelection) => Promise<void> } }
  sessions: { subagentAddress: (sessionId: string) => { kind: string } | undefined }
}

interface FakeContext {
  effect: (callback: () => unknown) => unknown
  locale: { register: () => () => void }
  remote: {
    settings: {
      describe: () => Promise<unknown>
      update: (ns: string, patch: unknown, revision: number | undefined) => Promise<unknown>
    }
    $on: () => () => void
  }
  inject: (deps: string[], callback: (scope: FakeScope) => unknown) => void
}

function buildContext(options: {
  current?: ModelSelection
  address?: { kind: string }
  describe?: () => Promise<unknown>
  update?: (ns: string, patch: unknown, revision: number | undefined) => Promise<unknown>
} = {}) {
  const directoryState = createSnapshotStore<ModelDirectoryState>({
    current: options.current ?? { provider: 'p', model: 'session-model' },
    routable: true,
    groups: [],
    failures: [],
    status: 'ready',
    error: null,
  })
  const load = vi.fn(async () => directoryState.getSnapshot())
  const select = vi.fn(async (selection: ModelSelection) => {
    directoryState.set({ ...directoryState.getSnapshot(), current: selection })
  })
  const update = vi.fn(
    options.update ?? (async () => ({ ok: true as const, value: view('commander', 'saved-model', 8) })),
  )
  const describe = vi.fn(
    options.describe ?? (async () => ({
      ok: true as const,
      value: {
        writable: true,
        hasDocument: false,
        namespaces: [view('commander', 'base-commander', 7)],
      },
    })),
  )
  const registrations: Registration[] = []
  let scope: FakeScope | undefined

  const context: FakeContext = {
    effect: (callback) => callback(),
    locale: { register: () => () => {} },
    remote: { settings: { describe, update }, $on: () => () => {} },
    inject: (_deps, callback) => {
      scope = {
        slots: {
          inject: (key, callback) => {
            callback()
            // The inner register call captured below is what matters.
            void key
          },
          register: (definition, component) => {
            registrations.push({
              key: String(definition['name']),
              name: String(definition['name']),
              ...(typeof definition['id'] === 'string' ? { id: definition['id'] } : {}),
              ...(typeof definition['order'] === 'number' ? { order: definition['order'] } : {}),
              ...(typeof definition['locale'] === 'string' ? { locale: definition['locale'] } : {}),
              ...(typeof definition['inject'] === 'function'
                ? { inject: definition['inject'] as Registration['inject'] }
                : {}),
              component,
            })
            return () => {}
          },
        },
        modelDirectories: {
          directoryFor: () => ({ store: directoryState, load, select }),
        },
        sessions: { subagentAddress: () => options.address },
      }
      callback(scope)
    },
  }
  return { context, registrations, directoryState, load, select, update, describe }
}

function view(role: 'commander' | 'watchdog', model: string, revision: number) {
  return {
    ns: ORBIT_SETTINGS_NS,
    schema: {},
    value: { [role]: { provider: 'p', model, reasoningEffort: 'high' } },
    applies: 'live' as const,
    secrets: [],
    revision,
  }
}

describe('Orbit client plugin wiring', () => {
  it('registers exactly one entry into conversation.input.right and none into the native seat', () => {
    const { context, registrations } = buildContext()
    apply(context as never)

    expect(inject).toEqual(['slots', 'modelDirectories', 'remote', 'remote.settings', 'locale'])
    expect(registrations).toHaveLength(1)
    const entry = registrations[0]!
    expect(entry.name).toBe('conversation.input.right')
    expect(entry.id).toBe('orbit-model')
    expect(entry.locale).toBe('orbit-model')
    expect(registrations.some((registration) => registration.name === 'conversation.input.model')).toBe(false)
  })

  it('routes the executor through the shared directory and the roles through settings', async () => {
    const { context, registrations, select, update } = buildContext()
    apply(context as never)
    const face = registrations[0]!.inject!('session-1')
    expect(face.available).toBe(true)

    await face.selectModel({ provider: 'p', model: 'v4-flash', reasoningEffort: 'low' })
    expect(select).toHaveBeenCalledWith({ provider: 'p', model: 'v4-flash', reasoningEffort: 'low' })
    await Promise.resolve()
    await Promise.resolve()

    const route: OrbitRouteValue = { provider: 'p', model: 'v4-pro', reasoningEffort: 'high' }
    await expect(face.writeRole('commander', route)).resolves.toBe(true)
    expect(update).toHaveBeenCalledWith(
      ORBIT_SETTINGS_NS,
      { commander: { provider: 'p', model: 'v4-pro', reasoningEffort: 'high' } },
      expect.any(Number),
    )
  })

  it('hides the face for addressed subagent sessions', () => {
    const { context, registrations } = buildContext({ address: { kind: 'subagent' } })
    apply(context as never)
    expect(registrations[0]!.inject!('session-1').available).toBe(false)
  })

  it('reports the settings namespace truth after a refused write', async () => {
    const refused = buildContext({
      update: async () => ({ ok: false as const, error: { code: 'settings/conflict', message: 'stale', details: {} } }),
    })
    apply(refused.context as never)
    const face = refused.registrations[0]!.inject!('session-1')
    await Promise.resolve()
    await Promise.resolve()
    await expect(face.writeRole('watchdog', { provider: 'p', model: 'm' })).resolves.toBe(false)
    // The refused write re-reads the server value rather than faking success.
    expect(refused.describe).toHaveBeenCalled()
  })
})
