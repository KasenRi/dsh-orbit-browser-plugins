/** Shared types for the browser plugin. */

export type SessionMode = 'auto' | 'fresh'

export type ResultCategory = 'success' | 'failure'

export type SuccessCategory = 'completed' | 'artifact-saved' | 'artifact-unverified' | 'inspection'

export type FailureCategory =
  | 'aborted'
  | 'artifact-missing'
  | 'cleanup-failed'
  | 'confirmation-required'
  | 'download-not-verified'
  | 'missing-binary'
  | 'parse-failure'
  | 'policy-blocked'
  | 'qa-failure'
  | 'selector-not-found'
  | 'selector-unsupported'
  | 'stale-ref'
  | 'tab-drift'
  | 'timeout'
  | 'upstream-error'
  | 'validation-error'

export type SemanticLocator = 'alt' | 'label' | 'placeholder' | 'role' | 'testid' | 'text' | 'title'

export type SemanticActionKind = 'check' | 'click' | 'fill' | 'select'

export interface SemanticActionInput {
  action: SemanticActionKind
  locator?: SemanticLocator
  value?: string
  values?: string[]
  selector?: string
  text?: string
  role?: string
  name?: string
  session?: string
}

export type JobStepAction =
  | 'open'
  | 'click'
  | 'fill'
  | 'type'
  | 'select'
  | 'wait'
  | 'assertText'
  | 'assertUrl'
  | 'waitForDownload'
  | 'screenshot'
  | 'snapshot'

export interface JobStep {
  action: JobStepAction
  url?: string
  loadState?: 'domcontentloaded' | 'load' | 'networkidle'
  selector?: string
  locator?: SemanticLocator
  value?: string
  values?: string[]
  text?: string
  name?: string
  role?: string
  milliseconds?: number
  delayMs?: number
  press?: string
  path?: string
}

export interface JobInput {
  steps: JobStep[]
  failFast?: boolean
}

export interface QaInput {
  url?: string
  attached?: boolean
  expectedText?: string
  expectedSelector?: string
  screenshotPath?: string
  checkNetwork?: boolean
  checkConsole?: boolean
  checkErrors?: boolean
  loadState?: 'domcontentloaded' | 'load' | 'networkidle'
}

export type ElectronAction = 'connect' | 'probe'

export interface ElectronInput {
  action: ElectronAction
  /** Explicit CDP port of an already-running Electron/Chrome debug endpoint. */
  port?: number
  /** Explicit CDP URL (ws/wss/http/https). */
  url?: string
  timeoutMs?: number
}

export interface SourceLookupInput {
  selector?: string
  reactFiberId?: string
  componentName?: string
  includeDomHints?: boolean
  maxWorkspaceFiles?: number
}

export interface NetworkSourceLookupInput {
  requestId?: string
  filter?: string
  url?: string
  maxWorkspaceFiles?: number
}

export interface AgentBrowserInput {
  args?: string[]
  semanticAction?: SemanticActionInput
  job?: JobInput
  qa?: QaInput
  electron?: ElectronInput
  sourceLookup?: SourceLookupInput
  networkSourceLookup?: NetworkSourceLookupInput
  stdin?: string
  outputPath?: string
  timeoutMs?: number
  sessionMode?: SessionMode
}

export type InputKind = 'args' | 'semanticAction' | 'job' | 'qa' | 'electron' | 'sourceLookup' | 'networkSourceLookup'

export interface ValidatedInput {
  ok: true
  kind: InputKind
  args: string[]
  generatedStdin?: string
  /** Caller-provided stdin, only accepted for whitelisted upstream commands. */
  stdin?: string
  failFast?: boolean
  sessionMode: SessionMode
  outputPath?: string
  timeoutMs?: number
  providesStdin: boolean
  /** Artifact candidates discovered inside compiled job/qa batch steps. */
  artifactRequests?: ArtifactRequest[]
  /** Lookup descriptor: analysis runs after a successful batch execution. */
  lookup?: LookupDescriptor
}

export interface LookupDescriptor {
  kind: 'source' | 'network'
  query: Record<string, string | number | boolean | undefined>
  steps: Array<{ action: string; args: string[] }>
}

export interface PageChangeSummary {
  command: string
  changeType: 'navigation' | 'mutation' | 'artifact' | 'confirmation' | 'recovery'
  summary: string
  title?: string
  url?: string
  previousUrl?: string
  titleChanged?: boolean
  urlChanged?: boolean
  refsBefore?: number
  refsAfter?: number
  refsRefreshed?: boolean
  activeTargetChanged?: boolean
  artifactCount?: number
  recoveryApplied?: boolean
}

export interface SourceCandidate {
  source: string
  file?: string
  line?: number
  column?: number
  componentName?: string
  confidence: 'high' | 'medium' | 'low'
  evidence: string[]
  requestUrl?: string
}

export interface LookupAnalysis {
  status: string
  summary: string
  candidates?: SourceCandidate[]
  failedRequests?: Array<{ requestId?: string; url?: string; method?: string; status?: number; error?: string }>
  limitations: string[]
}

export interface CliEnvelope {
  success: boolean
  data: unknown
  raw: unknown
}

export interface CommandResult {
  stdout: string
  stderr: string
  code: number
  timedOut: boolean
  killedBySignal: boolean
}

export interface ArtifactRequest {
  requestedPath: string
  kind: string
  pending?: boolean
}

export interface ArtifactEntry {
  requestedPath: string
  absolutePath: string
  kind: string
  mediaType?: string
  exists: boolean
  sizeBytes?: number
  status: 'verified' | 'missing' | 'pending' | 'unverified'
}

export interface ArtifactVerification {
  artifacts: ArtifactEntry[]
  verified: boolean
  verifiedCount: number
  missingCount: number
  pendingCount: number
  unverifiedCount: number
}

export interface RefEntry {
  role?: string
  name?: string
}

export interface RefSnapshot {
  refIds: string[]
  refs: Record<string, RefEntry>
  target: { url?: string; title?: string }
  invalidated?: 'no-active-page'
}

export interface RunContext {
  sessionId: string
  cwd: string
  signal?: AbortSignal
  agentId?: string
}

export interface AgentBrowserResult {
  resultCategory: ResultCategory
  successCategory?: SuccessCategory
  failureCategory?: FailureCategory
  command: string
  sessionName?: string
  usedImplicitSession: boolean
  args: string[]
  effectiveArgs: string[]
  data: unknown
  summary: string
  detail?: string
  nextActions: string[]
  artifacts?: ArtifactEntry[]
  artifactVerification?: ArtifactVerification
  refSnapshot?: RefSnapshot
  fullOutputPath?: string
  /** Absolute path written from `outputPath`, when requested and written successfully. */
  outputFile?: string
  /** Deterministic summary of what this call changed on the page. */
  pageChangeSummary?: PageChangeSummary
  /** sourceLookup analysis (candidate source locations, bounded). */
  sourceLookup?: LookupAnalysis
  /** networkSourceLookup analysis (failed requests + candidate locations, bounded). */
  networkSourceLookup?: LookupAnalysis
}
