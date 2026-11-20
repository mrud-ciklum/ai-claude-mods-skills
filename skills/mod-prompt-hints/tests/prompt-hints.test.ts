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

test('the hint line under an idle prompt says what needs a look', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const files = new Map([
    [`${HOME}/.claude/context-band/sessions/sess-a.json`, JSON.stringify({ sessionId: 'sess-a', isEnded: false, turn: { isWorking: false, since: NOW - 12 * 60_000 }, runners: [] })],
    [
      `${HOME}/.claude/context-band/sessions/sess-b.json`,
      JSON.stringify({ sessionId: 'sess-b', isEnded: false, turn: { isWorking: true, since: NOW }, runners: [{ endedAt: null, progress: { targets: [{ status: 'RUN_DEAD' }] } }] }),
    ],
  ])
  answerDisk(on, clock, files)
  on('session.measure', ($, e) => ({ changed: [...e.changed] }))
  on('ui.render', { component: 'PromptHint' }, ($, e) => ({ type: 'Text' as const, children: [e.props.hint] }))
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
  await $.session.measure({ context: { tokens: 170_000, window: 200_000, percent: 85 }, rateLimits: [], changed: ['context'] })

  const idle = await $.ui.mount({ plugin: 'mod-prompt-hints', surface: 'desktop', component: 'PromptHint', props: { isDraft: false, isWorking: false, hint: '? for shortcuts' } })
  expect(await idle.find({ type: 'Text', text: 'context 85% - press Compact · 1 runner died · 1 session waiting for you' })).toBeDefined()
  const typing = await $.ui.mount({ plugin: 'mod-prompt-hints', surface: 'desktop', component: 'PromptHint', props: { isDraft: true, isWorking: false, hint: '? for shortcuts' } })
  expect(await typing.find({ type: 'Text', text: '? for shortcuts' })).toBeDefined()
})
