import { expect, mock, test } from 'claude-code/testing'
import type { MockClock } from 'claude-code/testing'
import type { On, SessionMeasureInput, SessionRateLimit } from 'claude-code'

// The readings draw into the band's own row (context-band), which the engine asks
// only of a plugin of that name: this stand-in hooks it and passes to the test's hooks.
const BAND_ROW = {
  name: 'context-band',
  register: (on: On) => {
    on('ui.render', { component: 'AbovePrompt' }, ($, e, next) => next(e))
  },
}

const HOME = '/home/me'
const SHARED = `${HOME}/.claude/mods/limits.json`
const SWITCHES = `${HOME}/.claude/mods/state.json`
const NOW = Date.parse('2026-10-13T12:00:00Z')
const MINUTE = 60_000
const HOUR = 60 * MINUTE

const BAND = {
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isCollapsed: false,
    isWorking: false,
    maxRows: 30,
    bodyColumns: 120,
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

// The five-hour window resets in 2 h 10 min, the weekly one in 3 days 4 hours.
function windows(fiveHour: number, week: number): SessionRateLimit[] {
  return [
    { kind: 'seven_day', percentUsed: week, resetsAt: new Date(NOW + 76 * HOUR).toISOString() },
    { kind: 'five_hour', percentUsed: fiveHour, resetsAt: new Date(NOW + 2 * HOUR + 10 * MINUTE).toISOString() },
  ]
}

function measured(rateLimits: SessionRateLimit[]): SessionMeasureInput {
  return { context: { tokens: 50_000, window: 200_000, percent: 25 }, rateLimits, changed: ['rateLimits'] }
}

type World = { files: Map<string, string>; toasts: string[]; write: (path: string, text: string) => void }

// The disk in memory, the session's own reading, and a line another mod drew beneath.
function answerWorld(on: On, clock: MockClock, files: Map<string, string>, usage: SessionRateLimit[]): World {
  const mtimes = new Map<string, number>()
  const world: World = {
    files,
    toasts: [],
    write: (path, text) => {
      files.set(path, text)
      mtimes.set(path, clock.now())
    },
  }
  mock.env(on, { HOME })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { window: 200_000 }, rateLimits: usage, cost: { usd: 0 } },
  }))
  on('session.measure', ($, e) => ({ changed: [...e.changed] }))
  on('fs.exists', ($, e) => ({ value: files.has(e.path) }))
  on('fs.read', ($, e) => {
    const text = files.get(e.path)

    return text === undefined ? { deny: `ENOENT: ${e.path}` } : { value: text }
  })
  on('fs.write', ($, e) => {
    world.write(e.path, e.text)

    return { value: undefined }
  })
  on('fs.stat', ($, e) =>
    files.has(e.path)
      ? { value: { kind: 'file' as const, size: (files.get(e.path) ?? '').length, mtimeMs: mtimes.get(e.path) ?? 0, isLink: false } }
      : { deny: `ENOENT: ${e.path}` },
  )
  on('ui.toast', ($, e) => {
    world.toasts.push(e.text)

    return { value: undefined }
  })
  on('ui.render', { component: 'AbovePrompt' }, () => ({
    type: 'Box' as const,
    children: [{ type: 'Text' as const, children: ['beneath'] }],
  }))

  return world
}

test('windows at rest are chips, the five-hour one first; from the amber step a window is a row with its bar and the time to its reset', { plugins: [BAND_ROW] }, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  answerWorld(on, clock, new Map(), windows(34, 12))
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'mod-limits', surface, ...BAND })
    expect((await ui.findAll({ type: 'Text' })).map(found => found.text)).toEqual(['5h', '34%', 'Week', '12%', 'beneath'])
    await ui.unmount()
  }

  await $.session.measure(measured(windows(64, 12)))
  const amber = await $.ui.mount({ plugin: 'mod-limits', surface: 'desktop', ...BAND })
  expect((await amber.findAll({ type: 'Text' })).map(found => found.text)).toEqual([
    '5h limit',
    '64%',
    `${'█'.repeat(13)}${'░'.repeat(7)}`,
    'in 2h 10m',
    'Week',
    '12%',
    'beneath',
  ])
  await amber.unmount()

  // Past its reset the five-hour window holds no figure and leaves the band.
  const later = await $.ui.mount({ plugin: 'mod-limits', surface: 'desktop', ...BAND })
  await clock.advance(3 * HOUR)
  expect(await later.find({ type: 'Text', text: /^5h/ })).toBeUndefined()
  expect(await later.find({ type: 'Text', text: 'Week' })).toBeDefined()
})

test('a response that moves the limits updates the row, shares the reading and toasts once past 80%', { plugins: [BAND_ROW] }, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const world = answerWorld(on, clock, new Map(), [])
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'mod-limits', surface: 'desktop', ...BAND })
  expect(await ui.find({ type: 'Text', text: '5h limit' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'beneath' })).toBeDefined()

  await $.session.measure(measured(windows(82, 40)))
  const figure = await ui.find({ type: 'Text', text: '82%' })
  expect(figure?.props.color).toBe('error')
  expect(world.toasts).toEqual(['5h limit: 82% used, resets in 2h 10m'])
  expect(JSON.parse(world.files.get(SHARED) ?? 'null')).toMatchObject({ at: NOW, windows: windows(82, 40) })

  await $.session.measure(measured(windows(84, 40)))
  expect(await ui.find({ type: 'Text', text: '84%' })).toBeDefined()
  expect(world.toasts).toHaveLength(1)
})

test('switched off in the mods panel the row is gone and nothing is toasted', { plugins: [BAND_ROW] }, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const files = new Map<string, string>()
  const world = answerWorld(on, clock, files, windows(34, 12))
  world.write(SWITCHES, JSON.stringify({ off: ['mod-limits'], isPaneWanted: true, updatedAt: 1 }))
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ plugin: 'mod-limits', surface: 'desktop', ...BAND })
  expect(await ui.find({ type: 'Text', text: '5h limit' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'beneath' })).toBeDefined()
  await $.session.measure(measured(windows(90, 12)))
  expect(world.toasts).toEqual([])

  await clock.advance(10)
  world.write(SWITCHES, JSON.stringify({ off: [], isPaneWanted: true, updatedAt: 2 }))
  await clock.advance(1_500)
  expect(await ui.find({ type: 'Text', text: '90%' })).toBeDefined()
})

test('a session without a reading of its own shows the newer one another session shared', { plugins: [BAND_ROW] }, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const world = answerWorld(on, clock, new Map(), [])
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'mod-limits', surface: 'desktop', ...BAND })
  expect(await ui.find({ type: 'Text', text: '5h limit' })).toBeUndefined()

  world.write(SHARED, JSON.stringify({ windows: windows(65, 20), at: NOW + 30_000 }))
  await clock.advance(MINUTE)
  expect(await ui.find({ type: 'Text', text: '65%' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'in 2h 9m' })).toBeDefined()
})

test('in quiet mode the rows wait until a window reaches 60%', { plugins: [BAND_ROW] }, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const world = answerWorld(on, clock, new Map(), windows(34, 12))
  world.write(SWITCHES, JSON.stringify({ off: [], quiet: true }))
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'mod-limits', surface: 'desktop', ...BAND })
  expect((await ui.findAll({ type: 'Text' })).map(found => found.text)).toEqual(['beneath'])

  await $.session.measure(measured(windows(64, 12)))
  expect(await ui.find({ type: 'Text', text: '5h limit' })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: '64%' }))?.props.color).toBe('warning')
})
