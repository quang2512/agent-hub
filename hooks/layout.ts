// A card is drawn as one Button, so the focus ring inverts all of it at once.
// A Button holds only strings and Text, never a Box: its rows are laid out
// here by hand, each padded to the card's exact width, long text wrapped onto
// the next row rather than cut.

/** A run of text in one style. */
export type Seg = { text: string; color?: string; dim?: boolean; bold?: boolean; strike?: boolean }

/** One row of a card, exactly as wide as the card. */
export type Line = Seg[]

export const segLength = (segs: readonly Seg[]): number => segs.reduce((n, seg) => n + seg.text.length, 0)

const isSpace = (text: string): boolean => /^\s+$/.test(text)

const sameStyle = (a: Seg, b: Seg): boolean =>
  a.color === b.color && a.dim === b.dim && a.bold === b.bold && a.strike === b.strike

function trimEnd(line: Seg[]): Seg[] {
  const out = [...line]
  while (out.length > 0) {
    const last = out[out.length - 1]!
    const text = last.text.trimEnd()
    if (text === last.text) break
    if (text === '') out.pop()
    else out[out.length - 1] = { ...last, text }
  }

  return out
}

/**
 * Wraps styled text to `width` columns at spaces, keeping each run's style; a
 * word longer than a whole row is split. Leading spaces of the first row are
 * kept (an indent); a wrapped row starts `hang` columns in, with no space of
 * its own.
 */
export function wrapSegs(segs: readonly Seg[], width: number, hang = 0): Seg[][] {
  const room = Math.max(1, width)
  const indent = Math.min(Math.max(0, hang), room - 1)
  const lines: Seg[][] = [[]]
  let used = 0
  let atStart = true
  // A run joins the one before it when they share a style: a row is a few
  // runs, not one per word.
  const put = (seg: Seg) => {
    const line = lines[lines.length - 1]!
    const last = line.at(-1)
    if (last !== undefined && sameStyle(last, seg)) line[line.length - 1] = { ...last, text: last.text + seg.text }
    else line.push(seg)
    used += seg.text.length
    if (!isSpace(seg.text)) atStart = false
  }
  const breakLine = () => {
    lines.push(indent > 0 ? [{ text: ' '.repeat(indent) }] : [])
    used = indent
    atStart = false
  }

  for (const seg of segs) {
    for (const token of seg.text.normalize('NFC').split(/(\s+)/)) {
      if (token === '') continue
      if (isSpace(token)) {
        if (atStart && lines.length === 1) {
          put({ ...seg, text: token.slice(0, room - 1) })
          continue
        }
        // A wrapped row begins at its indent, never with a space.
        if (lines.length > 1 && used <= indent) continue
        if (used + token.length >= room) breakLine()
        else put({ ...seg, text: token })
        continue
      }
      let word = token
      while (word !== '') {
        if (used + word.length <= room) {
          put({ ...seg, text: word })
          break
        }
        const lineStart = lines.length > 1 ? indent : 0
        if (used > lineStart && word.length <= room - indent) {
          breakLine()
          continue
        }
        const take = Math.max(1, room - used)
        put({ ...seg, text: word.slice(0, take) })
        word = word.slice(take)
        breakLine()
      }
    }
  }

  const trimmed = lines.map(trimEnd)

  return trimmed.length > 1 && trimmed.at(-1)!.length === 0 ? trimmed.slice(0, -1) : trimmed
}

const pad = (line: Seg[], width: number): Line => {
  const gap = width - segLength(line)

  return gap > 0 ? [...line, { text: ' '.repeat(gap) }] : line
}

/**
 * One logical row of a card: `left` wraps across as many rows as it needs;
 * `right`, kept whole, sits at the right end of the last of them, or on a row
 * of its own when it does not fit there. Every row is exactly `width` wide.
 */
export function row(left: readonly Seg[], right: readonly Seg[] | undefined, width: number, hang = 0): Line[] {
  const rightLength = right === undefined ? 0 : segLength(right)
  const lines = wrapSegs(left, width, hang)
  if (right === undefined || rightLength === 0) return lines.map(line => pad(line, width))
  // Too long for any row: it wraps too, on rows of its own.
  if (rightLength > width) {
    const head = lines.length === 1 && lines[0]!.length === 0 ? [] : lines

    return [...head, ...wrapSegs(right, width)].map(line => pad(line, width))
  }

  const last = lines.at(-1) ?? []
  const lastLength = segLength(last)
  const fits = lastLength + (lastLength > 0 ? 1 : 0) + rightLength <= width
  const body = fits ? lines.slice(0, -1) : lines
  const lastLeft = fits ? last : []
  const gap = Math.max(fits && segLength(lastLeft) > 0 ? 1 : 0, width - segLength(lastLeft) - rightLength)

  return [
    ...body.map(line => pad(line, width)),
    pad([...lastLeft, { text: ' '.repeat(gap) }, ...right], width),
  ]
}

/**
 * The card around its rows: a rounded border in `edge`, one space inside each
 * side, and the title on the top border, `╭─ <left> ─…─ <right> ─╮`. Where the
 * border has no room for `right` it leads the rows instead; a `left` too long
 * for the border is cut there, being a name.
 */
export function framed(
  rows: readonly Line[],
  width: number,
  edge: Omit<Seg, 'text'>,
  title?: { left: readonly Seg[]; right?: readonly Seg[] },
): Line[] {
  const inner = Math.max(1, width - 4)
  const bottom: Line = [{ ...edge, text: `╰${'─'.repeat(inner + 2)}╯` }]
  const body = (lines: readonly Line[]) =>
    lines.map(line => [{ ...edge, text: '│ ' }, ...pad(line, inner), { ...edge, text: ' │' }])
  if (title === undefined) return [[{ ...edge, text: `╭${'─'.repeat(inner + 2)}╮` }], ...body(rows), bottom]

  // '╭─ ' left ' ' dashes ' ' right ' ─╮' takes 8 columns besides left,
  // right and the dashes; with no right, '╭─ ' left ' ' dashes '─╮' takes 6.
  // At least one dash either way.
  const right = title.right ?? []
  const rightLength = segLength(right)
  const hasRight = rightLength > 0 && segLength(title.left) + rightLength <= width - 9
  const leftRoom = hasRight ? width - 9 - rightLength : width - 7
  let left: Seg[] = []
  let used = 0
  for (const seg of title.left) {
    if (used >= leftRoom) break
    const text = seg.text.slice(0, leftRoom - used)
    left = [...left, { ...seg, text }]
    used += text.length
  }
  const dashes = Math.max(1, hasRight ? width - 8 - used - rightLength : width - 6 - used)
  const top: Line = hasRight
    ? [{ ...edge, text: '╭─ ' }, ...left, { ...edge, text: ` ${'─'.repeat(dashes)} ` }, ...right, { ...edge, text: ' ─╮' }]
    : [{ ...edge, text: '╭─ ' }, ...left, { ...edge, text: ` ${'─'.repeat(dashes)}─╮` }]
  const lead = hasRight || rightLength === 0 ? [] : row([], right, inner)

  return [top, ...body([...lead, ...rows]), bottom]
}
