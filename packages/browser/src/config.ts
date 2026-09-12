import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserRunnerConfig } from './runner.ts'

export interface BrowserPluginConfig {
  command: string
  namespace?: string
  executablePath?: string
  timeoutMs: number
  maxOutputChars: number
  maxOutputLines: number
  spillDir?: string
  allowedDomains?: string[]
}

export const DEFAULT_BROWSER_PLUGIN_CONFIG: BrowserPluginConfig = {
  command: 'agent-browser',
  timeoutMs: 35_000,
  maxOutputChars: 8_000,
  maxOutputLines: 120,
  allowedDomains: [],
}

export function resolveRunnerConfig(config: BrowserPluginConfig): BrowserRunnerConfig {
  const executablePath = config.executablePath ?? process.env.DSH_BROWSER_EXECUTABLE_PATH
  return {
    command: config.command,
    timeoutMs: config.timeoutMs,
    maxOutputChars: config.maxOutputChars,
    maxOutputLines: config.maxOutputLines,
    spillDir: config.spillDir ?? join(homedir(), '.dsh', 'browser-artifacts'),
    ...(config.namespace ? { namespace: config.namespace } : {}),
    ...(executablePath ? { executablePath } : {}),
    allowedDomains: config.allowedDomains ?? [],
  }
}

export function defaultSpillDir(): string {
  return join(tmpdir(), 'dsh-browser-artifacts')
}
