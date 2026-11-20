import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { On, TurnStepResult } from 'claude-code'

// The readings draw into the band's own row (context-band), which the engine asks
// only of a plugin of that name: this stand-in hooks it and passes to the test's hooks.
const BAND_ROW = {
  name: 'context-band',
  register: (on: On) => {
    on('ui.render', { component: 'AbovePrompt' }, ($, e, next) => next(e))
  },
}

const HOME = '/home/me'
const NOW = 1_760_000_000_000
const MINUTE = 60_000
const BAND = {
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 60, bodyColumns: 140, scroll: { offset: 0, bodyRows: 60 }, view: {} },
} as const
const PANE = {
  component: 'Pane',
  requestId: 'mission',
  props: { title: 'Overview', isFocused: false, bodyColumns: 90, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
} as const
const COMMAND = { origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } } as const

type World = { opened: string[] }

function answerWorld(on: On, clock: MockClock, isPlaced: boolean): World {
  const world: World = { opened: [] }
  const files = new Map<string, string>([
    [`${HOME}/.claude/mods/limits.json`, JSON.stringify({ at: NOW, windows: [{ kind: 'five_hour', percentUsed: 34 }, { kind: 'seven_day', percentUsed: 82 }] })],
    [`${HOME}/.claude/mods/machine.json`, JSON.stringify({ at: NOW, freePct: 76, disk: { usedPct: 96 } })],
    [`${HOME}/.claude/mods/pulls.json`, JSON.stringify({ '/work/app#main': { at: NOW, pull: { number: 345, state: 'OPEN', checks: { passed: 3, failed: 1, pending: 0 }, review: '' } } })],
    [
      `${HOME}/.claude/context-band/sessions/sess-here.json`,
      JSON.stringify({
        sessionId: 'sess-here',
        cwd: '/work/app',
        updatedAt: NOW,
        isEnded: false,
        fill: 32,
        task: { title: 'Mod 0', percent: 70 },
        turn: { isWorking: true, since: NOW },
        runners: [
          { id: 'b1', description: 'Head job', seenAt: NOW - 90 * MINUTE, endedAt: null, status: 'running', progress: { targets: [{ status: 'RUNNING' }] } },
          { id: 'b2', description: 'Base job', seenAt: NOW - 3 * 60 * MINUTE, endedAt: NOW - 2 * 60 * MINUTE, status: 'completed' },
          { id: 'b3', description: 'Old job', seenAt: NOW - 9 * 60 * MINUTE, endedAt: NOW - 8 * 60 * MINUTE, status: 'completed' },
        ],
      }),
    ],
  ])
  mock.env(on, { HOME })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/work/app' }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('fs.exists', ($, e) => ({ value: files.has(e.path) || [...files.keys()].some(path => path.startsWith(`${e.path}/`)) }))
  on('fs.read', ($, e) => {
    const text = files.get(e.path)

    return text === undefined ? { deny: `ENOENT: ${e.path}` } : { value: text }
  })
  on('fs.list', ($, e) => ({
    value: [...files.keys()]
      .filter(path => path.startsWith(`${e.path}/`))
      .map(path => ({ name: path.slice(e.path.length + 1), kind: 'file' as const, size: 1, mtimeMs: clock.now(), isLink: false })),
  }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [] } }))
  on('turn.step', async function* ($, e) {
    const response: TurnStepResult = {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'tool_use',
      usage: { input_tokens: 0, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: [40_000, 60_000, 90_000][e.index] ?? 0, model: e.model },
    }

    return response
  })
  on('ui.open', ($, e) => {
    world.opened.push(e.id)

    return { value: isPlaced ? { isPlaced: true as const } : { isPlaced: false as const, reason: 'no panes here' } }
  })
  on('ui.close', () => ({ value: undefined }))
  on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'Box' as const, children: [{ type: 'Text' as const, children: ['beneath'] }] }))

  return world
}

async function steps($: Engine): Promise<void> {
  for (const index of [0, 1, 2]) {
    const stream = $.turn.step({ turnId: 't1', index, model: 'claude-opus-5-5', messageCount: 3 })
    for await (const _chunk of stream) {
      // drained
    }
    await stream.result
  }
}

test('the overview opens as a pane with charts on the desktop and text bars on the terminal', { plugins: [BAND_ROW] }, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const world = answerWorld(on, clock, true)
  await $.session.start({ cwd: '/work/app', surface: 'desktop', isInteractive: true })
  await steps($)
  await $.command.run({ command: 'mission', args: '', ...COMMAND })
  expect(world.opened).toEqual(['mission'])

  const desktop = await $.ui.mount({ plugin: 'mod-mission', surface: 'desktop', ...PANE })
  const charts = await desktop.findAll({ type: 'Svg' })
  expect(charts.map(found => String(found.props.alt))).toEqual([
    'Context fill over the last 3 steps',
    'Subscription limit use',
    "Every session's runners on a timeline",
  ])
  expect(String(charts[0]?.props.source)).toContain('<polyline')
  expect(String(charts[2]?.props.source)).toContain('Head job · app')
  expect(String(charts[2]?.props.source)).not.toContain('Old job')
  const texts = (await desktop.findAll({ type: 'Text' })).map(found => found.text)
  expect(texts).toEqual(expect.arrayContaining(['Runners in 4 hours: 2', 'Sessions: 1', 'memory 76% free · disk 96% · PR #345 open, checks 3/4, 1 ✕']))

  const terminal = await $.ui.mount({ plugin: 'mod-mission', surface: 'terminal', ...PANE })
  expect(await terminal.findAll({ type: 'Svg' })).toEqual([])
  expect((await terminal.findAll({ type: 'Text' })).map(found => found.text)).toEqual(expect.arrayContaining(['Week limit', '82%', '● running', '✓ done']))
})

test('where the surface places no pane, the overview opens as a section of the band', { plugins: [BAND_ROW] }, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  answerWorld(on, clock, false)
  await $.session.start({ cwd: '/work/app', surface: 'desktop', isInteractive: true })
  const band = await $.ui.mount({ plugin: 'mod-mission', surface: 'desktop', ...BAND })
  expect((await band.findAll({ type: 'Text' })).map(found => found.text)).toEqual(['beneath'])

  await $.command.run({ command: 'mission', args: '', ...COMMAND })
  expect((await band.findAll({ type: 'Text' })).map(found => found.text)).toEqual(expect.arrayContaining(['beneath', 'Overview', 'everything from the mods in one place', 'Sessions: 1']))
  expect((await band.findAll({ type: 'Svg' })).length).toBe(3)
})
