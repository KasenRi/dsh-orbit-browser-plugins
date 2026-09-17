import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OrbitStateStore } from '../src/state-store.ts'
import { OrbitSupervisor, type OrbitSupervisorConfig } from '../src/supervisor.ts'
import { resolveEffectiveRoutes, routeFromSelection, sessionModelStateOf, sessionSelectionOf } from '../src/routes.ts'
import type { OrbitRoutes } from '../src/types.ts'
import { FakeHost } from './helpers/fake-host.ts'

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

const plan = (steps: Array<{ id: string; goal: string }>) => ({ summary: 'plan', steps })
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

  assert.deepEqual(resolveEffectiveRoutes({ configRoutes, sessionSelection: { provider: 'x' } }), configRoutes)
  assert.deepEqual(resolveEffectiveRoutes({ configRoutes, sessionSelection: { provider: '', model: '' } }), configRoutes)
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
  const selection = { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'high' }
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

test('the durable session modelSelection wins over the request header', () => {
  const configRoutes = routes('config')

  // The pending choice (what the native seat shows) beats lastUsed and the
  // legacy request header.
  assert.deepEqual(
    resolveEffectiveRoutes({
      configRoutes,
      sessionModel: {
        lastUsed: { provider: 'old', model: 'old-model', reasoningEffort: 'low' },
        pending: { provider: 'mysub-oc', model: 'glm-5.3-flash', reasoningEffort: 'xhigh' },
      },
      sessionSelection: { provider: 'header', model: 'header-model' },
    }).executor,
    { provider: 'mysub-oc', model: 'glm-5.3-flash', reasoningEffort: 'xhigh' },
  )

  // lastUsed applies when no choice is pending.
  assert.deepEqual(
    resolveEffectiveRoutes({
      configRoutes,
      sessionModel: { lastUsed: { provider: 'used', model: 'used-model' }, pending: null },
      sessionSelection: { provider: 'header', model: 'header-model' },
    }).executor,
    { provider: 'used', model: 'used-model' },
  )

  // The request header remains a compatibility fallback below the durable
  // projection, and config is the last resort.
  assert.deepEqual(
    resolveEffectiveRoutes({
      configRoutes,
      sessionModel: { lastUsed: null, pending: null },
      sessionSelection: { provider: 'header', model: 'header-model' },
    }).executor,
    { provider: 'header', model: 'header-model' },
  )
  assert.deepEqual(
    resolveEffectiveRoutes({ configRoutes, sessionModel: { lastUsed: null, pending: null } }).executor,
    configRoutes.executor,
  )
})

test('reads the session modelSelection projection without an inject declaration', () => {
  const session = { id: 's' }
  const state = { lastUsed: null, pending: { provider: 'mysub-oc', model: 'glm-5.3-flash' } }
  const ctx = {
    reflect: {
      get: (name: string) => (name === 'sessionProjections' ? { stateOf: () => state } : undefined),
    },
  }
  assert.deepEqual(sessionModelStateOf(ctx, session), state)
  assert.equal(sessionModelStateOf({}, session), undefined)
  assert.equal(sessionModelStateOf({ reflect: { get: () => ({ stateOf: () => 'nope' }) } }, session), undefined)
  assert.equal(sessionModelStateOf({ reflect: { get: () => undefined } }, session), undefined)
})
