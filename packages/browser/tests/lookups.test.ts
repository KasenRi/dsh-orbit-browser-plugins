import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  analyzeNetworkSourceLookup,
  analyzeSourceLookup,
  analyzeSourceLookupFromHtml,
  compileNetworkSourceLookup,
  compileSourceLookup,
} from '../src/lookups.ts'

function tempWorkspace(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-lookup-test-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('selector sourceLookup compiles to a bounded batch', () => {
  const compiled = compileSourceLookup({ selector: '#app' })
  assert.equal(compiled.ok, true)
  if (!compiled.ok) return
  assert.deepEqual(compiled.args, ['batch'])
  assert.deepEqual(compiled.steps.map((step) => step.args), [
    ['is', 'visible', '#app'],
    ['get', 'html', '#app'],
  ])
  assert.equal(compiled.query.selector, '#app')
  assert.equal(compiled.query.maxWorkspaceFiles, 500)
})

test('react fiber and component name sourceLookup compile', () => {
  const fiber = compileSourceLookup({ reactFiberId: '7' })
  assert.equal(fiber.ok, true)
  if (fiber.ok) assert.deepEqual(fiber.steps.map((step) => step.args), [['react', 'inspect', '7']])

  const component = compileSourceLookup({ componentName: 'Dashboard' })
  assert.equal(component.ok, true)
  if (component.ok) {
    assert.deepEqual(component.steps.map((step) => step.args), [['react', 'tree']])
    assert.equal(component.query.componentName, 'Dashboard')
  }
})

test('sourceLookup validation rejects malformed input', () => {
  assert.equal(compileSourceLookup({}).ok, false)
  assert.equal(compileSourceLookup({ selector: '  ' }).ok, false)
  assert.equal(compileSourceLookup({ selector: '#a', includeDomHints: 'yes' as never }).ok, false)
  assert.equal(compileSourceLookup({ selector: '#a', maxWorkspaceFiles: 0 }).ok, false)
  assert.equal(compileSourceLookup({ selector: '#a', maxWorkspaceFiles: 5000 }).ok, false)
})

test('HTML source hints are extracted with line and column', () => {
  const analysis = analyzeSourceLookupFromHtml('<div data-source-file="src/app.tsx:10:2">x</div>')
  assert.equal(analysis.status, 'candidates-found')
  assert.equal(analysis.candidates?.[0]?.file, 'src/app.tsx')
  assert.equal(analysis.candidates?.[0]?.line, 10)
  assert.equal(analysis.candidates?.[0]?.column, 2)
  assert.ok((analysis.candidates?.[0]?.evidence.length ?? 0) > 0)
})

test('sourceLookup extracts candidates from batch react/dom results', async () => {
  const data = [
    { command: ['react', 'inspect', '7'], success: true, result: { source: '/src/components/Widget.tsx:22:5' } },
    { command: ['get', 'html', '#app'], success: true, result: '<div data-source-file="src/App.tsx"></div>' },
  ]
  const analysis = await analyzeSourceLookup(data, { maxWorkspaceFiles: 10 }, tmpdir())
  assert.equal(analysis.status, 'candidates-found')
  const sources = analysis.candidates?.map((candidate) => candidate.source) ?? []
  assert.ok(sources.includes('react-inspect'))
  assert.ok(sources.includes('dom-html'))
})

test('sourceLookup workspace scan finds a component declaration', async () => {
  const workspace = tempWorkspace()
  mkdirSync(join(workspace.dir, 'src'), { recursive: true })
  writeFileSync(join(workspace.dir, 'src', 'App.tsx'), 'export function Dashboard() {\n  return null\n}\n', 'utf8')
  const analysis = await analyzeSourceLookup([], { componentName: 'Dashboard', maxWorkspaceFiles: 100 }, workspace.dir)
  const candidate = analysis.candidates?.find((entry) => entry.source === 'workspace-search')
  assert.ok(candidate, 'workspace candidate expected')
  assert.ok(candidate.file?.endsWith('App.tsx'))
  assert.equal(candidate.line, 1)
  workspace.cleanup()
})

test('sourceLookup skips ignored directories', async () => {
  const workspace = tempWorkspace()
  mkdirSync(join(workspace.dir, 'node_modules', 'pkg'), { recursive: true })
  mkdirSync(join(workspace.dir, 'src'), { recursive: true })
  writeFileSync(join(workspace.dir, 'node_modules', 'pkg', 'Ghost.tsx'), 'export function Ghost() {}\n', 'utf8')
  writeFileSync(join(workspace.dir, 'src', 'Ghost.tsx'), 'export function Ghost() {}\n', 'utf8')
  const analysis = await analyzeSourceLookup([], { componentName: 'Ghost', maxWorkspaceFiles: 100 }, workspace.dir)
  const files = analysis.candidates?.map((candidate) => candidate.file ?? '') ?? []
  assert.ok(files.length >= 1)
  assert.ok(files.every((file) => !file.includes('node_modules')))
  workspace.cleanup()
})

test('sourceLookup candidate count is bounded to 20', () => {
  const html = Array.from({ length: 40 }, (_, index) => `<div data-source-file="src/File${index}.tsx"></div>`).join('')
  const analysis = analyzeSourceLookupFromHtml(html)
  assert.ok((analysis.candidates?.length ?? 0) <= 20)
})

test('networkSourceLookup compiles requestId, filter, and url modes', () => {
  const requestId = compileNetworkSourceLookup({ requestId: 'r1' })
  assert.equal(requestId.ok, true)
  if (requestId.ok) assert.deepEqual(requestId.steps.map((step) => step.args), [['network', 'request', 'r1']])

  const filter = compileNetworkSourceLookup({ filter: '/api/' })
  assert.equal(filter.ok, true)
  if (filter.ok) assert.deepEqual(filter.steps.map((step) => step.args), [['network', 'requests', '--filter', '/api/']])

  const url = compileNetworkSourceLookup({ url: 'https://api.test/missing' })
  assert.equal(url.ok, true)
  if (url.ok) assert.deepEqual(url.steps.map((step) => step.args), [['network', 'requests', '--filter', 'https://api.test/missing']])

  assert.equal(compileNetworkSourceLookup({}).ok, false)
  assert.equal(compileNetworkSourceLookup({ filter: '' }).ok, false)
  assert.equal(compileNetworkSourceLookup({ requestId: 'r1', maxWorkspaceFiles: -1 }).ok, false)
})

test('networkSourceLookup finds failed requests and redacts secrets', async () => {
  const data = [
    {
      command: ['network', 'requests'],
      success: true,
      result: {
        requests: [
          { id: 'r1', url: 'https://api.test/missing?token=SUPERSECRET', status: 500, method: 'POST' },
          { id: 'r2', url: 'https://api.test/ok', status: 200, method: 'GET' },
        ],
      },
    },
  ]
  const analysis = await analyzeNetworkSourceLookup(data, { url: 'https://api.test/missing' }, tmpdir())
  assert.equal(analysis.status, 'no-candidates')
  assert.equal(analysis.failedRequests?.length, 1)
  const failed = analysis.failedRequests?.[0]
  assert.equal(failed?.requestId, 'r1')
  assert.equal(failed?.status, 500)
  const serialized = JSON.stringify(analysis)
  assert.ok(!serialized.includes('SUPERSECRET'))
  assert.ok(serialized.includes('REDACTED'))
})

test('networkSourceLookup bounds failed requests and extracts initiator candidates', async () => {
  const requests = Array.from({ length: 15 }, (_, index) => ({
    id: `r${index}`,
    url: `https://api.test/fail/${index}`,
    status: 500,
    initiator: 'at fetch (/src/api/client.ts:12:3)',
  }))
  const data = [{ command: ['network', 'requests'], success: true, result: { requests } }]
  const analysis = await analyzeNetworkSourceLookup(data, {}, tmpdir())
  assert.equal(analysis.status, 'failed-requests-found')
  assert.ok((analysis.failedRequests?.length ?? 0) <= 10)
  const initiator = analysis.candidates?.find((candidate) => candidate.source === 'initiator')
  assert.ok(initiator, 'initiator candidate expected')
  assert.equal(initiator.file, '/src/api/client.ts')
})

test('networkSourceLookup matches workspace URL literals', async () => {
  const workspace = tempWorkspace()
  mkdirSync(join(workspace.dir, 'src'), { recursive: true })
  writeFileSync(join(workspace.dir, 'src', 'api.ts'), 'export const failUrl = "/api/fail"\n', 'utf8')
  const data = [{ command: ['network', 'requests'], success: true, result: { requests: [{ id: 'r1', url: 'https://server.test/api/fail', status: 404 }] } }]
  const analysis = await analyzeNetworkSourceLookup(data, { filter: '/api/fail', maxWorkspaceFiles: 100 }, workspace.dir)
  const candidate = analysis.candidates?.find((entry) => entry.source === 'workspace-search')
  assert.ok(candidate, 'workspace candidate expected')
  assert.ok(candidate.file?.endsWith('api.ts'))
  workspace.cleanup()
})

test('networkSourceLookup reports no failed requests cleanly', async () => {
  const analysis = await analyzeNetworkSourceLookup([], {}, tmpdir())
  assert.equal(analysis.status, 'no-failed-requests')
  assert.deepEqual(analysis.failedRequests, [])
  assert.equal(analysis.candidates?.length ?? 0, 0)
})
