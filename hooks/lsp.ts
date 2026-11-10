// The LSP calls of the session: each time Claude, or a subagent, asks a
// language server something through the LSP tool. The engine exposes no
// server status or diagnostics to a mod, so the calls are what the pane shows.

import type { LspCall, LspCalls } from '../types'
import { plural } from './card'

/** The calls the group draws; older ones are only counted. */
export const LSP_ROWS = 5

/** Adds a call, keeping the latest LSP_ROWS. */
export const startLspCall = (lsp: LspCalls, row: LspCall): LspCalls => ({
  calls: [...lsp.calls.filter(one => one.id !== row.id), row].slice(-LSP_ROWS),
  total: lsp.total + 1,
})

/** How a call ended, from what the tool answered: its counts, its error's first line, or its denial. */
export function lspEndOf(ran: { deny?: string; isError?: boolean; text?: string; result?: unknown }): Partial<LspCall> {
  if (ran.deny !== undefined) return { status: 'failed', error: ran.deny }
  if (ran.isError === true) return { status: 'failed', error: (ran.text ?? '').split('\n')[0]?.trim() || 'failed' }
  const record = typeof ran.result === 'object' && ran.result !== null ? (ran.result as Record<string, unknown>) : {}

  return {
    status: 'done',
    ...(typeof record.resultCount === 'number' ? { resultCount: record.resultCount } : {}),
    ...(typeof record.fileCount === 'number' ? { fileCount: record.fileCount } : {}),
  }
}

/** Ends a call still listed; one already scrolled off is left counted. */
export const endLspCall = (lsp: LspCalls, id: string, change: Partial<LspCall>): LspCalls =>
  lsp.calls.some(one => one.id === id) ? { ...lsp, calls: lsp.calls.map(one => (one.id === id ? { ...one, ...change } : one)) } : lsp

/** A call as its row reads after the glyph: operation, file:line, what it found. */
export function lspLine(row: LspCall): string {
  const where = row.query !== undefined ? `"${row.query}"` : `${row.filePath.split('/').at(-1) ?? row.filePath}:${row.line}`
  const found =
    row.error !== undefined
      ? ` · ${row.error}`
      : row.resultCount === undefined
        ? ''
        : ` · ${plural(row.resultCount, 'result')}${row.fileCount === undefined ? '' : ` in ${plural(row.fileCount, 'file')}`}`

  return `${row.operation}  ${where}${found}`
}
