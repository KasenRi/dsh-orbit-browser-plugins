import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BrowserRunner, type BrowserRunnerConfig } from '../src/runner.ts'
import type { CommandExecutor } from '../src/cli.ts'

const config: BrowserRunnerConfig = {
  command: 'agent-browser',
  timeoutMs: 5000,
  maxOutputChars: 8000,
  maxOutputLines: 120,
  spillDir: '/tmp/dsh-pi-parity-test-spill',
  allowedDomains: [],
}

const context = { sessionId: '12345678-1234-1234-1234-1234567890ab', cwd: '/tmp/dsh-pi-parity-demo' }

function envelope(data: unknown, success = true): string {
  return JSON.stringify({ success, data })
}

function fakeExecutor(handler: (args: readonly string[]) => { stdout: string; code?: number; stderr?: string; timedOut?: boolean }): CommandExecutor {
  return async (_command, args) => {
    const result = handler(args)
    return {
      stdout: result.stdout,
      stderr: result.stderr ?? '',
      code: result.code ?? 0,
      timedOut: result.timedOut ?? false,
      killedBySignal: false,
    }
  }
}

test('successful open returns success and records session', async () => {
  const runner = new BrowserRunner(config, {
    executor: fakeExecutor(() => ({ stdout: envelope({ origin: 'https://example.com', title: 'Example' }) })),
  })
  const result = await runner.run({ args: ['open', 'https://example.com'] }, context)
  assert.equal(result.resultCategory, 'success')
  assert.equal(result.usedImplicitSession, true)
})

test('snapshot then ref click is allowed', async () => {
  const executor = fakeExecutor((args) => {
    if (args.includes('snapshot')) {
      return { stdout: envelope({ origin: 'https://example.com', refs: { e1: { role: 'button' } } }) }
    }
    return { stdout: envelope({ ok: true }) }
  })
  const runner = new BrowserRunner(config, { executor })
  await runner.run({ args: ['snapshot', '-i'] }, context)
  const click = await runner.run({ args: ['click', '@e1'] }, context)
  assert.equal(click.resultCategory, 'success')
})

test('ref click without snapshot is blocked and never spawns', async () => {
  let spawned = 0
  const runner = new BrowserRunner(config, {
    executor: fakeExecutor(() => {
      spawned += 1
      return { stdout: envelope({ ok: true }) }
    }),
  })
  const result = await runner.run({ args: ['click', '@e1'] }, context)
  assert.equal(result.resultCategory, 'failure')
  assert.equal(result.failureCategory, 'stale-ref')
  assert.equal(spawned, 0)
})

test('timeout classified', async () => {
  const runner = new BrowserRunner(config, {
    executor: fakeExecutor(() => ({ stdout: '', timedOut: true, code: 124 })),
  })
  const result = await runner.run({ args: ['open', 'https://example.com'] }, context)
  assert.equal(result.failureCategory, 'timeout')
})

test('missing binary classified', async () => {
  const runner = new BrowserRunner(config, {
    executor: fakeExecutor(() => ({ stdout: '', code: 127 })),
  })
  const result = await runner.run({ args: ['open', 'https://example.com'] }, context)
  assert.equal(result.failureCategory, 'missing-binary')
})

test('protected state operand is policy-blocked before spawn', async () => {
  let spawned = 0
  const runner = new BrowserRunner(config, {
    executor: fakeExecutor(() => {
      spawned += 1
      return { stdout: envelope({}) }
    }),
  })
  const result = await runner.run({ args: ['open', '/tmp/protected/.agent-browser/state.json'] }, context)
  assert.equal(result.failureCategory, 'policy-blocked')
  assert.equal(spawned, 0)
})

test('allowed domain violation is policy-blocked', async () => {
  const runner = new BrowserRunner({ ...config, allowedDomains: ['example.com'] }, {
    executor: fakeExecutor((args) => {
      if (args[0] === 'open') return { stdout: envelope({ origin: 'https://evil.test' }) }
      return { stdout: envelope({}) }
    }),
  })
  const result = await runner.run({ args: ['open', 'https://evil.test'] }, context)
  assert.equal(result.failureCategory, 'policy-blocked')
})

test('artifact missing fails closed', async () => {
  const runner = new BrowserRunner(config, {
    executor: fakeExecutor(() => ({ stdout: envelope({ saved: true }) })),
    statFn: async () => {
      throw new Error('ENOENT')
    },
  })
  const result = await runner.run({ args: ['screenshot', '/tmp/x.png'] }, context)
  assert.equal(result.failureCategory, 'artifact-missing')
})

test('large output is spilled', async () => {
  const runner = new BrowserRunner({ ...config, maxOutputChars: 10, maxOutputLines: 2 }, {
    executor: fakeExecutor(() => ({ stdout: envelope({ blob: 'x'.repeat(5000) }) })),
  })
  const result = await runner.run({ args: ['snapshot', '-i'] }, context)
  assert.equal(result.resultCategory, 'success')
  assert.ok(result.fullOutputPath)
})

test('outputPath is written atomically as 0600 and reported', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-browser-out-'))
  const runner = new BrowserRunner(config, {
    executor: fakeExecutor(() => ({ stdout: envelope({ title: 'Written', cookie: 'c' }) })),
  })
  const result = await runner.run(
    { args: ['get', 'title'], outputPath: join(dir, 'nested', 'out.json') },
    context,
  )
  assert.equal(result.resultCategory, 'success', result.detail)
  const target = join(dir, 'nested', 'out.json')
  assert.equal(result.outputFile, target)
  const written = JSON.parse(readFileSync(target, 'utf8')) as Record<string, unknown>
  assert.equal(written['title'], 'Written')
  assert.equal(written['cookie'], '[REDACTED]')
  assert.equal(statSync(target).mode & 0o777, 0o600)
  rmSync(dir, { recursive: true, force: true })
})

test('job screenshot artifact is independently verified', async () => {
  const runner = new BrowserRunner(config, {
    executor: fakeExecutor(() => ({ stdout: envelope([{ success: true }]) })),
    statFn: async () => ({ isFile: () => true, size: 42 }),
  })
  const result = await runner.run(
    {
      job: {
        steps: [
          { action: 'open', url: 'https://example.com' },
          { action: 'screenshot', path: '/tmp/job.png' },
        ],
      },
    },
    context,
  )
  assert.equal(result.resultCategory, 'success', result.detail)
  assert.equal(result.successCategory, 'artifact-saved')
  assert.equal(result.artifactVerification?.verified, true)
})

test('job screenshot missing fails closed', async () => {
  const runner = new BrowserRunner(config, {
    executor: fakeExecutor(() => ({ stdout: envelope([{ success: true }]) })),
    statFn: async () => {
      throw new Error('ENOENT')
    },
  })
  const result = await runner.run(
    { job: { steps: [{ action: 'screenshot', path: '/tmp/missing.png' }] } },
    context,
  )
  assert.equal(result.failureCategory, 'artifact-missing')
})

test('allowed domains are enforced before navigation', async () => {
  let spawned = 0
  const runner = new BrowserRunner({ ...config, allowedDomains: ['example.com'] }, {
    executor: fakeExecutor(() => {
      spawned += 1
      return { stdout: envelope({}) }
    }),
  })
  const result = await runner.run({ args: ['open', 'https://evil.test'] }, context)
  assert.equal(result.failureCategory, 'policy-blocked')
  assert.equal(spawned, 0)
})

test('allowed domains inject the upstream containment flag on a fresh context', async () => {
  const argvSeen: string[][] = []
  const executor: CommandExecutor = async (_command, args) => {
    argvSeen.push([...args])
    return { stdout: envelope({ origin: 'https://example.com' }), stderr: '', code: 0, timedOut: false, killedBySignal: false }
  }
  const runner = new BrowserRunner({ ...config, allowedDomains: ['example.com'] }, { executor })
  const result = await runner.run({ args: ['open', 'https://example.com'] }, context)
  assert.equal(result.resultCategory, 'success', result.detail)
  const argv = argvSeen[0] ?? []
  assert.ok(argv.includes('--allowed-domains'))
  assert.ok(argv.includes('example.com'))
  assert.ok(result.sessionName?.includes('-fresh-'))
})

test('args + stdin is forwarded to the child process', async () => {
  let stdinSeen: string | undefined
  const executor: CommandExecutor = async (_command, _args, options) => {
    stdinSeen = options.input
    return { stdout: envelope([{ success: true }]), stderr: '', code: 0, timedOut: false, killedBySignal: false }
  }
  const runner = new BrowserRunner(config, { executor })
  const result = await runner.run({ args: ['batch'], stdin: '[["snapshot"]]' }, context)
  assert.equal(result.resultCategory, 'success', result.detail)
  assert.equal(stdinSeen, '[["snapshot"]]')
})

function routedExecutor(handler: (args: readonly string[]) => unknown): { executor: CommandExecutor; argvSeen: string[][] } {
  const argvSeen: string[][] = []
  const executor: CommandExecutor = async (_command, args) => {
    argvSeen.push([...args])
    return { stdout: envelope(handler(args)), stderr: '', code: 0, timedOut: false, killedBySignal: false }
  }
  return { executor, argvSeen }
}

test('runner recovers a unique prior tab and reports recovery', async () => {
  const { executor, argvSeen } = routedExecutor((args) => {
    if (args.includes('open')) return { origin: 'https://a.test/', title: 'A' }
    if (args.includes('get') && args.includes('url')) return { url: 'https://b.test/' }
    if (args.includes('tab') && args.includes('list')) {
      return {
        tabs: [
          { active: true, tabId: 't2', title: 'B', url: 'https://b.test/' },
          { active: false, tabId: 't1', title: 'A', url: 'https://a.test/' },
        ],
      }
    }
    if (args.includes('tab') && args.includes('t1')) return { switched: true }
    return {}
  })
  const runner = new BrowserRunner(config, { executor })
  await runner.run({ args: ['open', 'https://a.test/'] }, context)
  const drifted = await runner.run({ args: ['get', 'url'] }, context)

  assert.equal(drifted.resultCategory, 'success', drifted.detail)
  assert.equal(drifted.pageChangeSummary?.recoveryApplied, true)
  assert.equal(drifted.pageChangeSummary?.changeType, 'recovery')
  assert.deepEqual(drifted.nextActions, ['refresh-interactive-refs'])
  assert.ok(argvSeen.some((argv) => argv.includes('tab') && argv.includes('list')))
  assert.ok(argvSeen.some((argv) => argv.includes('t1')))
})

test('runner rejects ambiguous tab recovery and invalidates refs', async () => {
  const executor = fakeExecutor((args) => {
    if (args.includes('open')) return { stdout: envelope({ origin: 'https://a.test/', title: 'A' }) }
    if (args.includes('snapshot')) {
      return { stdout: envelope({ origin: 'https://a.test/', refs: { e1: { role: 'button', name: 'X' } }, snapshot: '- button "X" [ref=e1]' }) }
    }
    if (args.includes('get') && args.includes('url')) return { stdout: envelope({ url: 'https://b.test/' }) }
    if (args.includes('tab') && args.includes('list')) return { stdout: envelope({ tabs: [{ active: true, tabId: 't9', url: 'https://b.test/' }] }) }
    return { stdout: envelope({}) }
  })
  const runner = new BrowserRunner(config, { executor })
  await runner.run({ args: ['open', 'https://a.test/'] }, context)
  const snapshot = await runner.run({ args: ['snapshot', '-i'] }, context)
  assert.equal(snapshot.resultCategory, 'success', snapshot.detail)
  assert.ok(snapshot.refSnapshot, 'refs must be saved before the drift')

  const drifted = await runner.run({ args: ['get', 'url'] }, context)
  assert.equal(drifted.resultCategory, 'failure')
  assert.equal(drifted.failureCategory, 'tab-drift')
  assert.deepEqual(drifted.nextActions, ['list-tabs-for-tab-drift-recovery', 'refresh-interactive-refs'])

  const click = await runner.run({ args: ['click', '@e1'] }, context)
  assert.equal(click.failureCategory, 'stale-ref')
})

test('drifted snapshot refs are not adopted even after recovery', async () => {
  const { executor } = routedExecutor((args) => {
    if (args.includes('open')) return { origin: 'https://a.test/', title: 'A' }
    if (args.includes('snapshot')) {
      return { origin: 'https://b.test/', refs: { e1: { role: 'button', name: 'Drifted' } }, snapshot: '- button "Drifted" [ref=e1]' }
    }
    if (args.includes('tab') && args.includes('list')) return { tabs: [{ active: false, tabId: 't1', url: 'https://a.test/' }] }
    if (args.includes('tab') && args.includes('t1')) return { switched: true }
    return {}
  })
  const runner = new BrowserRunner(config, { executor })
  await runner.run({ args: ['open', 'https://a.test/'] }, context)

  const snapshot = await runner.run({ args: ['snapshot', '-i'] }, context)
  assert.equal(snapshot.resultCategory, 'success', snapshot.detail)
  assert.equal(snapshot.refSnapshot, undefined, 'drifted snapshot refs must not be adopted')
  assert.equal(snapshot.pageChangeSummary?.recoveryApplied, true)

  const click = await runner.run({ args: ['click', '@e1'] }, context)
  assert.equal(click.failureCategory, 'stale-ref')
})

test('electron and raw connect are policy-blocked when allowedDomains is active', async () => {
  let spawned = 0
  const executor: CommandExecutor = async () => {
    spawned += 1
    return { stdout: envelope({}), stderr: '', code: 0, timedOut: false, killedBySignal: false }
  }
  const runner = new BrowserRunner({ ...config, allowedDomains: ['example.com'] }, { executor })

  const electron = await runner.run({ electron: { action: 'connect', port: 9222 } }, context)
  assert.equal(electron.failureCategory, 'policy-blocked')

  const raw = await runner.run({ args: ['connect', '9222'] }, context)
  assert.equal(raw.failureCategory, 'policy-blocked')

  assert.equal(spawned, 0)
})

test('sourceLookup runner integration attaches bounded candidates', async () => {
  const executor = fakeExecutor(() => ({
    stdout: envelope([
      { command: ['get', 'html', '#app'], success: true, result: '<div data-source-file="src/App.tsx:3:1"></div>' },
    ]),
  }))
  const runner = new BrowserRunner(config, { executor })
  const result = await runner.run({ sourceLookup: { selector: '#app' } }, context)
  assert.equal(result.resultCategory, 'success', result.detail)
  assert.equal(result.sourceLookup?.status, 'candidates-found')
  assert.ok((result.sourceLookup?.candidates?.length ?? 0) >= 1)
  assert.ok((result.sourceLookup?.candidates?.length ?? 0) <= 20)
  assert.ok(!JSON.stringify(result).includes('undefined'))
})

test('networkSourceLookup runner integration attaches redacted failed requests', async () => {
  const executor = fakeExecutor(() => ({
    stdout: envelope([
      {
        command: ['network', 'requests'],
        success: true,
        result: { requests: [{ id: 'r1', url: 'https://api.test/fail?token=SUPERSECRET', status: 500, method: 'GET' }] },
      },
    ]),
  }))
  const runner = new BrowserRunner(config, { executor })
  const result = await runner.run({ networkSourceLookup: { filter: '/fail' } }, context)
  assert.equal(result.resultCategory, 'success', result.detail)
  assert.equal(result.networkSourceLookup?.failedRequests?.length, 1)
  assert.ok(!JSON.stringify(result).includes('SUPERSECRET'))
  assert.ok(JSON.stringify(result).includes('[REDACTED]'))
})
