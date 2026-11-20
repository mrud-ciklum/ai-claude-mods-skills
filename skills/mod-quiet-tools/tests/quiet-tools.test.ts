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

const ROW = { isRunning: false, isErrored: false, isInterrupted: false, input: {} } as const

test("the band's own tool calls leave the conversation; other tools stay as they were", async ($, on) => {
  answerDisk(on, mock.clock(on, { now: NOW }), new Map())
  on('ui.render', { component: 'ToolUse' }, ($, e) => ({ type: 'Text' as const, children: [`row ${e.props.tool}`] }))
  on('ui.render', { component: 'ToolResult' }, () => ({ type: 'Text' as const, children: ['result'] }))
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })

  const quiet = await $.ui.mount({ plugin: 'mod-quiet-tools', surface: 'desktop', component: 'ToolUse', requestId: 't1', props: { ...ROW, tool_use_id: 't1', tool: 'mcp__context-band__task_progress' } })
  expect(await quiet.findAll({ type: 'Text' })).toEqual([])
  const result = await $.ui.mount({ plugin: 'mod-quiet-tools', surface: 'desktop', component: 'ToolResult', requestId: 't1', props: { tool_use_id: 't1', tool: 'mcp__context-band__runner_info', output: {}, isErrored: false } })
  expect(await result.findAll({ type: 'Text' })).toEqual([])
  const bash = await $.ui.mount({ plugin: 'mod-quiet-tools', surface: 'desktop', component: 'ToolUse', requestId: 't2', props: { ...ROW, tool_use_id: 't2', tool: 'Bash' } })
  expect(await bash.find({ type: 'Text', text: 'row Bash' })).toBeDefined()
})
