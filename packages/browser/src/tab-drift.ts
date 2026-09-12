import { isAboutBlank, targetsMatch } from './page-change.ts'

export interface TabTarget {
  url?: string
  title?: string
}

export interface TabListEntry {
  id: string
  url?: string
  title?: string
  active: boolean
}

/** Commands whose target change is intentional, never drift. */
const EXPLICIT_TARGET_COMMANDS = new Set(['open', 'goto', 'navigate', 'back', 'forward', 'reload', 'connect', 'tab', 'close'])

export type DriftReason = 'about-blank' | 'target-changed'

export function detectTabDrift(
  expected: TabTarget | undefined,
  observed: TabTarget | undefined,
  command: string,
): { drift: boolean; reason?: DriftReason } {
  if (!expected?.url || !observed?.url) return { drift: false }
  if (EXPLICIT_TARGET_COMMANDS.has(command)) return { drift: false }
  if (isAboutBlank(observed.url) && !isAboutBlank(expected.url)) return { drift: true, reason: 'about-blank' }
  if (!targetsMatch(expected, observed)) return { drift: true, reason: 'target-changed' }
  return { drift: false }
}

export function parseTabList(data: unknown): TabListEntry[] {
  const record = data !== null && typeof data === 'object' ? (data as Record<string, unknown>) : undefined
  const raw = Array.isArray(data) ? data : Array.isArray(record?.['tabs']) ? (record?.['tabs'] as unknown[]) : []
  const entries: TabListEntry[] = []
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue
    const entry = item as Record<string, unknown>
    const id = typeof entry['tabId'] === 'string' ? entry['tabId'] : typeof entry['id'] === 'string' ? entry['id'] : undefined
    if (!id) continue
    entries.push({
      id,
      active: entry['active'] === true,
      ...(typeof entry['url'] === 'string' ? { url: entry['url'] } : {}),
      ...(typeof entry['title'] === 'string' ? { title: entry['title'] } : {}),
    })
  }
  return entries
}

/**
 * Deterministic recovery choice: exactly one non-blank tab whose URL matches the
 * expected target. Ambiguity is never guessed.
 */
export function chooseRecoveryTab(expected: TabTarget | undefined, tabs: readonly TabListEntry[]): TabListEntry | undefined {
  if (!expected?.url) return undefined
  const candidates = tabs.filter((tab) => !isAboutBlank(tab.url) && targetsMatch(expected, { url: tab.url }))
  return candidates.length === 1 ? candidates[0] : undefined
}
