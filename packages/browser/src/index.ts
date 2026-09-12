import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { DEFAULT_BROWSER_PLUGIN_CONFIG, type BrowserPluginConfig } from './config.ts'
import { BrowserAutomationService } from './service.ts'
import { createAgentBrowserTool } from './tool.ts'

export const name = 'dsh-browser'
export const inject = ['tools']

export const Config = z.object({
  command: z.string().default(DEFAULT_BROWSER_PLUGIN_CONFIG.command),
  namespace: z.string(),
  executablePath: z.string(),
  timeoutMs: z.natural().default(DEFAULT_BROWSER_PLUGIN_CONFIG.timeoutMs),
  maxOutputChars: z.natural().default(DEFAULT_BROWSER_PLUGIN_CONFIG.maxOutputChars),
  maxOutputLines: z.natural().default(DEFAULT_BROWSER_PLUGIN_CONFIG.maxOutputLines),
  spillDir: z.string(),
  allowedDomains: z.array(z.string()).default([]),
  registerTool: z.boolean().default(true),
})

export interface BrowserConfigShape {
  command: string
  namespace?: string
  executablePath?: string
  timeoutMs: number
  maxOutputChars: number
  maxOutputLines: number
  spillDir?: string
  allowedDomains: string[]
  registerTool: boolean
}

export function apply(ctx: Context, config: BrowserConfigShape): void {
  const resolved: BrowserPluginConfig = {
    command: config.command,
    timeoutMs: config.timeoutMs,
    maxOutputChars: config.maxOutputChars,
    maxOutputLines: config.maxOutputLines,
    allowedDomains: config.allowedDomains,
    ...(config.namespace ? { namespace: config.namespace } : {}),
    ...(config.executablePath ? { executablePath: config.executablePath } : {}),
    ...(config.spillDir ? { spillDir: config.spillDir } : {}),
  }

  const service = new BrowserAutomationService(ctx, resolved)
  ctx.effect(() => () => service.close(), 'dsh-browser.service')

  if (config.registerTool) {
    ctx.tools.register(createAgentBrowserTool(ctx))
  }
}
