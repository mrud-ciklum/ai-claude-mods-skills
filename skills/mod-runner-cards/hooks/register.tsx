import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, ThemeKey } from 'claude-code'

import type { CardRunner } from '../types'

const MOD_NAME = 'mod-runner-cards'
const isOn = atom({ plugin: 'mod-runner-cards', key: 'isOn' } as const, true)
const switchSeenAt = atom({ plugin: 'mod-runner-cards', key: 'switchSeenAt' } as const, -1)
const isQuiet = atom({ plugin: 'mod-runner-cards', key: 'isQuiet' } as const, false)
const switchedOff = atom({ plugin: 'mod-runner-cards', key: 'switchedOff' } as const, [])
const runners = atom({ plugin: 'mod-runner-cards', key: 'runners' } as const, [])
const hereId = atom({ plugin: 'mod-runner-cards', key: 'hereId' } as const, '')

// This session's runners as its band published them, under HOME.
const REGISTRY_DIR = '.claude/context-band/sessions'
const POLL_MS = 10_000
const BAR_CELLS = 20
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
    await readRunners($)
    $.clock.every(POLL_MS, () => {
      void readRunners($)
    })

    return started
  })
  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    if ((e.props.tool !== 'Bash' && e.props.tool !== 'Agent') || !(await read($, isOn))) {
      return next(e)
    }
    const id = launchedId(e.props.output)
    const runner = id === null ? undefined : (await read($, runners)).find(candidate => candidate.id === id)
    if (runner === undefined) {
      return next(e)
    }
    const { Box, Text } = $.ui.resolve(e)
    const state = stateOf(runner)
    const percent = runner.progress?.percent ?? null

    return (
      <Box gap={1} flexWrap="wrap">
        <Text color={state.tone}>{state.label}</Text>
        <Text>{runner.info?.title ?? runner.description}</Text>
        {percent !== null && <Text color={state.tone}>{`${bar(percent)} ${percent}%`}</Text>}
        {countOf(runner) !== '' && <Text dimColor>{countOf(runner)}</Text>}
      </Box>
    )
  })
}

async function readRunners($: EngineInterface): Promise<void> {
  try {
    const home = await $.env.get('HOME')
    const id = await read($, hereId)
    if (home === undefined || home === '' || id === '') {
      return
    }
    const path = `${home.replace(/\/$/, '')}/${REGISTRY_DIR}/${id}.json`
    if (!(await $.fs.exists(path))) {
      return
    }
    const entry = JSON.parse(await $.fs.read(path)) as { runners?: unknown }
    const list = Array.isArray(entry.runners) ? (entry.runners as CardRunner[]) : []
    await update($, runners, () => list)
  } catch (error) {
    $.ui.log(`mod-runner-cards: could not read this session's runners: ${error instanceof Error ? error.message : String(error)}`, { to: 'debug' })
  }
}

// The background task id a launch result names: a shell's or an agent's.
function launchedId(output: unknown): string | null {
  if (typeof output !== 'object' || output === null) {
    return null
  }
  const record = output as { backgroundTaskId?: unknown; agentId?: unknown; status?: unknown }
  if (typeof record.backgroundTaskId === 'string') {
    return record.backgroundTaskId
  }

  return typeof record.agentId === 'string' && record.status === 'async_launched' ? record.agentId : null
}

function stateOf(runner: CardRunner): { label: string; tone: ThemeKey } {
  const targets = runner.progress?.targets ?? []
  const status = targets[targets.length - 1]?.status ?? null
  if (runner.endedAt !== null) {
    return runner.status === 'failed' || runner.status === 'killed' ? { label: '✕ died', tone: 'error' } : { label: '✓ done', tone: 'subtle' }
  }
  if (status !== null && DEAD_WORDS.has(status)) {
    return { label: '✕ died', tone: 'error' }
  }
  if (status !== null && DONE_WORDS.has(status)) {
    return { label: '✓ done', tone: 'success' }
  }

  return status === 'waiting' ? { label: '◌ runner waiting', tone: 'warning' } : { label: '● runner running', tone: 'suggestion' }
}

function countOf(runner: CardRunner): string {
  const counted = (runner.progress?.targets ?? []).find(target => target.done !== null && target.total !== null)

  return counted === undefined ? '' : `${counted.done}/${counted.total}`
}

function bar(percent: number): string {
  const filled = Math.max(0, Math.min(BAR_CELLS, Math.round((percent / 100) * BAR_CELLS)))

  return '█'.repeat(filled) + '░'.repeat(BAR_CELLS - filled)
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
