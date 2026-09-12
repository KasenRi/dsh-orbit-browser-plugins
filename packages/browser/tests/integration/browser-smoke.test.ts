import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BrowserRunner, type BrowserRunnerConfig } from '../../src/runner.ts'
import { resolveExecutable } from '../../src/cli.ts'
import { findChromium } from '../../../../tests/helpers/chromium.ts'

const chromium = findChromium()
const agentBrowser = resolveExecutable('agent-browser', process.env.PATH)

const config: BrowserRunnerConfig = {
  command: 'agent-browser',
  timeoutMs: 90_000,
  maxOutputChars: 20_000,
  maxOutputLines: 400,
  spillDir: '/tmp/dsh-pi-parity-browser-smoke',
  allowedDomains: [],
  ...(chromium ? { executablePath: chromium } : {}),
}

const FIXTURE =
  'data:text/html,<html><head><title>SmokeTitle</title></head><body>' +
  '<h1>Hello</h1><button id="b">Go</button><input id="i" placeholder="Name"></body></html>'

test('real chromium smoke: open, snapshot, title, text, click, close', { timeout: 180_000 }, async () => {
  assert.ok(agentBrowser, 'agent-browser must be on PATH')
  assert.ok(chromium, 'a working chromium executable must be available')

  const runner = new BrowserRunner(config, { env: { ...process.env, AGENT_BROWSER_EXECUTABLE_PATH: chromium } })
  const context = { sessionId: `smoke-${process.pid}-${Date.now()}`, cwd: '/tmp' }

  const open = await runner.run({ args: ['open', FIXTURE] }, context)
  assert.equal(open.resultCategory, 'success', open.detail)
  assert.equal(open.usedImplicitSession, true)

  const snapshot = await runner.run({ args: ['snapshot', '-i'] }, context)
  assert.equal(snapshot.resultCategory, 'success', snapshot.detail)
  assert.ok(snapshot.refSnapshot, 'snapshot should record refs')
  assert.ok(
    Object.values(snapshot.refSnapshot?.refs ?? {}).some((entry) => entry.role === 'button'),
    'snapshot should contain the button ref',
  )

  const title = await runner.run({ args: ['get', 'title'] }, context)
  assert.equal(title.resultCategory, 'success', title.detail)
  assert.match(JSON.stringify(title.data), /SmokeTitle/)

  const text = await runner.run({ args: ['get', 'text', 'h1'] }, context)
  assert.equal(text.resultCategory, 'success', text.detail)
  assert.match(JSON.stringify(text.data), /Hello/)

  const buttonRef = Object.entries(snapshot.refSnapshot?.refs ?? {}).find(([, entry]) => entry.role === 'button')?.[0]
  assert.ok(buttonRef, 'button ref id must exist')
  const click = await runner.run({ args: ['click', `@${buttonRef}`] }, context)
  assert.equal(click.resultCategory, 'success', click.detail)

  await runner.close()
})
