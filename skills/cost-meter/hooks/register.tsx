import { atom, read, update } from 'claude-code'
import type { EngineInterface, ModelCompleteResult, Register } from 'claude-code'

import type { Tally } from '../types'

const MOD_NAME = 'cost-meter'
const isOn = atom({ plugin: 'cost-meter', key: 'isOn' } as const, true)
const switchSeenAt = atom({ plugin: 'cost-meter', key: 'switchSeenAt' } as const, -1)
const isQuiet = atom({ plugin: 'cost-meter', key: 'isQuiet' } as const, false)
const switchedOff = atom({ plugin: 'cost-meter', key: 'switchedOff' } as const, [])
const today = atom({ plugin: 'cost-meter', key: 'today' } as const, null as { day: string; byMod: Tally } | null)

// Every session's mods count into one file under the home folder, a day per key, the last 14 days.
// It holds counts only: no prompt, no answer. The Mods panel reads it to show each mod's day.
export const LEDGER = '.claude/mods/side-models.json'
const DAYS_KEPT = 14
// The Daily cap choices of the Mods panel, in tokens (in and out together).
export const CAPS: Record<string, number> = { '500k': 500_000, '1M': 1_000_000, '2M': 2_000_000, '5M': 5_000_000 }
// The row above the prompt shows from this share of the cap on.
const NEAR_CAP = 0.8

type Ledger = Record<string, Tally>

const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10)
export const tokensOf = (tally: Tally) => Object.values(tally).reduce((sum, t) => sum + t.input + t.output, 0)
export const shortTokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${Math.round(n / 1_000)}k` : `${n}`)

async function ledgerPath($: EngineInterface): Promise<string | undefined> {
  const home = await $.env.get('HOME')

  return home ? `${home.replace(/\/$/, '')}/${LEDGER}` : undefined
}

async function readLedger($: EngineInterface, path: string): Promise<Ledger> {
  const text = await $.fs.read(path).catch(() => '')
  try {
    const data: unknown = JSON.parse(typeof text === 'string' && text !== '' ? text : '{}')

    return typeof data === 'object' && data !== null && !Array.isArray(data) ? (data as Ledger) : {}
  } catch {
    return {}
  }
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

const NONE = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await watchSwitch($)
    const path = await ledgerPath($)
    if (path !== undefined) {
      const day = dayOf(await $.clock.now())
      const ledger = await readLedger($, path)
      await update($, today, () => ({ day, byMod: ledger[day] ?? {} }))
    }

    return next(e)
  })

  // Every model call a mod makes passes here: refused at the day's cap, else counted after it answers.
  on('model.complete', async ($, e, next) => {
    if (!(await read($, isOn))) return next(e)
    const path = await ledgerPath($)
    if (path === undefined) return next(e)
    const mod = next.origin.plugin
    const started = await $.clock.now()
    const day = dayOf(started)
    const cap = CAPS[(await modSetting($, 'cap')) ?? 'off']
    if (cap !== undefined) {
      const spent = tokensOf((await readLedger($, path))[day] ?? {})
      if (spent >= cap) {
        $.ui.toast(`Side-model cap reached: ${shortTokens(spent)} of ${shortTokens(cap)} tokens today. ${mod}'s call was not made.`)

        return { value: { isAnswered: false, reason: 'aborted', usage: NONE } satisfies ModelCompleteResult }
      }
    }
    const answered = await next(e)
    // A call another hook refused cost nothing.
    if (!('value' in answered) || answered.value === undefined) return answered
    const r = answered.value
    const ms = (await $.clock.now()) - started
    // Read again just before the write: another session may have counted since.
    const ledger = await readLedger($, path)
    const tally = { ...(ledger[day] ?? {}) }
    const was = tally[mod] ?? { calls: 0, input: 0, output: 0, ms: 0 }
    tally[mod] = { calls: was.calls + 1, input: was.input + r.usage.input_tokens + r.usage.cache_read_input_tokens + r.usage.cache_creation_input_tokens, output: was.output + r.usage.output_tokens, ms: was.ms + ms }
    const kept = Object.fromEntries([...Object.entries({ ...ledger, [day]: tally })].sort(([a], [b]) => a.localeCompare(b)).slice(-DAYS_KEPT))
    // ponytail: read, then written whole; two sessions writing at once can lose one call's count.
    await $.fs.write(path, `${JSON.stringify(kept, null, 1)}\n`).catch(() => undefined)
    await update($, today, () => ({ day, byMod: tally }))

    return answered
  }).catch(($, e, next) => next(e)) // a meter that fails never stops a call

  // One line above the prompt, and only near or over the cap: the day's tokens against it.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const now = await read($, today)
    if (e.props.hasSurvey || !now || !(await read($, isOn))) return next(e)
    const cap = CAPS[(await modSetting($, 'cap')) ?? 'off']
    const spent = tokensOf(now.byMod)
    if (cap === undefined || spent < cap * NEAR_CAP) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const top = Object.entries(now.byMod).sort(([, a], [, b]) => b.input + b.output - (a.input + a.output))[0]

    return (
      <Box columnGap={1}>
        <Text bold color={spent >= cap ? 'error' : 'warning'}>
          Side models
        </Text>
        <Text>{`${shortTokens(spent)} of ${shortTokens(cap)} tokens today${spent >= cap ? ': stopped until tomorrow' : ''}`}</Text>
        {top ? <Text dimColor>{`most: ${top[0]} ${shortTokens(top[1].input + top[1].output)}`}</Text> : null}
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
