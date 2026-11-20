import { atom, read, update } from 'claude-code'
import type { ElementTable, EngineInterface, Register, RenderElement, ThemeKey } from 'claude-code'

import type { PullState, TreeState } from '../types'

const MOD_NAME = 'mod-git'
// Its place in the mods panel, which also orders its rows among the band's meters.
const MOD_ORDER = 6
const isOn = atom({ plugin: 'mod-git', key: 'isOn' } as const, true)
const switchSeenAt = atom({ plugin: 'mod-git', key: 'switchSeenAt' } as const, -1)
const isQuiet = atom({ plugin: 'mod-git', key: 'isQuiet' } as const, false)
const switchedOff = atom({ plugin: 'mod-git', key: 'switchedOff' } as const, [])
const tree = atom({ plugin: 'mod-git', key: 'tree' } as const, null)
const pull = atom({ plugin: 'mod-git', key: 'pull' } as const, null)
const pullAt = atom({ plugin: 'mod-git', key: 'pullAt' } as const, 0)

// The tree is local and cheap; the pull request is a network call, asked for rarely and shared by
// the sessions of one folder through this file under HOME.
const TREE_POLL_MS = 20_000
const PULL_EVERY_MS = 3 * 60_000
const PULL_CACHE = '.claude/mods/pulls.json'
const PULL_FIELDS = 'number,title,state,isDraft,reviewDecision,statusCheckRollup,comments,url'
const REVIEW_WORDS: Readonly<Record<string, string>> = {
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'changes requested',
  REVIEW_REQUIRED: 'review pending',
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await watchSwitch($)
    await readTree($)
    await readPull($)
    $.clock.every(TREE_POLL_MS, () => {
      void readTree($)
      void readPull($)
    })

    return started
  })

  // A commit, a checkout or a push the model ran shows at once, not at the next poll.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    const command = typeof e.command === 'string' ? e.command : ''
    if (/\bgit\b/.test(command)) {
      await readTree($)
    }
    if (/\bgh\s+pr\b|\bgit\s+push\b/.test(command)) {
      await readPull($, true)
    }

    return ran
  }).catch(($, e, next) => next(e))

  // Rows on the band's grid, among the meters.
  // Drawn into the band's row (context-band), not a row of this mod's own: the engine
  // gives each plugin its own row, and only the band's row holds the slots that
  // keep every reading on one line.
  on('ui.render', { component: 'AbovePrompt', plugin: 'context-band' }, async ($, e, next) => {
    const inner = await next(e)
    const state = await read($, tree)
    if (e.props.hasSurvey || state === null || !(await read($, isOn))) {
      return inner
    }
    const request = await read($, pull)
    const quiet = await read($, isQuiet)
    const ui = $.ui.resolve(e)
    // The tree and the pull request are chips until the branch falls behind or the PR needs a look.
    const readings: BandReading[] = []
    const isTreeNotable = state.behind !== null && state.behind > 0
    if (!quiet || isTreeNotable) {
      const changes = state.changed + state.untracked
      const figure = changes === 0 ? '✓' : String(changes)
      const color = changes === 0 ? 'success' : 'warning'
      readings.push({
        needsLook: isTreeNotable,
        chip: { name: 'Git', figure, color },
        row: { name: 'Git', figure, color, lines: [{ text: treeText(state), isDim: true }] },
      })
    }
    if (request !== null && (!quiet || pullNeedsLook(request))) {
      const figure = `#${request.number}`
      readings.push({
        needsLook: pullNeedsLook(request),
        chip: { name: 'PR', figure, color: pullTone(request) },
        row: { name: 'PR', figure, color: pullTone(request), lines: [{ text: pullLine(request), isDim: true }] },
      })
    }
    if (readings.length === 0) {
      return inner
    }

    return placeReadings(ui, inner, readings, MOD_ORDER, MOD_NAME, e.props.bodyColumns)
  })
}

async function readTree($: EngineInterface): Promise<void> {
  try {
    const cwd = await $.session.cwd()
    const ran = await $.process.run(['git', '-C', cwd, 'status', '--porcelain=v2', '--branch'], { timeoutMs: 15_000 })
    const parsed = ran.exitCode === 0 ? parseStatus(ran.stdout) : null
    await update($, tree, () => parsed)
  } catch (error) {
    $.ui.log(`mod-git: could not read the git status: ${messageOf(error)}`, { to: 'debug' })
  }
}

// The branch's pull request: from the shared cache while fresh, else asked of GitHub;
// forced after a push or a gh pr command, which may have changed it.
async function readPull($: EngineInterface, isForced = false): Promise<void> {
  try {
    const now = await $.clock.now()
    if (!isForced && now - (await read($, pullAt)) < PULL_EVERY_MS) {
      return
    }
    await update($, pullAt, () => now)
    const cwd = await $.session.cwd()
    const branch = (await read($, tree))?.branch ?? ''
    const cacheKey = `${cwd}#${branch}`
    const cachePath = `${await homeOf($)}/${PULL_CACHE}`
    const cache = await readCache($, cachePath)
    const cached = cache[cacheKey]
    if (!isForced && cached !== undefined && now - cached.at < PULL_EVERY_MS) {
      await update($, pull, () => cached.pull)

      return
    }
    const ran = await $.process.run(['gh', 'pr', 'view', '--json', PULL_FIELDS], { cwd, timeoutMs: 30_000 })
    const found = ran.exitCode === 0 ? parsePull(ran.stdout) : null
    await update($, pull, () => found)
    await $.fs.write(cachePath, JSON.stringify({ ...cache, [cacheKey]: { at: now, pull: found } }))
  } catch (error) {
    $.ui.log(`mod-git: could not read the pull request: ${messageOf(error)}`, { to: 'debug' })
  }
}

async function readCache($: EngineInterface, path: string): Promise<Record<string, { at: number; pull: PullState | null }>> {
  if (!(await $.fs.exists(path))) {
    return {}
  }
  try {
    const data: unknown = JSON.parse(await $.fs.read(path))

    return typeof data === 'object' && data !== null ? (data as Record<string, { at: number; pull: PullState | null }>) : {}
  } catch {
    return {}
  }
}

function parseStatus(text: string): TreeState | null {
  let branch = ''
  let ahead: number | null = null
  let behind: number | null = null
  let changed = 0
  let staged = 0
  let untracked = 0
  for (const line of text.split('\n')) {
    if (line.startsWith('# branch.head ')) {
      branch = line.slice('# branch.head '.length).trim()
    } else if (line.startsWith('# branch.ab ')) {
      const counts = /\+(\d+)\s+-(\d+)/.exec(line)
      ahead = counts?.[1] === undefined ? null : Number(counts[1])
      behind = counts?.[2] === undefined ? null : Number(counts[2])
    } else if (line.startsWith('1 ') || line.startsWith('2 ') || line.startsWith('u ')) {
      changed += 1
      const xy = line.split(' ')[1] ?? '..'
      if (xy[0] !== '.') {
        staged += 1
      }
    } else if (line.startsWith('? ')) {
      untracked += 1
    }
  }

  return branch === '' ? null : { branch, ahead, behind, changed, staged, untracked }
}

function parsePull(text: string): PullState | null {
  try {
    const data = JSON.parse(text) as {
      number?: unknown
      title?: unknown
      state?: unknown
      isDraft?: unknown
      reviewDecision?: unknown
      statusCheckRollup?: unknown
      comments?: unknown
      url?: unknown
    }
    if (typeof data.number !== 'number') {
      return null
    }
    const checks = { passed: 0, failed: 0, pending: 0 }
    for (const check of Array.isArray(data.statusCheckRollup) ? data.statusCheckRollup : []) {
      const run = check as { conclusion?: unknown; status?: unknown; state?: unknown }
      const verdict = String(run.conclusion ?? run.state ?? '').toUpperCase()
      if (verdict === 'SUCCESS' || verdict === 'NEUTRAL' || verdict === 'SKIPPED') {
        checks.passed += 1
      } else if (verdict === 'FAILURE' || verdict === 'ERROR' || verdict === 'CANCELLED' || verdict === 'TIMED_OUT') {
        checks.failed += 1
      } else {
        checks.pending += 1
      }
    }

    return {
      number: data.number,
      title: typeof data.title === 'string' ? data.title : '',
      state: typeof data.state === 'string' ? data.state : 'OPEN',
      isDraft: data.isDraft === true,
      review: typeof data.reviewDecision === 'string' ? data.reviewDecision : '',
      checks,
      comments: Array.isArray(data.comments) ? data.comments.length : 0,
      url: typeof data.url === 'string' ? data.url : '',
    }
  } catch {
    return null
  }
}

// The branch and how far it is from its upstream, in one line: the figure counts the changes.
function treeText(state: TreeState): string {
  const sync =
    state.ahead === null || state.behind === null
      ? 'no upstream'
      : state.ahead === 0 && state.behind === 0
        ? ''
        : `↑${state.ahead} ↓${state.behind}`

  return [state.branch, sync].filter(Boolean).join(' · ')
}

// The pull request in one line: its state unless open, its checks, its review.
function pullLine(request: PullState): string {
  const state = request.state === 'MERGED' ? 'merged' : request.state === 'CLOSED' ? 'closed' : request.isDraft ? 'draft' : ''
  const { passed, failed, pending } = request.checks
  const total = passed + failed + pending
  const checks =
    total === 0 ? '' : `checks ${passed}/${total}${failed === 0 ? '' : `, ${failed} failed`}${pending === 0 ? '' : `, ${pending} running`}`

  return [state, checks, REVIEW_WORDS[request.review] ?? ''].filter(Boolean).join(' · ')
}

function pullNeedsLook(request: PullState): boolean {
  return request.state === 'OPEN' && (request.checks.failed > 0 || request.review === 'CHANGES_REQUESTED')
}

function pullTone(request: PullState): ThemeKey {
  if (request.state !== 'OPEN') {
    return 'subtle'
  }
  if (request.checks.failed > 0 || request.review === 'CHANGES_REQUESTED') {
    return 'error'
  }
  if (request.checks.pending > 0) {
    return 'warning'
  }

  return 'success'
}

async function homeOf($: EngineInterface): Promise<string> {
  const home = await $.env.get('HOME')
  if (home === undefined || home === '') {
    throw new Error('HOME is not set')
  }

  return home.replace(/\/$/, '')
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
