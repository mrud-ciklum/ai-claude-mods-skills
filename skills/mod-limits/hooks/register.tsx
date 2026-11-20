import { atom, read, update } from 'claude-code'
import type { ElementTable, EngineInterface, Register, RenderElement, ThemeKey } from 'claude-code'

import type { LimitWindow, LimitsReading } from '../types'

const MOD_NAME = 'mod-limits'
// Its place in the mods panel, which also orders its rows among the band's meters.
const MOD_ORDER = 2
// Whether the mods panel has this mod on; off, it draws nothing and toasts nothing.
const isOn = atom({ plugin: 'mod-limits', key: 'isOn' } as const, true)
const switchSeenAt = atom({ plugin: 'mod-limits', key: 'switchSeenAt' } as const, -1)
// The family's quiet mode: the band's meters show only what needs a look.
const isQuiet = atom({ plugin: 'mod-limits', key: 'isQuiet' } as const, false)
// Every mod the panel has off, as the switches file last said.
const switchedOff = atom({ plugin: 'mod-limits', key: 'switchedOff' } as const, [])
// The freshest reading of the account's windows: this session's own, or another session's newer one.
const latest = atom({ plugin: 'mod-limits', key: 'latest' } as const, null)
// The time the row counts "resets in" from, moved once a minute.
const now = atom({ plugin: 'mod-limits', key: 'now' } as const, 0)
// The highest level each window was toasted at; it re-arms once the window falls below it.
const alerted = atom({ plugin: 'mod-limits', key: 'alerted' } as const, {})

// The limits are the account's, not the session's: the last reading any session
// took is shared under HOME, so a new session shows them before its first response.
const SHARED_FILE = '.claude/mods/limits.json'
const TICK_MS = 60_000
// Highest first: the first level a window reaches is the level it is at.
const ALERT_LEVELS = [95, 80] as const
// What each window is called on its chip at rest, then in the band's name column and its toasts.
const CHIP_NAMES: Readonly<Record<string, string>> = {
  five_hour: '5h',
  seven_day: 'Week',
  seven_day_opus: 'Week Opus',
  seven_day_sonnet: 'Week Sonnet',
  spend_limit: 'Spend',
}
const NAMES: Readonly<Record<string, string>> = {
  five_hour: '5h limit',
  seven_day: 'Week limit',
  seven_day_opus: 'Week Opus',
  seven_day_sonnet: 'Week Sonnet',
  spend_limit: 'Spend',
}
// In quiet mode the rows show from the amber step on.
const QUIET_SHOWS_AT = 60
// The five-hour window first, the weekly next, any other after them.
const KIND_ORDER = ['five_hour', 'seven_day']

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await watchSwitch($)
    const at = await $.clock.now()
    await update($, now, () => at)
    const usage = await $.session.usage()
    if (usage.rateLimits.length > 0) {
      await update($, latest, () => ({ windows: [...usage.rateLimits], at }))
    }
    await adoptShared($)
    $.clock.every(TICK_MS, () => {
      void tick($)
    })

    return started
  })

  on('session.measure', async ($, e, next) => {
    const measured = await next(e)
    if (e.changed.includes('rateLimits') && e.rateLimits.length > 0) {
      await record($, e.rateLimits)
    }

    return measured
  }).catch(($, e, next) => next(e))

  // One row per window on the band's grid, above whatever the mods beneath drew.
  // Drawn into the band's row (context-band), not a row of this mod's own: the engine
  // gives each plugin its own row, and only the band's row holds the slots that
  // keep every reading on one line.
  on('ui.render', { component: 'AbovePrompt', plugin: 'context-band' }, async ($, e, next) => {
    const inner = await next(e)
    const reading = await read($, latest)
    if (e.props.hasSurvey || reading === null || !(await read($, isOn))) {
      return inner
    }
    const at = await read($, now)
    const windows = current(reading.windows, at)
    const isCalm = windows.every(window => window.percentUsed < QUIET_SHOWS_AT)
    if (windows.length === 0 || ((await read($, isQuiet)) && isCalm)) {
      return inner
    }
    const ui = $.ui.resolve(e)
    // Below the amber step a window is a chip; from it, a row with its bar and when it resets.
    const readings = windows.map(window => {
      const figure = `${Math.round(window.percentUsed)}%`
      const color = toneOf(window.percentUsed)

      return {
        needsLook: color !== 'success',
        chip: { name: CHIP_NAMES[window.kind] ?? window.kind, figure, color },
        row: {
          name: NAMES[window.kind] ?? window.kind,
          figure,
          color,
          percent: window.percentUsed,
          lines: [{ text: window.resetsAt === undefined ? '' : untilText(window.resetsAt, at), isDim: true }],
        },
      }
    })

    return placeReadings(ui, inner, readings, MOD_ORDER, MOD_NAME, e.props.bodyColumns)
  })
}

// A response's reading: kept, shared with the other sessions, and toasted once per level crossed.
async function record($: EngineInterface, windows: readonly LimitWindow[]): Promise<void> {
  const at = await $.clock.now()
  const reading: LimitsReading = { windows: [...windows], at }
  await update($, now, () => at)
  await update($, latest, () => reading)
  try {
    await $.fs.write(await homePath($, SHARED_FILE), `${JSON.stringify(reading)}\n`)
  } catch (error) {
    $.ui.log(`mod-limits: could not share the reading: ${messageOf(error)}`, { to: 'debug' })
  }
  for (const window of windows) {
    const level = ALERT_LEVELS.find(at => window.percentUsed >= at) ?? 0
    const before = (await read($, alerted))[window.kind] ?? 0
    if (level === before) {
      continue
    }
    await update($, alerted, all => ({ ...all, [window.kind]: level }))
    if (level > before && (await read($, isOn))) {
      const reset = window.resetsAt === undefined ? '' : `, resets ${untilText(window.resetsAt, at)}`
      await $.ui.toast(`${NAMES[window.kind] ?? window.kind}: ${Math.round(window.percentUsed)}% used${reset}`)
    }
  }
}

async function tick($: EngineInterface): Promise<void> {
  const at = await $.clock.now()
  await update($, now, () => at)
  await adoptShared($)
}

// Another session's reading, when it is newer than the one in hand.
async function adoptShared($: EngineInterface): Promise<void> {
  try {
    const path = await homePath($, SHARED_FILE)
    if (!(await $.fs.exists(path))) {
      return
    }
    const shared = parseReading(await $.fs.read(path))
    const mine = await read($, latest)
    if (shared !== null && shared.at > (mine?.at ?? -1)) {
      await update($, latest, () => shared)
    }
  } catch (error) {
    $.ui.log(`mod-limits: could not read the shared reading: ${messageOf(error)}`, { to: 'debug' })
  }
}

function parseReading(text: string): LimitsReading | null {
  try {
    const data: unknown = JSON.parse(text)
    if (typeof data !== 'object' || data === null) {
      return null
    }
    const record = data as { windows?: unknown; at?: unknown }
    if (!Array.isArray(record.windows) || typeof record.at !== 'number') {
      return null
    }
    const windows = record.windows.filter(
      (window): window is LimitWindow =>
        typeof window === 'object' &&
        window !== null &&
        typeof (window as LimitWindow).kind === 'string' &&
        typeof (window as LimitWindow).percentUsed === 'number',
    )

    return { windows, at: record.at }
  } catch {
    return null
  }
}

// The windows still running at `at`, in their usual order: a window past its reset holds no figure.
function current(windows: readonly LimitWindow[], at: number): LimitWindow[] {
  const rank = (kind: string) => {
    const index = KIND_ORDER.indexOf(kind)

    return index === -1 ? KIND_ORDER.length : index
  }

  return windows
    .filter(window => window.resetsAt === undefined || !(Date.parse(window.resetsAt) <= at))
    .sort((a, b) => rank(a.kind) - rank(b.kind))
}

// The same steps as the context meter: green, amber from 60%, red from 80%.
function toneOf(percent: number): ThemeKey {
  if (percent >= 80) {
    return 'error'
  }

  return percent >= 60 ? 'warning' : 'success'
}

// "in 2h 10m", "in 3d 4h": rounded up to the minute.
function untilText(resetsAt: string, at: number): string {
  const ms = Date.parse(resetsAt) - at
  if (Number.isNaN(ms)) {
    return ''
  }
  if (ms <= 0) {
    return 'now'
  }
  const minutes = Math.ceil(ms / 60_000)
  if (minutes < 60) {
    return `in ${minutes}m`
  }
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    const rest = minutes % 60

    return rest === 0 ? `in ${hours}h` : `in ${hours}h ${rest}m`
  }
  const days = Math.floor(hours / 24)
  const rest = hours % 24

  return rest === 0 ? `in ${days}d` : `in ${days}d ${rest}h`
}

async function homePath($: EngineInterface, relative: string): Promise<string> {
  const home = await $.env.get('HOME')
  if (home === undefined || home === '') {
    throw new Error('HOME is not set')
  }

  return `${home.replace(/\/$/, '')}/${relative}`
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
