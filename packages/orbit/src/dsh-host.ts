import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-subagent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock, LlmRuntime } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { collectTurnToolFacts } from './evidence.ts'
import type { CommanderDecisionSubmission } from './commander-tool.ts'
import { ORBIT_COMMANDER_DECISION_TOOL, ORBIT_RUN_COMPLETE_TOOL, type ModelRunRequest, type ModelRunResult, type ModelRunUsage, type OrbitHost, type RoleHandle, type RoleRunRequest, type RoleRunResult } from './host.ts'
import { redactText, truncateSafe } from './sanitize.ts'
import { classifyTurnSettlement } from './settlement.ts'
import type { OrbitTelemetry, TerminalCompletionSubmission } from './types.ts'
import type { OrbitRole, OrbitRoute } from './types.ts'

interface SubagentRunLike {
  id: string
  localAgent?: Agent
  result: Promise<{ output: ContentBlock[]; stopReason: string; diagnostic?: string; structured?: unknown }>
  dispose(): Promise<void>
}

interface AgentLike {
  id: unknown
  status?: 'idle' | 'running'
  session?: {
    header?: { cwd?: string }
    ownEvents?: () => readonly { type?: string; time?: number; data?: unknown }[]
    snapshotEvents?: () => readonly { type?: string; time?: number; data?: unknown }[]
  }
  whenIdle?: () => Promise<void>
}

interface GoalsLike {
  get(agent: unknown): { phase?: string; activation?: string } | undefined
}

export interface DshOrbitHostOptions {
  now?: () => number
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
}

const EXECUTOR_TURN_START_TIMEOUT_MS = 5_000

function contentToText(blocks: readonly ContentBlock[] | undefined): string {
  if (!blocks) return ''
  return blocks
    .map((block) => (block.type === 'text' ? block.text : `[${block.type}]`))
    .join('\n')
}

function visibleContentToText(blocks: readonly ContentBlock[] | undefined): string {
  return blocks?.flatMap((block) => block.type === 'text' && block.text.trim() !== '' ? [block.text] : []).join('\n') ?? ''
}

/**
 * Wire the Orbit supervisor to DeepSeek Harness native Agent/Subagent services.
 *
 * Commander and Executor can run as durable continuable children for the life
 * of one Orbit Run. Watchdog and MoA model calls remain isolated one-shot
 * children. A continuable child may drain between turns; its Session identity
 * and history remain cold-resumable through DSH.
 */
export class DshOrbitHost implements OrbitHost {
  private readonly ctx: Context
  private readonly ownedChildren = new Set<string>()
  private readonly interruptedChildren = new Set<string>()
  private readonly childParents = new Map<string, Agent>()
  private readonly childGrants = new Map<string, { role: OrbitRole; workspace: string; tools: ReadonlySet<string> }>()
  private readonly commanderDecisions = new Map<string, CommanderDecisionSubmission>()
  private readonly terminalConfirmations = new Map<string, TerminalCompletionSubmission>()
  private readonly terminalExpected = new Set<string>()
  private readonly nowFn: () => number
  private readonly sleepFn: (ms: number, signal?: AbortSignal) => Promise<void>

  constructor(ctx: Context, options: DshOrbitHostOptions = {}) {
    this.ctx = ctx
    this.nowFn = options.now ?? (() => Date.now())
    this.sleepFn = options.sleep ?? defaultSleep
  }

  now(): number {
    return this.nowFn()
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return this.sleepFn(ms, signal)
  }

  async startRole(request: RoleRunRequest): Promise<RoleHandle> {
    const parent = this.parent()
    if (request.workspace !== undefined && resolve(parent.session.header.cwd ?? process.cwd()) !== resolve(request.workspace)) {
      throw new Error('ORBIT_WORKSPACE_MISMATCH: 子代理工作目录必须与 Orbit 持有的 workspace 一致。')
    }
    const prompt: ContentBlock[] = [{ type: 'text', text: request.prompt }]
    const agentOptions = {
      provider: request.route.provider,
      model: request.route.model,
      reasoningEffort: request.route.reasoningEffort as never,
    }

    if (request.persistent === true && (request.role === 'executor' || request.role === 'commander')) {
      return this.startPersistentRole(parent, request, prompt, agentOptions)
    }
    return this.startOneShot(parent, request, prompt, agentOptions)
  }

  async runModel(request: ModelRunRequest): Promise<ModelRunResult> {
    const handle = await this.startRole({
      role: 'commander',
      label: request.label,
      prompt: request.prompt,
      route: request.route,
      toolFilter: { allow: [] },
      ...(request.signal ? { signal: request.signal } : {}),
    })
    try {
      const result = await handle.result
      return {
        output: result.visibleOutput ?? result.output,
        interrupted: result.interrupted,
        ...(result.reason ? { reason: result.reason } : {}),
        ...(result.tokenUsage ? { usage: result.tokenUsage } : {}),
      }
    } finally {
      await this.releaseRole(handle)
    }
  }

  private parent(): Agent {
    const initiator = this.ctx.agents.currentInitiator()
    if (initiator) return initiator
    return this.ctx.agents.requireInitiator()
  }

  private async startOneShot(
    parent: Agent,
    request: RoleRunRequest,
    prompt: ContentBlock[],
    agentOptions: Record<string, unknown>,
  ): Promise<RoleHandle> {
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
      ...(request.outputSchema ? { outputSchema: request.outputSchema } : {}),
    })) as unknown as SubagentRunLike
    this.registerChild(run.id, parent, request)

    const result: Promise<RoleRunResult> = run.result
      .then((value) => ({
        childId: run.id,
        output: contentToText(value.output),
        visibleOutput: visibleContentToText(value.output),
        interrupted: value.stopReason !== 'completed',
        ...(value.stopReason !== 'completed' ? { reason: value.stopReason } : {}),
        ...(value.diagnostic ? { testSummary: [value.diagnostic] } : {}),
        ...(value.structured !== undefined ? { structured: value.structured } : {}),
        ...(this.readTokenUsage(run.localAgent as unknown as AgentLike | undefined) ? { tokenUsage: this.readTokenUsage(run.localAgent as unknown as AgentLike | undefined) } : {}),
      }))
      .catch((error: unknown) => ({
        childId: run.id,
        output: '',
        interrupted: true,
        reason: error instanceof Error ? error.message : String(error),
      }))

    return {
      childId: run.id,
      result,
      cancel: async (reason: string) => {
        this.interruptedChildren.add(run.id)
        controller.abort(new Error(reason))
        await run.dispose()
        this.forgetChild(run.id)
      },
      dispose: async () => {
        await run.dispose()
        this.forgetChild(run.id)
      },
      runtimeSnapshot: () => this.snapshotAgent(run.localAgent as unknown as AgentLike | undefined),
    }
  }

  /** Accept one decision from the exact persistent Commander child. */
  captureCommanderDecision(agent: Agent | undefined, submission: CommanderDecisionSubmission): void {
    const childId = String(agent?.id ?? '')
    const grant = this.childGrants.get(childId)
    const parent = this.childParents.get(childId)
    if (!agent || grant?.role !== 'commander' || this.terminalExpected.has(childId) || parent === undefined || this.ctx.agents.get(SessionId(childId)) !== agent || !this.ctx.agents.isOwnedBy(SessionId(childId), parent)) {
      throw new Error('ORBIT_COMMANDER_DECISION_UNAUTHORIZED')
    }
    this.commanderDecisions.set(childId, structuredClone(submission))
  }

  /** Accept the narrow final stop signal from the exact persistent Commander child. */
  captureTerminalConfirmation(agent: Agent | undefined, submission: TerminalCompletionSubmission): void {
    const childId = String(agent?.id ?? '')
    const grant = this.childGrants.get(childId)
    const parent = this.childParents.get(childId)
    if (!agent || grant?.role !== 'commander' || !this.terminalExpected.has(childId) || parent === undefined || this.ctx.agents.get(SessionId(childId)) !== agent || !this.ctx.agents.isOwnedBy(SessionId(childId), parent)) {
      throw new Error('ORBIT_TERMINAL_CONFIRM_UNAUTHORIZED')
    }
    this.terminalConfirmations.set(childId, structuredClone(submission))
  }

  private async startPersistentRole(
    parent: Agent,
    request: RoleRunRequest,
    prompt: ContentBlock[],
    agentOptions: Record<string, unknown>,
  ): Promise<RoleHandle> {
    if (request.resumeOf) {
      const existingId = request.resumeOf
      const previous = this.ctx.agents.get(existingId as SessionId) as unknown as AgentLike | undefined
      const previousTurns = (previous?.session?.snapshotEvents?.() ?? []).filter((event) => event.type === 'turn/start').length
      // DSH sendMessage can cold-resume a durable direct continuable child. Rebuild
      // Orbit's in-memory grant before delivery so the resumed turn is authorized.
      this.registerChild(existingId, parent, request)
      this.interruptedChildren.delete(existingId)
      try {
        await this.ctx.subagents.sendMessage(parent, existingId as SessionId, prompt, {
          signal: request.signal ?? new AbortController().signal,
        })
        const resumed = this.ctx.agents.get(existingId as SessionId) as unknown as AgentLike | undefined
        if (!resumed) throw new Error('ORBIT_PERSISTENT_CHILD_MISSING_AFTER_RESUME')
        const done = this.waitForPersistentSettlement(request, resumed, existingId, previousTurns)
        return {
          childId: existingId,
          result: done,
          cancel: async (reason: string) => this.interruptPersistentChild(existingId, reason),
          // A settled persistent turn stays resident for the next Orbit turn.
          // Run-level cleanup drains it explicitly through revokeWorkspace().
          dispose: async () => undefined,
          runtimeSnapshot: () => this.snapshotAgent(resumed),
        }
      } catch (error) {
        this.forgetChild(existingId)
        throw error
      }
    }

    const controller = new AbortController()
    request.signal?.addEventListener('abort', () => controller.abort(), { once: true })
    const reservedId = SessionId(randomUUID())
    const childId = String(reservedId)
    this.registerChild(childId, parent, request)
    let started
    try {
      started = await this.ctx.subagents.startContinuable({
        provider: 'spawn',
        label: request.label,
        childId: reservedId,
        request: {
          prompt,
          parent,
          agentOptions,
          ...(request.toolFilter ? { toolFilter: request.toolFilter } : {}),
        },
        signal: controller.signal,
      })
    } catch (error) {
      this.forgetChild(childId)
      throw error
    }
    const agent = this.ctx.agents.get(started.childId)
    const result = agent
      ? this.waitForPersistentSettlement(request, agent as unknown as AgentLike, childId)
      : Promise.resolve<RoleRunResult>({ childId, output: '', interrupted: true, reason: 'ORBIT_PERSISTENT_CHILD_MISSING' })
    return {
      childId,
      result,
      cancel: async (reason: string) => this.interruptPersistentChild(childId, reason),
      // Do not drain after a normal turn: that would force an unnecessary
      // cold-resume and discard the live role context we intentionally reuse.
      dispose: async () => undefined,
      runtimeSnapshot: agent ? () => this.snapshotAgent(agent as unknown as AgentLike) : undefined,
    }
  }

  private registerChild(childId: string, parent: Agent, request: RoleRunRequest): void {
    this.ownedChildren.add(childId)
    this.childParents.set(childId, parent)
    this.childGrants.set(childId, {
      role: request.role,
      workspace: resolve(request.workspace ?? parent.session.header.cwd ?? process.cwd()),
      tools: new Set(request.toolFilter?.allow ?? []),
    })
    if (request.role === 'commander') {
      if (request.terminalConfirm === true) this.terminalExpected.add(childId)
      else this.terminalExpected.delete(childId)
    }
  }

  private forgetChild(childId: string): void {
    this.ownedChildren.delete(childId)
    this.interruptedChildren.delete(childId)
    this.childParents.delete(childId)
    this.childGrants.delete(childId)
    this.commanderDecisions.delete(childId)
    this.terminalConfirmations.delete(childId)
    this.terminalExpected.delete(childId)
  }

  private async interruptPersistentChild(childId: string, reason: string): Promise<void> {
    this.interruptedChildren.add(childId)
    const parent = this.childParents.get(childId)
    this.ctx.subagents.interrupt(childId as SessionId, parent ? { kind: 'ancestor', agent: parent } : { kind: 'user', parentSessionId: childId as SessionId })
    await this.ctx.agents.get(SessionId(childId))?.whenIdle()
    void reason
  }

  private async drainPersistentChild(parent: Agent, childId: string): Promise<void> {
    try {
      await this.ctx.subagents.drainContinuableChildren(parent, [childId as SessionId])
    } catch {
      // already released
    }
    this.forgetChild(childId)
  }

  private async waitForPersistentSettlement(request: RoleRunRequest, agent: AgentLike, childId: string, previousTurns = 0): Promise<RoleRunResult> {
    await this.waitForTurnOrIdle(agent, previousTurns)
    const events = agent.session?.snapshotEvents?.() ?? agent.session?.ownEvents?.() ?? []
    const classified = classifyTurnSettlement(events)
    const output = this.readFinalOutput(agent)
    const visibleOutput = this.readFinalVisibleOutput(agent)
    const telemetry = await this.snapshotAgent(agent)
    const tokenUsage = this.readTokenUsage(agent)
    const toolEvidence = collectTurnToolFacts(events)
    const evidence = {
      settlement: classified.settlement,
      ...(toolEvidence.length > 0 ? { toolEvidence } : {}),
      ...(tokenUsage ? { tokenUsage } : {}),
    }
    const roleCode = request.role === 'commander' ? 'COMMANDER' : 'EXECUTOR'

    if (this.interruptedChildren.has(childId)) {
      return { childId, output, interrupted: true, reason: `${roleCode}_INTERRUPTED`, telemetry, ...evidence }
    }

    if (classified.settlement === 'completed' && request.role === 'commander') {
      if (request.terminalConfirm === true) {
        const submission = this.terminalConfirmations.get(childId)
        this.terminalConfirmations.delete(childId)
        this.terminalExpected.delete(childId)
        if (!submission) {
          return { childId, output, interrupted: true, reason: 'TERMINAL_CONFIRM_STRUCTURED_OUTPUT_MISSING', telemetry, ...evidence }
        }
        return { childId, output, visibleOutput, structured: submission, interrupted: false, telemetry, ...evidence }
      }
      const submission = this.commanderDecisions.get(childId)
      this.commanderDecisions.delete(childId)
      if (!submission) {
        return { childId, output, interrupted: true, reason: `${request.commanderMode ?? 'COMMANDER'}_STRUCTURED_OUTPUT_MISSING`, telemetry, ...evidence }
      }
      if (request.commanderMode !== undefined && submission.mode !== request.commanderMode) {
        return { childId, output, interrupted: true, reason: `COMMANDER_DECISION_MODE_MISMATCH: expected ${request.commanderMode}, got ${submission.mode}`, telemetry, ...evidence }
      }
      const { mode: _mode, ...structured } = submission
      return { childId, output, visibleOutput, structured, interrupted: false, telemetry, ...evidence }
    }

    switch (classified.settlement) {
      case 'completed':
        return { childId, output, interrupted: false, telemetry, ...evidence }
      case 'aborted':
        return {
          childId,
          output,
          interrupted: true,
          reason: `${roleCode}_ABORTED${classified.cancelCause ? `:${classified.cancelCause}` : ''}`,
          telemetry,
          ...evidence,
        }
      case 'error':
        return {
          childId,
          output,
          interrupted: true,
          reason: `${roleCode}_ERROR: ${redactText(classified.errorMessage ?? 'unknown failure')}`,
          telemetry,
          ...evidence,
        }
      case 'blocked':
        return { childId, output, interrupted: true, reason: `${roleCode}_BLOCKED`, telemetry, ...evidence }
      case 'max-tokens':
        return { childId, output, interrupted: true, reason: `${roleCode}_MAX_TOKENS`, telemetry, ...evidence }
      case 'interrupted':
        return { childId, output, interrupted: true, reason: `${roleCode}_INTERRUPTED`, telemetry, ...evidence }
      default:
        return { childId, output, interrupted: true, reason: `${roleCode}_NO_TURN`, telemetry, ...evidence }
    }
  }

  private async waitForTurnOrIdle(agent: AgentLike, previousTurns = 0): Promise<void> {
    const deadline = this.nowFn() + EXECUTOR_TURN_START_TIMEOUT_MS
    while (this.nowFn() < deadline && !this.hasTurnStarted(agent, previousTurns)) {
      await this.sleepFn(20)
    }
    await agent.whenIdle?.()
  }

  private hasTurnStarted(agent: AgentLike, previousTurns: number): boolean {
    const events = agent.session?.snapshotEvents?.() ?? []
    return events.filter((event) => event.type === 'turn/start').length > previousTurns
  }

  private readTokenUsage(agent: AgentLike | undefined): ModelRunUsage | undefined {
    const events = agent?.session?.snapshotEvents?.() ?? agent?.session?.ownEvents?.() ?? []
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]
      if (!event || event.type !== 'assistant/message') continue
      const usage = (event.data as { usage?: Partial<ModelRunUsage> } | undefined)?.usage
      if (typeof usage?.inputTokens !== 'number' || typeof usage.outputTokens !== 'number') continue
      return {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        ...(typeof usage.totalTokens === 'number' ? { totalTokens: usage.totalTokens } : {}),
        ...(typeof usage.cacheReadTokens === 'number' ? { cacheReadTokens: usage.cacheReadTokens } : {}),
        ...(typeof usage.cacheWriteTokens === 'number' ? { cacheWriteTokens: usage.cacheWriteTokens } : {}),
      }
    }
    return undefined
  }

  private readFinalVisibleOutput(agent: AgentLike): string {
    const events = agent.session?.snapshotEvents?.() ?? agent.session?.ownEvents?.() ?? []
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]
      if (!event || event.type !== 'assistant/message') continue
      const data = event.data as { message?: { content?: ContentBlock[] }; content?: ContentBlock[] } | undefined
      const text = visibleContentToText(data?.message?.content ?? data?.content)
      if (text.trim()) return text
    }
    return ''
  }

  private readFinalOutput(agent: AgentLike): string {
    const events = agent.session?.snapshotEvents?.() ?? agent.session?.ownEvents?.() ?? []
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]
      if (!event || event.type !== 'assistant/message') continue
      const data = event.data as { message?: { content?: ContentBlock[] }; content?: ContentBlock[] } | undefined
      const text = contentToText(data?.message?.content ?? data?.content)
      if (text.trim()) return text
    }
    return ''
  }

  /** Bounded telemetry for the exact agent behind a handle. */
  private async snapshotAgent(agent: AgentLike | undefined): Promise<OrbitTelemetry> {
    if (!agent) return { status: 'unknown' }
    const events = agent.session?.snapshotEvents?.() ?? []
    const openCalls = new Map<string, { name: string; at?: number }>()
    let turnCount = 0
    let toolCount = 0
    let lastAssistant = ''
    let lastEventAt: number | undefined
    let lastAssistantAt: number | undefined
    let lastTurnStartAt: number | undefined
    for (const event of events) {
      if (typeof event.time === 'number') lastEventAt = event.time
      if (event.type === 'turn/start' && typeof event.time === 'number') lastTurnStartAt = event.time
      if (event.type === 'turn/end') turnCount += 1
      if (event.type === 'tool/call') {
        toolCount += 1
        const data = event.data as { callId?: string; name?: string } | undefined
        if (data?.callId) openCalls.set(data.callId, { name: data.name ?? 'unknown', ...(typeof event.time === 'number' ? { at: event.time } : {}) })
      }
      if (event.type === 'tool/result') {
        const data = event.data as {
          callId?: string
          message?: { content?: Array<{ toolCallId?: string }> }
        } | undefined
        const callId = data?.callId ?? data?.message?.content?.find((block) => block.toolCallId)?.toolCallId
        if (callId) openCalls.delete(callId)
      }
      if (event.type === 'assistant/message') {
        const data = event.data as { message?: { content?: ContentBlock[] }; content?: ContentBlock[] } | undefined
        const text = contentToText(data?.message?.content ?? data?.content)
        if (text.trim()) {
          lastAssistant = text
          if (typeof event.time === 'number') lastAssistantAt = event.time
        }
      }
    }
    const currentTool = [...openCalls.values()].pop()
    const now = this.nowFn()
    const age = (value: number | undefined): number | undefined => value === undefined ? undefined : Math.max(0, now - value)
    return {
      status: agent.status ?? 'unknown',
      activity_state: agent.status ?? 'unknown',
      turn_count: turnCount,
      tool_count: toolCount,
      ...(currentTool ? { current_tool: currentTool.name } : {}),
      ...(age(lastEventAt) === undefined ? {} : { last_event_age_ms: age(lastEventAt) }),
      ...(age(currentTool?.at) === undefined ? {} : { current_tool_age_ms: age(currentTool?.at) }),
      ...(age(lastAssistantAt) === undefined ? {} : { last_assistant_age_ms: age(lastAssistantAt) }),
      ...(agent.status === 'running' && age(lastTurnStartAt) !== undefined ? { turn_age_ms: age(lastTurnStartAt) } : {}),
      ...(lastAssistant ? { recent_output: truncateSafe(lastAssistant, 1500) } : {}),
    }
  }

  async interruptRole(handle: RoleHandle, reason: string): Promise<void> {
    if (handle.cancel) {
      await handle.cancel(reason)
      return
    }
    if (handle.childId) await this.interruptPersistentChild(handle.childId, reason)
  }

  async releaseRole(handle: RoleHandle): Promise<void> {
    if (handle.dispose) {
      await handle.dispose()
      return
    }
    if (handle.childId) {
      const parent = this.childParents.get(handle.childId)
      if (parent) await this.drainPersistentChild(parent, handle.childId)
    }
  }

  hasTool(name: string): boolean {
    if (name === ORBIT_COMMANDER_DECISION_TOOL || name === ORBIT_RUN_COMPLETE_TOOL) return true
    // Standard profiles mount their tool composition on the agent plane
    // (agent presets), so the visible set must resolve against the initiating
    // agent's scope. Without an initiator this falls back to the global view.
    const agent = this.ctx.agents.currentInitiator()
    return this.ctx.tools.get(name, agent) !== undefined
  }

  async validateRoutes(routes: Readonly<Record<string, OrbitRoute>>, signal?: AbortSignal): Promise<string[]> {
    const issues: string[] = []
    const labels: Record<string, string> = { commander: '指挥官', executor: '执行员', watchdog: '监控模型' }
    for (const [role, route] of Object.entries(routes)) {
      const label = labels[role] ?? role
      try {
        const llm = this.ctx.reflect.get('llm') as LlmRuntime | undefined
        if (!llm) throw new Error('DSH LLM registry 不可用')
        const deadline = AbortSignal.timeout(10_000)
        const activeSignal = signal ? AbortSignal.any([signal, deadline]) : deadline
        const info = await llm.resolveModelInfo(route.provider, route.model, activeSignal)
        const catalog = await llm.listModels(route.provider)
        if (catalog.length > 0 && !catalog.some((entry) => entry.id === route.model)) {
          issues.push(`${label}：ORBIT_MODEL_UNAVAILABLE (${route.provider}/${route.model})，当前模型目录中不存在，请重新选择。`)
          continue
        }
        if (route.reasoningEffort !== undefined) {
          const efforts = info.reasoning?.efforts ?? []
          if (!efforts.some((effort) => effort.id === route.reasoningEffort)) {
            issues.push(`${label}：ORBIT_REASONING_EFFORT_UNAVAILABLE (${route.provider}/${route.model}/${route.reasoningEffort})，当前模型未声明此推理等级。`)
          }
        }
      } catch (error) {
        issues.push(`${label}：ORBIT_MODEL_UNAVAILABLE (${route.provider}/${route.model})，当前不可用，请重新选择：${truncateSafe(error instanceof Error ? error.message : String(error), 200)}`)
      }
    }
    return issues
  }

  isMutationAuthorized(agent: unknown, cwd: string, tool: string): boolean {
    const id = String((agent as { id?: unknown } | undefined)?.id ?? '')
    const grant = this.childGrants.get(id)
    const parent = this.childParents.get(id)
    return grant?.role === 'executor' && grant.workspace === resolve(cwd) && grant.tools.has(tool)
      && !this.interruptedChildren.has(id) && this.ctx.agents.get(SessionId(id)) === agent
      && parent !== undefined && this.ctx.agents.isOwnedBy(SessionId(id), parent)
  }

  async revokeWorkspace(cwd: string): Promise<void> {
    const ids = [...this.childGrants].filter(([, grant]) => grant.workspace === resolve(cwd)).map(([id]) => id)
    for (const id of ids) {
      const parent = this.childParents.get(id)
      await this.interruptPersistentChild(id, 'ORBIT_WORKSPACE_RELEASED')
      if (parent) await this.drainPersistentChild(parent, id)
    }
  }

  /**
   * Mutation ownership is about top-level autonomous drivers, not about every
   * running agent. The calling parent, Orbit's own children, and ordinary
   * conversational/read-only agents are never competitors. Goal is the one
   * DSH-native driver with a readable active state; ralph/workflow are blocked
   * at tool start by the Orbit mutation guard.
   */
  async otherMutationDrivers(cwd: string): Promise<string[]> {
    const drivers: string[] = []
    const initiator = this.ctx.agents.currentInitiator()
    // `ctx.reflect.get` is the official service lookup that does not require an
    // inject declaration, so Orbit stays loadable in profiles without dsh-goal.
    const reflect = (this.ctx as unknown as { reflect?: { get(name: string, strict?: boolean): unknown } }).reflect
    const goals = reflect?.get('goals') as GoalsLike | undefined
    const agents = this.ctx.agents.list?.() ?? (initiator ? [initiator] : [])
    for (const candidate of agents) {
      if (!goals || resolve(candidate.session.header.cwd ?? process.cwd()) !== resolve(cwd) || this.ownedChildren.has(String(candidate.id))) continue
      try {
        const goal = goals.get(candidate)
        if (goal?.phase === 'active' && !drivers.includes('goal')) drivers.push('goal')
      } catch {
        // goal service is present but not readable for this initiator
      }
    }
    return drivers
  }

  changedFiles(cwd: string): string[] {
    try {
      const output = execFileSync('git', ['-C', cwd, 'status', '--porcelain'], {
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      return output
        .split('\n')
        .map((line) => line.slice(3).trim())
        .filter((line) => line.length > 0 && !line.startsWith('.cx/'))
    } catch {
      return []
    }
  }
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new Error('ORBIT_ABORTED'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
