import { atom, read, update } from 'claude-code'
import type {
  ElementTable,
  EngineInterface,
  Register,
  RenderElement,
  SessionContextBreakdown,
  SessionContextUsage,
  ThemeKey,
  ToolSpec,
  TurnUsage,
} from 'claude-code'

import type {
  Breakdown,
  CategoryShare,
  Fill,
  Runner,
  RunnerInfo,
  RunnerProgress,
  RunnerTarget,
  PlanStep,
  SectionButton,
  ServerShare,
  SessionEntry,
  Task,
  ToolShare,
} from '../types'

const fill = atom({ plugin: 'context-band', key: 'fill' } as const, null)
// Whether the mods panel has this mod on; off, the band draws nothing and the guide stays out.
const MOD_NAME = 'context-band'
const isOn = atom({ plugin: 'context-band', key: 'isOn' } as const, true)
const switchSeenAt = atom({ plugin: 'context-band', key: 'switchSeenAt' } as const, -1)
// The family's quiet mode: the band's meters show only what needs a look.
const isQuiet = atom({ plugin: 'context-band', key: 'isQuiet' } as const, false)
// Every mod the panel has off, as the switches file last said.
const switchedOff = atom({ plugin: 'context-band', key: 'switchedOff' } as const, [])
// The warning level already toasted, 0 for none; it drops back with the fill.
const warnedAt = atom({ plugin: 'context-band', key: 'warnedAt' } as const, 0)
// True while a compaction the Compact button started is running.
const isCompacting = atom({ plugin: 'context-band', key: 'isCompacting' } as const, false)
// Whether the band shows the breakdown beneath its line.
const isExpanded = atom({ plugin: 'context-band', key: 'isExpanded' } as const, false)
const breakdown = atom({ plugin: 'context-band', key: 'breakdown' } as const, null)
// When the breakdown was last counted, so the hover card stays fresh without a count per response.
const breakdownAt = atom({ plugin: 'context-band', key: 'breakdownAt' } as const, 0)
// What each tool's results added to the main conversation since it last started over.
const toolShares = atom({ plugin: 'context-band', key: 'toolShares' } as const, [])
// The user's current task as the model last estimated it.
const task = atom({ plugin: 'context-band', key: 'task' } as const, null)
// This session's background work, as the band last saw it.
const runners = atom({ plugin: 'context-band', key: 'runners' } as const, [])
const isRunnersOpen = atom({ plugin: 'context-band', key: 'isRunnersOpen' } as const, false)
// The other live sessions' background work, as their files last said.
const otherSessions = atom({ plugin: 'context-band', key: 'otherSessions' } as const, [])
// The band's height as the person set it with ▲ ▼, in rows; null while it takes the rows it draws.
const bandRows = atom({ plugin: 'context-band', key: 'bandHeight' } as const, null)
// Whether the toolbar shows: the ⋯ button at the right end of the readings opens and closes it.
const isMenuOpen = atom({ plugin: 'context-band', key: 'isMenuOpen' } as const, false)
// Whether a main turn runs now, and since when it runs or rests: the other sessions read it.
const turnState = atom({ plugin: 'context-band', key: 'turnState' } as const, { isWorking: false, since: 0 })
// What the main conversation was last asked and what its answer came to: the other sessions show it.
const lastExchange = atom({ plugin: 'context-band', key: 'lastExchange' } as const, { asked: null, said: null, ending: null })
// The toolbar buttons other mods ask for in their mod.json cards, and the one of them open.
const sectionButtons = atom({ plugin: 'context-band', key: 'sectionButtons' } as const, [])
const openSection = atom({ plugin: 'context-band', key: 'openSection' } as const, null)
// The runner opened by a press on its title: its log, command and actions; by list key.
const expandedRunner = atom({ plugin: 'context-band', key: 'expandedRunner' } as const, null)
// What the bar column of the list shows: each job's progress, or its life on a four-hour scale.
const runnerView = atom({ plugin: 'context-band', key: 'runnerView' } as const, 'progress')
// The list keeps to a few rows unless asked for all; finished work folds into one line.
const isShowingAllRunners = atom({ plugin: 'context-band', key: 'isShowingAllRunners' } as const, false)
const isShowingDoneRunners = atom({ plugin: 'context-band', key: 'isShowingDoneRunners' } as const, false)
// One-sentence explanations the model wrote, by list key, and the one being written.
const explanations = atom({ plugin: 'context-band', key: 'explanations' } as const, {})
const explaining = atom({ plugin: 'context-band', key: 'explaining' } as const, null)
// Each runner's phase at the last look (live, done, dead, stalled, stopped), by session and runner id:
// news is a change from a phase seen live, so work first seen finished is not announced.
const alerted = atom({ plugin: 'context-band', key: 'alerted' } as const, {})

// Highest first: the first level the fill reaches is the level it is at.
const WARN_LEVELS = [90, 80] as const
// From this fill on, the Compact button is drawn as the main action.
const COMPACT_URGENT_AT = 80
// After a compaction the band waits for the compacted conversation to be in
// place before it asks for an estimate: this often, at most this many times.
const ESTIMATE_RETRY_MS = 500
const ESTIMATE_ATTEMPTS = 10
// How many items each detail line of the breakdown names.
const TOP_ITEMS = 4
// A rough count for tool output: about four characters a token.
const CHARS_PER_TOKEN = 4
// Breakdown rows: what occupies the window first, then what loads on demand,
// the free space and the compaction reserve.
const KIND_ORDER = { used: 0, deferred: 1, free: 2, buffer: 3 } as const
// /context's category names, short enough for the grid's name column.
const CATEGORY_NAMES: Readonly<Record<string, string>> = {
  'System prompt': 'System',
  'System tools': 'Tools',
  'MCP tools': 'MCP',
  'Memory files': 'Memory',
  Skills: 'Skills',
  'Custom agents': 'Agents',
  Messages: 'Messages',
  'Free space': 'Free',
  'Autocompact buffer': 'Reserve',
}

// The tool the model reports the user's task progress through, and what it reads about it.
const PROGRESS_TOOL = 'mcp__context-band__task_progress'
const PROGRESS_SPEC = {
  name: 'task_progress',
  description:
    'Shows the user a progress bar for their current task above the prompt. Call it as the task starts, after each meaningful step with an honest estimate, and with 100 once it is finished.',
  inputSchema: {
    type: 'object',
    properties: {
      percent: {
        type: 'integer',
        minimum: 0,
        maximum: 100,
        description: 'How much of the task is done, 0 to 100, judged by the work left.',
      },
      task: {
        type: 'string',
        description: 'The task in a few words; the same for every update of one task.',
      },
      step: {
        type: 'string',
        description: 'What you are doing now or just finished, in a few words.',
      },
      steps: {
        type: 'array',
        description:
          'Optional: the plan in order, every step with its status. The bar then shows the checklist, counts the percent from it when `percent` is left out, and times the steps.',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'The step in a few words.' },
            status: { type: 'string', enum: ['done', 'active', 'todo'] },
          },
          required: ['title', 'status'],
        },
      },
    },
    required: ['task'],
  },
  isDeferred: false,
} satisfies ToolSpec
const PROGRESS_GUIDE = [
  'The user watches a progress bar for their current task above the prompt, fed by the task_progress tool.',
  'For any request that takes more than one step, call it when you start (a few percent), after each meaningful step with an honest estimate of how much is done, and with 100 only once the work is finished and checked.',
  'Keep `task` the same for one task; a new request is a new task. If the user adds work, lower the estimate. Skip it for one-step answers.',
  'For work of three or more steps, also pass `steps`: the whole plan in order, each step done, active or todo; send it again whenever a step changes.',
  'If task_progress is listed as a deferred tool, load it first with ToolSearch, query "select:mcp__context-band__task_progress".',
  'Right after you start background work (a shell with run_in_background, a background agent, a monitor, a workflow), call runner_info with its id, a short title the user understands, the task it serves, and where its progress shows: a log with a done_pattern and a total or total_pattern, a status_file, or expected_minutes. Load it with ToolSearch too when it is deferred.',
].join(' ')
// The tool the model describes a piece of background work through.
const RUNNER_TOOL = 'mcp__context-band__runner_info'
const RUNNER_SPEC = {
  name: 'runner_info',
  description:
    'Tells the user what a piece of background work is and where its progress shows, for the Runners list above the prompt. Call it right after starting a background shell, agent, monitor or workflow.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: "The background task id: the shell's background id, or the agent id." },
      title: { type: 'string', description: 'What runs, in a few words the user understands, e.g. "Nightly test run for PR 12".' },
      task: { type: 'string', description: 'The user task it serves, in a few words.' },
      log: { type: 'string', description: 'Absolute path of a log that shows its progress.' },
      done_pattern: { type: 'string', description: 'Regular expression: each matching log line is one unit done.' },
      total_pattern: {
        type: 'string',
        description: 'Regular expression whose first group, found in the log, is the number of units.',
      },
      total: { type: 'integer', minimum: 1, description: 'The number of units, when known up front.' },
      status_file: {
        type: 'string',
        description: 'Absolute path of a file holding the job status word (RUNNING, DONE, FAILED).',
      },
      expected_minutes: {
        type: 'number',
        minimum: 1,
        description: 'How long it should take, for an approximate bar when nothing can be counted.',
      },
      waits_for: { type: 'string', description: 'For a watcher: what it waits for, in a few words.' },
    },
    required: ['id', 'title'],
  },
  isDeferred: false,
} satisfies ToolSpec
// Status words that mean the job finished well, or died.
const DONE_WORDS = statusWords(['DONE', 'COMPLETED', 'SUCCESS', 'OK', 'PASSED', 'PASS'])
const DEAD_WORDS = statusWords(['FAILED', 'FAIL', 'DEAD', 'ERROR', 'KILLED'])
// A longer status word counts by its last part (BUILD_DONE is DONE, STEP_FAILED is FAILED), unless it is negated (NOT_DONE).
function statusWords(words: string[]): { has: (word: string) => boolean } {
  const known = new Set(words)

  return { has: word => known.has(word) || (!/^NOT?_/.test(word) && known.has(word.slice(word.lastIndexOf('_') + 1))) }
}
// How much of a log's last line the band shows.
const LAST_LINE_MAX_CHARS = 140
// The checklist glyphs a task row draws before it sums up the rest.
const PLAN_GLYPHS = 12
// The pace keeps this many estimates of one task.
const TASK_SAMPLES = 12
// An estimate needs this much time behind it before it forecasts the rest.
const PACE_MIN_MS = 60_000
const TASK_SCOPE = 'context-band:task'
// A job's log lines about a shared evaluation lease it waits for or holds: the last one says where the job stands.
const LEASE_LINE = /(waiting for|acquired) evaluation lease '([^']+)'/g
// A running job whose log has not grown for this long is shown as stalled.
const STALL_MS = 10 * 60_000
// Every session announces a runner, but only the first to claim it in this
// ledger (under HOME) plays the sound, so one event rings once per machine.
const ALERTS_LEDGER = '.claude/mods/alerts.json'
const LEDGER_KEEP_MS = 24 * 60 * 60_000
const SOUNDS = { done: 'sounds/done.aiff', dead: 'sounds/fail.aiff', stalled: 'sounds/stall.aiff' } as const
// The height the person set the band to and whether its toolbar shows, shared by every session under HOME.
const BAND_FILE = '.claude/mods/band.json'
// The fewest rows a set height asks for, a step of the ▲ and ▼ buttons, and the most when the surface says none.
const BAND_MIN_ROWS = 4
const BAND_STEP = 1
const BAND_MAX_ROWS = 60
// About as wide as the height's controls at the toolbar's right end: what the toolbar's rows are counted with.
const SIZE_STAND_IN = 'height 00 [ ▲ ] [ ▼ ] [ auto ]'
// Where the mods live; a card's `button` asks the band for a toolbar button that opens its section.
const SKILLS_DIR = '.claude/skills'
// How many of a log's last lines a pointer on the runner, or opening it, reveals.
const TAIL_LINES = 5
// The list's live rows before `N more`; the time scale's span (twenty cells of twelve minutes).
const RUNNER_ROWS = 6
const TIMELINE_MS = 4 * 60 * 60_000
// The model that explains a runner in a sentence: small and quick.
const EXPLAIN_MODEL = 'haiku'
// The hover card over the context meter recounts the window at most this often.
const BREAKDOWN_REFRESH_MS = 60_000
// Hover groups: a pointer on the meter or a runner reveals the rows under it.
const CONTEXT_SCOPE = 'context-band:context'
// A log the band reads whole; a bigger one shows its status only.
const MAX_LOG_CHARS = 4_000_000
// A question-by-question run's log: the questions it loaded, and one line per finished question.
const AUDIT_TOTAL = /(\d+) questions loaded/
const AUDIT_DONE = /^\[audit\] Q\d+ completed/
// A prompt's own words stand in as the task's title until the model names it.
const AUTO_TITLE_MAX_CHARS = 60
// How long a prompt's or an answer's gist may run in the registry, for the other sessions' lists.
const GIST_CHARS = 160
// Finished background work the Runners list keeps showing, newest first.
const KEPT_FINISHED_RUNNERS = 5
// Statuses that mean a piece of background work has stopped.
const ENDED_STATUSES = new Set(['completed', 'failed', 'killed', 'stopped', 'cancelled', 'error', 'finished'])
// Every session's band writes what it runs to one file of its own here (under
// HOME) and reads the others' files: a list across sessions without a server.
const REGISTRY_DIR = '.claude/context-band/sessions'
// How often a session rewrites its file and rereads the others'.
const HEARTBEAT_MS = 30_000
// A file not rewritten for this long belongs to a session that is gone.
const SILENT_AFTER_MS = 120_000

// What the model reads back from a tool call, as tool.call's result carries it.
type ToolReply = { deny?: string; text?: string; context?: readonly string[]; result?: unknown }

// One entry of the engine's background-task list (a Stop hook's background_tasks).
type TaskSnapshot = {
  id: string
  type: string
  status: string
  description: string
  command?: string
  agent_type?: string
  server?: string
  tool?: string
  name?: string
}

type CategoryRow = { name: string; tokens: number; percent: number | null; color: string; isDim: boolean }

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await watchSwitch($)
    // A reload in the middle of a compaction would otherwise keep the button hidden.
    await update($, isCompacting, () => false)
    const usage = await $.session.usage()
    await record($, fromContext(usage.context))
    if (await read($, isExpanded)) {
      await refreshBreakdown($)
    }
    await readSectionButtons($)
    await readBandFile($)
    await $.command.register({ name: 'runners', description: 'Runners: the background work of every session, open or close the list' })
    await $.command.register({ name: 'band', description: 'The band in words: context, task and runners as one text' })
    await $.tool.register(PROGRESS_SPEC)
    await $.tool.register(RUNNER_SPEC)
    $.clock.every(HEARTBEAT_MS, () => {
      void heartbeat($)
    })
    void heartbeat($)

    return started
  })

  // The task bar needs the model to report; the guide rides only on requests
  // that offer it the tool.
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (!e.tools.includes(PROGRESS_TOOL) || !(await read($, isOn))) {
      return composed
    }

    return {
      sections: [
        ...composed.sections,
        { id: 'context-band:progress', text: PROGRESS_GUIDE, scope: 'session' as const },
      ],
    }
  })

  // The model's estimate of the user's task. The band answers the call itself,
  // so no permission prompt runs for it. A subagent's estimates stay out of the
  // band: it shows the user's task, the one the main conversation works on.
  on('tool.call', { tool: PROGRESS_TOOL }, async ($, e) => {
    const plan = planIn(e.steps)
    const given =
      typeof e.percent === 'number' && Number.isFinite(e.percent)
        ? Math.max(0, Math.min(100, Math.round(e.percent)))
        : null
    const percent = given ?? (plan === null || plan.length === 0 ? null : planPercent(plan))
    const title = typeof e.task === 'string' ? e.task.trim() : ''
    if (percent === null || title === '') {
      return { deny: 'task_progress needs a short `task`, and `percent` from 0 to 100 or the `steps` of the plan.' }
    }
    if (e.agentId === undefined) {
      const step = typeof e.step === 'string' && e.step.trim() !== '' ? e.step.trim() : null
      const now = await $.clock.now()
      await update($, task, previous => {
        const same = previous !== null && !previous.isAuto && previous.title === title
        const before = same ? previous : null

        return {
          title,
          percent,
          step,
          isAuto: false,
          steps: plan === null ? (before?.steps ?? []) : timedPlan(before?.steps ?? [], plan, now),
          startedAt: before?.startedAt ?? now,
          samples: [...(before?.samples ?? []), { percent, at: now }].slice(-TASK_SAMPLES),
        }
      })
    }

    return { result: `Progress shown: ${percent}%.` }
  }).catch(() => ({ deny: 'task_progress could not update the bar; carry on with the task.' }))

  on('command.run', { command: 'runners' }, async $ => {
    await toggleRunners($)

    return {}
  }).catch(() => ({ text: 'The runner list did not open; details are in the debug log.' }))

  // The note under a cut middle shows everything: whoever drew it, its press gives the height back to auto.
  on('ui.press', { element: SHOW_ALL_KEY }, async ($, e, next) => {
    const pressed = await next(e)
    await setBandRows($, null)

    return pressed
  }).catch(($, e, next) => next(e))

  // `/band` says the band in words; `/band size 14` or `/band size auto` sets its height.
  on('command.run', { command: 'band' }, async ($, e) => {
    const size = /^size\s+(\d+|auto)$/.exec(e.args.trim())
    if (size !== null) {
      const rows = size[1] === 'auto' ? null : Math.max(BAND_MIN_ROWS, Number(size[1]))
      await setBandRows($, rows)

      return { text: rows === null ? 'Band height: auto' : `Band height: ${rows} rows` }
    }

    return { text: await bandInWords($) }
  }).catch(() => ({ text: 'The band could not describe itself; details are in the debug log.' }))

  // The prompt shows as the task at once; the model's first estimate takes it over.
  on('turn.start', async ($, e, next) => {
    const at = await $.clock.now()
    await update($, turnState, () => ({ isWorking: true, since: at }))
    await update($, lastExchange, () => ({ asked: promptGist(e.text), said: null, ending: null }))
    void publish($, false)
    const title = autoTitle(e.text)
    const current = await read($, task)
    const isFree = current === null || current.isAuto || current.percent >= 100
    if (title !== null && isFree) {
      await update($, task, () => ({ title, percent: 0, step: null, isAuto: true }))
    }

    return next(e)
  })

  // A task the model never estimated was a quick answer: it goes with the turn.
  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      const at = await $.clock.now()
      await update($, turnState, () => ({ isWorking: false, since: at }))
      await update($, lastExchange, previous => ({ ...previous, said: answerGist(e.answer), ending: e.reason }))
      void publish($, false)
      const current = await read($, task)
      if (current?.isAuto === true) {
        await update($, task, () => null)
      }
    }

    return next(e)
  })

  // At each turn's end the engine lists the session's background work whole:
  // what is missing from it has stopped. Observe only, as the other hooks.
  on('classic.Stop', async ($, e, next) => {
    await syncRunners($, e.background_tasks ?? [], true)

    return next(e)
  }).catch(($, e, next) => next(e))

  // A subagent's stop lists background work too; it finishes nothing here.
  on('classic.SubagentStop', async ($, e, next) => {
    await syncRunners($, e.background_tasks ?? [], false)

    return next(e)
  }).catch(($, e, next) => next(e))

  // The model's word on a piece of background work: its title, its task, and
  // where its progress shows. Answered here, so no permission prompt runs.
  on('tool.call', { tool: RUNNER_TOOL }, async ($, e) => {
    const id = textArg(e.id)
    const title = textArg(e.title)
    if (id === null || title === null) {
      return { deny: 'runner_info needs the background task `id` and a short `title`.' }
    }
    const badPattern = [e.done_pattern, e.total_pattern].find(
      value => textArg(value) !== null && compiled(textArg(value) ?? '') === null,
    )
    if (badPattern !== undefined) {
      return { deny: `runner_info: ${String(badPattern)} is not a valid regular expression.` }
    }
    const info: RunnerInfo = {
      title,
      forTask: textArg(e.task) ?? (await read($, task))?.title ?? null,
      log: textArg(e.log),
      donePattern: textArg(e.done_pattern),
      totalPattern: textArg(e.total_pattern),
      total: positiveArg(e.total),
      statusFile: textArg(e.status_file),
      expectedMinutes: positiveArg(e.expected_minutes),
      waitsFor: textArg(e.waits_for),
    }
    await describeRunner($, id, info)
    await measureRunners($)
    await publish($, false)

    return { result: `Runner described: ${title}.` }
  }).catch(() => ({ deny: 'runner_info could not record it; carry on with the task.' }))

  // A finished task makes way for whatever the next prompt brings.
  on('prompt.submit', async ($, e, next) => {
    const current = await read($, task)
    if (current !== null && current.percent >= 100) {
      await update($, task, () => null)
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('context')) {
      await record($, fromContext(e.context))
      try {
        const now = await $.clock.now()
        if ((await read($, isExpanded)) || now - (await read($, breakdownAt)) >= BREAKDOWN_REFRESH_MS) {
          await refreshBreakdown($)
        }
      } catch (error) {
        $.ui.log(`context-band: could not recount the context: ${messageOf(error)}`, { to: 'debug' })
      }
    }

    return next(e)
  })

  // session.measure fires only once a turn has ended; the main loop's model
  // steps keep the band current while a long turn is still running.
  on('turn.step', async function* ($, e, next) {
    const response = yield* next(e)
    if (e.agentId === undefined && response.usage !== null) {
      await recordStep($, response.usage)
    }

    return response
  })

  // Observe only: should this hook fail, the catch replays what next(e) settled
  // to, so the band never blocks a tool call or makes it run twice. A subagent's
  // calls stay in its own context; only its final answer (the Agent call) counts.
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (e.agentId === undefined) {
      await addToolShare($, e.tool, ran)
    }
    await trackLaunch($, e, ran)

    return ran
  }).catch(($, e, next) => next(e))

  // Observe only, as above: the band never blocks a compaction or makes it run twice.
  on('session.compact', async ($, e, next) => {
    const compacted = await next(e)
    const isMainCompacted =
      e.trigger !== 'precompute' && e.agentId === undefined && compacted.skip === undefined
    if (isMainCompacted) {
      await afterMainCompaction($)
    }

    return compacted
  }).catch(($, e, next) => next(e))

  on('session.end', async ($, e, next) => {
    await publish($, true)
    if (e.reason === 'clear') {
      await update($, fill, last =>
        last === null ? null : { ...last, tokens: null, percent: null, isEstimate: false },
      )
      await update($, warnedAt, () => 0)
      await update($, toolShares, () => [])
      await update($, breakdown, () => null)
      await update($, task, () => null)
    }

    return next(e)
  })

  // A pointer on a runner in the band marks the transcript row that launched it, and back.
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    const drawn = await next(e)
    if (!(await read($, isOn))) {
      return drawn
    }
    const runner = (await read($, runners)).find(candidate => candidate.launchId === e.props.tool_use_id)
    if (runner === undefined) {
      return drawn
    }
    const { Box, Text } = $.ui.resolve(e)
    const scope = `context-band:runner:${runner.id}`

    return (
      <Box flexDirection="column" hover={{ scope, backgroundColor: 'subtle' }}>
        {drawn}
        <Box display="none" hover={{ scope, display: 'flex' }}>
          <Text color="suggestion">{`↳ runner in the band: ${runner.info?.title ?? runner.description}`}</Text>
        </Box>
      </Box>
    )
  })

  // The band's rows in one order wherever the engine ran their hooks: this row first, then the
  // family's pieces (chip, then meter, then section, each by its order number), then every
  // other row as it came. The engine hands a row's hook only its own drawing, so each mod's
  // piece is a row of its own; the order is what still makes them read as one band.
  on('ui.render', { component: 'AbovePromptList' }, async ($, e, next) => {
    const rows = e.props.rows
    const own = rows.filter(row => row.plugin === MOD_NAME)
    const ranked = rows.filter(row => row.plugin !== MOD_NAME).map(row => ({ row, rank: pieceRank(row.tree) }))
    const keyed = ranked.filter(x => x.rank !== undefined).sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0))
    const rest = ranked.filter(x => x.rank === undefined)
    const ordered = [...own, ...keyed.map(x => x.row), ...rest.map(x => x.row)]

    return ordered.every((row, i) => row === rows[i]) ? next(e) : next({ ...e, props: { ...e.props, rows: ordered } })
  }).catch(($, e, next) => next(e))

  // The band, top down: the toolbar with the height at its right end while
  // the ⋯ menu is open, the context meter, the readings with ⋯ at their right
  // end, the other mods' rows, the open section (details or runners), and the
  // task last, right above the prompt. Every row sits on the family's grid.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const beneath = await next(e)
    const last = await read($, fill)
    if (e.props.hasSurvey || last === null || !(await read($, isOn))) {
      return beneath
    }
    // The mods beneath stacked their pieces; they go into the slots, in order.
    const sections = takePieces(beneath, 'section')
    const meters = takePieces(sections.rest, 'meter')
    const chips = takePieces(meters.rest, 'chip')
    const compacting = await read($, isCompacting)
    const expanded = await read($, isExpanded)
    const runnersOpen = await read($, isRunnersOpen)
    const current = await read($, task)
    const background = await read($, runners)
    const others = await read($, otherSessions)
    // Other sessions show what still runs; their finished work is their own band's to show.
    const busyOthers = others.filter(entry => entry.runners.some(runner => runner.endedAt === null))
    const running =
      background.filter(runner => runner.endedAt === null).length +
      busyOthers.reduce((sum, entry) => sum + entry.runners.filter(runner => runner.endedAt === null).length, 0)

    const ui = $.ui.resolve(e)
    const { Box, Button, Text } = ui
    const columns = e.props.bodyColumns
    const isUrgent = last.percent !== null && last.percent >= COMPACT_URGENT_AT
    const figure = last.percent === null ? '-' : `${last.isEstimate ? '~' : ''}${last.percent}%`

    const off = await read($, switchedOff)
    const sectionTabs = (await read($, sectionButtons)).filter(button => !off.includes(button.mod))
    const openedSection = await read($, openSection)
    const liveSessions = others.length + 1
    const menuOpen = await read($, isMenuOpen)
    // Compact takes no key: it must never fire by a stray keystroke.
    const compactControl = compacting ? (
      <Text dimColor>Compacting</Text>
    ) : e.props.isWorking ? null : (
      <Button
        key="compact"
        label="Compact"
        variant={isUrgent ? 'primary' : 'secondary'}
        dimColor={!isUrgent}
        onPress={() => compactNow($)}
      />
    )
    // Letters press only while the band holds the keys; a digit would be
    // pressed from an empty prompt. An open section's button is drawn at full strength.
    const toolbar = (
      <Box columnGap={1} flexWrap="wrap">
        <Button
          key="runners"
          label={running > 0 ? `Runners ${running}` : 'Runners'}
          hotkey="r"
          dimColor={!runnersOpen}
          onPress={() => toggleRunners($)}
        />
        <Button key="details" label="Details" hotkey="d" dimColor={!expanded} onPress={() => toggleDetails($)} />
        {compactControl}
        {sectionTabs.map(button => (
          <Button
            key={`section:${button.key}`}
            label={button.count === 'sessions' ? `${button.label} ${liveSessions}` : button.label}
            dimColor={openedSection !== button.key}
            onPress={() => pressSection($, button.key)}
          />
        ))}
        <Button key="mods" label="Mods" hotkey="m" dimColor onPress={() => closeSections($)} />
      </Box>
    )
    // With the menu shut, a full window still puts Compact (or its progress) beside ⋯.
    const menuControls = (
      <Box key="context-band:menu" gap={1} flexShrink={0}>
        {!menuOpen && (compacting || isUrgent) && compactControl}
        <Button key="band-menu" label="⋯" dimColor={!menuOpen} onPress={() => toggleMenu($)} />
      </Box>
    )
    const counted = await read($, breakdown)
    // The context is always the first chip of the band's one line of figures, its tone
    // saying how full it is. Its card, shown while the pointer is on the chip, says how
    // many tokens of the window are used and what fills them most.
    const contextText = [last.tokens === null ? '' : `${kilo(last.tokens)} of ${kilo(last.window)}`, counted === null ? '' : contextCard(counted)]
      .filter(part => part !== '')
      .join(' · ')
    const contextHover =
      contextText !== '' && !expanded ? (
        <Box display="none" hover={{ scope: CONTEXT_SCOPE, display: 'flex' }}>
          {gridRow(ui, { name: 'Context', figure, color: colorOf(last.percent), lines: [{ text: contextText, isDim: true }] }, columns)}
        </Box>
      ) : null
    const contextChip = (
      <Box key={pieceKey('chip', 1, MOD_NAME)} hover={{ scope: CONTEXT_SCOPE }}>
        {gridChip(ui, { name: 'Context', figure, color: colorOf(last.percent) })}
      </Box>
    )
    const clockNow = current === null ? 0 : await $.clock.now()
    const history = current === null ? [] : stepTimes(current, clockNow)
    const taskRow =
      current === null ? (
        gridRow(ui, { name: 'Task', figure: '-', color: 'inactive', percent: 0, barColor: 'inactive', lines: [{ text: 'no task', isDim: true }] }, columns)
      ) : (
        <Box flexDirection="column">
          <Box hover={{ scope: TASK_SCOPE }}>
            {gridRow(
              ui,
              {
                name: 'Task',
                figure: current.percent >= 100 ? '✓' : `${current.percent}%`,
                color: progressColor(current.percent),
                percent: current.percent,
                lines: [{ text: current.title }, ...taskNote(current, clockNow).map(text => ({ text, isDim: true }))],
              },
              columns,
            )}
          </Box>
          {history.length > 0 && (
            <Box display="none" hover={{ scope: TASK_SCOPE, display: 'flex' }}>
              {gridRow(ui, { name: '', figure: '', lines: history.map(text => ({ text, isDim: true })) }, columns)}
            </Box>
          )}
        </Box>
      )

    // A set height, in rows: the open toolbar, the context row and the task
    // always show; the rest is the middle's.
    const chosen = await read($, bandRows)
    // The set height counts the toolbar's rows: with the menu shut the band is
    // that much shorter, instead of filling the toolbar's place with blank rows.
    const toolbarRows = rowsOf({ type: 'Box', props: { flexWrap: 'wrap', columnGap: 2 }, children: [toolbar, SIZE_STAND_IN] }, columns)
    const chosenHere = chosen === null ? null : chosen - (menuOpen ? 0 : toolbarRows)
    const fixedRows = (menuOpen ? toolbarRows : 0) + rowsOf(taskRow, columns)
    const maxRows = Math.max(fixedRows + 1, Number.isFinite(e.props.maxRows) && e.props.maxRows > 0 ? Math.floor(e.props.maxRows) : BAND_MAX_ROWS)
    // The middle's rows at a set height, before it is drawn: how many runners list.
    const roomAhead = chosenHere === null ? null : Math.max(1, Math.min(chosenHere, maxRows) - fixedRows)
    const details = expanded ? await read($, breakdown) : null
    const shares = expanded ? await read($, toolShares) : []
    const now = runnersOpen || background.length > 0 ? await $.clock.now() : 0
    const view = runnersOpen ? await read($, runnerView) : 'progress'
    const opened = runnersOpen ? await read($, expandedRunner) : null
    const notes = runnersOpen ? await read($, explanations) : {}
    const writing = runnersOpen ? await read($, explaining) : null
    const listed = runnersOpen ? listRunners(background, busyOthers, now) : []
    const live = listed.filter(item => !isFinished(item.runner, now))
    const finished = listed.filter(item => isFinished(item.runner, now))
    const isAll = runnersOpen && (await read($, isShowingAllRunners))
    const isDoneShown = runnersOpen && (await read($, isShowingDoneRunners))
    const runnerLimit = roomAhead === null ? RUNNER_ROWS : Math.max(RUNNER_ROWS, Math.floor(roomAhead / 3))
    const liveShown = isAll ? live : live.slice(0, runnerLimit)
    const runnerRow = (item: ListedRunner) => {
      const { runner, key, scope } = item
      const state = runnerState(runner, now)
      const percent = runner.progress?.percent ?? null
      const tail = runner.endedAt === null ? logTail(runner) : []
      const isOpen = opened === key
      const command = runner.detail
      const log = logPathOf(runner)

      return (
        <Box flexDirection="column">
          <Box hover={{ scope, backgroundColor: 'subtle' }}>
            {gridRow(
              ui,
              {
                name: state.label,
                nameColor: state.tone,
                figure: view === 'timeline' || percent === null ? '' : `${runner.progress?.isApprox === true ? '≈' : ''}${percent}%`,
                color: state.tone,
                ...(view === 'timeline' ? { barText: timeline(runner, now) } : { percent: percent ?? 0 }),
                barColor: view === 'timeline' ? state.tone : percent === null || runner.progress?.isApprox === true ? 'inactive' : state.tone,
                lines: [],
              },
              columns,
            )}
          </Box>
          <Box marginLeft={GRID_NAME + GRID_FIGURE + 2} flexDirection="column">
            <Button key={`runner:${key}`} plain dimColor={false} onPress={() => toggleRunner($, key)}>
              {`${isOpen ? '▾' : '▸'} ${runner.info?.title ?? runner.description}`}
            </Button>
            {[...(item.where === '' ? [] : [item.where]), ...runnerNotes(runner, now)].map(text => (
              <Text dimColor>{text}</Text>
            ))}
            {notes[key] !== undefined && <Text color="suggestion">{notes[key]}</Text>}
            {isOpen && tail.map(text => <Text dimColor>{`│ ${text}`}</Text>)}
            {isOpen && command !== null && <Text dimColor>{`command: ${command}`}</Text>}
            {isOpen && log !== null && <Text dimColor>{`log: ${log}`}</Text>}
            {isOpen && (
              <Box gap={1} flexWrap="wrap">
                {command !== null && <Button key={`copy-command:${key}`} label="Copy command" dimColor onPress={() => copyText($, command)} />}
                {log !== null && <Button key={`copy-log:${key}`} label="Copy log path" dimColor onPress={() => copyText($, log)} />}
                {writing === key ? (
                  <Text dimColor>writing an explanation</Text>
                ) : (
                  <Button key={`explain:${key}`} label="Explain" dimColor onPress={() => explainRunner($, key, runner)} />
                )}
              </Box>
            )}
          </Box>
          {!isOpen && tail.length > 0 && (
            <Box display="none" hover={{ scope, display: 'flex' }}>
              {gridRow(ui, { name: '', figure: '', lines: tail.map(text => ({ text: `│ ${text}`, isDim: true })) }, columns)}
            </Box>
          )}
        </Box>
      )
    }
    const leaseRows = leaseQueues([
      ...background.map(runner => ({ runner, where: '' })),
      ...busyOthers.flatMap(entry => entry.runners.map(runner => ({ runner, where: baseName(entry.cwd) }))),
    ]).map(queue =>
      gridRow(
        ui,
        {
          name: 'Eval lease',
          figure: queue.waiters.length === 0 ? '' : String(queue.waiters.length),
          color: queue.waiters.length === 0 ? 'success' : 'warning',
          lines: [
            {
              text: [
                queue.holders.length === 0 ? 'held by someone off this Mac' : `held by ${queue.holders.join(', ')}`,
                queue.waiters.length === 0 ? '' : `waiting: ${queue.waiters.join(', ')}`,
              ]
                .filter(Boolean)
                .join(' · '),
              isDim: true,
            },
          ],
        },
        columns,
      ),
    )
    const sectionHeader = (name: string, text: string) =>
      gridRow(ui, { name, isHeader: true, figure: '', lines: [{ text, isDim: true }] }, columns)
    const runnersHeader = (
      <Box justifyContent="space-between" flexWrap="wrap" columnGap={2}>
        {sectionHeader(
          'Runners',
          `${runnersSummary(background, busyOthers, now)}${view === 'timeline' ? ' · scale: last 4h' : ''}`,
        )}
        <Button
          key="runner-view"
          label={view === 'timeline' ? 'Progress' : 'Timeline'}
          dimColor
          onPress={() => toggleRunnerView($)}
        />
      </Box>
    )

    const meterSlot = (
      <Box key={METERS_SLOT} flexDirection="column">
        {[...meters.pieces].sort(byPieceKey) as RenderElement[]}
        {chips.rest as RenderElement}
      </Box>
    )
    const chipSlot = (
      <Box key={CHIPS_SLOT} columnGap={CHIP_GAP} flexWrap="wrap">
        {[contextChip, ...chips.pieces].sort(byPieceKey) as RenderElement[]}
      </Box>
    )
    const readingsRow = (
      // marginBottom: keeps the ⋯ button off the line under it, as the toolbar's does.
      <Box key="context-band:readings" justifyContent="space-between" columnGap={2} marginBottom="xs">
        {chipSlot}
        {menuControls}
      </Box>
    )
    const sectionSlot = (
      <Box key={SECTIONS_SLOT} flexDirection="column">
        {[...sections.pieces].sort(byPieceKey) as RenderElement[]}
      </Box>
    )
    const content: RenderElement[] = [
      readingsRow,
      ...(contextHover === null ? [] : [contextHover]),
      meterSlot,
      ...leaseRows,
      ...(expanded ? [sectionHeader('Details', details === null ? 'counting the context' : 'what fills the window, largest first')] : []),
      ...(details === null
        ? []
        : categoryRows(details).map(row =>
            gridRow(
              ui,
              {
                name: row.name,
                ...(row.isDim ? {} : { nameColor: 'text' as const }),
                figure: row.percent === null ? '' : `${row.percent}%`,
                percent: row.percent ?? 0,
                barColor: row.percent === null ? 'inactive' : (row.color as ThemeKey),
                lines: [{ text: row.percent === null ? `${kilo(row.tokens)} · on demand` : kilo(row.tokens), isDim: true }],
              },
              columns,
            ),
          )),
      ...(details === null
        ? []
        : detailLines(details, shares).map(line => gridRow(ui, { name: line.name, figure: '', lines: [{ text: line.text, isDim: true }] }, columns))),
      ...(runnersOpen ? [runnersHeader] : []),
      ...(runnersOpen ? liveShown.map(runnerRow) : []),
      ...(runnersOpen && live.length > liveShown.length
        ? [
            <Box marginLeft={GRID_NAME + GRID_FIGURE + 2}>
              <Button key="runners-more" plain dimColor onPress={() => showAllRunners($)}>
                {`${live.length - liveShown.length} more`}
              </Button>
            </Box>,
          ]
        : []),
      ...(runnersOpen && finished.length > 0
        ? [
            <Box marginLeft={GRID_NAME + GRID_FIGURE + 2}>
              <Button key="runners-done" plain dimColor onPress={() => toggleDoneRunners($)}>
                {isDoneShown ? 'hide finished' : `${finished.length} more finished`}
              </Button>
            </Box>,
          ]
        : []),
      ...(runnersOpen && isDoneShown ? finished.map(runnerRow) : []),
      sectionSlot,
    ]
    // The readings and ⋯ are never cut, and a row more holds the note when
    // anything under them is out.
    const contentRows = rowsOf(content, columns)
    const readingRows = rowsOf(readingsRow, columns)
    const minRows = fixedRows + readingRows + (contentRows > readingRows ? 1 : 0)
    const limit = chosenHere === null ? null : Math.max(minRows, Math.min(chosenHere, maxRows))
    const middleRows = limit === null ? null : limit - fixedRows
    // In auto the middle takes the rows it holds; at a set height exactly its own.
    const middle =
      middleRows === null ? (
        <Box key="context-band:middle" flexDirection="column">
          {content}
        </Box>
      ) : (
        fitBand(ui, { type: 'Box', props: { flexDirection: 'column' }, children: content }, middleRows, columns)
      )
    // The rows the band shows now: a step starts from them.
    const shown = limit ?? Math.min(maxRows, fixedRows + contentRows)
    const toolbarRow = (
      // marginBottom: a desktop button is taller than a line of text; xs keeps it off the readings (no row on the terminal).
      <Box key="context-band:toolbar" justifyContent="space-between" flexWrap="wrap" columnGap={2} marginBottom="xs">
        {toolbar}
        <Box gap={1} flexShrink={0}>
          <Text dimColor>{limit === null ? 'height auto' : `height ${limit}`}</Text>
          <Button key="band-taller" label="▲" dimColor onPress={() => resizeBand($, BAND_STEP, shown, minRows, maxRows)} />
          <Button key="band-shorter" label="▼" dimColor onPress={() => resizeBand($, -BAND_STEP, shown, minRows, maxRows)} />
          {limit !== null && <Button key="band-auto" label="auto" dimColor onPress={() => setBandRows($, null)} />}
        </Box>
      </Box>
    )

    return (
      <Box key="context-band:root" flexDirection="column">
        {menuOpen && toolbarRow}
        {middle}
        {taskRow}
      </Box>
    )
  })
}

// A step of the height from the rows the band shows, a row a press; the height
// is read again at the press, so presses quicker than the redraws all count.
async function resizeBand($: EngineInterface, step: number, shown: number, minRows: number, maxRows: number): Promise<void> {
  const chosen = await read($, bandRows)
  const from = chosen === null ? shown : Math.max(minRows, Math.min(maxRows, chosen))
  await setBandRows($, Math.max(minRows, Math.min(maxRows, from + step)))
}

async function setBandRows($: EngineInterface, rows: number | null): Promise<void> {
  await update($, bandRows, () => rows)
  await saveBandFile($)
}

async function toggleMenu($: EngineInterface): Promise<void> {
  await update($, isMenuOpen, isOpen => !isOpen)
  await saveBandFile($)
}

async function readBandFile($: EngineInterface): Promise<void> {
  try {
    const home = await $.env.get('HOME')
    const path = `${(home ?? '').replace(/\/$/, '')}/${BAND_FILE}`
    if (home === undefined || home === '' || !(await $.fs.exists(path))) {
      return
    }
    const data = JSON.parse(await readText($, path)) as { rows?: unknown; isMenuOpen?: unknown }
    const rows = typeof data.rows === 'number' ? data.rows : null
    if (rows !== (await read($, bandRows))) {
      await update($, bandRows, () => rows)
    }
    const menuOpen = data.isMenuOpen === true
    if (menuOpen !== (await read($, isMenuOpen))) {
      await update($, isMenuOpen, () => menuOpen)
    }
  } catch (error) {
    $.ui.log(`context-band: could not read the band's settings: ${messageOf(error)}`, { to: 'debug' })
  }
}

async function saveBandFile($: EngineInterface): Promise<void> {
  try {
    const home = await $.env.get('HOME')
    if (home === undefined || home === '') {
      return
    }
    const rows = await read($, bandRows)
    const menuOpen = await read($, isMenuOpen)
    await $.fs.write(`${home.replace(/\/$/, '')}/${BAND_FILE}`, JSON.stringify({ rows, isMenuOpen: menuOpen }))
  } catch (error) {
    $.ui.log(`context-band: could not keep the band's settings: ${messageOf(error)}`, { to: 'debug' })
  }
}

async function toggleRunners($: EngineInterface): Promise<void> {
  const open = await update($, isRunnersOpen, isOpen => !isOpen)
  await update($, openSection, () => null)
  if (open) {
    await update($, isExpanded, () => false)
    await refreshAgents($)
    await measureRunners($)
    await collectOthers($)
    await checkAlerts($)
  }
}

// Agents can be asked for at any moment; the rest of the background work is
// listed by the engine at each turn's end and seen here as it starts.
async function refreshAgents($: EngineInterface): Promise<void> {
  const agents = await $.agent.list()
  const now = await $.clock.now()
  await update($, runners, known => {
    const merged = known.map(runner => {
      const agent = agents.find(candidate => candidate.id === runner.id)
      if (agent === undefined) {
        return runner
      }
      const isOver = isEnded(agent.status)

      return { ...runner, status: agent.status, endedAt: isOver ? (runner.endedAt ?? now) : null }
    })
    const added: Runner[] = agents
      .filter(agent => !isEnded(agent.status) && !known.some(runner => runner.id === agent.id))
      .map(agent => ({
        id: agent.id,
        type: 'subagent',
        status: agent.status,
        description: agent.description,
        detail: `agent: ${agent.type}`,
        seenAt: now,
        endedAt: null,
      }))

    return keepRecent([...merged, ...added])
  })
  await publish($, false)
}

// The engine's list of background work. At a main turn's end it is whole, so
// what the band knew and the list lacks has stopped (finishMissing).
async function syncRunners(
  $: EngineInterface,
  tasks: readonly TaskSnapshot[],
  finishMissing: boolean,
): Promise<void> {
  const now = await $.clock.now()
  await update($, runners, known => {
    const merged = known.map(runner => {
      const listed = tasks.find(candidate => candidate.id === runner.id)
      if (listed !== undefined) {
        return {
          ...runner,
          ...describeTask(listed),
          endedAt: isEnded(listed.status) ? (runner.endedAt ?? now) : null,
        }
      }

      return finishMissing && runner.endedAt === null
        ? { ...runner, status: 'finished', endedAt: now }
        : runner
    })
    const added: Runner[] = tasks
      .filter(listed => !known.some(runner => runner.id === listed.id))
      .map(listed => ({
        id: listed.id,
        ...describeTask(listed),
        seenAt: now,
        endedAt: isEnded(listed.status) ? now : null,
      }))

    return keepRecent([...merged, ...added])
  })
  await publish($, false)
  await checkAlerts($)
}

// A background shell or agent shows the moment it starts, not at the turn's end.
async function trackLaunch(
  $: EngineInterface,
  e: { tool: string; [argument: string]: unknown },
  ran: ToolReply,
): Promise<void> {
  let launched: Omit<Runner, 'seenAt' | 'endedAt'> | null = null
  if (e.tool === 'Bash') {
    const id = stringField(ran.result, 'backgroundTaskId')
    const command = typeof e.command === 'string' ? e.command : ''
    const said = typeof e.description === 'string' ? e.description.trim() : ''
    if (id !== undefined) {
      launched = { id, type: 'shell', status: 'running', description: said || command, detail: command || null }
    }
  } else if (e.tool === 'Agent') {
    const id = stringField(ran.result, 'agentId')
    const status = stringField(ran.result, 'status')
    const said = typeof e.description === 'string' ? e.description.trim() : ''
    const kind = typeof e.subagent_type === 'string' ? e.subagent_type : 'general-purpose'
    if (id !== undefined && (status === 'async_launched' || status === 'remote_launched')) {
      launched = { id, type: 'subagent', status: 'running', description: said, detail: `agent: ${kind}` }
    }
  }
  if (launched === null) {
    return
  }
  const started = launched
  const now = await $.clock.now()
  await update($, runners, known => {
    const prior = known.find(runner => runner.id === started.id)
    const runner: Runner = {
      ...started,
      seenAt: prior?.seenAt ?? now,
      endedAt: null,
      launchId: typeof e.tool_use_id === 'string' ? e.tool_use_id : prior?.launchId,
      info: prior?.info ?? null,
      ...(prior?.progress === undefined ? {} : { progress: prior.progress }),
    }

    return keepRecent([...known.filter(other => other.id !== started.id), runner])
  })
  await publish($, false)
}

async function heartbeat($: EngineInterface): Promise<void> {
  await readSectionButtons($)
  await readBandFile($)
  await measureRunners($)
  await publish($, false)
  await collectOthers($)
  await checkAlerts($)
}

async function registryDir($: EngineInterface): Promise<string> {
  const home = await $.env.get('HOME')
  if (home === undefined || home === '') {
    throw new Error('HOME is not set')
  }

  return `${home.replace(/\/$/, '')}/${REGISTRY_DIR}`
}

// The list across sessions is a convenience: a failed write or read is noted
// in the debug log and never gets in the way of the session's own work.
async function publish($: EngineInterface, isEnded: boolean): Promise<void> {
  try {
    const dir = await registryDir($)
    const sessionId = await $.session.id()
    const current = await read($, task)
    const entry: SessionEntry = {
      sessionId,
      cwd: await $.session.cwd(),
      task: current === null || isEnded ? null : { title: current.title, percent: current.percent, step: current.step },
      runners: isEnded ? [] : await read($, runners),
      fill: (await read($, fill))?.percent ?? null,
      turn: await read($, turnState),
      ...(isEnded ? { asked: null, said: null, ending: null } : await read($, lastExchange)),
      updatedAt: await $.clock.now(),
      isEnded,
    }
    await $.fs.write(`${dir}/${sessionId}.json`, JSON.stringify(entry))
  } catch (error) {
    $.ui.log(`context-band: could not publish this session's runners: ${messageOf(error)}`, { to: 'debug' })
  }
}

async function collectOthers($: EngineInterface): Promise<void> {
  try {
    const dir = await registryDir($)
    const own = `${await $.session.id()}.json`
    const now = await $.clock.now()
    const files = (await $.fs.list(dir)).filter(
      file => file.kind === 'file' && file.name.endsWith('.json') && file.name !== own && now - file.mtimeMs < SILENT_AFTER_MS,
    )
    const previous = await read($, otherSessions)
    const entries: SessionEntry[] = []
    for (const file of files) {
      const entry = parseEntry(await $.fs.read(`${dir}/${file.name}`))
      if (entry !== null && !entry.isEnded && now - entry.updatedAt < SILENT_AFTER_MS) {
        const before = previous.find(known => known.sessionId === entry.sessionId)
        entries.push({ ...entry, runners: await measureOthers($, entry.runners, before, now) })
      }
    }
    entries.sort((a, b) => b.updatedAt - a.updatedAt)
    await update($, otherSessions, () => entries)
  } catch (error) {
    $.ui.log(`context-band: could not read the other sessions' runners: ${messageOf(error)}`, { to: 'debug' })
  }
}

// Another session's running work, measured here as this session measures its
// own: its progress then shows whichever version of the band that session
// runs. The last reading made here carries the rate from one gathering to the next.
async function measureOthers(
  $: EngineInterface,
  list: readonly Runner[],
  before: SessionEntry | undefined,
  now: number,
): Promise<Runner[]> {
  const measured: Runner[] = []
  for (const runner of list) {
    if (runner.endedAt !== null) {
      measured.push(runner)
      continue
    }
    const priorHere = before?.runners.find(known => known.id === runner.id)?.progress ?? null
    const published = runner.progress ?? null
    try {
      const progress = await measureRunner($, { ...runner, progress: priorHere ?? published }, now)
      measured.push({ ...runner, progress: progress ?? published })
    } catch (error) {
      $.ui.log(`context-band: could not read ${runner.id}'s progress: ${messageOf(error)}`, { to: 'debug' })
      measured.push(runner)
    }
  }

  return measured
}

// Another session's file, or null when it is mid-write or not one of ours.
function parseEntry(text: string | { base64: string }): SessionEntry | null {
  if (typeof text !== 'string') {
    return null
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const entry = value as Partial<SessionEntry>
  const isShaped =
    typeof entry.sessionId === 'string' &&
    typeof entry.cwd === 'string' &&
    typeof entry.updatedAt === 'number' &&
    Array.isArray(entry.runners)

  return isShaped ? (entry as SessionEntry) : null
}

function sessionLabel(entry: SessionEntry): string {
  const where = baseName(entry.cwd)
  if (entry.task === null) {
    return `${where} · session ${entry.sessionId.slice(0, 8)}`
  }

  return `${where} · ${entry.task.title} · ${entry.task.percent}%`
}

// The model's word on a runner, kept on it; a runner the band has not seen yet
// starts from it, and the engine's list fills in its type and status later.
async function describeRunner($: EngineInterface, id: string, info: RunnerInfo): Promise<void> {
  const now = await $.clock.now()
  await update($, runners, known => {
    const prior = known.find(runner => runner.id === id)
    const runner: Runner =
      prior === undefined
        ? { id, type: 'task', status: 'running', description: info.title, detail: null, seenAt: now, endedAt: null, info }
        : { ...prior, info }

    return keepRecent([...known.filter(other => other.id !== id), runner])
  })
}

// Reads the progress of every running runner of this session: from the files
// the model named, from the status and log files its command names, or, with
// nothing to count, from the time it was expected to take.
async function measureRunners($: EngineInterface): Promise<void> {
  try {
    const now = await $.clock.now()
    const list = await read($, runners)
    const measured = new Map<string, RunnerProgress | null>()
    for (const runner of list) {
      if (runner.endedAt === null) {
        measured.set(runner.id, await measureRunner($, runner, now))
      }
    }
    if (measured.size > 0) {
      await update($, runners, current =>
        current.map(runner => (measured.has(runner.id) ? { ...runner, progress: measured.get(runner.id) ?? null } : runner)),
      )
    }
  } catch (error) {
    $.ui.log(`context-band: could not read the runners' progress: ${messageOf(error)}`, { to: 'debug' })
  }
}

async function measureRunner($: EngineInterface, runner: Runner, now: number): Promise<RunnerProgress | null> {
  const info = runner.info ?? null
  const named = info !== null && (info.statusFile !== null || info.log !== null)
  const files = named
    ? { statusFiles: info.statusFile === null ? [] : [info.statusFile], logs: info.log === null ? [] : [info.log] }
    : pathsInCommand(runner.detail ?? '')
  const targets: RunnerTarget[] = []
  for (const statusFile of files.statusFiles) {
    const log = (named ? info?.log : null) ?? siblingLog(statusFile, files.logs)
    targets.push(await readTarget($, stem(statusFile), statusFile, log, info))
  }
  if (files.statusFiles.length === 0) {
    for (const log of files.logs) {
      targets.push(await readTarget($, stem(log), null, log, info))
    }
  }
  if (targets.length === 0) {
    const expected = info?.expectedMinutes ?? null
    if (expected === null) {
      return null
    }
    const elapsed = (now - runner.seenAt) / 60_000

    return {
      targets: [],
      percent: Math.min(99, Math.round((elapsed / expected) * 100)),
      isApprox: true,
      minutesLeft: Math.max(0, Math.round(expected - elapsed)),
      sample: null,
    }
  }

  const active = activeTarget(targets)
  const percent =
    active.done !== null && active.total !== null && active.total > 0
      ? Math.min(100, Math.round((active.done / active.total) * 100))
      : null
  // The rate runs from the first count seen for this job to the latest one.
  const prior = runner.progress?.sample ?? null
  let sample: RunnerProgress['sample'] = null
  let minutesLeft: number | null = null
  if (active.done !== null) {
    const isSameJob = prior !== null && prior.name === active.name && prior.done <= active.done
    sample = isSameJob ? prior : { name: active.name, at: now, done: active.done }
    const gained = active.done - sample.done
    if (gained > 0 && now > sample.at && active.total !== null) {
      const perMinute = gained / ((now - sample.at) / 60_000)
      minutesLeft = Math.ceil(Math.max(0, active.total - active.done) / perMinute)
    } else if (isSameJob) {
      minutesLeft = runner.progress?.minutesLeft ?? null
    }
  }

  return { targets, percent, isApprox: false, minutesLeft, sample }
}

async function readTarget(
  $: EngineInterface,
  name: string,
  statusFile: string | null,
  log: string | null,
  info: RunnerInfo | null,
): Promise<RunnerTarget> {
  let status = 'running'
  if (statusFile !== null) {
    status = (await $.fs.exists(statusFile)) ? statusWordIn(await readText($, statusFile)) : 'waiting'
  }
  let done: number | null = null
  let total = info?.total ?? null
  let lastLine: string | null = null
  let tail: string[] = []
  let logAt: number | null = null
  let lease: RunnerTarget['lease'] = null
  if (log !== null && status !== 'waiting' && (await $.fs.exists(log))) {
    logAt = (await $.fs.stat(log)).mtimeMs
    const text = await readText($, log)
    const counted = countProgress(text, info)
    done = counted.done
    total = total ?? counted.total
    lastLine = lastLogLine(text)
    tail = lastLogLines(text, TAIL_LINES)
    lease = leaseIn(text)
  }

  return { name, status, done, total, lastLine, tail, logAt, lease }
}

async function readText($: EngineInterface, path: string): Promise<string> {
  const content = await $.fs.read(path)

  return typeof content === 'string' ? content.slice(-MAX_LOG_CHARS) : ''
}

// Units done and in all: by the model's patterns; else as a question-by-question
// run logs them; else from the last lines' "N/M" or "N%".
function countProgress(text: string, info: RunnerInfo | null): { done: number | null; total: number | null } {
  const lines = text.split('\n')
  const donePattern = info?.donePattern ? compiled(info.donePattern) : null
  if (donePattern !== null) {
    const totalPattern = info?.totalPattern ? compiled(info.totalPattern) : null
    const found = totalPattern === null ? null : totalPattern.exec(text)?.[1]

    return { done: lines.filter(line => donePattern.test(line)).length, total: found === undefined || found === null ? null : Number(found) }
  }
  const auditTotal = AUDIT_TOTAL.exec(text)?.[1]
  if (auditTotal !== undefined) {
    return { done: lines.filter(line => AUDIT_DONE.test(line)).length, total: Number(auditTotal) }
  }
  for (const line of lines.filter(candidate => candidate.trim() !== '').slice(-3).reverse()) {
    const fraction = /\b(\d+)\s*\/\s*(\d+)\b/.exec(line)
    if (fraction?.[1] !== undefined && fraction[2] !== undefined) {
      const done = Number(fraction[1])
      const total = Number(fraction[2])
      if (total > 0 && done <= total) {
        return { done, total }
      }
    }
    const share = /\b(\d{1,3})\s*%/.exec(line)?.[1]
    if (share !== undefined && Number(share) <= 100) {
      return { done: Number(share), total: 100 }
    }
  }

  return { done: null, total: null }
}

// The status and log files a watcher's command names, its simple VAR=value
// assignments expanded first: `L=/x/logs; until [ -f $L/build.status ]`.
function pathsInCommand(command: string): { statusFiles: string[]; logs: string[] } {
  const vars = new Map<string, string>()
  for (const match of command.matchAll(/(?:^|[;&|\s])([A-Za-z_][A-Za-z0-9_]*)=([^\s;&|]+)/g)) {
    if (match[1] !== undefined && match[2] !== undefined) {
      vars.set(match[1], match[2].replace(/^['"]|['"]$/g, ''))
    }
  }
  const expanded = command.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (whole, name: string) => vars.get(name) ?? whole)
  const pathsEnding = (suffix: string) => [
    ...new Set([...expanded.matchAll(new RegExp(`(/[^\\s'"|;&]+\\.${suffix})(?![\\w.])`, 'g'))].map(match => match[1] ?? '')),
  ]

  return { statusFiles: pathsEnding('status').slice(0, 3), logs: pathsEnding('log').slice(0, 3) }
}

// The job the runner is on now: one that runs, else one still waiting to
// start, else the last. A watcher's command names the job it waits for first,
// while the job before it in the queue is the one running.
function activeTarget(targets: readonly RunnerTarget[]): RunnerTarget {
  const fallback = targets[targets.length - 1] as RunnerTarget

  return (
    targets.find(target => isLive(target.status)) ??
    targets.find(target => target.status === 'waiting') ??
    fallback
  )
}

function isLive(status: string): boolean {
  return status !== 'waiting' && !DONE_WORDS.has(status) && !DEAD_WORDS.has(status)
}

// The jobs in the order they run: finished ones, then the running one, then those waiting.
function inRunOrder(targets: readonly RunnerTarget[]): RunnerTarget[] {
  const rank = (target: RunnerTarget) => (target.status === 'waiting' ? 2 : isLive(target.status) ? 1 : 0)

  return [...targets].sort((a, b) => rank(a) - rank(b))
}

// A status file's log is the log of the same name beside it.
function siblingLog(statusFile: string, logs: readonly string[]): string {
  const log = statusFile.replace(/\.status$/, '.log')

  return logs.find(candidate => candidate === log) ?? log
}

function stem(path: string): string {
  return baseName(path).replace(/\.[^.]+$/, '')
}

// What a log says last, for a job with nothing to count: often the very thing
// it waits on ("waiting for evaluation lease ...").
function lastLogLine(text: string): string | null {
  return lastLogLines(text, 1)[0] ?? null
}

// Where the job stands with the evaluation lease, by its log's last word on it.
function leaseIn(text: string): RunnerTarget['lease'] {
  let found: RunnerTarget['lease'] = null
  for (const match of text.matchAll(LEASE_LINE)) {
    found = { name: match[2] ?? '', state: match[1] === 'acquired' ? 'holding' : 'waiting' }
  }

  return found
}

// Every lease the running jobs of this Mac wait for or hold: who holds it and who waits.
function leaseQueues(runnersSeen: ReadonlyArray<{ runner: Runner; where: string }>): Array<{
  name: string
  holders: string[]
  waiters: string[]
}> {
  const queues = new Map<string, { holders: string[]; waiters: string[] }>()
  for (const { runner, where } of runnersSeen) {
    const targets = runner.progress?.targets ?? []
    if (runner.endedAt !== null || targets.length === 0) {
      continue
    }
    const active = activeTarget(targets)
    const lease = active.lease ?? null
    if (lease === null || DONE_WORDS.has(active.status) || DEAD_WORDS.has(active.status)) {
      continue
    }
    const queue = queues.get(lease.name) ?? { holders: [], waiters: [] }
    const label = `${runner.info?.title ?? runner.description}${where === '' ? '' : ` (${where})`}`
    if (lease.state === 'holding') {
      queue.holders.push(label)
    } else {
      queue.waiters.push(label)
    }
    queues.set(lease.name, queue)
  }

  return [...queues.entries()].map(([name, queue]) => ({ name, ...queue }))
}

function lastLogLines(text: string, count: number): string[] {
  const lines = text.split('\n').map(line => line.trim()).filter(line => line !== '')

  return lines.slice(-count).map(line => line.slice(0, LAST_LINE_MAX_CHARS))
}

// What a pointer on a running runner reveals: its active job's last log lines.
function logTail(runner: Runner): string[] {
  const targets = runner.progress?.targets ?? []

  return targets.length === 0 ? [] : (activeTarget(targets).tail ?? [])
}

// What a pointer on the context meter reveals: the biggest shares and where auto-compaction starts.
function contextCard(details: Breakdown): string {
  const top = categoryRows(details)
    .filter(row => !row.isDim)
    .slice(0, 3)
    .map(row => `${row.name} ${kilo(row.tokens)}`)
  const compactAt = details.autoCompactAt === null ? [] : [`auto-compact at ${kilo(details.autoCompactAt)}`]

  return [...top, ...compactAt].join(' · ')
}

// The log line a row shows: only when the job runs and nothing could be counted.
function logLineShown(runner: Runner): string | null {
  const targets = runner.progress?.targets ?? []
  if (runner.endedAt !== null || targets.length === 0) {
    return null
  }
  const active = activeTarget(targets)

  return active.done === null && active.status !== 'waiting' ? (active.lastLine ?? null) : null
}

// A status file's word is the first word of its first line: `DONE 0a1b2c3d` is DONE.
function statusWordIn(text: string): string {
  return text.trim().split(/\s+/)[0] || 'running'
}

function compiled(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern, 'm')
  } catch {
    return null
  }
}

function textArg(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

function positiveArg(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

// What a runner's row says about its progress: counted, approximate, waiting, or nothing.
// How far a runner got, in words; its percent stands in the figure column.
function progressText(runner: Runner): string {
  const progress = runner.progress ?? null
  if (progress === null) {
    return ''
  }
  const left = progress.minutesLeft === null ? '' : `~${minutes(progress.minutesLeft)} left`
  if (progress.isApprox) {
    return progress.minutesLeft === 0 ? 'approximate · longer than expected' : ['approximate', left].filter(Boolean).join(' · ')
  }
  const active = activeTarget(progress.targets)
  if (active.status === 'waiting') {
    return `waiting for ${runner.info?.waitsFor ?? active.name}`
  }
  if (active.done !== null && active.total !== null) {
    const isOver = DONE_WORDS.has(active.status) || DEAD_WORDS.has(active.status)

    return [`${active.done}/${active.total}`, isOver ? '' : left].filter(Boolean).join(' · ')
  }

  return ''
}

// The job's own status word, when a status file gave one.
function statusWord(runner: Runner): string | null {
  const targets = runner.progress?.targets ?? []
  if (targets.length === 0) {
    return null
  }
  const status = activeTarget(targets).status
  const plain = status.toLowerCase()

  return plain === 'waiting' || plain === 'running' ? null : status
}

// The state the name column shows: a mark and a word, in the row's color.
function runnerState(runner: Runner, now: number): { label: string; tone: ThemeKey } {
  if (runner.endedAt !== null) {
    if (runner.status === 'failed' || runner.status === 'error') {
      return { label: '✕ died', tone: 'error' }
    }
    if (runner.status === 'killed' || runner.status === 'stopped' || runner.status === 'cancelled') {
      return { label: '■ stopped', tone: 'subtle' }
    }

    return { label: '✓ done', tone: 'subtle' }
  }
  const targets = runner.progress?.targets ?? []
  const status = targets.length === 0 ? null : activeTarget(targets).status
  if (status !== null && DEAD_WORDS.has(status)) {
    return { label: '✕ died', tone: 'error' }
  }
  if (status !== null && DONE_WORDS.has(status)) {
    return { label: '✓ done', tone: 'success' }
  }
  if (status === 'waiting') {
    return { label: '◌ waiting', tone: 'warning' }
  }
  if (runner.status === 'pending') {
    return { label: '◌ queued', tone: 'warning' }
  }
  if (stalledFor(runner, now) !== null) {
    return { label: '⚠ stuck?', tone: 'warning' }
  }

  return { label: '● running', tone: 'suggestion' }
}

// How long a running job's log has been still, once past STALL_MS; null otherwise.
function stalledFor(runner: Runner, now: number): number | null {
  const targets = runner.progress?.targets ?? []
  if (runner.endedAt !== null || targets.length === 0) {
    return null
  }
  const active = activeTarget(targets)
  const still = active.logAt === undefined || active.logAt === null ? 0 : now - active.logAt

  return isLive(active.status) && active.status !== 'waiting' && still >= STALL_MS ? still : null
}

type AlertKind = 'done' | 'dead' | 'stalled'
type Phase = AlertKind | 'live' | 'stopped' | 'pending'

// `pending` until the band first measured a running job: its files may show it ended long ago.
function phaseOf(runner: Runner, now: number): Phase {
  if (runner.endedAt === null && runner.progress === undefined) {
    return 'pending'
  }
  const label = runnerState(runner, now).label
  if (label === '✓ done') {
    return 'done'
  }
  if (label === '✕ died') {
    return 'dead'
  }
  if (label === '⚠ stuck?') {
    return 'stalled'
  }

  return label === '■ stopped' ? 'stopped' : 'live'
}

// A change worth a toast: done or dead after live or stalled, stalled after live.
function isNews(before: string | undefined, now: Phase): now is AlertKind {
  if (now === 'done' || now === 'dead') {
    return before === 'live' || before === 'stalled'
  }

  return now === 'stalled' && before === 'live'
}

// News since the last look: a runner done, dead or stalled is announced once,
// in a toast in every session and with one sound per machine.
async function checkAlerts($: EngineInterface): Promise<void> {
  try {
    const now = await $.clock.now()
    const here = await $.session.id()
    const seen = [
      ...(await read($, runners)).map(runner => ({ key: `${here}:${runner.id}`, runner })),
      ...(await read($, otherSessions)).flatMap(entry => entry.runners.map(runner => ({ key: `${entry.sessionId}:${runner.id}`, runner }))),
    ]
    const before = await read($, alerted)
    const phases: Record<string, string> = {}
    const news: Array<{ key: string; runner: Runner; kind: AlertKind }> = []
    for (const { key, runner } of seen) {
      const phase = phaseOf(runner, now)
      phases[key] = phase
      if (isNews(before[key], phase)) {
        news.push({ key, runner, kind: phase })
      }
    }
    await update($, alerted, () => phases)
    if (!(await read($, isOn))) {
      return
    }
    for (const item of news) {
      await announce($, item.key, item.runner, item.kind, now)
    }
  } catch (error) {
    $.ui.log(`context-band: could not check the runners for news: ${messageOf(error)}`, { to: 'debug' })
  }
}

async function announce($: EngineInterface, key: string, runner: Runner, kind: AlertKind, now: number): Promise<void> {
  const title = runner.info?.title ?? runner.description
  const still = stalledFor(runner, now)
  const text =
    kind === 'done'
      ? `✓ ${title}: done`
      : kind === 'dead'
        ? `✕ ${title}: died`
        : `⚠ ${title}: log still for ${minutes(Math.round((still ?? STALL_MS) / 60_000))}`
  await $.ui.toast(text)
  const settings = await soundSettings($)
  if ((settings.sounds || settings.voice) && (await claimSound($, `${key}:${kind}`, now))) {
    try {
      if (settings.sounds) {
        await $.audio.play({ asset: SOUNDS[kind] })
      }
      if (settings.voice) {
        await $.audio.speak(text.replace(/^[✓✕⚠]\s*/, ''))
      }
    } catch (error) {
      $.ui.log(`context-band: could not sound the ${kind} news: ${messageOf(error)}`, { to: 'debug' })
    }
  }
}

// The family's sound settings, as the mods panel keeps them: sounds on, voice off, unless set.
async function soundSettings($: EngineInterface): Promise<{ sounds: boolean; voice: boolean }> {
  try {
    const home = await $.env.get('HOME')
    const path = `${(home ?? '').replace(/\/$/, '')}/${SWITCHES_FILE}`
    if (home === undefined || home === '' || !(await $.fs.exists(path))) {
      return { sounds: true, voice: false }
    }
    const data = JSON.parse(await readText($, path)) as { settings?: { sounds?: unknown; voice?: unknown } }

    return { sounds: data.settings?.sounds !== false, voice: data.settings?.voice === true }
  } catch {
    return { sounds: true, voice: false }
  }
}

// True for the one session that writes the event into the ledger first.
async function claimSound($: EngineInterface, event: string, now: number): Promise<boolean> {
  const home = await $.env.get('HOME')
  if (home === undefined || home === '') {
    return false
  }
  const path = `${home.replace(/\/$/, '')}/${ALERTS_LEDGER}`
  let ledger: Record<string, number> = {}
  if (await $.fs.exists(path)) {
    try {
      const data: unknown = JSON.parse(await readText($, path))
      if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
        ledger = data as Record<string, number>
      }
    } catch {
      ledger = {}
    }
  }
  if (typeof ledger[event] === 'number') {
    return false
  }
  const kept = Object.fromEntries(Object.entries(ledger).filter(([, at]) => typeof at === 'number' && now - at < LEDGER_KEEP_MS))
  await $.fs.write(path, JSON.stringify({ ...kept, [event]: now }))

  return true
}

// The dim lines under a runner's title: how far it got and its status word,
// the last log line when nothing counts, then its task, kind, age and chain.
function runnerNotes(runner: Runner, now: number): string[] {
  const word = statusWord(runner)
  const progress = [runner.endedAt === null ? progressText(runner) : '', word === null ? '' : `status ${word}`]
    .filter(Boolean)
    .join(' · ')
  const logLine = logLineShown(runner)

  return [progress, logLine === null ? '' : `log: ${logLine}`, runnerSubline(runner, now), ...chainTree(runner)].filter(Boolean)
}

// For which task, what kind and how long.
function runnerSubline(runner: Runner, now: number): string {
  const when = runner.endedAt === null ? age(now - runner.seenAt) : null
  const forTask = runner.info?.forTask ?? null

  return [forTask === null ? null : `for task: ${forTask}`, [kindOf(runner.type), when].filter(Boolean).join(' ')]
    .filter(Boolean)
    .join(' · ')
}

// The jobs a watcher walks through, in run order, as a small tree.
function chainTree(runner: Runner): string[] {
  const targets = runner.progress?.targets ?? []
  if (targets.length < 2) {
    return []
  }
  const ordered = inRunOrder(targets)

  return ordered.map((target, index) => `${index === ordered.length - 1 ? '└' : '├'} ${target.name} ${target.status}`)
}

type ListedRunner = { runner: Runner; key: string; scope: string; where: string }

// Every session's work in one list, the most urgent first: dead, stalled,
// running, waiting, then what finished; oldest first within a kind.
function listRunners(mine: readonly Runner[], others: readonly SessionEntry[], now: number): ListedRunner[] {
  const listed: ListedRunner[] = [
    ...mine.map(runner => ({ runner, key: `here:${runner.id}`, scope: `context-band:runner:${runner.id}`, where: '' })),
    ...others.flatMap(entry =>
      entry.runners
        .filter(runner => runner.endedAt === null)
        .map(runner => ({
          runner,
          key: `${entry.sessionId}:${runner.id}`,
          scope: `context-band:runner:${entry.sessionId.slice(0, 8)}:${runner.id}`.slice(0, 64),
          where: sessionLabel(entry),
        })),
    ),
  ]
  const rank = (runner: Runner) => {
    const label = runnerState(runner, now).label
    const order = ['✕ died', '⚠ stuck?', '● running', '◌ waiting', '◌ queued']
    const at = order.indexOf(label)

    return at === -1 ? order.length : at
  }

  return listed.sort((a, b) => rank(a.runner) - rank(b.runner) || a.runner.seenAt - b.runner.seenAt)
}

function isFinished(runner: Runner, now: number): boolean {
  const label = runnerState(runner, now).label

  return runner.endedAt !== null || label === '✓ done'
}

// Twenty cells over the last four hours: filled while the job was alive.
function timeline(runner: Runner, now: number): string {
  const cell = TIMELINE_MS / GRID_BAR
  const from = now - TIMELINE_MS
  const end = runner.endedAt ?? now

  return Array.from({ length: GRID_BAR }, (_, index) => {
    const cellStart = from + index * cell
    const cellEnd = cellStart + cell

    return runner.seenAt < cellEnd && end >= cellStart ? '█' : '░'
  }).join('')
}

// Where a runner's log is: what the model named, else the first log its command writes.
function logPathOf(runner: Runner): string | null {
  if (runner.info?.log !== undefined && runner.info.log !== null) {
    return runner.info.log
  }

  return runner.detail === null ? null : (pathsInCommand(runner.detail).logs[0] ?? null)
}

function kindOf(type: string): string {
  if (type.includes('bash') || type === 'shell') {
    return 'shell'
  }
  if (type.includes('agent')) {
    return 'agent'
  }
  if (type.includes('workflow')) {
    return 'workflow'
  }
  if (type.includes('monitor')) {
    return 'monitor'
  }

  return type
}

function runnersSummary(mine: readonly Runner[], others: readonly SessionEntry[], now: number): string {
  const live = [
    ...mine.filter(runner => runner.endedAt === null),
    ...others.flatMap(entry => entry.runners.filter(runner => runner.endedAt === null)),
  ]
  if (live.length === 0) {
    return mine.length === 0 ? 'no background work in any session' : 'nothing running now'
  }
  const waiting = live.filter(runner => runnerState(runner, now).label === '◌ waiting').length
  const counts = [`${live.length} running`]
  if (waiting > 0) {
    counts.push(`${waiting} of them waiting`)
  }

  return `${counts.join(', ')} · all sessions`
}

function minutes(count: number): string {
  if (count < 60) {
    return `${count}m`
  }

  return `${Math.floor(count / 60)}h${String(count % 60).padStart(2, '0')}m`
}

function describeTask(listed: TaskSnapshot): Pick<Runner, 'type' | 'status' | 'description' | 'detail'> {
  const said = listed.description.trim()
  const how =
    listed.command ??
    (listed.agent_type !== undefined ? `agent: ${listed.agent_type}` : undefined) ??
    (listed.name !== undefined ? `workflow: ${listed.name}` : undefined) ??
    (listed.server !== undefined ? [listed.server, listed.tool].filter(Boolean).join(' / ') : undefined)

  return {
    type: listed.type,
    status: listed.status,
    description: said || how || listed.id,
    detail: how ?? null,
  }
}

function isEnded(status: string): boolean {
  return ENDED_STATUSES.has(status)
}

// Every running piece of work, and the most recent finished ones.
function keepRecent(list: readonly Runner[]): Runner[] {
  const active = list.filter(runner => runner.endedAt === null)
  const ended = list
    .filter(runner => runner.endedAt !== null)
    .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
    .slice(0, KEPT_FINISHED_RUNNERS)

  return [...active, ...ended]
}

// Running work first, oldest first; then what finished, newest first.
function orderRunners(list: readonly Runner[]): Runner[] {
  const active = list.filter(runner => runner.endedAt === null).sort((a, b) => a.seenAt - b.seenAt)
  const ended = list
    .filter(runner => runner.endedAt !== null)
    .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))

  return [...active, ...ended]
}

function runnerColor(runner: Runner): ThemeKey {
  if (runner.endedAt === null) {
    return runner.status === 'pending' ? 'warning' : 'suggestion'
  }

  return runner.status === 'failed' || runner.status === 'killed' ? 'error' : 'subtle'
}

// How long a piece of work has run: 45s, 12m, 2h05m.
function age(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) {
    return `${seconds}s`
  }
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) {
    return `${minutes}m`
  }

  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`
}

// The first line of a typed prompt, cut at a word to fit; none for a turn
// without one (a continuation) or for engine text (a tag-led notification).
// A prompt's first line, kept short: what the session was asked, for the other sessions' lists.
function promptGist(text: string): string | null {
  const line = text
    .split('\n')
    .map(part => part.trim())
    .find(part => part !== '')

  return line === undefined ? null : clipped(line, GIST_CHARS)
}

// What an answer comes to for someone glancing from another session: the
// question it ends on, else the first sentence of its prose (a heading is a
// title, not the answer), without markdown's marks.
function answerGist(text: string): string | null {
  const lines = proseLines(text)
  const last = lines[lines.length - 1]
  if (last === undefined) {
    return null
  }
  const prose = lines.find(line => !/^\s*#{1,6}\s/.test(line)) ?? last

  return clipped(/\?\s*$/.test(plainLine(last)) ? plainLine(last) : firstSentence(plainLine(prose)), GIST_CHARS)
}

// The lines of a text that read as words: none inside a code fence, none empty.
function proseLines(text: string): string[] {
  const kept: string[] = []
  let isInFence = false
  for (const line of text.split('\n')) {
    if (line.trim().startsWith('```')) {
      isInFence = !isInFence
      continue
    }
    if (!isInFence && plainLine(line) !== '') {
      kept.push(line)
    }
  }

  return kept
}

// A line as read, not as written: no heading, quote or list marks, no emphasis
// or code ticks, a link as its text; a fence or a table row is no line.
function plainLine(line: string): string {
  const trimmed = line.trim()
  if (trimmed.startsWith('```') || trimmed.startsWith('|')) {
    return ''
  }

  return trimmed
    .replace(/^(#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/, '')
    .replace(/\*\*|__|`/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .trim()
}

function firstSentence(line: string): string {
  const end = line.search(/[.!?](\s|$)/)

  return end < 0 ? line : line.slice(0, end + 1)
}

// At most `chars` characters, cut at a word and marked as cut.
function clipped(text: string, chars: number): string {
  if (text.length <= chars) {
    return text
  }
  const cut = text.slice(0, chars)
  const space = cut.lastIndexOf(' ')

  return `${(space > chars / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:·-]+$/, '')}…`
}

function autoTitle(text: string): string | null {
  const firstLine = text.trim().split('\n')[0]?.replace(/\s+/g, ' ').trim() ?? ''
  if (firstLine === '' || firstLine.startsWith('<')) {
    return null
  }
  if (firstLine.length <= AUTO_TITLE_MAX_CHARS) {
    return firstLine
  }
  const cut = firstLine.slice(0, AUTO_TITLE_MAX_CHARS + 1)
  const atWord = cut.lastIndexOf(' ')

  return (atWord > 0 ? cut.slice(0, atWord) : cut.slice(0, AUTO_TITLE_MAX_CHARS)).replace(/[\s,.;:-]+$/, '')
}

function stringField(value: unknown, key: string): string | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined
  }
  const field: unknown = (value as Record<string, unknown>)[key]

  return typeof field === 'string' ? field : undefined
}

// What the band shows, as lines of text to read or copy.
async function bandInWords($: EngineInterface): Promise<string> {
  const last = await read($, fill)
  const current = await read($, task)
  const now = await $.clock.now()
  const mine = await read($, runners)
  const live = mine.filter(runner => runner.endedAt === null)
  const lines = [
    last === null ? 'Context: not measured yet' : `Context ${last.percent === null ? '-' : `${last.isEstimate ? '~' : ''}${last.percent}%`} (${kilo(last.tokens)} of ${kilo(last.window)})`,
    current === null ? 'Task: none' : `Task ${current.percent}%: ${current.title}${taskNote(current, now).length === 0 ? '' : ` (${taskNote(current, now).join(', ')})`}`,
    `This session's runners: ${live.length === 0 ? 'nothing running' : live.map(runner => `${runnerState(runner, now).label} ${runner.info?.title ?? runner.description}`).join('; ')}`,
  ]

  return lines.join('\n')
}

// The `button` of each mod card under ~/.claude/skills: a key, a label, and what to count beside it.
async function readSectionButtons($: EngineInterface): Promise<void> {
  try {
    const home = await $.env.get('HOME')
    if (home === undefined || home === '') {
      return
    }
    const dir = `${home.replace(/\/$/, '')}/${SKILLS_DIR}`
    if (!(await $.fs.exists(dir))) {
      return
    }
    const found: SectionButton[] = []
    for (const entry of await $.fs.list(dir)) {
      const card = `${dir}/${entry.name}/mod.json`
      const manifest = `${dir}/${entry.name}/.claude-plugin/plugin.json`
      if ((entry.kind !== 'dir' && !entry.isLink) || !(await $.fs.exists(card)) || !(await $.fs.exists(manifest))) {
        continue
      }
      const data = JSON.parse(await readText($, card)) as { order?: unknown; button?: { key?: unknown; label?: unknown; count?: unknown } }
      const named = JSON.parse(await readText($, manifest)) as { name?: unknown }
      const button = data.button
      if (button === undefined || typeof button.key !== 'string' || typeof button.label !== 'string' || typeof named.name !== 'string') {
        continue
      }
      found.push({
        mod: named.name,
        key: button.key,
        label: button.label,
        order: typeof data.order === 'number' ? data.order : 99,
        count: button.count === 'sessions' ? 'sessions' : null,
      })
    }
    found.sort((a, b) => a.order - b.order)
    if (JSON.stringify(found) !== JSON.stringify(await read($, sectionButtons))) {
      await update($, sectionButtons, () => found)
    }
  } catch (error) {
    $.ui.log(`context-band: could not read the mod cards: ${messageOf(error)}`, { to: 'debug' })
  }
}

// Another mod's section: the band closes its own and marks the button; the mod answers the press.
async function pressSection($: EngineInterface, key: string): Promise<void> {
  await update($, isExpanded, () => false)
  await update($, isRunnersOpen, () => false)
  await update($, openSection, current => (current === key ? null : key))
}

async function toggleRunner($: EngineInterface, key: string): Promise<void> {
  await update($, expandedRunner, current => (current === key ? null : key))
}

async function toggleRunnerView($: EngineInterface): Promise<void> {
  await update($, runnerView, current => (current === 'timeline' ? 'progress' : 'timeline'))
}

async function showAllRunners($: EngineInterface): Promise<void> {
  await update($, isShowingAllRunners, () => true)
}

async function toggleDoneRunners($: EngineInterface): Promise<void> {
  await update($, isShowingDoneRunners, isShown => !isShown)
}

async function copyText($: EngineInterface, text: string): Promise<void> {
  const copied = await $.ui.copy({ text })
  await $.ui.toast(copied.isCopied ? 'Copied' : `Not copied: ${copied.reason}`)
}

// One sentence from a small model on what the job does and where it stands: it spends a little of the subscription.
async function explainRunner($: EngineInterface, key: string, runner: Runner): Promise<void> {
  if ((await read($, explaining)) !== null) {
    return
  }
  await update($, explaining, () => key)
  try {
    const prompt = [
      'In one short English sentence of at most 20 words, say what this background job does and where it stands now.',
      'Name it plainly for a developer; no preamble.',
      `Title: ${runner.info?.title ?? runner.description}`,
      `Command: ${runner.detail ?? 'unknown'}`,
      `Last log lines:\n${logTail(runner).join('\n') || 'none'}`,
    ].join('\n')
    const reply = await $.model.complete({ model: EXPLAIN_MODEL, prompt, maxTokens: 120 })
    const text = reply.isAnswered ? reply.text.trim() : `could not explain (${reply.reason})`
    await update($, explanations, all => ({ ...all, [key]: text }))
  } catch (error) {
    await update($, explanations, all => ({ ...all, [key]: `could not explain: ${messageOf(error)}` }))
  } finally {
    await update($, explaining, () => null)
  }
}

// The mods panel (mod 0) answers its own button; the band's sections make way for it.
async function closeSections($: EngineInterface): Promise<void> {
  await update($, isExpanded, () => false)
  await update($, isRunnersOpen, () => false)
  await update($, openSection, () => null)
}

async function toggleDetails($: EngineInterface): Promise<void> {
  const expanded = await update($, isExpanded, open => !open)
  await update($, openSection, () => null)
  if (expanded) {
    await update($, isRunnersOpen, () => false)
    await refreshBreakdown($)
  }
}

// The window as /context counts it, estimated locally: no request is sent.
async function refreshBreakdown($: EngineInterface): Promise<SessionContextBreakdown | undefined> {
  const { context } = await $.session.usage({ breakdown: 'summary' })
  if (context.breakdown !== undefined) {
    const latest = summarize(context.breakdown)
    const at = await $.clock.now()
    await update($, breakdown, () => latest)
    await update($, breakdownAt, () => at)
  }

  return context.breakdown
}

// The Compact button runs /compact as if the person typed it. $.session.compact
// is not available where the session is headless (the desktop app, the SDK);
// /compact runs in every session, as a turn of its own where it is headless.
async function compactNow($: EngineInterface): Promise<void> {
  let wasCompacting = false
  await update($, isCompacting, previous => {
    wasCompacting = previous
    return true
  })
  if (wasCompacting) {
    return
  }
  let said: string | undefined
  try {
    said = (await $.command.run({ command: 'compact' })).text
  } catch (error) {
    await $.ui.toast(`Compact failed: ${messageOf(error)}`)
    return
  } finally {
    await update($, isCompacting, () => false)
  }
  await followCompaction($, said)
}

// The engine runs no hook of this plugin for a run the plugin started itself,
// so the band follows the compaction here. When nothing was compacted, the
// command's own output says why.
async function followCompaction($: EngineInterface, said: string | undefined): Promise<void> {
  const live = await $.session.usage()
  if (live.context.tokens === undefined) {
    const shown = await read($, fill)
    if (shown !== null && shown.tokens !== null && !shown.isEstimate) {
      await afterMainCompaction($)
    }
    return
  }
  if (said !== undefined && said !== '') {
    await $.ui.toast(`Compact: ${said}`)
  }
}

// A compacted conversation has no measured fill until its next model response:
// blank the figure now, then show the engine's local estimate, marked "~",
// once the compacted conversation is in place. The tool results counted so
// far were summarized away with the rest.
async function afterMainCompaction($: EngineInterface): Promise<void> {
  await update($, fill, last =>
    last === null ? null : { ...last, tokens: null, percent: null, isEstimate: false },
  )
  await update($, toolShares, () => [])
  scheduleEstimate($, 1)
}

function scheduleEstimate($: EngineInterface, attempt: number): void {
  $.clock.after(ESTIMATE_RETRY_MS, () => {
    estimateCompacted($)
      .then(isSettled => {
        if (!isSettled && attempt < ESTIMATE_ATTEMPTS) {
          scheduleEstimate($, attempt + 1)
        }
      })
      .catch(error => {
        $.ui.log(`context-band: no estimate after the compaction: ${messageOf(error)}`)
      })
  })
}

// Settled once the band shows a figure for the compacted conversation: this
// estimate, or a measured one that arrived first.
async function estimateCompacted($: EngineInterface): Promise<boolean> {
  const shown = await read($, fill)
  if (shown === null || shown.tokens !== null) {
    return true
  }
  // Until the compacted conversation is in place, the live figure is still the old one.
  const live = await $.session.usage()
  if (live.context.tokens !== undefined) {
    return false
  }
  const counted = await refreshBreakdown($)
  if (counted === undefined) {
    return true
  }
  const estimate = counted.totalTokens
  const percent = percentOf(estimate, shown.window)
  await update($, fill, last =>
    last === null || last.tokens !== null
      ? last
      : { ...last, tokens: estimate, percent, isEstimate: true },
  )
  await warnOnClimb($, percent)

  return true
}

// A measurement without a fill (the compacted window has not answered yet)
// keeps the estimate on show instead of blanking it. One that loses a measured
// fill means the conversation was compacted without the band's hook seeing it:
// a /compact turn of a headless session, say. The band then estimates it.
async function record($: EngineInterface, measured: Fill): Promise<void> {
  const before = await read($, fill)
  await update($, fill, last =>
    measured.tokens === null && last?.isEstimate === true
      ? { ...last, window: measured.window }
      : measured,
  )
  await warnOnClimb($, measured.percent)
  const isUnseenCompaction =
    measured.tokens === null && before !== null && before.tokens !== null && !before.isEstimate
  if (isUnseenCompaction) {
    await update($, toolShares, () => [])
    scheduleEstimate($, 1)
  }
}

async function recordStep($: EngineInterface, usage: TurnUsage): Promise<void> {
  const tokens =
    usage.input_tokens + usage.cache_creation_input_tokens + usage.cache_read_input_tokens
  const known = await read($, fill)
  const window = known?.window ?? (await $.session.usage()).context.window
  const percent = percentOf(tokens, window)
  await update($, fill, () => ({ tokens, window, percent, isEstimate: false }))
  await warnOnClimb($, percent)
}

async function addToolShare($: EngineInterface, tool: string, reply: ToolReply): Promise<void> {
  const name = toolLabel(tool)
  const chars = replyChars(reply)
  await update($, toolShares, shares => {
    const found = shares.find(share => share.tool === name)
    const others = shares.filter(share => share.tool !== name)

    return [...others, { tool: name, calls: (found?.calls ?? 0) + 1, chars: (found?.chars ?? 0) + chars }]
  })
}

// What the model reads for the call: the result's text, or the refusal, and
// any reminder a hook attached. Images are not counted.
function replyChars(reply: ToolReply): number {
  const shown = reply.deny ?? reply.text ?? ''
  const reminders = (reply.context ?? []).reduce((sum, line) => sum + line.length, 0)

  return shown.length + reminders
}

// MCP tools are grouped by their server.
function toolLabel(tool: string): string {
  const mcp = /^mcp__(.+?)__/.exec(tool)

  return mcp?.[1] === undefined ? tool : `mcp:${mcp[1]}`
}

function fromContext(context: SessionContextUsage): Fill {
  return {
    tokens: context.tokens ?? null,
    window: context.window,
    percent: context.percent ?? null,
    isEstimate: false,
  }
}

function summarize(counted: SessionContextBreakdown): Breakdown {
  const servers = new Map<string, ServerShare>()
  let deferredMcpTools = 0
  for (const tool of counted.mcpTools) {
    if (!tool.isLoaded) {
      deferredMcpTools += 1
      continue
    }
    const server = servers.get(tool.serverName) ?? { name: tool.serverName, tools: 0, tokens: 0 }
    servers.set(tool.serverName, { ...server, tools: server.tools + 1, tokens: server.tokens + tool.tokens })
  }
  const categories: CategoryShare[] = counted.categories
    .filter(category => category.tokens > 0)
    .map(category => ({
      name: category.name,
      tokens: category.tokens,
      kind: category.kind,
      color: category.color,
    }))

  return {
    maxTokens: counted.maxTokens,
    autoCompactAt: counted.autoCompactThreshold ?? null,
    categories,
    memoryFiles: largest(
      counted.memoryFiles.map(file => ({ name: `${file.type} ${baseName(file.path)}`, tokens: file.tokens })),
    ),
    mcpServers: largest([...servers.values()]),
    deferredMcpTools,
    skills:
      counted.skills === undefined
        ? null
        : {
            listed: counted.skills.includedSkills,
            total: counted.skills.totalSkills,
            tokens: counted.skills.tokens,
          },
    agents: {
      count: counted.agents.length,
      tokens: counted.agents.reduce((sum, agent) => sum + agent.tokens, 0),
    },
  }
}

function categoryRows(details: Breakdown): CategoryRow[] {
  return [...details.categories]
    .sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || b.tokens - a.tokens)
    .map(category => ({
      name: CATEGORY_NAMES[category.name] ?? category.name,
      tokens: category.tokens,
      percent: category.kind === 'deferred' ? null : percentOf(category.tokens, details.maxTokens),
      color: category.color,
      isDim: category.kind !== 'used',
    }))
}

function detailLines(details: Breakdown, shares: readonly ToolShare[]): Array<{ name: string; text: string }> {
  const lines: Array<{ name: string; text: string }> = []
  if (details.memoryFiles.length > 0) {
    lines.push({ name: 'Files', text: details.memoryFiles.map(file => `${file.name} ${kilo(file.tokens)}`).join(' · ') })
  }
  const servers = details.mcpServers.map(
    server => `${server.name} ${kilo(server.tokens)} (${server.tools} ${plural(server.tools, 'tool', 'tools')})`,
  )
  if (details.deferredMcpTools > 0) {
    const count = details.deferredMcpTools
    servers.push(`${count} more ${plural(count, 'tool', 'tools')} on demand`)
  }
  if (servers.length > 0) {
    lines.push({ name: 'MCP servers', text: servers.join(' · ') })
  }
  if (details.skills !== null) {
    const { listed, total, tokens } = details.skills
    lines.push({ name: 'Skills', text: `${listed} of ${total} listed, ${kilo(tokens)}` })
  }
  if (details.agents.count > 0) {
    lines.push({ name: 'Agents', text: `${details.agents.count}, ${kilo(details.agents.tokens)}` })
  }
  lines.push({ name: 'Tools', text: toolLine(shares) })
  if (details.autoCompactAt !== null) {
    lines.push({ name: 'Auto-compact', text: `at ${kilo(details.autoCompactAt)} of ${kilo(details.maxTokens)}` })
  }

  return lines
}

// The share of the conversation the mod counted itself: the engine does not split it.
function toolLine(shares: readonly ToolShare[]): string {
  if (shares.length === 0) {
    return 'no tool results in this conversation yet'
  }
  const total = shares.reduce((sum, share) => sum + share.chars, 0)
  const top = [...shares]
    .sort((a, b) => b.chars - a.chars)
    .slice(0, TOP_ITEMS)
    .map(share => `${share.tool} ${kilo(tokensIn(share.chars))} ×${share.calls}`)

  return `results ≈${kilo(tokensIn(total))}: ${top.join(' · ')}`
}

function largest<T extends { tokens: number }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => b.tokens - a.tokens).slice(0, TOP_ITEMS)
}

function tokensIn(chars: number): number {
  return Math.round(chars / CHARS_PER_TOKEN)
}

function baseName(path: string): string {
  return path.split('/').pop() ?? path
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many
}

// One toast each time the fill climbs past a level; falling back below it
// (a compaction, /clear) re-arms that level.
async function warnOnClimb($: EngineInterface, percent: number | null): Promise<void> {
  if (percent === null) {
    return
  }
  const level = WARN_LEVELS.find(at => percent >= at) ?? 0
  const before = await read($, warnedAt)
  if (level === before) {
    return
  }
  await update($, warnedAt, () => level)
  if (level > before && (await read($, isOn))) {
    await $.ui.toast(`Context ${percent}% full`)
  }
}

function percentOf(tokens: number, window: number): number | null {
  if (window <= 0) {
    return null
  }

  return Math.min(100, Math.round((tokens / window) * 100))
}

// The line under the task's title: the checklist and its count, what runs now, and the time left.
function taskNote(current: Task, now: number): string[] {
  if (current.percent >= 100) {
    const spent = current.startedAt === undefined ? 0 : now - current.startedAt
    const took = spent >= 60_000 ? ` in ${minutes(Math.round(spent / 60_000))}` : ''

    return [`done${took}`]
  }
  if (current.isAuto) {
    return ['estimating']
  }
  const plan = current.steps ?? []
  const active = plan.find(step => step.status === 'active')
  const left = timeLeft(current, now)
  const parts = [
    plan.length === 0 ? '' : `${checklist(plan)} ${plan.filter(step => step.status === 'done').length}/${plan.length}`,
    current.step ?? active?.title ?? '',
    left === null ? '' : `~${minutes(left)} left`,
  ].filter(Boolean)

  return parts.length === 0 ? [] : [parts.join(' · ')]
}

type PlanInput = { title: string; status: PlanStep['status'] }

function planIn(value: unknown): PlanInput[] | null {
  if (!Array.isArray(value)) {
    return null
  }

  return value.flatMap(item => {
    const step = item as { title?: unknown; status?: unknown }
    const title = typeof step.title === 'string' ? step.title.trim() : ''
    const status = step.status === 'done' || step.status === 'active' || step.status === 'todo' ? step.status : null

    return title === '' || status === null ? [] : [{ title, status }]
  })
}

// Done steps count whole, the active one half.
function planPercent(plan: readonly PlanInput[]): number {
  const done = plan.filter(step => step.status === 'done').length
  const active = plan.filter(step => step.status === 'active').length

  return Math.round(((done + active / 2) / plan.length) * 100)
}

// The plan as given, each step keeping when the band first saw it running and done.
function timedPlan(before: readonly PlanStep[], given: readonly PlanInput[], now: number): PlanStep[] {
  return given.map(step => {
    const known = before.find(old => old.title === step.title)
    const startedAt = known?.startedAt ?? (step.status === 'todo' ? null : now)
    const doneAt = step.status === 'done' ? (known?.doneAt ?? now) : null

    return { title: step.title, status: step.status, startedAt, doneAt }
  })
}

function checklist(plan: readonly PlanStep[]): string {
  const glyphs = plan.map(step => (step.status === 'done' ? '✓' : step.status === 'active' ? '▶' : '○'))

  return glyphs.length <= PLAN_GLYPHS ? glyphs.join('') : `${glyphs.slice(0, PLAN_GLYPHS).join('')}+${glyphs.length - PLAN_GLYPHS}`
}

// Minutes left: from the steps' own times when some finished, else from the estimates' pace.
function timeLeft(current: Task, now: number): number | null {
  const plan = current.steps ?? []
  const timed = plan.filter(step => step.startedAt !== null && step.doneAt !== null && step.doneAt > step.startedAt)
  if (timed.length > 0) {
    const perStep = timed.reduce((sum, step) => sum + ((step.doneAt ?? 0) - (step.startedAt ?? 0)), 0) / timed.length
    const remaining = plan.filter(step => step.status === 'todo').length + plan.filter(step => step.status === 'active').length / 2

    return remaining === 0 ? null : Math.max(1, Math.round((perStep * remaining) / 60_000))
  }
  const samples = current.samples ?? []
  const first = samples[0]
  const last = samples[samples.length - 1]
  if (first === undefined || last === undefined || last.at - first.at < PACE_MIN_MS || last.percent <= first.percent) {
    return null
  }
  const perPercent = (last.at - first.at) / (last.percent - first.percent)

  return Math.max(1, Math.round(((100 - last.percent) * perPercent) / 60_000))
}

// What a pointer on the task reveals: each step and how long it took or has run.
function stepTimes(current: Task, now: number): string[] {
  return (current.steps ?? []).map(step => {
    const mark = step.status === 'done' ? '✓' : step.status === 'active' ? '▶' : '○'
    const end = step.status === 'done' ? step.doneAt : step.status === 'active' ? now : null
    const took =
      step.startedAt === null || end === null || end <= step.startedAt ? '' : ` · ${minutes(Math.max(1, Math.round((end - step.startedAt) / 60_000)))}`

    return `${mark} ${step.title}${took}`
  })
}

function colorOf(percent: number | null): ThemeKey {
  if (percent === null) {
    return 'subtle'
  }
  if (percent >= 80) {
    return 'error'
  }
  if (percent >= 60) {
    return 'warning'
  }

  return 'success'
}

// Amber while the task is young, blue past halfway, green once it is done.
function progressColor(percent: number): ThemeKey {
  if (percent >= 100) {
    return 'success'
  }
  if (percent >= 50) {
    return 'suggestion'
  }

  return 'warning'
}

// Tokens for people: 950, 4.2k, 124k, 1M.
function kilo(tokens: number | null): string {
  if (tokens === null) {
    return '-'
  }
  if (tokens >= 1_000_000) {
    return `${trimZero((tokens / 1_000_000).toFixed(1))}M`
  }
  if (tokens >= 10_000) {
    return `${Math.round(tokens / 1_000)}k`
  }
  if (tokens >= 1_000) {
    return `${trimZero((tokens / 1_000).toFixed(1))}k`
  }

  return String(tokens)
}

function trimZero(fixed: string): string {
  return fixed.replace(/\.0$/, '')
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// Where a row's piece goes in the band: chips first, then meters, then sections, each by the
// mod's order number in its key (`meter:03:mod-forecast`). A row with no such piece has none.
const PIECE_RANK = { chip: 0, meter: 1, section: 2 } as const
function pieceRank(node: unknown, depth = 0): number | undefined {
  const key = keyOf(node)
  const found = key === undefined ? null : /^(chip|meter|section):(\d+):/.exec(key)
  if (found) return PIECE_RANK[found[1] as keyof typeof PIECE_RANK] * 1_000 + Number(found[2])
  const children = (node as TreeNode | null)?.children
  if (depth >= 3 || !Array.isArray(children)) return undefined
  for (const child of children) {
    const rank = pieceRank(child, depth + 1)
    if (rank !== undefined) return rank
  }

  return undefined
}

// ---- band layout (shared block) ----
// The engine runs the family's band hooks in an order no mod controls, so the
// band (context-band) draws two keyed slots wherever it stands: METERS_SLOT
// under its context row and SECTIONS_SLOT above its task row. A mod that finds
// the band in what lies beneath it puts its piece into the slot; one that does
// not stacks the piece around it, and the band, when it stands outside, moves
// the stacked pieces into its slots. Pieces are keyed `meter:NN:<mod>` or
// `section:NN:<mod>` (NN the mod's order), and a slot keeps them in key order.
// CHIPS_SLOT, first in the middle, is one line of the readings at rest, each a
// chip keyed `chip:NN:<mod>`; a reading's card, shown while the pointer is on
// its chip, waits hidden in METERS_SLOT (placeReadings puts both).
// When the person set the band's height, the slots sit in a middle keyed
// `FIT_PREFIX<rows>` that keeps to that many rows: a piece put in refits it,
// what runs past the end leaves from the bottom, a note keyed
// `NOTE_PREFIX<rows out>` says how many rows are out, and blank rows fill the rest.
// The note is a button keyed SHOW_ALL_KEY whoever draws it: the band hears its
// press and gives the height back to auto.
// This block is pasted unchanged into each mod that draws in the band.
const CHIPS_SLOT = 'context-band:chips'
const METERS_SLOT = 'context-band:meters'
const SECTIONS_SLOT = 'context-band:sections'
const FIT_PREFIX = 'context-band:fit:'
const NOTE_PREFIX = 'context-band:note:'
const PAD_KEY = 'context-band:pad'
const SHOW_ALL_KEY = 'band-show-all'
// Cells between two chips on their line.
const CHIP_GAP = 2
// A blank row: a space no surface collapses.
const BLANK_ROW = ' '
// About the pixels of a row where a surface draws an Svg (the desktop's line).
const SVG_ROW_PIXELS = 20

type TreeNode = { type?: unknown; key?: unknown; props?: Record<string, unknown>; children?: unknown[] }

function keyOf(node: unknown): string | undefined {
  if (typeof node !== 'object' || node === null) {
    return undefined
  }
  const tree = node as TreeNode
  const key = tree.key ?? tree.props?.key

  return typeof key === 'string' ? key : undefined
}

function pieceKey(kind: 'chip' | 'meter' | 'section', order: number, mod: string): string {
  return `${kind}:${String(order).padStart(2, '0')}:${mod}`
}

// Puts `piece` into the band's slot when the band lies beneath; else stacks it
// above (a chip or a meter) or below (a section) what lies beneath. `columns` is the
// band's width (`bodyColumns`), what a refit wraps the rows in.
function placeInBand(ui: ElementTable, inner: RenderElement, slot: string, piece: RenderElement, columns: number): RenderElement {
  const placed = insertInto(ui, inner, slot, piece, columns)
  if (placed !== null) {
    return placed as RenderElement
  }
  const { Box } = ui

  return slot === SECTIONS_SLOT ? (
    <Box flexDirection="column">
      {inner}
      {piece}
    </Box>
  ) : (
    <Box flexDirection="column">
      {piece}
      {inner}
    </Box>
  )
}

// A meter mod's readings in the band: each one a chip on the band's one line of
// figures, its tone saying when it needs a look. A chip with more to say has a
// card, drawn hidden in METERS_SLOT and shown while the pointer is on the chip:
// the reading's row without a bar. No reading grows into a row with a bar.
type BandReading = { row: GridRow; chip: GridChip; needsLook: boolean }

function placeReadings(
  ui: ElementTable,
  inner: RenderElement,
  readings: readonly BandReading[],
  order: number,
  mod: string,
  columns: number,
): RenderElement {
  const { Box } = ui
  if (readings.length === 0) {
    return inner
  }
  // A chip and its card share a hover group, one per reading across the family.
  const scopeOf = (reading: BandReading) => `${mod}:${reading.chip.name}`.slice(0, 64)
  const chips = (
    <Box key={pieceKey('chip', order, mod)} columnGap={CHIP_GAP} flexWrap="wrap">
      {readings.map(reading => (
        <Box hover={{ scope: scopeOf(reading) }} flexShrink={0}>
          {gridChip(ui, reading.chip)}
        </Box>
      ))}
    </Box>
  )
  const placed = placeInBand(ui, inner, CHIPS_SLOT, chips, columns)
  const cards = readings.filter(reading => reading.row.lines.some(line => line.text !== ''))
  if (cards.length === 0) {
    return placed
  }
  const hidden = (
    <Box key={pieceKey('meter', order, mod)} flexDirection="column">
      {cards.map(reading => (
        <Box display="none" hover={{ scope: scopeOf(reading), display: 'flex' }}>
          {gridRow(ui, { name: reading.row.name, figure: reading.row.figure, ...(reading.row.color === undefined ? {} : { color: reading.row.color }), lines: reading.row.lines }, columns)}
        </Box>
      ))}
    </Box>
  )

  return placeInBand(ui, placed, METERS_SLOT, hidden, columns)
}

// `node` with `piece` in its slot, in key order, and the middle of a set height
// that holds the slot refitted; null when no such slot lies under `node`.
function insertInto(ui: ElementTable, node: unknown, slot: string, piece: unknown, columns: number): unknown {
  if (typeof node !== 'object' || node === null) {
    return null
  }
  const tree = node as TreeNode
  const children = flatNodes(Array.isArray(tree.children) ? tree.children : [])
  const key = keyOf(node)
  if (key === slot) {
    return { ...tree, children: [...children, piece].sort(byPieceKey) }
  }
  for (let index = 0; index < children.length; index++) {
    const placed = insertInto(ui, children[index], slot, piece, columns)
    if (placed !== null) {
      const copy = [...children]
      copy[index] = placed
      const next = { ...tree, children: copy }

      return key?.startsWith(FIT_PREFIX) === true ? fitBand(ui, next, Number(key.slice(FIT_PREFIX.length)), columns) : next
    }
  }

  return null
}

// The band's middle in at most `rows` rows: what it holds from the top while it
// fits, then a note of the rows left out. A column
// that runs past the end is cut inside; the slots stay, empty if need be, so a
// mod placing later still finds them, and the engine's own nodes always stay:
// a surface draws its part there. A middle fitted before keeps its count.
function fitBand(ui: ElementTable, middle: unknown, rows: number, columns: number): RenderElement {
  const { Box, Button, Text } = ui
  const tree = (typeof middle === 'object' && middle !== null ? middle : {}) as TreeNode
  const all = flatNodes(Array.isArray(tree.children) ? tree.children : [])
  const noteKey = all.map(keyOf).find(key => key?.startsWith(NOTE_PREFIX) === true)
  const outBefore = noteKey === undefined ? 0 : Number(noteKey.slice(NOTE_PREFIX.length)) || 0
  const content = all.filter(child => {
    const key = keyOf(child)

    return key !== PAD_KEY && key?.startsWith(NOTE_PREFIX) !== true
  })
  const room = Math.max(0, rows)
  const total = rowsOf(content, columns)
  const isWhole = outBefore === 0 && total <= room
  const cut = isWhole ? { kept: content, used: total } : trimRows(content, Math.max(0, room - 1), columns)
  const out = outBefore + total - cut.used
  const noteRows = out > 0 && room > 0 ? 1 : 0
  // The set height is a ceiling, not a floor: a band with less to show is shorter, never padded.
  const blank = 0

  return (
    <Box key={`${FIT_PREFIX}${room}`} flexDirection="column">
      {cut.kept as RenderElement[]}
      {noteRows > 0 && (
        <Box key={`${NOTE_PREFIX}${out}`}>
          <Button key={SHOW_ALL_KEY} plain dimColor onPress={() => undefined}>
            {`▾ ${out} more ${bandRowsWord(out)} hidden · show all`}
          </Button>
        </Box>
      )}
      <Box key={PAD_KEY} flexDirection="column">
        {Array.from({ length: blank }, () => (
          <Text>{BLANK_ROW}</Text>
        ))}
      </Box>
    </Box>
  )
}

// The nodes from the top that fit in `room` rows and the rows they take: a
// column that runs past the end is opened and cut inside, a row or a text is
// left out whole; past the end only the slots stay, emptied, and the engine's
// nodes, which take no row of their own.
function trimRows(nodes: readonly unknown[], room: number, columns: number): { kept: unknown[]; used: number } {
  const kept: unknown[] = []
  let used = 0
  let isFull = false
  for (const node of flatNodes(nodes)) {
    const key = keyOf(node)
    const isSlot = key === CHIPS_SLOT || key === METERS_SLOT || key === SECTIONS_SLOT
    const tree = node as TreeNode
    if (isFull) {
      if (isSlot) {
        kept.push({ ...tree, children: engineNodesIn(tree.children ?? []) })
      } else {
        kept.push(...engineNodesIn([node]))
      }
      continue
    }
    const size = rowsOf(node, columns)
    if (used + size <= room) {
      kept.push(node)
      used += size
      continue
    }
    isFull = true
    if (tree.type === 'Box' && tree.props?.flexDirection === 'column') {
      const inner = trimRows(Array.isArray(tree.children) ? tree.children : [], room - used, roomInside(tree, columns))
      if (inner.kept.length > 0 || isSlot) {
        kept.push({ ...tree, children: inner.kept })
        used += inner.used
      }
    } else if (isSlot) {
      kept.push({ ...tree, children: engineNodesIn(tree.children ?? []) })
    } else {
      kept.push(...engineNodesIn([node]))
    }
  }

  return { kept, used }
}

// The engine's own nodes (`type: 'engine'`) anywhere among `nodes`: where a
// surface draws the engine's part of the site, which a tree must carry on.
function engineNodesIn(nodes: readonly unknown[]): unknown[] {
  return flatNodes(nodes).flatMap(node => {
    if (typeof node !== 'object' || node === null) {
      return []
    }
    const tree = node as TreeNode

    return tree.type === 'engine' ? [node] : engineNodesIn(Array.isArray(tree.children) ? tree.children : [])
  })
}

// About how many rows a tree takes `columns` cells across: a column adds its
// children up, a row takes its tallest, a hidden Box none; a Text its lines,
// each wrapped in the room its row leaves it beside the parts of fixed width.
function rowsOf(node: unknown, columns: number): number {
  if (Array.isArray(node)) {
    return node.reduce((sum: number, child: unknown) => sum + rowsOf(child, columns), 0)
  }
  if (typeof node === 'string' || typeof node === 'number') {
    return linesIn(String(node), columns)
  }
  if (typeof node !== 'object' || node === null) {
    return 0
  }
  const tree = node as TreeNode
  const props = tree.props ?? {}
  if (props.display === 'none' || tree.type === 'engine') {
    return 0
  }
  if (tree.type === 'Svg') {
    // CSS pixels, about a row each SVG_ROW_PIXELS.
    return typeof props.height === 'number' ? Math.max(1, Math.ceil(props.height / SVG_ROW_PIXELS)) : 1
  }
  if (typeof props.height === 'number') {
    return props.height
  }
  const children = flatNodes(Array.isArray(tree.children) ? tree.children : [])
  if (tree.type === 'Text') {
    const text = bandTextOf(children)

    return typeof props.wrap === 'string' && props.wrap.startsWith('truncate') ? text.split('\n').length : linesIn(text, columns)
  }
  if (tree.type !== 'Box') {
    return 1
  }
  const room = roomInside(tree, columns)
  if (props.flexDirection === 'column') {
    return children.reduce((sum: number, child) => sum + rowsOf(child, room), 0)
  }
  const gap = typeof props.columnGap === 'number' ? props.columnGap : typeof props.gap === 'number' ? props.gap : 0
  const widths = children.map(child => Math.min(room, cellsAcross(child)))
  if (props.flexWrap === 'wrap') {
    // Lines of whole children, each as tall as its tallest.
    let rows = 0
    let line = 0
    let lineRows = 0
    children.forEach((child, index) => {
      const width = widths[index] ?? 0
      if (line > 0 && line + gap + width > room) {
        rows += lineRows
        line = 0
        lineRows = 0
      }
      line += (line > 0 ? gap : 0) + width
      lineRows = Math.max(lineRows, rowsOf(child, Math.max(1, width)))
    })

    return rows + lineRows
  }
  // One line: the last child wraps in what the others leave it.
  const others = widths.slice(0, -1).reduce((sum, width) => sum + width, 0) + gap * Math.max(0, children.length - 1)

  return children.reduce(
    (most: number, child, index) =>
      Math.max(most, rowsOf(child, index === children.length - 1 ? Math.max(1, room - others) : Math.max(1, widths[index] ?? 1))),
    0,
  )
}

// The cells a node takes across on one line, unwrapped.
function cellsAcross(node: unknown): number {
  if (Array.isArray(node)) {
    return node.reduce((sum: number, child: unknown) => sum + cellsAcross(child), 0)
  }
  if (typeof node === 'string' || typeof node === 'number') {
    return Math.max(0, ...String(node).split('\n').map(cellsIn))
  }
  if (typeof node !== 'object' || node === null) {
    return 0
  }
  const tree = node as TreeNode
  const props = tree.props ?? {}
  if (props.display === 'none' || tree.type === 'engine') {
    return 0
  }
  const margins = sideCells(props)
  if (typeof props.width === 'number') {
    return props.width + margins
  }
  const children = flatNodes(Array.isArray(tree.children) ? tree.children : [])
  if (tree.type === 'Button') {
    const label = typeof props.label === 'string' && props.label !== '' ? props.label : bandTextOf(children)

    return cellsIn(label) + (props.plain === true ? 0 : 4) + margins
  }
  if (tree.type === 'Text') {
    return Math.max(0, ...bandTextOf(children).split('\n').map(cellsIn)) + margins
  }
  if (tree.type !== 'Box') {
    return margins
  }
  const across = children.map(cellsAcross)
  if (props.flexDirection === 'column') {
    return Math.max(0, ...across) + margins
  }
  const gap = typeof props.columnGap === 'number' ? props.columnGap : typeof props.gap === 'number' ? props.gap : 0

  return across.reduce((sum, width) => sum + width, 0) + gap * Math.max(0, children.length - 1) + margins
}

// The cells a Box gives its children: its width, or what its parent gives,
// less its margins, padding and border.
function roomInside(tree: TreeNode, columns: number): number {
  const props = tree.props ?? {}
  const outer = typeof props.width === 'number' ? props.width : columns - sideCells(props)

  return Math.max(1, outer - paddingCells(props))
}

function sideCells(props: Record<string, unknown>): number {
  const number = (value: unknown) => (typeof value === 'number' ? value : 0)
  const margin = number(props.margin)
  const marginX = number(props.marginX)

  return number(props.marginLeft) + number(props.marginRight) + 2 * marginX + 2 * margin
}

function paddingCells(props: Record<string, unknown>): number {
  const number = (value: unknown) => (typeof value === 'number' ? value : 0)

  return (
    number(props.paddingLeft) +
    number(props.paddingRight) +
    2 * number(props.paddingX) +
    2 * number(props.padding) +
    (typeof props.borderStyle === 'string' ? 2 : 0)
  )
}

// Rows a text takes `columns` cells across, each line wrapped.
function linesIn(text: string, columns: number): number {
  return text.split('\n').reduce((sum, line) => sum + Math.max(1, Math.ceil(cellsIn(line) / Math.max(1, columns))), 0)
}

// Cells a line takes: a wide glyph (an emoji, a CJK one) two, the rest one.
function cellsIn(line: string): number {
  let cells = 0
  for (const glyph of line) {
    cells += /\p{Extended_Pictographic}|[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/u.test(glyph) ? 2 : 1
  }

  return cells
}

function bandTextOf(children: readonly unknown[]): string {
  return children
    .map(child =>
      typeof child === 'string' || typeof child === 'number'
        ? String(child)
        : typeof child === 'object' && child !== null && Array.isArray((child as TreeNode).children)
          ? bandTextOf((child as TreeNode).children ?? [])
          : '',
    )
    .join('')
}

// Children as the engine lays them out: nested lists opened, the empty ones
// (`false`, `null`) dropped.
function flatNodes(nodes: readonly unknown[]): unknown[] {
  return nodes.flatMap(node => (Array.isArray(node) ? flatNodes(node) : node === null || node === undefined || node === false || node === true ? [] : [node]))
}

function bandRowsWord(count: number): string {
  return count === 1 ? 'row' : 'rows'
}

// The pieces keyed `<kind>:...` anywhere under `node`, and `node` without them.
function takePieces(node: unknown, kind: 'chip' | 'meter' | 'section'): { rest: unknown; pieces: unknown[] } {
  if (typeof node !== 'object' || node === null) {
    return { rest: node, pieces: [] }
  }
  if (keyOf(node)?.startsWith(`${kind}:`) === true) {
    return { rest: null, pieces: [node] }
  }
  const tree = node as TreeNode
  if (!Array.isArray(tree.children)) {
    return { rest: node, pieces: [] }
  }
  const pieces: unknown[] = []
  const kept: unknown[] = []
  for (const child of tree.children) {
    const taken = takePieces(child, kind)
    pieces.push(...taken.pieces)
    if (taken.rest !== null) {
      kept.push(taken.rest)
    }
  }

  return { rest: pieces.length === 0 ? node : { ...tree, children: kept }, pieces }
}

function byPieceKey(a: unknown, b: unknown): number {
  return (keyOf(a) ?? '').localeCompare(keyOf(b) ?? '')
}
// ---- end of band layout ----

// ---- band grid (shared block) ----
// Every mod that draws rows in the band lays them on one grid, so names,
// figures and bars line up across mods: a name column, a right-aligned
// figure, a bar of GRID_BAR cells, then the text, one line or a column of
// them. This block is pasted unchanged into each mod that draws band rows.
const GRID_NAME = 12
const GRID_FIGURE = 5
const GRID_BAR = 20
// Narrower than this, rows keep their figures and drop the bars.
const GRID_MIN_COLUMNS = 70

type GridLine = { text: string; color?: ThemeKey; isDim?: boolean; isBold?: boolean }

type GridRow = {
  name: string
  nameColor?: ThemeKey
  isHeader?: boolean
  figure: string
  color?: ThemeKey
  // Absent (and no barText): the row has no bar and its text starts where the bar would.
  percent?: number
  // Drawn in the bar's place instead of a bar of `percent`, GRID_BAR cells wide (a sparkline).
  barText?: string
  barColor?: ThemeKey
  lines: GridLine[]
}

function gridRow(ui: ElementTable, row: GridRow, columns: number): RenderElement {
  const { Box, Text } = ui
  const hasBar = (row.percent !== undefined || row.barText !== undefined) && columns >= GRID_MIN_COLUMNS
  const colorOrDim = (color: ThemeKey | undefined, isDim: boolean) =>
    color === undefined ? { dimColor: isDim } : { color, dimColor: isDim }

  return (
    <Box gap={1}>
      <Box width={GRID_NAME} flexShrink={0}>
        <Text {...colorOrDim(row.nameColor, row.nameColor === undefined && row.isHeader !== true)} bold={row.isHeader === true}>
          {row.name}
        </Text>
      </Box>
      <Box width={GRID_FIGURE} flexShrink={0} justifyContent="flex-end">
        <Text {...colorOrDim(row.color, false)} bold>
          {row.figure}
        </Text>
      </Box>
      {hasBar && <Text {...colorOrDim(row.barColor ?? row.color, false)}>{row.barText ?? gridBar(row.percent ?? 0)}</Text>}
      <Box flexDirection="column" flexShrink={1}>
        {row.lines.map(line => (
          <Text {...colorOrDim(line.color, line.isDim === true)} bold={line.isBold === true}>
            {line.text}
          </Text>
        ))}
      </Box>
    </Box>
  )
}

function gridBar(percent: number): string {
  const filled = Math.max(0, Math.min(GRID_BAR, Math.round((percent / 100) * GRID_BAR)))

  return '█'.repeat(filled) + '░'.repeat(GRID_BAR - filled)
}
// A reading at rest, drawn as a chip on the band's one line of quiet figures:
// its name dim, its figure in its tone.
type GridChip = { name: string; figure: string; color?: ThemeKey }

function gridChip(ui: ElementTable, chip: GridChip): RenderElement {
  const { Box, Text } = ui

  return (
    <Box gap={1} flexShrink={0}>
      <Text dimColor>{chip.name}</Text>
      {chip.color === undefined ? <Text bold>{chip.figure}</Text> : <Text color={chip.color} bold>{chip.figure}</Text>}
    </Box>
  )
}
// ---- end of band grid ----

// ---- mods switch (shared block) ----
// The mods panel (mod 0) writes the names of the mods turned off to this file
// under HOME, and every session of every mod reads it; a mod not named there
// is on, and `quiet: true` asks the band's meters to show only what needs a
// look. This block is pasted unchanged into each mod of the family, which
// declares MOD_NAME and the atoms `isOn`, `isQuiet`, `switchedOff` and
// `switchSeenAt` (the last two keep the file's time and its whole off list): the
// engine follows $ only into functions of the same file, and state only
// through its own atoms.
const SWITCHES_FILE = '.claude/mods/state.json'
// How soon a switch flipped in any session reaches this one.
const SWITCH_POLL_MS = 1_500

// Reads the switch now, then keeps polling it.
async function watchSwitch($: EngineInterface): Promise<boolean> {
  const isNowOn = await refreshSwitch($)
  $.clock.every(SWITCH_POLL_MS, () => {
    void refreshSwitch($)
  })

  return isNowOn
}

// Reads the file only once its modification time moved; a file caught
// half-written fails to parse and is read again at the next poll.
async function refreshSwitch($: EngineInterface): Promise<boolean> {
  try {
    const home = await $.env.get('HOME')
    if (home === undefined || home === '') {
      return await read($, isOn)
    }
    const path = `${home.replace(/\/$/, '')}/${SWITCHES_FILE}`
    let isNowOn = true
    let isNowQuiet = false
    if (await $.fs.exists(path)) {
      const { mtimeMs } = await $.fs.stat(path)
      if (mtimeMs === (await read($, switchSeenAt))) {
        return await read($, isOn)
      }
      const data: unknown = JSON.parse(await $.fs.read(path))
      await update($, switchSeenAt, () => mtimeMs)
      const record = typeof data === 'object' && data !== null ? (data as { off?: unknown; quiet?: unknown }) : {}
      const off = Array.isArray(record.off) ? record.off.filter((name): name is string => typeof name === 'string') : []
      isNowOn = !off.includes(MOD_NAME)
      isNowQuiet = record.quiet === true
      await update($, switchedOff, () => off)
    }
    if (isNowQuiet !== (await read($, isQuiet))) {
      await update($, isQuiet, () => isNowQuiet)
    }
    if (isNowOn !== (await read($, isOn))) {
      await update($, isOn, () => isNowOn)
    }

    return isNowOn
  } catch (error) {
    $.ui.log(`${MOD_NAME}: could not read the mods switches: ${error instanceof Error ? error.message : String(error)}`, {
      to: 'debug',
    })

    return read($, isOn)
  }
}
// ---- end of mods switch ----
