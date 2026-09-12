import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildEvidenceBundle,
  collectTurnToolFacts,
  EVIDENCE_LIMITS,
  formatEvidenceBundle,
  isTestCommand,
} from '../src/evidence.ts'

const call = (turn: number, callId: string, name: string, args: Record<string, unknown>) => ({
  type: 'tool/call',
  data: { turn, step: 1, callId, name, arguments: JSON.stringify(args) },
})

const result = (turn: number, callId: string, isError = false, error?: { name: string; code: string }) => ({
  type: 'tool/result',
  data: {
    turn,
    step: 1,
    message: { content: [{ type: 'tool-result', toolCallId: callId, content: [], isError }] },
    ...(error ? { error } : {}),
  },
})

test('turn isolation: only the most recent turn produces facts', () => {
  const facts = collectTurnToolFacts([
    { type: 'turn/start', data: { turn: 1 } },
    call(1, 'c1', 'read', { path: 'a.ts' }),
    result(1, 'c1'),
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
    { type: 'turn/start', data: { turn: 2 } },
    call(2, 'c2', 'edit', { path: 'b.ts' }),
    result(2, 'c2'),
  ])
  assert.deepEqual(
    facts.map((fact) => fact.name),
    ['edit'],
  )
})

test('pairs calls with results and marks unpaired calls unknown', () => {
  const facts = collectTurnToolFacts([
    { type: 'turn/start', data: { turn: 1 } },
    call(1, 'ok', 'read', { path: 'a.ts' }),
    result(1, 'ok'),
    call(1, 'bad', 'bash', { command: 'false' }),
    result(1, 'bad', true, { name: 'ExitError', code: 'E2' }),
    call(1, 'open', 'grep', { pattern: 'x' }),
  ])
  assert.deepEqual(
    facts.map((fact) => ({ name: fact.name, status: fact.status, detail: fact.detail })),
    [
      { name: 'read', status: 'ok', detail: undefined },
      { name: 'bash', status: 'error', detail: 'ExitError:E2' },
      { name: 'grep', status: 'unknown', detail: undefined },
    ],
  )
})

test('detects test commands and keeps them as real evidence', () => {
  assert.ok(isTestCommand('npm test -- --grep evidence'))
  assert.ok(isTestCommand('node --test packages/orbit/tests/*.test.ts'))
  assert.ok(!isTestCommand('npm run build'))
  const facts = collectTurnToolFacts([
    { type: 'turn/start', data: { turn: 1 } },
    call(1, 't1', 'bash', { command: 'npm test' }),
    result(1, 't1'),
    call(1, 't2', 'bash', { command: 'echo hi' }),
    result(1, 't2'),
  ])
  const bundle = buildEvidenceBundle({ tools: facts })
  assert.deepEqual(bundle.tests, [{ command: 'npm test', status: 'ok' }])
  assert.equal(bundle.tools.length, 2)
})

test('bounds every evidence section', () => {
  const tools = Array.from({ length: 30 }, (_, index) => ({
    name: `tool-${index}`,
    status: 'ok' as const,
    command: `npm test -- project-${index}`,
  }))
  const bundle = buildEvidenceBundle({
    changedFiles: Array.from({ length: 60 }, (_, index) => `src/file-${index}.ts`),
    tools,
    executorOutput: 'x'.repeat(5000),
  })
  assert.equal(bundle.changed_files.length, EVIDENCE_LIMITS.changedFiles)
  assert.equal(bundle.tools.length, EVIDENCE_LIMITS.toolEvidence)
  assert.equal(bundle.tests.length, EVIDENCE_LIMITS.testEvidence)
  assert.ok((bundle.executor_summary ?? '').length <= EVIDENCE_LIMITS.executorSummary)

  const longEntry = buildEvidenceBundle({
    tools: [{ name: 'bash', status: 'ok', command: 'y'.repeat(1000) }],
  })
  assert.ok((longEntry.tools[0]?.detail ?? '').length <= EVIDENCE_LIMITS.entry)
  assert.ok((longEntry.tests[0]?.command ?? '').length <= EVIDENCE_LIMITS.entry)
})

test('redacts secrets and enforces the total budget', () => {
  const facts = collectTurnToolFacts([
    { type: 'turn/start', data: { turn: 1 } },
    call(1, 's1', 'bash', { command: 'API_KEY=supersecret123 npm run deploy', env: { TOKEN: 'abc' } }),
    result(1, 's1'),
  ])
  const bundle = buildEvidenceBundle({ tools: facts, executorOutput: 'access_token=abcdef123456' })
  const formatted = formatEvidenceBundle(bundle)
  assert.ok(!formatted.includes('supersecret123'))
  assert.ok(!formatted.includes('abcdef123456'))

  const huge = buildEvidenceBundle({
    executorOutput: 'z'.repeat(100_000),
    changedFiles: Array.from({ length: 60 }, (_, index) => `src/${'d'.repeat(300)}-${index}.ts`),
    tools: Array.from({ length: 25 }, () => ({ name: 'bash', status: 'ok' as const, command: 'q'.repeat(1000) })),
  })
  assert.ok(formatEvidenceBundle(huge).length <= EVIDENCE_LIMITS.total)
})

test('a log without turn boundaries yields no facts', () => {
  assert.deepEqual(collectTurnToolFacts([call(1, 'c1', 'read', { path: 'a.ts' }), result(1, 'c1')]), [])
})
