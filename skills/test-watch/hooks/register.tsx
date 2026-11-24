import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Run } from '../types'

const MOD_NAME = 'test-watch'
const isOn = atom({ plugin: 'test-watch', key: 'isOn' } as const, true)
const switchSeenAt = atom({ plugin: 'test-watch', key: 'switchSeenAt' } as const, -1)
const isQuiet = atom({ plugin: 'test-watch', key: 'isQuiet' } as const, false)
const switchedOff = atom({ plugin: 'test-watch', key: 'switchedOff' } as const, [])
const runs = atom({ plugin: 'test-watch', key: 'runs' } as const, [] as Run[])
const edited = atom({ plugin: 'test-watch', key: 'edited' } as const, [] as string[])

const PANE = 'test-watch'
const EDITS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit'])
// A mod's tests take seconds; a run past this is stopped and shown as such.
const RUN_TIMEOUT_MS = 180_000
// How far up from an edited file a mod's folder is looked for.
const LEVELS_UP = 8

// The mod an edited file belongs to: the nearest folder above it with .claude-plugin/plugin.json.
async function modFolder($: EngineInterface, file: string): Promise<string | undefined> {
  let at = file.slice(0, file.lastIndexOf('/'))
  for (let i = 0; i < LEVELS_UP && at !== ''; i++) {
    if (await $.fs.exists(`${at}/.claude-plugin/plugin.json`).catch(() => false)) return at
    at = at.slice(0, at.lastIndexOf('/'))
  }

  return undefined
}

// What `claude plugin test` printed: the counts and the names of the tests that failed.
export function readRun(stdout: string): { passed: number; failed: number; failures: string[] } {
  const passed = Number(/^\s*(\d+) pass\s*$/m.exec(stdout)?.[1] ?? 0)
  const failed = Number(/^\s*(\d+) fail\s*$/m.exec(stdout)?.[1] ?? 0)
  const failures = [...stdout.matchAll(/^\(fail\) (.+?)(?: \[[\d.]+m?s\])?$/gm)].map(m => m[1] ?? '').filter(name => name !== '')

  return { passed, failed, failures }
}

const putRun = (list: readonly Run[], run: Run) => [...list.filter(r => r.folder !== run.folder), run]

async function runTests($: EngineInterface, folders: readonly string[]) {
  const cli = (await $.env.get('CLAUDE_CODE_EXECPATH').catch(() => undefined)) || 'claude'
  for (const folder of folders) {
    const name = folder.slice(folder.lastIndexOf('/') + 1)
    const base: Run = { folder, name, state: 'running', passed: 0, failed: 0, failures: [], at: await $.clock.now() }
    await update($, runs, list => putRun(list, base))
    const r = await $.process.run([cli, 'plugin', 'test', folder], { timeoutMs: RUN_TIMEOUT_MS }).catch((err: unknown) => (err instanceof Error ? err.message : String(err)))
    // A run with failing tests names them; one that did not get that far says what it printed last.
    const counts = typeof r === 'string' ? undefined : readRun(r.stdout + r.stderr)
    const run: Run =
      typeof r === 'string' || counts === undefined
        ? { ...base, state: 'error', detail: String(r) }
        : r.exitCode === 0
          ? { ...base, ...counts, state: 'passed' }
          : counts.failed > 0
            ? { ...base, ...counts, state: 'failed' }
            : { ...base, ...counts, state: 'error', detail: (r.stderr || r.stdout).trim().split('\n').slice(-3).join('\n') }
    await update($, runs, list => putRun(list, run))
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await watchSwitch($)

    return next(e)
  })

  // The files a turn edits, from the edit tools' own calls.
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    const path = (e as { file_path?: unknown }).file_path
    if (EDITS.has(String(e.tool)) && typeof path === 'string' && ran.deny === undefined && ran.isError !== true) await update($, edited, list => (list.includes(path) ? list : [...list, path]))

    return ran
  }).catch(($, e, next) => next(e))

  // When the turn ends, the tests of every mod it edited run, after the hook returns.
  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const files = await read($, edited)
    await update($, edited, () => [])
    if (files.length === 0 || !(await read($, isOn))) return next(e)
    void (async () => {
      const folders = [...new Set((await Promise.all(files.map(f => modFolder($, f)))).filter((f): f is string => f !== undefined))]
      if (folders.length > 0) await runTests($, folders)
    })().catch(() => undefined)

    return next(e)
  })

  // One line above the prompt: each mod's last run, and the failures a press away.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const list = await read($, runs)
    if (e.props.hasSurvey || list.length === 0 || !(await read($, isOn))) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const isBad = list.some(r => r.state === 'failed' || r.state === 'error')

    return (
      <Box justifyContent="space-between" columnGap={2}>
        <Box columnGap={2} flexShrink={1} flexWrap="wrap">
          <Text bold>Tests</Text>
          {list.map(r => (
            <Text color={r.state === 'passed' ? 'success' : r.state === 'running' ? undefined : 'error'} dimColor={r.state === 'running'}>
              {r.state === 'running' ? `${r.name} running…` : r.state === 'passed' ? `${r.name} ${r.passed} ✓` : r.state === 'failed' ? `${r.name} ${r.passed}/${r.passed + r.failed} ✗` : `${r.name} did not run`}
            </Text>
          ))}
        </Box>
        <Box columnGap={1} flexShrink={0}>
          {isBad ? <Button key="tests-why" label="Why" dimColor onPress={() => void $.ui.open({ id: PANE, title: 'Test watch' })} /> : null}
          <Button key="tests-hide" label="Hide" dimColor onPress={() => update($, runs, () => [])} />
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const bad = (await read($, runs)).filter(r => r.state === 'failed' || r.state === 'error')
    if (bad.length === 0) return <Text dimColor>Every test of the last run passed.</Text>

    return (
      <Box flexDirection="column" gap={1}>
        {bad.map(r => (
          <Box flexDirection="column">
            <Text bold>{r.folder}</Text>
            {r.failures.map(name => (
              <Text color="error">✗ {name}</Text>
            ))}
            {r.detail ? <Text dimColor>{r.detail}</Text> : null}
          </Box>
        ))}
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
