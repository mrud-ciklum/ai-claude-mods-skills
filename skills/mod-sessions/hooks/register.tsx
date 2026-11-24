import { atom, read, update } from 'claude-code'
import type { ElementTable, EngineInterface, Register, RenderElement, ThemeKey } from 'claude-code'

import type { SessionCard, SessionRunner } from '../types'

const MOD_NAME = 'mod-sessions'
// Its place in the mods panel, which also orders its section in the band.
const MOD_ORDER = 4
// The band's toolbar button this mod's card asks for: `section:sessions`.
const BUTTON = 'section:sessions'
const BAND = 'context-band'
const isOn = atom({ plugin: 'mod-sessions', key: 'isOn' } as const, true)
const switchSeenAt = atom({ plugin: 'mod-sessions', key: 'switchSeenAt' } as const, -1)
const isQuiet = atom({ plugin: 'mod-sessions', key: 'isQuiet' } as const, false)
const switchedOff = atom({ plugin: 'mod-sessions', key: 'switchedOff' } as const, [])
const sessions = atom({ plugin: 'mod-sessions', key: 'sessions' } as const, [])
const branches = atom({ plugin: 'mod-sessions', key: 'branches' } as const, {})
const hereId = atom({ plugin: 'mod-sessions', key: 'hereId' } as const, '')
const isOpen = atom({ plugin: 'mod-sessions', key: 'isOpen' } as const, false)
const workingSince = atom({ plugin: 'mod-sessions', key: 'workingSince' } as const, {})
const lastPromptAt = atom({ plugin: 'mod-sessions', key: 'lastPromptAt' } as const, 0)
const summary = atom({ plugin: 'mod-sessions', key: 'summary' } as const, null)
const isSummarizing = atom({ plugin: 'mod-sessions', key: 'isSummarizing' } as const, false)

// Each session's band writes its entry here, under HOME.
const REGISTRY_DIR = '.claude/context-band/sessions'
// A file not rewritten for this long belongs to a session that is gone.
const SILENT_AFTER_MS = 120_000
const POLL_MS = 15_000
// A turn this long that ended is worth telling the person about.
const NOTABLE_TURN_MS = 2 * 60_000
// After this long without a prompt here, the next one is a return: say what happened.
const AWAY_MS = 30 * 60_000
// The digest names this many sessions, then counts the rest; it stays this long.
const DIGEST_NAMES = 4
const DIGEST_MS = 20_000
// A session resting this long is drawn in amber.
const LONG_WAIT_MS = 10 * 60_000
// One sound per machine for one event: the first session to write it here plays it.
const ALERTS_LEDGER = '.claude/mods/alerts.json'
const LEDGER_KEEP_MS = 24 * 60 * 60_000
const WAITING_SOUND = 'sounds/waiting.aiff'
const SUMMARY_MODEL = 'haiku'
const SUMMARY_MESSAGES = 40
const SUMMARY_CHARS = 24_000
const REPORT_ASK = 'Briefly, for the sessions panel: what are you doing now, what is done and what is left? Three lines, no preamble.'
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
    const id = await $.session.id()
    await update($, hereId, () => id)
    await $.command.register({ name: 'sessions', description: 'Sessions: every live session, who waits for you, a report and a summary' })
    await poll($)
    $.clock.every(POLL_MS, () => {
      void poll($)
    })

    return started
  })

  on('command.run', { command: 'sessions' }, async $ => {
    const open = await update($, isOpen, current => !current)
    if (open) {
      await poll($)
    }

    return {}
  }).catch(() => ({ text: 'The session list did not open; details are in the debug log.' }))

  // The band's toolbar carries this mod's button; a press on another of its buttons closes the section.
  on('ui.press', { plugin: BAND }, async ($, e, next) => {
    const pressed = await next(e)
    if (e.element === BUTTON) {
      const open = await update($, isOpen, current => !current)
      if (open) {
        await poll($)
      }
    } else {
      await update($, isOpen, () => false)
    }

    return pressed
  }).catch(($, e, next) => next(e))

  // A prompt after a long absence: what finished, died or waits since the last one.
  on('prompt.submit', async ($, e, next) => {
    const submitted = await next(e)
    if (e.origin.kind === 'plugin' || e.origin.kind === 'task-notification') {
      return submitted
    }
    const now = await $.clock.now()
    const before = await read($, lastPromptAt)
    await update($, lastPromptAt, () => now)
    if (before > 0 && now - before >= AWAY_MS && (await read($, isOn))) {
      await poll($)
      const digest = awayDigest(await read($, sessions), await read($, hereId), before)
      if (digest !== null) {
        // The sessions it names are listed in the band at once, each with what it was asked and answered.
        if (digest.hasSessions) {
          await update($, isOpen, () => true)
        }
        await $.ui.toast(digest.text, { timeoutMs: DIGEST_MS })
      }
    }

    return submitted
  }).catch(($, e, next) => next(e))

  // Drawn into the band's row (context-band), not a row of this mod's own: the engine
  // gives each plugin its own row, and only the band's row holds the slots that
  // keep every reading on one line.
  on('ui.render', { component: 'AbovePrompt', plugin: 'context-band' }, async ($, e, next) => {
    const inner = await next(e)
    if (e.props.hasSurvey || !(await read($, isOpen)) || !(await read($, isOn))) {
      return inner
    }
    const ui = $.ui.resolve(e)
    const { Box, Button, Text } = ui
    const columns = e.props.bodyColumns
    const now = await $.clock.now()
    const here = await read($, hereId)
    const list = orderSessions(await read($, sessions), here)
    const branchOf = await read($, branches)
    const notes = await read($, summary)
    const isWriting = await read($, isSummarizing)
    const waiting = list.filter(card => card.sessionId !== here && isWaiting(card)).length
    const shared = sharedFolders(list)

    const sessionRow = (card: SessionCard) => {
      const isHere = card.sessionId === here
      const state = stateOf(card, isHere, now)
      const branch = branchOf[card.cwd]
      const live = card.runners.filter(runner => runner.endedAt === null).length
      const word = !isHere && isWaiting(card) ? lastWord(card) : null
      const lines = [
        { text: [baseName(card.cwd), branch].filter(Boolean).join(' · '), isBold: isHere },
        {
          text:
            card.task !== null
              ? `${card.task.title} · ${card.task.percent}%`
              : card.asked !== undefined && card.asked !== null && card.asked !== ''
                ? `asked: "${card.asked}"`
                : 'no task',
          isDim: true,
        },
        ...(word === null ? [] : [{ text: word }]),
        ...(live === 0 ? [] : [{ text: `${live} ${plural(live, 'runner', 'runners')}`, isDim: true }]),
        ...(shared.has(card.cwd) ? [{ text: '⚠ this folder is open in another session too', color: 'warning' as const }] : []),
      ]

      return (
        <Box justifyContent="space-between" columnGap={2}>
          {gridRow(
            ui,
            {
              name: state.label,
              nameColor: state.tone,
              figure: card.fill === undefined || card.fill === null ? '' : `${card.fill}%`,
              color: fillTone(card.fill ?? null),
              percent: card.fill ?? 0,
              barColor: card.fill === undefined || card.fill === null ? 'inactive' : fillTone(card.fill),
              lines,
            },
            columns,
          )}
          {!isHere && (
            <Button key={`report:${card.sessionId}`} label="Ask for a report" dimColor onPress={() => askReport($, card)} />
          )}
        </Box>
      )
    }

    const piece = (
      <Box key={pieceKey('section', MOD_ORDER, MOD_NAME)} flexDirection="column">
        <Box justifyContent="space-between" flexWrap="wrap" columnGap={2}>
          {gridRow(
            ui,
            {
              name: 'Sessions',
              isHeader: true,
              figure: '',
              lines: [
                { text: `${list.length} live · ${waiting} ${plural(waiting, 'waits', 'wait')} for you`, isDim: true },
                ...(waiting === 0
                  ? []
                  : [{ text: '"wait" - the session finished its work and stands until you write to it; switch to it in the session list', isDim: true }]),
              ],
            },
            columns,
          )}
          {isWriting ? (
            <Text dimColor>writing a summary</Text>
          ) : (
            <Button key="summary" label="Summarize this session" dimColor onPress={() => summarize($)} />
          )}
        </Box>
        {notes !== null && (
          <Box justifyContent="space-between" columnGap={2}>
            {gridRow(ui, { name: 'Summary', figure: '', lines: notes.map(text => ({ text: `• ${text}` })) }, columns)}
            <Box gap={1} flexShrink={0}>
              <Button key="summary-copy" label="Copy" dimColor onPress={() => copySummary($)} />
              <Button key="summary-hide" label="Hide" dimColor onPress={() => hideSummary($)} />
            </Box>
          </Box>
        )}
        {list.map(sessionRow)}
      </Box>
    )

    return placeInBand(ui, inner, SECTIONS_SLOT, piece, e.props.bodyColumns)
  })
}

// Reads every live session's entry, the branches of their folders, and tells of sessions that came to rest.
async function poll($: EngineInterface): Promise<void> {
  try {
    const home = await $.env.get('HOME')
    if (home === undefined || home === '') {
      return
    }
    const dir = `${home.replace(/\/$/, '')}/${REGISTRY_DIR}`
    if (!(await $.fs.exists(dir))) {
      return
    }
    const now = await $.clock.now()
    const found: SessionCard[] = []
    for (const file of await $.fs.list(dir)) {
      if (file.kind !== 'file' || !file.name.endsWith('.json') || now - file.mtimeMs >= SILENT_AFTER_MS) {
        continue
      }
      // A file gone between the listing and the read (its session ended) is skipped; the others still count.
      const card = parseCard(await $.fs.read(`${dir}/${file.name}`).catch(() => ''))
      if (card !== null && !card.isEnded && now - card.updatedAt < SILENT_AFTER_MS) {
        found.push(card)
      }
    }
    await update($, sessions, () => found)
    await readBranches($, found)
    await noticeRests($, found, now)
  } catch (error) {
    $.ui.log(`mod-sessions: could not read the sessions: ${messageOf(error)}`, { to: 'debug' })
  }
}

// A session that worked a while and has come to rest waits for the person: say so once.
async function noticeRests($: EngineInterface, found: readonly SessionCard[], now: number): Promise<void> {
  const here = await read($, hereId)
  const before = await read($, workingSince)
  const next: Record<string, number> = {}
  const rested: SessionCard[] = []
  for (const card of found) {
    if (card.turn === undefined || card.sessionId === here) {
      continue
    }
    if (card.turn.isWorking) {
      next[card.sessionId] = card.turn.since
    } else {
      const startedAt = before[card.sessionId]
      if (startedAt !== undefined && card.turn.since - startedAt >= NOTABLE_TURN_MS) {
        rested.push(card)
      }
    }
  }
  await update($, workingSince, () => next)
  if (!(await read($, isOn))) {
    return
  }
  for (const card of rested) {
    const word = lastWord(card)
    const text = `◌ ${sessionName(card)} finished and waits for you${word === null ? '' : ` - ${word}`}`
    await $.ui.toast(text)
    const settings = await soundSettings($)
    if ((settings.sounds || settings.voice) && (await claimSound($, `${card.sessionId}:rest:${card.turn?.since ?? now}`, now))) {
      try {
        if (settings.sounds) {
          await $.audio.play({ asset: WAITING_SOUND })
        }
        if (settings.voice) {
          await $.audio.speak(text.replace(/^◌\s*/, ''))
        }
      } catch (error) {
        $.ui.log(`mod-sessions: could not sound the waiting news: ${messageOf(error)}`, { to: 'debug' })
      }
    }
  }
}

// Each folder's checked-out branch, from its .git (a worktree's .git file points at its git dir).
async function readBranches($: EngineInterface, found: readonly SessionCard[]): Promise<void> {
  const known: Record<string, string> = {}
  for (const card of found) {
    try {
      let gitDir = `${card.cwd}/.git`
      if (!(await $.fs.exists(gitDir))) {
        continue
      }
      if ((await $.fs.stat(gitDir)).kind === 'file') {
        const pointer = /gitdir:\s*(.+)/.exec(await $.fs.read(gitDir))
        if (pointer?.[1] === undefined) {
          continue
        }
        // A worktree's or a submodule's pointer may be relative to the folder.
        const pointed = pointer[1].trim()
        gitDir = pointed.startsWith('/') ? pointed : joinPath(card.cwd, pointed)
      }
      const head = await $.fs.read(`${gitDir}/HEAD`)
      const branch = /ref:\s*refs\/heads\/(.+)/.exec(head)?.[1]?.trim()
      known[card.cwd] = branch ?? `detached ${head.trim().slice(0, 8)}`
    } catch {
      // A folder without a readable git head shows no branch.
    }
  }
  await update($, branches, () => known)
}

// `rel` read from the folder `base`, its `.` and `..` resolved.
function joinPath(base: string, rel: string): string {
  const parts: string[] = []
  for (const part of `${base}/${rel}`.split('/')) {
    if (part === '..') parts.pop()
    else if (part !== '' && part !== '.') parts.push(part)
  }

  return `/${parts.join('/')}`
}

async function askReport($: EngineInterface, card: SessionCard): Promise<void> {
  const sent = await $.session.send({ to: { sessionId: card.sessionId }, text: REPORT_ASK })
  await $.ui.toast(sent.isDelivered ? `Report requested: ${baseName(card.cwd)}` : `Not sent: ${sent.reason}`)
}

// Five points on this session from a small model: it spends a little of the subscription.
async function summarize($: EngineInterface): Promise<void> {
  if (await read($, isSummarizing)) {
    return
  }
  await update($, isSummarizing, () => true)
  try {
    const messages = (await $.session.messages()).slice(-SUMMARY_MESSAGES)
    const transcript = messages
      .map(message => `${message.role === 'user' ? 'User' : 'Assistant'}: ${message.text}`)
      .join('\n')
      .slice(-SUMMARY_CHARS)
    const prompt = [
      'Summarize this coding session for its owner in exactly five short English bullet points:',
      'what was asked, what is done, what is in progress, what is blocked, what comes next.',
      'One line each, starting with "- ", no preamble.',
      '',
      transcript,
    ].join('\n')
    const reply = await $.model.complete({ model: SUMMARY_MODEL, prompt, maxTokens: 500 })
    const points = reply.isAnswered
      ? reply.text
          .split('\n')
          .map(line => line.replace(/^\s*[-•*]\s*/, '').trim())
          .filter(line => line !== '')
          .slice(0, 5)
      : [`could not summarize (${reply.reason})`]
    await update($, summary, () => points)
  } catch (error) {
    await update($, summary, () => [`could not summarize: ${messageOf(error)}`])
  } finally {
    await update($, isSummarizing, () => false)
  }
}

async function copySummary($: EngineInterface): Promise<void> {
  const points = await read($, summary)
  if (points === null) {
    return
  }
  const copied = await $.ui.copy({ text: points.map(point => `- ${point}`).join('\n') })
  await $.ui.toast(copied.isCopied ? 'Copied' : `Not copied: ${copied.reason}`)
}

async function hideSummary($: EngineInterface): Promise<void> {
  await update($, summary, () => null)
}

// What happened while the person was away, in one line, naming the sessions
// that finished their work since and wait for an answer; null when nothing did.
function awayDigest(found: readonly SessionCard[], here: string, since: number): { text: string; hasSessions: boolean } | null {
  const ended = found.flatMap(card => card.runners.filter(runner => runner.endedAt !== null && runner.endedAt >= since))
  const dead = ended.filter(isDead).length
  const done = ended.length - dead
  const finished = found.filter(card => card.sessionId !== here && isWaiting(card) && (card.turn?.since ?? 0) >= since)
  const named = finished.slice(0, DIGEST_NAMES).map(sessionName).join('; ')
  const more = finished.length - DIGEST_NAMES
  const parts = [
    finished.length === 0
      ? ''
      : `${finished.length} ${plural(finished.length, 'session finished and waits', 'sessions finished and wait')} for your answer: ${named}${more > 0 ? ` and ${more} more` : ''}`,
    done === 0 ? '' : `${done} ${plural(done, 'runner done', 'runners done')}`,
    dead === 0 ? '' : `${dead} ${plural(dead, 'runner died', 'runners died')}`,
  ].filter(Boolean)
  if (parts.length === 0) {
    return null
  }
  const where = finished.length > 0 ? 'The list with details is in the band above the prompt, Sessions section.' : 'Details: the Runners button in the band.'

  return { text: `While you were away: ${parts.join(' · ')}. ${where}`, hasSessions: finished.length > 0 }
}

// A session that finished a turn and now waits for the person; one that never
// ran a turn since it opened only stands by.
function isWaiting(card: SessionCard): boolean {
  return card.turn !== undefined && !card.turn.isWorking && card.turn.since > 0
}

// A session as the person knows it: its folder and what it works on, or was last asked.
function sessionName(card: SessionCard): string {
  const subject = card.task?.title ?? card.asked ?? null

  return subject === null ? baseName(card.cwd) : `${baseName(card.cwd)} "${subject}"`
}

// How a waiting session's last turn ended, in a line: its answer's gist, or why it stopped.
function lastWord(card: SessionCard): string | null {
  if (card.ending === 'aborted') {
    return 'stopped mid-work'
  }
  if (card.ending === 'error') {
    return 'stopped on an error'
  }
  if (card.ending === 'refusal') {
    return 'the model refused to answer'
  }

  return card.said === undefined || card.said === null || card.said === '' ? null : `answered: ${card.said}`
}

function isDead(runner: SessionRunner): boolean {
  if (runner.status === 'failed' || runner.status === 'killed' || runner.status === 'error') {
    return true
  }
  const targets = runner.progress?.targets ?? []

  return targets.some(target => DEAD_WORDS.has(target.status)) && !targets.some(target => DONE_WORDS.has(target.status))
}

// This session first, then the ones waiting longest, then the ones at work, then the idle.
function orderSessions(list: readonly SessionCard[], here: string): SessionCard[] {
  const rank = (card: SessionCard) => (card.sessionId === here ? 0 : isWaiting(card) ? 1 : card.turn?.isWorking === true ? 2 : 3)

  return [...list].sort((a, b) => rank(a) - rank(b) || (a.turn?.since ?? 0) - (b.turn?.since ?? 0))
}

function stateOf(card: SessionCard, isHere: boolean, now: number): { label: string; tone: ThemeKey } {
  if (isHere) {
    return { label: '● this one', tone: 'claude' }
  }
  if (card.turn === undefined) {
    return { label: '● live', tone: 'subtle' }
  }
  if (card.turn.isWorking) {
    return { label: '● working', tone: 'suggestion' }
  }
  if (card.turn.since <= 0) {
    return { label: '○ idle', tone: 'subtle' }
  }
  const resting = now - card.turn.since

  return { label: `◌ wait ${ago(resting)}`, tone: resting >= LONG_WAIT_MS ? 'warning' : 'subtle' }
}

// Folders open in more than one live session: edits there can collide.
function sharedFolders(list: readonly SessionCard[]): Set<string> {
  const seen = new Map<string, number>()
  for (const card of list) {
    seen.set(card.cwd, (seen.get(card.cwd) ?? 0) + 1)
  }

  return new Set([...seen.entries()].filter(([, count]) => count > 1).map(([cwd]) => cwd))
}

function fillTone(percent: number | null): ThemeKey {
  if (percent === null) {
    return 'subtle'
  }
  if (percent >= 80) {
    return 'error'
  }

  return percent >= 60 ? 'warning' : 'success'
}

function parseCard(text: string): SessionCard | null {
  try {
    const value: unknown = JSON.parse(text)
    if (typeof value !== 'object' || value === null) {
      return null
    }
    const card = value as Partial<SessionCard>

    return typeof card.sessionId === 'string' &&
      typeof card.cwd === 'string' &&
      typeof card.updatedAt === 'number' &&
      Array.isArray(card.runners)
      ? (card as SessionCard)
      : null
  } catch {
    return null
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
    const data = JSON.parse(await $.fs.read(path)) as { settings?: { sounds?: unknown; voice?: unknown } }

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
      const data: unknown = JSON.parse(await $.fs.read(path))
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

// How long ago: 45s, 12m, 2h05m.
function ago(ms: number): string {
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

function baseName(path: string): string {
  return path.split('/').pop() ?? path
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

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
