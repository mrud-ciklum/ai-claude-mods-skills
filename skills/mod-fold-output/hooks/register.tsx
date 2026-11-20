import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

const MOD_NAME = 'mod-fold-output'
const isOn = atom({ plugin: 'mod-fold-output', key: 'isOn' } as const, true)
const switchSeenAt = atom({ plugin: 'mod-fold-output', key: 'switchSeenAt' } as const, -1)
const isQuiet = atom({ plugin: 'mod-fold-output', key: 'isQuiet' } as const, false)
const switchedOff = atom({ plugin: 'mod-fold-output', key: 'switchedOff' } as const, [])
const openResults = atom({ plugin: 'mod-fold-output', key: 'openResults' } as const, [])

// Longer than this, an output folds to its first FIRST_LINES lines.
const FOLD_LINES = 12
const FIRST_LINES = 4
const CHARS_PER_TOKEN = 4

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await watchSwitch($)

    return started
  })
  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    if (e.props.tool !== 'Bash' || !(await read($, isOn))) {
      return next(e)
    }
    const text = outputText(e.props.output)
    const lines = text.split('\n')
    if (lines.length <= FOLD_LINES || (await read($, openResults)).includes(e.props.tool_use_id)) {
      return next(e)
    }
    const { Box, Button, Text } = $.ui.resolve(e)
    const id = e.props.tool_use_id

    return (
      <Box flexDirection="column">
        {lines.slice(0, FIRST_LINES).map(line => (
          <Text dimColor wrap="truncate-end">
            {line}
          </Text>
        ))}
        <Box gap={1}>
          <Text dimColor>{`… ${lines.length - FIRST_LINES} more lines · ~${kilo(Math.round(text.length / CHARS_PER_TOKEN))} tokens`}</Text>
          <Button key={`unfold:${id}`} label="show all" dimColor onPress={() => unfold($, id)} />
        </Box>
      </Box>
    )
  })
}

async function unfold($: EngineInterface, id: string): Promise<void> {
  await update($, openResults, open => [...open.filter(other => other !== id), id].slice(-200))
}

// A shell's output as it printed it: stdout, then stderr.
function outputText(output: unknown): string {
  if (typeof output === 'string') {
    return output
  }
  if (typeof output !== 'object' || output === null) {
    return ''
  }
  const record = output as { stdout?: unknown; stderr?: unknown }

  return [record.stdout, record.stderr].filter((part): part is string => typeof part === 'string' && part !== '').join('\n')
}

function kilo(count: number): string {
  if (count >= 10_000) {
    return `${Math.round(count / 1_000)}k`
  }

  return count >= 1_000 ? `${(count / 1_000).toFixed(1).replace(/\.0$/, '')}k` : String(count)
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
