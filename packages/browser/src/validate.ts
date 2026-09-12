import { compileSemanticAction } from './semantic.ts'
import { compileJob, compileQa } from './job.ts'
import { artifactRequestsFromCompiledSteps } from './artifacts.ts'
import type { AgentBrowserInput, ValidatedInput } from './types.ts'

export interface ValidationFailure {
  ok: false
  code: 'validation-error'
  message: string
}

/**
 * Upstream agent-browser commands that consume caller stdin. Everything else
 * rejects stdin so a secret payload can never be silently dropped or echoed.
 */
export function argsStdinAllowed(args: readonly string[]): boolean {
  const [command, subcommand] = args
  if (command === 'batch') return true
  if (command === 'eval' && args.includes('--stdin')) return true
  if (command === 'auth' && subcommand === 'save' && args.includes('--password-stdin')) return true
  return false
}

export function validateInput(input: AgentBrowserInput): ValidatedInput | ValidationFailure {
  const modePresent = [
    input.args !== undefined,
    input.semanticAction !== undefined,
    input.job !== undefined,
    input.qa !== undefined,
  ].filter(Boolean).length

  if (modePresent !== 1) {
    return {
      ok: false,
      code: 'validation-error',
      message: 'Provide exactly one of args, semanticAction, job, or qa.',
    }
  }

  const sessionMode = input.sessionMode ?? 'auto'

  if (input.outputPath !== undefined && (typeof input.outputPath !== 'string' || input.outputPath.length === 0)) {
    return { ok: false, code: 'validation-error', message: 'outputPath must be a non-empty string when provided.' }
  }
  if (input.timeoutMs !== undefined && (!Number.isInteger(input.timeoutMs) || input.timeoutMs <= 0)) {
    return { ok: false, code: 'validation-error', message: 'timeoutMs must be a positive integer when provided.' }
  }

  if (input.args !== undefined) {
    if (!Array.isArray(input.args) || input.args.length === 0) {
      return { ok: false, code: 'validation-error', message: 'args must be a non-empty string array.' }
    }
    if (input.stdin !== undefined && !argsStdinAllowed(input.args)) {
      return {
        ok: false,
        code: 'validation-error',
        message: 'stdin is only supported with batch, eval --stdin, or auth save --password-stdin.',
      }
    }
    return {
      ok: true,
      kind: 'args',
      args: [...input.args],
      ...(input.stdin !== undefined ? { stdin: input.stdin } : {}),
      sessionMode,
      ...(input.outputPath !== undefined ? { outputPath: input.outputPath } : {}),
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      providesStdin: input.stdin !== undefined,
    }
  }

  if (input.semanticAction !== undefined) {
    if (input.stdin !== undefined) {
      return { ok: false, code: 'validation-error', message: 'Do not provide stdin with semanticAction.' }
    }
    const compiled = compileSemanticAction(input.semanticAction)
    if (!compiled.ok) return { ok: false, code: 'validation-error', message: compiled.message }
    return {
      ok: true,
      kind: 'semanticAction',
      args: compiled.args,
      sessionMode,
      ...(input.outputPath !== undefined ? { outputPath: input.outputPath } : {}),
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      providesStdin: false,
    }
  }

  if (input.job !== undefined) {
    if (input.stdin !== undefined) {
      return { ok: false, code: 'validation-error', message: 'Do not provide stdin with job; job generates its own batch stdin.' }
    }
    const compiled = compileJob(input.job)
    if (!compiled.ok) return { ok: false, code: 'validation-error', message: compiled.message }
    return {
      ok: true,
      kind: 'job',
      args: compiled.args,
      generatedStdin: compiled.stdin,
      failFast: input.job.failFast !== false,
      sessionMode,
      artifactRequests: artifactRequestsFromCompiledSteps(compiled.steps),
      ...(input.outputPath !== undefined ? { outputPath: input.outputPath } : {}),
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      providesStdin: true,
    }
  }

  const qa = input.qa!
  if (input.stdin !== undefined) {
    return { ok: false, code: 'validation-error', message: 'Do not provide stdin with qa; qa generates its own batch stdin.' }
  }
  if (qa.attached === true && sessionMode === 'fresh') {
    return {
      ok: false,
      code: 'validation-error',
      message: 'qa.attached cannot be used with sessionMode=fresh; attach or launch a session first, then run qa.attached with the current session.',
    }
  }
  const compiled = compileQa(qa)
  if (!compiled.ok) return { ok: false, code: 'validation-error', message: compiled.message }
  return {
    ok: true,
    kind: 'qa',
    args: compiled.args,
    generatedStdin: compiled.stdin,
    sessionMode,
    artifactRequests: artifactRequestsFromCompiledSteps(compiled.steps),
    ...(input.outputPath !== undefined ? { outputPath: input.outputPath } : {}),
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    providesStdin: true,
  }
}
