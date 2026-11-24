import { expect, mock, test } from 'claude-code/testing'
import type { MockClock } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { TurnStepResult } from 'claude-code'

import { modelLabel } from '../hooks/register'

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


test('the footer shows the model, the effort and the modes as one badge', async ($, on) => {
  answerDisk(on, mock.clock(on, { now: NOW }), new Map())
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('turn.step', async function* ($, e) {
    const response: TurnStepResult = { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }

    return response
  })
  on('ui.render', { component: 'SessionMode' }, ($, e) => ({ type: 'Text' as const, children: [e.props.modes.join(' & ')] }))
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'mod-mode-badge', surface: 'desktop', component: 'SessionMode', props: { modes: ['focus'] } })
  expect((await ui.findAll({ type: 'Text' })).map(found => found.text)).toEqual(['Opus 5.5', 'focus'])

  const stream = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', effort: 'max', messageCount: 2 })
  for await (const _chunk of stream) {
    // drained
  }
  await stream.result
  expect((await ui.findAll({ type: 'Text' })).map(found => found.text)).toEqual(['Opus 5.5', 'effort max', 'focus'])
})

test('a model id reads as its family and version, without a date or a [1m] suffix', () => {
  expect(modelLabel('claude-opus-5-5')).toBe('Opus 5.5')
  expect(modelLabel('claude-fable-5-2')).toBe('Fable 5.2')
  expect(modelLabel('claude-opus-5-5[1m]')).toBe('Opus 5.5')
  expect(modelLabel('claude-sonnet-4-20250514')).toBe('Sonnet 4')
  expect(modelLabel('claude-opus-4-1-20250805')).toBe('Opus 4.1')
  expect(modelLabel('gpt-x')).toBe('gpt-x')
})
