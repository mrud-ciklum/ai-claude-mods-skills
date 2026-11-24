import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

const MOD_NAME = 'retry-stop'
const isOn = atom({ plugin: 'retry-stop', key: 'isOn' } as const, true)
const switchSeenAt = atom({ plugin: 'retry-stop', key: 'switchSeenAt' } as const, -1)
const isQuiet = atom({ plugin: 'retry-stop', key: 'isQuiet' } as const, false)
const switchedOff = atom({ plugin: 'retry-stop', key: 'switchedOff' } as const, [])

// Two failures of one command in a row, with nothing edited between: the third run is refused.
export const FAILURES_ALLOWED = 2
// The tools that change files: one of them between two runs is a reason to run the command again.
const EDITS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit'])

// The command as compared: the same words with any spacing.
export const sameCommand = (command: string) => command.trim().replace(/\s+/g, ' ')

// The last shell command of each agent (the main loop is "main"), and how many times in a row it failed.
const streaks = new Map<string, { command: string; failures: number }>()

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await watchSwitch($)

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const loop = e.agentId ?? 'main'
    if (String(e.tool) !== 'Bash') {
      if (EDITS.has(String(e.tool))) streaks.delete(loop)

      return next(e)
    }
    if (!(await read($, isOn))) return next(e)
    const command = sameCommand(String((e as { command?: unknown }).command ?? ''))
    const streak = streaks.get(loop)
    if (streak?.command === command && streak.failures >= FAILURES_ALLOWED)
      return {
        deny: `retry-stop: this command failed ${streak.failures} times in a row, and nothing was edited since. Read its error and change something first: the command, a file, or the approach. If running it again as it is would help, tell the user why.`,
      }
    const ran = await next(e)
    // A run another guard refused did not fail on its own.
    if (ran.deny === undefined && ran.isError === true) streaks.set(loop, { command, failures: streak?.command === command ? streak.failures + 1 : 1 })
    else if (ran.deny === undefined) streaks.delete(loop)

    return ran
  }).catch(($, e, next) => next(e)) // a guard of time: if it fails, the command goes on
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
