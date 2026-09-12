/**
 * Settlement classification for Orbit executor/commander children.
 *
 * The durable seam is the session `turn/end` event: its `data.reason.kind` is
 * `completed | aborted | error | blocked | max-tokens` (`interrupted` only
 * appears on cold-read synthesis). A child that is merely `idle` is NOT success.
 */

export type TurnSettlement = 'completed' | 'aborted' | 'error' | 'blocked' | 'max-tokens' | 'open'

export interface SettlementResult {
  settlement: TurnSettlement
  /** For aborted turns: the cancel cause (`user` / `parent` / `hook` / `disposed`). */
  cancelCause?: string
  /** For error turns: a bounded, redacted failure message. */
  errorMessage?: string
}

interface TurnEndReasonLike {
  kind?: string
  reason?: { kind?: string }
  error?: { message?: string; code?: string }
}

interface EventLike {
  type?: string
  data?: unknown
}

export function classifyTurnSettlement(events: readonly EventLike[]): SettlementResult {
  let end: EventLike | undefined
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]?.type === 'turn/end') {
      end = events[index]
      break
    }
  }
  if (!end) return { settlement: 'open' }
  const reason = (end.data as { reason?: TurnEndReasonLike } | undefined)?.reason
  switch (reason?.kind) {
    case 'completed':
      return { settlement: 'completed' }
    case 'aborted':
      return { settlement: 'aborted', ...(reason.reason?.kind ? { cancelCause: reason.reason.kind } : {}) }
    case 'error':
      return { settlement: 'error', ...(reason.error?.message ? { errorMessage: reason.error.message } : {}) }
    case 'blocked':
      return { settlement: 'blocked' }
    case 'max-tokens':
      return { settlement: 'max-tokens' }
    default:
      return { settlement: 'open' }
  }
}
