import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { ORBIT_RUN_COMPLETE_TOOL } from './host.ts'
import type { TerminalCompletionSubmission } from './types.ts'

export function createRunCompleteTool(
  capture: (agent: Agent | undefined, submission: TerminalCompletionSubmission) => void,
) {
  return defineTool({
    name: ORBIT_RUN_COMPLETE_TOOL,
    description:
      'Orbit 指挥官最终停机确认工具。仅在 TERMINAL_CONFIRM 阶段提交 COMPLETE 或 NOT_COMPLETE；调用后当前轮次结束。',
    parameters: {
      signal: { type: 'string', required: true, enum: ['COMPLETE', 'NOT_COMPLETE'] },
      reason: { type: 'string' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { accepted: { type: 'boolean', required: true } },
      },
      render: () => [{ type: 'text', text: 'Orbit terminal confirmation accepted.' }] satisfies ContentBlock[],
    },
    async execute(args, exec) {
      capture(exec.agent, args as unknown as TerminalCompletionSubmission)
      exec.concludeTurn()
      return { accepted: true }
    },
  })
}
