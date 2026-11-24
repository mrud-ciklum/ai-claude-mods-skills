import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

const MOD_NAME = 'mod-mode-badge'
const isOn = atom({ plugin: 'mod-mode-badge', key: 'isOn' } as const, true)
const switchSeenAt = atom({ plugin: 'mod-mode-badge', key: 'switchSeenAt' } as const, -1)
const isQuiet = atom({ plugin: 'mod-mode-badge', key: 'isQuiet' } as const, false)
const switchedOff = atom({ plugin: 'mod-mode-badge', key: 'switchedOff' } as const, [])
const model = atom({ plugin: 'mod-mode-badge', key: 'model' } as const, '')
const effort = atom({ plugin: 'mod-mode-badge', key: 'effort' } as const, null)

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await watchSwitch($)
    const name = await $.session.model().catch(() => '')
    await update($, model, () => name)

    return started
  })
  // The model and effort the main loop's last request went out with.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) {
      const name = e.model
      const level = e.effort === undefined ? null : String(e.effort)
      await update($, model, () => name)
      await update($, effort, () => level)
    }

    return yield* next(e)
  })

  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const name = await read($, model)
    if (name === '' || !(await read($, isOn))) {
      return next(e)
    }
    const { Box, Text } = $.ui.resolve(e)
    const level = await read($, effort)

    return (
      <Box gap={1}>
        <Text color="claude" bold>
          {modelLabel(name)}
        </Text>
        {level !== null && <Text color="suggestion">{`effort ${level}`}</Text>}
        {e.props.modes.length > 0 && <Text dimColor>{e.props.modes.join(' & ')}</Text>}
      </Box>
    )
  })
}

// `claude-opus-5-5` reads as `Opus 5.5`, `claude-sonnet-4-20250514` as `Sonnet 4`: the date
// and a `[1m]` suffix are not part of the name. An id of another shape shows as it is.
export function modelLabel(id: string): string {
  const found = /claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?=-\d{8}|\[|$)/.exec(id)
  if (found === null) {
    return id
  }
  const family = found[1] ?? ''

  return `${family.charAt(0).toUpperCase()}${family.slice(1)} ${found[2]}${found[3] === undefined ? '' : `.${found[3]}`}`
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
