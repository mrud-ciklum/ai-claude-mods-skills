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

test('a background launch shows as a card with the runner\'s live state and progress', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const files = new Map([
    [
      `${HOME}/.claude/context-band/sessions/sess-here.json`,
      JSON.stringify({
        sessionId: 'sess-here',
        runners: [{ id: 'b1', status: 'running', description: 'Head job', endedAt: null, info: { title: 'Head job jb-head2' }, progress: { percent: 40, targets: [{ status: 'RUNNING', done: 40, total: 101 }] } }],
      }),
    ],
  ])
  answerDisk(on, clock, files)
  on('ui.render', { component: 'ToolResult' }, () => ({ type: 'Text' as const, children: ['Command running in background with ID: b1'] }))
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ plugin: 'mod-runner-cards', surface: 'desktop', component: 'ToolResult', requestId: 't1', props: { tool_use_id: 't1', tool: 'Bash', output: { backgroundTaskId: 'b1' }, isErrored: false } })
  expect((await ui.findAll({ type: 'Text' })).map(found => found.text)).toEqual([
    '● runner running',
    'Head job jb-head2',
    `${'█'.repeat(8)}${'░'.repeat(12)} 40%`,
    '40/101',
  ])
  const other = await $.ui.mount({ plugin: 'mod-runner-cards', surface: 'desktop', component: 'ToolResult', requestId: 't2', props: { tool_use_id: 't2', tool: 'Bash', output: { stdout: 'hi' }, isErrored: false } })
  expect(await other.find({ type: 'Text', text: 'Command running in background with ID: b1' })).toBeDefined()
})
