// The LSP calls of the session: each time Claude, or a subagent, asks a
// language server something through the LSP tool. The engine exposes no
// server status or diagnostics to a mod, so the calls are what the pane shows.

import type { LspCall, LspCalls } from '../types'
import { plural } from './card'

/** The calls the group draws; older ones are only counted. */
export const LSP_ROWS = 5

/**
 * Adds a call, keeping LSP_ROWS: the oldest finished ones go first, so a call
 * still running stays until it ends. A call seen again is counted once.
 */
export function startLspCall(lsp: LspCalls, row: LspCall): LspCalls {
  const isNew = !lsp.calls.some(one => one.id === row.id)
  const all = [...lsp.calls.filter(one => one.id !== row.id), row]
  let extra = all.length - LSP_ROWS
  const calls = all.filter(one => (extra > 0 && one.status !== 'running' ? (extra -= 1) < 0 : true))

  return { calls, total: lsp.total + (isNew ? 1 : 0) }
}

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
  const name = row.filePath.split(/[\\/]/).at(-1) ?? ''
  const at = Number.isFinite(row.line) && row.line > 0 ? `:${row.line}` : ''
  const where = row.query !== undefined ? `"${row.query}"` : name === '' ? '' : `${name}${at}`
  const found =
    row.error !== undefined
      ? ` · ${row.error}`
      : row.resultCount === undefined
        ? ''
        : ` · ${plural(row.resultCount, 'result')}${row.fileCount === undefined ? '' : ` in ${plural(row.fileCount, 'file')}`}`

  return `${row.operation}${where === '' ? '' : `  ${where}`}${found}`
}
