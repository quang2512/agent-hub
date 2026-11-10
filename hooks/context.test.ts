import { describe, expect, test } from 'claude-code/testing'
import type { SessionContextBreakdown } from 'claude-code'

import { contextView, share, SQUARE } from './context'

const sq = (categoryName: string, color: string, isFilled: boolean, squareFullness: number) => ({
  categoryName,
  color,
  isFilled,
  squareFullness,
  tokens: 0,
  percentage: 0,
})

const breakdown = {
  model: 'claude-opus-5-5',
  totalTokens: 66_400,
  rawMaxTokens: 1_000_000,
  categories: [
    { name: 'System prompt', tokens: 4_400, color: 'promptBorder', isDeferred: false, kind: 'used' },
    { name: 'Agents', tokens: 0, color: 'permission', isDeferred: false, kind: 'used' },
    { name: 'Deferred tools', tokens: 9_000, color: 'inactive', isDeferred: true, kind: 'deferred' },
    { name: 'Free space', tokens: 900_600, color: 'inactive', isDeferred: false, kind: 'free' },
    { name: 'Autocompact buffer', tokens: 33_000, color: 'inactive', isDeferred: false, kind: 'buffer' },
  ],
  gridRows: [
    [
      sq('System prompt', 'promptBorder', true, 1),
      sq('System prompt', 'promptBorder', true, 0.4),
      sq('Free space', 'inactive', false, 0),
      sq('Autocompact buffer', 'inactive', true, 1),
    ],
  ],
} as unknown as SessionContextBreakdown

describe('context', () => {
  test('keeps the rows /context lists: empty and deferred ones left out', () => {
    expect(contextView(breakdown).rows.map(r => r.name)).toEqual(['System prompt', 'Free space', 'Autocompact buffer'])
  })

  test('draws each square as /context does', () => {
    expect(contextView(breakdown).grid[0]?.map(s => s.glyph)).toEqual([
      SQUARE.full,
      SQUARE.partial,
      SQUARE.free,
      SQUARE.buffer,
    ])
  })

  test('a share prints with one decimal', () => {
    expect(share(33_000, 1_000_000)).toBe('3.3%')
    expect(share(1, 0)).toBe('0.0%')
  })
})
