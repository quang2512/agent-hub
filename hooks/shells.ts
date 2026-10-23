// The shells the session spawned: Bash commands run in the background, or
// moved there (Ctrl+B, a timeout), by the main conversation or a subagent.
// A foreground command is the transcript's to show. The engine writes a
// background command's output to `<tasks dir>/<id>.output`, the path its
// result names, and ends the file `[exited with code N]` when it exits, or
// `[killed]` when it is stopped (TaskStop, the tasks dialog, its agent ending).

import type { ShellRow } from '../types'
import { redact } from './steps'

export const MAX_SHELLS = 30
/** The log lines a running card draws. */
export const TAIL_LINES = 5
/** The log lines a finished card keeps drawn. */
export const DONE_TAIL_LINES = 2
/** The log lines a shell keeps, for its detail; its card draws the last few. */
export const KEEP_LINES = 40
/** A larger log is not read: one read copies the whole file. */
export const MAX_LOG_BYTES = 256 * 1024

const EXIT_TRAILER = /\n*\[(?:exited with code (-?\d+)|killed)\]\s*$/
// CSI and OSC sequences, then any other control character but tab, newline, return.
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g
// "… Output is being written to: /…/tasks/b1x2y3.output. …"
const LOG_PATH = /(\/\S+\/(b[a-z0-9]+)\.output)\b/

/** The latest lines of a log as a terminal shows them, and how it ended once it has: its exit code, or killed. */
export function readLog(text: string, keep = KEEP_LINES): { tail: string[]; exitCode?: number; isKilled?: true } {
  const exit = EXIT_TRAILER.exec(text)
  const body = exit === null ? text : text.slice(0, exit.index)
  const lines = body
    .replace(ANSI, '')
    .split('\n')
    // A carriage return redraws its line: a progress bar keeps only its last frame.
    .map(line => (line.split('\r').filter(part => part !== '').at(-1) ?? '').replace(CONTROL, '').replace(/\t/g, '  ').trimEnd())
  while (lines.length > 0 && lines.at(-1) === '') lines.pop()
  const tail = lines.slice(-keep).map(redact)

  if (exit === null) return { tail }

  return exit[1] === undefined ? { tail, isKilled: true } : { tail, exitCode: Number(exit[1]) }
}

/**
 * The background command a Bash call left running, from its result: its id
 * and, when the result's text names it, its log's path.
 */
export function spawnedOf(result: unknown, text: string | undefined): { taskId: string; logPath?: string } | undefined {
  const record = typeof result === 'object' && result !== null ? (result as Record<string, unknown>) : {}
  const taskId = typeof record.backgroundTaskId === 'string' && record.backgroundTaskId !== '' ? record.backgroundTaskId : undefined
  if (taskId === undefined) return undefined
  const named = LOG_PATH.exec(text ?? '')

  return named !== null && named[2] === taskId ? { taskId, logPath: named[1] } : { taskId }
}

/** Adds a shell, dropping the oldest finished ones past MAX_SHELLS. */
export function startShell(shells: readonly ShellRow[], row: ShellRow): ShellRow[] {
  const all = [...shells.filter(one => one.id !== row.id), row]
  let extra = all.length - MAX_SHELLS

  return all.filter(one => (extra > 0 && one.status !== 'running' ? (extra -= 1) < 0 : true))
}

/** Changes a shell still running: a log read late never undoes its end. */
export function patchRunning(shells: readonly ShellRow[], id: string, change: Partial<ShellRow>): ShellRow[] {
  return shells.map(one => (one.id === id && one.status === 'running' ? { ...one, ...change } : one))
}

/** The shells the group draws, oldest first: those running, and the latest task's, as the subagents are. */
export const visibleShells = (shells: readonly ShellRow[], task: number): ShellRow[] =>
  shells.filter(row => row.status === 'running' || row.task === task).sort((a, b) => a.startedAt - b.startedAt)

/** One row cut to `width` columns, an ellipsis where it was cut. */
export const clip = (text: string, width: number): string =>
  width <= 0 ? '' : text.length > width ? `${text.slice(0, Math.max(0, width - 1))}…` : text

/** The command as its pinned row shows it: the first line, `…` when there are more. */
export function commandLine(command: string): string {
  const lines = command.split('\n').map(line => line.trim()).filter(line => line !== '')
  const first = redact(lines[0] ?? '')

  return lines.length > 1 ? `${first} …` : first
}

/** The command as its detail shows it: every line, trimmed, secrets masked. */
export const commandLines = (command: string): string[] =>
  command
    .split('\n')
    .map(line => redact(line.trimEnd()))
    .filter(line => line.trim() !== '')

/** A shell still running: TaskStop takes its id. */
export const isStoppable = (row: ShellRow): boolean => row.status === 'running'

/** Every shell of the session, newest first, as the detail lists them. */
export const shellHistory = (shells: readonly ShellRow[]): ShellRow[] =>
  [...shells].sort((a, b) => b.startedAt - a.startedAt)

/**
 * How long a running shell may go without its log read before the pane says
 * it cannot follow it. The engine opens a command's log as it starts, so a
 * quiet command has one; none read by now means the tasks dir was not found.
 */
export const OUTPUT_GRACE_MS = 10_000

/** What a running shell with no output yet reads as: waiting, or not followed live. */
export const waitingNote = (row: ShellRow, now: number): string =>
  row.size === undefined && now - row.startedAt >= OUTPUT_GRACE_MS
    ? 'live output unavailable · its log was not found'
    : 'waiting for output…'
