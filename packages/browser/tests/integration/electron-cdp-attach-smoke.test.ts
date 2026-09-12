import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { BrowserRunner, type BrowserRunnerConfig } from '../../src/runner.ts'
import { resolveExecutable } from '../../src/cli.ts'
import { findChromium } from '../../../../tests/helpers/chromium.ts'

const chromium = findChromium()

const config: BrowserRunnerConfig = {
  command: 'agent-browser',
  timeoutMs: 60_000,
  maxOutputChars: 20_000,
  maxOutputLines: 400,
  spillDir: '/tmp/dsh-pi-parity-cdp-smoke',
  allowedDomains: [],
  ...(chromium ? { executablePath: chromium } : {}),
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => resolve(port))
    })
    server.on('error', reject)
  })
}

async function waitForDebugPort(port: number, timeoutMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (response.ok) return true
    } catch {
      // not ready yet
    }
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  return false
}

test('CDP attach smoke: electron.connect and electron.probe over a real debug endpoint', { timeout: 180_000 }, async () => {
  assert.ok(chromium, 'a working chromium executable is required')
  assert.ok(resolveExecutable('agent-browser', process.env.PATH), 'agent-browser must be on PATH')

  const port = await freePort()
  let child: ChildProcess | undefined
  const runner = new BrowserRunner(config, { env: { ...process.env } })
  const context = { sessionId: `cdp-${process.pid}-${Date.now()}`, cwd: '/tmp' }

  try {
    child = spawn(
      chromium as string,
      ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', `--remote-debugging-port=${port}`, 'about:blank'],
      { stdio: 'ignore', detached: false },
    )
    const ready = await waitForDebugPort(port)
    assert.ok(ready, `chromium debug port ${port} did not become ready`)

    const connect = await runner.run({ electron: { action: 'connect', port } }, context)
    assert.equal(connect.resultCategory, 'success', connect.detail)
    assert.deepEqual(connect.args, ['connect', String(port)])

    const probe = await runner.run({ electron: { action: 'probe' } }, context)
    assert.equal(probe.resultCategory, 'success', probe.detail)
    assert.match(JSON.stringify(probe.data), /about:blank|tabs/i)
  } finally {
    await runner.close()
    if (child && child.exitCode === null) child.kill('SIGKILL')
  }
})
