import { mkdirSync, writeFileSync } from 'node:fs'
import { mkdir as mkdirPromise, rename as renamePromise, writeFile as writeFilePromise } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, isAbsolute as isAbsolutePath, resolve as resolvePath } from 'node:path'
import { buildArgv, defaultCommandExecutor, parseEnvelope, type CommandExecutor } from './cli.ts'
import { artifactRequestsFromArgs, verifyArtifacts, type StatFn } from './artifacts.ts'
import { checkBatchRefOrdering, checkRefSafety, parseSnapshotRefs } from './refs.ts'
import { chooseRecoveryTab, detectTabDrift, parseTabList } from './tab-drift.ts'
import { buildPageChangeSummary } from './page-change.ts'
import { analyzeNetworkSourceLookup, analyzeSourceLookup } from './lookups.ts'
import { findProtectedStateViolation, redactArgs, redactValue, sanitizeEnv, truncateSafe, checkAllowedDomains } from './security.ts'
import { buildImplicitSessionName, decideSession, isManagedSessionName } from './session.ts'
import { validateInput } from './validate.ts'
import type {
  AgentBrowserInput,
  AgentBrowserResult,
  ArtifactRequest,
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

    // A CDP-attached context (electron connect / raw connect) cannot install the
    // upstream --allowed-domains containment, so it is refused when the allowlist
    // is active. The allowlist is never silently downgraded.
    if (this.config.allowedDomains.length > 0 && (validated.kind === 'electron' || args[0] === 'connect')) {
      return this.failure(
        'policy-blocked',
        'allowedDomains containment cannot be installed on a CDP-attached session (electron/connect); remove allowedDomains or use a managed browser context.',
      )
    }

    // Known-URL preflight: fail before any browser request leaves the machine.
    if (this.config.allowedDomains.length > 0) {
      for (const url of collectPlannedUrls(input, args)) {
        const violation = checkAllowedDomains(url, this.config.allowedDomains)
        if (violation) return this.failure('policy-blocked', violation.message)
      }
    }

    // Strict containment launches a fresh managed context with the upstream
    // --allowed-domains guard; the postflight check stays as defense in depth.
    const containmentLaunch =
      this.config.allowedDomains.length > 0 &&
      collectPlannedUrls(input, args).length > 0 &&
      !args.some((token) => token === '--session' || token.startsWith('--session='))
    const launchArgs = containmentLaunch
      ? ['--allowed-domains', this.config.allowedDomains.join(','), ...args]
      : args

    const decision = decideSession(
      launchArgs,
      containmentLaunch ? 'fresh' : validated.sessionMode,
      implicitSessionName,
      sessionState?.alive === true,
    )
    if (decision.launchFlagError) return this.failure('validation-error', decision.launchFlagError)

    const command = args[0] ?? ''
    const effectiveArgv = buildArgv({
      args: launchArgs,
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
      input: validated.generatedStdin ?? validated.stdin,
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

    return this.success(command, args, effectiveArgv, decision.sessionName, decision.usedImplicitSession, envelope, sessionState, implicitSessionName, context, validated)
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
    validated: ValidatedInput,
  ): Promise<AgentBrowserResult> {
    const requests = dedupeRequests([...artifactRequestsFromArgs(args), ...(validated.artifactRequests ?? [])])
    const verification = requests.length > 0 ? await verifyArtifacts(requests, context.cwd, this.statFn) : undefined
    if (verification && verification.missingCount > 0) {
      const missing = verification.artifacts.filter((entry) => entry.status === 'missing').map((entry) => entry.absolutePath)
      return this.failure('artifact-missing', `Expected artifact(s) missing: ${missing.join(', ')}`)
    }

    const state = this.ensureSession(implicitSessionName)
    const previousTarget = { ...state.target }
    const refsBefore = state.refSnapshot?.refIds.length
    let observedTarget = extractObservedTarget(command, args, envelope.data)
    let recoveryApplied = false

    // Tab drift: the active target changed without an explicit navigation. Refs
    // are invalidated immediately and we attempt exactly one deterministic
    // recovery; ambiguity is a failure, never a guess.
    const drift = detectTabDrift(previousTarget, observedTarget, command)
    if (drift.drift) {
      state.refSnapshot = undefined
      const recoveryArgv = this.recoveryArgv(sessionName, args, ['tab', 'list'])
      const recovered = recoveryArgv
        ? await this.attemptTabRecovery(previousTarget, recoveryArgv, sessionName, args, context)
        : false
      if (!recovered) {
        return this.failure(
          'tab-drift',
          `agent-browser detected tab drift (${drift.reason ?? 'target-changed'}) from ${previousTarget.url ?? 'unknown'} to ${observedTarget?.url ?? 'unknown'}; refs were invalidated and the intended tab could not be uniquely restored. Run tab list, re-select the intended tab, then snapshot -i.`,
          ['list-tabs-for-tab-drift-recovery', 'refresh-interactive-refs'],
        )
      }
      recoveryApplied = true
      observedTarget = previousTarget
    }

    let refsRefreshed = false
    if (command === 'snapshot' && !args.includes('--diff')) {
      const snapshot = drift.drift ? undefined : parseSnapshotRefs(envelope.data)
      if (snapshot) {
        state.refSnapshot = snapshot
        // Same-page snapshot: merge so an existing title survives (URL/title both optional).
        state.target = { ...state.target, ...(observedTarget ?? snapshot.target) }
        refsRefreshed = true
      }
    } else if (NAVIGATING_COMMANDS.has(command)) {
      const url = args.find((token) => /^https?:|^data:|^file:/.test(token))
      state.refSnapshot = undefined
      state.target = { ...(observedTarget ?? (url ? { url } : {})) }
    } else if (command === 'tab' && args[1] === 'close') {
      state.refSnapshot = undefined
      if (observedTarget) state.target = { ...state.target, ...observedTarget }
    } else if (observedTarget) {
      state.target = { ...state.target, ...observedTarget }
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

    const pageChangeSummary = buildPageChangeSummary({
      command,
      previousTarget,
      currentTarget: state.target,
      refsBefore,
      refsAfter: state.refSnapshot?.refIds.length,
      refsRefreshed,
      artifactCount: verification?.artifacts.length ?? 0,
      confirmationRequired: detectConfirmation(envelope.data),
      recoveryApplied,
    })

    const lookup =
      validated.lookup === undefined
        ? undefined
        : validated.lookup.kind === 'source'
          ? await analyzeSourceLookup(envelope.data, validated.lookup.query, context.cwd)
          : await analyzeNetworkSourceLookup(envelope.data, validated.lookup.query, context.cwd)

    const result: AgentBrowserResult = {
      resultCategory: 'success',
      successCategory: categories,
      command,
      ...(sessionName ? { sessionName } : {}),
      usedImplicitSession,
      args: redactArgs(args),
      effectiveArgs: redactArgs(effectiveArgv),
      data: output.data,
      summary: summarize(command, envelope.data, usedImplicitSession ? implicitSessionName : sessionName),
      nextActions: drift.drift ? ['refresh-interactive-refs'] : [],
      ...(verification ? { artifacts: verification.artifacts, artifactVerification: verification } : {}),
      ...(state.refSnapshot ? { refSnapshot: state.refSnapshot } : {}),
      ...(output.fullOutputPath ? { fullOutputPath: output.fullOutputPath } : {}),
      ...(pageChangeSummary ? { pageChangeSummary } : {}),
      ...(lookup && validated.lookup?.kind === 'source' ? { sourceLookup: lookup } : {}),
      ...(lookup && validated.lookup?.kind === 'network' ? { networkSourceLookup: lookup } : {}),
    }

    if (validated.outputPath) {
      const written = await this.writeOutputFile(validated.outputPath, output.data, context.cwd)
      if ('error' in written) return this.failure('validation-error', written.error)
      result.outputFile = written.path
    }
    return result
  }

  private recoveryArgv(
    sessionName: string | undefined,
    originalArgs: readonly string[],
    commandArgs: readonly string[],
  ): string[] | undefined {
    if (sessionName) {
      return buildArgv({
        args: [...commandArgs],
        sessionName,
        ...(this.config.namespace ? { namespace: this.config.namespace } : {}),
      })
    }
    const explicitIndex = originalArgs.findIndex((token) => token === '--session' || token.startsWith('--session='))
    if (explicitIndex >= 0) {
      const explicit = originalArgs[explicitIndex] === '--session'
        ? ['--session', originalArgs[explicitIndex + 1] ?? '']
        : [originalArgs[explicitIndex] as string]
      if (explicit[1] !== '' || explicit[0]?.includes('=')) {
        return buildArgv({
          args: [...explicit, ...commandArgs],
          ...(this.config.namespace ? { namespace: this.config.namespace } : {}),
        })
      }
    }
    return undefined
  }

  private async attemptTabRecovery(
    expected: { url?: string; title?: string },
    listArgv: string[],
    sessionName: string | undefined,
    originalArgs: readonly string[],
    context: RunContext,
  ): Promise<boolean> {
    const listed = await this.executor(this.config.command, listArgv, {
      cwd: context.cwd,
      timeoutMs: 10_000,
      env: this.childEnv(),
    })
    if (listed.timedOut || listed.code !== 0) return false
    const listedEnvelope = parseEnvelope(listed.stdout)
    if ('error' in listedEnvelope || !listedEnvelope.success) return false
    const tab = chooseRecoveryTab(expected, parseTabList(listedEnvelope.data))
    if (!tab) return false

    const selectArgv = this.recoveryArgv(sessionName, originalArgs, ['tab', tab.id])
    if (!selectArgv) return false
    const selected = await this.executor(this.config.command, selectArgv, {
      cwd: context.cwd,
      timeoutMs: 10_000,
      env: this.childEnv(),
    })
    if (selected.timedOut || selected.code !== 0) return false
    const selectedEnvelope = parseEnvelope(selected.stdout)
    return !('error' in selectedEnvelope) && selectedEnvelope.success
  }

  /** Atomic 0600 write of the structured result; caller path is resolved from cwd. */
  private async writeOutputFile(
    requestedPath: string,
    data: unknown,
    cwd: string,
  ): Promise<{ path: string } | { error: string }> {
    const target = isAbsolutePath(requestedPath) ? requestedPath : resolvePath(cwd, requestedPath)
    const payload =
      typeof data === 'string'
        ? data
        : `${JSON.stringify(redactValue(data), null, 2)}\n`
    const temp = `${target}.${randomUUID()}.tmp`
    try {
      await mkdirPromise(dirname(target), { recursive: true })
      await writeFilePromise(temp, payload, { encoding: 'utf8', mode: 0o600 })
      await renamePromise(temp, target)
      return { path: target }
    } catch (error) {
      return { error: `failed to write outputPath ${target}: ${error instanceof Error ? error.message : String(error)}` }
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

/** Extract the observed page target from a single envelope or a batch result array. */
function extractObservedTarget(
  command: string,
  args: readonly string[],
  data: unknown,
): { url?: string; title?: string } | undefined {
  const fromRecord = (value: unknown): { url?: string; title?: string } | undefined => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
    const record = value as Record<string, unknown>
    const url = typeof record['origin'] === 'string' ? record['origin'] : typeof record['url'] === 'string' ? record['url'] : undefined
    const title = typeof record['title'] === 'string' ? record['title'] : undefined
    return url || title ? { ...(url ? { url } : {}), ...(title ? { title } : {}) } : undefined
  }

  const direct = fromRecord(data)
  if (direct) return direct
  if (Array.isArray(data)) {
    for (let index = data.length - 1; index >= 0; index -= 1) {
      const item = data[index]
      if (item === null || typeof item !== 'object') continue
      const result = (item as Record<string, unknown>)['result']
      const payload = result !== null && typeof result === 'object' && 'data' in (result as Record<string, unknown>)
        ? (result as Record<string, unknown>)['data']
        : result
      const found = fromRecord(payload)
      if (found) return found
    }
  }
  if (NAVIGATING_COMMANDS.has(command)) {
    const url = args.find((token) => /^https?:|^data:|^file:/.test(token))
    return url ? { url } : undefined
  }
  return undefined
}

function detectConfirmation(data: unknown): boolean {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return false
  const record = data as Record<string, unknown>
  if (record['confirmationRequired'] === true) return true
  if (typeof record['confirmation'] === 'string' && record['confirmation'].length > 0) return true
  return record['status'] === 'confirmation-required'
}

/** URLs a single call is known to navigate to, for preflight containment. */
function collectPlannedUrls(input: AgentBrowserInput, args: readonly string[]): string[] {
  const urls: string[] = []
  const command = args[0]
  if (command === 'open' || command === 'goto' || command === 'navigate') {
    const target = args.slice(1).find((token) => !token.startsWith('-'))
    if (target) urls.push(target)
  }
  if (input.job) {
    for (const step of input.job.steps) {
      if (step.action === 'open' && step.url) urls.push(step.url)
    }
  }
  if (input.qa?.url) urls.push(input.qa.url)
  return urls
}

function dedupeRequests(requests: readonly ArtifactRequest[]): ArtifactRequest[] {
  const seen = new Set<string>()
  const out: ArtifactRequest[] = []
  for (const request of requests) {
    if (seen.has(request.requestedPath)) continue
    seen.add(request.requestedPath)
    out.push(request)
  }
  return out
}

function extractBatchRows(validated: ValidatedInput): string[][] {
  if (!validated.generatedStdin) return []
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
