import { createHash } from 'node:crypto'
import { basename } from 'node:path'

/** Reserved namespace prefix for sessions owned by this plugin. */
export const MANAGED_SESSION_NAME_PREFIX = 'dshab-'

export const DEFAULT_IMPLICIT_SESSION_IDLE_TIMEOUT_MS = 900_000
export const DEFAULT_IMPLICIT_SESSION_CLOSE_TIMEOUT_MS = 5_000

const LAUNCH_SCOPED_FLAGS = new Set([
  '--allowed-domains',
  '--auto-connect',
  '--cdp',
  '--enable',
  '--executable-path',
  '--webgpu',
  '--headed',
  '--init-script',
  '--device',
  '--namespace',
  '--profile',
  '--provider',
  '-p',
  '--restore',
  '--restore-save',
  '--session-name',
  '--idle-timeout',
])

const LAUNCH_SCOPED_PREFIXES = ['--restore-check-']

function slug(value: string): string {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return cleaned.slice(0, 24) || 'project'
}

export function buildImplicitSessionName(sessionId: string, cwd: string): string {
  const cwdHash = createHash('sha256').update(`cwd:${cwd}`).digest('hex').slice(0, 8)
  const stableSessionId = sessionId.replace(/-/g, '').slice(0, 12)
  const stable = stableSessionId || createHash('sha256').update(`ephemeral:${cwd}`).digest('hex').slice(0, 12)
  return `${MANAGED_SESSION_NAME_PREFIX}${slug(basename(cwd))}-${stable}-${cwdHash}`
}

export function buildFreshSessionName(base: string): string {
  const suffix = createHash('sha256').update(`${base}:${Date.now()}:${Math.random()}`).digest('hex').slice(0, 10)
  const stripped = base.startsWith(MANAGED_SESSION_NAME_PREFIX)
    ? base.slice(MANAGED_SESSION_NAME_PREFIX.length)
    : base
  return `${MANAGED_SESSION_NAME_PREFIX}${stripped}-fresh-${suffix}`
}

export function isManagedSessionName(name: string): boolean {
  return name.startsWith(MANAGED_SESSION_NAME_PREFIX)
}

export function hasExplicitSession(args: readonly string[]): boolean {
  return args.some((token) => token === '--session' || token.startsWith('--session='))
}

export function launchScopedFlags(args: readonly string[]): string[] {
  const flags: string[] = []
  for (const token of args) {
    const flag = token.includes('=') ? token.slice(0, token.indexOf('=')) : token
    if (LAUNCH_SCOPED_FLAGS.has(flag) || LAUNCH_SCOPED_PREFIXES.some((prefix) => flag.startsWith(prefix))) {
      if (!flags.includes(flag)) flags.push(flag)
    }
  }
  return flags
}

const PLAIN_TEXT_INSPECTION = new Set(['--help', '-h', '--version', '-V'])

export function isPlainTextInspectionArgs(args: readonly string[]): boolean {
  return args.length === 1 && args[0] !== undefined && PLAIN_TEXT_INSPECTION.has(args[0])
}

const SESSIONLESS_COMMANDS = new Set([
  'install',
  'upgrade',
  'dashboard',
  'profiles',
  'skills',
  'plugin',
  'mcp',
  'state',
  'session',
  'auth',
  'device',
])

export function commandNeedsManagedSession(args: readonly string[]): boolean {
  const command = args.find((token) => !token.startsWith('-'))
  if (command === undefined) return false
  if (SESSIONLESS_COMMANDS.has(command)) return false
  return true
}

export interface SessionDecision {
  sessionName?: string
  usedImplicitSession: boolean
  launchFlagError?: string
  sessionRecoveryHint?: { recommendedSessionMode: 'fresh' }
}

export function decideSession(
  args: readonly string[],
  mode: 'auto' | 'fresh',
  implicitSessionName: string,
  hasActiveImplicitSession: boolean,
): SessionDecision {
  if (hasExplicitSession(args) || !commandNeedsManagedSession(args) || isPlainTextInspectionArgs(args)) {
    return { usedImplicitSession: false }
  }
  if (mode === 'fresh') {
    return { sessionName: buildFreshSessionName(implicitSessionName), usedImplicitSession: true }
  }
  const flags = launchScopedFlags(args)
  if (hasActiveImplicitSession && flags.length > 0) {
    return {
      usedImplicitSession: false,
      launchFlagError:
        `The current managed agent-browser session is already running, so launch-scoped flags ${flags.join(', ')} ` +
        'would be ignored by upstream agent-browser. Retry with sessionMode: "fresh" or pass an explicit --session.',
      sessionRecoveryHint: { recommendedSessionMode: 'fresh' },
    }
  }
  return { sessionName: implicitSessionName, usedImplicitSession: true }
}
