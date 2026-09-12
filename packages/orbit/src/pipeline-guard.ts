import { guardBashCommand, guardReason, guardToolPath } from './guard.ts'
import type { OrbitService } from './service.ts'

const WRITE_PATH_TOOLS = new Set(['write', 'edit', 'str_replace_editor'])

/** Top-level autonomous mutation drivers that must not run beside an active Orbit run. */
export const MUTATION_DRIVER_TOOLS = new Set(['create_goal', 'ralph', 'workflow'])

/** Canonical and legacy controller tool names. */
export const ORBIT_CONTROLLER_TOOLS = new Set(['orbit_controller', 'cx_controller'])

export interface GuardExecLike {
  name: string
  arguments?: unknown
  agent?: { session?: { header?: { cwd?: string } } }
}

export type PreExecuteDecision = { kind: 'allow' } | { kind: 'deny'; reason: string }

export interface OrbitPreExecuteOptions {
  /** Returns the name of a competing top-level mutation driver for this agent, if any. */
  competingDriver?: (agent: GuardExecLike['agent']) => string | undefined
}

/**
 * The Orbit recoverable tool guard plus mutation-driver mutual exclusion.
 *
 * Recovery contract: a denial blocks only this one tool call; the agent turn and
 * the Orbit phase continue. Mutation exclusion, by contrast, is an ownership fence:
 * Orbit and another top-level autonomous driver must never run in the same project.
 */
export function createOrbitPreExecuteHandler(service: OrbitService, options: OrbitPreExecuteOptions = {}) {
  return async function orbitPreExecute(
    exec: GuardExecLike,
    next: () => Promise<PreExecuteDecision>,
  ): Promise<PreExecuteDecision> {
    const cwd = exec.agent?.session?.header?.cwd ?? process.cwd()
    const active = service.hasActiveRun(cwd)
    const args = (exec.arguments ?? {}) as Record<string, unknown>

    // Orbit owns the workspace: refuse to start another top-level mutation driver.
    if (active && MUTATION_DRIVER_TOOLS.has(exec.name)) {
      return {
        kind: 'deny',
        reason:
          `ORBIT_MUTATION_DRIVER_CONFLICT: an active Orbit run owns this workspace, so ${exec.name} must not start. ` +
          'Resume or stop the Orbit run first, or continue through orbit_controller.',
      }
    }

    // Another driver already owns the workspace: refuse to start Orbit.
    if (!active && ORBIT_CONTROLLER_TOOLS.has(exec.name)) {
      const action = typeof args['action'] === 'string' ? args['action'] : ''
      if (action === 'run' || action === 'start') {
        const competing = options.competingDriver?.(exec.agent)
        if (competing) {
          return {
            kind: 'deny',
            reason: `ORBIT_MUTATION_DRIVER_CONFLICT: ${competing} already owns mutation in this workspace; stop it before starting Orbit.`,
          }
        }
      }
    }

    if (!active) return next()

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

    // The browser tool can write its structured result to a caller path; route
    // that path through the same durable-state policy instead of a second copy.
    if (exec.name === 'agent_browser') {
      const outputPath = args['outputPath']
      if (typeof outputPath === 'string' && outputPath.length > 0) {
        const decision = guardToolPath('write', outputPath, { cwd })
        if (!decision.allowed) {
          const outcome = await service.recordGuardBlock(decision.code, decision.reason, cwd)
          return { kind: 'deny', reason: `${guardReason(decision)} ${outcome.instruction}` }
        }
      }
      return next()
    }

    return next()
  }
}
