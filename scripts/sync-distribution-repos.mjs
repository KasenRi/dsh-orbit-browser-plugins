#!/usr/bin/env node

import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

const root = resolve(new URL('..', import.meta.url).pathname)
const version = process.argv[2]
const push = process.argv.includes('--push')

if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) {
  console.error('Usage: node scripts/sync-distribution-repos.mjs <release-version> [--push]')
  process.exit(1)
}

const sourceRepo = 'https://github.com/KasenRi/dsh-orbit-browser-plugins'
const rootPackage = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
if (rootPackage.version !== version) {
  console.error(`Release version ${version} does not match root package version ${rootPackage.version}`)
  process.exit(1)
}
const mirrors = [
  { packageDir: 'packages/orbit', repo: 'KasenRi/dsh-orbit', title: 'Orbit' },
  { packageDir: 'packages/browser', repo: 'KasenRi/dsh-browser', title: 'Browser' },
]
const stagingRoot = resolve('/tmp/opencode/dsh-distribution-sync', version)

rmSync(stagingRoot, { recursive: true, force: true })
mkdirSync(stagingRoot, { recursive: true })

for (const mirror of mirrors) {
  const source = join(root, mirror.packageDir)
  const target = join(stagingRoot, mirror.title.toLowerCase())
  const worktree = push ? join(stagingRoot, `${mirror.title.toLowerCase()}-repo`) : target
  if (push) {
    execFileSync('git', ['clone', '--depth', '1', `https://github.com/${mirror.repo}.git`, worktree], { stdio: 'inherit' })
    execFileSync('git', ['-C', worktree, 'fetch', '--tags', '--quiet'], { stdio: 'inherit' })
    for (const entry of execFileSync('git', ['-C', worktree, 'ls-files', '-z'], { encoding: 'utf8' }).split('\0')) {
      if (entry) rmSync(join(worktree, entry), { force: true, recursive: true })
    }
    mkdirSync(worktree, { recursive: true })
  } else {
    mkdirSync(worktree, { recursive: true })
  }

  for (const file of ['package.json', 'cordis.patch.yml', 'README.md', 'LICENSE']) {
    cpSync(join(source, file), join(worktree, file))
  }
  cpSync(join(source, 'lib'), join(worktree, 'lib'), { recursive: true })

  const packageJson = JSON.parse(readFileSync(join(worktree, 'package.json'), 'utf8'))

  const originalReadme = readFileSync(join(worktree, 'README.md'), 'utf8')
  const notice = [
    `> This repository is an installable release mirror for ${packageJson.name} ${packageJson.version}.`,
    `> Canonical source: ${sourceRepo}/tree/main/${mirror.packageDir}`,
    '> Do not develop features here; publish changes from the canonical source monorepo.',
    '',
  ].join('\n')
  const install = [
    '## Install',
    '',
    'Install the current stable Git source so DSH can compare the locked commit with repository `HEAD`:',
    '',
    '```bash',
    `dsh plugin --profile web add github:${mirror.repo}`,
    '```',
    '',
    'The canonical source monorepo also keeps versioned GitHub Release tarballs for manual or offline installation.',
    '',
  ].join('\n')
  const withoutInstall = originalReadme.replace(/## Install\n[\s\S]*?\n## Usage\n/, '## Usage\n')
  const readme = withoutInstall.replace(/^# [^\n]+\n\n/, (heading) => `${heading}${notice}`)
    .replace('## Usage\n', `${install}\n## Usage\n`)
  writeFileSync(join(worktree, 'README.md'), readme)

  if (push) {
    const changes = execFileSync('git', ['-C', worktree, 'status', '--short'], { encoding: 'utf8' })
    if (changes.trim()) {
      execFileSync('git', ['-C', worktree, 'add', '-A'], { stdio: 'inherit' })
      execFileSync('git', ['-C', worktree, 'commit', '-m', `Release ${mirror.title} v${packageJson.version}`], { stdio: 'inherit' })
      execFileSync('git', ['-C', worktree, 'push', 'origin', 'main'], { stdio: 'inherit' })
    }
    const tag = `v${packageJson.version}`
    const tagExists = execFileSync('git', ['-C', worktree, 'tag', '--list', tag], { encoding: 'utf8' }).trim() !== ''
    if (!tagExists) {
      execFileSync('git', ['-C', worktree, 'tag', '-a', tag, '-m', `${mirror.title} ${tag}`], { stdio: 'inherit' })
      execFileSync('git', ['-C', worktree, 'push', 'origin', tag], { stdio: 'inherit' })
    }
  }
}

console.log(`${push ? 'Synced' : 'Prepared'} distribution mirrors for v${version} in ${stagingRoot}`)
for (const mirror of mirrors) console.log(`  ${mirror.repo}: ${join(stagingRoot, mirror.title.toLowerCase())}`)
