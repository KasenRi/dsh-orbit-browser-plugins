import { execFileSync } from 'node:child_process'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-subagent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { CxHost, RoleHandle, RoleRunRequest, RoleRunResult } from './host.ts'

interface SubagentRunLike {
  id: string
  localAgent?: Agent
  result: Promise<{ output: ContentBlock[]; stopReason: string; diagnostic?: string }>
  dispose(): Promise<void>
}

interface AgentLike {
  id: unknown
  status?: 'idle' | 'running'
  session?: {
    header?: { cwd?: string }
    ownEvents?: () => readonly { type: string; data?: unknown }[]
    snapshotEvents?: () => readonly { type: string; data?: unknown }[]
  }
  whenIdle?: () => Promise<void>
}

function contentToText(blocks: readonly ContentBlock[] | undefined): string {
  if (!blocks) return ''
  return blocks
    .map((block) => (block.type === 'text' ? block.text : `[${block.type}]`))
    .join('\n')
}

/**
 * Wire the CX supervisor to DeepSeek Harness native Agent/Subagent services.
 * Commanders and watchdogs are one-shot children; executors are continuable so a
 * runtime restart can interrupt the old child before spawning a fresh one.
 */
export class DshCxHost implements CxHost {
  private readonly ctx: Context
  private readonly ownedChildren = new Set<string>()

  constructor(ctx: Context) {
    this.ctx = ctx
  }

  now(): number {
    return Date.now()
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, ms)
      const onAbort = (): void => {
        clearTimeout(timer)
        reject(new Error('CX_ABORTED'))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  async startRole(request: RoleRunRequest): Promise<RoleHandle> {
    const parent = this.ctx.agents.requireInitiator()
    const prompt: ContentBlock[] = [{ type: 'text', text: request.prompt }]
    const agentOptions = {
      provider: request.route.provider,
      model: request.route.model,
      ...(request.route.reasoningEffort ? { reasoningEffort: request.route.reasoningEffort as never } : {}),
      ...(request.route.maxTokens ? { maxTokens: request.route.maxTokens } : {}),
    }

    if (request.role === 'executor') {
      return this.startExecutor(parent, request, prompt, agentOptions)
    }

    const controller = new AbortController()
    const onAbort = (): void => controller.abort()
    request.signal?.addEventListener('abort', onAbort, { once: true })
    const run = (await this.ctx.subagents.start('spawn', {
      label: request.label,
      prompt,
      parent,
      signal: controller.signal,
      agentOptions,
      ...(request.toolFilter ? { toolFilter: request.toolFilter } : {}),
    })) as unknown as SubagentRunLike
    this.ownedChildren.add(run.id)

    const result: Promise<RoleRunResult> = run.result
      .then((value) => ({
        childId: run.id,
        output: contentToText(value.output),
        interrupted: value.stopReason !== 'completed',
        ...(value.stopReason !== 'completed' ? { reason: value.stopReason } : {}),
        ...(value.diagnostic ? { testSummary: [value.diagnostic] } : {}),
      }))
      .catch((error: unknown) => ({
        childId: run.id,
        output: '',
        interrupted: true,
        reason: error instanceof Error ? error.message : String(error),
      }))

    return { childId: run.id, result }
  }

  private async startExecutor(
    parent: Agent,
    request: RoleRunRequest,
    prompt: ContentBlock[],
    agentOptions: Record<string, unknown>,
  ): Promise<RoleHandle> {
    if (request.resumeOf) {
      const existing = this.ctx.agents.get(request.resumeOf as SessionId)
      if (existing) {
        const done = this.waitForIdle(existing as unknown as AgentLike)
        await this.ctx.subagents.sendMessage(parent, request.resumeOf as SessionId, prompt, { signal: new AbortController().signal })
        return { childId: request.resumeOf, result: done }
      }
    }

    const controller = new AbortController()
    request.signal?.addEventListener('abort', () => controller.abort(), { once: true })
    const started = await this.ctx.subagents.startContinuable({
      provider: 'spawn',
      label: request.label,
      request: {
        prompt,
        parent,
        agentOptions,
        ...(request.toolFilter ? { toolFilter: request.toolFilter } : {}),
      },
      signal: controller.signal,
    })
    const childId = String(started.childId)
    this.ownedChildren.add(childId)
    const agent = this.ctx.agents.get(started.childId)
    const result = agent
      ? this.waitForIdle(agent as unknown as AgentLike, childId)
      : Promise.resolve<RoleRunResult>({ childId, output: '', interrupted: true, reason: 'EXECUTOR_CHILD_MISSING' })
    return { childId, result }
  }

  private async waitForIdle(agent: AgentLike, childId?: string): Promise<RoleRunResult> {
    await agent.whenIdle?.()
    const output = this.readFinalOutput(agent)
    return {
      childId: childId ?? String(agent.id),
      output,
      interrupted: false,
      telemetry: {
        status: 'idle',
        ...(agent.session ? { activity_state: 'idle' } : {}),
      },
    }
  }

  private readFinalOutput(agent: AgentLike): string {
    const events = agent.session?.snapshotEvents?.() ?? agent.session?.ownEvents?.() ?? []
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]
      if (!event || event.type !== 'assistant/message') continue
      const data = event.data as { content?: ContentBlock[] } | undefined
      const text = contentToText(data?.content)
      if (text.trim()) return text
    }
    return ''
  }

  async interruptRole(handle: RoleHandle, reason: string): Promise<void> {
    if (!handle.childId) return
    try {
      const parent = this.ctx.agents.requireInitiator()
      this.ctx.subagents.interrupt(handle.childId as SessionId, { kind: 'ancestor', agent: parent })
    } catch {
      // best effort; releaseRole still drains the child
    }
    void reason
  }

  async releaseRole(handle: RoleHandle): Promise<void> {
    if (!handle.childId) return
    try {
      const parent = this.ctx.agents.requireInitiator()
      await this.ctx.subagents.drainContinuableChildren(parent, [handle.childId as SessionId])
    } catch {
      // one-shot children are released by their own result
    }
    this.ownedChildren.delete(handle.childId)
  }

  hasTool(name: string): boolean {
    return this.ctx.tools.get(name) !== undefined
  }

  async otherMutationDrivers(cwd: string): Promise<string[]> {
    const competitors: string[] = []
    for (const agent of this.ctx.agents.list()) {
      const id = String(agent.id)
      if (this.ownedChildren.has(id)) continue
      const agentLike = agent as unknown as AgentLike
      if (agentLike.status !== 'running') continue
      if (agentLike.session?.header?.cwd !== cwd) continue
      competitors.push(id)
    }
    return competitors
  }

  changedFiles(cwd: string): string[] {
    try {
      const output = execFileSync('git', ['-C', cwd, 'status', '--porcelain'], { encoding: 'utf8', timeout: 5000 })
      return output
        .split('\n')
        .map((line) => line.slice(3).trim())
        .filter((line) => line.length > 0 && !line.startsWith('.cx/'))
    } catch {
      return []
    }
  }
}
