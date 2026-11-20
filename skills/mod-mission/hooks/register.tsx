import { atom, read, update } from 'claude-code'
import type { ElementTable, EngineInterface, Register, RenderElement, ThemeKey, TurnUsage } from 'claude-code'

import type { FillPoint, Overview, SessionLine, TimelineRunner } from '../types'

const MOD_NAME = 'mod-mission'
// Its place in the mods panel, which also orders its section in the band.
const MOD_ORDER = 16
// The band's toolbar button this mod's card asks for, and the pane it opens.
const BUTTON = 'section:mission'
const BAND = 'context-band'
const PANE_ID = 'mission'
const PANE_TITLE = 'Overview'
const PANE_COLUMNS = 90
const isOn = atom({ plugin: 'mod-mission', key: 'isOn' } as const, true)
const switchSeenAt = atom({ plugin: 'mod-mission', key: 'switchSeenAt' } as const, -1)
const isQuiet = atom({ plugin: 'mod-mission', key: 'isQuiet' } as const, false)
const switchedOff = atom({ plugin: 'mod-mission', key: 'switchedOff' } as const, [])
const fillHistory = atom({ plugin: 'mod-mission', key: 'fillHistory' } as const, [])
const overview = atom({ plugin: 'mod-mission', key: 'overview' } as const, null)
// Open as a section in the band (where no pane is placed) or as the pane.
const isOpen = atom({ plugin: 'mod-mission', key: 'isOpen' } as const, false)
const isPaneShown = atom({ plugin: 'mod-mission', key: 'isPaneShown' } as const, false)

// The files the other mods share, under HOME.
const REGISTRY_DIR = '.claude/context-band/sessions'
const LIMITS_FILE = '.claude/mods/limits.json'
const MACHINE_FILE = '.claude/mods/machine.json'
const PULLS_FILE = '.claude/mods/pulls.json'
const POLL_MS = 15_000
const SILENT_AFTER_MS = 120_000
const HISTORY_POINTS = 120
// The runner timeline's span, and how many rows it draws.
const TIMELINE_MS = 4 * 60 * 60_000
const TIMELINE_ROWS = 10
// Chart colours that read on light and dark alike: the charts are drawn as images.
const INK = { axis: '#9CA3AF', line: '#3B82F6', live: '#3B82F6', done: '#22C55E', dead: '#EF4444', warn: '#F59E0B', ok: '#22C55E' }
const CHART_WIDTH = 640
const DONE_WORDS = statusWords(['DONE', 'COMPLETED', 'SUCCESS', 'OK', 'PASSED', 'PASS'])
const DEAD_WORDS = statusWords(['FAILED', 'FAIL', 'DEAD', 'ERROR', 'KILLED'])
// A longer status word counts by its last part (BUILD_DONE is DONE, STEP_FAILED is FAILED), unless it is negated (NOT_DONE).
function statusWords(words: string[]): { has: (word: string) => boolean } {
  const known = new Set(words)

  return { has: word => known.has(word) || (!/^NOT?_/.test(word) && known.has(word.slice(word.lastIndexOf('_') + 1))) }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await watchSwitch($)
    await $.command.register({ name: 'mission', description: 'Overview: everything from the mods in one place, with charts' })
    $.clock.every(POLL_MS, () => {
      void refreshWhileOpen($)
    })

    return started
  })

  // This session's fill, step by step: the line on the first chart.
  on('turn.step', async function* ($, e, next) {
    const response = yield* next(e)
    if (e.agentId === undefined && response.usage !== null) {
      const usage: TurnUsage = response.usage
      const window = (await $.session.usage()).context.window
      const tokens = usage.input_tokens + usage.cache_creation_input_tokens + usage.cache_read_input_tokens
      const at = await $.clock.now()
      if (window > 0) {
        await update($, fillHistory, points => [...points, { at, percent: Math.min(100, Math.round((tokens / window) * 100)) }].slice(-HISTORY_POINTS))
      }
    }

    return response
  })

  on('ui.press', { plugin: BAND }, async ($, e, next) => {
    const pressed = await next(e)
    if (e.element === BUTTON) {
      await toggle($)
    } else {
      await update($, isOpen, () => false)
    }

    return pressed
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'mission' }, async $ => {
    await toggle($)

    return {}
  }).catch(() => ({ text: 'The overview did not open; details are in the debug log.' }))

  on('ui.close', { id: PANE_ID }, async ($, e, next) => {
    const closed = await next(e)
    await update($, isPaneShown, () => false)

    return closed
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box } = ui
    // Remote surfaces draw SVG charts; the terminal gets text bars.
    const chartOf =
      e.surface === 'terminal'
        ? null
        : (source: string, alt: string, height: number) => {
            const { Svg } = $.ui.resolve(e)

            return <Svg source={source} alt={alt} width={CHART_WIDTH} height={height} />
          }

    return <Box flexDirection="column">{await drawOverview($, ui, chartOf, e.props.bodyColumns)}</Box>
  })

  // Drawn into the band's row (context-band), not a row of this mod's own: the engine
  // gives each plugin its own row, and only the band's row holds the slots that
  // keep every reading on one line.
  on('ui.render', { component: 'AbovePrompt', plugin: 'context-band' }, async ($, e, next) => {
    const inner = await next(e)
    if (e.props.hasSurvey || !(await read($, isOpen)) || !(await read($, isOn))) {
      return inner
    }
    const ui = $.ui.resolve(e)
    const { Box } = ui
    const chartOf =
      e.surface === 'terminal'
        ? null
        : (source: string, alt: string, height: number) => {
            const { Svg } = $.ui.resolve(e)

            return <Svg source={source} alt={alt} width={CHART_WIDTH} height={height} />
          }
    const piece = (
      <Box key={pieceKey('section', MOD_ORDER, MOD_NAME)} flexDirection="column">
        {gridRow(ui, { name: PANE_TITLE, isHeader: true, figure: '', lines: [{ text: 'everything from the mods in one place', isDim: true }] }, e.props.bodyColumns)}
        {await drawOverview($, ui, chartOf, e.props.bodyColumns)}
      </Box>
    )

    return placeInBand(ui, inner, SECTIONS_SLOT, piece, e.props.bodyColumns)
  })
}

// Opens the overview as a pane where the surface places one, else as a section in the band.
async function toggle($: EngineInterface): Promise<void> {
  if (await read($, isOpen)) {
    await update($, isOpen, () => false)

    return
  }
  if (await read($, isPaneShown)) {
    await $.ui.close({ id: PANE_ID })
    await update($, isPaneShown, () => false)

    return
  }
  await gather($)
  const opened = await $.ui.open({ id: PANE_ID, title: PANE_TITLE, columns: PANE_COLUMNS })
  if (opened.isPlaced) {
    await update($, isPaneShown, () => true)

    return
  }
  await $.ui.close({ id: PANE_ID })
  await update($, isOpen, () => true)
}

async function refreshWhileOpen($: EngineInterface): Promise<void> {
  if ((await read($, isOpen)) || (await read($, isPaneShown))) {
    await gather($)
  }
}

// Everything the overview shows, from the files the other mods keep.
async function gather($: EngineInterface): Promise<void> {
  try {
    const home = (await $.env.get('HOME'))?.replace(/\/$/, '') ?? ''
    if (home === '') {
      return
    }
    const now = await $.clock.now()
    const cwd = await $.session.cwd()
    const limits = (await readJson($, `${home}/${LIMITS_FILE}`)) as { windows?: Overview['limits'] } | null
    const machine = (await readJson($, `${home}/${MACHINE_FILE}`)) as { freePct?: number | null; disk?: { usedPct: number } | null } | null
    const pulls = ((await readJson($, `${home}/${PULLS_FILE}`)) ?? {}) as Record<string, { pull: { number: number; state: string; checks: { passed: number; failed: number; pending: number }; review: string } | null }>
    const pullEntry = Object.entries(pulls).find(([key]) => key.startsWith(`${cwd}#`))?.[1]?.pull ?? null
    const sessions: SessionLine[] = []
    const runners: TimelineRunner[] = []
    const dir = `${home}/${REGISTRY_DIR}`
    if (await $.fs.exists(dir)) {
      for (const file of await $.fs.list(dir)) {
        if (file.kind !== 'file' || !file.name.endsWith('.json') || now - file.mtimeMs >= SILENT_AFTER_MS) {
          continue
        }
        const entry = (await readJson($, `${dir}/${file.name}`)) as {
          cwd?: string
          isEnded?: boolean
          fill?: number | null
          task?: { title: string; percent: number } | null
          turn?: { isWorking: boolean }
          runners?: Array<{ description: string; seenAt: number; endedAt: number | null; status: string; info?: { title: string } | null; progress?: { targets: Array<{ status: string }> } | null }>
        } | null
        if (entry === null || entry.isEnded === true || typeof entry.cwd !== 'string') {
          continue
        }
        const where = entry.cwd.split('/').pop() ?? entry.cwd
        sessions.push({ where, task: entry.task?.title ?? null, percent: entry.task?.percent ?? null, fill: entry.fill ?? null, isWorking: entry.turn?.isWorking ?? null })
        for (const runner of entry.runners ?? []) {
          if (typeof runner.seenAt !== 'number' || (runner.endedAt !== null && now - runner.endedAt > TIMELINE_MS)) {
            continue
          }
          runners.push({ where, title: runner.info?.title ?? runner.description, seenAt: runner.seenAt, endedAt: runner.endedAt, state: runnerState(runner) })
        }
      }
    }
    const gathered: Overview = {
      limits: Array.isArray(limits?.windows) ? limits.windows : [],
      runners: runners.sort((a, b) => a.seenAt - b.seenAt).slice(-TIMELINE_ROWS),
      sessions,
      machine: machine === null ? null : { freePct: machine.freePct ?? null, diskUsedPct: machine.disk?.usedPct ?? null },
      pull: pullEntry === null ? null : { number: pullEntry.number, state: pullEntry.state, ...pullEntry.checks, review: pullEntry.review },
      at: now,
    }
    await update($, overview, () => gathered)
  } catch (error) {
    $.ui.log(`mod-mission: could not gather the overview: ${messageOf(error)}`, { to: 'debug' })
  }
}

function runnerState(runner: { endedAt: number | null; status: string; progress?: { targets: Array<{ status: string }> } | null }): TimelineRunner['state'] {
  const statuses = (runner.progress?.targets ?? []).map(target => target.status)
  if (runner.status === 'failed' || runner.status === 'killed' || statuses.some(status => DEAD_WORDS.has(status))) {
    return 'dead'
  }
  if (runner.endedAt !== null || statuses.some(status => DONE_WORDS.has(status))) {
    return 'done'
  }

  return 'live'
}

// The overview's rows: charts where the surface draws SVG, text bars where it does not.
type ChartOf = ((source: string, alt: string, height: number) => RenderElement) | null

async function drawOverview($: EngineInterface, ui: ElementTable, chartOf: ChartOf, columns: number): Promise<RenderElement[]> {
  const shown = await read($, overview)
  const history = await read($, fillHistory)
  const { Box, Text } = ui
  const rows: RenderElement[] = []
  const heading = (text: string) => <Text bold>{text}</Text>
  rows.push(heading("This session's context"))
  if (chartOf !== null) {
    rows.push(chartOf(fillChart(history), `Context fill over the last ${history.length} steps`, 130))
  } else {
    rows.push(gridRow(ui, { name: 'Context', figure: `${history[history.length - 1]?.percent ?? '-'}%`, barText: sparkline(history.map(point => point.percent)), lines: [{ text: 'by step', isDim: true }] }, columns))
  }
  if (shown === null) {
    rows.push(<Text dimColor>collecting data</Text>)

    return rows
  }
  if (shown.limits.length > 0) {
    rows.push(heading('Subscription limits'))
    if (chartOf !== null) {
      rows.push(chartOf(limitsChart(shown.limits), 'Subscription limit use', 20 + shown.limits.length * 28))
    } else {
      for (const window of shown.limits) {
        rows.push(gridRow(ui, { name: window.kind === 'five_hour' ? '5h limit' : window.kind === 'seven_day' ? 'Week limit' : window.kind, figure: `${Math.round(window.percentUsed)}%`, color: tone(window.percentUsed), percent: window.percentUsed, lines: [] }, columns))
      }
    }
  }
  rows.push(heading(`Runners in 4 hours: ${shown.runners.length}`))
  if (shown.runners.length === 0) {
    rows.push(<Text dimColor>no background work</Text>)
  } else if (chartOf !== null) {
    rows.push(chartOf(timelineChart(shown.runners, shown.at), "Every session's runners on a timeline", 30 + shown.runners.length * 22))
  } else {
    for (const runner of shown.runners) {
      rows.push(gridRow(ui, { name: runner.state === 'dead' ? '✕ died' : runner.state === 'done' ? '✓ done' : '● running', figure: '', barText: timelineText(runner, shown.at), color: runner.state === 'dead' ? 'error' : runner.state === 'done' ? 'subtle' : 'suggestion', lines: [{ text: `${runner.title} · ${runner.where}`, isDim: true }] }, columns))
    }
  }
  rows.push(heading(`Sessions: ${shown.sessions.length}`))
  for (const line of shown.sessions) {
    rows.push(
      gridRow(
        ui,
        {
          name: line.isWorking === true ? '● working' : line.isWorking === false ? '◌ waiting' : '● live',
          nameColor: line.isWorking === true ? 'suggestion' : 'subtle',
          figure: line.fill === null ? '' : `${line.fill}%`,
          color: tone(line.fill ?? 0),
          percent: line.fill ?? 0,
          lines: [{ text: [line.where, line.task === null ? '' : `${line.task} · ${line.percent ?? 0}%`].filter(Boolean).join(' · '), isDim: true }],
        },
        columns,
      ),
    )
  }
  const machineText =
    shown.machine === null
      ? ''
      : [shown.machine.freePct === null ? '' : `memory ${shown.machine.freePct}% free`, shown.machine.diskUsedPct === null ? '' : `disk ${shown.machine.diskUsedPct}%`].filter(Boolean).join(' · ')
  const pullText =
    shown.pull === null
      ? ''
      : `PR #${shown.pull.number} ${shown.pull.state === 'OPEN' ? 'open' : shown.pull.state === 'MERGED' ? 'merged' : 'closed'}, checks ${shown.pull.passed}/${shown.pull.passed + shown.pull.failed + shown.pull.pending}${shown.pull.failed === 0 ? '' : `, ${shown.pull.failed} ✕`}`
  if (machineText !== '' || pullText !== '') {
    rows.push(heading('Mac and PR'))
    rows.push(<Text dimColor>{[machineText, pullText].filter(Boolean).join(' · ')}</Text>)
  }

  return [<Box flexDirection="column" gap={0}>{rows}</Box>]
}

// The fill as a line over the steps, with the 80% mark where compaction nears.
function fillChart(points: readonly FillPoint[]): string {
  const width = CHART_WIDTH
  const height = 130
  const pad = 24
  const xs = points.length < 2 ? [] : points.map((_, index) => pad + (index * (width - pad * 2)) / (points.length - 1))
  const y = (percent: number) => height - pad - (percent / 100) * (height - pad * 2)
  const line = xs.map((x, index) => `${x.toFixed(1)},${y(points[index]?.percent ?? 0).toFixed(1)}`).join(' ')
  const last = points[points.length - 1]

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="sans-serif" font-size="11">`,
    `<line x1="${pad}" y1="${y(80)}" x2="${width - pad}" y2="${y(80)}" stroke="${INK.warn}" stroke-dasharray="4 4"/>`,
    `<text x="${width - pad}" y="${y(80) - 4}" text-anchor="end" fill="${INK.warn}">80%</text>`,
    `<line x1="${pad}" y1="${height - pad}" x2="${width - pad}" y2="${height - pad}" stroke="${INK.axis}"/>`,
    line === '' ? `<text x="${pad}" y="${height / 2}" fill="${INK.axis}">too few steps for a chart yet</text>` : `<polyline points="${line}" fill="none" stroke="${INK.line}" stroke-width="2"/>`,
    last === undefined ? '' : `<text x="${pad}" y="${pad - 6}" fill="${INK.axis}">now ${last.percent}%</text>`,
    '</svg>',
  ].join('')
}

function limitsChart(limits: Overview['limits']): string {
  const width = CHART_WIDTH
  const height = 20 + limits.length * 28
  const barX = 120
  const barWidth = width - barX - 60
  const rows = limits.map((window, index) => {
    const yTop = 10 + index * 28
    const used = Math.max(0, Math.min(100, window.percentUsed))
    const label = window.kind === 'five_hour' ? '5h limit' : window.kind === 'seven_day' ? 'Week limit' : escapeXml(window.kind)

    return [
      `<text x="0" y="${yTop + 13}" fill="${INK.axis}">${label}</text>`,
      `<rect x="${barX}" y="${yTop}" width="${barWidth}" height="16" rx="3" fill="${INK.axis}" fill-opacity="0.25"/>`,
      `<rect x="${barX}" y="${yTop}" width="${((barWidth * used) / 100).toFixed(1)}" height="16" rx="3" fill="${used >= 80 ? INK.dead : used >= 60 ? INK.warn : INK.ok}"/>`,
      `<text x="${barX + barWidth + 8}" y="${yTop + 13}" fill="${INK.axis}">${Math.round(used)}%</text>`,
    ].join('')
  })

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="sans-serif" font-size="12">${rows.join('')}</svg>`
}

// Every runner of the last four hours as a bar from its start to its end (or now).
function timelineChart(runners: readonly TimelineRunner[], now: number): string {
  const width = CHART_WIDTH
  const labelWidth = 220
  const span = width - labelWidth - 10
  const from = now - TIMELINE_MS
  const height = 30 + runners.length * 22
  const x = (at: number) => labelWidth + Math.max(0, Math.min(span, ((at - from) / TIMELINE_MS) * span))
  const rows = runners.map((runner, index) => {
    const yTop = 6 + index * 22
    const start = x(runner.seenAt)
    const end = x(runner.endedAt ?? now)
    const colour = runner.state === 'dead' ? INK.dead : runner.state === 'done' ? INK.done : INK.live

    return [
      `<text x="0" y="${yTop + 12}" fill="${INK.axis}">${escapeXml(`${runner.title} · ${runner.where}`.slice(0, 34))}</text>`,
      `<rect x="${start.toFixed(1)}" y="${yTop}" width="${Math.max(3, end - start).toFixed(1)}" height="14" rx="3" fill="${colour}"/>`,
    ].join('')
  })
  const axis = [0, 1, 2, 3, 4].map(hour => {
    const at = labelWidth + (hour * span) / 4

    return `<line x1="${at}" y1="2" x2="${at}" y2="${height - 16}" stroke="${INK.axis}" stroke-opacity="0.3"/><text x="${at}" y="${height - 4}" text-anchor="middle" fill="${INK.axis}">${hour === 4 ? 'now' : `-${4 - hour}h`}</text>`
  })

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="sans-serif" font-size="11">${axis.join('')}${rows.join('')}</svg>`
}

function timelineText(runner: TimelineRunner, now: number): string {
  const cell = TIMELINE_MS / GRID_BAR
  const from = now - TIMELINE_MS

  return Array.from({ length: GRID_BAR }, (_, index) => {
    const start = from + index * cell

    return runner.seenAt < start + cell && (runner.endedAt ?? now) >= start ? '█' : '░'
  }).join('')
}

function sparkline(values: readonly number[]): string {
  const levels = '▁▂▃▄▅▆▇█'
  const shown = values.slice(-GRID_BAR).map(value => levels[Math.max(0, Math.min(7, Math.ceil((value / 100) * 8) - 1))] ?? '░')

  return '░'.repeat(GRID_BAR - shown.length) + shown.join('')
}

function tone(percent: number): ThemeKey {
  if (percent >= 80) {
    return 'error'
  }

  return percent >= 60 ? 'warning' : 'success'
}

function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

async function readJson($: EngineInterface, path: string): Promise<unknown> {
  if (!(await $.fs.exists(path))) {
    return null
  }
  try {
    return JSON.parse(await $.fs.read(path)) as unknown
  } catch {
    return null
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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
// chip keyed `chip:NN:<mod>`; a reading that needs a look is a full row in
// METERS_SLOT instead (placeReadings sorts them).
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

// A meter mod's readings in the band: each one at rest a chip on the line of
// quiet figures, each one that needs a look a full row with its bar.
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
  const atRest = readings.filter(reading => !reading.needsLook)
  const looks = readings.filter(reading => reading.needsLook)
  let placed = inner
  if (atRest.length > 0) {
    const chips = (
      <Box key={pieceKey('chip', order, mod)} columnGap={CHIP_GAP} flexWrap="wrap">
        {atRest.map(reading => gridChip(ui, reading.chip))}
      </Box>
    )
    placed = placeInBand(ui, placed, CHIPS_SLOT, chips, columns)
  }
  if (looks.length > 0) {
    const rows = (
      <Box key={pieceKey('meter', order, mod)} flexDirection="column">
        {looks.map(reading => gridRow(ui, reading.row, columns))}
      </Box>
    )
    placed = placeInBand(ui, placed, METERS_SLOT, rows, columns)
  }

  return placed
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

// The band's middle in exactly `rows` rows: what it holds from the top while it
// fits, then a note of the rows left out, then blank rows to the end. A column
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
  const blank = Math.max(0, room - cut.used - noteRows)

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
