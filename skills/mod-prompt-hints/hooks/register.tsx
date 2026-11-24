import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

const MOD_NAME = 'mod-prompt-hints'
const isOn = atom({ plugin: 'mod-prompt-hints', key: 'isOn' } as const, true)
const switchSeenAt = atom({ plugin: 'mod-prompt-hints', key: 'switchSeenAt' } as const, -1)
const isQuiet = atom({ plugin: 'mod-prompt-hints', key: 'isQuiet' } as const, false)
const switchedOff = atom({ plugin: 'mod-prompt-hints', key: 'switchedOff' } as const, [])
const percent = atom({ plugin: 'mod-prompt-hints', key: 'percent' } as const, null)
const waiting = atom({ plugin: 'mod-prompt-hints', key: 'waiting' } as const, 0)
const dead = atom({ plugin: 'mod-prompt-hints', key: 'dead' } as const, 0)
const hereId = atom({ plugin: 'mod-prompt-hints', key: 'hereId' } as const, '')

const REGISTRY_DIR = '.claude/context-band/sessions'
const POLL_MS = 20_000
const SILENT_AFTER_MS = 120_000
// A session resting this long counts as waiting for the person.
const WAITING_AFTER_MS = 5 * 60_000
const CONTEXT_HINT_AT = 80
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
    await readSessions($)
    $.clock.every(POLL_MS, () => {
      void readSessions($)
    })

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

  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    if (e.props.isDraft || e.props.isWorking || !(await read($, isOn))) {
      return next(e)
    }
    const fill = await read($, percent)
    const parts = [
      fill !== null && fill >= CONTEXT_HINT_AT ? `context ${fill}% - press Compact` : '',
      countHint(await read($, dead), 'runner died', 'runners died'),
      countHint(await read($, waiting), 'session waiting for you', 'sessions waiting for you'),
    ].filter(Boolean)
    if (parts.length === 0) {
      return next(e)
    }

    return next({ ...e, props: { ...e.props, hint: parts.join(' · ') } })
  })
}

function countHint(count: number, one: string, many: string): string {
  return count === 0 ? '' : `${count} ${plural(count, one, many)}`
}

// The other sessions resting a while, and the runners that died, across this Mac.
async function readSessions($: EngineInterface): Promise<void> {
  try {
    const home = await $.env.get('HOME')
    if (home === undefined || home === '') {
      return
    }
    const dir = `${home.replace(/\/$/, '')}/${REGISTRY_DIR}`
    if (!(await $.fs.exists(dir))) {
      return
    }
    const now = await $.clock.now()
    const here = await read($, hereId)
    let resting = 0
    let died = 0
    for (const file of await $.fs.list(dir)) {
      if (file.kind !== 'file' || !file.name.endsWith('.json') || now - file.mtimeMs >= SILENT_AFTER_MS) {
        continue
      }
      // One file caught half-written (or broken) is skipped; the others still count.
      const entry = await $.fs
        .read(`${dir}/${file.name}`)
        .then(
          text =>
            JSON.parse(text) as {
              sessionId?: unknown
              isEnded?: unknown
              turn?: { isWorking?: unknown; since?: unknown }
              runners?: Array<{ endedAt?: unknown; progress?: { targets?: Array<{ status?: unknown }> } | null }>
            },
        )
        .catch(() => null)
      if (entry === null || typeof entry !== 'object' || entry.isEnded === true) {
        continue
      }
      if (entry.sessionId !== here && entry.turn?.isWorking === false && typeof entry.turn.since === 'number' && now - entry.turn.since >= WAITING_AFTER_MS) {
        resting += 1
      }
      for (const runner of entry.runners ?? []) {
        const targets = runner.progress?.targets ?? []
        const last = targets[targets.length - 1]
        if (runner.endedAt === null && typeof last?.status === 'string' && DEAD_WORDS.has(last.status)) {
          died += 1
        }
      }
    }
    await update($, waiting, () => resting)
    await update($, dead, () => died)
  } catch (error) {
    $.ui.log(`mod-prompt-hints: could not read the sessions: ${error instanceof Error ? error.message : String(error)}`, { to: 'debug' })
  }
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
