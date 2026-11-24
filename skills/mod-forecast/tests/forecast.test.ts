import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, RenderElement, SessionContextBreakdown, TurnStepInput, TurnStepResult } from 'claude-code'

// The readings draw into the band's own row (context-band), which the engine asks
// only of a plugin of that name: this stand-in hooks it and passes to the test's hooks.
const BAND_ROW = {
  name: 'context-band',
  register: (on: On) => {
    on('ui.render', { component: 'AbovePrompt' }, ($, e, next) => next(e))
  },
}

// The band itself, drawn by a plugin as context-band draws it in a session: a mod
// above it gets this tree open and finds the slots in it, where a tree the test's own
// hooks drew would reach the mod as the engine's opaque node. An inline plugin runs
// apart from this file, so all it draws is defined inside. With /test/band-blank
// answered it is the band at a set height leaving that many blank rows, carrying the
// engine's node in its sections; unanswered, the band at auto height.
const BAND_DRAWN = {
  name: 'context-band',
  register: (on: On) => {
    on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
      const engine = await next(e)
      const box = (key: string | null, ...children: unknown[]) => ({
        type: 'Box' as const,
        props: key === null ? { flexDirection: 'column' as const } : { key, flexDirection: 'column' as const },
        children,
      })
      const text = (value: string) => ({ type: 'Text' as const, children: [value] })
      const chipLine = { type: 'Box' as const, props: { key: 'context-band:chips', columnGap: 2, flexWrap: 'wrap' as const }, children: [] }
      const limits = box('context-band:meters', box('meter:02:mod-limits', text('5h limit')))
      const blankText = await $.fs.read('/test/band-blank').catch(() => '')
      if (blankText === '') {
        return box('context-band:root', text('Context'), chipLine, limits, box('context-band:sections'), text('Task')) as unknown as RenderElement
      }
      const blank = Number(blankText)

      return box(
        'context-band:root',
        text('Context'),
        box(
          `context-band:fit:${3 + blank}`,
          chipLine,
          limits,
          box('context-band:sections', box('section:04:mod-sessions', text('Sessions'), text('one more')), engine),
          box('context-band:pad', ...Array.from({ length: blank }, () => text('\u00a0'))),
        ),
        text('Task'),
      ) as unknown as RenderElement
    })
  },
}

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

function breakdownWith(threshold: number | null): SessionContextBreakdown {
  return {
    categories: [],
    totalTokens: 40_000,
    maxTokens: 200_000,
    rawMaxTokens: 200_000,
    autocompactSource: 'auto',
    percentage: 20,
    gridRows: [],
    model: 'claude-opus-5-5',
    memoryFiles: [],
    mcpTools: [],
    agents: [],
    skills: { totalSkills: 0, includedSkills: 0, tokens: 0, skillFrontmatter: [] },
    autoCompactThreshold: threshold ?? 0,
    isAutoCompactEnabled: threshold !== null,
    apiUsage: null,
  }
}

// A window of 200k; auto-compaction at the threshold given, or off.
function answerWorld(on: On, threshold: number | null, carried: (e: TurnStepInput) => number): void {
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.usage', ($, e) => ({
    value: {
      startedAt: 0,
      context: e.breakdown === undefined ? { window: 200_000 } : { window: 200_000, breakdown: breakdownWith(threshold) },
      rateLimits: [],
    },
  }))
  on('turn.step', async function* ($, e) {
    const response: TurnStepResult = {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'tool_use',
      usage: {
        input_tokens: 0,
        output_tokens: 10,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: carried(e),
        model: e.model,
      },
    }

    return response
  })
  on('tool.call', ($, e) => ({ result: {}, text: 'x'.repeat(e.tool === 'Read' ? 32_000 : 4_000) }))
  on('ui.render', { component: 'AbovePrompt' }, () => ({
    type: 'Box' as const,
    children: [{ type: 'Text' as const, children: ['beneath'] }],
  }))
}

async function runStep($: Engine, index: number, agentId?: string): Promise<void> {
  const stream = $.turn.step({ turnId: 't1', index, model: 'claude-opus-5-5', messageCount: 3 + index, ...(agentId === undefined ? {} : { agentId }) })
  for await (const _chunk of stream) {
    // drained: the forecast reads the step's result
  }
  await stream.result
}

test('far from auto-compaction the steps left are a chip; eight or fewer away, a row with the sparkline and the growth', { plugins: [BAND_ROW] }, async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const main = [40_000, 50_000, 62_000, 140_000]
  answerWorld(on, 167_000, e => (e.agentId === undefined ? (main[e.index] ?? 0) : 190_000))
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })

  await runStep($, 0)
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  await runStep($, 1)
  await $.tool.call({ tool: 'Read', file_path: '/a.py' })
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  await runStep($, 2)
  await runStep($, 0, 'a1')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'mod-forecast', surface, ...BAND })
    const texts = (await ui.findAll({ type: 'Text' })).map(found => found.text)
    // (167k - 62k) / 11k average growth = 9.5: about 10 steps.
    expect(texts).toEqual(['Steps', '≈10', 'beneath'])
    await ui.unmount()
  }

  // A jump to 140k: (167k - 140k) / 33k average growth, about 1 step: a red row.
  await runStep($, 3)
  const near = await $.ui.mount({ plugin: 'mod-forecast', surface: 'desktop', ...BAND })
  const texts = (await near.findAll({ type: 'Text' })).map(found => found.text)
  expect(texts.slice(0, 2)).toEqual(['Steps left', '≈1'])
  expect(texts[3]).toMatch(/^\+\d+k\/step/)
  expect((await near.find({ type: 'Text', text: '≈1' }))?.props.color).toBe('error')
})

test('with auto-compaction off the row says so and forecasts nothing', { plugins: [BAND_ROW] }, async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  answerWorld(on, null, e => [30_000, 34_000][e.index] ?? 0)
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
  await runStep($, 0)
  await runStep($, 1)

  const ui = await $.ui.mount({ plugin: 'mod-forecast', surface: 'desktop', ...BAND })
  expect((await ui.findAll({ type: 'Text' })).map(found => found.text)).toEqual(['Auto-compact', 'off', 'beneath'])
})

test('before the first step and while switched off the band shows only what lies beneath', { plugins: [BAND_ROW] }, async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  mock.env(on, { HOME: '/home/me' })
  const switches = '/home/me/.claude/mods/state.json'
  on('fs.exists', ($, e) => ({ value: e.path === switches }))
  on('fs.stat', () => ({ value: { kind: 'file' as const, size: 10, mtimeMs: 5, isLink: false } }))
  on('fs.read', () => ({ value: JSON.stringify({ off: ['mod-forecast'] }) }))
  answerWorld(on, 167_000, e => [40_000, 50_000][e.index] ?? 0)
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ plugin: 'mod-forecast', surface: 'desktop', ...BAND })
  expect((await ui.findAll({ type: 'Text' })).map(found => found.text)).toEqual(['beneath'])
  await runStep($, 0)
  await runStep($, 1)
  expect((await ui.findAll({ type: 'Text' })).map(found => found.text)).toEqual(['beneath'])
})

test("with the band beneath it, the chip goes into the band's line of quiet figures, above the meter rows", { plugins: [BAND_DRAWN] }, async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  answerWorldBandBeneath(on, e => [40_000, 50_000][e.index] ?? 0)
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
  await runStep($, 0)
  await runStep($, 1)

  const ui = await $.ui.mount({ plugin: 'mod-forecast', surface: 'desktop', ...BAND })
  const texts = (await ui.findAll({ type: 'Text' })).map(found => found.text)
  expect(texts).toEqual(['Context', 'Steps', '≈12', '5h limit', 'Task'])
})

test("at the band's set height the chip fits while there is room, and no blank row is left; with none left the rows at the bottom give way and a note you can press counts them", { plugins: [BAND_DRAWN] }, async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const band = { blank: 2 }
  answerWorldBandBeneath(on, e => [40_000, 50_000][e.index] ?? 0, () => String(band.blank))
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
  await runStep($, 0)
  await runStep($, 1)
  const forecast = ['Steps', '≈12']

  const roomy = await $.ui.mount({ plugin: 'mod-forecast', surface: 'desktop', ...BAND })
  expect((await roomy.findAll({ type: 'Text' })).map(found => found.text)).toEqual([
    'Context',
    ...forecast,
    '5h limit',
    'Sessions',
    'one more',
    'Task',
  ])
  await roomy.unmount()

  band.blank = 0
  const full = await $.ui.mount({ plugin: 'mod-forecast', surface: 'desktop', ...BAND })
  expect((await full.findAll({ type: 'Text' })).map(found => found.text)).toEqual(['Context', ...forecast, '5h limit', 'Task'])
  expect((await full.find({ type: 'Button', key: 'band-show-all' }))?.text).toBe('▾ 2 more rows hidden · show all')
  // The engine's own node rides on, cut or not: the surface draws its part there.
  expect(JSON.stringify(await full.drawn())).toContain('"type":"engine"')
})

// The band's own tree beneath: its meter slot already holds the limits row (order 2).
function answerWorldBandBeneath(on: On, carried: (e: TurnStepInput) => number, blank: () => string = () => ''): void {
  on('fs.read', ($, e) => (e.path === '/test/band-blank' && blank() !== '' ? { value: blank() } : { deny: `ENOENT: ${e.path}` }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.usage', ($, e) => ({
    value: {
      startedAt: 0,
      context: e.breakdown === undefined ? { window: 200_000 } : { window: 200_000, breakdown: breakdownWith(167_000) },
      rateLimits: [],
    },
  }))
  on('turn.step', async function* ($, e) {
    const response: TurnStepResult = {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'tool_use',
      usage: { input_tokens: 0, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: carried(e), model: e.model },
    }

    return response
  })
}

test('in quiet mode the row waits until auto-compaction is 8 steps away or nearer', { plugins: [BAND_ROW] }, async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  mock.env(on, { HOME: '/home/me' })
  on('fs.exists', ($, e) => ({ value: e.path === '/home/me/.claude/mods/state.json' }))
  on('fs.stat', () => ({ value: { kind: 'file' as const, size: 10, mtimeMs: 5, isLink: false } }))
  on('fs.read', () => ({ value: JSON.stringify({ off: [], quiet: true }) }))
  const main = [40_000, 60_000, 140_000]
  answerWorld(on, 167_000, e => main[e.index] ?? 0)
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
  await runStep($, 0)
  await runStep($, 1)
  const ui = await $.ui.mount({ plugin: 'mod-forecast', surface: 'desktop', ...BAND })
  // (167k - 60k) / 20k = 5.35: near enough already.
  expect(await ui.find({ type: 'Text', text: '≈5' })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: '≈5' }))?.props.color).toBe('warning')
  await runStep($, 2)
  // (167k - 140k) / 50k average: 1 step left, in red.
  expect((await ui.find({ type: 'Text', text: '≈1' }))?.props.color).toBe('error')
})
