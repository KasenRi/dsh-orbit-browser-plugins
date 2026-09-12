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

const context = { sessionId: '12345678-1234-1234-1234-1234567890ab', cwd: '/root/code/demo' }

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
  const result = await runner.run({ args: ['open', '/root/.agent-browser/state.json'] }, context)
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
