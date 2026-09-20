import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OrbitMoaAdapter } from '../src/moa-adapter.ts'

function project(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-orbit-moa-adapter-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

function candidateRoot(workspace: string): string {
  return join(workspace, '.cx', 'moa', 'run1', 'P0', 'candidate-1')
}

test('MoA promotion is deterministic and idempotent', async () => {
  const { dir, cleanup } = project()
  const root = candidateRoot(dir)
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'result.txt'), 'winner\n')
  const adapter = new OrbitMoaAdapter({} as never)

  const first = await adapter.promote({ workspace: dir, runId: 'run1', stepId: 'P0', winningCandidate: 1 })
  const second = await adapter.promote({ workspace: dir, runId: 'run1', stepId: 'P0', winningCandidate: 1 })

  assert.equal(readFileSync(join(dir, 'result.txt'), 'utf8'), 'winner\n')
  assert.deepEqual(second, first)
  assert.equal(first.files.length, 1)
  assert.equal(first.files[0]?.candidate_sha256, first.files[0]?.promoted_sha256)
  cleanup()
})

test('MoA promotion refuses an existing symlink path that could escape the workspace', async () => {
  const { dir, cleanup } = project()
  const outside = mkdtempSync(join(tmpdir(), 'dsh-orbit-moa-outside-'))
  const root = join(candidateRoot(dir), 'linked')
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'escape.txt'), 'blocked\n')
  symlinkSync(outside, join(dir, 'linked'))
  const adapter = new OrbitMoaAdapter({} as never)

  await assert.rejects(
    adapter.promote({ workspace: dir, runId: 'run1', stepId: 'P0', winningCandidate: 1 }),
    /ORBIT_MOA_PROMOTION_SYMLINK/,
  )
  assert.throws(() => readFileSync(join(outside, 'escape.txt'), 'utf8'))
  cleanup()
  rmSync(outside, { recursive: true, force: true })
})

test('MoA promotion refuses internal control directories', async () => {
  const { dir, cleanup } = project()
  const root = join(candidateRoot(dir), '.git')
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'config'), 'bad\n')
  const adapter = new OrbitMoaAdapter({} as never)

  await assert.rejects(
    adapter.promote({ workspace: dir, runId: 'run1', stepId: 'P0', winningCandidate: 1 }),
    /ORBIT_MOA_PROMOTION_PATH_INVALID/,
  )
  cleanup()
})
