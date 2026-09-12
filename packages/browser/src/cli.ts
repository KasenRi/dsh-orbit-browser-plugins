import { spawn } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { delimiter, join } from 'node:path'
import type { CliEnvelope, CommandResult } from './types.ts'

export type CommandExecutor = (
  command: string,
  args: readonly string[],
  options: { cwd: string; input?: string; timeoutMs: number; signal?: AbortSignal; env: NodeJS.ProcessEnv },
) => Promise<CommandResult>

export const DEFAULT_PROCESS_TIMEOUT_MS = 35_000
export const SAFE_OPERATION_TIMEOUT_MS = 25_000

export function resolveExecutable(command: string, pathValue: string | undefined): string | undefined {
  if (command.includes('/')) {
    try {
      accessSync(command, constants.X_OK)
      return command
    } catch {
      return undefined
    }
  }
  const dirs = (pathValue ?? '').split(delimiter).filter(Boolean)
  for (const dir of dirs) {
    const candidate = join(dir, command)
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      // keep looking
    }
  }
  return undefined
}

export interface BuildArgvOptions {
  args: readonly string[]
  sessionName?: string
  namespace?: string
}

/** Inject --json plus the managed session selection ahead of the caller argv. */
export function buildArgv(options: BuildArgvOptions): string[] {
  const argv: string[] = ['--json']
  if (options.namespace) argv.push('--namespace', options.namespace)
  if (options.sessionName) argv.push('--session', options.sessionName)
  argv.push(...options.args)
  return argv
}

export function parseEnvelope(stdout: string): CliEnvelope | { error: string } {
  const trimmed = stdout.trim()
  if (trimmed.length === 0) return { error: 'agent-browser returned no JSON output.' }
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch (error) {
    return { error: `agent-browser returned invalid JSON: ${error instanceof Error ? error.message : String(error)}` }
  }
  if (Array.isArray(parsed)) {
    const success = parsed.every((item) => !(item !== null && typeof item === 'object' && (item as { success?: unknown }).success === false))
    return { success, data: parsed, raw: parsed }
  }
  if (parsed === null || typeof parsed !== 'object') {
    return { error: 'agent-browser output is not an object envelope.' }
  }
  const record = parsed as Record<string, unknown>
  if (typeof record.success !== 'boolean') {
    return { error: 'agent-browser output is missing a boolean success field.' }
  }
  const data = record.data !== undefined ? record.data : omitKeys(record, ['success', 'data'])
  return { success: record.success, data, raw: parsed }
}

function omitKeys(record: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(record)) {
    if (!keys.includes(key)) out[key] = value
  }
  return out
}

export const defaultCommandExecutor: CommandExecutor = (command, args, options) =>
  new Promise<CommandResult>((resolve) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let killedBySignal = false
    const MAX_STDOUT = 512 * 1024
    const MAX_STDERR = 32_000

    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 2000)
    }, options.timeoutMs)

    const onAbort = (): void => {
      killedBySignal = true
      child.kill('SIGTERM')
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })

    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      if (stdout.length < MAX_STDOUT) stdout += chunk
    })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      if (stderr.length < MAX_STDERR) stderr += chunk
    })

    child.on('error', () => {
      clearTimeout(timer)
      resolve({ stdout, stderr, code: 127, timedOut, killedBySignal })
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      resolve({
        stdout,
        stderr,
        code: code ?? (timedOut ? 124 : 1),
        timedOut,
        killedBySignal: killedBySignal || signal !== null,
      })
    })
    if (options.input !== undefined) {
      child.stdin?.write(options.input)
    }
    child.stdin?.end()
  })
