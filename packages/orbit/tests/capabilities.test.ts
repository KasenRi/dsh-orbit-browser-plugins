import { test } from 'node:test'
import assert from 'node:assert/strict'
import { executorToolsFor, EXECUTOR_READ_ONLY_TOOLS } from '../src/capabilities.ts'
import { normalizeCapabilities, applyCorrectionStep, createInitialState } from '../src/kernel.ts'

test('Executor capabilities grant exactly the requested tool union', () => {
  const base = [...EXECUTOR_READ_ONLY_TOOLS]
  assert.deepEqual(executorToolsFor([], ['custom_browser']), base)
  assert.deepEqual(executorToolsFor(['filesystem'], ['custom_browser']), [...base, 'write', 'edit', 'str_replace_editor'])
  assert.deepEqual(executorToolsFor(['shell'], ['custom_browser']), [...base, 'bash'])
  assert.deepEqual(executorToolsFor(['web'], ['custom_browser']), [...base, 'web_search', 'web_fetch'])
  assert.deepEqual(executorToolsFor(['browser'], ['custom_browser']), [...base, 'custom_browser'])
  assert.deepEqual(executorToolsFor(['filesystem', 'shell'], ['custom_browser']), [...base, 'write', 'edit', 'str_replace_editor', 'bash'])
  assert.deepEqual(executorToolsFor([], ['custom_browser'], [...base, 'bash', 'write', 'workflow', 'custom_browser']), base)
  for (const capabilities of [[], ['filesystem'], ['shell'], ['web'], ['browser']] as const) {
    assert.ok(!executorToolsFor(capabilities, ['custom_browser']).includes('subagent'))
  }
})

test('legacy reconnaissance normalizes and explicit empty correction removes capability', () => {
  assert.deepEqual(normalizeCapabilities(['web-api-recon']), ['web', 'browser'])
  const route = { provider: 'provider-a', model: 'model-a' }
  const state = createInitialState({ runId: 'r', now: 0, goal: 'g', routes: { commander: route, executor: route, watchdog: route }, githubAllowed: false })
  state.plan.steps = [{ id: 'P0', goal: 'g', status: 'running', capabilities: ['browser'] }]
  applyCorrectionStep(state, state.plan.steps[0]!, { nextGoal: 'read only', capabilities: [] })
  assert.equal(state.plan.steps[1]?.capabilities, undefined)
})
