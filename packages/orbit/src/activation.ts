/**
 * Deterministic Orbit activation.
 *
 * Both entry points hand control to the host runtime directly:
 * - an explicit `/agent-orbit <goal>` statement (host command or genuine
 *   message), whatever the Session toggle says, and
 * - every ordinary user message in a Session whose toggle is ON.
 *
 * The pre-step boundary consumes the turn (no parent model call, no parent
 * mutation) and starts or resumes the existing `OrbitService`; the same
 * `orbit_controller` tool + Supervisor remain the only runtime.
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
 * Register the closed-namespace `/agent-orbit` host command.
 *
 * The handler never runs Orbit itself. It reposts the original command line as
 * a genuine user message, so the gesture boundary stays the only activation
 * point and a command-registered surface cannot double activate through both
 * routes.
 */
export function registerOrbitCommand(ctx: Context): void {
  ctx.effect(
    () =>
      ctx.commands.register({
        name: AGENT_ORBIT_COMMAND,
        description: '使用 Orbit 确定性工程编排执行目标',
        input: { hint: '描述要交给 Orbit 完成的工程目标' },
        handler(invocation: CommandInvocation): CommandResult {
          const goal = invocation.rawInput.trim()
          if (goal === '') {
            return { kind: 'error', text: `用法：/${AGENT_ORBIT_COMMAND} <goal>，请输入任务。` }
          }
          invocation.agent.followup(
            createUserMessage({
              content: [{ type: 'text', text: `/${AGENT_ORBIT_COMMAND}${invocation.rawInput}` }],
              source: { kind: 'user' },
            }),
          )
          return { kind: 'success', text: 'Orbit 已激活，现有 Supervisor 将处理此目标。' }
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
        description: '启用或关闭本会话 Orbit，不启动 Run',
        input: { hint: '请输入 on 或 off' },
        handler(invocation: CommandInvocation): CommandResult {
          const enabled = parseOrbitToggle(invocation.rawInput)
          if (enabled === undefined) {
            return { kind: 'error', text: `用法：/${ORBIT_TOGGLE_COMMAND} on|off，请输入 on 或 off。` }
          }
          return {
            kind: 'success',
            text: enabled
              ? '本会话 Orbit 已启用，普通消息将进入 Orbit。'
              : '本会话 Orbit 已关闭，普通消息使用原生执行方式。',
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
   * Host-side activation: start or resume the existing `OrbitService`. Returns
   * only after the run settles, so the consumed turn owns exactly one mutation
   * driver.
   */
  activate?: (agent: Agent, goal: string, position: { turn: number; step: number }, signal: AbortSignal) => Promise<void>
}

/**
 * Install the activation boundary. It runs for every proposed step.
 *
 * An explicit `/agent-orbit <goal>` always wins and always activates, whatever
 * the Session toggle says. Otherwise, an enabled Session hands the ordinary
 * user message to Orbit. Either way the step is consumed with no parent model
 * call while the message stays in the conversation as durable history.
 */
export function installOrbitGestureBoundary(ctx: Context, options: OrbitGestureBoundaryOptions = {}): void {
  ctx.on('agent/pre-step', async (payload, next): Promise<PreStepDecision> => {
    const { agent, messages, signal } = payload
    const decision = await next()
    if (decision.kind === 'reject') return decision

    const explicit = invokedOrbitActivation(messages)
    const goal = explicit !== undefined
      ? explicit.goal
      : options.sessionEnabled?.(agent.session) === true
        ? invokedOrbitMessage(messages)?.goal
        : undefined
    const activate = options.activate
    if (goal === undefined || goal === '' || activate === undefined) return decision

    signal.throwIfAborted()
    // The claimed batch enters the conversation exactly once: the loop commits
    // `decision.messages`, which this path leaves empty.
    for (const message of messages) agent.session.append('user/message', message, { surfaceOp: 'append' })
    await activate(agent, goal, { turn: payload.turn, step: payload.step }, signal)
    return { kind: 'enter', messages: [] }
  })
}
