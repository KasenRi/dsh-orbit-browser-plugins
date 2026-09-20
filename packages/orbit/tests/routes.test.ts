import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OrbitStateStore } from '../src/state-store.ts'
import { OrbitSupervisor, type OrbitSupervisorConfig } from '../src/supervisor.ts'
import { agentDefaultSelectionOf, resolveEffectiveRoutes, resolveMoaPolicy, routeFromSelection, sessionModelSelectionOf, sessionModelStateOf, sessionSelectionOf } from '../src/routes.ts'
import type { OrbitRoutes } from '../src/types.ts'
import { FakeHost } from './helpers/fake-host.ts'
import { Config } from '../src/index.ts'

const config: Omit<OrbitSupervisorConfig, 'defaultRoutes' | 'resolveRoutes'> = {
  browserTools: ['agent_browser'],
  commanderReadOnlyTools: ['read', 'glob', 'grep'],
  watchdogTools: ['read'],
  executorTools: ['read', 'glob', 'grep', 'bash', 'write', 'edit'],
}

function project(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-orbit-routes-test-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

function routes(tag: string): OrbitRoutes {
  return {
    commander: { provider: 'p', model: `${tag}-commander`, reasoningEffort: 'high' },
    executor: { provider: 'p', model: `${tag}-executor`, reasoningEffort: 'low' },
    watchdog: { provider: 'p', model: `${tag}-watchdog`, reasoningEffort: 'low' },
  }
}

const plan = (steps: Array<{ id: string; goal: string; capabilities?: string[] }>) => ({ summary: 'plan', steps })
const commander = (decision: Record<string, unknown>) => decision

test('resolves effective routes from settings, session selection, and config fallback', () => {
  const configRoutes = routes('config')

  assert.deepEqual(resolveEffectiveRoutes({ configRoutes }), configRoutes)

  assert.deepEqual(
    resolveEffectiveRoutes({
      configRoutes,
      settings: {
        commander: { provider: 'orbit', model: 'pro', reasoningEffort: 'high' },
        watchdog: { provider: '', model: '', reasoningEffort: '' },
      },
      sessionSelection: { provider: 'session', model: 'flash', reasoningEffort: 'low' },
    }),
    {
      commander: { provider: 'orbit', model: 'pro', reasoningEffort: 'high' },
      executor: { provider: 'session', model: 'flash', reasoningEffort: 'low' },
      watchdog: configRoutes.watchdog,
    },
  )
})

test('falls back per role when settings or session selection are absent or unusable', () => {
  const configRoutes = routes('config')

  assert.deepEqual(
    resolveEffectiveRoutes({
      configRoutes,
      settings: { commander: { provider: 'orbit', model: 'pro' } },
    }),
    {
      commander: { provider: 'orbit', model: 'pro' },
      executor: configRoutes.executor,
      watchdog: configRoutes.watchdog,
    },
  )

  assert.deepEqual(
    resolveEffectiveRoutes({
      configRoutes,
      sessionSelection: { provider: 'session', model: 'flash' },
    }),
    {
      commander: configRoutes.commander,
      executor: { provider: 'session', model: 'flash' },
      watchdog: configRoutes.watchdog,
    },
  )

  assert.throws(() => resolveEffectiveRoutes({ configRoutes, sessionSelection: { provider: 'x' } }), /Executor 未选择/)
  assert.throws(() => resolveEffectiveRoutes({ configRoutes, sessionSelection: { provider: '', model: '' } }), /Executor 未选择/)
})

test('MoA policy uses only explicit DSH routes and never guesses models', () => {
  assert.equal(resolveMoaPolicy({ settings: { enabled: false } }), undefined)
  assert.deepEqual(resolveMoaPolicy({ settings: {
    enabled: true,
    candidateCount: 2,
    peerCritique: true,
    maxMoaSteps: 1,
    candidates: [
      { provider: 'p1', model: 'm1' },
      { provider: 'p2', model: 'm2', reasoningEffort: 'high' },
    ],
    judge: { provider: 'pj', model: 'judge' },
  } }), {
    enabled: true,
    candidate_count: 2,
    peer_critique: true,
    max_moa_steps: 1,
    candidates: [
      { provider: 'p1', model: 'm1' },
      { provider: 'p2', model: 'm2', reasoningEffort: 'high' },
    ],
    judge: { provider: 'pj', model: 'judge' },
  })
  assert.throws(() => resolveMoaPolicy({ settings: {
    enabled: true,
    candidateCount: 3,
    candidates: [{ provider: 'p', model: 'one' }],
  } }), /ORBIT_MOA_MODEL_CONFIGURATION_REQUIRED/)
})

test('route candidates require a complete provider/model pair', () => {
  assert.deepEqual(routeFromSelection({ provider: 'p', model: 'm' }), { provider: 'p', model: 'm' })
  assert.deepEqual(routeFromSelection({ provider: 'p', model: 'm', reasoningEffort: 'high' }), {
    provider: 'p',
    model: 'm',
    reasoningEffort: 'high',
  })
  assert.equal(routeFromSelection(undefined), undefined)
  assert.equal(routeFromSelection({}), undefined)
  assert.equal(routeFromSelection({ provider: 'p' }), undefined)
  assert.equal(routeFromSelection({ provider: 'p', model: '' }), undefined)
  assert.equal(routeFromSelection({ provider: 5 as never, model: 'm' }), undefined)
  assert.deepEqual(routeFromSelection({ provider: 'p', model: 'm', reasoningEffort: '' }), { provider: 'p', model: 'm' })
})

test('reads the initiating session selection from the public request header', () => {
  const selection = { provider: 'provider-a', model: 'model-b', reasoningEffort: 'high' }
  assert.deepEqual(sessionSelectionOf({ session: { requestHeader: () => ({ config: selection }) } }), selection)
  assert.equal(sessionSelectionOf({ session: { requestHeader: () => undefined } }), undefined)
  assert.equal(sessionSelectionOf({ session: {} }), undefined)
  assert.equal(sessionSelectionOf(undefined), undefined)
})

test('a new run freezes resolved routes and the next run picks up new resolution', async () => {
  const { dir, cleanup } = project()
  const host = new FakeHost()
  host
    .script('commander', [
      { structured: plan([{ id: 'P1', goal: 'a' }]) },
      { structured: commander({ decision: 'PASS_CURRENT_STEP' }) },
      { structured: commander({ decision: 'SUCCESS' }) },
      { structured: plan([{ id: 'P1', goal: 'b' }]) },
      { structured: commander({ decision: 'PASS_CURRENT_STEP' }) },
      { structured: commander({ decision: 'SUCCESS' }) },
    ])
    .script('executor', [{ output: 'done', childId: 'e1' }, { output: 'done', childId: 'e2' }])
  const store = new OrbitStateStore(dir)
  let resolved = routes('A')
  const supervisor = new OrbitSupervisor(store, host, { ...config, defaultRoutes: routes('default'), resolveRoutes: () => resolved })

  const first = await supervisor.bootstrap({ goal: 'first goal', approved_loop_count: 3 })
  assert.equal(first.phase, 'SUCCESS')
  assert.deepEqual(store.readState()?.routes, routes('A'))
  assert.equal(host.scriptsFor('executor')[0]?.request.route.model, 'A-executor')

  resolved = routes('D')
  const second = await supervisor.bootstrap({ goal: 'second goal', approved_loop_count: 3 })
  assert.equal(second.phase, 'SUCCESS')
  assert.deepEqual(store.readState()?.routes, routes('D'))
  assert.equal(host.scriptsFor('executor')[1]?.request.route.model, 'D-executor')
  cleanup()
})

test('resume reuses the frozen routes even after resolution changes', async () => {
  const { dir, cleanup } = project()
  const host = new FakeHost()
  host
    .script('commander', [
      { interrupted: true, reason: 'PLAN_FAILED', childId: 'c1' },
      { structured: plan([{ id: 'P1', goal: 'a' }]) },
      { structured: commander({ decision: 'PASS_CURRENT_STEP' }) },
      { structured: commander({ decision: 'SUCCESS' }) },
    ])
    .script('executor', [{ output: 'done', childId: 'e1' }])
  const store = new OrbitStateStore(dir)
  let resolved = routes('A')
  const supervisor = new OrbitSupervisor(store, host, { ...config, defaultRoutes: routes('default'), resolveRoutes: () => resolved })

  const first = await supervisor.bootstrap({ goal: 'interrupted goal', approved_loop_count: 3 })
  assert.equal(first.ok, false)
  assert.deepEqual(store.readState()?.routes, routes('A'))

  // The UI/settings change while the run is interrupted; the frozen run must
  // keep using its snapshot.
  resolved = routes('D')
  const resumed = await supervisor.run(store.readState()!)
  assert.equal(resumed.phase, 'SUCCESS')
  assert.deepEqual(store.readState()?.routes, routes('A'))
  for (const entry of [...host.scriptsFor('commander'), ...host.scriptsFor('executor')]) {
    assert.equal(entry.request.route.model.startsWith('A-'), true, `${entry.role} must use the frozen route`)
  }
  cleanup()
})

test('without resolveRoutes a new run keeps the config default routes', async () => {
  const { dir, cleanup } = project()
  const host = new FakeHost()
  host
    .script('commander', [
      { structured: plan([{ id: 'P1', goal: 'a' }]) },
      { structured: commander({ decision: 'PASS_CURRENT_STEP' }) },
      { structured: commander({ decision: 'SUCCESS' }) },
    ])
    .script('executor', [{ output: 'done', childId: 'e1' }])
  const store = new OrbitStateStore(dir)
  const supervisor = new OrbitSupervisor(store, host, { ...config, defaultRoutes: routes('config') })

  const result = await supervisor.bootstrap({ goal: 'plain', approved_loop_count: 3 })
  assert.equal(result.phase, 'SUCCESS')
  assert.deepEqual(store.readState()?.routes, routes('config'))
  cleanup()
})

test('the current Session model follows DSH selectionFor semantics', () => {
  // 1. The pending choice (what the native seat shows) wins over header/default.
  assert.deepEqual(
    sessionModelSelectionOf({
      sessionModel: { pending: { provider: 'provider-b', model: 'model-b', reasoningEffort: 'xhigh' } },
      requestHeader: { config: { provider: 'header', model: 'header-model' } },
      agentDefault: { provider: 'default', model: 'default-model' },
    }),
    { provider: 'provider-b', model: 'model-b', reasoningEffort: 'xhigh' },
  )

  // 2. With no pending choice, the logged request header wins over the default.
  assert.deepEqual(
    sessionModelSelectionOf({
      sessionModel: { lastUsed: { provider: 'ignored', model: 'ignored-model' }, pending: null },
      requestHeader: { config: { provider: 'header', model: 'header-model', reasoningEffort: 'low' } },
      agentDefault: { provider: 'default', model: 'default-model' },
    }),
    { provider: 'header', model: 'header-model', reasoningEffort: 'low' },
  )

  // 3. A header effort that only materialized the adapter default is not a
  //    user choice and must be suppressed, exactly like DSH does.
  assert.deepEqual(
    sessionModelSelectionOf({
      requestHeader: {
        config: { provider: 'header', model: 'header-model', reasoningEffort: 'medium' },
        adapterDefaults: { reasoningEffort: true },
      },
      agentDefault: { provider: 'default', model: 'default-model' },
    }),
    { provider: 'header', model: 'header-model' },
  )

  // 4. A fresh Session without projection state or header uses the deployment
  //    default (`ctx.agentDefaultModel.currentSelection()`).
  assert.deepEqual(
    sessionModelSelectionOf({
      sessionModel: { lastUsed: null, pending: null },
      agentDefault: { provider: 'provider-b', model: 'model-b', reasoningEffort: 'xhigh' },
    }),
    { provider: 'provider-b', model: 'model-b', reasoningEffort: 'xhigh' },
  )

  // 5. Nothing known yields nothing: the route resolver falls to config.
  assert.equal(sessionModelSelectionOf({}), undefined)
})

test('an unusable current-Session selection cannot fall back to profile executor', () => {
  const configRoutes = routes('config')
  assert.deepEqual(
    resolveEffectiveRoutes({
      configRoutes,
      sessionSelection: { provider: 'header', model: 'header-model' },
    }).executor,
    { provider: 'header', model: 'header-model' },
  )
  assert.throws(() => resolveEffectiveRoutes({ configRoutes, sessionSelection: { provider: 'x' } }), /Executor 未选择/)
  // Commander and Watchdog never follow the Session selection.
  assert.deepEqual(
    resolveEffectiveRoutes({ configRoutes, sessionSelection: { provider: 'header', model: 'header-model' } }).commander,
    configRoutes.commander,
  )
})

test('reads the session modelSelection projection and deployment default safely', () => {
  const session = { id: 's' }
  const state = { lastUsed: null, pending: { provider: 'provider-b', model: 'model-b' } }
  const ctx = {
    reflect: {
      get: (name: string) => {
        if (name === 'sessionProjections') return { stateOf: () => state }
        if (name === 'agentDefaultModel') {
          return { currentSelection: () => ({ provider: 'default', model: 'default-model', reasoningEffort: 'high' }) }
        }
        return undefined
      },
    },
  }
  assert.deepEqual(sessionModelStateOf(ctx, session), state)
  assert.deepEqual(agentDefaultSelectionOf(ctx), { provider: 'default', model: 'default-model', reasoningEffort: 'high' })
  assert.equal(sessionModelStateOf({}, session), undefined)
  assert.equal(sessionModelStateOf({ reflect: { get: () => ({ stateOf: () => 'nope' }) } }, session), undefined)
  assert.equal(sessionModelStateOf({ reflect: { get: () => undefined } }, session), undefined)
  assert.equal(agentDefaultSelectionOf({}), undefined)
  assert.equal(agentDefaultSelectionOf({ reflect: { get: () => ({}) } }), undefined)
  assert.equal(
    agentDefaultSelectionOf({ reflect: { get: () => ({ currentSelection: () => { throw new Error('boom') } }) } }),
    undefined,
  )
})

test('empty plugin Config ships no model or reasoning defaults', () => {
  const configured = Config({}) as { routes?: Record<string, { provider?: string; model?: string; reasoningEffort?: string }> }
  for (const route of Object.values(configured.routes ?? {})) {
    assert.ok(!route.provider)
    assert.ok(!route.model)
    assert.ok(!route.reasoningEffort)
  }
})

test('missing role configuration blocks durable creation and every child', async () => {
  for (const role of ['commander', 'executor', 'watchdog'] as const) {
    const { dir, cleanup } = project()
    const host = new FakeHost()
    const explicit = routes('explicit')
    const candidate: Partial<OrbitRoutes> = { ...explicit }
    delete candidate[role]
    const store = new OrbitStateStore(dir)
    const result = await new OrbitSupervisor(store, host, { ...config, defaultRoutes: candidate }).bootstrap({ goal: 'g' })
    assert.equal(result.ok, false)
    assert.match(result.message ?? '', new RegExp(`${role === 'commander' ? 'Commander' : role === 'executor' ? 'Executor' : 'Watchdog'} 未选择`))
    assert.equal(host.started.length, 0)
    assert.equal(existsSync(store.statePath), false)
    cleanup()
  }
})

test('unavailable saved model blocks a new Run without persisting guessed routes', async () => {
  const { dir, cleanup } = project()
  const host = new FakeHost()
  host.routeIssues = ['commander: ORBIT_MODEL_UNAVAILABLE (provider-a/removed-model)']
  const store = new OrbitStateStore(dir)
  const result = await new OrbitSupervisor(store, host, { ...config, defaultRoutes: routes('user') }).bootstrap({ goal: 'g' })
  assert.equal(result.ok, false)
  assert.match(result.message ?? '', /commander.*ORBIT_MODEL_UNAVAILABLE/)
  assert.equal(host.started.length, 0)
  assert.equal(existsSync(store.statePath), false)
  cleanup()
})

test('frozen user routes and reasoning reach the exact role requests without fallback or delegation tools', async () => {
  const { dir, cleanup } = project()
  const host = new FakeHost()
  const selected: OrbitRoutes = {
    commander: { provider: 'provider-a', model: 'model-a', reasoningEffort: 'effort-a' },
    executor: { provider: 'provider-b', model: 'model-b' },
    watchdog: { provider: 'provider-c', model: 'model-c', reasoningEffort: 'effort-c' },
  }
  host.tools.add('subagent')
  host
    .script('commander', [
      { structured: plan([{ id: 'P0', goal: 'run', capabilities: ['shell'] }]) },
      { structured: commander({ decision: 'PASS_CURRENT_STEP' }) },
      { structured: commander({ decision: 'SUCCESS' }) },
    ])
    .script('executor', [
      { interrupted: true, reason: 'controlled anomaly', childId: 'exec-a' },
      { output: 'done', childId: 'exec-b' },
    ])
    .script('watchdog', [{ structured: commander({ decision: 'RESTART_STEP' }) }])
  const store = new OrbitStateStore(dir)
  const supervisor = new OrbitSupervisor(store, host, { ...config, defaultRoutes: selected })
  assert.equal((await supervisor.bootstrap({ goal: 'route proof', approved_loop_count: 3 })).phase, 'SUCCESS')
  assert.deepEqual(store.readState()?.routes, selected)
  for (const request of host.started) {
    assert.deepEqual(request.request.route, selected[request.role as keyof OrbitRoutes])
    assert.ok(!(request.toolFilter?.allow ?? []).includes('subagent'), `${request.role} must not delegate to a fourth autonomous Agent`)
  }
  assert.ok(host.scriptsFor('watchdog').length > 0, 'the controlled anomaly must invoke Watchdog')
  assert.equal('reasoningEffort' in selected.executor, false, 'provider default remains an absent effort')
  cleanup()
})
