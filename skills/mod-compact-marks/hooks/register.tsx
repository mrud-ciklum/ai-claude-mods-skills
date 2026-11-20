import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, TurnUsage } from 'claude-code'

const MOD_NAME = 'mod-compact-marks'
const isOn = atom({ plugin: 'mod-compact-marks', key: 'isOn' } as const, true)
const switchSeenAt = atom({ plugin: 'mod-compact-marks', key: 'switchSeenAt' } as const, -1)
const isQuiet = atom({ plugin: 'mod-compact-marks', key: 'isQuiet' } as const, false)
const switchedOff = atom({ plugin: 'mod-compact-marks', key: 'switchedOff' } as const, [])
const percent = atom({ plugin: 'mod-compact-marks', key: 'percent' } as const, null)
const lastCompaction = atom({ plugin: 'mod-compact-marks', key: 'lastCompaction' } as const, null)

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await watchSwitch($)

    return started
  })
  on('session.measure', async ($, e, next) => {
    const measured = await next(e)
    if (e.context.percent !== undefined) {
      const shown = e.context.percent
      await update($, percent, () => shown)
    }

    return measured
  }).catch(($, e, next) => next(e))

  on('turn.step', async function* ($, e, next) {
    const response = yield* next(e)
    if (e.agentId === undefined && response.usage !== null) {
      const usage: TurnUsage = response.usage
      const window = (await $.session.usage()).context.window
      const tokens = usage.input_tokens + usage.cache_creation_input_tokens + usage.cache_read_input_tokens
      await update($, percent, () => (window > 0 ? Math.round((tokens / window) * 100) : null))
    }

    return response
  })

  // A main compaction: what the window held before, and the estimate after.
  on('session.compact', async ($, e, next) => {
    const before = await read($, percent)
    const compacted = await next(e)
    if (e.trigger === 'precompute' || e.agentId !== undefined || compacted.skip !== undefined) {
      return compacted
    }
    const after = await estimate($)
    await update($, lastCompaction, () => ({ before, after }))
    await update($, percent, () => after)
    if (e.trigger === 'auto' && (await read($, isOn))) {
      await $.ui.toast(`Auto-compact: ${mark({ before, after })}`)
    }

    return compacted
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'CommandOutput' }, async ($, e, next) => {
    const last = await read($, lastCompaction)
    if (e.props.command !== 'compact' || last === null || !(await read($, isOn))) {
      return next(e)
    }
    const { Box, Text } = $.ui.resolve(e)

    return (
      <Box flexDirection="column">
        {await next(e)}
        <Text color="suggestion">{mark(last)}</Text>
      </Box>
    )
  })
}

async function estimate($: EngineInterface): Promise<number | null> {
  try {
    const { context } = await $.session.usage({ breakdown: 'summary' })

    return context.breakdown === undefined ? null : context.breakdown.percentage
  } catch {
    return null
  }
}

function mark(last: { before: number | null; after: number | null }): string {
  return `context ${last.before === null ? '?' : `${last.before}%`} → ${last.after === null ? '?' : `~${last.after}%`}`
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
