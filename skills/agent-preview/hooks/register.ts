import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

const MOD_NAME = 'agent-preview'
const isOn = atom({ plugin: 'agent-preview', key: 'isOn' } as const, true)
const switchSeenAt = atom({ plugin: 'agent-preview', key: 'switchSeenAt' } as const, -1)
const isQuiet = atom({ plugin: 'agent-preview', key: 'isQuiet' } as const, false)
const switchedOff = atom({ plugin: 'agent-preview', key: 'switchedOff' } as const, [])

// The tools that start work of their own: a subagent, or a workflow of them.
const AGENT_TOOLS = new Set(['Agent', 'Task'])
const WORKFLOW_TOOL = 'Workflow'
const LAUNCH = 'Launch'
const HOLD = "Don't launch"
// How much of a prompt the question shows: enough to judge it, short enough to read.
const SHOWN_CHARS = 1_500

const isLaunchTool = (tool: unknown) => AGENT_TOOLS.has(String(tool)) || String(tool) === WORKFLOW_TOOL

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

const textOf = (value: unknown) => (typeof value === 'string' ? value.trim() : '')

// The question: what starts, and its prompt (or a workflow's script), cut to what a person reads.
export function questionOf(tool: string, input: Record<string, unknown>): string {
  const isWorkflow = tool === WORKFLOW_TOOL
  const name = textOf(input.description) || textOf(input.title) || textOf(input.name) || (isWorkflow ? 'a workflow' : 'an agent')
  const kind = isWorkflow ? 'workflow' : input.run_in_background === true ? 'background agent' : 'agent'
  const body = textOf(input.prompt) || textOf(input.script) || textOf(input.args)
  const shown = body.length > SHOWN_CHARS ? `${body.slice(0, SHOWN_CHARS)}… (${body.length - SHOWN_CHARS} more characters)` : body

  return `Launch this ${kind}: "${name}"?${shown === '' ? '' : `\n\n${shown}`}`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await watchSwitch($)

    return next(e)
  })

  // A background agent or a workflow starts only on the person's Launch; any other call goes on.
  on('tool.call', async ($, e, next) => {
    if (!isLaunchTool(e.tool) || !(await read($, isOn))) return next(e)
    const tool = String(e.tool)
    const input = e as unknown as Record<string, unknown>
    const isAsked = tool === WORKFLOW_TOOL || input.run_in_background === true || (await modSetting($, 'scope')) === 'all'
    if (!isAsked) return next(e)
    const answer = await $.ui.ask(questionOf(tool, input), { header: 'Agent', options: [LAUNCH, HOLD] }).catch(() => undefined)
    if (answer === LAUNCH) return next(e)

    return {
      deny:
        answer === undefined
          ? 'agent-preview: nobody approved this launch (the question was dismissed, or there is no one to ask). Show the prompt in the chat and ask the user first.'
          : `agent-preview: the user did not approve this launch (they answered "${answer}"). Show the prompt in the chat, and launch only on their word.`,
    }
  }).catch(($, e, next) =>
    // A guard that failed refuses only a launch; any other call goes on.
    next.called ? next(e) : isLaunchTool(e.tool) ? { deny: 'agent-preview failed while asking, so this launch did not start. Tell the user.' } : next(e),
  )
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
