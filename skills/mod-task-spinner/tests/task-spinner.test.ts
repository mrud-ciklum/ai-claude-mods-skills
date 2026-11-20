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

test("while a turn runs the spinner says the task's step and percent", async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const files = new Map([
    [`${HOME}/.claude/context-band/sessions/sess-here.json`, JSON.stringify({ sessionId: 'sess-here', task: { title: 'Mod 0', percent: 45, step: 'writing tests' }, runners: [] })],
  ])
  answerDisk(on, clock, files)
  on('ui.render', { component: 'Spinner' }, ($, e) => ({ type: 'Text' as const, children: [e.props.message ?? e.props.word] }))
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'mod-task-spinner', surface: 'desktop', component: 'Spinner', props: { word: 'Sauteing', message: null, suffix: '…', mode: 'responding' } })
  expect(await ui.find({ type: 'Text', text: 'writing tests · 45%' })).toBeDefined()

  files.set(`${HOME}/.claude/context-band/sessions/sess-here.json`, JSON.stringify({ sessionId: 'sess-here', task: { title: 'Mod 0', percent: 100, step: 'done' }, runners: [] }))
  await clock.advance(5_000)
  expect(await ui.find({ type: 'Text', text: 'Sauteing' })).toBeDefined()
})
