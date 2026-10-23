// What the pane tells the person without being looked at: a toast (and, if
// they asked, a notification of their own channel) when a subagent may be
// stuck, or the context window nears compaction. Each said once a time.

import type { AgentActivity, AgentRow } from '../types'
import { stuckNote } from './steps'

/** How full the context window is when the pane says compaction is near. */
export const CONTEXT_ALERT = 0.8

/** How the person asked to hear: `toast` in Claude Code, `notify` beside a notification too, `off` not at all. */
export type AlertMode = 'toast' | 'notify' | 'off'

export const alertModeOf = (value: unknown): AlertMode => (value === 'notify' || value === 'off' ? value : 'toast')

/**
 * The running agents that may be stuck and were not yet said to be, each
 * with what to say, and the ids said so far that still are. An agent that
 * recovers leaves `alerted`, so a later stall is said again.
 */
export function stuckAlerts(
  rows: Readonly<Record<string, AgentRow>>,
  acts: Readonly<Record<string, AgentActivity>>,
  alerted: readonly string[],
  now: number,
): { fire: { id: string; text: string }[]; alerted: string[] } {
  const fire: { id: string; text: string }[] = []
  const still: string[] = []
  for (const row of Object.values(rows)) {
    if (row.status !== 'running') continue
    const note = stuckNote(acts[row.id], row.startedAt ?? row.firstSeenAt, now)
    if (note === undefined) continue
    still.push(row.id)
    if (!alerted.includes(row.id)) fire.push({ id: row.id, text: `${row.type} may be stuck: ${note}` })
  }

  return { fire, alerted: still }
}

/** What to say when a reading takes the context window past CONTEXT_ALERT, or undefined. */
export function contextAlert(
  before: { tokens: number; window: number } | null,
  after: { tokens: number; window: number },
): string | undefined {
  if (after.window <= 0) return undefined
  const was = before === null || before.window <= 0 ? 0 : before.tokens / before.window
  const is = after.tokens / after.window
  if (was >= CONTEXT_ALERT || is < CONTEXT_ALERT) return undefined

  return `context ${Math.round(Math.min(1, is) * 100)}% full: compaction is near`
}
