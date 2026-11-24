import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { BIG_FILE_BYTES, fullPath, heavyReasons, preflightReasons, readFiles, refusal } from './rules'

const MOD_NAME = 'bash-guard'
const isOn = atom({ plugin: 'bash-guard', key: 'isOn' } as const, true)
const switchSeenAt = atom({ plugin: 'bash-guard', key: 'switchSeenAt' } as const, -1)
const isQuiet = atom({ plugin: 'bash-guard', key: 'isQuiet' } as const, false)
const switchedOff = atom({ plugin: 'bash-guard', key: 'switchedOff' } as const, [])

// A choice of this mod's own in the Mods panel, read when it is needed: the shared file's modSettings.
async function modSetting($: EngineInterface, key: string): Promise<string | undefined> {
  const home = await $.env.get('HOME')
  if (!home) return undefined
  const text = await $.fs.read(`${home.replace(/\/$/, '')}/${SWITCHES_FILE}`).catch(() => '')
  try {
    const value = (JSON.parse(text) as { modSettings?: Record<string, Record<string, unknown>> }).modSettings?.[MOD_NAME]?.[key]

    return typeof value === 'string' ? value : undefined
  } catch {
    return undefined
  }
}

const sizeText = (bytes: number) => (bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`)

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await watchSwitch($)

    return next(e)
  })

  // Every shell command passes here first. What would run for minutes for nothing is refused
  // with the reason; anything else goes on untouched.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (!(await read($, isOn))) return next(e)
    const home = (await $.env.get('HOME').catch(() => undefined)) || undefined
    const reasons = heavyReasons(e.command, home)
    const names = readFiles(e.command)
    if (names.length > 0) {
      const cwd = await $.session.cwd().catch(() => undefined)
      for (const name of names) {
        const path = fullPath(name, home, cwd)
        const stat = path === undefined ? undefined : await $.fs.stat(path).catch(() => undefined)
        if (stat?.kind === 'file' && stat.size > BIG_FILE_BYTES)
          reasons.push(`it reads ${name} whole, ${sizeText(stat.size)}: it runs for minutes. Take a part of it first (head, a streaming script that writes a small file), then search that.`)
      }
    }
    if (e.run_in_background === true && (await modSetting($, 'preflight')) !== 'off') reasons.push(...preflightReasons(e.command))

    return reasons.length === 0 ? next(e) : { deny: refusal(reasons) }
  }).catch(($, e, next) => next(e)) // a guard of time, not of safety: if it fails, the command goes on
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
