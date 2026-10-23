export type AgentRowStatus =
  | 'pending'
  | 'running'
  | 'waiting'
  | 'idle'
  | 'completed'
  | 'failed'
  | 'killed'

export type TurnEndReason = 'answer' | 'aborted' | 'refusal' | 'error'

/**
 * One agent as the pane knows it: what `$.agent.list()` last said of it,
 * plus the times the turn events gave, kept after the engine drops it.
 */
export type AgentRow = {
  id: string
  type: string
  description: string
  name?: string
  parentId?: string
  /** A teammate goes idle between turns instead of ending. */
  isTeammate: boolean
  /** The person's prompt it was first seen under (PluginState's `task`); absent in rows from before tasks were kept. */
  task?: number
  status: AgentRowStatus
  /** Seen in `$.agent.list()` at least once; forks and workflow loops never are. */
  isListed: boolean
  /** In the latest `$.agent.list()` snapshot. */
  inList: boolean
  firstSeenAt: number
  startedAt?: number
  endedAt?: number
  reason?: TurnEndReason
}

export type StepStatus = 'running' | 'done' | 'error' | 'denied'

/** One tool call an agent made. */
export type StepRow = {
  /** The call's tool_use_id. */
  id: string
  /** The agent's turn it ran in, when its start was heard. */
  turnId?: string
  tool: string
  /** What it ran on, cut short and with secrets masked: a path, a command, a pattern. */
  summary: string
  status: StepStatus
  startedAt: number
  endedAt?: number
  /** The first line of an error, or why the call was refused. */
  note?: string
}

/** One run of an agent's loop: a subagent has one, a teammate one per wake. */
export type TurnRow = {
  turnId: string
  /** The prompt it began with, cut short and with secrets masked; "" for a continuation. */
  prompt: string
  startedAt: number
  endedAt?: number
  reason?: TurnEndReason
}

export type TodoStatus = 'pending' | 'in_progress' | 'completed'

/** One item of an agent's plan, from its TodoWrite or TaskCreate / TaskUpdate calls. */
export type TodoItem = {
  id: string
  text: string
  status: TodoStatus
  /** What the item reads as while in progress ("Running tests"), when the call gave one. */
  active?: string
  /** When the main conversation last put it in progress, for its elapsed time. */
  startedAt?: number
}

/** What an agent's turns cost, summed: the API's four token counts and the last model. */
export type TokenUsage = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  model: string
}

/** What one agent did: its turns, its latest steps and its counts over all of them. */
export type AgentActivity = {
  /** The turn running now, which new steps belong to. */
  turnId?: string
  turns: TurnRow[]
  steps: StepRow[]
  toolCount: number
  errorCount: number
  /** Absent until the agent writes a plan, and in state written before plans were kept. */
  todos?: TodoItem[]
  /** The turns that ended, summed; absent until one ends with usage. */
  usage?: TokenUsage
  /** The running turn's requests so far, from each model step; cleared as the turn ends. */
  live?: TokenUsage
}

/** One rate-limit window of the account, as the session's last response reported it. */
export type RateLimitRow = {
  /** `five_hour`, `seven_day`, or a gateway's `spend_limit`. */
  kind: string
  /** 0 to 100; past 100 on an exceeded spend limit. */
  percentUsed: number
  /** When the window starts over, as an ISO 8601 timestamp. */
  resetsAt?: string
}

/** The main conversation's latest model request: when it ended and how its input was cached. */
export type CacheReading = {
  at: number
  input: number
  read: number
  write: number
}

export type ShellStatus = 'running' | 'done' | 'failed' | 'stopped'
/** A shell the session spawned: a Bash command left running in the background, its log watched. */
export type ShellRow = {
  /** The call's tool_use_id. */
  id: string
  command: string
  description?: string
  /** The subagent that spawned it; absent for the main conversation. */
  agentId?: string
  /** The prompt it was spawned under (the `task` count). */
  task: number
  status: ShellStatus
  /** The engine's id for the command, `b…`. */
  taskId: string
  /** Its log, as the call's result named it; absent, `<tasks dir>/<taskId>.output`. */
  logPath?: string
  startedAt: number
  endedAt?: number
  exitCode?: number
  /** The log's latest lines (KEEP_LINES of them), oldest first, ANSI and secrets removed; a card draws the last few. */
  tail: string[]
  /** The log's size when last read; it is read again only when that changes. */
  size?: number
}
/** Remote control as the pane shows it: the helper starting, its tunnel up, or why it failed. */
export type RemoteStatus = {
  status: 'off' | 'starting' | 'on' | 'error'
  /** The tunnel's address with the token: what the phone opens. */
  link?: string
  /** The helper's latest error line. */
  note?: string
  /** The link's QR code folded away in the pane. */
  isQrHidden?: boolean
}
declare module 'claude-code' {
  interface PluginState {
    'agent-hub': {
      agents: Record<string, AgentRow>
      /** The main conversation's task checklist, from its TaskCreate / TaskUpdate / TodoWrite calls. */
      tasks: TodoItem[]
      /** The task the main conversation works on now: its tool calls are logged under it. */
      currentTask: string | null
      /** Each task's log: the main conversation's tool calls while it was the current task. */
      taskLogs: Record<string, AgentActivity>
      activity: Record<string, AgentActivity>
      now: number
      /** The agent the pane shows in detail; null shows the list. */
      selected: string | null
      /** Messages sent from the pane, counted: the field is drawn anew after each. */
      sendCount: number
      /** The agent, or `shell:<id>` the shell, a first press of stop asked about; a second press stops it. */
      confirmStop: string | null
      /** The shell the pane shows in detail, by its id; null shows the list. */
      selectedShell: string | null
      /** The context window the session's last response filled: its tokens and its size; null before a reading. */
      context: { tokens: number; window: number } | null
      /** The prompt cache as the main conversation's latest request left it; null before one. */
      cache: CacheReading | null
      /** What the whole session has cost, in US dollars, as /cost totals it; null before a reading. */
      sessionCostUsd: number | null
      /** The account's rate-limit windows, five hours first; empty off a subscription or before a reading. */
      rateLimits: RateLimitRow[]
      /** The shells the session spawned, oldest first: the latest MAX_SHELLS, every running one kept. */
      shells: ShellRow[]
      /** The person's prompts so far, counted: each one starts a task. */
      task: number
      /** The list shows every agent of the session, not only the latest task's. */
      showAll: boolean
      /** Running agents' cards list their latest steps; off, only what runs now. Finished cards stay folded. */
      isExpanded: boolean
      /** Remote control; off again after a reload, which ends the helper. */
      remote: RemoteStatus
    }
  }
}
