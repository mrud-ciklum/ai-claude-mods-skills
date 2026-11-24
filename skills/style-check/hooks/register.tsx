import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

const MOD_NAME = 'style-check'
const isOn = atom({ plugin: 'style-check', key: 'isOn' } as const, true)
const switchSeenAt = atom({ plugin: 'style-check', key: 'switchSeenAt' } as const, -1)
const isQuiet = atom({ plugin: 'style-check', key: 'isQuiet' } as const, false)
const switchedOff = atom({ plugin: 'style-check', key: 'switchedOff' } as const, [])
const pending = atom({ plugin: 'style-check', key: 'pending' } as const, [] as string[])

const EM_DASH = '\u2014'
// An answer shorter than this is not judged for its language: a "Done." says nothing.
const MIN_LETTERS = 80

// The prose of an answer: code blocks, inline code, links and paths set aside.
export const proseOf = (text: string) =>
  text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/(?:~|\.{0,2})?\/[\w./-]+/g, ' ')

// What an answer breaks: em dashes in its prose, and a language other than the one picked.
export function findings(answer: string, language: string): string[] {
  const prose = proseOf(answer)
  const out: string[] = []
  const dashes = prose.split(EM_DASH).length - 1
  if (dashes > 0) out.push(`${dashes} em ${dashes === 1 ? 'dash' : 'dashes'}; write "-" instead`)
  const letters = prose.match(/\p{L}/gu) ?? []
  if (letters.length >= MIN_LETTERS && (language === 'uk' || language === 'en')) {
    const cyrillic = letters.filter(ch => /\p{Script=Cyrillic}/u.test(ch)).length / letters.length
    if (language === 'uk' && cyrillic < 0.5) out.push('not in Ukrainian, the language picked for answers')
    if (language === 'en' && cyrillic > 0.3) out.push('not in English, the language picked for answers')
  }

  return out
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

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await watchSwitch($)

    return next(e)
  })

  // After each answer: what it broke shows under it, and waits for the next prompt.
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined || e.reason !== 'answer' || !(await read($, isOn))) return done
    const found = findings(e.answer, (await modSetting($, 'language')) ?? 'any')
    await update($, pending, () => found)
    if (found.length === 0) return done

    // Core's text is the answer itself; another mod's line under it (turn stats) is kept, and this one joins it.
    const mine = `Style: ${found.join('; ')}`

    return { ...done, text: done.text === e.answer || done.text === '' ? mine : `${done.text} · ${mine}` }
  }).catch(($, e, next) => next(e))

  // The next prompt carries the reminder once, as context the model reads and the person does not.
  on('prompt.submit', async ($, e, next) => {
    const list = await read($, pending)
    if (list.length === 0 || e.origin?.kind !== 'composer' || !(await read($, isOn))) return next(e)
    await update($, pending, () => [])

    return next({ ...e, context: [...(e.context ?? []), `style-check: your last answer broke the user's writing rules: ${list.join('; ')}. Keep to them from this answer on.`] })
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
