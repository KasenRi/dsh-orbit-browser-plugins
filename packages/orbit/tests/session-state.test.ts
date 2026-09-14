import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ORBIT_SESSION_KEY,
  ORBIT_TOGGLE_COMMAND,
  foldOrbitSession,
  installOrbitSessionProjection,
  parseOrbitToggle,
  type OrbitSessionState,
} from '../src/session-state.ts'

test('the toggle argument parses only to on/off', () => {
  assert.equal(ORBIT_TOGGLE_COMMAND, 'orbit-toggle')
  assert.equal(parseOrbitToggle('on'), true)
  assert.equal(parseOrbitToggle(' ON '), true)
  assert.equal(parseOrbitToggle('off'), false)
  assert.equal(parseOrbitToggle(' Off'), false)
  assert.equal(parseOrbitToggle(''), undefined)
  assert.equal(parseOrbitToggle('true'), undefined)
  assert.equal(parseOrbitToggle('/orbit-toggle on'), undefined)
})

test('a new Session starts OFF and folds its own toggle records', () => {
  const toggle = (args: string) => ({ type: 'command/run', data: { name: ORBIT_TOGGLE_COMMAND, args } })
  assert.deepEqual(foldOrbitSession({ enabled: false }, toggle(' on')), { enabled: true })
  assert.deepEqual(foldOrbitSession({ enabled: true }, toggle('off')), { enabled: false })
  assert.deepEqual(foldOrbitSession({ enabled: true }, toggle(' on')), { enabled: true })
})

test('unrelated events, other commands, and malformed arguments keep the same state', () => {
  const state: OrbitSessionState = { enabled: true }
  assert.equal(foldOrbitSession(state, { type: 'turn/start', data: { turn: 1 } }), state)
  assert.equal(foldOrbitSession(state, { type: 'command/run', data: { name: 'agent-orbit', args: ' goal' } }), state)
  assert.equal(foldOrbitSession(state, { type: 'command/run', data: { name: ORBIT_TOGGLE_COMMAND, args: 'maybe' } }), state)
  assert.equal(foldOrbitSession(state, { type: 'command/run', data: { name: ORBIT_TOGGLE_COMMAND } }), state)
  assert.equal(foldOrbitSession(state, { type: 'command/run', data: 'not-a-record' }), state)
})

test('the projection registers with the OFF default and a strict wire shape', () => {
  let registered: {
    key: string
    init: () => OrbitSessionState
    apply: (state: OrbitSessionState, event: { type: string; data: unknown }) => OrbitSessionState
    wire: { viewSchema: { parse: (value: unknown) => unknown }; view: (state: OrbitSessionState) => OrbitSessionState }
    stateSchema: { parse: (value: unknown) => unknown }
  } | undefined
  const ctx = {
    sessionProjections: {
      register: (definition: never) => {
        registered = definition as never
        return () => undefined
      },
    },
  }
  installOrbitSessionProjection(ctx as never)
  assert.ok(registered)
  assert.equal(registered.key, ORBIT_SESSION_KEY)
  assert.deepEqual(registered.init(), { enabled: false })
  assert.deepEqual(
    registered.apply({ enabled: false }, { type: 'command/run', data: { name: ORBIT_TOGGLE_COMMAND, args: ' on' } }),
    { enabled: true },
  )
  assert.deepEqual(registered.wire.view({ enabled: true }), { enabled: true })
  assert.deepEqual(registered.stateSchema.parse({ enabled: false }), { enabled: false })
  assert.throws(() => registered?.stateSchema.parse({ enabled: 'yes' }))
  assert.throws(() => registered?.stateSchema.parse(null))
})
