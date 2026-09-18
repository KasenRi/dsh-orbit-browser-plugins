import { existsSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { GuardCode, GuardDisposition } from './types.ts'

export interface GuardIntent {
  github_allowed?: boolean
}

export type GuardDecision =
  | { allowed: true }
  | { allowed: false; code: GuardCode; reason: string; disposition: GuardDisposition }

const GITHUB_REMOTE_PATTERNS: readonly RegExp[] = [
  /\bgit\s+push\b/i,
  /\bgh\s+pr\s+(?:create|edit|merge)\b/i,
  /\bgh\s+issue\s+(?:create|edit|close|comment|delete)\b/i,
  /\bgh\s+pr\s+(?:comment|close|reopen|ready|review)\b/i,
  /\bgh\s+workflow\s+(?:run|disable|enable)\b/i,
  /\bgh\s+release\s+(?:create|delete|edit|upload)\b/i,
  /\bgit\s+remote\s+(?:set-url|add|remove)\b/i,
]

const DANGEROUS_PATTERNS: ReadonlyArray<[GuardCode, RegExp, string]> = [
  ['destructive_operation', /\brm\s+-[A-Za-z]*r[A-Za-z]*f|\brm\s+-rf\b/i, '递归强制删除'],
  ['destructive_operation', /\bgit\s+reset\s+--hard\b|\bgit\s+clean\s+-[A-Za-z]*f/i, '不可逆的 git reset/clean'],
  ['production_operation', /\bdrop\s+database\b|\b(?:drop|truncate)\s+(?:table|schema)\b/i, '不可逆的数据库操作'],
  [
    'production_operation',
    /\b(?:production|prod)\b.*\b(?:deploy|migrate|database|restart)\b|\b(?:deploy|migrate)\b.*\b(?:production|prod)\b/i,
    '生产环境操作',
  ],
  [
    'production_operation',
    /\b(?:kubectl|helm)\s+(?:apply|delete|upgrade|rollback)\b|\bterraform\s+apply\b|\bdocker\s+push\b/i,
    '部署或远程 registry 写入',
  ],
  ['production_operation', /\b(?:alembic|prisma|sequelize|rails)\b.*\b(?:upgrade|migrate|db:migrate)\b/i, '数据库迁移'],
  ['production_operation', /\b(?:ufw|iptables)\b.*\b(?:allow|insert|append)\b|\bdocker\s+run\b.*\s-p\s/i, '暴露公共网络端口'],
  ['secret_operation', /\b(?:cat|less|more|head|tail)\b[^\n]*(?:\.env|secret|credential|auth\.json|cookie)/i, '输出凭证或敏感信息'],
  ['secret_operation', /\b(?:curl|wget)\b[^\n]*(?:Authorization|Bearer|api[_-]?key|token)=?/i, '携带凭证的网络请求'],
]

const SENSITIVE_ENV_NAME = /(?:^|_)(?:KEY|TOKEN|PASSWORD|PASSWD|SECRET|COOKIE|AUTH|CREDENTIAL|PRIVATE_KEY|ACCESS_TOKEN|REFRESH_TOKEN)(?:_|$)/i

const DURABLE_STATE_PATH = /(?:^|[\s/'"])(?:\.\/)?\.cx(?:[/'"\s]|$)/i
const DURABLE_STATE_REDIRECTION = /(?:^|[\s;&|])(?:\d+)?>>?\s*["']?(?:[^\s"']*\/)?\.cx(?:[/'"\s]|$)/i
const DURABLE_STATE_WRITE_COMMAND = /\b(?:tee|touch|mkdir|install|cp|mv|rm|rmdir|truncate|dd)\b/i
const DURABLE_STATE_IN_PLACE_COMMAND = /\b(?:sed|perl)\b[^\n]*\s-[^\n]*\bi\b/i
const DURABLE_STATE_WRITE_API = /\b(?:write(?:File|_text)?|write_text|writeFileSync)\s*\(|\bopen\s*\([^,]+,\s*["'][^"']*(?:w|a|x|\+)[^"']*["']/i

function block(code: GuardCode, reason: string, disposition: GuardDisposition = 'block_continue'): GuardDecision {
  return { allowed: false, code, reason, disposition }
}

function looksLikeEnvSecret(command: string): boolean {
  const trimmed = command.trim()
  if (!trimmed) return false
  const envBare = /^(?:env|printenv)\s*$/i.test(trimmed)
  const printenvTarget = /\bprintenv\s+([A-Za-z_][A-Za-z0-9_]*)/i.exec(trimmed)
  if (envBare) return true
  if (printenvTarget && SENSITIVE_ENV_NAME.test(printenvTarget[1] ?? '')) return true
  const envAssign = /\benv\s+((?:[A-Za-z_][A-Za-z0-9_]*=\S*\s*)+)/i.exec(trimmed)
  if (envAssign) {
    const pairs = envAssign[1] ?? ''
    const names = [...pairs.matchAll(/([A-Za-z_][A-Za-z0-9_]*)=/g)].map((match) => match[1] ?? '')
    const hasSecret = names.some((name) => SENSITIVE_ENV_NAME.test(name))
    const tail = trimmed.slice(envAssign.index + envAssign[0].length).trim()
    const onlyAssignments = tail.length === 0
    if (hasSecret && (onlyAssignments || tail.length > 0)) return true
    // `env TMPDIR=/tmp npm test` stays allowed: assignment names are not sensitive.
    return false
  }
  return false
}

function isDurableStateWrite(command: string): boolean {
  if (DURABLE_STATE_REDIRECTION.test(command)) return true
  if (!DURABLE_STATE_PATH.test(command)) return false
  if (DURABLE_STATE_WRITE_COMMAND.test(command)) return true
  if (DURABLE_STATE_IN_PLACE_COMMAND.test(command)) return true
  if (DURABLE_STATE_WRITE_API.test(command)) return true
  return false
}

/** Guard a bash command string. Order matters and mirrors the Pi CX (now Orbit) reference contract. */
export function guardBashCommand(command: string, intent: GuardIntent = {}): GuardDecision {
  const trimmed = command.trim()
  if (!trimmed) return { allowed: true }

  if (intent.github_allowed !== true) {
    for (const pattern of GITHUB_REMOTE_PATTERNS) {
      if (pattern.test(trimmed)) return block('github_remote_write', `未授权 GitHub 远程写入：${pattern.source}`)
    }
  }

  if (isDurableStateWrite(trimmed)) {
    return block('durable_state_write', '只有 Orbit controller 可以写入 .cx 持久状态。')
  }

  if (looksLikeEnvSecret(trimmed)) {
    return block('secret_operation', '不允许读取或导出敏感凭证。')
  }
  if (/^\s*export\s+[A-Za-z_][A-Za-z0-9_]*\s*=/i.test(trimmed)) {
    const assignment = /^\s*export\s+([A-Za-z_][A-Za-z0-9_]*)\s*=/i.exec(trimmed)
    if (assignment && SENSITIVE_ENV_NAME.test(assignment[1] ?? '')) {
      return block('secret_operation', '不允许导出敏感环境变量。')
    }
  }
  if (/^\s*set\s+[A-Za-z_][A-Za-z0-9_]*=/i.test(trimmed)) {
    const assignment = /^\s*set\s+([A-Za-z_][A-Za-z0-9_]*)\s*=/i.exec(trimmed)
    if (assignment && SENSITIVE_ENV_NAME.test(assignment[1] ?? '')) {
      return block('secret_operation', '不允许设置敏感环境变量。')
    }
  }

  for (const [code, pattern, reason] of DANGEROUS_PATTERNS) {
    if (pattern.test(trimmed)) return block(code, reason)
  }

  return { allowed: true }
}

export interface ToolPathGuardDeps {
  cwd: string
  realpath?: (path: string) => string
}

const WRITE_FILE_TOOLS = new Set(['write', 'edit', 'str_replace_editor'])

export function guardToolPath(toolName: string, targetPath: unknown, deps: ToolPathGuardDeps): GuardDecision {
  if (!WRITE_FILE_TOOLS.has(toolName)) return { allowed: true }
  if (typeof targetPath !== 'string' || targetPath.length === 0) return { allowed: true }
  const cwd = deps.cwd
  const absolute = isAbsolute(targetPath) ? targetPath : resolve(cwd, targetPath)
  if (isInsideDurableState(absolute, cwd)) {
    return block('durable_state_write', '只有 Orbit controller 可以写入 .cx 持久状态。')
  }
  const realpath = deps.realpath ?? safeRealpath
  if (isInsideDurableState(realpathWithin(absolute, realpath), cwd)) {
    return block('durable_state_write', '只有 Orbit controller 可以写入 .cx 持久状态（已解析符号链接）。')
  }
  return { allowed: true }
}

function isInsideDurableState(absolute: string, cwd: string): boolean {
  const stateRoot = resolve(cwd, '.cx')
  const rel = relative(stateRoot, absolute)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function realpathWithin(absolute: string, realpath: (path: string) => string): string {
  let current = absolute
  while (!existsSync(current) && dirname(current) !== current) {
    current = dirname(current)
  }
  try {
    const real = realpath(current)
    return join(real, relative(current, absolute))
  } catch {
    return absolute
  }
}

function safeRealpath(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

export function guardReason(decision: Extract<GuardDecision, { allowed: false }>): string {
  return `Orbit 安全护栏阻断当前调用 (${decision.code})：${decision.reason}`
}
