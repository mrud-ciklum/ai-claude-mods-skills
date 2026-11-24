import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

const MOD_NAME = 'away-ping'
const isOn = atom({ plugin: 'away-ping', key: 'isOn' } as const, true)
const switchSeenAt = atom({ plugin: 'away-ping', key: 'switchSeenAt' } as const, -1)
const isQuiet = atom({ plugin: 'away-ping', key: 'isQuiet' } as const, false)
const switchedOff = atom({ plugin: 'away-ping', key: 'switchedOff' } as const, [])

// The Long turn choices of the Mods panel, in milliseconds.
export const AFTER: Record<string, number> = { '1 min': 60_000, '5 min': 300_000, '15 min': 900_000 }

// The question an answer ends with, when it ends with one: its last sentence, if that asks.
export function closingQuestion(answer: string): string | undefined {
  const prose = answer.replace(/```[\s\S]*?```/g, ' ').trim()
  const last = prose.split(/\n+/).filter(line => line.trim() !== '').at(-1)?.trim() ?? ''
  const sentence = last.split(/(?<=[.!])\s+/).at(-1)?.trim() ?? ''

  return sentence.endsWith('?') ? sentence.replace(/^[-*>\s]+/, '').slice(0, 200) : undefined
}

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

const minutes = (ms: number) => `${Math.max(1, Math.round(ms / 60_000))} min`

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await watchSwitch($)

    return next(e)
  })

  // When the main loop's turn ends: a question for the person, or a long run done, is sent to their own channel.
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined || e.reason !== 'answer' || !(await read($, isOn))) return done
    const question = closingQuestion(e.answer)
    const after = AFTER[(await modSetting($, 'after')) ?? '5 min']
    const isLong = after !== undefined && e.durationMs >= after
    if (question !== undefined) await $.ui.notify(question, { title: 'Claude asks' }).catch(() => undefined)
    else if (isLong) await $.ui.notify(`Done after ${minutes(e.durationMs)}: ${e.answer.trim().split('\n')[0]?.slice(0, 160) ?? ''}`, { title: 'Claude finished' }).catch(() => undefined)

    return done
  }).catch(($, e, next) => next(e))
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
