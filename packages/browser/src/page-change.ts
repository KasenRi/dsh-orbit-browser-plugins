import type { PageChangeSummary } from './types.ts'

export function normalizeComparableUrl(url: string | undefined): string | undefined {
  if (!url) return undefined
  try {
    const parsed = new URL(url)
    parsed.hash = ''
    return parsed.toString()
  } catch {
    return url.split('#')[0]
  }
}

export function isAboutBlank(url: string | undefined): boolean {
  return normalizeComparableUrl(url) === 'about:blank'
}

export function targetsMatch(left: { url?: string } | undefined, right: { url?: string } | undefined): boolean {
  if (!left?.url || !right?.url) return true
  return normalizeComparableUrl(left.url) === normalizeComparableUrl(right.url)
}

export interface PageChangeInput {
  command: string
  previousTarget?: { url?: string; title?: string }
  currentTarget?: { url?: string; title?: string }
  refsBefore?: number
  refsAfter?: number
  refsRefreshed: boolean
  artifactCount: number
  confirmationRequired?: boolean
  recoveryApplied?: boolean
}

const NAVIGATING = new Set(['open', 'goto', 'navigate', 'back', 'forward', 'reload'])

/**
 * Deterministic, bounded description of what a call changed about the page.
 * Not an LLM and not a DOM diff: it compares targets and ref counts only.
 */
export function buildPageChangeSummary(input: PageChangeInput): PageChangeSummary | undefined {
  const previousUrl = normalizeComparableUrl(input.previousTarget?.url)
  const url = normalizeComparableUrl(input.currentTarget?.url) ?? previousUrl
  const urlChanged = previousUrl !== undefined && url !== undefined && previousUrl !== url
  const previousTitle = input.previousTarget?.title?.trim()
  const title = input.currentTarget?.title?.trim()
  const titleChanged = previousTitle !== undefined && title !== undefined && previousTitle !== title
  const activeTargetChanged = urlChanged
  const navigating = NAVIGATING.has(input.command)
  const somethingChanged =
    urlChanged ||
    titleChanged ||
    input.refsRefreshed ||
    input.artifactCount > 0 ||
    input.confirmationRequired === true ||
    input.recoveryApplied === true

  if (!somethingChanged && !navigating) return undefined

  const changeType: PageChangeSummary['changeType'] = input.recoveryApplied
    ? 'recovery'
    : input.artifactCount > 0
      ? 'artifact'
      : urlChanged || navigating
        ? 'navigation'
        : input.confirmationRequired
          ? 'confirmation'
          : 'mutation'

  const parts: string[] = [input.command, changeType]
  if (input.recoveryApplied) parts.push('tab recovery applied')
  if (urlChanged) parts.push(`url ${previousUrl} -> ${url}`)
  else if (titleChanged) parts.push(`title ${previousTitle} -> ${title}`)
  else if (navigating && url) parts.push(url)
  if (input.refsRefreshed) parts.push(`refs ${input.refsBefore ?? 0} -> ${input.refsAfter ?? 0}`)
  if (input.artifactCount > 0) parts.push(`${input.artifactCount} artifact${input.artifactCount === 1 ? '' : 's'}`)
  if (input.confirmationRequired) parts.push('confirmation required')

  return {
    command: input.command,
    changeType,
    summary: parts.join(' → ').slice(0, 400),
    ...(title ? { title } : {}),
    ...(url ? { url } : {}),
    ...(previousUrl ? { previousUrl } : {}),
    ...(titleChanged ? { titleChanged } : {}),
    ...(urlChanged ? { urlChanged } : {}),
    ...(input.refsBefore !== undefined ? { refsBefore: input.refsBefore } : {}),
    ...(input.refsAfter !== undefined ? { refsAfter: input.refsAfter } : {}),
    ...(input.refsRefreshed ? { refsRefreshed: input.refsRefreshed } : {}),
    ...(activeTargetChanged ? { activeTargetChanged } : {}),
    ...(input.artifactCount > 0 ? { artifactCount: input.artifactCount } : {}),
    ...(input.recoveryApplied ? { recoveryApplied: input.recoveryApplied } : {}),
  }
}
