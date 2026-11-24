import { expect, test } from 'claude-code/testing'
import type { Mounted } from 'claude-code/testing'
import type { On } from 'claude-code'

import { shortTokens } from './register'

const LEDGER = '/home/u/.claude/mods/side-models.json'
const STATE = '/home/u/.claude/mods/state.json'
const NOW = Date.parse('2026-11-24T12:00:00Z')

// A mod that asks a model once per answer, as a judge does.
const JUDGE = {
  name: 'judge-mod',
  register: (on: On) => {
    on('turn.complete', async ($, e, next) => {
      const r = await $.model.complete({ model: 'sonnet', prompt: 'check this', maxTokens: 100 })
      $.ui.log(r.isAnswered ? 'answered' : `not answered: ${r.reason}`)

      return next(e)
    })
  },
}

function world(on: On, opts: { ledger?: string; switches?: string } = {}) {
  const files = new Map<string, string>()
  if (opts.ledger !== undefined) files.set(LEDGER, opts.ledger)
  if (opts.switches !== undefined) files.set(STATE, opts.switches)
  const asked: string[] = []
  const logs: string[] = []
  let clock = NOW
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('clock.now', () => ({ value: (clock += 1_500) }))
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home/u' : undefined }))
  on('fs.exists', (_, e) => ({ value: files.has(e.path) }))
  on('fs.stat', () => ({ value: { kind: 'file', size: 80, mtimeMs: 1, isLink: false } }))
  on('fs.read', (_, e) => (files.has(e.path) ? { value: files.get(e.path) ?? '' } : { deny: 'no such file' }))
  on('fs.write', (_, e) => {
    files.set(e.path, e.text)

    return { value: undefined }
  })
  on('ui.log', (_, e) => {
    logs.push(e.text)

    return { value: undefined }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('model.complete', (_, e) => {
    asked.push(e.prompt)

    return { value: { isAnswered: true, text: 'ok', usage: { input_tokens: 9_000, output_tokens: 600, cache_read_input_tokens: 1_000, cache_creation_input_tokens: 0 } } }
  })
  on('turn.complete', (_, e) => ({ text: e.answer }))

  return { files, asked, logs }
}

const answer = ($: { turn: { complete: (input: never) => Promise<unknown> } }, turnId: string) =>
  $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId, reason: 'answer' } as never)

// The rows draw into the band's own row (context-band), which the engine asks only of a plugin
// of that name: this stand-in hooks it and passes down to what lies beneath.
const BAND_ROW = {
  name: 'context-band',
  register: (on: On) => {
    on('ui.render', { component: 'AbovePrompt' }, ($, e, next) => next(e))
  },
}

const BAND = { plugin: 'cost-meter', surface: 'desktop', component: 'AbovePrompt', props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 30, bodyColumns: 100, scroll: { offset: 0, bodyRows: 30 }, view: {} } } as const

test("each mod's model calls are counted per day: calls, tokens in (cache reads included) and out, time", { plugins: [BAND_ROW, JUDGE] }, async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await answer($ as never, 'T1')
  await answer($ as never, 'T2')
  const ledger = JSON.parse(w.files.get(LEDGER) ?? '{}') as Record<string, Record<string, { calls: number; input: number; output: number; ms: number }>>
  expect(ledger['2026-11-24']?.['judge-mod']).toEqual({ calls: 2, input: 20_000, output: 1_200, ms: 3_000 })
  expect(w.asked).toHaveLength(2)
  // Below any cap, no row above the prompt.
  const band = await $.ui.mount(BAND)
  expect(await band.find({ type: 'Text', text: 'Side models' })).toBeUndefined()
  await band.unmount()
})

test('at the daily cap a call is not made, the calling mod is told, and the band says so', { plugins: [BAND_ROW, JUDGE] }, async ($, on) => {
  const spent = JSON.stringify({ '2026-11-24': { 'judge-mod': { calls: 40, input: 480_000, output: 30_000, ms: 1 } } })
  const w = world(on, { ledger: spent, switches: JSON.stringify({ off: [], modSettings: { 'cost-meter': { cap: '500k' } } }) })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await answer($ as never, 'T1')
  expect(w.asked).toEqual([])
  expect(w.logs).toContain('not answered: aborted')
  const band = await $.ui.mount(BAND)
  const texts = await shownTexts(band)
  // A chip on the band's one line, in the error tone: the day's share of the cap.
  expect(texts.slice(texts.indexOf('Models'), texts.indexOf('Models') + 2)).toEqual(['Models', '100%'])
  await band.unmount()
})

test('another day starts from nothing; days older than two weeks are dropped', { plugins: [JUDGE] }, async ($, on) => {
  const old = Object.fromEntries(Array.from({ length: 14 }, (_, i) => [`2026-11-${String(i + 1).padStart(2, '0')}`, { x: { calls: 1, input: 1, output: 1, ms: 1 } }]))
  const w = world(on, { ledger: JSON.stringify(old), switches: JSON.stringify({ off: [], modSettings: { 'cost-meter': { cap: '500k' } } }) })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await answer($ as never, 'T1')
  const days = Object.keys(JSON.parse(w.files.get(LEDGER) ?? '{}') as object)
  expect(days).toHaveLength(14)
  expect(days[0]).toBe('2026-11-02')
  expect(days.at(-1)).toBe('2026-11-24')
})

test('switched off in the Mods panel, nothing is counted or stopped', { plugins: [JUDGE] }, async ($, on) => {
  const w = world(on, { switches: JSON.stringify({ off: ['cost-meter'] }) })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await answer($ as never, 'T1')
  expect(w.asked).toHaveLength(1)
  expect(w.files.has(LEDGER)).toBe(false)
})

test('token counts read short', () => {
  expect([shortTokens(950), shortTokens(19_095), shortTokens(2_214_000)]).toEqual(['950', '19k', '2.2M'])
})

// ---- shown texts ----
// A chip's card is drawn hidden (display none) and shown only while the pointer
// is on the chip, in the hover group they share. These read the mounted tree.
type DrawnNode = { type?: string; props?: { display?: unknown }; hover?: { scope?: unknown; display?: unknown }; children?: unknown[] }

// The texts on screen now, in order: what waits hidden is left out.
async function shownTexts(ui: Pick<Mounted, 'findAll'>): Promise<string[]> {
  return textsIn((await ui.findAll({}))[0], true)
}

// The texts of the card the chip of hover group `scope` opens; undefined when it has none.
async function cardTexts(ui: Pick<Mounted, 'findAll'>, scope: string): Promise<string[] | undefined> {
  const card = cardIn((await ui.findAll({}))[0], scope)

  return card === undefined ? undefined : textsIn(card, false)
}

function cardIn(node: unknown, scope: string): DrawnNode | undefined {
  if (typeof node !== 'object' || node === null) {
    return undefined
  }
  const drawn = node as DrawnNode
  if (drawn.props?.display === 'none' && drawn.hover?.scope === scope && drawn.hover.display === 'flex') {
    return drawn
  }
  for (const child of drawn.children ?? []) {
    const card = cardIn(child, scope)
    if (card !== undefined) {
      return card
    }
  }

  return undefined
}

function textsIn(node: unknown, isShownOnly: boolean): string[] {
  if (typeof node === 'string' || typeof node === 'number') {
    return [String(node)]
  }
  if (typeof node !== 'object' || node === null) {
    return []
  }
  const drawn = node as DrawnNode
  if (isShownOnly && drawn.props?.display === 'none') {
    return []
  }
  const inner = (drawn.children ?? []).flatMap(child => textsIn(child, isShownOnly))

  return drawn.type === 'Text' ? [inner.join('')] : inner
}
// ---- end of shown texts ----
