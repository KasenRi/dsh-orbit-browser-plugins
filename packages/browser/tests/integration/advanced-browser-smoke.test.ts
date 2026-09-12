import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { existsSync } from 'node:fs'
import { BrowserRunner, type BrowserRunnerConfig } from '../../src/runner.ts'
import { resolveExecutable } from '../../src/cli.ts'

const FIXTURE_HTML = `<!doctype html>
<html>
  <head>
    <title>AdvancedFixture</title>
    <link rel="stylesheet" href="/style.css" />
  </head>
  <body>
    <h1 id="heading">Advanced Fixture</h1>
    <div id="app">
      <div data-source-file="src/app.tsx:10:2">source hint</div>
    </div>
    <button id="change">Change title</button>
    <div id="status">loading</div>
    <script src="/app.js"></script>
  </body>
</html>`

const FIXTURE_JS = `document.getElementById('change').addEventListener('click', () => {
  document.title = 'AdvancedFixtureClicked'
  document.getElementById('heading').textContent = 'Changed'
})
Promise.all([
  fetch('/api/data').then(() => 'ok').catch(() => 'fail'),
  fetch('/api/fail').then(() => 'ok').catch(() => 'fail'),
]).then(() => { document.getElementById('status').textContent = 'Fetched' })`

const FIXTURE_CSS = 'body { font-family: sans-serif; }'

function startFixture(): Promise<{ server: Server; url: string; close: () => Promise<void> }> {
  const server = createServer((request, response) => {
    const path = (request.url ?? '/').split('?')[0]
    if (path === '/') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(FIXTURE_HTML)
      return
    }
    if (path === '/app.js') {
      response.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8' })
      response.end(FIXTURE_JS)
      return
    }
    if (path === '/style.css') {
      response.writeHead(200, { 'content-type': 'text/css; charset=utf-8' })
      response.end(FIXTURE_CSS)
      return
    }
    if (path === '/api/data') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: true }))
      return
    }
    if (path === '/api/fail') {
      response.writeHead(500, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: 'boom' }))
      return
    }
    response.writeHead(404).end()
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      resolve({
        server,
        url: `http://127.0.0.1:${port}/`,
        close: () => new Promise((done) => server.close(() => done())),
      })
    })
  })
}

const chromium =
  process.env.DSH_BROWSER_EXECUTABLE_PATH ??
  ['/root/.cache/ms-playwright/chromium-1228/chrome-linux/chrome', '/root/.cache/ms-playwright/chromium-1223/chrome-linux/chrome'].find((candidate) =>
    existsSync(candidate),
  )

const config: BrowserRunnerConfig = {
  command: 'agent-browser',
  timeoutMs: 90_000,
  maxOutputChars: 40_000,
  maxOutputLines: 800,
  spillDir: '/tmp/dsh-pi-parity-advanced-smoke',
  allowedDomains: [],
  ...(chromium ? { executablePath: chromium } : {}),
}

test('advanced browser smoke: fixture page, summary, source lookup, network lookup, tabs', { timeout: 240_000 }, async () => {
  assert.ok(chromium, 'a working chromium executable is required')
  assert.ok(resolveExecutable('agent-browser', process.env.PATH), 'agent-browser must be on PATH')

  const fixture = await startFixture()
  const runner = new BrowserRunner(config, { env: { ...process.env } })
  const context = { sessionId: `advanced-${process.pid}-${Date.now()}`, cwd: '/tmp' }

  try {
    const open = await runner.run({ args: ['open', fixture.url] }, context)
    assert.equal(open.resultCategory, 'success', open.detail)
    assert.equal(open.pageChangeSummary?.changeType, 'navigation', JSON.stringify(open.pageChangeSummary))

    const wait = await runner.run({ args: ['wait', '1500'] }, context)
    assert.equal(wait.resultCategory, 'success', wait.detail)

    const snapshot = await runner.run({ args: ['snapshot', '-i'] }, context)
    assert.equal(snapshot.resultCategory, 'success', snapshot.detail)
    assert.ok(snapshot.refSnapshot, 'snapshot must record refs')
    const buttonRef = Object.entries(snapshot.refSnapshot?.refs ?? {}).find(([, entry]) => entry.role === 'button')?.[0]
    assert.ok(buttonRef, 'button ref must exist')

    const source = await runner.run({ sourceLookup: { selector: '#app' } }, context)
    assert.equal(source.resultCategory, 'success', source.detail)
    assert.ok((source.sourceLookup?.candidates?.length ?? 0) >= 1, 'source candidate expected')
    assert.ok((source.sourceLookup?.candidates?.length ?? 0) <= 20)
    assert.ok(JSON.stringify(source.sourceLookup).includes('app.tsx'))

    const network = await runner.run({ networkSourceLookup: { filter: '/api/fail' } }, context)
    assert.equal(network.resultCategory, 'success', network.detail)
    assert.ok((network.networkSourceLookup?.failedRequests?.length ?? 0) >= 1, 'failed request expected')
    assert.ok((network.networkSourceLookup?.failedRequests?.length ?? 0) <= 10)

    const click = await runner.run({ args: ['click', `@${buttonRef}`] }, context)
    assert.equal(click.resultCategory, 'success', click.detail)

    const title = await runner.run({ args: ['get', 'title'] }, context)
    assert.equal(title.resultCategory, 'success', title.detail)
    assert.equal(title.pageChangeSummary?.titleChanged, true, JSON.stringify(title.pageChangeSummary))
    assert.match(JSON.stringify(title.data), /AdvancedFixtureClicked/)

    const tabs = await runner.run({ args: ['tab', 'list'] }, context)
    assert.equal(tabs.resultCategory, 'success', tabs.detail)

    await runner.close()
  } finally {
    await runner.close()
    await fixture.close()
  }
})
