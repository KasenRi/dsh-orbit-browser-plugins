import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OrbitStateStore } from '../src/state-store.ts'
import { OrbitSupervisor, type OrbitSupervisorConfig } from '../src/supervisor.ts'
import type { OrbitMoaAdapterLike, OrbitMoaFanoutResult, OrbitMoaJudgeResult } from '../src/moa-adapter.ts'
import type { OrbitMoaPolicy, OrbitMoaPromotionReceipt } from '../src/types.ts'
import { FakeHost } from './helpers/fake-host.ts'

const POLICY: OrbitMoaPolicy = {
  enabled: true,
  candidate_count: 3,
  peer_critique: false,
  max_moa_steps: 2,
  candidates: [
    { provider: 'p', model: 'candidate-a' },
    { provider: 'p', model: 'candidate-b', reasoningEffort: 'high' },
    { provider: 'p', model: 'candidate-c' },
  ],
  judge: { provider: 'p', model: 'judge', reasoningEffort: 'high' },
}

class FakeMoa implements OrbitMoaAdapterLike {
  availabilityCalls = 0
  fanoutCalls = 0
  judgeCalls = 0
  promoteCalls = 0
  lastPolicy?: OrbitMoaPolicy
  successful = 3
  available = true
  throwJudge = false
  includeUsage = false

  async availability() {
    this.availabilityCalls += 1
    return this.available
      ? { available: true, version: '0.2.19' }
      : { available: false, reason: 'ORBIT_MOA_UNAVAILABLE: package missing' }
  }

  async fanout(input: Parameters<OrbitMoaAdapterLike['fanout']>[0]): Promise<OrbitMoaFanoutResult> {
    this.fanoutCalls += 1
    this.lastPolicy = input.policy
    const candidates = input.policy.candidates.slice(0, input.policy.candidate_count).map((route, offset) => ({
      index: offset + 1,
      provider: route.provider,
      model: route.model,
      ok: offset < this.successful,
      summary: offset < this.successful ? '候选方案 ' + (offset + 1) : '失败',
      files: offset === 1 && offset < this.successful ? ['result.txt'] : [],
      ...(this.includeUsage && offset < this.successful ? { usage: { input_tokens: 10 + offset, output_tokens: 5 + offset, total_tokens: 15 + (offset * 2), cost_usd: 0.001 * (offset + 1) } } : {}),
      ...(offset < this.successful ? {} : { error: 'candidate failed' }),
    }))
    return {
      adapterVersion: '0.2.19',
      candidates,
      successful: candidates.filter((candidate) => candidate.ok).length,
      failed: candidates.filter((candidate) => !candidate.ok).length,
    }
  }

  async judge(input: Parameters<OrbitMoaAdapterLike['judge']>[0]): Promise<OrbitMoaJudgeResult> {
    this.judgeCalls += 1
    if (this.throwJudge) throw new Error('ORBIT_MOA_JUDGE_FAILED')
    const candidate = input.candidates.find((entry) => entry.index === 2 && entry.ok) ?? input.candidates.find((entry) => entry.ok)
    if (!candidate) throw new Error('no candidate')
    return {
      winningCandidate: candidate.index,
      winnerModel: candidate.provider + '/' + candidate.model,
      summary: '候选 2 的实现最完整。\nWINNER_CANDIDATE_INDEX: ' + candidate.index,
      ...(this.includeUsage ? { usage: { input_tokens: 20, output_tokens: 8, total_tokens: 28, cost_usd: 0.004 } } : {}),
    }
  }

  async promote(input: Parameters<OrbitMoaAdapterLike['promote']>[0]): Promise<OrbitMoaPromotionReceipt> {
    this.promoteCalls += 1
    writeFileSync(join(input.workspace, 'result.txt'), 'winner\n')
    return {
      files: [{ path: 'result.txt', candidate_sha256: 'a', promoted_sha256: 'b' }],
      promoted_at: '2026-09-20T00:00:00.000Z',
    }
  }
}

const BASE_CONFIG: Omit<OrbitSupervisorConfig, 'moaAdapter' | 'resolveMoaPolicy'> = {
  defaultRoutes: {
    commander: { provider: 'p', model: 'commander' },
    executor: { provider: 'p', model: 'executor' },
    watchdog: { provider: 'p', model: 'watchdog' },
  },
  browserTools: ['agent_browser'],
  commanderReadOnlyTools: ['read', 'glob', 'grep'],
  watchdogTools: ['read', 'glob', 'grep'],
  executorTools: ['read', 'glob', 'grep', 'bash', 'write', 'edit'],
}

function project(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-orbit-moa-supervisor-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

function seedMoaResumeState(store: OrbitStateStore, phase: 'JUDGE' | 'SELECTED' | 'PROMOTED'): void {
  const creator = new OrbitSupervisor(store, new FakeHost(), {
    ...BASE_CONFIG,
    moaAdapter: new FakeMoa(),
    resolveMoaPolicy: () => POLICY,
  })
  const state = creator.createState({ goal: 'resume MoA' })
  state.phase = 'EXECUTE'
  state.status = 'running'
  state.plan = { summary: 'existing plan', steps: [{ id: 'P0', goal: 'ensemble', execution_mode: 'MOA', status: 'running' }] }
  state.current_step = { id: 'P0', attempt: 1 }
  state.moa_step = {
    step_id: 'P0',
    phase,
    adapter_version: '0.2.19',
    candidates: [
      { index: 1, provider: 'p', model: 'candidate-a', ok: true, summary: 'A', files: [] },
      { index: 2, provider: 'p', model: 'candidate-b', ok: true, summary: 'B', files: ['result.txt'] },
      { index: 3, provider: 'p', model: 'candidate-c', ok: true, summary: 'C', files: [] },
    ],
    successful_candidates: 3,
    failed_candidates: 0,
    ...(phase === 'JUDGE' ? {} : {
      winning_candidate: 2,
      winner_model: 'p/candidate-b',
      judge_summary: 'WINNER_CANDIDATE_INDEX: 2',
    }),
    ...(phase === 'PROMOTED' ? {
      promotion_receipt: {
        files: [{ path: 'result.txt', candidate_sha256: 'a', promoted_sha256: 'b' }],
        promoted_at: '2026-09-20T00:00:00.000Z',
      },
    } : {}),
  }
  store.writeState(state)
}

test('MOA step fans out, judges, promotes, verifies, and spends exactly one Orbit loop', async () => {
  const { dir, cleanup } = project()
  const host = new FakeHost()
  const moa = new FakeMoa()
  host
    .script('commander', [
      { structured: { summary: 'plan', steps: [{ id: 'P0', goal: '选择并实现更可靠的修复', capabilities: ['filesystem', 'shell'], execution_mode: 'MOA' }] } },
      { structured: { decision: 'PASS_CURRENT_STEP' } },
      { visibleOutput: '最终结果', structured: { decision: 'SUCCESS', summary: '完成' } },
    ])
    .script('executor', [{
      output: '已检查胜出文件并运行测试，全部通过。',
      childId: 'verify-1',
      changedFiles: ['result.txt'],
      testSummary: ['npm test PASS'],
    }])

  const store = new OrbitStateStore(dir)
  const supervisor = new OrbitSupervisor(store, host, {
    ...BASE_CONFIG,
    moaAdapter: moa,
    resolveMoaPolicy: () => POLICY,
  })
  const result = await supervisor.bootstrap({ goal: '解决复杂问题' })

  assert.equal(result.phase, 'SUCCESS')
  assert.deepEqual(result.data?.['loop'], { used: 1, max: 5 })
  assert.equal(moa.fanoutCalls, 1)
  assert.equal(moa.judgeCalls, 1)
  assert.equal(moa.promoteCalls, 1)
  assert.deepEqual(moa.lastPolicy, POLICY)
  assert.equal(store.readState()?.moa_step?.phase, 'PROMOTED')
  assert.equal(store.readState()?.moa_step?.winning_candidate, 2)
  assert.match(host.scriptsFor('executor')[0]?.request.prompt ?? '', /Supervisor 已确定性地把胜出文件提升/)
  assert.match(host.scriptsFor('executor')[0]?.request.prompt ?? '', /candidate-2/)
  assert.deepEqual(store.readState()?.moa_policy, POLICY)
  cleanup()
})

test('MoA routes are frozen once and later resolver changes do not alter the active Run', async () => {
  const { dir, cleanup } = project()
  const host = new FakeHost()
  const moa = new FakeMoa()
  let policy = structuredClone(POLICY)
  host.script('commander', [{ interrupted: true, reason: 'PLAN_FAILED', childId: 'c1' }])

  const store = new OrbitStateStore(dir)
  const supervisor = new OrbitSupervisor(store, host, {
    ...BASE_CONFIG,
    moaAdapter: moa,
    resolveMoaPolicy: () => policy,
  })
  const first = await supervisor.bootstrap({ goal: '冻结 MoA 路由' })
  assert.equal(first.ok, false)
  const frozen = structuredClone(store.readState()?.moa_policy)

  policy = {
    ...POLICY,
    candidates: POLICY.candidates.map((route, index) => ({ ...route, model: 'changed-' + index })),
    judge: { provider: 'p', model: 'changed-judge' },
  }
  assert.deepEqual(store.readState()?.moa_policy, frozen)
  cleanup()
})

test('missing MoA integration fails preflight before durable Run creation', async () => {
  const { dir, cleanup } = project()
  const host = new FakeHost()
  const moa = new FakeMoa()
  moa.available = false
  const store = new OrbitStateStore(dir)
  const result = await new OrbitSupervisor(store, host, {
    ...BASE_CONFIG,
    moaAdapter: moa,
    resolveMoaPolicy: () => POLICY,
  }).bootstrap({ goal: 'x' })
  assert.equal(result.ok, false)
  assert.match(result.message ?? '', /ORBIT_MOA_UNAVAILABLE/)
  assert.equal(store.readState(), null)
  assert.equal(host.scriptsFor('commander').length, 0)
  cleanup()
})

test('a PLAN cannot request MOA when the Run has no frozen MoA policy', async () => {
  const { dir, cleanup } = project()
  const host = new FakeHost()
  host.script('commander', [{
    structured: { summary: 'bad plan', steps: [{ id: 'P0', goal: 'ensemble', execution_mode: 'MOA' }] },
  }])
  const result = await new OrbitSupervisor(new OrbitStateStore(dir), host, BASE_CONFIG).bootstrap({ goal: 'x' })
  assert.equal(result.ok, false)
  assert.equal(result.phase, 'PLAN')
  assert.match(String(result.data?.['last_error']), /ORBIT_MOA_UNAVAILABLE/)
  assert.equal(host.scriptsFor('executor').length, 0)
  cleanup()
})

test('cold resume after candidate fan-out reuses candidates and starts at Judge', async () => {
  const { dir, cleanup } = project()
  const store = new OrbitStateStore(dir)
  seedMoaResumeState(store, 'JUDGE')
  const host = new FakeHost()
  const moa = new FakeMoa()
  host
    .script('commander', [
      { structured: { decision: 'PASS_CURRENT_STEP' } },
      { visibleOutput: 'final', structured: { decision: 'SUCCESS', summary: 'done' } },
    ])
    .script('executor', [{ output: 'verified', changedFiles: ['result.txt'], testSummary: ['PASS'] }])

  const result = await new OrbitSupervisor(store, host, { ...BASE_CONFIG, moaAdapter: moa, resolveMoaPolicy: () => POLICY }).run(store.readState()!)
  assert.equal(result.phase, 'SUCCESS')
  assert.equal(moa.fanoutCalls, 0, 'durable candidates must not be regenerated')
  assert.equal(moa.judgeCalls, 1)
  assert.equal(moa.promoteCalls, 1)
  cleanup()
})

test('cold resume after Judge selection skips both fan-out and Judge', async () => {
  const { dir, cleanup } = project()
  const store = new OrbitStateStore(dir)
  seedMoaResumeState(store, 'SELECTED')
  const host = new FakeHost()
  const moa = new FakeMoa()
  host
    .script('commander', [
      { structured: { decision: 'PASS_CURRENT_STEP' } },
      { visibleOutput: 'final', structured: { decision: 'SUCCESS', summary: 'done' } },
    ])
    .script('executor', [{ output: 'verified', changedFiles: ['result.txt'], testSummary: ['PASS'] }])

  const result = await new OrbitSupervisor(store, host, { ...BASE_CONFIG, moaAdapter: moa, resolveMoaPolicy: () => POLICY }).run(store.readState()!)
  assert.equal(result.phase, 'SUCCESS')
  assert.equal(moa.fanoutCalls, 0)
  assert.equal(moa.judgeCalls, 0, 'durable winner must not be judged again')
  assert.equal(moa.promoteCalls, 1)
  cleanup()
})

test('cold resume after Promotion skips every MoA model call and promotion', async () => {
  const { dir, cleanup } = project()
  const store = new OrbitStateStore(dir)
  seedMoaResumeState(store, 'PROMOTED')
  const host = new FakeHost()
  const moa = new FakeMoa()
  host
    .script('commander', [
      { structured: { decision: 'PASS_CURRENT_STEP' } },
      { visibleOutput: 'final', structured: { decision: 'SUCCESS', summary: 'done' } },
    ])
    .script('executor', [{ output: 'verified', changedFiles: ['result.txt'], testSummary: ['PASS'] }])

  const result = await new OrbitSupervisor(store, host, { ...BASE_CONFIG, moaAdapter: moa, resolveMoaPolicy: () => POLICY }).run(store.readState()!)
  assert.equal(result.phase, 'SUCCESS')
  assert.equal(moa.fanoutCalls, 0)
  assert.equal(moa.judgeCalls, 0)
  assert.equal(moa.promoteCalls, 0, 'durable promotion receipt must prevent another promotion')
  assert.equal(host.scriptsFor('executor').length, 1, 'only verification resumes')
  cleanup()
})

test('MoA token and cost accounting is persisted as a complete aggregate', async () => {
  const { dir, cleanup } = project()
  const host = new FakeHost()
  const moa = new FakeMoa()
  moa.includeUsage = true
  host
    .script('commander', [
      { structured: { summary: 'plan', steps: [{ id: 'P0', goal: 'ensemble', execution_mode: 'MOA' }] } },
      { structured: { decision: 'PASS_CURRENT_STEP' } },
      { visibleOutput: 'final', structured: { decision: 'SUCCESS', summary: 'done' } },
    ])
    .script('executor', [{ output: 'verified' }])
  const store = new OrbitStateStore(dir)
  const result = await new OrbitSupervisor(store, host, {
    ...BASE_CONFIG,
    moaAdapter: moa,
    resolveMoaPolicy: () => POLICY,
  }).bootstrap({ goal: 'usage' })

  assert.equal(result.phase, 'SUCCESS')
  assert.deepEqual(store.readState()?.moa_step?.total_usage, {
    input_tokens: 53,
    output_tokens: 26,
    total_tokens: 79,
    cost_usd: 0.01,
  })
  assert.deepEqual(store.readState()?.moa_step?.judge_usage, {
    input_tokens: 20,
    output_tokens: 8,
    total_tokens: 28,
    cost_usd: 0.004,
  })
  cleanup()
})

test('MoA runtime failure settles the same attempt for Commander review without an implicit retry', async () => {
  const { dir, cleanup } = project()
  const host = new FakeHost()
  const moa = new FakeMoa()
  moa.throwJudge = true
  host.script('commander', [
    { structured: { summary: 'plan', steps: [{ id: 'P0', goal: 'ensemble', execution_mode: 'MOA' }] } },
    { structured: { decision: 'NEEDS_USER', reason: 'Judge 失败，需要用户处理' } },
  ])
  const store = new OrbitStateStore(dir)
  const result = await new OrbitSupervisor(store, host, {
    ...BASE_CONFIG,
    moaAdapter: moa,
    resolveMoaPolicy: () => POLICY,
  }).bootstrap({ goal: 'x' })

  assert.equal(result.phase, 'NEEDS_USER')
  assert.equal(store.readState()?.current_step?.attempt, 1)
  assert.deepEqual(store.readState()?.loop, { used: 1, max: 5 })
  assert.match(store.readState()?.moa_step?.last_error ?? '', /ORBIT_MOA_JUDGE_FAILED/)
  assert.equal(host.scriptsFor('executor').length, 0)
  cleanup()
})

test('MoA quorum failure does not silently fall back to the single Executor', async () => {
  const { dir, cleanup } = project()
  const host = new FakeHost()
  const moa = new FakeMoa()
  moa.successful = 1
  host.script('commander', [
    { structured: { summary: 'plan', steps: [{ id: 'P0', goal: 'ensemble', execution_mode: 'MOA' }] } },
    { structured: { decision: 'NEEDS_USER', reason: '候选不足，无法可靠择优' } },
  ])
  const store = new OrbitStateStore(dir)
  const result = await new OrbitSupervisor(store, host, {
    ...BASE_CONFIG,
    moaAdapter: moa,
    resolveMoaPolicy: () => POLICY,
  }).bootstrap({ goal: 'x' })

  assert.equal(result.phase, 'NEEDS_USER')
  assert.equal(moa.judgeCalls, 0)
  assert.equal(moa.promoteCalls, 0)
  assert.equal(host.scriptsFor('executor').length, 0)
  assert.match(store.readState()?.moa_step?.last_error ?? '', /ORBIT_MOA_QUORUM_FAILED/)
  cleanup()
})
