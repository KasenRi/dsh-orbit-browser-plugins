/**
 * Deterministic `/agent-orbit` activation.
 *
 * Two routes converge on the same tiny pre-step directive:
 * - a closed-namespace DSH host command for surfaces with command adjudication
 *   (the Web GUI slash menu), and
 * - a strict genuine-user-message gesture boundary for headless/CLI surfaces
 *   without one.
 *
 * Neither route creates an execution entry of its own: the directive only
 * states that activation is explicit, and the existing `orbit_controller`
 * tool + `OrbitService` + Supervisor remain the sole Orbit runtime.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'

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
 * Install the gesture boundary. It runs for every proposed step and injects
 * the activation directive once, for the step that carries the genuine user
 * message. The in-step guard keeps a step that already holds an Orbit
 * directive from gaining a second one, without any durable state.
 */
export function installOrbitGestureBoundary(ctx: Context): void {
  ctx.on('agent/pre-step', async ({ messages, signal }, next): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    if (decision.messages.some((message) => message.source.kind === 'orbit-command')) return decision
    const activation = invokedOrbitActivation(messages)
    if (activation === undefined) return decision
    signal.throwIfAborted()
    return {
      kind: 'enter',
      messages: [
        ...decision.messages,
        createUserMessage({
          content: [{ type: 'text', text: buildOrbitActivationDirective(activation.goal) }],
          source: { kind: 'orbit-command', ...(activation.goal === '' ? {} : { goal: activation.goal }) },
        }),
      ],
    }
  })
}
