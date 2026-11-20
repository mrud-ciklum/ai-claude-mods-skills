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

const call = (tool: string, isErrored = false) => ({ tool, input: {}, isRunning: false, isErrored, isInterrupted: false, tool_use_id: `${tool}-${Math.random()}` })

test('a finished group reads as one line of what it did, and opens on a press', async ($, on) => {
  answerDisk(on, mock.clock(on, { now: NOW }), new Map())
  on('ui.render', { component: 'ToolGroup' }, ($, e) => ({ type: 'Text' as const, children: [e.props.isExpanded ? 'engine rows' : 'engine group'] }))
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
  const calls = [call('Read'), call('Read'), call('Read'), call('Grep'), call('Glob'), call('Bash', true), call('mcp__context-band__task_progress')]
  const ui = await $.ui.mount({ plugin: 'mod-tool-groups', surface: 'desktop', component: 'ToolGroup', requestId: 'g1', props: { calls, isActive: false, isExpanded: false } })

  const line = await ui.find({ type: 'Button' })
  expect(line?.text).toBe('▸ read 3 files · 2 searches · 1 command')
  expect((await ui.find({ type: 'Text', text: '1 failed' }))?.props.color).toBe('error')
  await ui.press({ key: line?.key ?? '' })
  expect(await ui.find({ type: 'Text', text: 'engine rows' })).toBeDefined()

  const live = await $.ui.mount({ plugin: 'mod-tool-groups', surface: 'desktop', component: 'ToolGroup', requestId: 'g2', props: { calls, isActive: true, isExpanded: false } })
  expect(await live.find({ type: 'Text', text: 'engine group' })).toBeDefined()
})
