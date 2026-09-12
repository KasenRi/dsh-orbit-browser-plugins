import { test } from 'node:test'
import assert from 'node:assert/strict'
import { artifactRequestsFromArgs, artifactRequestsFromCompiledSteps, mediaTypeForPath, verifyArtifacts } from '../src/artifacts.ts'

const statOk = async (path: string) => ({ isFile: () => true, size: path.length })
const statMissing = async () => {
  throw new Error('ENOENT')
}

test('extracts screenshot artifact path', () => {
  const requests = artifactRequestsFromArgs(['screenshot', '/tmp/a.png'])
  assert.deepEqual(requests, [{ requestedPath: '/tmp/a.png', kind: 'image' }])
})

test('extracts download path from flag', () => {
  const requests = artifactRequestsFromArgs(['wait', '--download', '/tmp/f.pdf'])
  assert.deepEqual(requests, [{ requestedPath: '/tmp/f.pdf', kind: 'file' }])
})

test('marks recording start as pending', () => {
  const requests = artifactRequestsFromArgs(['record', 'start', '--path', '/tmp/v.webm'])
  assert.equal(requests[0]?.pending, true)
})

test('media type mapping', () => {
  assert.equal(mediaTypeForPath('x.png'), 'image/png')
  assert.equal(mediaTypeForPath('x.pdf'), 'application/pdf')
  assert.equal(mediaTypeForPath('x.unknown'), undefined)
})

test('verifies existing artifact', async () => {
  const report = await verifyArtifacts([{ requestedPath: '/tmp/a.png', kind: 'image' }], '/tmp', statOk)
  assert.equal(report.verified, true)
  assert.equal(report.verifiedCount, 1)
})

test('fails closed on missing artifact', async () => {
  const report = await verifyArtifacts([{ requestedPath: 'a.png', kind: 'image' }], '/tmp', statMissing)
  assert.equal(report.verified, false)
  assert.equal(report.missingCount, 1)
})

test('extracts artifact requests from compiled batch steps', () => {
  const requests = artifactRequestsFromCompiledSteps([
    { action: 'open', args: ['open', 'https://example.com'] },
    { action: 'screenshot', args: ['screenshot', '/tmp/a.png'] },
    { action: 'waitForDownload', args: ['wait', '--download', '/tmp/f.pdf'] },
  ])
  assert.deepEqual(requests, [
    { requestedPath: '/tmp/a.png', kind: 'image' },
    { requestedPath: '/tmp/f.pdf', kind: 'file' },
  ])
})

test('pending artifact is not missing', async () => {
  const report = await verifyArtifacts([{ requestedPath: '/tmp/v.webm', kind: 'video', pending: true }], '/tmp', statMissing)
  assert.equal(report.pendingCount, 1)
  assert.equal(report.missingCount, 0)
})
