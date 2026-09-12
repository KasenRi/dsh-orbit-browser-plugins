import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'
import { buildArgv, defaultCommandExecutor, parseEnvelope, type CommandExecutor } from './cli.ts'
import { artifactRequestsFromArgs, verifyArtifacts, type StatFn } from './artifacts.ts'
import { checkBatchRefOrdering, checkRefSafety, parseSnapshotRefs } from './refs.ts'
import { findProtectedStateViolation, redactArgs, redactValue, sanitizeEnv, truncateSafe, checkAllowedDomains } from './security.ts'
import { buildImplicitSessionName, decideSession, isManagedSessionName } from './session.ts'
import { validateInput } from './validate.ts'
import type {
  AgentBrowserInput,
  AgentBrowserResult,
  CliEnvelope,
  FailureCategory,
  RefSnapshot,
  RunContext,
  SuccessCategory,
  ValidatedInput,
} from './types.ts'

export interface BrowserRunnerConfig {
  command: string
  timeoutMs: number
  maxOutputChars: number
  maxOutputLines: number
  spillDir: string
  namespace?: string
  executablePath?: string
  allowedDomains: readonly string[]
}

interface SessionState {
  refSnapshot?: RefSnapshot
  target: { url?: string }
  alive: boolean
}

export const MANAGEABLE_DEFAULT_TIMEOUT_MS = 35_000

const NAVIGATING_COMMANDS = new Set(['open', 'goto', 'navigate', 'reload', 'back', 'forward'])

export interface BrowserRunnerDeps {
  executor?: CommandExecutor
  statFn?: StatFn
  commandPath?: string
  env?: NodeJS.ProcessEnv
  now?: () => number
}

export class BrowserRunner {
  readonly config: BrowserRunnerConfig
  private readonly executor: CommandExecutor
  private readonly statFn: StatFn
  private readonly env: NodeJS.ProcessEnv
  private readonly sessions = new Map<string, SessionState>()

  constructor(config: BrowserRunnerConfig, deps: BrowserRunnerDeps = {}) {
    this.config = config
    this.executor = deps.executor ?? defaultCommandExecutor
    this.statFn = deps.statFn ?? defaultStat
    this.env = deps.env ?? process.env
  }

  sessionIdFor(context: RunContext): string {
    return buildImplicitSessionName(context.sessionId, context.cwd)
  }

  inspectSession(sessionName: string): { refSnapshot?: RefSnapshot; target: { url?: string }; alive: boolean } | undefined {
    const state = this.sessions.get(sessionName)
    if (!state) return undefined
    return { ...(state.refSnapshot ? { refSnapshot: state.refSnapshot } : {}), target: { ...state.target }, alive: state.alive }
  }

  async close(sessionName?: string): Promise<void> {
    if (sessionName === undefined) {
      const names = [...this.sessions.keys()]
      this.sessions.clear()
      await Promise.all(names.map((name) => this.runCli(['close'], name, '')))
      return
    }
    this.sessions.delete(sessionName)
  }

  async run(input: AgentBrowserInput, context: RunContext): Promise<AgentBrowserResult> {
    const validated = validateInput(input)
    if (!validated.ok) return this.failure('validation-error', validated.message)

    const implicitSessionName = this.sessionIdFor(context)
    const args = validated.args
    const protectedViolation = findProtectedStateViolation(args)
    if (protectedViolation) return this.failure('policy-blocked', protectedViolation)

    const sessionState = this.sessions.get(implicitSessionName)
    const decision = decideSession(args, validated.sessionMode, implicitSessionName, sessionState?.alive === true)
    if (decision.launchFlagError) return this.failure('validation-error', decision.launchFlagError)

    const command = args[0] ?? ''
    const effectiveArgv = buildArgv({
      args,
      ...(decision.sessionName ? { sessionName: decision.sessionName } : {}),
      ...(this.config.namespace ? { namespace: this.config.namespace } : {}),
    })

    const orderingCheck = checkBatchRefOrdering(extractBatchRows(validated))
    if (!orderingCheck.ok) {
      return this.failure('stale-ref', orderingCheck.message ?? 'stale ref in batch', orderingCheck.nextActions)
    }

    const refCheck = checkRefSafety(command, args, sessionState?.refSnapshot, sessionState?.target)
    if (!refCheck.ok) {
      return this.failure('stale-ref', refCheck.message ?? 'stale ref', refCheck.nextActions)
    }

    const timeoutMs = validated.timeoutMs ?? this.config.timeoutMs
    const result = await this.executor(this.config.command, effectiveArgv, {
      cwd: context.cwd,
      input: validated.generatedStdin,
      timeoutMs,
      signal: context.signal,
      env: this.childEnv(),
    })

    if (result.timedOut) {
      return this.failure('timeout', `agent-browser timed out after ${timeoutMs}ms.`, ['retry-with-longer-timeout'])
    }
    if (result.code === 127) {
      return this.failure('missing-binary', `agent-browser executable not found: ${this.config.command}`)
    }

    const envelope = parseEnvelope(result.stdout)
    if ('error' in envelope) {
      const detail = result.stderr.trim() || envelope.error
      return this.failure(result.code === 0 ? 'parse-failure' : 'upstream-error', detail)
    }
    if (!envelope.success) {
      const detail = extractUpstreamError(envelope) ?? result.stderr.trim() ?? 'agent-browser reported failure.'
      return this.failure('upstream-error', detail)
    }

    return this.success(command, args, effectiveArgv, decision.sessionName, decision.usedImplicitSession, envelope, sessionState, implicitSessionName, context)
  }

  private async success(
    command: string,
    args: string[],
    effectiveArgv: string[],
    sessionName: string | undefined,
    usedImplicitSession: boolean,
    envelope: CliEnvelope,
    sessionState: SessionState | undefined,
    implicitSessionName: string,
    context: RunContext,
  ): Promise<AgentBrowserResult> {
    const requests = artifactRequestsFromArgs(args)
    const verification = requests.length > 0 ? await verifyArtifacts(requests, context.cwd, this.statFn) : undefined
    if (verification && verification.missingCount > 0) {
      const missing = verification.artifacts.filter((entry) => entry.status === 'missing').map((entry) => entry.absolutePath)
      return this.failure('artifact-missing', `Expected artifact(s) missing: ${missing.join(', ')}`)
    }

    const state = this.ensureSession(implicitSessionName)
    if (command === 'snapshot' && !args.includes('--diff')) {
      const snapshot = parseSnapshotRefs(envelope.data)
      if (snapshot) {
        state.refSnapshot = snapshot
        state.target = { ...state.target, ...snapshot.target }
      }
    } else if (NAVIGATING_COMMANDS.has(command)) {
      const url = args.find((token) => /^https?:|^data:|^file:/.test(token))
      state.refSnapshot = undefined
      state.target = { ...(url ? { url } : {}) }
    } else if (command === 'tab' && args[1] === 'close') {
      state.refSnapshot = undefined
    }

    const categories: SuccessCategory = verification
      ? verification.verified
        ? 'artifact-saved'
        : 'artifact-unverified'
      : isInspection(command)
        ? 'inspection'
        : 'completed'

    const redactedData = redactValue(envelope.data)
    const observedUrl = extractObservedUrl(command, args, envelope.data, sessionState)
    const domainViolation = checkAllowedDomains(observedUrl, this.config.allowedDomains)
    if (domainViolation) return this.failure('policy-blocked', domainViolation.message)
    const output = this.boundOutput(command, redactedData)

    return {
      resultCategory: 'success',
      successCategory: categories,
      command,
      ...(sessionName ? { sessionName } : {}),
      usedImplicitSession,
      args: redactArgs(args),
      effectiveArgs: redactArgs(effectiveArgv),
      data: output.data,
      summary: summarize(command, envelope.data, usedImplicitSession ? implicitSessionName : sessionName),
      nextActions: [],
      ...(verification ? { artifacts: verification.artifacts, artifactVerification: verification } : {}),
      ...(state.refSnapshot ? { refSnapshot: state.refSnapshot } : {}),
      ...(output.fullOutputPath ? { fullOutputPath: output.fullOutputPath } : {}),
    }
  }

  private boundOutput(command: string, data: unknown): { data: unknown; fullOutputPath?: string } {
    const serialized = typeof data === 'string' ? data : JSON.stringify(data, null, 2)
    const lines = serialized.split('\n')
    if (serialized.length <= this.config.maxOutputChars && lines.length <= this.config.maxOutputLines) {
      return { data }
    }
    mkdirSync(this.config.spillDir, { recursive: true })
    const path = resolvePath(this.config.spillDir, `dsh-browser-output-${Date.now()}-${command}.txt`)
    writeFileSync(path, serialized, { encoding: 'utf8', mode: 0o600 })
    const preview = lines.slice(0, 40).map((line) => line.slice(0, 240)).join('\n')
    return {
      data: {
        compacted: true,
        fullOutputPath: path,
        outputCharCount: serialized.length,
        outputLineCount: lines.length,
        preview,
      },
      fullOutputPath: path,
    }
  }

  private ensureSession(name: string): SessionState {
    let state = this.sessions.get(name)
    if (!state) {
      state = { target: {}, alive: true }
      this.sessions.set(name, state)
    }
    return state
  }

  private async runCli(args: string[], sessionName: string, cwd: string): Promise<void> {
    const argv = buildArgv({ args, sessionName })
    await this.executor(this.config.command, argv, {
      cwd,
      timeoutMs: 5_000,
      env: this.childEnv(),
    })
  }

  private childEnv(): NodeJS.ProcessEnv {
    const env = sanitizeEnv(this.env)
    if (this.config.executablePath) env.AGENT_BROWSER_EXECUTABLE_PATH = this.config.executablePath
    return env
  }

  private failure(category: FailureCategory, detail: string, nextActions: string[] = []): AgentBrowserResult {
    return {
      resultCategory: 'failure',
      failureCategory: category,
      command: '',
      usedImplicitSession: false,
      args: [],
      effectiveArgs: [],
      data: null,
      summary: `agent_browser failed: ${category}`,
      detail: truncateSafe(detail, 2000),
      nextActions,
    }
  }
}

function extractObservedUrl(
  command: string,
  args: readonly string[],
  data: unknown,
  sessionState: SessionState | undefined,
): string | undefined {
  if (data !== null && typeof data === 'object') {
    const record = data as Record<string, unknown>
    for (const key of ['origin', 'url']) {
      const value = record[key]
      if (typeof value === 'string' && value.length > 0) return value
    }
  }
  if (NAVIGATING_COMMANDS.has(command)) {
    return args.find((token) => /^https?:|^data:|^file:/.test(token)) ?? sessionState?.target.url
  }
  return sessionState?.target.url
}

function extractBatchRows(validated: ValidatedInput): string[][] {  if (!validated.generatedStdin) return []
  try {
    const parsed = JSON.parse(validated.generatedStdin)
    return Array.isArray(parsed) ? (parsed as string[][]) : []
  } catch {
    return []
  }
}

function extractUpstreamError(envelope: CliEnvelope): string | undefined {
  const data = envelope.data
  if (data === null || typeof data !== 'object') return undefined
  const record = data as Record<string, unknown>
  const error = record.error
  if (typeof error === 'string') return error
  if (error !== null && typeof error === 'object') {
    const message = (error as Record<string, unknown>).message
    if (typeof message === 'string') return message
  }
  return undefined
}

function isInspection(command: string): boolean {
  return ['get', 'snapshot', 'network', 'console', 'errors', 'a11y', 'vitals', 'tab', 'session', 'state'].includes(command)
}

function summarize(command: string, data: unknown, sessionName?: string): string {
  if (command === 'snapshot') {
    const snapshot = parseSnapshotRefs(data)
    const count = snapshot?.refIds.length ?? 0
    const url = snapshot?.target.url ?? 'current page'
    return `Snapshot: ${count} refs on ${url}`
  }
  if (command === 'open') return `Opened session ${sessionName ?? ''}`.trim()
  if (command === 'get') return `Read page value.`
  return `Completed ${command}${sessionName ? ` (session ${sessionName})` : ''}.`
}

async function defaultStat(path: string): Promise<{ isFile(): boolean; size: number }> {
  const { stat } = await import('node:fs/promises')
  return stat(path)
}

export { isManagedSessionName }
