import { atom, read, update } from 'claude-code'
import type { AgentInfo, EngineInterface, HookStream, ProcessSpawnChunk, ProcessSpawnResult, Register, ToolCallResult } from 'claude-code'

import type {
  AgentActivity,
  AgentRow,
  AgentRowStatus,
  RemoteStatus,
  ShellRow,
  ShellStatus,
  StepRow,
  StepStatus,
  TodoItem,
  TodoStatus,
  TurnEndReason,
} from '../types'
import { innerWidth, MIN_CARD_WIDTH, plural, spinnerFrame, stripRoom } from './card'
import { framed, row as layoutRow } from './layout'
import type { Line, Seg } from './layout'
import {
  applyPlan,
  currentTaskAfter,
  nextPlan,
  planFromTaskList,
  stampStarts,
  applyStepUsage,
  applyUsage,
  CACHE_TTL_MS,
  cacheParts,
  cacheReading,
  formatTokens,
  formatUsd,
  limitParts,
  orderLimits,
  planProgress,
  settleLive,
  totalTokens,
  usageOf,
} from './plan'
import { commandsFor, fileContext, historyOf, isTerminalOnly, mentionsOf, parseHelperLine, parseSlash, projectPath, shareUrl, snapshot } from './remote'
import type { RemoteResult, RemoteTurn } from './remote'
import { qrEncode, qrLines } from './qr'
import {
  applyList,
  applyTurnComplete,
  applyTurnStart,
  elapsedMs,
  formatElapsed,
  hasActive,
  isEnded,
  isPersonOrigin,
  latestTask,
  visibleTree,
} from './roster'
import {
  clip,
  commandLine,
  commandLines,
  DONE_TAIL_LINES,
  isStoppable,
  MAX_LOG_BYTES,
  patchRunning,
  readLog,
  shellHistory,
  spawnedOf,
  startShell,
  TAIL_LINES,
  visibleShells,
  waitingNote,
} from './shells'
import {
  applyStepEnd,
  applyStepStart,
  applyTurnBegin,
  applyTurnEnd,
  formatStepDuration,
  groupSteps,
  pruneActivity,
  stuckNote,
  summarize,
} from './steps'

export const PANE = 'agent-hub'
const TITLE = 'Agent Hub'
// The spinner's frame rate; the engine's roster is read every LIST_EVERY ticks.
const TICK_MS = 250
const LIST_EVERY = 4
// The keys of a tool.call input that are the engine's, not the tool's arguments.
const RESERVED = new Set(['tool', 'tool_use_id', 'agentId', 'requestMeta', 'consent'])
// The checklist tool this mod gives every agent, subagents included (they
// have no TodoWrite or TaskCreate of their own): listed as mcp__<plugin>__<name>.
const CHECKLIST = 'checklist'
const CHECKLIST_TOOL = `mcp__agent-hub__${CHECKLIST}`
const CHECKLIST_SCHEMA = {
  type: 'object',
  properties: {
    todos: {
      type: 'array',
      description: 'The whole checklist, every item, in order.',
      items: {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'The item, imperative: "Read the layout file".' },
          status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
          activeForm: { type: 'string', description: 'The item while in progress: "Reading the layout file".' },
        },
        required: ['content', 'status'],
      },
    },
  },
  required: ['todos'],
} as const

// The calls that write an agent's plan.
const PLAN_TOOLS = new Set(['TodoWrite', 'TaskCreate', 'TaskUpdate'])

// Remote control: a phone drives the session through a page the helper
// (remote/server.mjs) serves over a localhost.run tunnel.
const REMOTE = 'remote'
const REMOTE_TOOL = `mcp__agent-hub__${REMOTE}`
const REMOTE_COMMAND = 'agent-hub-remote'
const REMOTE_SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['start', 'stop', 'status'], description: 'start the remote link, stop it, or say how it stands.' },
  },
  required: ['action'],
} as const
// The token outlives the session; the tunnel's address is new at each start.
const STORE_TOKEN = 'remoteToken'
// How long the tool waits for the link: a hook has 10 s of its own time and
// sleeping counts. A slower start answers that it is starting.
const REMOTE_START_MS = 7_000
// The view is synced every SYNC_EVERY ticks.
const SYNC_EVERY = 4
// What the phone's typeahead lists: the commands, and the project's files
// (as git knows them), read again this often and sent only when they change.
const CATALOG_MS = 30_000
// The phone's history is read again after each turn, and this often besides
// (a command typed at the terminal starts no turn).
const HISTORY_MS = 15_000
const MAX_CATALOG_FILES = 5_000
// The files a phone prompt's @ mentions bring along, as Claude Code would for a typed one.
const MAX_MENTIONS = 10
const MAX_MENTION_BYTES = 100_000
const MAX_MENTION_TOTAL = 300_000

const agents = atom({ plugin: 'agent-hub', key: 'agents' } as const, {})
const activity = atom({ plugin: 'agent-hub', key: 'activity' } as const, {})
const tasks = atom({ plugin: 'agent-hub', key: 'tasks' } as const, [])
const currentTask = atom({ plugin: 'agent-hub', key: 'currentTask' } as const, null)
const taskLogs = atom({ plugin: 'agent-hub', key: 'taskLogs' } as const, {})
// Which log a step goes to: a subagent's activity, or a task of the main conversation.
type Log = 'agent' | 'task'
type Logs = Record<string, AgentActivity>
// The main conversation's calls that manage its checklist: not logged under a task.
const TASK_TOOLS = new Set(['TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet'])
// The latest calls a task in progress lists under it.
const TASK_LOG_STEPS = 6
const now = atom({ plugin: 'agent-hub', key: 'now' } as const, 0)
const selected = atom({ plugin: 'agent-hub', key: 'selected' } as const, null)
const selectedShell = atom({ plugin: 'agent-hub', key: 'selectedShell' } as const, null)
const sendCount = atom({ plugin: 'agent-hub', key: 'sendCount' } as const, 0)
const confirmStop = atom({ plugin: 'agent-hub', key: 'confirmStop' } as const, null)
const isExpanded = atom({ plugin: 'agent-hub', key: 'isExpanded' } as const, true)
const EMPTY_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, model: '' }
const task = atom({ plugin: 'agent-hub', key: 'task' } as const, 0)
const showAll = atom({ plugin: 'agent-hub', key: 'showAll' } as const, false)
const contextFill = atom({ plugin: 'agent-hub', key: 'context' } as const, null)
const promptCache = atom({ plugin: 'agent-hub', key: 'cache' } as const, null)
// The context bar: the used part solid in Claude's orange, red once the
// window is 80% full (compaction is near); the rest a light shade.
const BAR_COLOR = 'claude'
const BAR_FULL_COLOR = 'error'
const sessionCost = atom({ plugin: 'agent-hub', key: 'sessionCostUsd' } as const, null)
const rateLimits = atom({ plugin: 'agent-hub', key: 'rateLimits' } as const, [])
const shells = atom({ plugin: 'agent-hub', key: 'shells' } as const, [])
const remote = atom({ plugin: 'agent-hub', key: 'remote' } as const, { status: 'off' })
// The steps a running agent's expanded card lists, and the calls under its
// item in progress: few, so a card stays short; a finished agent's card
// folds to one line, and the detail view lists them all.
const CARD_STEPS = 3
const CARD_TASK_STEPS = 3
// The spawned shells' logs are read every SHELL_EVERY ticks while one runs;
// the tasks dir, when needed, is looked for every SCAN_EVERY polls until found.
const SHELL_EVERY = 2
const SCAN_EVERY = 8
// The size the pane asks for: columns docked beside a fullscreen transcript,
// rows seated inline above the prompt. A size the person set wins.
const OPEN_SIZE = { columns: 80, rows: 32 } as const
// How long a first press of stop waits for the second.
const CONFIRM_MS = 3000

const GLYPH: Record<AgentRowStatus, string> = {
  pending: '◌',
  running: '●',
  waiting: '◐',
  idle: '○',
  completed: '✓',
  failed: '✗',
  killed: '⊘',
}

const LABEL: Record<AgentRowStatus, string> = {
  pending: 'pending',
  running: 'running',
  waiting: 'waiting',
  idle: 'idle',
  completed: 'done',
  failed: 'failed',
  killed: 'stopped',
}

const COLOR: Record<AgentRowStatus, string> = {
  pending: 'inactive',
  running: 'claude',
  waiting: 'warning',
  idle: 'inactive',
  completed: 'success',
  failed: 'error',
  killed: 'error',
}

const TURN_LABEL: Record<TurnEndReason, string> = {
  answer: 'done',
  aborted: 'stopped',
  refusal: 'refused',
  error: 'failed',
}

const STEP_GLYPH: Record<StepStatus, string> = { running: '●', done: '✓', error: '✗', denied: '⊘' }
const STEP_COLOR: Record<StepStatus, string> = { running: 'claude', done: 'success', error: 'error', denied: 'warning' }
const TODO_COLOR: Record<TodoStatus, string> = { pending: 'inactive', in_progress: 'claude', completed: 'success' }
// The main checklist drawn as Claude Code draws its own task list.
const TASK_GLYPH: Record<TodoStatus, string> = { pending: '□', in_progress: '■', completed: '✔' }
const TASK_COLOR: Record<TodoStatus, string | undefined> = { pending: undefined, in_progress: 'claude', completed: 'success' }
const SHELL_GLYPH: Record<ShellStatus, string> = { running: '●', done: '✓', failed: '✗', stopped: '⊘' }
const SHELL_COLOR: Record<ShellStatus, string> = { running: 'claude', done: 'success', failed: 'error', stopped: 'warning' }
const SHELL_WORD: Record<ShellStatus, string> = { running: 'running', done: 'done', failed: 'failed', stopped: 'stopped' }
const TASK_WORD: Record<TodoStatus, string> = { pending: 'pending', in_progress: 'in progress', completed: 'done' }

// The pane's heading, "Subagents": Claude's orange, as the theme spells it.
const TITLE_COLOR = 'claude'
/** Claude's mascot, drawn in blocks as Claude Code draws it at start. */
const MASCOT = [' ▐▛███▜▌', '▝▜█████▛▘', '  ▘▘ ▝▝']
/**
 * "AGENT HUB" in quarter blocks, as the mascot is drawn: three rows like it,
 * half a column between letters.
 */
const NAME_ART = [
  '▟▛▜▙▗█▀▀▘█▛▀▘█▙ █▌▀▜█▀▘ ▐█ █▌█▌▐█▐█▀█▖',
  '█▙▟█▐█▗▄▖█▛▀ █▛██▌ ▐█   ▐█▀█▌█▌▐█▐█▀█▖',
  '█▌▐█▝█▄█▌█▙▄▖█▌▝█▌ ▐█   ▐█ █▌▜▙▟▛▐█▄█▘',
]
/** Mascot, gap and name: the columns the drawn header needs. */
const HEADER_WIDTH = 9 + 2 + NAME_ART[0]!.length

const openKey = (id: string) => `open:${id}`
const childKey = (id: string) => `child:${id}`
const shellKey = (id: string) => `shell:${id}`
const historyKey = (id: string) => `history:${id}`

let ticks = 0
// Where the engine writes the session's command logs, when a result did not
// name a shell's own. The module's own: a reload looks again.
let tasksDir: string | undefined
let polls = 0

const sanitize = (path: string) => path.replace(/[^a-zA-Z0-9]/g, '-')

// The engine keeps a session's command logs in `<tmp>/claude-<uid>/<project>/<session>/tasks`:
// the project's folder guessed from the session's start first, then every one.
async function findTasksDir($: EngineInterface): Promise<string | undefined> {
  const id = await $.session.id()
  const guesses = [sanitize(await $.session.root()), sanitize(await $.session.cwd())]
  const own = await $.env.get('CLAUDE_CODE_TMPDIR')
  for (const tmp of [own, '/private/tmp', '/tmp']) {
    if (tmp === undefined) continue
    const roots = (await $.fs.list(tmp).catch(() => [])).filter(one => one.kind === 'dir' && one.name.startsWith('claude-'))
    for (const root of roots) {
      const projects = (await $.fs.list(`${tmp}/${root.name}`).catch(() => [])).filter(one => one.kind === 'dir')
      const names = [...new Set([...guesses, ...projects.map(one => one.name)])]
      for (const name of names) {
        const dir = `${tmp}/${root.name}/${name}/${id}/tasks`
        if (await $.fs.exists(dir).catch(() => false)) return dir
      }
    }
  }

  return undefined
}

// Reads each running shell's log when it grew; the log's exit line ends the shell.
async function pollShells($: EngineInterface) {
  const running = (await read($, shells)).filter(one => one.status === 'running')
  if (running.length === 0) return
  if (tasksDir === undefined && running.some(one => one.logPath === undefined) && polls++ % SCAN_EVERY === 0) {
    tasksDir = await findTasksDir($)
  }
  for (const row of running) {
    const path = row.logPath ?? (tasksDir === undefined ? undefined : `${tasksDir}/${row.taskId}.output`)
    if (path === undefined) continue
    const stat = await $.fs.stat(path).catch(() => undefined)
    const t = await $.clock.now()
    // The log gone with no exit line: the command was stopped.
    if (stat === undefined) {
      await update($, shells, rows => patchRunning(rows, row.id, { status: 'stopped', endedAt: t }))
      continue
    }
    if (stat.size === row.size) continue
    if (stat.size > MAX_LOG_BYTES) {
      const tail = [`… ${formatTokens(stat.size)}B of output, too much to tail here`]
      await update($, shells, rows => patchRunning(rows, row.id, { tail, size: stat.size }))
      continue
    }
    const text = await $.fs.read(path).catch(() => undefined)
    if (typeof text !== 'string') continue
    const { tail, exitCode } = readLog(text)
    const end: Partial<ShellRow> =
      exitCode === undefined ? {} : { status: exitCode === 0 ? 'done' : 'failed', exitCode, endedAt: t }
    await update($, shells, rows => patchRunning(rows, row.id, { tail, size: stat.size, ...end }))
  }
}

// Reads the engine's roster and folds it in, writing only on a change so an
// idle session redraws nothing.
async function refresh($: EngineInterface) {
  let list: AgentInfo[]
  try {
    list = await $.agent.list()
  } catch {
    return
  }
  const t = await $.clock.now()
  const current = await read($, task)
  const before = await read($, agents)
  if (JSON.stringify(applyList(before, list, t, current)) !== JSON.stringify(before)) {
    await update($, agents, rows => applyList(rows, list, t, current))
  }

  const keep = new Set(Object.keys(await read($, agents)))
  const acts = await read($, activity)
  if (pruneActivity(acts, keep) !== acts) {
    await update($, activity, a => pruneActivity(a, keep))
  }
  const shown = await read($, selected)
  if (shown !== null && !keep.has(shown)) {
    await update($, selected, () => null)
  }
}

async function tick($: EngineInterface) {
  ticks += 1
  if (ticks % LIST_EVERY === 0) await refresh($)
  if (ticks % SHELL_EVERY === 0) await pollShells($).catch(() => undefined)
  if (ticks % SYNC_EVERY === 0) void sync($).catch(() => undefined)
  const isShellBusy = (await read($, shells)).some(one => one.status === 'running')
  const isTaskBusy = Object.values(await read($, taskLogs)).some(log => log.steps.at(-1)?.status === 'running')
  const isTaskOpen = (await read($, tasks)).some(item => item.status === 'in_progress')
  // The cache countdown ticks until a tick past its expiry.
  const cache = await read($, promptCache)
  const isCacheWarm = cache !== null && (await read($, now)) < cache.at + CACHE_TTL_MS
  if (hasActive(await read($, agents)) || isTaskBusy || isTaskOpen || isShellBusy || isCacheWarm) {
    const t = await $.clock.now()
    await update($, now, () => t)
  }
}

// The state library takes each value by its own reference: one write per log.
const writeLog = ($: EngineInterface, log: Log, change: (logs: Logs) => Logs) =>
  log === 'task' ? update($, taskLogs, change) : update($, activity, change)

// A step ends in `log` under `key`.
async function endStep($: EngineInterface, log: Log, key: string, stepId: string, ran: ToolCallResult) {
  const t = await $.clock.now()
  const [status, note]: [Exclude<StepStatus, 'running'>, string | undefined] =
    ran.deny !== undefined ? ['denied', ran.deny] : ran.isError === true ? ['error', ran.text] : ['done', undefined]
  await writeLog($, log, a => applyStepEnd(a, key, stepId, status, t, note))
}

async function failStep($: EngineInterface, log: Log, key: string, stepId: string) {
  const t = await $.clock.now()
  await writeLog($, log, a => applyStepEnd(a, key, stepId, 'error', t, 'cancelled'))
}

// Shows one agent (or the list, for null) and puts the focus ring on `key`
// once the next drawing has it; a pane not holding the keys refuses, harmlessly.
async function show($: EngineInterface, id: string | null, key: string) {
  await update($, selectedShell, () => null)
  await update($, selected, () => id)
  await $.ui.focus({ requestId: PANE, key }).catch(() => undefined)
}

// Shows one shell (or the list, for null), the focus ring on `key` as show puts it.
async function showShell($: EngineInterface, id: string | null, key: string) {
  await update($, selected, () => null)
  await update($, selectedShell, () => id)
  await $.ui.focus({ requestId: PANE, key }).catch(() => undefined)
}

// The first press asks; a second within CONFIRM_MS stops the background command.
async function stopShell($: EngineInterface, row: ShellRow) {
  const asking = shellKey(row.id)
  if ((await read($, confirmStop)) !== asking) {
    await update($, confirmStop, () => asking)
    $.clock.after(CONFIRM_MS, () => void update($, confirmStop, id => (id === asking ? null : id)).catch(() => undefined))

    return
  }
  await update($, confirmStop, () => null)
  const ran = await $.tool.call({ tool: 'TaskStop', task_id: row.taskId })
  if (ran.deny !== undefined || ran.isError === true) {
    $.ui.toast(`Agent Hub: could not stop the command: ${ran.deny ?? ran.text ?? 'unknown error'}`)

    return
  }
  const t = await $.clock.now()
  await update($, shells, list => patchRunning(list, row.id, { status: 'stopped', endedAt: t }))
  $.ui.toast('Agent Hub: stopped the command')
}

// Puts an agent's transcript in the main view, or the main conversation back
// for undefined; only a press of the person's own moves it.
async function view($: EngineInterface, agentId: string | undefined) {
  const moved = await $.ui.view(agentId === undefined ? {} : { agentId })
  if (moved.deny !== undefined) $.ui.toast(`Agent Hub: ${moved.deny}`)
}

const msgKey = (count: number) => `msg:${count}`

// Sends the person's text to the agent's loop, as SendMessage would, then
// draws the field anew, empty, with the focus back on it.
async function send($: EngineInterface, row: AgentRow, text: string) {
  const message = text.trim()
  if (message === '') return

  const sent = await $.session.send({ to: { agentId: row.id }, text: message })
  if (!sent.isDelivered) {
    $.ui.toast(`Agent Hub: not sent: ${sent.reason}`)

    return
  }
  const count = await update($, sendCount, n => n + 1)
  $.ui.toast(`Agent Hub: message sent to ${row.type}`)
  await $.ui.focus({ requestId: PANE, key: msgKey(count) }).catch(() => undefined)
}

// The first press asks; a second within CONFIRM_MS stops the agent's task.
async function stop($: EngineInterface, row: AgentRow) {
  if ((await read($, confirmStop)) !== row.id) {
    await update($, confirmStop, () => row.id)
    $.clock.after(CONFIRM_MS, () => void update($, confirmStop, id => (id === row.id ? null : id)).catch(() => undefined))

    return
  }
  await update($, confirmStop, () => null)
  const ran = await $.tool.call({ tool: 'TaskStop', task_id: row.id })
  if (ran.deny !== undefined || ran.isError === true) {
    $.ui.toast(`Agent Hub: could not stop ${row.type}: ${ran.deny ?? ran.text ?? 'unknown error'}`)

    return
  }
  $.ui.toast(`Agent Hub: stopped ${row.type}`)
  await refresh($)
}

// The helper's run while remote control is on, and the socket it listens on
// for the mod once it said its port. Module variables: a reload ends the
// helper with the module, and the pane reads off again (session.start).
let helper: HookStream<ProcessSpawnChunk, ProcessSpawnResult> | undefined
let helperSocket: string | undefined
let isStopping = false
let isSyncing = false
// The main conversation, for the phone: in a turn or not, the turn it runs
// (its prompt and start), its latest answer, and the phone's prompts not yet started.
let isMainBusy = false
let mainTurn: RemoteTurn | null = null
let lastResult: RemoteResult | null = null
let queued: string[] = []
// A slash command the phone ran: the turn it starts (a skill, a prompt
// command) is named by what the phone sent, so its pin finds the answer.
let phoneCommand: string | undefined
let turnSinceCommand = false
// The files each phone prompt mentions, by its text, for prompt.submit to attach.
const mentioned = new Map<string, string[]>()
// The catalog as last sent, and when it was last read.
let catalogSent = ''
// The history as last sent, when it was last read, and whether a turn has moved it since.
let historySent = ''
let historyAt = 0
let isHistoryStale = true
// The link's QR code as drawn last: a render redraws it often, the link seldom changes.
let qrDrawn: { link: string; lines: string[] } | undefined
let catalogAt = 0

// The link's QR code as pane lines; none when too long for a code.
function qrOf(link: string): string[] {
  if (qrDrawn?.link !== link) {
    const code = qrEncode(link)
    qrDrawn = { link, lines: code === undefined ? [] : qrLines(code) }
  }

  return qrDrawn.lines
}

const describeRemote = (state: RemoteStatus): string => {
  switch (state.status) {
    case 'on':
      return `Remote control is on. Open on the phone: ${state.link ?? '(no link yet)'}`
    case 'starting':
      return 'Remote control is starting; the link shows in the Agent Hub pane, or ask for status again in a few seconds.'
    case 'error':
      return `Remote control failed: ${state.note ?? 'the helper stopped'}`
    default:
      return 'Remote control is off.'
  }
}

async function startRemote($: EngineInterface) {
  if (helper !== undefined) return
  // A new helper has no catalog yet, nor any history.
  catalogSent = ''
  catalogAt = 0
  historySent = ''
  isHistoryStale = true
  const token = await $.store.get(STORE_TOKEN)
  // A socket path stays short: the per-user temp directory, the session's id cut.
  const dir = ((await $.env.get('TMPDIR')) ?? '/tmp').replace(/\/+$/, '')
  const socket = `${dir}/agent-hub-${(await $.session.id()).slice(0, 8)}.sock`
  const env: Record<string, string> = { AGENT_HUB_SOCKET: socket }
  if (typeof token === 'string') env.AGENT_HUB_TOKEN = token

  await update($, remote, () => ({ status: 'starting' }))
  isStopping = false
  const run = $.process.spawn({ argv: ['node', `${$.plugin.root}/remote/server.mjs`], env })
  helper = run
  void watchHelper($, run, socket)
}

// Reads the helper's lines until it exits, the pane following what it says.
async function watchHelper($: EngineInterface, run: HookStream<ProcessSpawnChunk, ProcessSpawnResult>, socket: string) {
  // The helper says its token first, the kept one or a new one.
  let token = ''
  let pending = ''
  let failure: string | undefined
  // The last thing it wrote to stderr: why it died, when it did not say.
  let complaint: string | undefined
  try {
    for await (const { stream, text } of run) {
      if (stream === 'stderr') {
        complaint = text.trim().split('\n').at(-1) || complaint
        continue
      }
      const lines = (pending + text).split('\n')
      pending = lines.pop() ?? ''
      for (const line of lines) {
        const event = parseHelperLine(line)
        if (event === undefined) continue
        if (event.kind === 'token') {
          token = event.token
          await $.store.set(STORE_TOKEN, token)
        } else if (event.kind === 'port') {
          helperSocket = socket
        } else if (event.kind === 'url') {
          // A new address, at start or mid-run: the phone needs the new link.
          const link = shareUrl(event.url, token)
          // Up again after a retry: the earlier error is past.
          await update($, remote, ({ note: _past, ...state }) => ({ ...state, status: 'on' as const, link }))
        } else {
          failure = event.text
          const note = event.text
          await update($, remote, state => ({ ...state, note }))
        }
      }
    }
  } catch (error) {
    failure = `the helper did not start: ${String(error)}`
  }
  if (helper !== run) return
  helper = undefined
  helperSocket = undefined
  const note = failure ?? complaint ?? 'the helper stopped'
  await update($, remote, () => (isStopping ? { status: 'off' } : { status: 'error', note }))
}

async function stopRemote($: EngineInterface) {
  const socket = helperSocket
  isStopping = true
  helperSocket = undefined
  if (socket !== undefined) {
    await $.http.fetch('http://agent-hub/quit', { method: 'POST', socketPath: socket }).catch(() => undefined)
  }
  // Not yet listening: ending the loop kills it. Not awaited, as the loop
  // may wait on the child's next line; a deaf helper ends itself unsynced.
  if (socket === undefined) void helper?.return(undefined as never).catch(() => undefined)
  if (helper === undefined) await update($, remote, () => ({ status: 'off' }))
}

// Sends the pane's view to the helper and submits the prompts the phone sent.
async function sync($: EngineInterface) {
  const socket = helperSocket
  if (socket === undefined || isSyncing) return
  isSyncing = true
  try {
    const view = snapshot({
      now: await $.clock.now(),
      context: await read($, contextFill),
      costUsd: await read($, sessionCost),
      rateLimits: await read($, rateLimits),
      tasks: await read($, tasks),
      agents: await read($, agents),
      activity: await read($, activity),
      shells: await read($, shells),
      task: await read($, task),
      busy: isMainBusy,
      current: mainTurn,
      queued,
      result: lastResult,
    })
    const res = await $.http.fetch('http://agent-hub/sync', {
      method: 'POST',
      socketPath: socket,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        view,
        catalog: await catalogOf($).catch(() => undefined),
        history: await historyToSend($).catch(() => undefined),
      }),
    })
    const prompts: unknown = res.ok ? JSON.parse(res.text).prompts : []
    for (const text of Array.isArray(prompts) ? prompts : []) {
      if (typeof text !== 'string' || text === '') continue
      const slash = parseSlash(text)
      if (slash !== undefined) void runPhoneCommand($, text, slash)
      else void submitPhonePrompt($, text)
    }
    // The pane's waiting count reads `queued`, which no atom redraws.
    if (Array.isArray(prompts) && prompts.length > 0) $.ui.invalidate('ui.render')
  } finally {
    isSyncing = false
  }
}

// The main conversation's latest turns for the phone's history; undefined when unchanged since sent.
async function historyToSend($: EngineInterface): Promise<unknown[] | undefined> {
  const t = await $.clock.now()
  if (!isHistoryStale && t - historyAt < HISTORY_MS) return undefined
  isHistoryStale = false
  historyAt = t
  const turns = historyOf(await $.session.messages())
  const json = JSON.stringify(turns)
  if (json === historySent) return undefined
  historySent = json

  return turns
}

// The commands and files the phone's typeahead offers; undefined when unchanged since sent.
async function catalogOf($: EngineInterface): Promise<{ commands: unknown[]; files: string[] } | undefined> {
  const t = await $.clock.now()
  if (catalogSent !== '' && t - catalogAt < CATALOG_MS) return undefined
  catalogAt = t
  const commands = commandsFor(await $.command.list())
  const listed = await $.process
    .run(['git', 'ls-files', '--cached', '--others', '--exclude-standard'], { cwd: await $.session.root(), timeoutMs: 5000 })
    .catch(() => undefined)
  const files = listed?.exitCode === 0 ? listed.stdout.split('\n').filter(Boolean).slice(0, MAX_CATALOG_FILES) : []
  const json = JSON.stringify({ commands, files })
  if (json === catalogSent) return undefined
  catalogSent = json

  return { commands, files }
}

// A phone's slash command: its output is the answer the phone pins; a command
// that prompts the model starts a turn, answered at turn.complete.
async function runPhoneCommand($: EngineInterface, text: string, slash: { name: string; args: string }) {
  const at = async () => $.clock.now().catch(() => 0)
  if (isTerminalOnly(slash.name)) {
    lastResult = { prompt: text, text: `/${slash.name} draws a picker in the terminal: run it there.`, reason: 'error', at: await at() }

    return
  }
  phoneCommand = text
  turnSinceCommand = false
  try {
    const ran = await $.command.run({ command: slash.name, args: slash.args })
    if (ran.text !== undefined && ran.text !== '') lastResult = { prompt: text, text: ran.text, reason: 'answer', at: await at() }
    else if (!turnSinceCommand) lastResult = { prompt: text, text: `/${slash.name} ran.`, reason: 'answer', at: await at() }
  } catch (error) {
    lastResult = { prompt: text, text: `/${slash.name} failed: ${String(error)}`, reason: 'error', at: await at() }
  } finally {
    if (phoneCommand === text) phoneCommand = undefined
    isHistoryStale = true
  }
}

// A phone's prompt, its @ files read first for prompt.submit to attach (a
// plugin's prompt has no @ expansion of its own); unread, the model still
// sees the paths and can read them.
async function submitPhonePrompt($: EngineInterface, text: string) {
  queued = [...queued, text]
  const files = await mentionedFiles($, text).catch(() => [])
  if (files.length > 0) mentioned.set(text, files)
  void $.prompt.submit({ text, asUser: true }).catch(() => {
    queued = queued.filter(one => one !== text)
    mentioned.delete(text)
  })
}

async function mentionedFiles($: EngineInterface, text: string): Promise<string[]> {
  const root = await $.session.root()
  const blocks: string[] = []
  let total = 0
  for (const path of mentionsOf(text).slice(0, MAX_MENTIONS)) {
    const file = projectPath(root, path)
    if (file === undefined) continue
    const stat = await $.fs.stat(file).catch(() => undefined)
    if (stat?.kind !== 'file' || stat.size > MAX_MENTION_BYTES || total + stat.size > MAX_MENTION_TOTAL) continue
    const body: unknown = await $.fs.read(file).catch(() => undefined)
    // Text only: a NUL is a binary file.
    if (typeof body !== 'string' || body.includes('\u0000')) continue
    total += stat.size
    blocks.push(fileContext(path, body))
  }

  return blocks
}

async function remoteAction($: EngineInterface, action: string): Promise<string> {
  if (action === 'stop') {
    await stopRemote($)

    return 'Remote control stopped.'
  }
  if (action === 'start') {
    await startRemote($)
    const until = (await $.clock.now()) + REMOTE_START_MS
    while ((await read($, remote)).status === 'starting' && (await $.clock.now()) < until) await $.clock.sleep(500)
  }

  return describeRemote(await read($, remote))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'agent-hub', description: 'Open Agent Hub: context, tasks and subagents' })
    await $.tool
      .register({
        name: CHECKLIST,
        // For any agent without a checklist tool of its own (subagents, and a
        // main conversation whose build has none); one that has TodoWrite or
        // TaskCreate keeps using those, which the pane follows as well.
        description:
          'Write your task checklist so the person can follow your progress live in the Agent Hub pane. ' +
          'If TodoWrite or TaskCreate is already among your tools, use that instead. ' +
          'Send the whole list every time. Use it for any job of three or more steps: write the list first, ' +
          'mark an item in_progress when you start it and completed as soon as it is done, one in progress at a time.',
        inputSchema: CHECKLIST_SCHEMA,
        isDeferred: false,
      })
      .catch(() => undefined)
    await $.command.register({ name: REMOTE_COMMAND, description: 'Agent Hub: turn remote control from a phone on or off' })
    await $.tool
      .register({
        name: REMOTE,
        description:
          'Remote control of this session from another device: start opens a localhost.run link (with a token) to a page ' +
          'showing the Agent Hub pane, with a box whose prompts go to this session and the latest answer to review. ' +
          'stop closes it; status says how it stands. Give the person the link it answers.',
        inputSchema: REMOTE_SCHEMA,
        isDeferred: true,
      })
      .catch(() => undefined)
    // A reload ended the helper with the module that ran it.
    await update($, remote, () => ({ status: 'off' }))
    void $.ui.open({ id: PANE, title: TITLE, ...OPEN_SIZE })
    $.clock.every(TICK_MS, () => void tick($).catch(() => undefined))
    // The checklist as it stands when the mod loads; each plan call keeps it current after.
    void $.tool
      .call({ tool: 'TaskList' })
      .then(ran => {
        const list = planFromTaskList(ran.result)
        if (list === undefined) return undefined

        return Promise.all([
          update($, tasks, () => list),
          update($, currentTask, () => currentTaskAfter([], list, null)),
        ])
      })
      .catch(() => undefined)
    void $.session
      .usage()
      .then(({ cost, context, rateLimits: limits }) =>
        Promise.all([
          cost === undefined ? undefined : update($, sessionCost, () => cost.usd),
          update($, rateLimits, () => orderLimits(limits)),
          context.tokens === undefined
            ? undefined
            : update($, contextFill, () => ({ tokens: context.tokens ?? 0, window: context.window })),
        ]),
      )
      .catch(() => undefined)

    return next(e)
  })

  // Each prompt the person sends starts a task; a slash command or a prompt
  // the engine made itself (a background task's notification, a subagent's
  // hand-back) does not, so neither opening the pane nor an agent finishing
  // hides what the person's prompt started.
  on('prompt.submit', async ($, e, next) => {
    if (e.command === undefined && e.isMeta !== true && isPersonOrigin(e.origin)) {
      await update($, task, n => n + 1).catch(() => undefined)
    }
    // A phone prompt's @ files, read before it was submitted.
    const files = mentioned.get(e.text)
    if (files !== undefined) {
      mentioned.delete(e.text)

      return next({ ...e, context: [...(e.context ?? []), ...files] })
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  // The engine raises a measurement as the session's figures move: the cost is /cost's own.
  on('session.measure', async ($, e, next) => {
    const usd = e.cost?.usd
    if (usd !== undefined) await update($, sessionCost, () => usd).catch(() => undefined)
    if (e.changed.includes('rateLimits')) {
      await update($, rateLimits, () => orderLimits(e.rateLimits)).catch(() => undefined)
    }
    const tokens = e.context.tokens
    if (tokens !== undefined) {
      await update($, contextFill, () => ({ tokens, window: e.context.window })).catch(() => undefined)
    }

    return next(e)
  })

  // Each model request of a subagent's turn: its tokens count at once, not
  // only when the turn ends; the main conversation's sets the cache line.
  // The stream passes through untouched first.
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    const agentId = e.agentId
    const usage = result.usage
    if (agentId !== undefined && usage !== null) {
      await update($, activity, a => applyStepUsage(a, agentId, usage)).catch(() => undefined)
    } else if (usage !== null) {
      const t = await $.clock.now()
      await update($, promptCache, () => cacheReading(usage, t)).catch(() => undefined)
    }

    return result
  })

  on('command.run', { command: 'agent-hub' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE, focus: true, ...OPEN_SIZE })

    return { text: 'Agent Hub pane opened.' }
  })

  on('command.run', { command: REMOTE_COMMAND }, async $ => {
    if (helper !== undefined) {
      await stopRemote($)

      return { text: 'Agent Hub: remote control stopped.' }
    }
    await startRemote($)
    await $.ui.open({ id: PANE, title: TITLE, ...OPEN_SIZE })

    return { text: 'Agent Hub: remote control starting; the link and its QR code show in the pane.' }
  })

  on('turn.start', async ($, e, next) => {
    const id = e.agentId
    if (id === undefined) {
      isMainBusy = true
      isHistoryStale = true
      // A turn a phone's command started is named by the command the phone sent.
      const prompt = phoneCommand ?? e.text
      if (phoneCommand !== undefined) turnSinceCommand = true
      phoneCommand = undefined
      mentioned.delete(e.text)
      mainTurn = { prompt, startedAt: await $.clock.now().catch(() => 0) }
      // A prompt the phone sent has started: it waits no more.
      const at = queued.indexOf(e.text)
      if (at >= 0) {
        queued = queued.filter((_, i) => i !== at)
        $.ui.invalidate('ui.render')
      }
    } else {
      const t = await $.clock.now()
      const current = await read($, task)
      await update($, agents, rows => applyTurnStart(rows, id, t, current))
      await update($, activity, a => applyTurnBegin(a, id, e.turnId, e.text, t))
      void refresh($).catch(() => undefined)
    }

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const id = e.agentId
    if (id === undefined) {
      // The main conversation's answer, for the phone to review.
      const ended = await next(e)
      isMainBusy = false
      isHistoryStale = true
      lastResult = { prompt: mainTurn?.prompt ?? '', text: ended.text, reason: e.reason, at: await $.clock.now().catch(() => 0) }

      return ended
    } else {
      const t = await $.clock.now()
      const current = await read($, task)
      await update($, agents, rows => applyTurnComplete(rows, id, e.reason, t, current))
      await update($, activity, a => applyTurnEnd(a, id, e.turnId, e.reason, t))
      const usage = e.usage
      await update($, activity, a => (usage === undefined ? settleLive(a, id) : applyUsage(a, id, usage)))
      void refresh($).catch(() => undefined)
    }

    return next(e)
  })

  // A Bash call that leaves its command running in the background, the main
  // conversation's or a subagent's, spawned a shell: the pane watches its log
  // as it watches a subagent. A foreground command is the transcript's.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const t = await $.clock.now().catch(() => 0)
    const ran = await next(e)
    const spawned = ran.deny === undefined ? spawnedOf(ran.result, ran.text) : undefined
    if (spawned !== undefined) {
      const row: ShellRow = {
        id: e.tool_use_id ?? spawned.taskId,
        command: String(e.command ?? ''),
        description: typeof e.description === 'string' && e.description !== '' ? e.description : undefined,
        agentId: e.agentId,
        task: await read($, task).catch(() => 0),
        status: 'running',
        ...spawned,
        startedAt: t,
        tail: [],
      }
      await update($, shells, list => startShell(list, row)).catch(() => undefined)
    }

    return ran
  })

  // A background command stopped by its id ends its shell.
  on('tool.call', { tool: 'TaskStop' }, async ($, e, next) => {
    const ran = await next(e)
    const stopped = e.task_id ?? e.shell_id
    if (stopped !== undefined && ran.deny === undefined && ran.isError !== true) {
      const t = await $.clock.now().catch(() => 0)
      await update($, shells, list =>
        list.map(one => (one.taskId === stopped && one.status === 'running' ? { ...one, status: 'stopped' as const, endedAt: t } : one)),
      ).catch(() => undefined)
    }

    return ran
  })

  // Watching must never stand in a tool's way: a failure here passes the call on.
  on('tool.call', async ($, e, next) => {
    const agentId = e.agentId
    const tool = String(e.tool)
    const args = Object.fromEntries(Object.entries(e).filter(([key]) => !RESERVED.has(key)))

    // This mod's own checklist tool, answered here: a subagent's list goes to
    // its card, the main conversation's to the Tasks group.
    if (tool === CHECKLIST_TOOL) {
      const asWrite = { todos: args.todos }
      if (agentId === undefined) {
        const before = await read($, tasks)
        const planned = nextPlan(before, 'TodoWrite', asWrite, {})
        if (planned !== undefined) {
          const after = stampStarts(before, planned, await $.clock.now())
          await update($, tasks, () => after)
          await update($, currentTask, current => currentTaskAfter(before, after, current))
        }
      } else {
        const t = await $.clock.now()
        await update($, activity, a => applyPlan(a, agentId, 'TodoWrite', asWrite, {}, t))
      }
      const count = Array.isArray(args.todos) ? args.todos.length : 0

      // A registered tool's result is text (or content blocks), never an object.
      const saved = `Checklist saved (${plural(count, 'item')}); the person sees it in the Agent Hub pane.`

      return { result: saved, text: saved }
    }

    // Remote control, this mod's other tool.
    if (tool === REMOTE_TOOL) {
      const said = await remoteAction($, String(args.action ?? 'status'))

      return { result: said, text: said }
    }

    // Logs the call as a step of `key` in `log`, running until the call settles.
    const logged = async (log: Log, key: string): Promise<ToolCallResult> => {
      const t = await $.clock.now()
      const stepId = e.tool_use_id ?? `${key}:${t}`
      const step: StepRow = { id: stepId, tool, summary: summarize(tool, args), status: 'running', startedAt: t }
      await writeLog($, log, a => applyStepStart(a, key, step))

      // An Agent call is left unawaited: the hook stays out of the child's spawn,
      // and the step settles when the call does.
      if (tool === 'Agent') {
        const pending = next(e)
        void pending.then(
          ran => endStep($, log, key, stepId, ran),
          () => failStep($, log, key, stepId),
        ).catch(() => undefined)

        return pending
      }
      try {
        const ran = await next(e)
        await endStep($, log, key, stepId, ran)

        return ran
      } catch (error) {
        await failStep($, log, key, stepId)
        throw error
      }
    }

    // The main conversation: its checklist calls keep the Tasks group current,
    // and any other call is logged under the task it works on, if one.
    if (agentId === undefined) {
      if (PLAN_TOOLS.has(tool)) {
        const ran = await next(e)
        if (ran.deny === undefined && ran.isError !== true) {
          const before = await read($, tasks)
          const planned = nextPlan(before, tool, args, ran.result)
          const after = planned === undefined ? undefined : stampStarts(before, planned, await $.clock.now())
          if (after !== undefined) {
            await update($, tasks, () => after)
            await update($, currentTask, current => currentTaskAfter(before, after, current))
          }
        }

        return ran
      }
      const taskId = TASK_TOOLS.has(tool) ? null : await read($, currentTask)

      return taskId === null ? next(e) : logged('task', taskId)
    }

    const ran = logged('agent', agentId)
    if (!PLAN_TOOLS.has(tool)) return ran
    const settled = await ran
    if (settled.deny === undefined && settled.isError !== true) {
      const t = await $.clock.now()
      await update($, activity, a => applyPlan(a, agentId, tool, args, settled.result, t))
    }

    return settled
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const table = $.ui.resolve(e)
    const { Box, Button, Text } = table
    // Mobile draws no text field: there the message box is left out.
    const Input = 'Input' in table ? table.Input : undefined
    const rows = await read($, agents)
    const acts = await read($, activity)
    const t = await read($, now)
    const shown = await read($, selected)
    const shownShell = await read($, selectedShell)
    const sends = await read($, sendCount)
    const asking = await read($, confirmStop)
    const expanded = await read($, isExpanded)
    const cost = await read($, sessionCost)
    const fill = await read($, contextFill)
    const cache = await read($, promptCache)
    const limits = await read($, rateLimits)
    const isAll = await read($, showAll)
    const checklist = await read($, tasks)
    const logs = await read($, taskLogs)
    const shellRows = await read($, shells)
    const currentPrompt = await read($, task)
    const remoteState = await read($, remote)
    // The list keeps to the latest task unless the person asked for all;
    // the detail view still finds any agent's children.
    const allLines = visibleTree(rows)
    const lines = isAll ? allLines : visibleTree(latestTask(rows, currentPrompt))
    const hidden = allLines.length - lines.length
    const frame = spinnerFrame(t, TICK_MS)
    const columns = e.props.bodyColumns
    // The agent whose transcript the main view shows, if any.
    const viewing = e.props.view.agentId
    const banner = viewing !== undefined && (
      <Box flexDirection="row" gap={2}>
        <Text color="warning">
          Viewing {rows[viewing]?.type ?? 'an agent'}'s transcript
        </Text>
        <Button key="main" plain hotkey="m" label="main conversation" onPress={() => view($, undefined)} />
      </Box>
    )

    const timeOf = (row: AgentRow) => formatElapsed(elapsedMs(row, Math.max(t, row.startedAt ?? 0)))
    const countsOf = (act: AgentActivity | undefined) =>
      plural(act?.toolCount ?? 0, 'tool') +
      (act && act.errorCount > 0 ? ` · ${plural(act.errorCount, 'error')}` : '') +
      (act?.todos?.length ? ` · ${planProgress(act.todos)}` : '')
    // The title row's right end: the time, and the tokens once a turn reported them.
    const rightOf = (row: AgentRow) => {
      const usage = usageOf(acts[row.id])

      return usage === undefined ? timeOf(row) : `${timeOf(row)} · ${formatTokens(totalTokens(usage))} tok`
    }
    const stepTime = (step: StepRow) =>
      formatStepDuration((step.endedAt ?? Math.max(t, step.startedAt)) - step.startedAt)

    // Rows of styled text as a Button's children: one Text a run, a newline between rows.
    const drawLines = (drawn: readonly Line[]) =>
      drawn.flatMap((cardLine, index) => [
        ...cardLine.map(seg => (
          <Text color={seg.color} dimColor={seg.dim} bold={seg.bold} strikethrough={seg.strike}>
            {seg.text}
          </Text>
        )),
        ...(index < drawn.length - 1 ? ['\n'] : []),
      ])

    // What a card's top border carries: the status glyph and type on the left,
    // the time and tokens on the right.
    const titleOf = (row: AgentRow, isDone: boolean, style: (segs: Seg[]) => Seg[] = segs => segs) => ({
      left: style([
        { text: GLYPH[row.status], color: COLOR[row.status] },
        { text: ` ${row.type}`, color: 'text', bold: !isDone },
      ]),
      right: style([{ text: rightOf(row), color: 'text' }]),
    })

    // The task component, one for every checklist the pane shows: the main
    // conversation's (the Tasks group) and each subagent's (in its card and
    // its detail). A heading with a tally, the item in progress, then every
    // item while any is open, drawn as Claude Code draws its own list.
    const workingOf = (list: readonly TodoItem[]) => list.find(item => item.status === 'in_progress')
    const isOpen = (list: readonly TodoItem[]) => list.some(item => item.status !== 'completed')
    // An agent that ended with items open left them undone: none is in progress any more.
    const leftOf = (list: readonly TodoItem[]): TodoItem[] =>
      list.map(item => (item.status === 'in_progress' ? { ...item, status: 'pending' } : item))
    const tallyOf = (list: readonly TodoItem[], isOver = false) => {
      const parts = (['in_progress', 'pending', 'completed'] as const)
        .map(status => [status, list.filter(item => item.status === status).length] as const)
        .filter(([, count]) => count > 0)
        .map(([status, count]) => `${count} ${isOver && status === 'pending' ? 'not done' : TASK_WORD[status]}`)

      return parts.length > 0 ? parts.join(' · ') : 'none'
    }
    const taskHeading = (list: readonly TodoItem[], extra: readonly string[] = [], isOver = false) => (
      <Text>
        <Text bold>
          <Text color={TITLE_COLOR}>Tasks</Text>: {tallyOf(list, isOver)}
        </Text>
        <Text dimColor>{extra.filter(Boolean).map(part => ` · ${part}`).join('')}</Text>
      </Text>
    )
    const workingLine = (list: readonly TodoItem[], facts: readonly string[] = []) => {
      const item = workingOf(list)
      const shown = facts.filter(Boolean)

      return (
        item !== undefined && (
          <Text color={TODO_COLOR.in_progress}>
            ✳ {item.active ?? item.text}…{shown.length > 0 && <Text dimColor> ({shown.join(' · ')})</Text>}
          </Text>
        )
      )
    }
    // The items, `logs` (the main conversation's) listing each in-progress
    // item's latest calls under it and folding a finished one's to a count.
    const taskItems = (list: readonly TodoItem[], logs?: Record<string, AgentActivity>) =>
      list.map((item, index) => {
        const log = logs?.[item.id]
        const steps = log?.steps ?? []
        const shownSteps = item.status === 'in_progress' ? steps.slice(-TASK_LOG_STEPS) : []
        const earlier = steps.length - shownSteps.length
        const tally =
          item.status === 'completed' && log !== undefined && log.toolCount > 0
            ? ` · ${plural(log.toolCount, 'tool')}${log.errorCount > 0 ? ` · ${plural(log.errorCount, 'error')}` : ''}`
            : ''

        return (
          <Box flexDirection="column" key={`task:${item.id}`}>
            {/* The glyph in a column of its own: a long item wraps under its text, not under the glyph. */}
            <Box flexDirection="row">
              <Box flexShrink={0} marginRight={1}>
                <Text>
                  <Text dimColor>{index === 0 ? '  ⎿ ' : '    '}</Text>
                  <Text color={TASK_COLOR[item.status]}>{TASK_GLYPH[item.status]}</Text>
                </Text>
              </Box>
              <Box flexGrow={1} flexShrink={1}>
                <Text>
                  <Text
                    bold={item.status === 'in_progress'}
                    dimColor={item.status === 'completed'}
                    strikethrough={item.status === 'completed'}
                  >
                    {item.text}
                  </Text>
                  {tally !== '' && <Text dimColor>{tally}</Text>}
                </Text>
              </Box>
            </Box>
            {item.status === 'in_progress' && earlier > 0 && (
              <Text dimColor>{`      … ${plural(earlier, 'earlier call')}`}</Text>
            )}
            {shownSteps.map(step => (
              <Box flexDirection="row" key={`task-step:${step.id}`} marginLeft={6}>
                <Box flexShrink={0} marginRight={1}>
                  <Text dimColor={step.status !== 'running'}>
                    <Text color={STEP_COLOR[step.status]}>{step.status === 'running' ? frame : STEP_GLYPH[step.status]}</Text>{' '}
                    {step.tool}
                  </Text>
                </Box>
                <Box flexGrow={1} flexShrink={1}>
                  <Text dimColor>{step.note ? `${step.summary} — ${step.note}` : step.summary}</Text>
                </Box>
                <Box flexShrink={0} marginLeft={1}>
                  <Text dimColor>{stepTime(step)}</Text>
                </Box>
              </Box>
            ))}
          </Box>
        )
      })
    // The same component as rows of a card, which holds only text.
    // `stepRows` draws the agent's calls since the item in progress began,
    // which then sit under it, as the Tasks group lists the main conversation's.
    const taskLines = (list: readonly TodoItem[], inner: number, stepRows?: (one: TodoItem) => Line[]): Line[] => {
      const item = workingOf(list)

      return [
        ...layoutRow(
          [
            { text: 'Tasks', color: TITLE_COLOR, bold: true },
            { text: `: ${tallyOf(list)}`, bold: true },
          ],
          undefined,
          inner,
        ),
        ...(item === undefined
          ? []
          : layoutRow([{ text: `✳ ${item.active ?? item.text}…`, color: TODO_COLOR.in_progress }], undefined, inner)),
        ...(isOpen(list)
          ? list.flatMap((one, index) =>
              layoutRow(
                [
                  { text: index === 0 ? '⎿ ' : '  ', dim: true },
                  { text: TASK_GLYPH[one.status], color: TASK_COLOR[one.status] },
                  { text: ' ' },
                  {
                    text: one.text,
                    bold: one.status === 'in_progress',
                    dim: one.status === 'completed',
                    strike: one.status === 'completed',
                  },
                ],
                undefined,
                inner,
                4,
              ).concat(one.status === 'in_progress' && stepRows !== undefined ? stepRows(one) : []),
            )
          : []),
      ]
    }

    // A card in the list is one Button, laid out by hand: Tab lands on the
    // whole card and the ring inverts all of it; Enter opens it. The ring
    // starts on the first card when the pane takes the keys, not on a toggle.
    const card = (row: AgentRow, depth: number, isFirst: boolean) => {
      const act = acts[row.id]
      const steps = act?.steps ?? []
      const isDone = isEnded(row.status)
      const width = Math.max(MIN_CARD_WIDTH, columns - depth * 2)
      const inner = innerWidth(width)
      const counts = countsOf(act)
      const current = steps.at(-1)
      const lastError = [...steps].reverse().find(step => step.status === 'error' || step.status === 'denied')
      const stuck = isDone ? undefined : stuckNote(act, row.startedAt ?? row.firstSeenAt, t)
      const strip = steps.slice(-stripRoom(width, counts))
      const listed = steps.slice(-CARD_STEPS)
      const earlier = steps.length - listed.length
      const stepSegs = (step: StepRow, glyph: string): Seg[] => [
        { text: glyph, color: STEP_COLOR[step.status] },
        { text: ` ${step.tool} `, dim: step.status !== 'running' },
        { text: step.note ? `${step.summary} — ${step.note}` : step.summary, dim: true },
      ]
      const stepLines = (step: StepRow) =>
        layoutRow(
          stepSegs(step, step.status === 'running' ? frame : STEP_GLYPH[step.status]),
          [{ text: stepTime(step), dim: true }],
          inner,
        )
      const note = (text: string) => layoutRow([{ text, dim: true }], undefined, inner)
      // The calls since the item in progress began, under it, indented past its glyph.
      const todos = act?.todos ?? []
      const working = workingOf(todos)
      const underTask = (item: TodoItem): Line[] => {
        const since = item.startedAt === undefined ? steps : steps.filter(step => step.startedAt >= item.startedAt!)
        // Compact keeps the latest call alone.
        const shown = since.slice(expanded ? -CARD_TASK_STEPS : -1)
        const hidden = since.length - shown.length

        return [
          ...(hidden > 0 ? layoutRow([{ text: `      … ${plural(hidden, 'earlier call')}`, dim: true }], undefined, inner) : []),
          ...shown.flatMap(step =>
            layoutRow(
              [{ text: '      ' }, ...stepSegs(step, step.status === 'running' ? frame : STEP_GLYPH[step.status])],
              [{ text: stepTime(step), dim: true }],
              inner,
              8,
            ),
          ),
        ]
      }
      // While an item is in progress its calls show under it, not in a list of their own.
      const isTaskLog = working !== undefined

      const body: Line[] = [
        ...layoutRow(
          [{ text: row.description || row.name || row.id, dim: true }],
          isDone ? [{ text: `${counts} · ${LABEL[row.status]}` }] : undefined,
          inner,
        ),
        ...(!isDone && todos.length > 0 ? taskLines(todos, inner, isTaskLog ? underTask : undefined) : []),
        ...(expanded && !isDone && !isTaskLog && earlier > 0 ? note(`… ${plural(earlier, 'earlier step')} · enter: all`) : []),
        ...(expanded && !isDone && !isTaskLog ? listed.flatMap(stepLines) : []),
        ...(expanded && !isDone && !isTaskLog && current === undefined ? note('starting…') : []),
        ...(!expanded && !isDone && !isTaskLog
          ? current === undefined
            ? note(row.status === 'running' ? 'starting…' : LABEL[row.status])
            : stepLines(current)
          : []),
        ...(!expanded && !isDone && lastError !== undefined && lastError !== current
          ? layoutRow(stepSegs(lastError, STEP_GLYPH[lastError.status]), undefined, inner)
          : []),
        ...(stuck !== undefined ? layoutRow([{ text: `⚠ ${stuck}`, color: 'warning' }], undefined, inner) : []),
        ...(!isDone
          ? layoutRow(
              strip.map(step => ({ text: STEP_GLYPH[step.status], color: STEP_COLOR[step.status] })),
              [{ text: counts, dim: true }],
              inner,
            )
          : []),
      ]
      // A finished card is drawn dim throughout.
      const dimmed = (segs: Seg[]) => (isDone ? segs.map(seg => ({ ...seg, dim: true })) : segs)
      const drawn = framed(body.map(dimmed), width, { color: COLOR[row.status], dim: isDone }, titleOf(row, isDone, dimmed))

      return (
        <Box marginLeft={depth * 2} key={row.id}>
          <Button key={openKey(row.id)} plain autoFocus={isFirst || undefined} onPress={() => show($, row.id, 'back')}>
            {drawLines(drawn)}
          </Button>
        </Box>
      )
    }

    const detail = (row: AgentRow) => {
      const act = acts[row.id]
      const width = Math.max(MIN_CARD_WIDTH, columns)
      const inner = innerWidth(width)
      const groups = act === undefined ? [] : groupSteps(act)
      const turnCount = groups.filter(group => group.turn !== undefined).length
      const firstPrompt = groups.find(group => group.turn?.prompt)?.turn?.prompt
      const children = allLines.filter(line => line.row.parentId === row.id).map(line => line.row)
      const used = usageOf(act)
      const stuck = isEnded(row.status) ? undefined : stuckNote(act, row.startedAt ?? row.firstSeenAt, t)

      return (
        <Box flexDirection="column">
          {viewing !== row.id && banner}
          <Box flexDirection="row" gap={3}>
            <Button key="back" plain hotkey="b" autoFocus label="← back to list" onPress={() => show($, null, openKey(row.id))} />
            {viewing === row.id ? (
              <Button key="view" plain hotkey="v" label="main conversation" onPress={() => view($, undefined)} />
            ) : (
              <Button key="view" plain hotkey="v" label="view transcript" onPress={() => view($, row.id)} />
            )}
            {!isEnded(row.status) && (
              <Button
                key="stop"
                plain
                hotkey="s"
                label={asking === row.id ? 'press s again to stop' : 'stop agent'}
                onPress={() => stop($, row)}
              />
            )}
          </Box>
          {viewing === row.id && <Text color="warning">Showing this agent's transcript: what you type now goes to it.</Text>}
          <Box marginTop={1}>
            <Text>
              {drawLines(
                framed(
                  [
                    ...layoutRow([{ text: row.description || row.name || row.id, dim: true }], undefined, inner),
                    ...layoutRow(
                      [
                        { text: LABEL[row.status], color: COLOR[row.status] },
                        { text: ` · ${countsOf(act)}`, dim: true },
                      ],
                      undefined,
                      inner,
                    ),
                    ...(used === undefined
                      ? []
                      : layoutRow(
                          [
                            {
                              text: `${formatTokens(used.input + used.cacheRead + used.cacheWrite)} in (${formatTokens(used.cacheRead)} cached) · ${formatTokens(used.output)} out · ${used.model}`,
                              dim: true,
                            },
                          ],
                          undefined,
                          inner,
                        )),
                    ...(stuck === undefined ? [] : layoutRow([{ text: `⚠ ${stuck}`, color: 'warning' }], undefined, inner)),
                  ],
                  width,
                  { color: COLOR[row.status], dim: isEnded(row.status) },
                  titleOf(row, false),
                ),
              )}
            </Text>
          </Box>

          {!isEnded(row.status) && Input !== undefined && (
            <Box marginTop={1}>
              <Input
                key={msgKey(sends)}
                label="Message"
                placeholder="type, then enter to send to this agent"
                submitLabel="send"
                onSubmit={(text: string) => send($, row, text)}
              />
            </Box>
          )}

          {firstPrompt && (
            <Box flexDirection="column" marginTop={1}>
              <Text bold>Prompt</Text>
              <Text dimColor>{firstPrompt}</Text>
            </Box>
          )}

          {act?.todos !== undefined && act.todos.length > 0 && (
            <Box flexDirection="column" marginTop={1}>
              {taskHeading(isEnded(row.status) ? leftOf(act.todos) : act.todos, [], isEnded(row.status))}
              {!isEnded(row.status) && workingLine(act.todos)}
              {taskItems(isEnded(row.status) ? leftOf(act.todos) : act.todos)}
            </Box>
          )}

          <Box flexDirection="column" marginTop={1}>
            <Text bold>Steps</Text>
            {groups.length === 0 && <Text dimColor>No tool calls yet.</Text>}
            {groups.map(group => {
              const turn = group.turn
              // A turn whose end went unheard ends with its agent.
              const state =
                turn === undefined
                  ? ''
                  : turn.reason !== undefined
                    ? ` · ${TURN_LABEL[turn.reason]} ${formatElapsed((turn.endedAt ?? turn.startedAt) - turn.startedAt)}`
                    : isEnded(row.status)
                      ? ` · ${LABEL[row.status]} ${formatElapsed(Math.max(0, (row.endedAt ?? t) - turn.startedAt))}`
                      : ` · running ${formatElapsed(Math.max(0, t - turn.startedAt))}`
              const heading =
                turn === undefined
                  ? 'Earlier steps'
                  : `Turn ${group.number ?? ''}${state}${turnCount > 1 && turn.prompt ? ` — ${turn.prompt}` : ''}`

              return (
                <Box flexDirection="column" key={`turn:${group.turnId ?? 'none'}`}>
                  <Text color="suggestion">
                    {heading}
                  </Text>
                  {group.steps.length === 0 && <Text dimColor>  no tool calls yet</Text>}
                  {group.steps.map(step => (
                    <Box flexDirection="column" key={step.id}>
                      <Box flexDirection="row">
                        {/* Glyph and tool in a column of their own: a long summary wraps under itself. */}
                        <Box flexShrink={0} marginRight={1}>
                          <Text dimColor={step.status === 'done'}>
                            {'  '}
                            <Text color={STEP_COLOR[step.status]}>
                              {step.status === 'running' ? frame : STEP_GLYPH[step.status]}
                            </Text>{' '}
                            {step.tool.padEnd(5)}
                          </Text>
                        </Box>
                        <Box flexGrow={1} flexShrink={1}>
                          <Text dimColor>{step.summary}</Text>
                        </Box>
                        <Box flexShrink={0} marginLeft={1}>
                          <Text dimColor>{stepTime(step)}</Text>
                        </Box>
                      </Box>
                      {step.note && (
                        <Text color={STEP_COLOR[step.status]}>
                          {'    └ '}
                          {step.note}
                        </Text>
                      )}
                    </Box>
                  ))}
                </Box>
              )
            })}
          </Box>

          {children.length > 0 && (
            <Box flexDirection="column" marginTop={1}>
              <Text bold>Subagents</Text>
              {children.map(child => {
                const right = `${LABEL[child.status]} ${timeOf(child)}`

                return (
                  <Button key={childKey(child.id)} plain onPress={() => show($, child.id, 'back')}>
                    <Text color={COLOR[child.status]}>{GLYPH[child.status]}</Text>
                    <Text>
                      {' '}
                      {child.type}{' '}
                    </Text>
                    <Text dimColor>{child.description || child.name || child.id}</Text>
                    <Text dimColor> {right}</Text>
                  </Button>
                )
              })}
            </Box>
          )}
        </Box>
      )
    }

    const focused = shown === null ? undefined : rows[shown]
    if (focused !== undefined && focused.isListed) return detail(focused)

    const active = lines.filter(({ row }) => !isEnded(row.status)).length
    // The whole session at a glance: every listed agent's calls, errors and tokens.
    const listedActs = lines.map(({ row }) => acts[row.id]).filter((one): one is AgentActivity => one !== undefined)
    const tools = listedActs.reduce((n, one) => n + one.toolCount, 0)
    const errors = listedActs.reduce((n, one) => n + one.errorCount, 0)
    const tokens = listedActs.reduce((n, one) => n + totalTokens(usageOf(one) ?? EMPTY_USAGE), 0)
    const stuckCount = lines.filter(
      ({ row }) => !isEnded(row.status) && stuckNote(acts[row.id], row.startedAt ?? row.firstSeenAt, t) !== undefined,
    ).length
    const overview = [
      lines.length > 0 ? plural(tools, 'tool') : '',
      errors > 0 ? plural(errors, 'error') : '',
      tokens > 0 ? `${formatTokens(tokens)} tok` : '',
      cost !== null ? `session ${formatUsd(cost)}` : '',
    ]
      .filter(Boolean)
      .map(part => ` · ${part}`)
      .join('')

    // The main conversation's checklist, above its subagents, each item in
    // progress with its latest calls under it.
    const working = workingOf(checklist)
    const workingLog = working === undefined ? undefined : logs[working.id]
    const taskTools = checklist.reduce((n, item) => n + (logs[item.id]?.toolCount ?? 0), 0)
    const taskErrors = checklist.reduce((n, item) => n + (logs[item.id]?.errorCount ?? 0), 0)
    const taskGroup = (
      <Box flexDirection="column">
        {taskHeading(checklist, [taskTools > 0 ? plural(taskTools, 'tool') : '', taskErrors > 0 ? plural(taskErrors, 'error') : ''])}
        {workingLine(checklist, [
          working?.startedAt === undefined ? '' : formatElapsed(Math.max(0, t - working.startedAt)),
          workingLog === undefined || workingLog.toolCount === 0 ? '' : plural(workingLog.toolCount, 'tool'),
        ])}
        {isOpen(checklist) && taskItems(checklist, logs)}
      </Box>
    )

    // The account's rate-limit windows on one line at the pane's foot: the
    // name and the reset mark orange, the use bold, the time dim.
    const usageGroup =
      limits.length === 0 ? null : (
        <Text>
          {limits.map((limit, i) => {
            const { name, used, reset } = limitParts(limit, t)

            return (
              <Text key={`limit:${i}`}>
                <Text color={TITLE_COLOR}>{`${i > 0 ? '   ' : ''}${name}`}</Text>{' '}
                <Text bold>{used}</Text>
                {reset === '' ? null : (
                  <Text>
                    <Text dimColor> · </Text>
                    <Text color={TITLE_COLOR}>↻</Text>
                    <Text dimColor>{` ${reset}`}</Text>
                  </Text>
                )}
              </Text>
            )
          })}
        </Text>
      )

    // The spawned shells, one card each: the command pinned on top, its log's
    // latest lines under it as a terminal scrolls. A running card keeps its
    // height as its log grows.
    const shownShells = visibleShells(shellRows, currentPrompt)
    const shellsRunning = shellRows.filter(one => one.status === 'running').length
    const shellTime = (one: ShellRow) => formatElapsed(Math.max(0, (one.endedAt ?? Math.max(t, one.startedAt)) - one.startedAt))
    const ownerOf = (one: ShellRow) => (one.agentId === undefined ? 'main' : (rows[one.agentId]?.type ?? 'agent'))
    const endOf = (one: ShellRow) =>
      one.status === 'running'
        ? ''
        : one.status === 'stopped'
          ? ' · stopped'
          : one.exitCode === undefined
            ? ''
            : ` · exit ${one.exitCode}`
    // What a shell's top border carries: its status and description, its owner and time.
    const shellTitle = (one: ShellRow, style: (segs: Seg[]) => Seg[]) => ({
      left: style([
        { text: one.status === 'running' ? frame : SHELL_GLYPH[one.status], color: SHELL_COLOR[one.status] },
        { text: ` ${one.description ?? 'shell'}`, color: 'text', bold: one.status === 'running' },
      ]),
      right: style([{ text: `${ownerOf(one)} · ${shellTime(one)}${endOf(one)}`, color: 'text' }]),
    })
    // A card in the group is one Button, as an agent's is: Enter opens its detail.
    const shellCard = (one: ShellRow, isFirst: boolean) => {
      const isRunning = one.status === 'running'
      const width = Math.max(MIN_CARD_WIDTH, columns)
      const inner = innerWidth(width)
      const keep = isRunning ? TAIL_LINES : DONE_TAIL_LINES
      const tail = one.tail.slice(-keep)
      const logRows: Line[] = [
        ...tail.map(text => [{ text: clip(text, inner), dim: true }]),
        ...(isRunning && tail.length === 0 ? [[{ text: waitingNote(one, t), dim: true }]] : []),
      ]
      // Running, the log keeps its rows, filled from the top as it grows.
      const blank = isRunning ? Math.max(0, TAIL_LINES - logRows.length) : 0
      const body: Line[] = [
        [
          { text: '$ ', color: TITLE_COLOR, bold: true },
          { text: clip(commandLine(one.command), Math.max(0, inner - 2)), bold: isRunning },
        ],
        ...logRows,
        ...Array.from({ length: blank }, (): Line => []),
      ]
      const dimmed = (segs: Seg[]) => (isRunning ? segs : segs.map(seg => ({ ...seg, dim: true })))

      return (
        <Button key={shellKey(one.id)} plain autoFocus={isFirst || undefined} onPress={() => showShell($, one.id, 'back')}>
          {drawLines(framed(body.map(dimmed), width, { color: SHELL_COLOR[one.status], dim: !isRunning }, shellTitle(one, dimmed)))}
        </Button>
      )
    }

    // One shell whole: every line of its command, how it ended, the lines of
    // its log the pane keeps, and every command of the session to go to next.
    const shellDetail = (one: ShellRow) => {
      const width = Math.max(MIN_CARD_WIDTH, columns)
      const inner = innerWidth(width)
      const isRunning = one.status === 'running'
      const command = commandLines(one.command)
      const card = framed(
        [
          ...command.flatMap((line, i) =>
            layoutRow(
              [
                { text: i === 0 ? '$ ' : '  ', color: TITLE_COLOR, bold: true },
                { text: line, bold: isRunning },
              ],
              undefined,
              inner,
              2,
            ),
          ),
          ...layoutRow(
            [
              { text: SHELL_WORD[one.status], color: SHELL_COLOR[one.status] },
              { text: `${endOf(one)} · ${ownerOf(one)}`, dim: true },
            ],
            undefined,
            inner,
          ),
        ],
        width,
        { color: SHELL_COLOR[one.status], dim: !isRunning },
        shellTitle(one, segs => segs),
      )
      const history = shellHistory(shellRows)

      return (
        <Box flexDirection="column">
          <Box flexDirection="row" gap={3}>
            <Button key="back" plain hotkey="b" autoFocus label="← back to list" onPress={() => showShell($, null, shellKey(one.id))} />
            {isStoppable(one) && (
              <Button
                key="stop"
                plain
                hotkey="s"
                label={asking === shellKey(one.id) ? 'press s again to stop' : 'stop command'}
                onPress={() => stopShell($, one)}
              />
            )}
          </Box>
          <Box marginTop={1}>
            <Text>{drawLines(card)}</Text>
          </Box>

          <Box flexDirection="column" marginTop={1}>
            <Text bold>
              Output
              <Text dimColor>{one.tail.length > 0 ? ` · last ${plural(one.tail.length, 'line')}` : ''}</Text>
            </Text>
            {one.tail.length === 0 && <Text dimColor>{isRunning ? waitingNote(one, t) : 'no output'}</Text>}
            {one.tail.map((line, i) => (
              <Text key={`out:${i}`} dimColor wrap="truncate-end">
                {line === '' ? ' ' : line}
              </Text>
            ))}
          </Box>

          {history.length > 1 && (
            <Box flexDirection="column" marginTop={1}>
              <Text bold>All commands</Text>
              {history.map(other => (
                <Button key={historyKey(other.id)} plain onPress={() => showShell($, other.id, 'back')}>
                  <Text color={SHELL_COLOR[other.status]}>{other.status === 'running' ? frame : SHELL_GLYPH[other.status]}</Text>
                  <Text bold={other.id === one.id}> {clip(other.description ?? commandLine(other.command), Math.max(1, inner - 24))}</Text>
                  <Text dimColor>
                    {' '}
                    {ownerOf(other)} · {shellTime(other)}
                    {endOf(other)}
                  </Text>
                </Button>
              ))}
            </Box>
          )}
        </Box>
      )
    }
    const openShell = shownShell === null ? undefined : shellRows.find(one => one.id === shownShell)
    if (openShell !== undefined) return shellDetail(openShell)
    const shellGroup =
      shellRows.length === 0 ? null : (
        <Box flexDirection="column">
          <Text>
            <Text bold>
              <Text color={TITLE_COLOR}>Shells</Text>: {shellsRunning} running · {shellRows.length - shellsRunning} done
            </Text>
          </Text>
          {shownShells.map((one, index) => shellCard(one, lines.length === 0 && index === 0))}
        </Box>
      )

    // Remote control while it is on: the link to open on the phone, or how
    // the start goes.
    const remoteLabel = {
      off: '',
      starting: 'starting…',
      on: queued.length > 0 ? `on · ${plural(queued.length, 'prompt')} waiting` : 'on',
      error: 'failed',
    }[remoteState.status]
    // The link as a QR code for the phone's camera, centred in the pane: light
    // on dark whatever the theme, and only whole, as a wrapped code does not scan.
    const qr = remoteState.link === undefined || remoteState.isQrHidden === true ? [] : qrOf(remoteState.link)
    const remoteQr =
      qr.length === 0 ? null : [...qr[0]!].length > columns ? (
        <Text dimColor>widen the pane to show the QR code</Text>
      ) : (
        <Box flexDirection="row" justifyContent="center" width={Math.max(1, columns)}>
          <Text color="#ffffff" backgroundColor="#000000">
            {qr.join('\n')}
          </Text>
        </Box>
      )
    const remoteGroup =
      remoteState.status === 'off' ? null : (
        <Box flexDirection="column">
          <Text>
            <Text bold>
              <Text color={TITLE_COLOR}>Remote</Text>:{' '}
            </Text>
            <Text color={remoteState.status === 'error' ? 'error' : remoteState.status === 'on' ? 'success' : undefined}>
              {remoteLabel}
            </Text>
          </Text>
          {remoteState.link !== undefined && <Text>{remoteState.link}</Text>}
          {remoteQr}
          {remoteState.note !== undefined && <Text color="warning">{remoteState.note}</Text>}
          <Box flexDirection="row" columnGap={3}>
            {remoteState.link !== undefined && (
              <Button
                key="remote-qr"
                plain
                label={remoteState.isQrHidden === true ? 'show QR' : 'hide QR'}
                onPress={() => update($, remote, state => ({ ...state, isQrHidden: state.isQrHidden !== true }))}
              />
            )}
            {remoteState.link !== undefined && (
              <Button
                key="remote-copy"
                plain
                label="copy link"
                onPress={press => void $.ui.copy({ text: remoteState.link ?? '', surface: press.surface })}
              />
            )}
            <Button
              key="remote-stop"
              plain
              label={remoteState.status === 'error' ? 'dismiss' : 'stop remote'}
              onPress={() => (helper === undefined ? update($, remote, () => ({ status: 'off' })) : stopRemote($))}
            />
          </Box>
        </Box>
      )

    // How full the session's context window is, as one bar the pane's width.
    const contextGroup = (() => {
      if (fill === null || fill.window <= 0) {
        return (
          <Text>
            <Text bold color={TITLE_COLOR}>
              Context
            </Text>
            <Text dimColor>: no reading yet</Text>
          </Text>
        )
      }
      const percent = Math.min(100, (fill.tokens / fill.window) * 100)
      const used = Math.round(percent)
      // One bar the pane's width, filled to the whole cell.
      const width = Math.max(1, columns)
      const full = Math.min(width, Math.round((percent / 100) * width))

      return (
        <Box flexDirection="column">
          {/* Headed as Tasks and Subagents are: the name bold in orange, the figures dim. */}
          <Text>
            <Text bold>
              <Text color={TITLE_COLOR}>Context</Text>: {percent < 1 && fill.tokens > 0 ? '<1' : used}%
            </Text>
            <Text dimColor>
              {' '}
              · {formatTokens(fill.tokens)} / {formatTokens(fill.window)} tok
            </Text>
          </Text>
          <Text>
            <Text color={percent >= 80 ? BAR_FULL_COLOR : BAR_COLOR}>{'█'.repeat(full)}</Text>
            <Text color="inactive">{'░'.repeat(width - full)}</Text>
          </Text>
        </Box>
      )
    })()
    // Under the context bar: how much of the latest request the cache served, and how long it stays warm.
    const cacheGroup = (() => {
      if (cache === null) return undefined
      const { hit, leftMs } = cacheParts(cache, t)

      return (
        <Box marginTop={1}>
          <Text>
            <Text bold>
              <Text color={TITLE_COLOR}>Cache</Text>: {hit} hit
            </Text>
            <Text dimColor>{leftMs > 0 ? ` · ↻ ${formatElapsed(leftMs)}` : ' · expired'}</Text>
          </Text>
        </Box>
      )
    })()
    const rule = <Text dimColor>{'─'.repeat(Math.max(1, columns))}</Text>

    // The header, centred: Claude's mascot in orange, the pane's name drawn
    // in letters as tall as it beside it; plain where the pane is too narrow.
    const header = (
      <Box flexDirection="row" justifyContent="center" width={Math.max(1, columns)}>
        <Box flexDirection="column">
          {MASCOT.map((line, i) => (
            <Text key={`mascot:${i}`} color={TITLE_COLOR}>
              {line}
            </Text>
          ))}
        </Box>
        <Box flexDirection="column" marginLeft={2}>
          {columns >= HEADER_WIDTH ? (
            NAME_ART.map((line, i) => (
              <Text key={`name:${i}`} bold color={TITLE_COLOR}>
                {line}
              </Text>
            ))
          ) : (
            <Text bold color={TITLE_COLOR}>
              AGENT HUB
            </Text>
          )}
        </Box>
      </Box>
    )

    // Docked, the tree fills the pane's height so the usage sits at its foot.
    return (
      <Box flexDirection="column" minHeight={e.props.placement === 'dock' ? e.props.scroll.bodyRows : undefined}>
        <Box flexDirection="column" flexGrow={1}>
          {header}
          {rule}
          {contextGroup}
          {cacheGroup}
          {rule}
          {taskGroup}
          {/* A rule between the groups, the pane's full width. */}
          <Text dimColor>{'─'.repeat(Math.max(1, columns))}</Text>
          <Text>
            <Text bold>
              <Text color={TITLE_COLOR}>{isAll ? 'All subagents' : 'Subagents'}</Text>: {active} running ·{' '}
              {lines.length - active} done
            </Text>
            <Text dimColor>{overview}</Text>
            {stuckCount > 0 && <Text color="warning"> · ⚠ {stuckCount} may be stuck</Text>}
          </Text>
          {(hidden > 0 || isAll || lines.length > 0) && (
            <Box flexDirection="row" flexWrap="wrap" columnGap={3}>
              {(hidden > 0 || isAll) && (
                <Button
                  key="all"
                  plain
                  hotkey="a"
                  label={isAll ? 'latest only' : `all (+${hidden})`}
                  onPress={() => update($, showAll, all => !all)}
                />
              )}
              {lines.length > 0 && (
                <Button
                  key="expand"
                  plain
                  hotkey="e"
                  label={expanded ? 'compact' : 'expand'}
                  onPress={() => update($, isExpanded, isOn => !isOn)}
                />
              )}
            </Box>
          )}
          {banner}
          {lines.map(({ row, depth }, index) => card(row, depth, index === 0))}
          {lines.length > 0 && (
            <Text dimColor>
              {e.props.isFocused ? 'tab: next card · enter: open · e: compact/expand · a: all agents' : 'ctrl+x tab: select a card'}
            </Text>
          )}
          {shellGroup === null ? null : rule}
          {shellGroup}
          {remoteGroup === null ? null : rule}
          {remoteGroup}
        </Box>
        {usageGroup === null ? null : rule}
        {usageGroup}
      </Box>
    )
  })
}
