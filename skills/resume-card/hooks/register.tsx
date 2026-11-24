import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Recap } from '../types'

const MOD_NAME = 'resume-card'
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

// "3 h ago", "yesterday", "5 days ago": how long since a session last wrote.
export function ago(at: number, now: number): string {
  const minutes = Math.max(0, Math.round((now - at) / 60_000))
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  const days = Math.round(hours / 24)

  return days === 1 ? 'yesterday' : `${days} days ago`
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

  // One line above the prompt: when the last session here ended and what it left.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const found = await read($, recaps)
    if (e.props.hasSurvey || !(await read($, isOn)) || (await read($, isHidden)) || !found || found.length === 0) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const last = found[0] as Recap
    const now = await $.clock.now()

    return (
      <Box justifyContent="space-between" columnGap={2}>
        <Box columnGap={1} flexShrink={1}>
          <Text bold>Last time here</Text>
          <Text dimColor>{ago(last.at, now)}</Text>
          <Text wrap="truncate-end">{last.recap}</Text>
        </Box>
        <Box columnGap={1} flexShrink={0}>
          <Button key="resume-more" label={found.length > 1 ? `${found.length - 1} more` : 'Open'} dimColor onPress={() => void $.ui.open({ id: PANE, title: 'Last time here' })} />
          <Button key="resume-hide" label="Hide" dimColor onPress={() => update($, isHidden, () => true)} />
        </Box>
      </Box>
    )
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
