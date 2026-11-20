import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

const MOD_NAME = 'mod-task-spinner'
const isOn = atom({ plugin: 'mod-task-spinner', key: 'isOn' } as const, true)
const switchSeenAt = atom({ plugin: 'mod-task-spinner', key: 'switchSeenAt' } as const, -1)
const isQuiet = atom({ plugin: 'mod-task-spinner', key: 'isQuiet' } as const, false)
const switchedOff = atom({ plugin: 'mod-task-spinner', key: 'switchedOff' } as const, [])
const task = atom({ plugin: 'mod-task-spinner', key: 'task' } as const, null)
const hereId = atom({ plugin: 'mod-task-spinner', key: 'hereId' } as const, '')

// This session's task as its band published it, under HOME.
const REGISTRY_DIR = '.claude/context-band/sessions'
const POLL_MS = 5_000

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await watchSwitch($)
    const id = await $.session.id()
    await update($, hereId, () => id)
    await readTask($)
    $.clock.every(POLL_MS, () => {
      void readTask($)
    })

    return started
  })
  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    const current = await read($, task)
    if (current === null || current.percent >= 100 || !(await read($, isOn))) {
      return next(e)
    }
    const step = current.step ?? current.title

    return next({ ...e, props: { ...e.props, message: `${step} · ${current.percent}%` } })
  })
}

async function readTask($: EngineInterface): Promise<void> {
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
    const entry = JSON.parse(await $.fs.read(path)) as { task?: { title?: unknown; percent?: unknown; step?: unknown } | null }
    const published = entry.task
    const found =
      published === null || published === undefined || typeof published.title !== 'string' || typeof published.percent !== 'number'
        ? null
        : { title: published.title, percent: published.percent, step: typeof published.step === 'string' ? published.step : null }
    if (JSON.stringify(found) !== JSON.stringify(await read($, task))) {
      await update($, task, () => found)
    }
  } catch (error) {
    $.ui.log(`mod-task-spinner: could not read the task: ${error instanceof Error ? error.message : String(error)}`, { to: 'debug' })
  }
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
