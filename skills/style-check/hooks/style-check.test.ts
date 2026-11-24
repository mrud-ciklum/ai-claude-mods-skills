import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { findings } from './register'

const UK = 'Готово: мод перевіряє кожну відповідь і показує, що в ній не так, одним рядком під нею, без жодної моделі.'
const EN = 'Done: the mod checks every answer and shows what is wrong with it in one line under it, with no model at all.'

function world(on: On, switches?: string) {
  const file = '/home/u/.claude/mods/state.json'
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home/u' : undefined }))
  on('fs.exists', (_, e) => ({ value: e.path === file && switches !== undefined }))
  on('fs.stat', () => ({ value: { kind: 'file', size: 80, mtimeMs: 1, isLink: false } }))
  on('fs.read', (_, e) => (e.path === file && switches !== undefined ? { value: switches } : { deny: 'no such file' }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('prompt.submit', (_, e) => ({ text: e.text, context: e.context }))
}

const answer = async ($: unknown, text: string) =>
  (await ($ as { turn: { complete: (input: never) => Promise<{ text?: string }> } }).turn.complete({ answer: text, durationMs: 1, isAborted: false, turnId: 'T', reason: 'answer' } as never)).text
const next = async ($: unknown) =>
  (await ($ as { prompt: { submit: (input: never) => Promise<{ context?: string[] }> } }).prompt.submit({ text: 'next', wait: false, origin: { kind: 'composer' } } as never)).context ?? []

test('an em dash shows under the answer and rides once with the next prompt', async ($, on) => {
  world(on)
  expect(await answer($, `Done \u2014 the mod works \u2014 mostly.`)).toBe('Style: 2 em dashes; write "-" instead')
  expect(await next($)).toEqual(["style-check: your last answer broke the user's writing rules: 2 em dashes; write \"-\" instead. Keep to them from this answer on."])
  expect(await next($)).toEqual([])
  // In code it is not prose.
  expect(await answer($, 'Run `echo a \u2014 b` and see.')).toBe('Run `echo a \u2014 b` and see.')
})

test('with Ukrainian picked in the Mods panel, an English answer is named; a short one is not judged', async ($, on) => {
  world(on, JSON.stringify({ off: [], modSettings: { 'style-check': { language: 'uk' } } }))
  await ($ as never as { session: { start: (i: never) => Promise<unknown> } }).session.start({ cwd: '/', surface: 'desktop', isInteractive: true } as never)
  expect(await answer($, EN)).toBe('Style: not in Ukrainian, the language picked for answers')
  expect(await answer($, UK)).toBe(UK)
  expect(await answer($, 'Done.')).toBe('Done.')
})

test('switched off in the Mods panel, nothing is named', async ($, on) => {
  world(on, JSON.stringify({ off: ['style-check'] }))
  await ($ as never as { session: { start: (i: never) => Promise<unknown> } }).session.start({ cwd: '/', surface: 'desktop', isInteractive: true } as never)
  expect(await answer($, 'a \u2014 b')).toBe('a \u2014 b')
})

test('the rules read prose only, and a language only when it is asked for', () => {
  expect(findings('```\nx \u2014 y\n```\nSee https://x.dev/a\u2014b', 'any')).toEqual([])
  expect(findings(EN, 'any')).toEqual([])
  expect(findings(UK, 'en')).toEqual(['not in English, the language picked for answers'])
})
