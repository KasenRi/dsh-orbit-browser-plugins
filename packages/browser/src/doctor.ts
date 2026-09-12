import type { CommandExecutor } from './cli.ts'

export const TESTED_AGENT_BROWSER_VERSION = '0.33.2'
export const MINIMUM_NODE_MAJOR = 22

export interface DoctorCheck {
  name: string
  status: 'pass' | 'warn' | 'fail'
  detail: string
}

export interface DoctorReport {
  status: 'pass' | 'warn' | 'fail'
  generatedAt: string
  checks: DoctorCheck[]
}

export interface DoctorOptions {
  executable?: string
  cwd: string
  env: NodeJS.ProcessEnv
  executor: CommandExecutor
  timeoutMs?: number
}

export function normalizeAgentBrowserVersion(raw: string): string | undefined {
  const match = /(\d+)\.(\d+)\.(\d+)(?:\b|[-+])/.exec(raw)
  if (!match) return undefined
  return `${match[1]}.${match[2]}.${match[3]}`
}

export async function runDoctor(options: DoctorOptions): Promise<DoctorReport> {
  const checks: DoctorCheck[] = []
  const nodeMajor = Number(process.versions.node.split('.')[0])
  checks.push({
    name: 'node',
    status: nodeMajor >= MINIMUM_NODE_MAJOR ? 'pass' : 'warn',
    detail: `node ${process.versions.node}`,
  })

  if (!options.executable) {
    checks.push({ name: 'agent-browser', status: 'fail', detail: 'agent-browser is not installed or not on PATH.' })
    return finalize(checks)
  }

  let versionRaw = ''
  try {
    const result = await options.executor(options.executable, ['--version'], {
      cwd: options.cwd,
      timeoutMs: options.timeoutMs ?? 10_000,
      env: options.env,
    })
    versionRaw = `${result.stdout}\n${result.stderr}`.trim()
  } catch (error) {
    checks.push({ name: 'agent-browser-version', status: 'fail', detail: `failed to run agent-browser: ${String(error)}` })
    return finalize(checks)
  }

  const version = normalizeAgentBrowserVersion(versionRaw)
  if (!version) {
    checks.push({ name: 'agent-browser-version', status: 'fail', detail: `could not parse version from "${versionRaw.slice(0, 120)}"` })
  } else if (version !== TESTED_AGENT_BROWSER_VERSION) {
    checks.push({
      name: 'agent-browser-version',
      status: 'warn',
      detail: `agent-browser ${version} differs from tested ${TESTED_AGENT_BROWSER_VERSION}; capabilities may drift.`,
    })
  } else {
    checks.push({ name: 'agent-browser-version', status: 'pass', detail: `agent-browser ${version}` })
  }

  try {
    const result = await options.executor(options.executable, ['doctor'], {
      cwd: options.cwd,
      timeoutMs: options.timeoutMs ?? 30_000,
      env: options.env,
    })
    checks.push({
      name: 'chromium',
      status: result.code === 0 ? 'pass' : 'warn',
      detail: result.code === 0 ? 'agent-browser doctor reported ready.' : `agent-browser doctor exit ${result.code}.`,
    })
  } catch (error) {
    checks.push({ name: 'chromium', status: 'warn', detail: `agent-browser doctor failed: ${String(error)}` })
  }

  return finalize(checks)
}

function finalize(checks: DoctorCheck[]): DoctorReport {
  const status = checks.some((check) => check.status === 'fail')
    ? 'fail'
    : checks.some((check) => check.status === 'warn')
      ? 'warn'
      : 'pass'
  return { status, generatedAt: new Date().toISOString(), checks }
}
