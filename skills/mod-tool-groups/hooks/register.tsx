import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, ToolGroupCall } from 'claude-code'

const MOD_NAME = 'mod-tool-groups'
const isOn = atom({ plugin: 'mod-tool-groups', key: 'isOn' } as const, true)
const switchSeenAt = atom({ plugin: 'mod-tool-groups', key: 'switchSeenAt' } as const, -1)
const isQuiet = atom({ plugin: 'mod-tool-groups', key: 'isQuiet' } as const, false)
const switchedOff = atom({ plugin: 'mod-tool-groups', key: 'switchedOff' } as const, [])
const openGroups = atom({ plugin: 'mod-tool-groups', key: 'openGroups' } as const, [])

// The band's own tools stay out of the count.
const QUIET_TOOLS = new Set(['mcp__context-band__task_progress', 'mcp__context-band__runner_info'])

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await watchSwitch($)

    return started
  })
  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    if (e.props.isActive || e.props.isExpanded || !(await read($, isOn))) {
      return next(e)
    }
    const key = e.requestId ?? e.props.calls.map(call => call.tool_use_id ?? '').join(',')
    if ((await read($, openGroups)).includes(key)) {
      return next({ ...e, props: { ...e.props, isExpanded: true } })
    }
    const calls = e.props.calls.filter(call => !QUIET_TOOLS.has(call.tool))
    if (calls.length === 0) {
      const { Box } = $.ui.resolve(e)

      return <Box />
    }
    const { Box, Button, Text } = $.ui.resolve(e)
    const errored = calls.filter(call => call.isErrored).length

    return (
      <Box gap={1}>
        <Button key={`group:${key}`.slice(0, 120)} plain dimColor onPress={() => openGroup($, key)}>
          {`▸ ${summary(calls)}`}
        </Button>
        {errored > 0 && <Text color="error">{`${errored} failed`}</Text>}
      </Box>
    )
  })
}

async function openGroup($: EngineInterface, key: string): Promise<void> {
  await update($, openGroups, open => [...open.filter(other => other !== key), key].slice(-200))
}

// What the group did, in words: the most frequent kinds first.
function summary(calls: readonly ToolGroupCall[]): string {
  const counts = new Map<string, number>()
  for (const call of calls) {
    const kind = kindOf(call.tool)
    counts.set(kind, (counts.get(kind) ?? 0) + 1)
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([kind, count]) => phrase(kind, count))
    .join(' · ')
}

function kindOf(tool: string): string {
  if (tool === 'Read' || tool === 'NotebookRead') {
    return 'read'
  }
  if (tool === 'Grep' || tool === 'Glob' || tool === 'ToolSearch') {
    return 'search'
  }
  if (tool === 'Bash' || tool === 'BashOutput') {
    return 'shell'
  }
  if (tool === 'Edit' || tool === 'Write' || tool === 'NotebookEdit' || tool === 'MultiEdit') {
    return 'edit'
  }
  if (tool === 'Agent' || tool === 'Task') {
    return 'agent'
  }
  if (tool === 'WebFetch' || tool === 'WebSearch') {
    return 'web'
  }
  const mcp = /^mcp__(.+?)__/.exec(tool)

  return mcp?.[1] === undefined ? tool : `mcp:${mcp[1]}`
}

function phrase(kind: string, count: number): string {
  const forms: Record<string, { verb?: string; one: string; many: string }> = {
    read: { verb: 'read', one: 'file', many: 'files' },
    search: { one: 'search', many: 'searches' },
    shell: { one: 'command', many: 'commands' },
    edit: { verb: 'edited', one: 'file', many: 'files' },
    agent: { one: 'agent', many: 'agents' },
    web: { one: 'web request', many: 'web requests' },
  }
  const form = forms[kind]
  if (form === undefined) {
    return kind.startsWith('mcp:') ? `${kind.slice(4)} ×${count}` : `${kind} ×${count}`
  }
  const counted = `${count} ${plural(count, form.one, form.many)}`

  return form.verb === undefined ? counted : `${form.verb} ${counted}`
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
