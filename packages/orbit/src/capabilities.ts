import type { OrbitCapability } from './types.ts'

export const EXECUTOR_READ_ONLY_TOOLS = ['read', 'read_image', 'glob', 'grep'] as const
export const FILESYSTEM_TOOLS = ['write', 'edit', 'str_replace_editor'] as const
export const SHELL_TOOLS = ['bash'] as const
export const WEB_TOOLS = ['web_search', 'web_fetch'] as const
export const READ_ONLY_ROLE_TOOLS = [...EXECUTOR_READ_ONLY_TOOLS, ...WEB_TOOLS] as const

const READ_ONLY_SET = new Set<string>(EXECUTOR_READ_ONLY_TOOLS)

/** Deterministically map bounded capability ids to tool names. */
export function executorToolsFor(
  capabilities: readonly OrbitCapability[],
  browserTools: readonly string[],
  configuredReadOnly: readonly string[] = EXECUTOR_READ_ONLY_TOOLS,
): string[] {
  const tools = configuredReadOnly.filter((tool) => READ_ONLY_SET.has(tool))
  if (capabilities.includes('filesystem')) tools.push(...FILESYSTEM_TOOLS)
  if (capabilities.includes('shell')) tools.push(...SHELL_TOOLS)
  if (capabilities.includes('web')) tools.push(...WEB_TOOLS)
  if (capabilities.includes('browser')) tools.push(...browserTools)
  return [...new Set(tools)]
}

/** Tools that can mutate workspace or browser state while Orbit owns it. */
export function mutationTools(browserTools: readonly string[]): ReadonlySet<string> {
  return new Set([...FILESYSTEM_TOOLS, ...SHELL_TOOLS, 'pwsh', 'apply_patch', 'delete_file', 'move_file', ...browserTools])
}
