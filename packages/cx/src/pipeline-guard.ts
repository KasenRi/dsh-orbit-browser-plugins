import { guardBashCommand, guardReason, guardToolPath } from './guard.ts'
import type { CxService } from './service.ts'

const WRITE_PATH_TOOLS = new Set(['write', 'edit', 'str_replace_editor'])

export interface GuardExecLike {
  name: string
  arguments?: unknown
  agent?: { session?: { header?: { cwd?: string } } }
}

export type PreExecuteDecision = { kind: 'allow' } | { kind: 'deny'; reason: string }

/**
 * The CX recoverable tool guard. It answers only "may this one tool call run?".
 * A denial blocks the single call; the agent turn and CX phase continue.
 */
export function createCxPreExecuteHandler(service: CxService) {
  return async function cxPreExecute(
    exec: GuardExecLike,
    next: () => Promise<PreExecuteDecision>,
  ): Promise<PreExecuteDecision> {
    const cwd = exec.agent?.session?.header?.cwd ?? process.cwd()
    if (!service.hasActiveRun(cwd)) return next()
    const args = (exec.arguments ?? {}) as Record<string, unknown>

    if (exec.name === 'bash') {
      const command = typeof args['command'] === 'string' ? args['command'] : ''
      const decision = guardBashCommand(command, { github_allowed: service.githubAllowed(cwd) })
      if (!decision.allowed) {
        const outcome = await service.recordGuardBlock(decision.code, decision.reason, cwd)
        return { kind: 'deny', reason: `${guardReason(decision)} ${outcome.instruction}` }
      }
      return next()
    }

    if (WRITE_PATH_TOOLS.has(exec.name)) {
      const target = args['path'] ?? args['file_path'] ?? args['filePath']
      const decision = guardToolPath(exec.name, target, { cwd })
      if (!decision.allowed) {
        const outcome = await service.recordGuardBlock(decision.code, decision.reason, cwd)
        return { kind: 'deny', reason: `${guardReason(decision)} ${outcome.instruction}` }
      }
      return next()
    }

    return next()
  }
}
