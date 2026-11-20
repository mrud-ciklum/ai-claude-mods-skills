import { expect, mock, test } from 'claude-code/testing'
import type { MockClock } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { SessionContextBreakdown, SessionMessage } from 'claude-code'

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


const SUMMARY: SessionMessage = { role: 'user', text: 'Summary.', toolUses: [] }

function breakdown(percentage: number): SessionContextBreakdown {
  return {
    categories: [],
    totalTokens: percentage * 2_000,
    maxTokens: 200_000,
    rawMaxTokens: 200_000,
    autocompactSource: 'auto',
    percentage,
    gridRows: [],
    model: 'claude-opus-5-5',
    memoryFiles: [],
    mcpTools: [],
    agents: [],
    skills: { totalSkills: 0, includedSkills: 0, tokens: 0, skillFrontmatter: [] },
    autoCompactThreshold: 167_000,
    isAutoCompactEnabled: true,
    apiUsage: null,
  }
}

test('after a compaction its output and a toast say how full the context was and is', async ($, on) => {
  answerDisk(on, mock.clock(on, { now: NOW }), new Map())
  const toasts: string[] = []
  on('ui.toast', ($, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })
  on('session.measure', ($, e) => ({ changed: [...e.changed] }))
  on('session.usage', ($, e) => ({ value: { startedAt: 0, context: e.breakdown === undefined ? { window: 200_000 } : { window: 200_000, breakdown: breakdown(31) }, rateLimits: [] } }))
  on('session.compact', () => ({ messages: [SUMMARY] }))
  on('ui.render', { component: 'CommandOutput' }, ($, e) => ({ type: 'Text' as const, children: [e.props.text] }))
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
  await $.session.measure({ context: { tokens: 164_000, window: 200_000, percent: 82 }, rateLimits: [], changed: ['context'] })

  await $.session.compact({ trigger: 'manual', messages: [SUMMARY] })
  const ui = await $.ui.mount({ plugin: 'mod-compact-marks', surface: 'desktop', component: 'CommandOutput', props: { command: 'compact', args: '', text: 'Compacted.', isErrored: false } })
  expect((await ui.findAll({ type: 'Text' })).map(found => found.text)).toEqual(['Compacted.', 'context 82% → ~31%'])
  expect(toasts).toEqual([])

  await $.session.measure({ context: { tokens: 166_000, window: 200_000, percent: 83 }, rateLimits: [], changed: ['context'] })
  await $.session.compact({ trigger: 'auto', messages: [SUMMARY] })
  expect(toasts).toEqual(['Auto-compact: context 83% → ~31%'])
})
