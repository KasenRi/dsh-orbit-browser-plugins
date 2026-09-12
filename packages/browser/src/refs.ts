import type { RefSnapshot } from './types.ts'

const MUTATION_COMMANDS = new Set([
  'click',
  'fill',
  'select',
  'check',
  'uncheck',
  'tap',
  'press',
  'keyboard',
  'scrollintoview',
  'scrollinto',
  'hover',
  'drag',
])

const NAVIGATING_BATCH_COMMANDS = new Set(['open', 'goto', 'navigate', 'reload', 'back', 'forward'])

export interface StaleRefCheck {
  ok: boolean
  category?: 'stale-ref' | 'tab-drift'
  message?: string
  nextActions?: string[]
}

function normalizeComparableUrl(value: string | undefined): string | undefined {
  if (!value) return undefined
  try {
    const url = new URL(value)
    url.hash = ''
    return url.toString()
  } catch {
    return value.split('#')[0]
  }
}

function targetsMatch(left: string | undefined, right: string | undefined): boolean {
  const a = normalizeComparableUrl(left)
  const b = normalizeComparableUrl(right)
  if (!a || !b) return true
  return a === b
}

function refsInArgv(command: string, args: readonly string[]): string[] {
  const found: string[] = []
  if (!MUTATION_COMMANDS.has(command)) return found
  for (const token of args) {
    const match = /^@(e\d+)$/.exec(token)
    if (match) found.push(match[1]!)
  }
  return found
}

/**
 * Page-scoped ref safety. A mutation that targets a @ref is only allowed when the
 * ref came from a still-valid snapshot of the same page.
 */
export function checkRefSafety(
  command: string,
  args: readonly string[],
  snapshot: RefSnapshot | undefined,
  currentTarget: { url?: string } | undefined,
): StaleRefCheck {
  const refs = refsInArgv(command, args)
  if (refs.length === 0) return { ok: true }
  if (!snapshot) {
    return {
      ok: false,
      category: 'stale-ref',
      message: `Refs in "${command}" require a snapshot first. Run snapshot -i to obtain current refs.`,
      nextActions: ['refresh-interactive-refs'],
    }
  }
  if (snapshot.invalidated) {
    return {
      ok: false,
      category: 'stale-ref',
      message: `Refs cannot be used because the latest snapshot reported no active page. Run snapshot -i again after the page is ready.`,
      nextActions: ['refresh-interactive-refs'],
    }
  }
  if (!targetsMatch(snapshot.target.url, currentTarget?.url)) {
    return {
      ok: false,
      category: 'stale-ref',
      message: `Refs came from a snapshot for ${snapshot.target.url ?? 'another page'}, but the current session target is ${currentTarget?.url ?? 'unknown'}. Run snapshot -i again.`,
      nextActions: ['refresh-interactive-refs'],
    }
  }
  const missing = refs.filter((ref) => snapshot.refs[ref] === undefined)
  if (missing.length > 0) {
    return {
      ok: false,
      category: 'stale-ref',
      message: `Ref ${missing.map((ref) => `@${ref}`).join(', ')} was not present in the latest snapshot for this session. Run snapshot -i again.`,
      nextActions: ['refresh-interactive-refs'],
    }
  }
  return { ok: true }
}

/**
 * Batch ordering preflight: a @ref mutation that follows a navigating command in
 * the same batch is unsafe because the ref's page is gone.
 */
export function checkBatchRefOrdering(rows: readonly string[][]): StaleRefCheck {
  let navigated = false
  for (const row of rows) {
    const command = row[0]
    if (!command) continue
    if (command === 'snapshot') {
      navigated = false
      continue
    }
    if (navigated && MUTATION_COMMANDS.has(command) && row.some((token) => /^@e\d+$/.test(token))) {
      return {
        ok: false,
        category: 'stale-ref',
        message: `Batch step ${command} uses page-scoped refs after an earlier step can navigate or mutate the page. Split the batch, run snapshot -i after the page-changing step, then retry with current refs.`,
        nextActions: ['refresh-interactive-refs'],
      }
    }
    if (NAVIGATING_BATCH_COMMANDS.has(command) || isMutatingClick(row)) navigated = true
  }
  return { ok: true }
}

function isMutatingClick(row: readonly string[]): boolean {
  if (row[0] !== 'click') return false
  return !row.some((token) => /^@e\d+$/.test(token))
}

export function parseSnapshotRefs(data: unknown): RefSnapshot | undefined {
  if (data === null || typeof data !== 'object') return undefined
  const record = data as Record<string, unknown>
  const origin = typeof record.origin === 'string' ? record.origin : undefined
  const refsRaw = record.refs
  const refs: Record<string, { role?: string; name?: string }> = {}
  if (refsRaw !== null && typeof refsRaw === 'object') {
    for (const [key, value] of Object.entries(refsRaw as Record<string, unknown>)) {
      const id = key.replace(/^@/, '')
      if (value !== null && typeof value === 'object') {
        const entry = value as Record<string, unknown>
        refs[id] = {
          ...(typeof entry.role === 'string' ? { role: entry.role } : {}),
          ...(typeof entry.name === 'string' ? { name: entry.name } : {}),
        }
      } else {
        refs[id] = {}
      }
    }
  }
  const snapshotText = typeof record.snapshot === 'string' ? record.snapshot : ''
  if (Object.keys(refs).length === 0 && snapshotText) {
    for (const match of snapshotText.matchAll(/ref=(e\d+)/g)) {
      const id = match[1]!
      refs[id] = refs[id] ?? {}
    }
  }
  const title = typeof record.title === 'string' ? record.title : undefined
  return { refIds: Object.keys(refs), refs, target: { ...(origin ? { url: origin } : {}), ...(title ? { title } : {}) } }
}
