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

export interface AgentBrowserInput {
  args?: string[]
  semanticAction?: SemanticActionInput
  job?: JobInput
  qa?: QaInput
  stdin?: string
  outputPath?: string
  timeoutMs?: number
  sessionMode?: SessionMode
}

export type InputKind = 'args' | 'semanticAction' | 'job' | 'qa'

export interface ValidatedInput {
  ok: true
  kind: InputKind
  args: string[]
  generatedStdin?: string
  failFast?: boolean
  sessionMode: SessionMode
  outputPath?: string
  timeoutMs?: number
  providesStdin: boolean
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
}
