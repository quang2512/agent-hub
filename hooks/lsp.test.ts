import { describe, expect, test } from 'claude-code/testing'

import type { LspCall, LspCalls } from '../types'
import { endLspCall, LSP_ROWS, lspEndOf, lspLine, startLspCall } from './lsp'

const call = (extra: Partial<LspCall> = {}): LspCall => ({
  id: 'toolu_1',
  operation: 'findReferences',
  filePath: '/repo/hooks/register.tsx',
  line: 986,
  status: 'running',
  ...extra,
})

describe('lsp', () => {
  test('a finished call reads as its operation, file:line and what it found', () => {
    expect(lspLine(call({ status: 'done', resultCount: 12, fileCount: 3 }))).toBe('findReferences  register.tsx:986 · 12 results in 3 files')
  })

  test('a failed call reads as why, not what it found', () => {
    expect(lspLine(call({ operation: 'hover', filePath: 'plan.ts', line: 40, status: 'failed', error: 'No LSP server for .ts' }))).toBe(
      'hover  plan.ts:40 · No LSP server for .ts',
    )
  })

  test('a workspace search reads as what it searched for, one result singular', () => {
    expect(lspLine(call({ operation: 'workspaceSymbol', query: 'startShell', status: 'done', resultCount: 1, fileCount: 1 }))).toBe(
      'workspaceSymbol  "startShell" · 1 result in 1 file',
    )
  })

  test('the list keeps the latest LSP_ROWS calls and counts every one; an ended call ends in place', () => {
    let lsp: LspCalls = { calls: [], total: 0 }
    for (let i = 1; i <= LSP_ROWS + 2; i += 1) lsp = startLspCall(lsp, call({ id: `t${i}` }))

    expect(lsp.calls.map(one => one.id)).toEqual(['t3', 't4', 't5', 't6', 't7'])
    expect(lsp.total).toBe(7)

    const ended = endLspCall(lsp, 't5', { status: 'done', resultCount: 2 })
    expect(ended.calls.find(one => one.id === 't5')).toMatchObject({ status: 'done', resultCount: 2 })
    expect(ended.calls.filter(one => one.status === 'running')).toHaveLength(4)
    expect(endLspCall(lsp, 't1', { status: 'done' })).toEqual(lsp)
  })

  test("a call ends as its result's counts, its error's first line, or its denial", () => {
    expect(lspEndOf({ result: { operation: 'findReferences', result: '…', filePath: 'a.ts', resultCount: 12, fileCount: 3 } })).toEqual({
      status: 'done',
      resultCount: 12,
      fileCount: 3,
    })
    expect(lspEndOf({ result: { operation: 'hover', result: 'type X', filePath: 'a.ts' } })).toEqual({ status: 'done' })
    expect(lspEndOf({ isError: true, text: 'No LSP server available for file type: .rb\nmore' })).toEqual({
      status: 'failed',
      error: 'No LSP server available for file type: .rb',
    })
    expect(lspEndOf({ deny: 'denied by the person' })).toEqual({ status: 'failed', error: 'denied by the person' })
  })
})
