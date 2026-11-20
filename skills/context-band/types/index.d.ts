/**
 * How full the main conversation's context window is, as last measured.
 */
export type Fill = {
  /** Input tokens the last main-loop model response was answered over; null before one came back and right after a compaction. */
  tokens: number | null
  /** The session model's context window, in tokens. */
  window: number
  /** `tokens` over `window` as a whole percentage, 0 to 100; null when `tokens` is. */
  percent: number | null
  /** True while `tokens` is the engine's local estimate of a just-compacted conversation, until a model response measures it. */
  isEstimate: boolean
}

/** One row of the window as /context lists it. */
export type CategoryShare = {
  name: string
  tokens: number
  /** `used` occupies the window, `free` is what is left, `buffer` the compaction reserve, `deferred` loads on demand outside it. */
  kind: 'used' | 'free' | 'buffer' | 'deferred'
  /** The theme key /context draws the row in. */
  color: string
}

/** A named item and the tokens it holds in the window. */
export type ItemShare = { name: string; tokens: number }

/** One MCP server: how many of its tool schemas sit in the window, and their tokens. */
export type ServerShare = { name: string; tools: number; tokens: number }

/** The window broken down as /context breaks it down, trimmed to what the band draws. */
export type Breakdown = {
  /** The window the rows are measured against: the model's, or a smaller compaction window. */
  maxTokens: number
  /** The token count at which auto-compaction runs; null when it is off. */
  autoCompactAt: number | null
  categories: CategoryShare[]
  /** The largest memory files (CLAUDE.md, rules, auto-memory). */
  memoryFiles: ItemShare[]
  /** The MCP servers whose tool schemas take the most room. */
  mcpServers: ServerShare[]
  /** MCP tools whose schemas load only when searched for, outside the window. */
  deferredMcpTools: number
  skills: { listed: number; total: number; tokens: number } | null
  agents: { count: number; tokens: number }
}

/** The user's current task as the model last estimated it through task_progress. */
export type Task = {
  /** The task in a few words, the same for every update of one task. */
  title: string
  /** How much of it is done, 0 to 100. */
  percent: number
  /** What the model is doing now or just finished; null when it gave none. */
  step: string | null
  /** True while the band made the task from the prompt and the model has not estimated it yet. */
  isAuto: boolean
  /** The plan as the model last listed it; empty or absent without one. */
  steps?: PlanStep[]
  /** When the model first estimated the task, epoch milliseconds. */
  startedAt?: number
  /** The model's estimates over time, oldest first: the pace the time left comes from. */
  samples?: Array<{ percent: number; at: number }>
}

/** One step of a task's plan. */
export type PlanStep = {
  title: string
  status: 'done' | 'active' | 'todo'
  /** When the band first saw the step running (or done), epoch milliseconds; null while it waits. */
  startedAt: number | null
  /** When the band first saw it done; null until then. */
  doneAt: number | null
}

/** One piece of background work of this session: a shell, a subagent, a monitor, a workflow. */
export type Runner = {
  /** The engine's task id (a shell's background id, an agent's id). */
  id: string
  /** `shell`, `subagent`, `monitor`, `workflow`, or the engine's own word for another kind. */
  type: string
  /** The engine's status word: running, pending, completed, failed, killed; `finished` once it left the list. */
  status: string
  /** What it does, as described when it was started. */
  description: string
  /** How it runs: the shell command, the agent type, the workflow name or the MCP tool; null when unknown. */
  detail: string | null
  /** When the band first saw it, in `$.clock.now()` milliseconds. */
  seenAt: number
  /** When the band saw it end; null while it runs. */
  endedAt: number | null
  /** What the model said about it through runner_info; absent when it said nothing. */
  info?: RunnerInfo | null
  /** What the band last read about its progress; absent until it read anything. */
  progress?: RunnerProgress | null
  /** The transcript row that launched it (its tool_use_id), for the hover both share. */
  launchId?: string
}

/** What the model said about a piece of background work through runner_info. */
export type RunnerInfo = {
  /** What runs, in a few words the user understands. */
  title: string
  /** The user's task it serves; null when not given. */
  forTask: string | null
  /** A log that shows its progress; null to let the band find one in the command. */
  log: string | null
  /** A regular expression: each matching log line is one unit done. */
  donePattern: string | null
  /** A regular expression whose first group, found in the log, is the number of units. */
  totalPattern: string | null
  /** The number of units, when known up front. */
  total: number | null
  /** A file holding the job's status word (RUNNING, DONE, FAILED). */
  statusFile: string | null
  /** How long it should take, for an approximate bar when nothing can be counted. */
  expectedMinutes: number | null
  /** For a watcher: what it waits for, in a few words. */
  waitsFor: string | null
}

/** One job a runner runs or waits on, as its status and log files read. */
export type RunnerTarget = {
  /** The job's name, from its file (`build`). */
  name: string
  /** The status file's word (RUNNING, DONE, FAILED); `waiting` while the file is not there; `running` with no status file. */
  status: string
  /** Units done, counted in the log; null when nothing could be counted. */
  done: number | null
  /** Units in all; null when unknown. */
  total: number | null
  /** The log's last non-empty line: what the job says it does now; null without a log. */
  lastLine?: string | null
  /** The log's last few non-empty lines, for the card a pointer on the runner reveals. */
  tail?: string[]
  /** When the log last changed, epoch milliseconds; null without a log. */
  logAt?: number | null
  /** The shared evaluation lease the job waits for or holds, by its log's last line on it. */
  lease?: { name: string; state: 'waiting' | 'holding' } | null
}

/** What the band last read about a runner's progress. */
export type RunnerProgress = {
  targets: RunnerTarget[]
  /** 0-100, counted from a log, or estimated from time when `isApprox`. */
  percent: number | null
  isApprox: boolean
  /** Minutes left, from the counting rate or the expected duration; null when unknown. */
  minutesLeft: number | null
  /** The first count seen for the active job, the base of its rate. */
  sample: { name: string; at: number; done: number } | null
}

/** What one tool's results added to the main conversation: calls and characters. */
export type ToolShare = { tool: string; calls: number; chars: number }

/** What one session tells the others about itself, in its file under ~/.claude/context-band/sessions. */
export type SessionEntry = {
  sessionId: string
  /** The session's working directory. */
  cwd: string
  /** The user's current task there, as its band shows it; null when none. */
  task: { title: string; percent: number; step?: string | null } | null
  runners: Runner[]
  /** When the session last wrote its entry, in epoch milliseconds. */
  updatedAt: number
  /** True once the session ended: its file stays, but it lists nothing. */
  isEnded: boolean
  /** How full its context window is, in percent; absent from older bands. */
  fill?: number | null
  /** Whether a main turn runs there now, and since when it runs or rests (epoch ms); absent from older bands. */
  turn?: { isWorking: boolean; since: number }
  /** The main conversation's last prompt, its first line; absent from older bands. */
  asked?: string | null
  /** The gist of its last answer: the question it ends on, else its first sentence; absent from older bands. */
  said?: string | null
  /** How that last turn ended; absent from older bands. */
  ending?: TurnEnding | null
}

/** How a main turn ended: answered, interrupted, refused by the model, or stopped by an error. */
export type TurnEnding = 'answer' | 'aborted' | 'refusal' | 'error'

/** A toolbar button another mod's card asks for: a press opens that mod's section. */
export type SectionButton = {
  /** The plugin that answers the press. */
  mod: string
  /** The element key's tail: the button is `section:<key>`. */
  key: string
  label: string
  /** Its place among the toolbar's other buttons: the card's order. */
  order: number
  /** What the band counts beside the label: the live sessions. */
  count: 'sessions' | null
}

declare module 'claude-code' {
  interface PluginState {
    'context-band': {
      fill: Fill | null
      isOn: boolean
      switchSeenAt: number
      isQuiet: boolean
      switchedOff: string[]
      warnedAt: number
      isCompacting: boolean
      isExpanded: boolean
      breakdown: Breakdown | null
      breakdownAt: number
      toolShares: ToolShare[]
      task: Task | null
      runners: Runner[]
      isRunnersOpen: boolean
      otherSessions: SessionEntry[]
      alerted: Record<string, string>
      turnState: { isWorking: boolean; since: number }
      lastExchange: { asked: string | null; said: string | null; ending: TurnEnding | null }
      bandHeight: number | null
      isMenuOpen: boolean
      sectionButtons: SectionButton[]
      openSection: string | null
      expandedRunner: string | null
      runnerView: 'progress' | 'timeline'
      isShowingAllRunners: boolean
      isShowingDoneRunners: boolean
      explanations: Record<string, string>
      explaining: string | null
    }
  }
}
