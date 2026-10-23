import { describe, expect, test } from 'claude-code/testing'

import type { ShellRow } from '../types'
import {
  clip,
  commandLine,
  commandLines,
  isStoppable,
  KEEP_LINES,
  MAX_SHELLS,
  OUTPUT_GRACE_MS,
  patchRunning,
  readLog,
  shellHistory,
  spawnedOf,
  startShell,
  visibleShells,
  waitingNote,
} from './shells'

const shell = (id: string, extra: Partial<ShellRow> = {}): ShellRow => ({
  id,
  command: `echo ${id}`,
  task: 1,
  status: 'running',
  taskId: `b${id}`,
  startedAt: 1000,
  tail: [],
  ...extra,
})

describe('shells', () => {
  test('a log reads as its latest lines, colours, progress frames and secrets gone', () => {
    const log = readLog('one\n\x1b[32mtwo\x1b[0m\n10%\r50%\r100%\nkey token=abc123\n\n')

    expect(log.tail).toEqual(['one', 'two', '100%', 'key token=***'])
    expect(log.exitCode).toBeUndefined()
    expect(readLog('a\nb\nc', 2).tail).toEqual(['b', 'c'])
  })

  test("a log's trailer is its exit code, not a line", () => {
    expect(readLog('built\n\n[exited with code 0]\n')).toEqual({ tail: ['built'], exitCode: 0 })
    expect(readLog('\n[exited with code 2]\n')).toEqual({ tail: [], exitCode: 2 })
  })

  test("a killed command's log ends `[killed]`, a trailer and not a line", () => {
    expect(readLog('ready on :3000\n\n[killed]\n')).toEqual({ tail: ['ready on :3000'], isKilled: true })
    expect(readLog('\n[killed]\n')).toEqual({ tail: [], isKilled: true })
    expect(readLog('echo [killed] here\n').isKilled).toBeUndefined()
  })

  test('a call that left its command in the background spawned a shell, its log the one the result names', () => {
    const text =
      'Command running in background with ID: bsrv1. Output is being written to: /private/tmp/claude-501/-p/sid/tasks/bsrv1.output. You will be notified.'

    expect(spawnedOf({ stdout: '', backgroundTaskId: 'bsrv1' }, text)).toEqual({
      taskId: 'bsrv1',
      logPath: '/private/tmp/claude-501/-p/sid/tasks/bsrv1.output',
    })
    expect(spawnedOf({ backgroundTaskId: 'bctrl' }, 'moved to the background')).toEqual({ taskId: 'bctrl' })
    expect(spawnedOf({ stdout: 'ok', stderr: '' }, 'ok')).toBeUndefined()
    expect(spawnedOf(undefined, 'Exit code 1')).toBeUndefined()
  })

  test('shells show while running or of the latest task, as the subagents do', () => {
    const shells = [
      shell('old', { status: 'done', task: 0, startedAt: 1 }),
      shell('live', { task: 0, startedAt: 2 }),
      shell('mine', { status: 'failed', startedAt: 3 }),
    ]

    expect(visibleShells(shells, 1).map(one => one.id)).toEqual(['live', 'mine'])
    expect(visibleShells(shells, 2).map(one => one.id)).toEqual(['live'])
  })

  test('the list keeps its running shells past the cap; a late read never undoes an end', () => {
    let shells: ShellRow[] = [shell('live', { startedAt: 0 })]
    for (let i = 0; i < MAX_SHELLS + 5; i += 1) shells = startShell(shells, shell(`d${i}`, { status: 'done' }))

    expect(shells).toHaveLength(MAX_SHELLS)
    expect(shells[0]?.id).toBe('live')
    expect(patchRunning([shell('x', { status: 'done' })], 'x', { tail: ['late'] })[0]?.tail).toEqual([])
  })

  test('a command shows as its first line, cut to the row', () => {
    expect(commandLine('cd app &&\n  npm run dev')).toBe('cd app && …')
    expect(clip('npm run build', 8)).toBe('npm run…')
    expect(clip('ls', 8)).toBe('ls')
  })

  test('a log keeps its latest KEEP_LINES lines for the detail', () => {
    const text = Array.from({ length: KEEP_LINES + 10 }, (_, i) => `line ${i + 1}`).join('\n')
    const { tail } = readLog(text)

    expect(tail).toHaveLength(KEEP_LINES)
    expect(tail[0]).toBe('line 11')
    expect(tail.at(-1)).toBe(`line ${KEEP_LINES + 10}`)
  })

  test('the detail shows every line of a command, secrets masked', () => {
    expect(commandLines('cd app &&\n\n  deploy --token=abc123 now   \n')).toEqual(['cd app &&', '  deploy --token=*** now'])
  })

  test('only a shell still running can be stopped', () => {
    expect(isStoppable(shell('a'))).toBe(true)
    expect(isStoppable(shell('b', { status: 'done' }))).toBe(false)
    expect(isStoppable(shell('c', { status: 'stopped' }))).toBe(false)
  })

  test('every shell is listed newest first', () => {
    const order = shellHistory([shell('old', { startedAt: 1 }), shell('new', { startedAt: 3 }), shell('mid', { startedAt: 2 })])

    expect(order.map(one => one.id)).toEqual(['new', 'mid', 'old'])
  })

  test('a running shell with no log file past the grace reads as not followed live', () => {
    const quiet = shell('q', { startedAt: 1000 })

    expect(waitingNote(quiet, 1000 + OUTPUT_GRACE_MS - 1)).toBe('waiting for output…')
    expect(waitingNote(quiet, 1000 + OUTPUT_GRACE_MS)).toBe('live output unavailable · its log was not found')
    // Its log was read: a quiet command is still only waiting.
    expect(waitingNote({ ...quiet, size: 0 }, 1000 + 60_000)).toBe('waiting for output…')
  })
})
