#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

const root = resolve(new URL('..', import.meta.url).pathname)
const version = process.argv[2]
const dryRun = process.argv.includes('--dry-run')

if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) {
  console.error('Usage: node scripts/release-canonical.mjs <version> [--dry-run]')
  process.exit(1)
}

const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
if (pkg.version !== version) {
  console.error(`Release version ${version} does not match package version ${pkg.version}`)
  process.exit(1)
}

const git = (args, options = {}) => {
  const result = execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: options.stdio ?? 'pipe' })
  return typeof result === 'string' ? result.trim() : ''
}

git(['diff', '--check'])
const head = git(['rev-parse', 'HEAD'])
const remoteLine = git(['ls-remote', 'origin', 'refs/heads/main'])
const remoteHead = remoteLine.split(/\s+/u)[0] ?? ''
if (!remoteHead || remoteHead !== head) {
  console.error(`origin/main moved: local base=${head}, remote=${remoteHead || '(missing)'}`)
  process.exit(1)
}

const tag = `v${version}`
const remoteTag = git(['ls-remote', '--tags', 'origin', `refs/tags/${tag}`])
if (remoteTag) {
  console.error(`Remote tag already exists: ${tag}`)
  process.exit(1)
}

const status = git(['status', '--porcelain'])
if (!status) {
  console.error('No release changes to commit.')
  process.exit(1)
}

console.log(`Canonical release preflight OK: ${head} -> ${tag}`)
if (dryRun) process.exit(0)

git(['add', '-A'], { stdio: 'inherit' })
git(['commit', '-m', `Release Orbit ${tag}: persistent role sessions`], { stdio: 'inherit' })
git(['tag', '-a', tag, '-m', `Orbit ${tag}`], { stdio: 'inherit' })
git(['push', 'origin', 'HEAD:main'], { stdio: 'inherit' })
git(['push', 'origin', tag], { stdio: 'inherit' })
console.log(`Published canonical source and tag ${tag}`)
