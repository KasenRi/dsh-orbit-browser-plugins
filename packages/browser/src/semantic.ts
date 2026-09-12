import type { SemanticActionInput } from './types.ts'

export interface CompileResult {
  ok: true
  args: string[]
}

export interface CompileError {
  ok: false
  message: string
}

export const SEMANTIC_ACTIONS = ['check', 'click', 'fill', 'select'] as const
export const SEMANTIC_LOCATORS = ['alt', 'label', 'placeholder', 'role', 'testid', 'text', 'title'] as const

/**
 * Compile a semantic locator into the upstream agent-browser argv, mirroring the
 * Pi wrapper contract (find-based for locators, direct command for selectors).
 */
export function compileSemanticAction(input: SemanticActionInput): CompileResult | CompileError {
  if (!SEMANTIC_ACTIONS.includes(input.action)) {
    return { ok: false, message: `semanticAction.action must be one of: ${SEMANTIC_ACTIONS.join(', ')}` }
  }
  const prefix = input.session ? ['--session', input.session] : []
  const hasLocator = input.locator !== undefined || input.value !== undefined || input.role !== undefined || input.name !== undefined

  if (input.selector !== undefined && hasLocator) {
    return {
      ok: false,
      message:
        'semanticAction.selector cannot be combined with locator, value, role, or name; use selector for a direct click/check/fill target or locator fields for find-based actions.',
    }
  }

  if (input.action === 'select') {
    if (input.selector === undefined) {
      return { ok: false, message: 'semanticAction select requires a selector.' }
    }
    if (input.locator !== undefined || input.role !== undefined || input.name !== undefined || input.text !== undefined) {
      return { ok: false, message: 'semanticAction select does not accept locator, role, name, or text; use selector plus value/values.' }
    }
    const values = input.values ?? (input.value !== undefined ? [input.value] : [])
    if (values.length === 0) return { ok: false, message: 'semanticAction select requires value or values.' }
    return { ok: true, args: [...prefix, 'select', input.selector, ...values] }
  }

  if (input.selector !== undefined) {
    if (input.action === 'fill') {
      if (!input.text) return { ok: false, message: 'semanticAction fill requires a non-empty text value.' }
      return { ok: true, args: [...prefix, 'fill', input.selector, input.text] }
    }
    return { ok: true, args: [...prefix, input.action, input.selector] }
  }

  const roleLocator = input.locator === 'role' || input.role !== undefined
  if (roleLocator) {
    const role = input.role ?? input.value
    if (!role) return { ok: false, message: 'semanticAction role locator requires role or value.' }
    const trailing: string[] = []
    if (input.name !== undefined) trailing.push('--name', input.name)
    if (input.action === 'fill') {
      if (!input.text) return { ok: false, message: 'semanticAction fill requires a non-empty text value.' }
      return { ok: true, args: [...prefix, 'find', 'role', role, 'fill', ...trailing, input.text] }
    }
    return { ok: true, args: [...prefix, 'find', 'role', role, input.action, ...trailing] }
  }

  if (input.locator === undefined || input.value === undefined) {
    return { ok: false, message: 'semanticAction requires either selector, role/name, or a locator with value.' }
  }
  if (input.action === 'fill') {
    if (!input.text) return { ok: false, message: 'semanticAction fill requires a non-empty text value.' }
    return { ok: true, args: [...prefix, 'find', input.locator, input.value, 'fill', input.text] }
  }
  return { ok: true, args: [...prefix, 'find', input.locator, input.value, input.action] }
}
