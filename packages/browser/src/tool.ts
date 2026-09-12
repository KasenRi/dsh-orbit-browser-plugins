import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { AgentBrowserInput, AgentBrowserResult } from './types.ts'
import type { BrowserAutomationService } from './service.ts'

export const AGENT_BROWSER_TOOL_NAME = 'agent_browser'

const TOOL_DESCRIPTION =
  'Browse and interact with real websites using agent-browser. Use this for page interaction, ' +
  'rendered-page inspection, and browser-based verification. Standard workflow: open, then ' +
  'snapshot -i to read current @refs, then click/fill/select, then snapshot again after the page ' +
  'changes. Choose exactly one input mode: args (raw argv), semanticAction (stable role/text/label ' +
  'targets), job (short deterministic multi-step chain), or qa (page QA preset). Refs are page-scoped: ' +
  'never reuse a @ref after navigation or a major DOM change; take a fresh snapshot instead.'

interface ToolArgs {
  args?: string[]
  semanticAction?: Record<string, unknown>
  job?: Record<string, unknown>
  qa?: Record<string, unknown>
  stdin?: string
  outputPath?: string
  timeoutMs?: number
  sessionMode?: 'auto' | 'fresh'
}

interface AgentLike {
  id?: unknown
  session?: { id?: unknown; header?: { cwd?: string } }
  ctx?: { browserAutomation?: BrowserAutomationService }
}

function summarizeForModel(result: AgentBrowserResult): string {
  const lines: string[] = [result.summary]
  if (result.detail) lines.push(`Detail: ${result.detail}`)
  if (result.nextActions.length > 0) lines.push(`Next actions: ${result.nextActions.join(', ')}`)
  if (result.artifactVerification) {
    const verification = result.artifactVerification
    lines.push(
      `Artifacts: ${verification.verifiedCount} verified, ${verification.missingCount} missing, ${verification.pendingCount} pending.`,
    )
    if (!verification.verified && verification.artifacts.length > 0) lines.push('Artifacts were NOT independently verified.')
  }
  if (result.fullOutputPath) lines.push(`Full output path: ${result.fullOutputPath}`)
  return lines.join('\n')
}

export function createAgentBrowserTool(ctx: Context) {
  return defineTool({
    name: AGENT_BROWSER_TOOL_NAME,
    description: TOOL_DESCRIPTION,
    parameters: {
      args: { type: 'array', items: { type: 'string' }, description: 'Raw agent-browser argv (without --json).' },
      semanticAction: { type: 'json', description: 'Stable semantic target: action plus locator/role/selector.' },
      job: { type: 'json', description: 'Short deterministic batch job (steps).' },
      qa: { type: 'json', description: 'Page QA preset (url or attached).' },
      stdin: { type: 'string', description: 'Stdin payload for batch/eval/auth commands.' },
      outputPath: { type: 'string', description: 'Write the structured result to this path.' },
      timeoutMs: { type: 'integer', description: 'Subprocess watchdog override in milliseconds.' },
      sessionMode: { type: 'string', enum: ['auto', 'fresh'], description: 'Managed session selection mode.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => {
        const result = value as unknown as AgentBrowserResult
        const blocks: ContentBlock[] = [{ type: 'text', text: summarizeForModel(result) }]
        return blocks
      },
    },
    async execute(args, exec) {
      const agent = exec.agent as AgentLike | undefined
      const service = agent?.ctx?.browserAutomation ?? (ctx as Context & { browserAutomation?: BrowserAutomationService }).browserAutomation
      if (!service) {
        throw new Error('browserAutomation service is unavailable; dsh-browser is not loaded.')
      }
      const sessionId = String(agent?.session?.id ?? exec.callId ?? 'unknown-session')
      const cwd = agent?.session?.header?.cwd ?? process.cwd()
      const result = await service.run(args as unknown as AgentBrowserInput, {
        sessionId,
        cwd,
        ...(exec.signal ? { signal: exec.signal } : {}),
        ...(agent?.id !== undefined ? { agentId: String(agent.id) } : {}),
      })
      return result as unknown as JsonValue
    },
  })
}
