import { describe, expect, test } from 'claude-code/testing'

import { framed, row, segLength, wrapSegs } from './layout'

const s = (text: string) => ({ text })
const texts = (lines: { text: string }[][]) => lines.map(line => line.map(seg => seg.text).join(''))

describe('layout', () => {
  test('every row and the frame come out exactly as wide as asked', () => {
    for (const width of [10, 20, 33, 56]) {
      const rows = [
        ...row([s('● general-purpose')], [s('0:09 · 71k tok')], width),
        ...row([s('Stuck check 2: loop then failures with a long description')], [s('1 tool · 1 error · stopped')], width),
        ...row([s('supercalifragilisticexpialidocious-word')], undefined, width),
        ...row([s('Tìm nơi định nghĩa route và cách navigate() được gọi')], [s('4.3s')], width),
      ]
      expect(rows.every(line => segLength(line) === width)).toBe(true)
      expect(framed(rows, width + 4, {}).every(line => segLength(line) === width + 4)).toBe(true)
    }
  })

  test('long text wraps at spaces instead of being cut', () => {
    expect(texts(wrapSegs([s('aa bb cc')], 5))).toEqual(['aa bb', 'cc'])
    expect(texts(wrapSegs([s('abcdefghij')], 4))).toEqual(['abcd', 'efgh', 'ij'])
    expect(texts(row([s('one two three four')], undefined, 9)).join('|')).not.toContain('…')
  })

  test('the right figure sits at the row end, or below when it does not fit', () => {
    expect(texts(row([s('abc')], [s('xyz')], 10))).toEqual(['abc    xyz'])
    expect(texts(row([s('abcdefgh')], [s('xyz')], 10))).toEqual(['abcdefgh  ', '       xyz'])
    expect(texts(row([s('ab')], [s('a long right part')], 8))).toEqual(['ab      ', 'a long  ', 'right   ', 'part    '])
  })

  test('the title rides the top border; the right part drops inside when the border is too short', () => {
    const card = (width: number, left: string, right: string) =>
      texts(framed(row([s('map the routes')], undefined, width - 4), width, {}, { left: [s(left)], right: [s(right)] }))

    expect(card(40, '● Explore', '0:42 · 13k tok')).toEqual([
      '╭─ ● Explore ───────── 0:42 · 13k tok ─╮',
      '│ map the routes                       │',
      '╰──────────────────────────────────────╯',
    ])
    expect(card(18, '● Explore', '0:42 · 13k tok')).toEqual([
      '╭─ ● Explore ────╮',
      '│ 0:42 · 13k tok │',
      '│ map the routes │',
      '╰────────────────╯',
    ])
    for (const width of [14, 18, 24, 30, 40, 60]) {
      expect(card(width, '● a-very-long-custom-agent-type-name', '12:34').every(line => line.length === width)).toBe(true)
    }
  })

  test('a leading indent is kept, and a wrapped item hangs under its text', () => {
    expect(texts(row([s('  '), s('□'), s(' '), s('Read the map file')], undefined, 22))).toEqual(['  □ Read the map file '])
    expect(texts(row([s('⎿ '), s('■'), s(' '), s('Read the traveler file and more')], undefined, 20, 4))).toEqual([
      '⎿ ■ Read the        ',
      '    traveler file   ',
      '    and more        ',
    ])
  })

  test('styles survive the wrap', () => {
    const lines = wrapSegs([{ text: 'red words here', color: 'error' }, { text: ' dim tail', dim: true }], 9)

    // Words of one style on one row are one run.
    expect(lines.map(line => line.map(seg => [seg.text, seg.color ?? '', seg.dim ?? false]))).toEqual([
      [['red words', 'error', false]],
      [
        ['here', 'error', false],
        [' dim', '', true],
      ],
      [['tail', '', true]],
    ])
  })
})
