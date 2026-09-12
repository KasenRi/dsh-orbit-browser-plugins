/**
 * Secret redaction and protected-state detection for the browser plugin.
 *
 * These rules are intentionally conservative: anything that could carry
 * authenticated browser state or a credential never reaches the model context.
 */

const SENSITIVE_KEY = /^(?:password|passwd|cookie|set-cookie|secret|authorization|bearer|private[_-]?key|api[_-]?key|access[_-]?token|refresh[_-]?token|token|github[_-]?token|gh[_-]?token|client[_-]?secret|credential)$/i

const SENSITIVE_FLAG_VALUE = new Set([
  '--body',
  '--headers',
  '--header',
  '--password',
  '--proxy',
  '--token',
  '--api-key',
  '--cookie',
  '--authorization',
])

const SECRET_TEXT_PATTERNS: ReadonlyArray<RegExp> = [
  /(authorization\s*:\s*(?:bearer\s+)?)[^\s,;]+/gi,
  /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|cookie|secret|private[_-]?key)\s*[=:]\s*)[^\s,;]+/gi,
  /(\b(?:sk|pk|ghp|github_pat)_[A-Za-z0-9_-]{8,})/g,
  /(\bBearer\s+)[A-Za-z0-9._-]+/gi,
]

export function redactText(value: string): string {
  let result = value
  for (const pattern of SECRET_TEXT_PATTERNS) result = result.replace(pattern, '$1[REDACTED]')
  return result
}

export function redactValue(value: unknown, key?: string): unknown {
  if (key !== undefined && SENSITIVE_KEY.test(key)) return '[REDACTED]'
  if (Array.isArray(value)) return value.map((item) => redactValue(item))
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
      out[childKey] = redactValue(childValue, childKey)
    }
    return out
  }
  if (typeof value === 'string') return redactText(value)
  return value
}

/** Redact the value that follows a sensitive global flag while keeping position. */
export function redactArgs(args: readonly string[]): string[] {
  const out = [...args]
  for (let index = 0; index < out.length; index += 1) {
    const token = out[index]
    if (token === undefined) continue
    const equals = token.indexOf('=')
    if (equals > 0) {
      const flag = token.slice(0, equals)
      if (SENSITIVE_FLAG_VALUE.has(flag)) out[index] = `${flag}=[REDACTED]`
      continue
    }
    if (SENSITIVE_FLAG_VALUE.has(token) && index + 1 < out.length) {
      out[index + 1] = '[REDACTED]'
      index += 1
    }
  }
  return out
}

const PROTECTED_STATE_DIR = /(?:^|[/\\%])\.agent-browser(?:[/\\]|%|$)/i
const PROTECTED_CONFIG_ENV = /^AGENT_BROWSER_(?:ACTION_POLICY|CONFIG|DOWNLOAD_PATH|EXECUTABLE_PATH|PROFILE|SCREENSHOT_DIR|SKILLS_DIR|SOCKET_DIR|STATE|EXTENSIONS|INIT_SCRIPTS)$/

export const BLOCKED_STATE_MESSAGE =
  'Browser access to local .agent-browser storage is blocked because state files can contain authenticated cookies and storage. Use guarded state commands instead.'

export const BLOCKED_FILE_ACCESS_MESSAGE =
  'Browser file-access enablement is blocked because a local page could read and exfiltrate authenticated .agent-browser state.'

export const BLOCKED_UPSTREAM_CONFIG_MESSAGE =
  'Upstream agent-browser config is blocked for browser-backed native calls because it can load protected state, profiles, extensions, or file-access settings.'

/** True when an argv token references the protected managed-state directory. */
export function referencesProtectedState(value: string): boolean {
  const decoded = safeDecode(value)
  return PROTECTED_STATE_DIR.test(value) || PROTECTED_STATE_DIR.test(decoded)
}

/** Reject argv that tries to read or redirect protected managed browser state. */
export function findProtectedStateViolation(args: readonly string[]): string | undefined {
  for (const token of args) {
    if (referencesProtectedState(token)) return BLOCKED_STATE_MESSAGE
    if (/^file:/i.test(token)) return BLOCKED_STATE_MESSAGE
    if (token === '--allow-file-access') return BLOCKED_FILE_ACCESS_MESSAGE
    if (token.startsWith('--config=') || token === '--config') return BLOCKED_UPSTREAM_CONFIG_MESSAGE
  }
  return undefined
}

/** Env keys the plugin must not forward from an untrusted caller. */
export function isProtectedEnvKey(key: string): boolean {
  return PROTECTED_CONFIG_ENV.test(key)
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

export function truncateSafe(value: string, max = 4000): string {  const redacted = redactText(value)
  if (redacted.length <= max) return redacted
  return `${redacted.slice(0, max)}\n...[truncated]`
}

/** Strip environment variables that could redirect protected browser state. */
export function sanitizeEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(env)) {
    if (isProtectedEnvKey(key)) continue
    out[key] = value
  }
  return out
}

export function parseAllowedDomains(values: readonly string[]): string[] {
  const entries = values.flatMap((value) => value.split(/[,\s]+/))
  const domains: string[] = []
  for (const raw of entries) {
    let candidate = raw.trim().toLowerCase()
    if (!candidate) continue
    candidate = candidate.replace(/^\.?\*\./, '')
    try {
      candidate = new URL(candidate.includes('://') ? candidate : `https://${candidate}`).hostname
    } catch {
      candidate = candidate.split('/')[0] ?? candidate
    }
    candidate = candidate.replace(/:\d+$/, '').replace(/\.$/, '').replace(/^\./, '')
    if (candidate && !domains.includes(candidate)) domains.push(candidate)
  }
  return domains
}

export function isHostAllowedByDomains(host: string, domains: readonly string[]): boolean {
  const normalized = host.toLowerCase()
  return domains.some((domain) => normalized === domain || normalized.endsWith(`.${domain}`))
}

export interface DomainViolation {
  observedHost: string
  message: string
}

/** Final-URL containment check applied after a navigation appears to succeed. */
export function checkAllowedDomains(url: string | undefined, domains: readonly string[]): DomainViolation | undefined {
  if (!url || domains.length === 0) return undefined
  let host: string
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    return undefined
  }
  if (isHostAllowedByDomains(host, domains)) return undefined
  return {
    observedHost: host,
    message: `Navigation policy blocked: ${domains.join(', ')} does not allow ${host} (${url}).`,
  }
}
