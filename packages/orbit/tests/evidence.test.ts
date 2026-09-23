import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildEvidenceBundle,
  collectTurnToolFacts,
  EVIDENCE_LIMITS,
  formatEvidenceBundle,
  isTestCommand,
  buildStepResult,
  formatStepResults,
} from '../src/evidence.ts'

const call = (turn: number, callId: string, name: string, args: Record<string, unknown>) => ({
  type: 'tool/call',
  data: { turn, step: 1, callId, name, arguments: JSON.stringify(args) },
})

const result = (
  turn: number,
  callId: string,
  isError = false,
  error?: { name: string; code: string },
  text?: string,
) => ({
  type: 'tool/result',
  data: {
    turn,
    step: 1,
    message: {
      content: [{
        type: 'tool-result',
        toolCallId: callId,
        content: text === undefined ? [] : [{ type: 'text', text }],
        isError,
      }],
    },
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

test('run_code nested tools.bash preserves trusted stdout, exit code, and test evidence', () => {
  const code = `const r = await tools.bash({ command: 'node --test orbit-smoke-test/task-summary.test.js; echo "EXIT_CODE=$?"', workdir: '/root/code' });\nconsole.log(r.stdout.text);\nconsole.log('timedOut:', r.timedOut, 'exitCode:', r.exitCode);`
  const output = [
    '✔ 正常统计',
    'ℹ tests 7',
    'ℹ pass 7',
    'ℹ fail 0',
    'EXIT_CODE=0',
    'timedOut: false exitCode: 0',
  ].join('\n')
  const facts = collectTurnToolFacts([
    { type: 'turn/start', data: { turn: 1 } },
    call(1, 'rc1', 'run_code', { code, description: 'run tests' }),
    result(1, 'rc1', false, undefined, output),
  ])

  assert.equal(facts.length, 1)
  assert.equal(facts[0]?.name, 'run_code')
  assert.equal(facts[0]?.operation, 'tools.bash')
  assert.match(facts[0]?.command ?? '', /node --test orbit-smoke-test\/task-summary\.test\.js/)
  assert.equal(facts[0]?.exit_code, 0)
  assert.match(facts[0]?.result_summary ?? '', /pass 7/)

  const bundle = buildEvidenceBundle({ tools: facts, executorOutput: 'tests passed' })
  assert.equal(bundle.tests.length, 1)
  assert.equal(bundle.tests[0]?.status, 'ok')
  assert.equal(bundle.tests[0]?.exit_code, 0)
  assert.match(bundle.tests[0]?.result_summary ?? '', /tests 7/)
  assert.match(bundle.tests[0]?.result_summary ?? '', /fail 0/)
  const formatted = formatEvidenceBundle(bundle)
  assert.match(formatted, /\[TRUSTED_TOOL_EVENTS\]/)
  assert.match(formatted, /\[EXECUTOR_SUMMARY_UNVERIFIED\]/)
  assert.match(formatted, /"operation":"tools\.bash"/)
  assert.match(formatted, /"exit_code":0/)
  const durable = buildStepResult('P2', 1, bundle)
  assert.equal(durable.test_summary.length, 1)
  assert.match(durable.test_summary[0] ?? '', /node --test/)
  assert.match(durable.test_summary[0] ?? '', /pass 7/)
  assert.match(durable.test_summary[0] ?? '', /fail 0/)
  assert.match(durable.test_summary[0] ?? '', /exit=0/)
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
    tools: [{ name: 'bash', status: 'ok', command: 'y'.repeat(1000), result_summary: 'r'.repeat(5000) }],
  })
  assert.ok((longEntry.tools[0]?.detail ?? '').length <= EVIDENCE_LIMITS.entry)
  assert.ok((longEntry.tools[0]?.result_summary ?? '').length <= EVIDENCE_LIMITS.toolResult)
  assert.ok((longEntry.tests[0]?.command ?? '').length <= EVIDENCE_LIMITS.entry)
})

test('redacts secrets and enforces the total budget', () => {
  const facts = collectTurnToolFacts([
    { type: 'turn/start', data: { turn: 1 } },
    call(1, 's1', 'bash', { command: 'API_KEY=supersecret123 npm run deploy', env: { TOKEN: 'abc' } }),
    result(1, 's1'),
  ])
  const secretOutputFacts = collectTurnToolFacts([
    { type: 'turn/start', data: { turn: 2 } },
    call(2, 's2', 'run_code', { code: `console.log('token')` }),
    result(2, 's2', false, undefined, 'TOKEN=supersecret123'),
  ])
  const bundle = buildEvidenceBundle({ tools: [...facts, ...secretOutputFacts], executorOutput: 'access_token=abcdef123456' })
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

test('durable step results bound and redact every string and final review retains every step', () => {
  const result = buildStepResult('P0', 1, buildEvidenceBundle({
    executorOutput: 'API_KEY=private-value ' + 'x'.repeat(9000),
    changedFiles: Array.from({ length: 70 }, () => 'a'.repeat(900)),
  }), Array.from({ length: 20 }, () => 'token=private-value ' + 't'.repeat(1000)))
  assert.ok(result.summary.length <= 2000)
  assert.ok(result.changed_files.length <= 50)
  assert.ok(result.test_summary.length <= 10)
  assert.ok(result.test_summary.every((item) => item.length <= 400))
  assert.doesNotMatch(JSON.stringify(result), /private-value/)
  const steps = Array.from({ length: 10 }, (_, i) => ({ id: `P${i}`, goal: 'g', status: 'passed' as const }))
  const formatted = formatStepResults({ plan: { summary: '', steps }, step_results: steps.map((step) => ({ ...result, step_id: step.id })) } as never)
  assert.ok(formatted.length <= 8000)
  for (const step of steps) assert.ok(formatted.includes(`${step.id}[passed]`))
})
