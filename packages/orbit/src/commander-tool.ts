import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { ORBIT_COMMANDER_DECISION_TOOL } from './host.ts'
import type { CommanderMode } from './types.ts'

export interface CommanderDecisionSubmission extends Record<string, unknown> {
  mode: CommanderMode
}

export function createCommanderDecisionTool(
  capture: (agent: Agent | undefined, submission: CommanderDecisionSubmission) => void,
) {
  return defineTool({
    name: ORBIT_COMMANDER_DECISION_TOOL,
    description:
      'Orbit 指挥官内部决策提交工具。仅用于提交当前 PLAN / STEP_EVALUATE / FINAL_EVALUATE / STRATEGY_RECONSIDER 的结构化结果；调用后当前轮次结束。',
    parameters: {
      mode: {
        type: 'string',
        required: true,
        enum: ['PLAN', 'STEP_EVALUATE', 'FINAL_EVALUATE', 'STRATEGY_RECONSIDER'],
      },
      summary: { type: 'string' },
      steps: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string' },
            goal: { type: 'string', required: true },
            capabilities: { type: 'array', items: { type: 'string' } },
            execution_mode: { type: 'string', enum: ['SINGLE', 'MOA'] },
          },
        },
      },
      decision: {
        type: 'string',
        enum: ['PASS_CURRENT_STEP', 'CORRECT_CURRENT_STEP', 'APPEND', 'SUCCESS', 'NEEDS_USER', 'KEEP_APPROACH', 'REPLACE_CURRENT_STEP'],
      },
      reason: { type: 'string' },
      next_step_goal: { type: 'string' },
      next_step_capabilities: { type: 'array', items: { type: 'string' } },
      next_step_execution_mode: { type: 'string', enum: ['SINGLE', 'MOA'] },
      next_steps: {
        type: 'array',
        items: {
          oneOf: [
            { type: 'string' },
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                goal: { type: 'string', required: true },
                capabilities: { type: 'array', items: { type: 'string' } },
                execution_mode: { type: 'string', enum: ['SINGLE', 'MOA'] },
              },
            },
          ],
        },
      },
      replacement_goal: { type: 'string' },
      executor_session: { type: 'string', enum: ['KEEP', 'RESET'] },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { accepted: { type: 'boolean', required: true } },
      },
      render: () => [{ type: 'text', text: 'Orbit Commander decision accepted.' }] satisfies ContentBlock[],
    },
    async execute(args, exec) {
      capture(exec.agent, args as unknown as CommanderDecisionSubmission)
      exec.concludeTurn()
      return { accepted: true }
    },
  })
}
