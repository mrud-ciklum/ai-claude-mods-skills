import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, TurnUsage } from 'claude-code'

const MOD_NAME = 'mod-turn-stats'
const isOn = atom({ plugin: 'mod-turn-stats', key: 'isOn' } as const, true)
const switchSeenAt = atom({ plugin: 'mod-turn-stats', key: 'switchSeenAt' } as const, -1)
const isQuiet = atom({ plugin: 'mod-turn-stats', key: 'isQuiet' } as const, false)
const switchedOff = atom({ plugin: 'mod-turn-stats', key: 'switchedOff' } as const, [])
const carried = atom({ plugin: 'mod-turn-stats', key: 'carried' } as const, null)
const turnStart = atom({ plugin: 'mod-turn-stats', key: 'turnStart' } as const, null)
const tools = atom({ plugin: 'mod-turn-stats', key: 'tools' } as const, 0)

// Turns shorter than this get no line: a quick answer needs no account.
const SHORT_TURN_MS = 10_000

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await watchSwitch($)

    return started
  })
  on('turn.start', async ($, e, next) => {
    const started = await next(e)
    const before = await read($, carried)
    await update($, turnStart, () => ({ tokens: before, tools: 0 }))
    await update($, tools, () => 0)

    return started
  })

  on('turn.step', async function* ($, e, next) {
    const response = yield* next(e)
    if (e.agentId === undefined && response.usage !== null) {
      const usage: TurnUsage = response.usage
      await update($, carried, () => usage.input_tokens + usage.cache_creation_input_tokens + usage.cache_read_input_tokens)
    }

    return response
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (e.agentId === undefined) {
      await update($, tools, count => count + 1)
    }

    return ran
  }).catch(($, e, next) => next(e))

  // A text other than the answer shows beneath it, on every surface.
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined || e.durationMs < SHORT_TURN_MS || !(await read($, isOn))) {
      return done
    }
    const start = await read($, turnStart)
    const now = await read($, carried)
    const added = start?.tokens === null || start?.tokens === undefined || now === null ? null : now - start.tokens
    const count = await read($, tools)
    const parts = [
      `⏱ ${duration(e.durationMs)}`,
      added === null ? '' : added >= 0 ? `+${kilo(added)} context` : `−${kilo(-added)} context (compacted)`,
      count === 0 ? '' : `${count} ${plural(count, 'tool', 'tools')}`,
    ].filter(Boolean)

    return { ...done, text: parts.join(' · ') }
  }).catch(($, e, next) => next(e))
}

function duration(ms: number): string {
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) {
    return `${seconds}s`
  }
  const minutes = Math.floor(seconds / 60)

  return minutes < 60 ? `${minutes}m ${seconds % 60}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

function kilo(count: number): string {
  if (count >= 10_000) {
    return `${Math.round(count / 1_000)}k`
  }

  return count >= 1_000 ? `${(count / 1_000).toFixed(1).replace(/\.0$/, '')}k` : String(count)
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many
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
