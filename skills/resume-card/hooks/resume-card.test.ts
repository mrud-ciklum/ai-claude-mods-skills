import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { ago, lastRecap, shortAgo } from './register'

const DIR = '/home/u/.claude/projects/-work-app'
const NOW = Date.parse('2026-11-24T12:00:00Z')
const HOUR = 3_600_000

// A transcript row with a wrap-up call, as the app writes it.
const wrapUp = (recap: string, ask?: string) =>
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__ccd_turn__wrap_up', input: { recap, ...(ask ? { ask } : {}) } }] } })
const said = (text: string) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } })

function world(on: On, files: Record<string, { text: string; mtimeMs: number }>, switches?: string) {
  const state = '/home/u/.claude/mods/state.json'
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('clock.now', () => ({ value: NOW }))
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home/u' : undefined }))
  on('session.cwd', () => ({ value: '/work/app/src' }))
  on('session.id', () => ({ value: 'NOW' }))
  on('fs.exists', (_, e) => ({ value: e.path === DIR || (e.path === state && switches !== undefined) }))
  on('fs.stat', () => ({ value: { kind: 'file', size: 80, mtimeMs: 1, isLink: false } }))
  on('fs.list', (_, e) => ({
    value: e.path === DIR ? Object.entries(files).map(([name, f]) => ({ name, kind: 'file' as const, size: f.text.length, mtimeMs: f.mtimeMs, isLink: false })) : [],
  }))
  on('fs.read', (_, e) => {
    if (e.path === state && switches !== undefined) return { value: switches }
    const f = files[e.path.slice(DIR.length + 1)]
    if (!e.path.startsWith(`${DIR}/`) || f === undefined) return { deny: 'no such file' }
    const from = e.offset ?? 0

    return { value: f.text.slice(from, from + (e.length ?? f.text.length)) }
  })
  on('prompt.submit', (_, e) => ({ text: e.text, context: e.context }))
}

// The rows draw into the band's own row (context-band), which the engine asks only of a plugin
// of that name: this stand-in hooks it and passes down to what lies beneath.
const BAND_ROW = {
  name: 'context-band',
  register: (on: On) => {
    on('ui.render', { component: 'AbovePrompt' }, ($, e, next) => next(e))
  },
}

const BAND = { plugin: 'resume-card', surface: 'desktop', component: 'AbovePrompt', props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 30, bodyColumns: 100, scroll: { offset: 0, bodyRows: 30 }, view: {} } } as const
const PANE = { plugin: 'resume-card', surface: 'desktop', component: 'Pane', requestId: 'resume-card', props: { title: 'Last time here', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } } as const

const FILES = {
  'a.jsonl': { text: [said('hi'), wrapUp('Added the importer; tests pass.', 'Open the PR?'), said('done')].join('\n'), mtimeMs: NOW - 3 * HOUR },
  'b.jsonl': { text: [wrapUp('Older work.'), said('x')].join('\n'), mtimeMs: NOW - 30 * HOUR },
  'c.jsonl': { text: said('no summary here'), mtimeMs: NOW - 2 * HOUR },
  'old.jsonl': { text: wrapUp('Too old.'), mtimeMs: NOW - 20 * 24 * HOUR },
  'NOW.jsonl': { text: wrapUp('This very session.'), mtimeMs: NOW },
}

test("a new session shows how the last session in this folder ended, until its first prompt", { plugins: [BAND_ROW] }, async ($, on) => {
  world(on, FILES)
  await $.session.start({ cwd: '/work/app/src', surface: 'desktop', isInteractive: true })
  const band = await $.ui.mount(BAND)
  const texts = (await band.findAll({ type: 'Text' })).map(found => found.text)
  // On the band's grid: its name, how long ago in the figure column, the summary on one line.
  expect(texts.slice(texts.indexOf('Last time'), texts.indexOf('Last time') + 3)).toEqual(['Last time', '3h', 'Added the importer; tests pass.'])
  expect(await band.find({ type: 'Button', key: 'resume-more', text: '1 more' })).toBeDefined()
  await band.unmount()

  const pane = await $.ui.mount(PANE)
  const lines = (await pane.findAll({ type: 'Text' })).map(found => found.text)
  expect(lines).toEqual(['3 h ago', 'Added the importer; tests pass.', 'It asked: Open the PR?', 'yesterday', 'Older work.'])
  await pane.unmount()

  await $.prompt.submit({ text: 'go on', wait: false, origin: { kind: 'composer' } })
  const after = await $.ui.mount(BAND)
  expect(await after.find({ type: 'Text', text: 'Last time' })).toBeUndefined()
  await after.unmount()
})

test('Hide takes the card away', { plugins: [BAND_ROW] }, async ($, on) => {
  world(on, FILES)
  await $.session.start({ cwd: '/work/app/src', surface: 'desktop', isInteractive: true })
  const band = await $.ui.mount(BAND)
  await band.press({ key: 'resume-hide' })
  expect(await band.find({ type: 'Text', text: 'Last time' })).toBeUndefined()
  await band.unmount()
})

test('no earlier session with a summary, or the card switched off: no row', { plugins: [BAND_ROW] }, async ($, on) => {
  world(on, { 'c.jsonl': FILES['c.jsonl'] }, JSON.stringify({ off: [] }))
  await $.session.start({ cwd: '/work/app/src', surface: 'desktop', isInteractive: true })
  const band = await $.ui.mount(BAND)
  expect(await band.find({ type: 'Text', text: 'Last time' })).toBeUndefined()
  await band.unmount()
})

test('switched off in the Mods panel, no row', { plugins: [BAND_ROW] }, async ($, on) => {
  world(on, FILES, JSON.stringify({ off: ['resume-card'] }))
  await $.session.start({ cwd: '/work/app/src', surface: 'desktop', isInteractive: true })
  const band = await $.ui.mount(BAND)
  expect(await band.find({ type: 'Text', text: 'Last time' })).toBeUndefined()
  await band.unmount()
})

test('the last wrap-up of a tail is found, a cut first line is skipped, and ages read plainly', () => {
  expect(lastRecap(`ut of a cut row"}\n${wrapUp('First.')}\n${wrapUp('Second.', 'Merge?')}\n${said('bye')}`)).toEqual({ recap: 'Second.', ask: 'Merge?' })
  expect(lastRecap(said('nothing'))).toBeUndefined()
  expect([ago(NOW - 5 * 60_000, NOW), ago(NOW - 3 * HOUR, NOW), ago(NOW - 30 * HOUR, NOW), ago(NOW - 72 * HOUR, NOW)]).toEqual(['5 min ago', '3 h ago', 'yesterday', '3 days ago'])
  expect([shortAgo(NOW - 5 * 60_000, NOW), shortAgo(NOW - 3 * HOUR, NOW), shortAgo(NOW - 72 * HOUR, NOW)]).toEqual(['5m', '3h', '3d'])
})
