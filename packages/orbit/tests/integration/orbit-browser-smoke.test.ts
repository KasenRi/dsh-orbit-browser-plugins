import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BrowserRunner } from '../../../browser/src/runner.ts'
import { resolveExecutable } from '../../../browser/src/cli.ts'
import { findChromium } from '../../../../tests/helpers/chromium.ts'
import { OrbitStateStore } from '../../src/state-store.ts'
import { OrbitSupervisor, type OrbitSupervisorConfig } from '../../src/supervisor.ts'
import type { OrbitHost, RoleHandle, RoleRunRequest, RoleRunResult } from '../../src/host.ts'

const chromium = findChromium()
const agentBrowser = resolveExecutable('agent-browser', process.env.PATH)

const config: OrbitSupervisorConfig = {
  defaultRoutes: {
    commander: { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'high' },
    executor: { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'high' },
    watchdog: { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'low' },
  },
  browserTools: ['agent_browser'],
  commanderReadOnlyTools: ['read', 'read_image', 'glob', 'grep', 'web_search', 'web_fetch'],
  watchdogTools: ['read', 'read_image', 'glob', 'grep'],
  executorTools: ['read', 'glob', 'grep', 'bash', 'write', 'edit'],
}

const FIXTURE =
  'data:text/html,<html><head><title>SmokeTitle</title></head><body><h1>Hello</h1><button id="b">Go</button></body></html>'

/** Host that really drives the browser capability for browser-capability steps. */
class CapabilityHost implements OrbitHost {
  readonly events: string[] = []
  readonly toolFilters: Array<{ role: string; allow?: readonly string[]; deny?: readonly string[] }> = []
  private readonly commanderQueue: string[]
  private readonly executorQueue: string[]
  private readonly runner: BrowserRunner

  constructor(runner: BrowserRunner, commanderQueue: string[], executorQueue: string[]) {
    this.runner = runner
    this.commanderQueue = commanderQueue
    this.executorQueue = executorQueue
  }

  now(): number {
    return Date.now()
  }

  async sleep(): Promise<void> {}

  async startRole(request: RoleRunRequest): Promise<RoleHandle> {
    this.toolFilters.push({
      role: request.role,
      ...(request.toolFilter?.allow ? { allow: request.toolFilter.allow } : {}),
      ...(request.toolFilter?.deny ? { deny: request.toolFilter.deny } : {}),
    })
    if (request.role === 'commander') {
      const output = this.commanderQueue.shift()
      if (!output) throw new Error('CapabilityHost: commander queue exhausted')
      return {
        childId: `cmd-${this.events.length}`,
        result: Promise.resolve<RoleRunResult>({ output, structured: JSON.parse(output) as unknown, interrupted: false }),
      }
    }
    if (request.role === 'watchdog') {
      return {
        childId: `wd-${this.events.length}`,
        result: Promise.resolve<RoleRunResult>({ output: '{"question":"q"}', structured: { question: 'q' }, interrupted: false }),
      }
    }

    const browserStep =
      request.capabilities?.includes('browser') === true &&
      (!request.toolFilter || (request.toolFilter.allow ?? []).includes('agent_browser'))
    const childId = `exec-${this.events.length}`
    if (!browserStep) {
      this.events.push('browser-unavailable')
      const output = this.executorQueue.shift() ?? 'code step done'
      return { childId, result: Promise.resolve<RoleRunResult>({ output, interrupted: false, childId }) }
    }

    this.events.push('browser-available')
    const context = { sessionId: `orbit-smoke-${process.pid}-${Date.now()}`, cwd: '/tmp' }
    try {
      const open = await this.runner.run({ args: ['open', FIXTURE] }, context)
      assert.equal(open.resultCategory, 'success', open.detail)
      const snapshot = await this.runner.run({ args: ['snapshot', '-i'] }, context)
      assert.equal(snapshot.resultCategory, 'success', snapshot.detail)
      const title = await this.runner.run({ args: ['get', 'title'] }, context)
      assert.match(JSON.stringify(title.data), /SmokeTitle/)
      const text = await this.runner.run({ args: ['get', 'text', 'h1'] }, context)
      assert.match(JSON.stringify(text.data), /Hello/)
      await this.runner.close()
      return { childId, result: Promise.resolve<RoleRunResult>({ output: 'browser smoke ok', interrupted: false, childId }) }
    } catch (error) {
      await this.runner.close()
      return {
        childId,
        result: Promise.resolve<RoleRunResult>({ output: '', interrupted: true, reason: error instanceof Error ? error.message : String(error), childId }),
      }
    }
  }

  async interruptRole(): Promise<void> {}
  async releaseRole(): Promise<void> {}
  hasTool(): boolean {
    return true
  }
  async otherMutationDrivers(): Promise<string[]> {
    return []
  }
  changedFiles(): string[] {
    return []
  }
}

test('Orbit browser integration smoke: P1 no browser, P2 browser, commander/watchdog no browser', { timeout: 180_000 }, async () => {
  assert.ok(agentBrowser && chromium, 'agent-browser and a working chromium are required')
  const dir = mkdtempSync(join(tmpdir(), 'dsh-orbit-browser-'))
  const runner = new BrowserRunner(
    {
      command: 'agent-browser',
      timeoutMs: 90_000,
      maxOutputChars: 20_000,
      maxOutputLines: 400,
      spillDir: join(dir, 'spill'),
      allowedDomains: [],
      ...(chromium ? { executablePath: chromium } : {}),
    },
    { env: { ...process.env } },
  )
  const host = new CapabilityHost(
    runner,
    [
      JSON.stringify({ summary: 's', steps: [{ id: 'P1', goal: 'edit code' }, { id: 'P2', goal: 'verify page', capabilities: ['browser'] }] }),
      JSON.stringify({ decision: 'PASS_CURRENT_STEP' }),
      JSON.stringify({ decision: 'PASS_CURRENT_STEP' }),
      JSON.stringify({ decision: 'SUCCESS' }),
    ],
    ['code step done'],
  )
  const result = await new OrbitSupervisor(new OrbitStateStore(dir), host, config).bootstrap({ goal: 'ship', approved_loop_count: 5 })

  assert.equal(result.phase, 'SUCCESS')
  assert.deepEqual(host.events, ['browser-unavailable', 'browser-available'])

  const p1 = host.toolFilters.find((entry) => entry.role === 'executor')
  assert.ok(!(p1?.allow ?? []).includes('agent_browser'), 'P1 executor must not allow agent_browser')

  const commanderFilters = host.toolFilters.filter((entry) => entry.role === 'commander')
  assert.ok(commanderFilters.length > 0)
  assert.ok(commanderFilters.every((entry) => !(entry.allow ?? []).includes('agent_browser')))

  rmSync(dir, { recursive: true, force: true })
})
