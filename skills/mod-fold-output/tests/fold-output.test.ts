import { expect, mock, test } from 'claude-code/testing'
import type { MockClock } from 'claude-code/testing'
import type { On } from 'claude-code'

const HOME = '/home/me'
const NOW = 1_760_000_000_000

// The disk in memory, with HOME set; a file's time is the clock's when it was written.
function answerDisk(on: On, clock: MockClock, files: Map<string, string>): void {
  mock.env(on, { HOME })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'sess-here' }))
  on('fs.exists', ($, e) => ({ value: files.has(e.path) || [...files.keys()].some(path => path.startsWith(`${e.path}/`)) }))
  on('fs.read', ($, e) => {
    const text = files.get(e.path)

    return text === undefined ? { deny: `ENOENT: ${e.path}` } : { value: text }
  })
  on('fs.stat', ($, e) => (files.has(e.path) ? { value: { kind: 'file' as const, size: 1, mtimeMs: clock.now(), isLink: false } } : { deny: 'ENOENT' }))
  on('fs.list', ($, e) => ({
    value: [...files.keys()]
      .filter(path => path.startsWith(`${e.path}/`))
      .map(path => ({ name: path.slice(e.path.length + 1), kind: 'file' as const, size: 1, mtimeMs: clock.now(), isLink: false })),
  }))
}

test('a long command output folds to its first lines with its size and a button that shows it all', async ($, on) => {
  answerDisk(on, mock.clock(on, { now: NOW }), new Map())
  on('ui.render', { component: 'ToolResult' }, () => ({ type: 'Text' as const, children: ['whole output'] }))
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
  const stdout = Array.from({ length: 30 }, (_, index) => `line ${index + 1} ${'x'.repeat(30)}`).join('\n')
  const ui = await $.ui.mount({ plugin: 'mod-fold-output', surface: 'desktop', component: 'ToolResult', requestId: 't1', props: { tool_use_id: 't1', tool: 'Bash', output: { stdout, stderr: '' }, isErrored: false } })

  const texts = (await ui.findAll({ type: 'Text' })).map(found => found.text)
  expect(texts.slice(0, 4)).toEqual([1, 2, 3, 4].map(index => `line ${index} ${'x'.repeat(30)}`))
  expect(texts).toContain('… 26 more lines · ~290 tokens')
  await ui.press({ key: 'unfold:t1' })
  expect(await ui.find({ type: 'Text', text: 'whole output' })).toBeDefined()

  const short = await $.ui.mount({ plugin: 'mod-fold-output', surface: 'desktop', component: 'ToolResult', requestId: 't2', props: { tool_use_id: 't2', tool: 'Bash', output: { stdout: 'ok', stderr: '' }, isErrored: false } })
  expect(await short.find({ type: 'Text', text: 'whole output' })).toBeDefined()
})
