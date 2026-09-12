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
  requiresAllowedDomains?: boolean
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

  if (options.requiresAllowedDomains) {
    try {
      const help = await options.executor(options.executable, ['--help'], {
        cwd: options.cwd,
        timeoutMs: options.timeoutMs ?? 10_000,
        env: options.env,
      })
      const supported = `${help.stdout}\n${help.stderr}`.includes('--allowed-domains')
      checks.push({
        name: 'allowed-domains-support',
        status: supported ? 'pass' : 'fail',
        detail: supported ? 'agent-browser advertises --allowed-domains' : 'allowedDomains is configured but the CLI does not advertise --allowed-domains',
      })
    } catch (error) {
      checks.push({ name: 'allowed-domains-support', status: 'fail', detail: `could not probe --allowed-domains: ${String(error)}` })
    }
  }

  // Capability probes only read CLI help; they never open a page.
  checks.push(
    await probeCapability(options, {
      name: 'electron-attach-support',
      args: ['connect', '--help'],
      needles: ['port', 'url'],
      okDetail: 'agent-browser connect accepts an explicit port or CDP URL',
      failDetail: 'agent-browser connect does not advertise an explicit port/URL target',
    }),
  )
  checks.push(
    await probeCapability(options, {
      name: 'network-inspection-support',
      args: ['network', '--help'],
      needles: ['requests', 'request'],
      okDetail: 'agent-browser network requests/request are available',
      failDetail: 'agent-browser network inspection commands are unavailable',
    }),
  )
  checks.push(
    await probeCapability(options, {
      name: 'source-lookup-support',
      args: ['--help'],
      needles: ['react'],
      okDetail: 'agent-browser advertises react inspection used by sourceLookup',
      failDetail: 'agent-browser does not advertise react inspection for sourceLookup',
    }),
  )

  return finalize(checks)
}

async function probeCapability(
  options: DoctorOptions,
  probe: { name: string; args: string[]; needles: string[]; okDetail: string; failDetail: string },
): Promise<DoctorCheck> {
  if (!options.executable) return { name: probe.name, status: 'fail', detail: 'agent-browser executable is unavailable.' }
  try {
    const result = await options.executor(options.executable, probe.args, {
      cwd: options.cwd,
      timeoutMs: options.timeoutMs ?? 10_000,
      env: options.env,
    })
    const text = `${result.stdout}\n${result.stderr}`.toLowerCase()
    const supported = probe.needles.every((needle) => text.includes(needle.toLowerCase()))
    return { name: probe.name, status: supported ? 'pass' : 'fail', detail: supported ? probe.okDetail : probe.failDetail }
  } catch (error) {
    return { name: probe.name, status: 'fail', detail: `capability probe failed: ${String(error)}` }
  }
}

function finalize(checks: DoctorCheck[]): DoctorReport {
  const status = checks.some((check) => check.status === 'fail')
    ? 'fail'
    : checks.some((check) => check.status === 'warn')
      ? 'warn'
      : 'pass'
  return { status, generatedAt: new Date().toISOString(), checks }
}
