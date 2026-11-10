import type { SessionContextBreakdown } from 'claude-code'

import type { ContextView } from '../types'

// The squares /context draws: a full one, a partly filled one (under 0.7),
// the window left, and the compaction reserve.
export const SQUARE = { full: '⛁', partial: '⛀', free: '⛶', buffer: '⛝' } as const

/** The breakdown as the pane keeps it: the rows /context lists and its grid as glyphs. */
export function contextView(b: SessionContextBreakdown): ContextView {
  const kindOf = new Map(b.categories.map(c => [c.name, c.kind]))

  return {
    model: b.model,
    tokens: b.totalTokens,
    max: b.rawMaxTokens,
    rows: b.categories
      .filter(c => c.kind !== 'deferred' && (c.tokens > 0 || c.kind !== 'used'))
      .map(c => ({ name: c.name, tokens: c.tokens, color: c.color, kind: c.kind })),
    grid: b.gridRows.map(line =>
      line.map(sq => {
        const kind = kindOf.get(sq.categoryName)
        const glyph =
          kind === 'buffer'
            ? SQUARE.buffer
            : kind === 'free' || !sq.isFilled
              ? SQUARE.free
              : sq.squareFullness < 0.7
                ? SQUARE.partial
                : SQUARE.full

        return { color: sq.color, glyph }
      }),
    ),
  }
}

/** A row's share of the window as /context prints it: one decimal. */
export function share(tokens: number, max: number): string {
  if (max <= 0) return '0.0%'

  return `${((tokens / max) * 100).toFixed(1)}%`
}
