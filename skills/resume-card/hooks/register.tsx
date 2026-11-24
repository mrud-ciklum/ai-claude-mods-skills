import { atom, read, update } from 'claude-code'
import type { ElementTable, EngineInterface, Register, RenderElement, ThemeKey } from 'claude-code'

import type { Recap } from '../types'

const MOD_NAME = 'resume-card'
// Its place among the band's pieces, as its card's order.
const MOD_ORDER = 22
const isOn = atom({ plugin: 'resume-card', key: 'isOn' } as const, true)
const switchSeenAt = atom({ plugin: 'resume-card', key: 'switchSeenAt' } as const, -1)
const isQuiet = atom({ plugin: 'resume-card', key: 'isQuiet' } as const, false)
const switchedOff = atom({ plugin: 'resume-card', key: 'switchedOff' } as const, [])
const recaps = atom({ plugin: 'resume-card', key: 'recaps' } as const, null as Recap[] | null)
const isHidden = atom({ plugin: 'resume-card', key: 'isHidden' } as const, false)

const PANE = 'resume-card'
// Sessions older than this are not "last time".
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000
// How many summaries the pane shows, and how many transcripts are read to find them.
const KEPT = 3
const READ_AT_MOST = 8
// The end of a transcript is read, not all of it: a session's last summary is near its end.
const TAIL_BYTES = 512 * 1024

const slug = (path: string) => path.replace(/[^A-Za-z0-9]/g, '-')

// The folder that holds this folder's transcripts: the working folder's, or a folder above it.
async function transcriptsDir($: EngineInterface): Promise<string | undefined> {
  const home = await $.env.get('HOME')
  if (!home) return undefined
  const config = (await $.env.get('CLAUDE_CONFIG_DIR')) || `${home}/.claude`
  let at = await $.session.cwd()
  for (let i = 0; i < 12 && at !== ''; i++) {
    const dir = `${config}/projects/${slug(at)}`
    if (await $.fs.exists(dir).catch(() => false)) return dir
    at = at.slice(0, at.lastIndexOf('/'))
  }

  return undefined
}

// The last summary a transcript holds: the input of its last wrap-up call (the app's recap of a turn).
export function lastRecap(tail: string): Omit<Recap, 'at'> | undefined {
  const lines = tail.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] ?? ''
    if (!line.includes('wrap_up')) continue
    try {
      const row = JSON.parse(line) as { message?: { content?: unknown } }
      const content = Array.isArray(row.message?.content) ? (row.message?.content as Record<string, unknown>[]) : []
      for (const block of [...content].reverse()) {
        const input = block.input as Record<string, unknown> | undefined
        if (block.type === 'tool_use' && typeof block.name === 'string' && block.name.endsWith('wrap_up') && typeof input?.recap === 'string' && input.recap.trim() !== '')
          return { recap: input.recap.trim(), ...(typeof input.ask === 'string' && input.ask.trim() !== '' ? { ask: input.ask.trim() } : {}) }
      }
    } catch {
      // the first line of a tail is usually cut: not a row
    }
  }

  return undefined
}

// The summaries the newest earlier sessions in this folder left, newest first.
async function findRecaps($: EngineInterface): Promise<Recap[]> {
  const dir = await transcriptsDir($)
  if (dir === undefined) return []
  const own = `${await $.session.id().catch(() => '')}.jsonl`
  const now = await $.clock.now()
  const files = (await $.fs.list(dir))
    .filter(f => f.kind === 'file' && f.name.endsWith('.jsonl') && f.name !== own && now - f.mtimeMs < MAX_AGE_MS)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, READ_AT_MOST)
  const out: Recap[] = []
  for (const f of files) {
    if (out.length >= KEPT) break
    const offset = Math.max(0, f.size - TAIL_BYTES)
    const tail = await $.fs.read(`${dir}/${f.name}`, { offset, length: TAIL_BYTES }).catch(() => '')
    const found = lastRecap(typeof tail === 'string' ? tail : '')
    if (found) out.push({ at: f.mtimeMs, ...found })
  }

  return out
}

// How long ago, in the band's figure column of five: "5m", "3h", "2d".
export function shortAgo(at: number, now: number): string {
  const minutes = Math.max(0, Math.round((now - at) / 60_000))
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)

  return hours < 24 ? `${hours}h` : `${Math.round(hours / 24)}d`
}

// "3 h ago", "yesterday", "5 days ago": how long since a session last wrote.
export function ago(at: number, now: number): string {
  const minutes = Math.max(0, Math.round((now - at) / 60_000))
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  const days = Math.round(hours / 24)

  return days === 1 ? 'yesterday' : `${days} days ago`
}

// A text cut to one line of `room` characters: the band keeps every row to one line.
const oneLine = (text: string, room: number) => {
  const flat = text.replace(/\s+/g, ' ').trim()
  const fit = Math.max(16, room)

  return flat.length > fit ? `${flat.slice(0, fit - 1)}…` : flat
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await watchSwitch($)
    // A session resumed or cleared keeps what it had; a new one reads the folder's last sessions.
    if ((await read($, recaps)) === null) {
      const found = await findRecaps($).catch(() => [])
      await update($, recaps, () => found)
    }

    return started
  })

  // The first prompt of the session: the person has picked up, and the card steps aside.
  on('prompt.submit', async ($, e, next) => {
    if (e.origin?.kind === 'composer' && !(await read($, isHidden))) await update($, isHidden, () => true)

    return next(e)
  }).catch(($, e, next) => next(e))

  // One row in the band, on its grid, above the task: when the last session here ended and what it left.
  on('ui.render', { component: 'AbovePrompt', plugin: 'context-band' }, async ($, e, next) => {
    const inner = await next(e)
    const found = await read($, recaps)
    if (e.props.hasSurvey || !(await read($, isOn)) || (await read($, isHidden)) || !found || found.length === 0) return inner
    const ui = $.ui.resolve(e)
    const { Box, Button } = ui
    const columns = e.props.bodyColumns
    const last = found[0] as Recap
    const now = await $.clock.now()
    const piece = (
      <Box key={pieceKey('section', MOD_ORDER, MOD_NAME)} justifyContent="space-between" columnGap={2}>
        {gridRow(ui, { name: 'Last time', figure: shortAgo(last.at, now), lines: [{ text: oneLine(last.recap, columns - GRID_NAME - GRID_FIGURE - 24), isDim: true }] }, columns)}
        <Box gap={1} flexShrink={0}>
          <Button key="resume-more" label={found.length > 1 ? `${found.length - 1} more` : 'Open'} dimColor onPress={() => void $.ui.open({ id: PANE, title: 'Last time here' })} />
          <Button key="resume-hide" label="Hide" dimColor onPress={() => update($, isHidden, () => true)} />
        </Box>
      </Box>
    )

    return placeInBand(ui, inner, SECTIONS_SLOT, piece, columns)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const found = (await read($, recaps)) ?? []
    const now = await $.clock.now()
    if (found.length === 0) return <Text dimColor>No earlier session in this folder left a summary in the last 14 days.</Text>

    return (
      <Box flexDirection="column" gap={1}>
        {found.map(r => (
          <Box flexDirection="column">
            <Text bold>{ago(r.at, now)}</Text>
            <Text>{r.recap}</Text>
            {r.ask ? <Text dimColor>It asked: {r.ask}</Text> : null}
          </Box>
        ))}
      </Box>
    )
  })
}

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

// ---- band layout (shared block) ----
// The engine runs the family's band hooks in an order no mod controls, so the
// band (context-band) draws three keyed slots in its middle wherever it stands:
// CHIPS_SLOT, the one line of readings, each a chip keyed `chip:NN:<mod>`;
// METERS_SLOT under it, for pieces keyed `meter:NN:<mod>` (a reading's card,
// shown while the pointer is on its chip, waits hidden there: placeReadings puts
// both); and SECTIONS_SLOT above the task row, for pieces keyed
// `section:NN:<mod>`. NN is the mod's order, and a slot keeps its pieces in key
// order. A mod that finds the band in what lies beneath it puts its piece into
// the slot; one that does not stacks the piece around it, and the band, when it
// stands outside, moves the stacked pieces into its slots.
// When the person set the band's height, the slots sit in a middle keyed
// `FIT_PREFIX<rows>` that keeps to at most that many rows: a piece put in refits
// it, what runs past the end leaves from the bottom, and a note keyed
// `NOTE_PREFIX<rows out>` says how many rows are out. A band with less to show
// is shorter, never padded.
// The note is a button keyed SHOW_ALL_KEY whoever draws it: the band hears its
// press and gives the height back to auto.
// This block is pasted unchanged into each mod that draws in the band.
const CHIPS_SLOT = 'context-band:chips'
const METERS_SLOT = 'context-band:meters'
const SECTIONS_SLOT = 'context-band:sections'
const FIT_PREFIX = 'context-band:fit:'
const NOTE_PREFIX = 'context-band:note:'
const SHOW_ALL_KEY = 'band-show-all'
// Cells between two chips on their line.
const CHIP_GAP = 2
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
type BandReading = { row: GridRow; chip: GridChip }

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
// fits, then a note of the rows left out. A column that runs past the end is cut
// inside; the slots stay, empty if need be, so a mod placing later still finds
// them, and the engine's own nodes always stay: a surface draws its part there.
// A middle fitted before keeps its count.
function fitBand(ui: ElementTable, middle: unknown, rows: number, columns: number): RenderElement {
  const { Box, Button } = ui
  const tree = (typeof middle === 'object' && middle !== null ? middle : {}) as TreeNode
  const all = flatNodes(Array.isArray(tree.children) ? tree.children : [])
  const noteKey = all.map(keyOf).find(key => key?.startsWith(NOTE_PREFIX) === true)
  const outBefore = noteKey === undefined ? 0 : Number(noteKey.slice(NOTE_PREFIX.length)) || 0
  const content = all.filter(child => keyOf(child)?.startsWith(NOTE_PREFIX) !== true)
  const room = Math.max(0, rows)
  const total = rowsOf(content, columns)
  const isWhole = outBefore === 0 && total <= room
  const cut = isWhole ? { kept: content, used: total } : trimRows(content, Math.max(0, room - 1), columns)
  const out = outBefore + total - cut.used
  const noteRows = out > 0 && room > 0 ? 1 : 0

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
