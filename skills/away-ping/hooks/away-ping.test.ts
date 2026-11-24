import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { closingQuestion } from './register'

function world(on: On, switches?: string) {
  const sent: { text: string; title?: string }[] = []
  const file = '/home/u/.claude/mods/state.json'
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home/u' : undefined }))
  on('fs.exists', (_, e) => ({ value: e.path === file && switches !== undefined }))
  on('fs.stat', () => ({ value: { kind: 'file', size: 80, mtimeMs: 1, isLink: false } }))
  on('fs.read', (_, e) => (e.path === file && switches !== undefined ? { value: switches } : { deny: 'no such file' }))
  on('ui.notify', (_, e) => {
    sent.push({ text: e.text, title: e.title })

    return { value: { isSent: true, channel: 'terminal' } } as never
  })
  on('turn.complete', (_, e) => ({ text: e.answer }))

  return { sent }
}

const end = ($: unknown, answer: string, durationMs: number) =>
  ($ as { turn: { complete: (i: never) => Promise<unknown> } }).turn.complete({ answer, durationMs, isAborted: false, turnId: 'T', reason: 'answer' } as never)
const start = ($: unknown) => ($ as { session: { start: (i: never) => Promise<unknown> } }).session.start({ cwd: '/', surface: 'desktop', isInteractive: true } as never)

test('an answer that ends with a question sends it; a long turn sends that it is done; a short plain one sends nothing', async ($, on) => {
  const w = world(on)
  await end($, 'Merged into main.\n\nShould I delete the branch?', 2_000)
  await end($, 'All 25 mods pass.\nNothing else changed.', 7 * 60_000)
  await end($, 'Done.', 2_000)
  expect(w.sent).toEqual([
    { text: 'Should I delete the branch?', title: 'Claude asks' },
    { text: 'Done after 7 min: All 25 mods pass.', title: 'Claude finished' },
  ])
})

test('the long-turn time comes from the Mods panel; never sends only questions', async ($, on) => {
  const w = world(on, JSON.stringify({ off: [], modSettings: { 'away-ping': { after: 'never' } } }))
  await start($)
  await end($, 'All 25 mods pass.', 60 * 60_000)
  await end($, 'Open the PR?', 1_000)
  expect(w.sent.map(s => s.title)).toEqual(['Claude asks'])
})

test('switched off in the Mods panel, nothing is sent', async ($, on) => {
  const w = world(on, JSON.stringify({ off: ['away-ping'] }))
  await start($)
  await end($, 'Open the PR?', 1_000)
  expect(w.sent).toEqual([])
})

test('the closing question is the last sentence, if it asks', () => {
  expect(closingQuestion('Done. Want me to push?')).toBe('Want me to push?')
  expect(closingQuestion('Is it on? Yes, it is.')).toBeUndefined()
  expect(closingQuestion('Run:\n```\nwhat?\n```\nDone.')).toBeUndefined()
  expect(closingQuestion('- Merge now, or after a look?')).toBe('Merge now, or after a look?')
})
