import { describe, expect, test } from 'claude-code/testing'

import type { AgentActivity, AgentRow } from '../types'
import { alertModeOf, contextAlert, stuckAlerts } from './alerts'

const row = (id: string, extra: Partial<AgentRow> = {}): AgentRow => ({
  id,
  type: 'Explore',
  description: id,
  isTeammate: false,
  status: 'running',
  isListed: true,
  inList: true,
  firstSeenAt: 0,
  startedAt: 0,
  ...extra,
})

const quiet: AgentActivity = { turns: [], steps: [], toolCount: 0, errorCount: 0 }

describe('alerts', () => {
  test('the option reads as toast unless it says notify or off', () => {
    expect(alertModeOf('notify')).toBe('notify')
    expect(alertModeOf('off')).toBe('off')
    expect(alertModeOf('toast')).toBe('toast')
    expect(alertModeOf(undefined)).toBe('toast')
    expect(alertModeOf('loud')).toBe('toast')
  })

  test('a running agent that may be stuck is said once, again only after it recovers', () => {
    const rows = { a1: row('a1') }
    const acts = { a1: quiet }

    // Not yet stuck: nothing said.
    expect(stuckAlerts(rows, acts, [], 10_000)).toEqual({ fire: [], alerted: [] })

    const first = stuckAlerts(rows, acts, [], 130_000)
    expect(first.fire).toEqual([{ id: 'a1', text: 'Explore may be stuck: no tool call for 2:10' }])
    expect(first.alerted).toEqual(['a1'])

    // Still stuck: not said again.
    expect(stuckAlerts(rows, acts, first.alerted, 200_000)).toEqual({ fire: [], alerted: ['a1'] })

    // It made a call: it leaves the list, so a later stall is said again.
    const busy: AgentActivity = {
      ...quiet,
      steps: [{ id: 's1', tool: 'Read', summary: 'a.ts', status: 'done', startedAt: 200_000, endedAt: 200_000 }],
      toolCount: 1,
    } as AgentActivity
    expect(stuckAlerts(rows, { a1: busy }, ['a1'], 201_000)).toEqual({ fire: [], alerted: [] })
    expect(stuckAlerts(rows, { a1: busy }, [], 400_000).fire).toHaveLength(1)
  })

  test('an agent that ended, idles or waits is never said to be stuck', () => {
    const rows = {
      done: row('done', { status: 'completed' }),
      idle: row('idle', { status: 'idle', isTeammate: true }),
      wait: row('wait', { status: 'waiting' }),
    }

    expect(stuckAlerts(rows, {}, [], 500_000)).toEqual({ fire: [], alerted: [] })
  })

  test('the context is said once as it passes 80%, again after it fell back', () => {
    const at = (tokens: number) => ({ tokens, window: 1_000_000 })

    expect(contextAlert(at(700_000), at(790_000))).toBeUndefined()
    expect(contextAlert(at(790_000), at(812_000))).toBe('context 81% full: compaction is near')
    expect(contextAlert(at(812_000), at(900_000))).toBeUndefined()
    // Compacted, then full again.
    expect(contextAlert(at(900_000), at(200_000))).toBeUndefined()
    expect(contextAlert(at(200_000), at(850_000))).toBe('context 85% full: compaction is near')
    // The first reading counts from empty; no window, nothing to say.
    expect(contextAlert(null, at(830_000))).toBe('context 83% full: compaction is near')
    expect(contextAlert(null, { tokens: 10, window: 0 })).toBeUndefined()
  })
})
