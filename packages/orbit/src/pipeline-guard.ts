import { guardBashCommand, guardReason, guardToolPath } from './guard.ts'
import type { OrbitService } from './service.ts'
import { mutationTools } from './capabilities.ts'

const WRITE_PATH_TOOLS = new Set(['write', 'edit', 'str_replace_editor'])

/** Top-level autonomous mutation drivers that must not run beside an active Orbit run. */
export const MUTATION_DRIVER_TOOLS = new Set(['create_goal', 'ralph', 'workflow'])

/** Canonical and legacy controller tool names. */
export const ORBIT_CONTROLLER_TOOLS = new Set(['orbit_controller', 'cx_controller'])

export interface GuardExecLike {
  name: string
  arguments?: unknown
  agent?: { id?: unknown; session?: { header?: { cwd?: string } } }
}

export type PreExecuteDecision = { kind: 'allow' } | { kind: 'deny'; reason: string }

export interface OrbitPreExecuteOptions {
  /** Returns the name of a competing top-level mutation driver for this agent, if any. */
  competingDriver?: (agent: GuardExecLike['agent']) => string | undefined
  contentGuards?: boolean
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
    const ownerSessionId = service.ownerSessionIdForAgent(exec.agent)
    const args = (exec.arguments ?? {}) as Record<string, unknown>
    const mutating = mutationTools(service.browserToolNames()).has(exec.name)

    // Orbit owns the workspace: refuse to start another top-level mutation driver.
    if (active && MUTATION_DRIVER_TOOLS.has(exec.name)) {
      return {
        kind: 'deny',
        reason:
          `ORBIT_MUTATION_DRIVER_CONFLICT: 当前 workspace 由 Orbit 持有，不能启动 ${exec.name}。` +
          '请先 resume 或 stop 当前 Run，或通过 orbit_controller 继续。',
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
            reason: `ORBIT_MUTATION_DRIVER_CONFLICT: ${competing} 已持有此 workspace 的修改权，请先停止该 Driver。`,
          }
        }
      }
    }

    if (!active) return next()

    // Runtime ownership fence: only the current Orbit Executor child may use
    // mutation-capable tools in an Orbit-owned workspace.
    if (mutating && !service.isMutationAuthorized(exec.agent, exec.name, cwd)) {
      return {
        kind: 'deny',
        reason: `ORBIT_MUTATION_DRIVER_CONFLICT: 当前 workspace 由 Orbit 持有；只有当前 Orbit Executor 可以调用 ${exec.name}。`,
      }
    }
    if (options.contentGuards === false) return next()

    if (exec.name === 'bash') {
      const command = typeof args['command'] === 'string' ? args['command'] : ''
      const decision = guardBashCommand(command, { github_allowed: service.githubAllowed(cwd, ownerSessionId) })
      if (!decision.allowed) {
        const outcome = await service.recordGuardBlock(decision.code, decision.reason, cwd, ownerSessionId)
        return { kind: 'deny', reason: `${guardReason(decision)} ${outcome.instruction}` }
      }
      return next()
    }

    if (WRITE_PATH_TOOLS.has(exec.name)) {
      const target = args['path'] ?? args['file_path'] ?? args['filePath']
      const decision = guardToolPath(exec.name, target, { cwd })
      if (!decision.allowed) {
        const outcome = await service.recordGuardBlock(decision.code, decision.reason, cwd, ownerSessionId)
        return { kind: 'deny', reason: `${guardReason(decision)} ${outcome.instruction}` }
      }
      return next()
    }

    // The browser tool can write its structured result to a caller path; route
    // that path through the same durable-state policy instead of a second copy.
    if (service.browserToolNames().includes(exec.name)) {
      const outputPath = args['outputPath']
      if (typeof outputPath === 'string' && outputPath.length > 0) {
        const decision = guardToolPath('write', outputPath, { cwd })
        if (!decision.allowed) {
          const outcome = await service.recordGuardBlock(decision.code, decision.reason, cwd, ownerSessionId)
          return { kind: 'deny', reason: `${guardReason(decision)} ${outcome.instruction}` }
        }
      }
      return next()
    }

    return next()
  }
}
