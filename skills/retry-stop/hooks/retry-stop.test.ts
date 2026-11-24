import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

type Caller = { tool: { call: (input: Record<string, unknown>) => Promise<unknown> } }

// Bash that fails while `failing` holds the command, and records what ran.
function world(on: On, failing: Set<string>, switches?: string) {
  const ran: string[] = []
  const file = '/home/u/.claude/mods/state.json'
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home/u' : undefined }))
  on('fs.exists', (_, e) => ({ value: e.path === file && switches !== undefined }))
  on('fs.stat', () => ({ value: { kind: 'file', size: 80, mtimeMs: 1, isLink: false } }))
  on('fs.read', (_, e) => (e.path === file && switches !== undefined ? { value: switches } : { deny: 'no such file' }))
  on('tool.call', (_, e) => {
    const command = e.tool === 'Bash' ? e.command : e.tool
    ran.push(command)
    // A failed run as core answers it: isError, and the error text as both result and text.
    if (e.tool === 'Bash' && failing.has(e.command.trim().replace(/\s+/g, ' '))) return { isError: true as const, result: 'Exit code 1\nboom', text: 'Exit code 1\nboom' }

    return { result: { stdout: '', stderr: '', interrupted: false } } as never
  })
  const call = async ($: unknown, input: Record<string, unknown>): Promise<string> => {
    const r = (await ($ as Caller).tool.call(input)) as { deny?: string; isError?: boolean; text?: string }

    // A refusal comes back as the guard's text; a run, failed or not, as what Bash answered.
    return r.deny !== undefined || /retry-stop/.test(r.text ?? '') ? 'refused' : 'ran'
  }

  return { ran, call }
}

test('a command that failed twice in a row is refused the third time, until a file is edited', async ($, on) => {
  const w = world(on, new Set(['npm test']))
  const bash = (command: string) => w.call($, { tool: 'Bash', command })
  expect(await bash('npm test')).toBe('ran') // and failed
  expect(await bash('npm  test')).toBe('ran') // failed again: the same words with other spacing
  expect(await bash('npm test')).toBe('refused')
  expect(await bash('npm test')).toBe('refused')
  // Reading changes nothing; an edit does.
  expect(await w.call($, { tool: 'Read', file_path: '/a.ts' })).toBe('ran')
  expect(await bash('npm test')).toBe('refused')
  expect(await w.call($, { tool: 'Edit', file_path: '/a.ts', old_string: 'a', new_string: 'b' })).toBe('ran')
  expect(await bash('npm test')).toBe('ran')
  expect(w.ran.filter(c => c === 'npm test' || c === 'npm  test')).toHaveLength(3)
})

test('another command between, or a success, starts the count again', async ($, on) => {
  const failing = new Set(['make build'])
  const w = world(on, failing)
  const bash = (command: string) => w.call($, { tool: 'Bash', command })
  expect(await bash('make build')).toBe('ran')
  expect(await bash('make build')).toBe('ran')
  expect(await bash('git status')).toBe('ran')
  expect(await bash('make build')).toBe('ran') // counted from one again
  expect(await bash('make build')).toBe('ran')
  expect(await bash('make build')).toBe('refused') // two failures in a row again
  // A success clears it.
  failing.delete('make build')
  expect(await w.call($, { tool: 'Edit', file_path: '/a.ts', old_string: 'a', new_string: 'b' })).toBe('ran')
  expect(await bash('make build')).toBe('ran')
  failing.add('make build')
  expect(await bash('make build')).toBe('ran')
  expect(await bash('make build')).toBe('ran')
})

test('switched off in the Mods panel, it refuses nothing', async ($, on) => {
  const w = world(on, new Set(['npm test']), JSON.stringify({ off: ['retry-stop'] }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const bash = (command: string) => w.call($, { tool: 'Bash', command })
  expect([await bash('npm test'), await bash('npm test'), await bash('npm test')]).toEqual(['ran', 'ran', 'ran'])
})
