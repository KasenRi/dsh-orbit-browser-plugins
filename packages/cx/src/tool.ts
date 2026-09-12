import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { CxActionResult } from './types.ts'
import type { CxService } from './service.ts'

export const CX_TOOL_NAME = 'cx_controller'

const TOOL_DESCRIPTION =
  'Drive CX Lite engineering autonomy for the current project. CX runs a deterministic Supervisor ' +
  '(Commander -> Executor -> Smart Watchdog) over a durable .cx/state.json. Use action "run" with a ' +
  'goal to start or continue, "resume" to continue a persisted run, "status" to inspect, "stop" to ' +
  'close the run, and "doctor" to check the environment. Only CX writes .cx durable state.'

interface ToolArgs {
  action: 'run' | 'start' | 'resume' | 'stop' | 'status' | 'doctor'
  goal?: string
  preset?: string
  approved_loop_count?: number
  run_id?: string
  user_hard_constraints?: string[]
  github_allowed?: boolean
}

interface AgentLike {
  session?: { header?: { cwd?: string } }
  ctx?: { cx?: CxService }
}

function summarize(result: CxActionResult): string {
  const lines = [`cx ${result.action}: ok=${result.ok} phase=${result.phase ?? '-'} status=${result.status ?? '-'}`]
  if (result.run_id) lines.push(`run_id: ${result.run_id}`)
  if (result.message) lines.push(`message: ${result.message}`)
  const data = result.data
  if (data) {
    if (data['loop']) lines.push(`loop: ${JSON.stringify(data['loop'])}`)
    if (data['current_step']) lines.push(`current_step: ${JSON.stringify(data['current_step'])}`)
    if (data['last_error']) lines.push(`last_error: ${JSON.stringify(data['last_error'])}`)
    if (Array.isArray(data['plan'])) lines.push(`plan: ${JSON.stringify(data['plan'])}`)
  }
  return lines.join('\n')
}

export function createCxTool(ctx: Context) {
  return defineTool({
    name: CX_TOOL_NAME,
    description: TOOL_DESCRIPTION,
    parameters: {
      action: { type: 'string', required: true, enum: ['run', 'start', 'resume', 'stop', 'status', 'doctor'] },
      goal: { type: 'string', description: 'The engineering goal (required for run/start).' },
      preset: { type: 'string', description: 'Run preset id.' },
      approved_loop_count: { type: 'integer', description: 'Explicit loop budget (positive, <= 10).' },
      run_id: { type: 'string', description: 'Target run id for resume/stop.' },
      user_hard_constraints: { type: 'array', items: { type: 'string' } },
      github_allowed: { type: 'boolean', description: 'Allow GitHub remote writes for this run.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => {
        const result = value as unknown as CxActionResult
        return [{ type: 'text', text: summarize(result) }] satisfies ContentBlock[]
      },
    },
    async execute(args, exec) {
      const agent = exec.agent as AgentLike | undefined
      const service = agent?.ctx?.cx ?? (ctx as Context & { cx?: CxService }).cx
      if (!service) throw new Error('cx service is unavailable; dsh-cx is not loaded.')
      const cwd = agent?.session?.header?.cwd ?? process.cwd()
      const input = {
        ...(args.goal !== undefined ? { goal: args.goal } : {}),
        ...(args.preset !== undefined ? { preset: args.preset } : {}),
        ...(args.approved_loop_count !== undefined ? { approved_loop_count: args.approved_loop_count } : {}),
        ...(args.run_id !== undefined ? { run_id: args.run_id } : {}),
        ...(args.user_hard_constraints !== undefined ? { user_hard_constraints: args.user_hard_constraints } : {}),
        ...(args.github_allowed !== undefined ? { github_allowed: args.github_allowed } : {}),
      }
      if (args.action === 'status') return (await service.status(cwd)) as unknown as JsonValue
      if (args.action === 'stop') return service.stop(args.run_id, cwd) as unknown as JsonValue
      if (args.action === 'doctor') return (await service.doctor(cwd)) as unknown as JsonValue
      if (args.action === 'resume') return (await service.resume(input, cwd, exec.signal)) as unknown as JsonValue
      return (await service.run(input, cwd, exec.signal)) as unknown as JsonValue
    },
  })
}
