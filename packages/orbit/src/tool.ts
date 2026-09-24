import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { OrbitActionResult } from './types.ts'
import type { OrbitService } from './service.ts'

export const ORBIT_TOOL_NAME = 'orbit_controller'
/** Legacy tool name kept as a backward-compatible alias. */
export const LEGACY_CX_TOOL_NAME = 'cx_controller'

const TOOL_DESCRIPTION =
  '驱动当前项目的 Orbit 工程编排。Orbit 由确定性的 Supervisor 控制 Commander、Executor 和 Smart Watchdog，' +
  '并按 DSH Session 隔离保存持久化状态（.cx/sessions/.../state.json；旧 .cx/state.json 兼容）。使用 action "run" 启动或继续，"resume" 继续持久化运行，"status" 查看当前 Session 状态，' +
  '"stop" 关闭运行，"doctor" 检查环境。只有 Orbit 可以写入 .cx 持久状态。'

const LEGACY_TOOL_DESCRIPTION = `Legacy compatibility alias（兼容旧接口），请优先使用 ${ORBIT_TOOL_NAME}。${TOOL_DESCRIPTION}`

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
  session?: { id?: unknown; header?: { cwd?: string } }
  ctx?: { orbit?: OrbitService; cx?: OrbitService }
}

function summarize(result: OrbitActionResult): string {
  const lines = [`orbit ${result.action}: ok=${result.ok} phase=${result.phase ?? '-'} status=${result.status ?? '-'}`]
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

export interface OrbitToolOptions {
  /** Register the legacy `cx_controller` alias instead of the canonical name. */
  legacy?: boolean
}

/**
 * One tool implementation shared by the canonical `orbit_controller` tool and
 * the legacy `cx_controller` alias. Both names call the same OrbitService.
 */
export function createOrbitTool(ctx: Context, options: OrbitToolOptions = {}) {
  const legacy = options.legacy === true
  return defineTool({
    name: legacy ? LEGACY_CX_TOOL_NAME : ORBIT_TOOL_NAME,
    description: legacy ? LEGACY_TOOL_DESCRIPTION : TOOL_DESCRIPTION,
    parameters: {
      action: { type: 'string', required: true, enum: ['run', 'start', 'resume', 'stop', 'status', 'doctor'] },
      goal: { type: 'string', description: '工程目标，run/start 时必填。' },
      preset: { type: 'string', description: 'Run preset id。' },
      approved_loop_count: { type: 'integer', description: '用户显式批准的 loop 预算，正整数且不超过 10。' },
      run_id: { type: 'string', description: 'resume/stop 的目标 run id。' },
      user_hard_constraints: { type: 'array', items: { type: 'string' } },
      github_allowed: { type: 'boolean', description: '是否允许此 Run 执行 GitHub 远程写入。' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => {
        const result = value as unknown as OrbitActionResult
        return [{ type: 'text', text: summarize(result) }] satisfies ContentBlock[]
      },
    },
    async execute(args, exec) {
      // The service is provided by this plugin's own fiber; reading it through
      // `agent.ctx` would require an inject declaration on the agent scope.
      const scope = ctx as Context & { orbit?: OrbitService; cx?: OrbitService }
      const service = scope.orbit ?? scope.cx
      if (!service) throw new Error('orbit service is unavailable; dsh-orbit is not loaded.')
      const agent = exec.agent as AgentLike | undefined
      const cwd = agent?.session?.header?.cwd ?? process.cwd()
      const ownerSessionId = agent?.session?.id === undefined ? undefined : String(agent.session.id)
      const input = {
        ...(args.goal !== undefined ? { goal: args.goal } : {}),
        ...(args.preset !== undefined ? { preset: args.preset } : {}),
        ...(args.approved_loop_count !== undefined ? { approved_loop_count: args.approved_loop_count } : {}),
        ...(args.run_id !== undefined ? { run_id: args.run_id } : {}),
        ...(args.user_hard_constraints !== undefined ? { user_hard_constraints: args.user_hard_constraints } : {}),
        ...(args.github_allowed !== undefined ? { github_allowed: args.github_allowed } : {}),
      }
      if (args.action === 'status') return (await service.status(cwd, ownerSessionId)) as unknown as JsonValue
      if (args.action === 'stop') return (await service.stop(args.run_id, cwd, ownerSessionId)) as unknown as JsonValue
      if (args.action === 'doctor') return (await service.doctor(cwd)) as unknown as JsonValue
      if (args.action === 'resume') return (await service.resume(input, cwd, exec.signal, ownerSessionId)) as unknown as JsonValue
      return (await service.run(input, cwd, exec.signal, ownerSessionId)) as unknown as JsonValue
    },
  })
}
