/**
 * Deterministic Orbit activation.
 *
 * - `/agent-orbit` (host command or genuine-message gesture) keeps its explicit
 *   directive; the existing `orbit_controller` tool + `OrbitService` remain the
 *   runtime.
 * - A Session whose toggle is ON hands every ordinary user message straight to
 *   `OrbitService`: the pre-step boundary consumes the turn (no parent model
 *   call, no parent mutation) and the host starts or resumes the run. The model
 *   never decides whether Orbit runs.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type { Session } from '@deepseek-ai/dsh-session'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { ORBIT_TOGGLE_COMMAND, parseOrbitToggle } from './session-state.ts'

export const AGENT_ORBIT_COMMAND = 'agent-orbit'

/** Strict gesture: the command must begin a genuine user message line. */
const GESTURE = /^\/agent-orbit(?=$|[\t\n\r ])/u

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'orbit-command': {
      readonly kind: 'orbit-command'
      /** Goal exactly as extracted from the `/agent-orbit` message, when present. */
      readonly goal?: string
    }
  }
}

export interface OrbitActivation {
  /** Raw goal text after the command prefix; `''` when the user sent no goal. */
  goal: string
}

/** Parse one text block as a `/agent-orbit` activation. */
export function parseOrbitActivation(text: string): OrbitActivation | undefined {
  const trimmed = text.trimStart()
  if (!GESTURE.test(trimmed)) return undefined
  return { goal: trimmed.slice(AGENT_ORBIT_COMMAND.length + 1).trim() }
}

/** Find the newest genuine user message that invokes `/agent-orbit`. */
export function invokedOrbitActivation(messages: readonly UserMessage[]): OrbitActivation | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message === undefined || message.source.kind !== 'user') continue
    for (const block of message.content) {
      if (block.type !== 'text') continue
      const activation = parseOrbitActivation(block.text)
      if (activation !== undefined) return activation
    }
  }
  return undefined
}

/** The newest genuine user message text, as the implicit activation's goal. */
export function invokedOrbitMessage(messages: readonly UserMessage[]): OrbitActivation | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message === undefined || message.source.kind !== 'user') continue
    const text = message.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
      .trim()
    if (text !== '') return { goal: text }
  }
  return undefined
}

/**
 * The one deterministic directive injected for an explicit activation. It only
 * states the activation and carries the goal verbatim; every Orbit rule still
 * comes from the existing tool, service and protocol.
 */
export function buildOrbitActivationDirective(goal: string): string {
  const lines = [
    'Orbit activation is explicit for this turn. Start or resume Orbit through the existing orbit_controller tool; do not ask the user to confirm the mode.',
    'Treat the text following /agent-orbit as the requested goal, without summarizing or rewriting it.',
  ]
  lines.push(
    goal === ''
      ? 'No goal was provided — ask the user what Orbit should accomplish; do not start an empty run.'
      : `Goal: ${goal}`,
  )
  return lines.join('\n')
}

/**
 * Register the closed-namespace `/agent-orbit` host command.
 *
 * The handler never injects a directive itself. It reposts the original
 * command line as a genuine user message, so the gesture boundary stays the
 * only activation point and a command-registered surface cannot double
 * activate through both routes.
 */
export function registerOrbitCommand(ctx: Context): void {
  ctx.effect(
    () =>
      ctx.commands.register({
        name: AGENT_ORBIT_COMMAND,
        description: 'Run a goal with Orbit deterministic engineering orchestration',
        input: { hint: 'Describe the engineering goal for Orbit' },
        handler(invocation: CommandInvocation): CommandResult {
          const goal = invocation.rawInput.trim()
          if (goal === '') {
            return { kind: 'error', text: `Usage: /${AGENT_ORBIT_COMMAND} <goal> — 请输入要交给 Orbit 完成的任务。` }
          }
          invocation.agent.followup(
            createUserMessage({
              content: [{ type: 'text', text: `/${AGENT_ORBIT_COMMAND}${invocation.rawInput}` }],
              source: { kind: 'user' },
            }),
          )
          return { kind: 'success', text: 'Orbit activated — the existing supervisor will handle this goal.' }
        },
      }),
    'dsh-orbit: /agent-orbit host command',
  )
}

/**
 * Register the `/orbit-toggle on|off` host command.
 *
 * The command writes nothing itself: the commands runtime logs its own
 * `command/run` record, and the `orbitSession` projection folds that record
 * into the per-Session state the toggle UI reads. Registering it also gives
 * CLI surfaces the same switch.
 */
export function registerOrbitToggleCommand(ctx: Context): void {
  ctx.effect(
    () =>
      ctx.commands.register({
        name: ORBIT_TOGGLE_COMMAND,
        description: 'Turn the per-chat Orbit default on or off without starting a run',
        input: { hint: 'on or off' },
        handler(invocation: CommandInvocation): CommandResult {
          const enabled = parseOrbitToggle(invocation.rawInput)
          if (enabled === undefined) {
            return { kind: 'error', text: `Usage: /${ORBIT_TOGGLE_COMMAND} on|off — 请输入 on 或 off。` }
          }
          return {
            kind: 'success',
            text: enabled
              ? 'Orbit is on for this chat — ordinary messages will enter Orbit.'
              : 'Orbit is off for this chat — ordinary messages stay native.',
          }
        },
      }),
    'dsh-orbit: /orbit-toggle host command',
  )
}

export interface OrbitGestureBoundaryOptions {
  /** Whether the current Session defaults ordinary messages into Orbit. */
  sessionEnabled?: (session: Session) => boolean
  /**
   * Host-side activation for an enabled Session's ordinary message: start or
   * resume the existing `OrbitService`. Returns only after the run settles, so
   * the consumed turn owns exactly one mutation driver.
   */
  activate?: (agent: Agent, goal: string, signal: AbortSignal) => Promise<void>
}

/**
 * Install the gesture boundary. It runs for every proposed step.
 *
 * An explicit `/agent-orbit` always wins and always activates, whatever the
 * Session toggle says: it keeps the existing activation directive and the
 * `orbit_controller` tool. Otherwise, an enabled Session hands the ordinary
 * user message to Orbit directly — the step is consumed with no model call and
 * the message stays in the conversation as durable history.
 */
export function installOrbitGestureBoundary(ctx: Context, options: OrbitGestureBoundaryOptions = {}): void {
  ctx.on('agent/pre-step', async ({ agent, messages, signal }, next): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    if (decision.messages.some((message) => message.source.kind === 'orbit-command')) return decision

    const explicit = invokedOrbitActivation(messages)
    if (explicit !== undefined) {
      signal.throwIfAborted()
      return {
        kind: 'enter',
        messages: [
          ...decision.messages,
          createUserMessage({
            content: [{ type: 'text', text: buildOrbitActivationDirective(explicit.goal) }],
            source: { kind: 'orbit-command', ...(explicit.goal === '' ? {} : { goal: explicit.goal }) },
          }),
        ],
      }
    }

    if (options.sessionEnabled?.(agent.session) !== true) return decision
    const ordinary = invokedOrbitMessage(messages)
    const activate = options.activate
    if (ordinary === undefined || activate === undefined) return decision

    signal.throwIfAborted()
    // The claimed batch enters the conversation exactly once: the loop commits
    // `decision.messages`, which this path leaves empty.
    for (const message of messages) agent.session.append('user/message', message, { surfaceOp: 'append' })
    await activate(agent, ordinary.goal, signal)
    return { kind: 'enter', messages: [] }
  })
}
