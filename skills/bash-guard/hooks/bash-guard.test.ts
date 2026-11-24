import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { heavyReasons, preflightReasons, readFiles } from './rules'

type Caller = { tool: { call: (input: { tool: 'Bash'; command: string; run_in_background?: boolean }) => Promise<unknown> } }

// The engine as the guard meets it: a home folder, file sizes, the shared switches file, and Bash.
function world(on: On, opts: { sizes?: Record<string, number>; switches?: string } = {}) {
  const ran: string[] = []
  const switches = '/home/u/.claude/mods/state.json'
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home/u' : undefined }))
  on('session.cwd', () => ({ value: '/work/app' }))
  on('fs.exists', (_, e) => ({ value: e.path === switches && opts.switches !== undefined }))
  on('fs.stat', (_, e) =>
    e.path === switches ? { value: { kind: 'file', size: 80, mtimeMs: 1, isLink: false } } : opts.sizes?.[e.path] !== undefined ? { value: { kind: 'file', size: opts.sizes[e.path] ?? 0, mtimeMs: 1, isLink: false } } : { deny: 'no such file' },
  )
  on('fs.read', (_, e) => (e.path === switches && opts.switches !== undefined ? { value: opts.switches } : { deny: 'no such file' }))
  on('tool.call', (_, e) => {
    ran.push(e.tool === 'Bash' ? e.command : e.tool)

    return { result: { stdout: '', stderr: '', interrupted: false } }
  })
  const bash = async ($: unknown, command: string, isBackground = false): Promise<string | undefined> => {
    const r = (await ($ as Caller).tool.call({ tool: 'Bash', command, ...(isBackground ? { run_in_background: true } : {}) })) as { deny?: string; isError?: boolean; text?: string }

    return r.deny ?? (r.isError === true ? (r.text ?? 'refused') : undefined)
  }

  return { ran, bash }
}

test('a search of the Claude Code binary, the whole home folder or the disk is refused with the reason', async ($, on) => {
  const w = world(on)
  expect(await w.bash($, 'grep -a -o "uuid?: string" "$CLAUDE_CODE_EXECPATH" | head -5')).toContain('reads the Claude Code binary')
  expect(await w.bash($, 'strings /Applications/Claude.app/Contents/MacOS/claude | grep x')).toContain('an app bundle')
  expect(await w.bash($, 'grep -rn "TODO" ~')).toContain('searches the whole home folder')
  expect(await w.bash($, 'rg -l secret /home/u/')).toContain('searches the whole home folder')
  expect(await w.bash($, 'find / -name "*.log"')).toContain('walks the whole disk')
  expect(w.ran).toEqual([])
  // Narrow ones go on.
  expect(await w.bash($, 'grep -rn "TODO" ~/code/app')).toBeUndefined()
  expect(await w.bash($, 'find ~ -maxdepth 2 -name "*.md"')).toBeUndefined()
  expect(await w.bash($, 'ls -la ~ && echo "$CLAUDE_CODE_EXECPATH"')).toBeUndefined()
  // A file next to the binary is not the binary.
  expect(await w.bash($, 'grep -n hover "$CLAUDE_CODE_EXECPATH"/../types.d.ts')).toBeUndefined()
  // A here-document's body is text, not a command.
  expect(await w.bash($, "cat > notes.md <<'EOF'\ngrep -rn x ~\nEOF")).toBeUndefined()
  expect(w.ran).toHaveLength(5)
})

test('a huge file read whole is refused; the same file through head goes on', async ($, on) => {
  const w = world(on, { sizes: { '/home/u/logs/big.jsonl': 900 * 1024 * 1024, '/work/app/small.json': 10_000 } })
  expect(await w.bash($, 'grep -c "error" ~/logs/big.jsonl')).toContain('it reads ~/logs/big.jsonl whole, 900 MB')
  expect(await w.bash($, 'cat $HOME/logs/big.jsonl | wc -l')).toContain('900 MB')
  expect(await w.bash($, 'head -c 100000 ~/logs/big.jsonl | grep error')).toBeUndefined()
  expect(await w.bash($, 'cat ~/logs/big.jsonl | head -3')).toBeUndefined()
  expect(await w.bash($, 'jq .name small.json')).toBeUndefined()
})

test('a background test run must start failing loud and naming its commit; switched off in the panel it is not asked', async ($, on) => {
  const w = world(on)
  const said = (await w.bash($, 'cd /work/app && pytest -q tests/', true)) ?? ''
  expect(said).toContain('set -euo pipefail')
  expect(said).toContain('git rev-parse --short HEAD')
  expect(await w.bash($, 'set -euo pipefail; git rev-parse --short HEAD; pytest -q tests/', true)).toBeUndefined()
  // In the foreground, and for a server, nothing is asked.
  expect(await w.bash($, 'pytest -q tests/')).toBeUndefined()
  expect(await w.bash($, 'npm run dev', true)).toBeUndefined()
})

test('with the background preflight off in the Mods panel, a bare background run goes on', async ($, on) => {
  const w = world(on, { switches: JSON.stringify({ off: [], modSettings: { 'bash-guard': { preflight: 'off' } } }) })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect(await w.bash($, 'pytest -q', true)).toBeUndefined()
})

test('switched off in the Mods panel, it refuses nothing', async ($, on) => {
  const w = world(on, { switches: JSON.stringify({ off: ['bash-guard'] }) })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect(await w.bash($, 'grep -rn x ~')).toBeUndefined()
})

test('the rules read pattern words as patterns and file words as files', () => {
  expect(readFiles('grep -n "logs/big.jsonl" notes.md')).toEqual(['notes.md'])
  expect(readFiles("awk '{print $1}' a.txt b.txt")).toEqual(['a.txt', 'b.txt'])
  expect(readFiles('cat a.txt | head -5')).toEqual([])
  expect(heavyReasons('grep -n x README.md', '/home/u')).toEqual([])
  expect(preflightReasons('git status')).toEqual([])
})
