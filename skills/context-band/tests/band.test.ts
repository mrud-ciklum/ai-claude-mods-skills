import { expect, mock, test } from 'claude-code/testing'
import type { ElementQuery, Engine, FoundElement, MockClock, Mounted } from 'claude-code/testing'
import type {
  On,
  SessionContextBreakdown,
  SessionMeasureInput,
  SessionMessage,
  TurnStepInput,
  TurnStepResult,
} from 'claude-code'

const BAND = {
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
   isCollapsed: false,
    isWorking: false,
    maxRows: 30,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const BAND_WHILE_WORKING = { ...BAND, props: { ...BAND.props, isWorking: true } } as const

const SUMMARY: SessionMessage = { role: 'user', text: 'Summary of the conversation so far.', toolUses: [] }

const MEASURED: SessionMeasureInput = {
  context: { tokens: 124_000, window: 200_000, percent: 62 },
  rateLimits: [],
  cost: { usd: 4.1 },
  changed: ['context', 'cost'],
}

const REGISTRY = '/home/me/.claude/context-band/sessions'

// The sessions' shared folder, in memory: each file's text and when it was last written.
function answerRegistry(on: On, clock: MockClock, files: Map<string, string>, mtimes = new Map<string, number>()): void {
  mock.env(on, { HOME: '/home/me' })
  on('session.id', () => ({ value: 'sess-here' }))
  on('session.cwd', () => ({ value: '/Users/me/work/project-a' }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('fs.write', ($, e) => {
    files.set(e.path, e.text)
    mtimes.set(e.path, clock.now())

    return { value: undefined }
  })
  on('fs.exists', ($, e) => ({ value: files.has(e.path) || [...files.keys()].some(path => path.startsWith(`${e.path}/`)) }))
  on('fs.stat', ($, e) =>
    files.has(e.path)
      ? { value: { kind: 'file' as const, size: (files.get(e.path) ?? '').length, mtimeMs: mtimes.get(e.path) ?? clock.now(), isLink: false } }
      : { deny: `ENOENT: ${e.path}` },
  )
  on('fs.read', ($, e) => {
    const text = files.get(e.path)

    return text === undefined ? { deny: `ENOENT: ${e.path}` } : { value: text }
  })
  // A folder lists its own entries: a deeper path shows as the folder it sits in.
  on('fs.list', ($, e) => {
    const entries = new Map<string, { name: string; kind: 'file' | 'dir'; size: number; mtimeMs: number; isLink: boolean }>()
    for (const path of files.keys()) {
      if (!path.startsWith(`${e.path}/`)) {
        continue
      }
      const rest = path.slice(e.path.length + 1)
      const name = rest.split('/')[0] ?? rest
      entries.set(
        name,
        rest.includes('/')
          ? { name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false }
          : { name, kind: 'file', size: (files.get(path) ?? '').length, mtimeMs: mtimes.get(path) ?? 0, isLink: false },
      )
    }

    return { value: [...entries.values()] }
  })
}

// Where the engine's world stands around a compaction: once the compacted
// conversation is in place, the live figure is blank until the next response.
type World = { isCompacted: boolean }

function answerMeasure(on: On): void {
  on('session.measure', ($, e) => ({ changed: [...e.changed] }))
}

function answerUsage(on: On, world: World, estimate: number): void {
  on('session.usage', ($, e) => {
    const context = world.isCompacted ? { window: 200_000 } : { ...MEASURED.context }

    return {
      value: {
        startedAt: 0,
        context: e.breakdown === undefined ? context : { ...context, breakdown: breakdownOf(estimate) },
        rateLimits: [],
        cost: { usd: 4.1 },
      },
    }
  })
}

// What the engine draws in the band beneath the plugins: nothing, as in a session with no other mods.
function answerBandBeneath(on: On): void {
  on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'Box' as const }))
}

function answerToasts(on: On): string[] {
  const toasts: string[] = []
  on('ui.toast', ($, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })

  return toasts
}

function breakdownOf(totalTokens: number): SessionContextBreakdown {
  const buffer = 33_000

  return {
    categories: [
      { name: 'System prompt', tokens: 3_000, color: 'promptBorder', isDeferred: false, kind: 'used' },
      { name: 'Messages', tokens: totalTokens - 3_000, color: 'permission', isDeferred: false, kind: 'used' },
      { name: 'MCP tools', tokens: 700, color: 'ide', isDeferred: true, kind: 'deferred' },
      { name: 'Free space', tokens: 200_000 - totalTokens - buffer, color: 'inactive', isDeferred: false, kind: 'free' },
      { name: 'Autocompact buffer', tokens: buffer, color: 'inactive', isDeferred: false, kind: 'buffer' },
    ],
    totalTokens,
    maxTokens: 200_000,
    rawMaxTokens: 200_000,
    autocompactSource: 'auto',
    percentage: Math.round((totalTokens / 200_000) * 100),
    gridRows: [],
    model: 'claude-opus-5-5',
    memoryFiles: [
      { path: '/Users/me/.claude/CLAUDE.md', type: 'User', tokens: 1_200 },
      { path: '/Users/me/.claude/projects/p/memory/MEMORY.md', type: 'AutoMem', tokens: 6_100 },
    ],
    mcpTools: [
      { name: 'mcp__browser__click', serverName: 'browser', tokens: 900, isLoaded: true },
      { name: 'mcp__browser__type', serverName: 'browser', tokens: 700, isLoaded: false },
    ],
    agents: [{ agentType: 'reviewer', source: 'userSettings', tokens: 400 }],
    skills: { totalSkills: 95, includedSkills: 70, tokens: 4_200, skillFrontmatter: [] },
    autoCompactThreshold: 167_000,
    isAutoCompactEnabled: true,
    apiUsage: null,
  }
}

function answerSteps(on: On, contextOf: (e: TurnStepInput) => number): void {
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
        cache_read_input_tokens: contextOf(e),
        model: e.model,
      },
    }

    return response
  })
}

// The toolbar shows once ⋯ opens it and stays open for the session: a second call leaves it.
async function openMenu(ui: Pick<Mounted, 'find' | 'press'>): Promise<void> {
  if ((await ui.find({ type: 'Button', key: 'runners' })) === undefined) {
    await ui.press({ key: 'band-menu' })
  }
}

async function runStep($: Engine, input: TurnStepInput): Promise<void> {
  const stream = $.turn.step(input)
  for await (const _chunk of stream) {
    // drained: the band reads the step's result, not its chunks
  }
  await stream.result
}

test('the band shows the measured fill, Details and Compact on the terminal and the desktop', async ($, on) => {
  answerBandBeneath(on)
  answerMeasure(on)
  await $.session.measure(MEASURED)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'context-band', surface, ...BAND })
    await openMenu(ui)
    expect(await ui.find({ type: 'Text', text: 'Context' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '62%' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '████████████░░░░░░░░' })).toBeUndefined() // no bar
    // The token counts wait in the chip's card, shown only under the pointer.
    expect((await shownTexts(ui)).some(text => text.includes('124k of 200k'))).toBe(false)
    expect((await cardTexts(ui, 'context-band:context'))?.[2]).toMatch(/^124k of 200k/)
    expect(await ui.find({ type: 'Button', key: 'runners', text: 'Runners' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'mods', text: 'Mods' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'details' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'compact' })).toBeDefined()
    await ui.unmount()
  }
})

test('main-loop steps move the band mid-turn and toast once per level; subagent steps do not', async ($, on) => {
  answerBandBeneath(on)
  answerMeasure(on)
  const toasts = answerToasts(on)
  const mainContext = [170_000, 172_000]
  answerSteps(on, e => (e.agentId === undefined ? (mainContext[e.index] ?? 0) : 199_000))

  await $.session.measure(MEASURED)
  await runStep($, { turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 3 })
  await runStep($, { turnId: 't1', index: 1, model: 'claude-opus-5-5', messageCount: 5 })
  await runStep($, { turnId: 's1', index: 0, model: 'claude-opus-5-5', messageCount: 2, agentId: 'a1' })

  const ui = await $.ui.mount({ plugin: 'context-band', surface: 'desktop', ...BAND })
  expect(await ui.find({ type: 'Text', text: '86%' })).toBeDefined()
  // The token counts wait in the chip's card, shown only under the pointer.
  expect((await shownTexts(ui)).some(text => text.includes('172k of 200k'))).toBe(false)
  expect((await cardTexts(ui, 'context-band:context'))?.[2]).toMatch(/^172k of 200k/)
  expect(toasts).toEqual(['Context 85% full'])
})

test('a main compaction blanks the fill, then shows the estimate once the compacted conversation is in place', async ($, on) => {
  answerBandBeneath(on)
  const clock = mock.clock(on)
  const world: World = { isCompacted: false }
  answerMeasure(on)
  answerUsage(on, world, 30_000)
  on('session.compact', () => ({ messages: [SUMMARY] }))
  await $.session.measure(MEASURED)
  const ui = await $.ui.mount({ plugin: 'context-band', surface: 'desktop', ...BAND })

  await $.session.compact({ trigger: 'auto', agentId: 'a1', messages: [SUMMARY] })
  expect(await ui.find({ type: 'Text', text: '62%' })).toBeDefined()

  await $.session.compact({ trigger: 'manual', messages: [SUMMARY] })
  expect(await ui.find({ type: 'Text', text: '-' })).toBeDefined()

  await clock.advance(500)
  expect(await ui.find({ type: 'Text', text: '-' })).toBeDefined()

  world.isCompacted = true
  await clock.advance(500)
  // At 15% the context is a chip on the band's one line of figures.
  expect(await ui.find({ type: 'Text', text: '~15%' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Context$/ })).toBeDefined()
  // The token counts wait in the chip's card, shown only under the pointer.
  expect((await shownTexts(ui)).some(text => text.includes('30k of 200k'))).toBe(false)
  expect((await cardTexts(ui, 'context-band:context'))?.[2]).toMatch(/^30k of 200k/)

  await $.session.measure({ context: { window: 200_000 }, rateLimits: [], changed: ['context'] })
  expect(await ui.find({ type: 'Text', text: '~15%' })).toBeDefined()
})

test('the Compact button is hidden during a turn; pressed between turns it runs /compact and the band follows', async ($, on) => {
  answerBandBeneath(on)
  const clock = mock.clock(on)
  const world: World = { isCompacted: false }
  answerMeasure(on)
  answerUsage(on, world, 30_000)
  // Stands in for the engine's /compact: it compacts, and the band's own
  // session.compact hook is not run for it, the worst case the band must cover.
  const commands: string[] = []
  on('command.run', { command: 'compact' }, ($, e) => {
    commands.push(`/${e.command}`)
    world.isCompacted = true

    return { text: 'Compacted.' }
  })
  await $.session.measure(MEASURED)

  const working = await $.ui.mount({ plugin: 'context-band', surface: 'desktop', ...BAND_WHILE_WORKING })
  expect(await working.find({ type: 'Button', key: 'compact' })).toBeUndefined()
  await working.unmount()

  const ui = await $.ui.mount({ plugin: 'context-band', surface: 'desktop', ...BAND })
  await openMenu(ui)
  await ui.press({ key: 'compact' })
  expect(commands).toEqual(['/compact'])
  expect(await ui.find({ type: 'Text', text: '-' })).toBeDefined()

  await clock.advance(500)
  expect(await ui.find({ type: 'Text', text: '~15%' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'compact' })).toBeDefined()
})

test('a /compact that compacts nothing shows what the command said and leaves the band as it was', async ($, on) => {
  answerBandBeneath(on)
  answerMeasure(on)
  answerUsage(on, { isCompacted: false }, 30_000)
  const toasts = answerToasts(on)
  on('command.run', { command: 'compact' }, () => ({ text: 'Not enough messages to compact.' }))
  await $.session.measure(MEASURED)

  const ui = await $.ui.mount({ plugin: 'context-band', surface: 'desktop', ...BAND })
  await openMenu(ui)
  await ui.press({ key: 'compact' })
  expect(toasts).toEqual(['Compact: Not enough messages to compact.'])
  expect(await ui.find({ type: 'Text', text: '62%' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'compact' })).toBeDefined()
})

test('a /compact the engine refuses says why and gives the button back', async ($, on) => {
  answerBandBeneath(on)
  answerMeasure(on)
  const toasts = answerToasts(on)
  await $.session.measure(MEASURED)

  // Nothing answers command.run here, so the engine's bottom refuses the run.
  const ui = await $.ui.mount({ plugin: 'context-band', surface: 'desktop', ...BAND })
  await openMenu(ui)
  await ui.press({ key: 'compact' })
  expect(toasts).toHaveLength(1)
  expect(toasts[0]).toMatch(/^Compact failed: /)
  expect(await ui.find({ type: 'Text', text: '62%' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'compact' })).toBeDefined()
})

test('a measurement that loses the fill after a compaction the band did not see shows the estimate', async ($, on) => {
  answerBandBeneath(on)
  const clock = mock.clock(on)
  const world: World = { isCompacted: false }
  answerMeasure(on)
  answerUsage(on, world, 30_000)
  await $.session.measure(MEASURED)
  const ui = await $.ui.mount({ plugin: 'context-band', surface: 'desktop', ...BAND })

  world.isCompacted = true
  await $.session.measure({ context: { window: 200_000 }, rateLimits: [], changed: ['context'] })
  expect(await ui.find({ type: 'Text', text: '-' })).toBeDefined()

  await clock.advance(500)
  expect(await ui.find({ type: 'Text', text: '~15%' })).toBeDefined()
})

test('Details expands the band into the window breakdown and the tool results it counted', async ($, on) => {
  answerBandBeneath(on)
  on('agent.list', () => ({ value: [] }))
  answerRegistry(on, mock.clock(on, { now: 1_000_000 }), new Map())
  answerMeasure(on)
  answerUsage(on, { isCompacted: false }, 124_000)
  const output = 'x'.repeat(8_000)
  on('tool.call', { tool: 'Bash' }, () => ({
    result: { stdout: output, stderr: '', interrupted: false },
    text: output,
  }))
  await $.session.measure(MEASURED)
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  await $.tool.call({ tool: 'Bash', command: 'ls -la' })

  const ui = await $.ui.mount({ plugin: 'context-band', surface: 'desktop', ...BAND })
  await openMenu(ui)
  expect(await ui.find({ type: 'Text', text: /^Messages$/ })).toBeUndefined()
  expect((await ui.find({ type: 'Button', key: 'details', text: 'Details' }))?.props.dimColor).toBe(true)
  // A pointer on the meter reveals the biggest shares: drawn hidden, lit by the hover group.
  expect(await ui.find({ type: 'Text', text: 'Messages 121k · System 3k · auto-compact at 167k' })).toBeDefined()

  await ui.press({ key: 'details' })
  expect((await ui.find({ type: 'Button', key: 'details', text: 'Details' }))?.props.dimColor).toBe(false)
  const rows = await drawnTexts(ui)
  expect(rows).toContain('what fills the window, largest first')
  expect(rows.indexOf('Messages')).toBeLessThan(rows.indexOf('System'))
  expect(rows.indexOf('System')).toBeLessThan(rows.indexOf('Free'))
  expect(rows).toContain('121k')
  expect(rows).toEqual(
    expect.arrayContaining([
      'Files',
      'AutoMem MEMORY.md 6.1k · User CLAUDE.md 1.2k',
      'MCP servers',
      'browser 900 (1 tool) · 1 more tool on demand',
      'Skills',
      '70 of 95 listed, 4.2k',
      'Agents',
      '1, 400',
      'Tools',
      'results ≈4k: Bash 4k ×2',
      'Auto-compact',
      'at 167k of 200k',
    ]),
  )

  const terminal = await $.ui.mount({ plugin: 'context-band', surface: 'terminal', ...BAND })
  await openMenu(terminal)
  expect(await terminal.find({ type: 'Text', text: /^Messages$/ })).toBeDefined()
  await terminal.unmount()

  // Runners and details share the space under the meters: one closes the other.
  await ui.press({ key: 'runners' })
  expect(await ui.find({ type: 'Text', text: /^Messages$/ })).toBeUndefined()
  await ui.press({ key: 'details' })
  expect(await ui.find({ type: 'Text', text: /^Messages$/ })).toBeDefined()
  await ui.press({ key: 'mods' })
  expect(await ui.find({ type: 'Text', text: /^Messages$/ })).toBeUndefined()
})

const PROGRESS = 'mcp__context-band__task_progress'

test('session start registers task_progress and runner_info and publishes this session for the others', async ($, on) => {
  answerBandBeneath(on)
  const clock = mock.clock(on, { now: 1_000_000 })
  const files = new Map<string, string>()
  answerRegistry(on, clock, files)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  answerUsage(on, { isCompacted: false }, 124_000)
  const registered: Array<{ name: string; isDeferred: unknown }> = []
  on('tool.register', ($, e) => {
    registered.push({ name: e.name, isDeferred: e.isDeferred })

    return { value: { tool: `mcp__context-band__${e.name}` } }
  })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))

  await $.session.start({ cwd: '/work', surface: null, isInteractive: false })
  expect(registered).toEqual([
    { name: 'task_progress', isDeferred: false },
    { name: 'runner_info', isDeferred: false },
  ])

  await clock.settle()
  const mine: unknown = JSON.parse(files.get(`${REGISTRY}/sess-here.json`) ?? 'null')
  expect(mine).toMatchObject({ sessionId: 'sess-here', cwd: '/Users/me/work/project-a', isEnded: false, runners: [] })

  // What it was last asked and what the answer came to ride along, for the other sessions' lists:
  // the question an answer ends on, else the first sentence of its prose.
  const entry = () => JSON.parse(files.get(`${REGISTRY}/sess-here.json`) ?? 'null') as Record<string, unknown>
  await $.turn.start({ text: 'Check whether the band came back\nand one more thing', turnId: 't1' })
  await clock.settle()
  expect(entry()).toMatchObject({ turn: { isWorking: true }, asked: 'Check whether the band came back', said: null })
  const answer = '## Summary\n**The band is back** after [the fix](https://x.test). One more thing.\n\n```bash\nls\n```'
  await $.turn.complete({ answer: `${answer}\n\nRoll back to v2?`, durationMs: 900, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.settle()
  expect(entry()).toMatchObject({ turn: { isWorking: false }, asked: 'Check whether the band came back', said: 'Roll back to v2?', ending: 'answer' })
  await $.turn.start({ text: 'Next', turnId: 't2' })
  await $.turn.complete({ answer, durationMs: 900, isAborted: false, turnId: 't2', reason: 'answer' })
  await clock.settle()
  expect(entry()).toMatchObject({ asked: 'Next', said: 'The band is back after the fix.', ending: 'answer' })
})

test('the progress guide rides only on requests that offer the model the tool', async ($, on) => {
  answerBandBeneath(on)
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'Intro.', scope: 'shared' as const }] }))
  const request = {
    model: 'claude-opus-5-5',
    promptModel: 'claude-opus-5-5',
    surfaces: [],
    outputStyle: null,
    traits: [],
  }

  const offered = await $.prompt.compose({ ...request, tools: ['Bash', PROGRESS] })
  expect(offered.sections.map(section => section.id)).toEqual(['intro', 'context-band:progress'])
  // Added mid-session, the tool reaches the model deferred: the guide says how to load it.
  expect(offered.sections[1]?.text).toContain('select:mcp__context-band__task_progress')

  const plain = await $.prompt.compose({ ...request, tools: ['Bash'] })
  expect(plain.sections.map(section => section.id)).toEqual(['intro'])
})

test('progress calls fill the task bar below the context line; done turns green and the next prompt clears it', async ($, on) => {
  answerBandBeneath(on)
  mock.clock(on, { now: 1_000_000 })
  answerMeasure(on)
  on('prompt.submit', ($, e) => ({ text: e.text }))
  await $.session.measure(MEASURED)
  const ui = await $.ui.mount({ plugin: 'context-band', surface: 'desktop', ...BAND })
  const texts = async () => drawnTexts(ui)
  // No task yet: the row stays, empty, so the band keeps its shape.
  expect(await texts()).toEqual(expect.arrayContaining(['Task', '-', 'no task']))

  const reply = await $.tool.call({ tool: PROGRESS, percent: 5, task: 'Add retries to the fetcher', step: 'reading the code' })
  expect(reply.result).toBe('Progress shown: 5%.')
  expect(await texts()).toEqual(
    expect.arrayContaining(['Task', '5%', `█${'░'.repeat(19)}`, 'Add retries to the fetcher', 'reading the code']),
  )
  const rows = await texts()
  expect(rows.indexOf('Task')).toBeGreaterThan(rows.indexOf('Context'))

  await $.tool.call({ tool: PROGRESS, percent: 60, task: 'Add retries to the fetcher', step: 'writing tests' })
  expect(await texts()).toEqual(expect.arrayContaining(['60%', `${'█'.repeat(12)}${'░'.repeat(8)}`, 'writing tests']))
  const figure60 = await ui.find({ type: 'Text', text: '60%' })
  expect(figure60?.props.color).toBe('suggestion')

  // A malformed call is refused and changes nothing.
  await $.tool.call({ tool: PROGRESS, percent: 'most', task: 'Add retries to the fetcher' })
  expect(await ui.find({ type: 'Text', text: '60%' })).toBeDefined()

  await $.tool.call({ tool: PROGRESS, percent: 100, task: 'Add retries to the fetcher', step: 'done' })
  const done = await ui.find({ type: 'Text', text: '✓' })
  expect(done?.props.color).toBe('success')
  expect(await texts()).toEqual(expect.arrayContaining(['█'.repeat(20), 'done']))

  await $.prompt.submit({ text: 'Next request.', wait: false, origin: { kind: 'sdk' } })
  expect(await texts()).not.toContain('Add retries to the fetcher')
  expect(await texts()).toEqual(expect.arrayContaining(['Task', 'no task']))
})

test('a prompt shows as the task at once; the model takes it over; an unestimated one goes with the turn', async ($, on) => {
  answerBandBeneath(on)
  mock.clock(on, { now: 1_000_000 })
  answerMeasure(on)
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  await $.session.measure(MEASURED)
  const ui = await $.ui.mount({ plugin: 'context-band', surface: 'desktop', ...BAND })
  const texts = async () => drawnTexts(ui)

  await $.turn.start({ text: 'Explain the reviews, tasks, board and analysis tabs of the dashboard please', turnId: 't1' })
  expect(await texts()).toEqual(
    expect.arrayContaining(['Task', '0%', '░'.repeat(20), 'Explain the reviews, tasks, board and analysis tabs of the', 'estimating']),
  )
  await $.turn.complete({ answer: 'They are four views.', durationMs: 900, isAborted: false, turnId: 't1', reason: 'answer' })
  expect(await texts()).not.toContain('estimating')
  expect(await texts()).toEqual(expect.arrayContaining(['Task', 'no task']))

  await $.turn.start({ text: 'Add retries to the fetcher', turnId: 't2' })
  await $.tool.call({ tool: PROGRESS, percent: 30, task: 'Add retries to the fetcher', step: 'reading the code' })
  expect(await texts()).not.toContain('estimating')
  await $.turn.complete({ answer: 'Started.', durationMs: 900, isAborted: false, turnId: 't2', reason: 'answer' })
  expect(await ui.find({ type: 'Text', text: '30%' })).toBeDefined()

  // A continuation carries no typed prompt and leaves the model's task alone.
  await $.turn.start({ text: '', turnId: 't3' })
  expect(await ui.find({ type: 'Text', text: '30%' })).toBeDefined()
})

test('Runners lists background work with what it does: shells at once, the rest from the turn-end list and the agent list', async ($, on) => {
  answerBandBeneath(on)
  const clock = mock.clock(on, { now: 1_000_000 })
  answerMeasure(on)
  on('tool.call', { tool: 'Bash' }, () => ({
    result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'b1' },
    text: 'Command running in background with ID: b1',
  }))
  on('classic.Stop', () => ({}))
  on('agent.list', () => ({
    value: [{ id: 'a7', description: 'Review the retry change for missed cases', type: 'general-purpose', status: 'running' as const, kind: 'local_agent' as const }] as never, // the fields the band reads
  }))
  await $.session.measure(MEASURED)
  const ui = await $.ui.mount({ plugin: 'context-band', surface: 'desktop', ...BAND })
  await openMenu(ui)
  const texts = async () => drawnTexts(ui)

  await $.tool.call({
    tool: 'Bash',
    command: 'python runjob.py --pr 123',
    description: 'Score PR 123 against the sample set',
    run_in_background: true,
  })
  expect(await ui.find({ type: 'Button', key: 'runners', text: 'Runners 1' })).toBeDefined()

  await clock.advance(12 * 60_000)
  await ui.press({ key: 'runners' })
  expect(await texts()).toEqual(expect.arrayContaining(['● running', 'Score PR 123 against the sample set', 'shell 12m']))
  expect(await texts()).not.toContain('python runjob.py --pr 123')
  expect(await texts()).toContain('Review the retry change for missed cases')

  // The turn ends: the shell is gone from the engine's list, a monitor the band never saw start is on it.
  await $.classic.Stop({
    stop_hook_active: false,
    background_tasks: [
      { id: 'a7', type: 'subagent', status: 'running', description: 'Review the retry change for missed cases', agent_type: 'general-purpose' },
      { id: 'm1', type: 'monitor', status: 'running', description: 'Watch the job log for errors', server: 'logs', tool: 'tail' },
    ],
  })
  // Finished work folds into one line until asked for.
  expect(await texts()).toContain('1 more finished')
  expect(await texts()).not.toContain('✓ done')
  await ui.press({ key: 'runners-done' })
  const rows = await texts()
  expect(rows).toEqual(expect.arrayContaining(['Watch the job log for errors', '✓ done', 'shell', 'hide finished']))
  expect(rows.indexOf('Watch the job log for errors')).toBeLessThan(rows.indexOf('Score PR 123 against the sample set'))
  expect(await ui.find({ type: 'Button', key: 'runners', text: 'Runners 2' })).toBeDefined()

  const terminal = await $.ui.mount({ plugin: 'context-band', surface: 'terminal', ...BAND })
  await openMenu(terminal)
  expect(await terminal.find({ type: 'Button', text: '▸ Watch the job log for errors' })).toBeDefined()
  await terminal.unmount()

  await ui.press({ key: 'runners' })
  expect(await texts()).not.toContain('Watch the job log for errors')
})

test('Runners lists the other live sessions by session; a silent or ended session is left out', async ($, on) => {
  answerBandBeneath(on)
  const now = 5_000_000
  const clock = mock.clock(on, { now })
  const files = new Map<string, string>()
  const mtimes = new Map<string, number>()
  answerRegistry(on, clock, files, mtimes)
  answerMeasure(on)
  on('agent.list', () => ({ value: [] }))
  const trial = {
    sessionId: 'sess-trial',
    cwd: '/Users/me/work-local/wt-trial-batch',
    task: { title: 'Analyse the ready-to-do issues', percent: 40 },
    runners: [
      {
        id: 'b9',
        type: 'shell',
        status: 'running',
        description: 'Score the trial batch on the 101 sample questions',
        detail: 'python trial.py --batch 7',
        seenAt: now - 7 * 60_000,
        endedAt: null,
        info: {
          title: 'Trial batch 7 on the sample set',
          forTask: 'Analyse the ready-to-do issues',
          log: null,
          donePattern: null,
          totalPattern: null,
          total: null,
          statusFile: null,
          expectedMinutes: null,
          waitsFor: null,
        },
        progress: {
          targets: [{ name: 'trial-7', status: 'RUNNING', done: 45, total: 101 }],
          percent: 45,
          isApprox: false,
          minutesLeft: 12,
          sample: null,
        },
      },
      {
        id: 'b8',
        type: 'shell',
        status: 'completed',
        description: 'Earlier finished run',
        detail: null,
        seenAt: now - 60 * 60_000,
        endedAt: now - 30 * 60_000,
        info: null,
        progress: null,
      },
    ],
    updatedAt: now - 10_000,
    isEnded: false,
  }
  const put = (entry: typeof trial & { sessionId: string }, writtenAgo: number) => {
    files.set(`${REGISTRY}/${entry.sessionId}.json`, JSON.stringify({ ...entry, updatedAt: now - writtenAgo }))
    mtimes.set(`${REGISTRY}/${entry.sessionId}.json`, now - writtenAgo)
  }
  put(trial, 10_000)
  put({ ...trial, sessionId: 'sess-silent', runners: [{ ...trial.runners[0]!, id: 'b0', description: 'A run in a session that went silent' }] }, 10 * 60_000)
  put({ ...trial, sessionId: 'sess-ended', isEnded: true, runners: [{ ...trial.runners[0]!, id: 'b5', description: 'A run in an ended session' }] }, 5_000)
  files.set(`${REGISTRY}/broken.json`, '{ not json')
  mtimes.set(`${REGISTRY}/broken.json`, now)
  await $.session.measure(MEASURED)

  const ui = await $.ui.mount({ plugin: 'context-band', surface: 'desktop', ...BAND })
  await openMenu(ui)
  expect(await ui.find({ type: 'Button', key: 'runners', text: 'Runners' })).toBeDefined()
  await ui.press({ key: 'runners' })
  const rows = await drawnTexts(ui)
  expect(rows).toEqual(
    expect.arrayContaining([
      'wt-trial-batch · Analyse the ready-to-do issues · 40%',
      'Trial batch 7 on the sample set',
      '45%',
      '45/101 · ~12m left',
      'for task: Analyse the ready-to-do issues · shell 7m',
    ]),
  )
  expect(rows).not.toContain('Earlier finished run')
  expect(rows).not.toContain('A run in a session that went silent')
  expect(rows).not.toContain('A run in an ended session')
  expect(await ui.find({ type: 'Button', key: 'runners', text: 'Runners 1' })).toBeDefined()

  // Opening the list published this session too, for the others to read.
  const mine: unknown = JSON.parse(files.get(`${REGISTRY}/sess-here.json`) ?? 'null')
  expect(mine).toMatchObject({ sessionId: 'sess-here', isEnded: false })
})

const RUNNER = 'mcp__context-band__runner_info'

function answerLaunch(on: On, id: string): void {
  on('tool.call', { tool: 'Bash' }, () => ({
    result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: id },
    text: `Command running in background with ID: ${id}`,
  }))
}

test('runner_info names a runner and its task; with only an expected time the bar is approximate; the command stays out of the list', async ($, on) => {
  answerBandBeneath(on)
  const clock = mock.clock(on, { now: 2_000_000 })
  answerRegistry(on, clock, new Map())
  answerMeasure(on)
  answerUsage(on, { isCompacted: false }, 124_000)
  on('agent.list', () => ({ value: [] }))
  answerLaunch(on, 'b1')
  await $.session.measure(MEASURED)
  await $.tool.call({
    tool: 'Bash',
    command: 'rsync -a ~/db-dump-local/ /Volumes/backup/db/',
    description: 'Back up the DB dump',
    run_in_background: true,
  })
  const reply = await $.tool.call({
    tool: RUNNER,
    id: 'b1',
    title: 'Back up the DB dump',
    task: 'Prepare the corpus',
    expected_minutes: 60,
  })
  expect(reply.result).toBe('Runner described: Back up the DB dump.')

  await clock.advance(15 * 60_000)
  const ui = await $.ui.mount({ plugin: 'context-band', surface: 'desktop', ...BAND })
  await openMenu(ui)
  const texts = async () => drawnTexts(ui)
  await ui.press({ key: 'runners' })
  expect(await texts()).toEqual(
    expect.arrayContaining([
      'Back up the DB dump',
      '≈25%',
      'approximate · ~45m left',
      'for task: Prepare the corpus · shell 15m',
    ]),
  )
  expect(await texts()).not.toContain('rsync -a ~/db-dump-local/ /Volumes/backup/db/')
})

test('a watcher shows the job it waits on: waiting, then counted from its log with the time left, then dead in red', async ($, on) => {
  answerBandBeneath(on)
  const clock = mock.clock(on, { now: 3_000_000 })
  const files = new Map<string, string>()
  answerRegistry(on, clock, files)
  answerMeasure(on)
  on('agent.list', () => ({ value: [] }))
  answerLaunch(on, 'w1')
  await $.session.measure(MEASURED)
  await $.tool.call({
    tool: 'Bash',
    command: "L=/logs; until [ -f $L/jb-b4.status ] && grep -q -E 'RUN_DONE|RUN_DEAD' $L/jb-b4.status; do sleep 30; done",
    description: 'Wait for the base job',
    run_in_background: true,
  })
  const ui = await $.ui.mount({ plugin: 'context-band', surface: 'desktop', ...BAND })
  await openMenu(ui)
  const texts = async () => drawnTexts(ui)
  const reopen = async () => {
    await ui.press({ key: 'runners' })
    await ui.press({ key: 'runners' })
  }
  const auditLog = (done: number) =>
    [
      'Input set verified: reviewed-v5 (101 reviewed questions)',
      '101 questions loaded from questions_v2.xlsx',
      ...Array.from({ length: done }, (_, index) => `[audit] Q${index + 1} started\n[audit] Q${index + 1} completed`),
    ].join('\n')

  await ui.press({ key: 'runners' })
  expect(await texts()).toEqual(expect.arrayContaining(['◌ waiting', 'Wait for the base job', 'waiting for jb-b4']))

  files.set('/logs/jb-b4.status', 'RUNNING\n')
  files.set('/logs/jb-b4.log', auditLog(40))
  await reopen()
  expect(await texts()).toEqual(expect.arrayContaining(['● running', '40%', '40/101']))

  await clock.advance(10 * 60_000)
  files.set('/logs/jb-b4.log', auditLog(60))
  await reopen()
  expect(await texts()).toEqual(expect.arrayContaining(['59%', '60/101 · ~21m left']))

  files.set('/logs/jb-b4.status', 'RUN_DEAD 4e5f6a7b\n')
  await reopen()
  expect(await texts()).toContain('60/101 · status RUN_DEAD')
  const dead = await ui.find({ type: 'Text', text: '✕ died' })
  expect(dead?.props.color).toBe('error')
})

test('runner_info patterns count a custom log; a pattern that does not compile is refused', async ($, on) => {
  answerBandBeneath(on)
  const clock = mock.clock(on, { now: 4_000_000 })
  const files = new Map<string, string>([['/tmp/sync.log', 'plan: 12 steps\ndone step a\ndone step b\ndone step c\n']])
  answerRegistry(on, clock, files)
  answerMeasure(on)
  on('agent.list', () => ({ value: [] }))
  answerLaunch(on, 'b3')
  await $.session.measure(MEASURED)
  await $.tool.call({ tool: 'Bash', command: './sync.sh', description: 'Sync', run_in_background: true })

  const refused = await $.tool.call({ tool: RUNNER, id: 'b3', title: 'Sync the mirrors', done_pattern: '([' })
  expect(JSON.stringify(refused)).toContain('is not a valid regular expression')

  await $.tool.call({
    tool: RUNNER,
    id: 'b3',
    title: 'Sync the mirrors',
    log: '/tmp/sync.log',
    done_pattern: '^done step',
    total_pattern: 'plan: (\\d+) steps',
  })
  const ui = await $.ui.mount({ plugin: 'context-band', surface: 'desktop', ...BAND })
  await openMenu(ui)
  await ui.press({ key: 'runners' })
  const rows = await drawnTexts(ui)
  expect(rows).toEqual(expect.arrayContaining(['Sync the mirrors', '25%', '3/12']))
})

test('a runner with nothing to count shows the last line of its log', async ($, on) => {
  answerBandBeneath(on)
  const clock = mock.clock(on, { now: 6_000_000 })
  const files = new Map<string, string>([
    ['/logs/img-base.log', "\nwaiting for evaluation lease 'team:staging:shared-gpu-cluster'\n\n"],
  ])
  answerRegistry(on, clock, files)
  answerMeasure(on)
  on('agent.list', () => ({ value: [] }))
  answerLaunch(on, 'b7')
  await $.session.measure(MEASURED)
  await $.tool.call({
    tool: 'Bash',
    command: "until grep -q 'img probe rc=' /logs/img-base.log 2>/dev/null; do sleep 30; done",
    description: 'Wait for the image re-measurement',
    run_in_background: true,
  })
  const ui = await $.ui.mount({ plugin: 'context-band', surface: 'desktop', ...BAND })
  await openMenu(ui)
  await ui.press({ key: 'runners' })
  const rows = await drawnTexts(ui)
  expect(rows).toContain("log: waiting for evaluation lease 'team:staging:shared-gpu-cluster'")
  // A pointer on the runner reveals the log's last lines.
  expect(rows).toContain("│ waiting for evaluation lease 'team:staging:shared-gpu-cluster'")
})

test("another session's runner is measured here too, even when that session runs an older band", async ($, on) => {
  answerBandBeneath(on)
  const start = 7_000_000
  const clock = mock.clock(on, { now: start })
  const files = new Map<string, string>()
  const mtimes = new Map<string, number>()
  answerRegistry(on, clock, files, mtimes)
  answerMeasure(on)
  on('agent.list', () => ({ value: [] }))
  const auditLog = (done: number) =>
    ['101 questions loaded from sample.xlsx', ...Array.from({ length: done }, (_, index) => `[audit] Q${index + 1} completed`)].join('\n')
  // What an older band publishes: no title, no progress, just the watcher and its command.
  const publish = (writtenAt: number) => {
    const path = `${REGISTRY}/sess-old-band.json`
    files.set(
      path,
      JSON.stringify({
        sessionId: 'sess-old-band',
        cwd: '/Users/me/work-local/wt-trial-batch',
        task: { title: 'PR #120 + PR #123', percent: 80 },
        runners: [
          {
            id: 'bb0',
            type: 'shell',
            status: 'running',
            description: 'Wait for the #123 head re-score after the review fixes',
            detail: "L=/logs; until grep -q -E 'RUN_DONE|RUN_FAILED' $L/jb-head2.status; do sleep 30; done",
            seenAt: start - 6 * 60_000,
            endedAt: null,
          },
        ],
        updatedAt: writtenAt,
        isEnded: false,
      }),
    )
    mtimes.set(path, writtenAt)
  }
  files.set('/logs/jb-head2.status', 'RUNNING\n')
  files.set('/logs/jb-head2.log', auditLog(40))
  publish(start - 5_000)
  await $.session.measure(MEASURED)

  const ui = await $.ui.mount({ plugin: 'context-band', surface: 'desktop', ...BAND })
  await openMenu(ui)
  const texts = async () => drawnTexts(ui)
  await ui.press({ key: 'runners' })
  expect(await texts()).toEqual(
    expect.arrayContaining([
      'wt-trial-batch · PR #120 + PR #123 · 80%',
      'Wait for the #123 head re-score after the review fixes',
      '40%',
      '40/101',
    ]),
  )

  await clock.advance(10 * 60_000)
  files.set('/logs/jb-head2.log', auditLog(60))
  publish(clock.now() - 5_000)
  await ui.press({ key: 'runners' })
  await ui.press({ key: 'runners' })
  expect(await texts()).toContain('60/101 · ~21m left')
})

test('switched off in the mods panel the band draws only what lies beneath and adds no guide; switched on it is back within a poll', async ($, on) => {
  on('ui.render', { component: 'AbovePrompt' }, () => ({
    type: 'Box' as const,
    children: [{ type: 'Text' as const, children: ['beneath'] }],
  }))
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'Intro.', scope: 'shared' as const }] }))
  const clock = mock.clock(on, { now: 1_000_000 })
  const files = new Map<string, string>()
  const mtimes = new Map<string, number>()
  const switches = '/home/me/.claude/mods/state.json'
  files.set(switches, JSON.stringify({ off: ['context-band'], isPaneWanted: true, updatedAt: 1 }))
  mtimes.set(switches, 999_000)
  answerRegistry(on, clock, files, mtimes)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  answerUsage(on, { isCompacted: false }, 124_000)
  on('tool.register', ($, e) => ({ value: { tool: `mcp__context-band__${e.name}` } }))
  await $.session.start({ cwd: '/work', surface: null, isInteractive: false })
  const request = { model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: [], outputStyle: null, traits: [] }

  const ui = await $.ui.mount({ plugin: 'context-band', surface: 'desktop', ...BAND })
  expect(await ui.find({ type: 'Text', text: 'beneath' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Context' })).toBeUndefined()
  const off = await $.prompt.compose({ ...request, tools: ['Bash', PROGRESS] })
  expect(off.sections.map(section => section.id)).toEqual(['intro'])

  await clock.advance(100)
  files.set(switches, JSON.stringify({ off: [], isPaneWanted: true, updatedAt: 2 }))
  mtimes.set(switches, clock.now())
  await clock.advance(1_500)
  expect(await ui.find({ type: 'Text', text: '62%' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'beneath' })).toBeDefined()
  const back = await $.prompt.compose({ ...request, tools: ['Bash', PROGRESS] })
  expect(back.sections.map(section => section.id)).toEqual(['intro', 'context-band:progress'])
})

// Two mods that draw a keyed piece each, as their own rows: the band orders the rows by the keys.
const MACHINE_ROW = {
  name: 'mod-machine',
  register: (on: On) => {
    on('ui.render', { component: 'AbovePrompt' }, async () => ({
      type: 'Box' as const,
      props: { key: 'chip:05:mod-machine', flexDirection: 'column' as const },
      children: [{ type: 'Text' as const, children: ['RAM 24%'] }],
    }))
  },
}
const LIMITS_ROW = {
  name: 'mod-limits',
  register: (on: On) => {
    on('ui.render', { component: 'AbovePrompt' }, async () => ({
      type: 'Box' as const,
      props: { key: 'chip:02:mod-limits', flexDirection: 'column' as const },
      children: [{ type: 'Text' as const, children: ['5h 12%'] }],
    }))
  },
}
const PLAIN_ROW = {
  name: 'some-mod',
  register: (on: On) => {
    on('ui.render', { component: 'AbovePrompt' }, async () => ({ type: 'Text' as const, children: ['a plain row'] }))
  },
}

test('the band orders the rows of the other mods by their pieces: chips by order number, plain rows last', { plugins: [PLAIN_ROW, MACHINE_ROW, LIMITS_ROW] }, async ($, on) => {
  answerMeasure(on)
  await $.session.measure({ ...MEASURED, context: { tokens: 80_000, window: 200_000, percent: 40 } })
  const ui = await $.ui.mount({ plugin: 'context-band', surface: 'desktop', ...BAND })
  const texts = await drawnTexts(ui)
  const at = (text: string) => texts.indexOf(text)
  expect(at('Context')).toBeGreaterThanOrEqual(0)
  expect(at('Context')).toBeLessThan(at('5h 12%'))
  expect(at('5h 12%')).toBeLessThan(at('RAM 24%'))
  expect(at('RAM 24%')).toBeLessThan(at('a plain row'))
})

// Two tests here checked that the band moved the pieces other mods stacked beneath it into its
// own line. The engine no longer hands a render hook the rows of other plugins (next(e) answers
// the engine's own drawing), so each mod's row stands alone and that path never runs.

test('a plan shows as a checklist under the task, counts the percent, times its steps and forecasts the rest', async ($, on) => {
  answerBandBeneath(on)
  answerMeasure(on)
  const clock = mock.clock(on, { now: 1_000_000 })
  await $.session.measure(MEASURED)
  const ui = await $.ui.mount({ plugin: 'context-band', surface: 'desktop', ...BAND })
  const texts = async () => drawnTexts(ui)
  const plan = (statuses: string[]) => ['Read the code', 'Write the tests', 'Run the suite'].map((title, index) => ({ title, status: statuses[index] }))

  // No percent: the plan gives it, the active step counting half.
  const first = await $.tool.call({ tool: PROGRESS, task: 'Add retries to the fetcher', steps: plan(['active', 'todo', 'todo']) })
  expect(first.result).toBe('Progress shown: 17%.')
  expect(await texts()).toEqual(expect.arrayContaining(['17%', '▶○○ 0/3 · Read the code']))

  await clock.advance(4 * 60_000)
  await $.tool.call({ tool: PROGRESS, task: 'Add retries to the fetcher', steps: plan(['done', 'active', 'todo']) })
  await clock.advance(4 * 60_000)
  await $.tool.call({ tool: PROGRESS, task: 'Add retries to the fetcher', percent: 80, step: 'running the suite', steps: plan(['done', 'done', 'active']) })
  // Four minutes a step, half a step to go.
  expect(await texts()).toEqual(expect.arrayContaining(['80%', '✓✓▶ 2/3 · running the suite · ~2m left']))
  // A pointer on the task reveals each step's time.
  expect(await texts()).toEqual(expect.arrayContaining(['✓ Read the code · 4m', '✓ Write the tests · 4m', '▶ Run the suite']))

  const refused = await $.tool.call({ tool: PROGRESS, task: 'Add retries to the fetcher' })
  expect(refused.deny).toMatch(/needs a short `task`, and `percent`/)
})

test('without a plan the time left comes from the pace of the estimates', async ($, on) => {
  answerBandBeneath(on)
  answerMeasure(on)
  const clock = mock.clock(on, { now: 1_000_000 })
  await $.session.measure(MEASURED)
  const ui = await $.ui.mount({ plugin: 'context-band', surface: 'desktop', ...BAND })
  await $.tool.call({ tool: PROGRESS, task: 'Port the parser', percent: 10, step: 'reading' })
  await clock.advance(6 * 60_000)
  await $.tool.call({ tool: PROGRESS, task: 'Port the parser', percent: 40, step: 'porting the lexer' })
  // 30 points in 6 minutes: 60 points to go is 12 minutes.
  expect(await ui.find({ type: 'Text', text: 'porting the lexer · ~12m left' })).toBeDefined()

  await clock.advance(12 * 60_000)
  await $.tool.call({ tool: PROGRESS, task: 'Port the parser', percent: 100, step: 'done' })
  expect(await ui.find({ type: 'Text', text: 'done in 18m' })).toBeDefined()
})

test('a runner that finishes, dies or stalls is announced once; the sound rings once per machine', async ($, on) => {
  answerBandBeneath(on)
  const clock = mock.clock(on, { now: 3_000_000 })
  const files = new Map<string, string>()
  const mtimes = new Map<string, number>()
  answerRegistry(on, clock, files, mtimes)
  answerMeasure(on)
  const toasts = answerToasts(on)
  const played: string[] = []
  on('audio.play', ($, e) => {
    played.push(e.clip.asset ?? '')

    return { value: undefined }
  })
  on('agent.list', () => ({ value: [] }))
  let launched = 0
  on('tool.call', { tool: 'Bash' }, () => {
    launched += 1

    return { result: { backgroundTaskId: `b${launched}` }, text: `Command running in background with ID: b${launched}` }
  })
  await $.session.measure(MEASURED)
  const job = async (name: string, status: string) => {
    files.set(`/logs/${name}.status`, `${status}\n`)
    files.set(`/logs/${name}.log`, `${name} line`)
    mtimes.set(`/logs/${name}.log`, clock.now())
    await $.tool.call({ tool: 'Bash', command: `python runjob.py > /logs/${name}.log 2>&1; echo $? > /logs/${name}.status`, description: `Job ${name}`, run_in_background: true })
  }
  const ui = await $.ui.mount({ plugin: 'context-band', surface: 'desktop', ...BAND })
  await openMenu(ui)
  const look = async () => {
    await ui.press({ key: 'runners' })
    await ui.press({ key: 'runners' })
  }

  // First seen finished: old news. Seen running, then finished or dead: news, once.
  await job('jb-old', 'RUN_DONE')
  await job('jb-ok', 'RUNNING')
  await job('jb-bad', 'RUNNING')
  await job('jb-slow', 'RUNNING')
  await look()
  expect(toasts).toEqual([])

  files.set('/logs/jb-ok.status', 'RUN_DONE 0a1b2c3d\n')
  files.set('/logs/jb-bad.status', 'RUN_DEAD 4e5f6a7b\n')
  // Another session already rang for jb-bad.
  files.set('/home/me/.claude/mods/alerts.json', JSON.stringify({ 'sess-here:b3:dead': clock.now() }))
  await look()
  expect(toasts).toEqual(['✓ Job jb-ok: done', '✕ Job jb-bad: died'])
  expect(played).toEqual(['sounds/done.aiff'])

  await look()
  expect(toasts).toHaveLength(2)

  // jb-slow's log stays still past ten minutes.
  await clock.advance(12 * 60_000)
  await look()
  expect(toasts[2]).toBe('⚠ Job jb-slow: log still for 12m')
  // Opening and closing measured the list; open it once more to read it.
  await ui.press({ key: 'runners' })
  expect(await ui.find({ type: 'Text', text: '⚠ stuck?' })).toBeDefined()
  expect(played).toEqual(['sounds/done.aiff', 'sounds/stall.aiff'])
})

test('jobs that hold or wait for the evaluation lease show who holds it and who waits', async ($, on) => {
  answerBandBeneath(on)
  on('classic.Stop', () => ({}))
  const clock = mock.clock(on, { now: 3_000_000 })
  const files = new Map<string, string>()
  answerRegistry(on, clock, files)
  answerMeasure(on)
  on('agent.list', () => ({ value: [] }))
  let launched = 0
  on('tool.call', { tool: 'Bash' }, () => {
    launched += 1

    return { result: { backgroundTaskId: `b${launched}` }, text: `Command running in background with ID: b${launched}` }
  })
  await $.session.measure(MEASURED)
  files.set('/logs/jb-a.log', "settings: x\nwaiting for evaluation lease 'team:staging:shared-gpu-cluster'\nacquired evaluation lease 'team:staging:shared-gpu-cluster'\n[audit] Q1 started")
  files.set('/logs/jb-b.log', "settings: x\nwaiting for evaluation lease 'team:staging:shared-gpu-cluster'")
  await $.tool.call({ tool: 'Bash', command: 'python runjob.py > /logs/jb-a.log 2>&1', description: 'Head job A', run_in_background: true })
  await $.tool.call({ tool: 'Bash', command: 'python runjob.py > /logs/jb-b.log 2>&1', description: 'Base job B', run_in_background: true })
  const ui = await $.ui.mount({ plugin: 'context-band', surface: 'desktop', ...BAND })
  await openMenu(ui)
  await ui.press({ key: 'runners' })
  await ui.press({ key: 'runners' })

  const shown = await drawnTexts(ui)
  expect(shown).toEqual(expect.arrayContaining(['Eval lease', 'held by Head job A · waiting: Base job B']))
  expect((await ui.find({ type: 'Text', text: /^1$/ }))?.props.color).toBe('warning')

  // The holder finishes: only the waiter is left, and its holder is not on this Mac.
  files.set('/logs/jb-a.log', "acquired evaluation lease 'team:staging:shared-gpu-cluster'\nDONE")
  await $.classic.Stop({
    stop_hook_active: false,
    background_tasks: [{ id: 'b2', type: 'local_bash', status: 'running', description: 'Base job B', command: 'python runjob.py > /logs/jb-b.log 2>&1' }],
  })
  await ui.press({ key: 'runners' })
  await ui.press({ key: 'runners' })
  const after = await drawnTexts(ui)
  expect(after).toContain('held by someone off this Mac · waiting: Base job B')
})

// Every text the band draws, button labels included, in document order; a
// runner's title button drops its ▸/▾ mark.
async function drawnTexts(ui: { findAll: (query: ElementQuery) => Promise<FoundElement[]> }): Promise<string[]> {
  return (await ui.findAll({}))
    .filter(found => found.type === 'Text' || found.type === 'Button')
    .map(found => found.text.replace(/^[▸▾] /, ''))
}

test('the list puts the urgent first, keeps to six rows, opens a runner on its title, copies, explains, and draws a time scale', async ($, on) => {
  answerBandBeneath(on)
  on('classic.Stop', () => ({}))
  const clock = mock.clock(on, { now: 30_000_000 })
  const files = new Map<string, string>()
  answerRegistry(on, clock, files)
  answerMeasure(on)
  const toasts = answerToasts(on)
  on('agent.list', () => ({ value: [] }))
  const copied: string[] = []
  on('ui.copy', ($, e) => {
    copied.push(e.text)

    return { value: { isCopied: true as const } }
  })
  const asked: string[] = []
  on('model.complete', ($, e) => {
    asked.push(e.prompt)

    return { value: { isAnswered: true as const, text: 'Scores head #123 on the sample set; 40 of 101 done.', usage: { input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }
  })
  let launched = 0
  on('tool.call', { tool: 'Bash' }, () => {
    launched += 1

    return { result: { backgroundTaskId: `b${launched}` }, text: `Command running in background with ID: b${launched}` }
  })
  await $.session.measure(MEASURED)
  const start = async (name: string, status: string, lines: string) => {
    files.set(`/logs/${name}.status`, `${status}\n`)
    files.set(`/logs/${name}.log`, lines)
    await $.tool.call({ tool: 'Bash', command: `python runjob.py > /logs/${name}.log 2>&1; echo DONE > /logs/${name}.status`, description: `Job ${name}`, run_in_background: true })
  }
  for (const name of ['jb-1', 'jb-2', 'jb-3', 'jb-4', 'jb-5', 'jb-6', 'jb-7']) {
    await start(name, 'RUNNING', `[audit] started ${name}`)
  }
  await start('jb-dead', 'RUN_DEAD', 'Traceback: boom')
  const ui = await $.ui.mount({ plugin: 'context-band', surface: 'desktop', ...BAND })
  await openMenu(ui)
  await ui.press({ key: 'runners' })

  // Dead first; six rows, then the rest behind `N more`.
  const rows = await drawnTexts(ui)
  expect(rows.indexOf('Job jb-dead')).toBeLessThan(rows.indexOf('Job jb-1'))
  expect(rows).toContain('2 more')
  expect(rows).not.toContain('Job jb-6')
  await ui.press({ key: 'runners-more' })
  expect(await drawnTexts(ui)).toEqual(expect.arrayContaining(['Job jb-6', 'Job jb-7']))

  // A press on a title opens the runner: its log, command, log path and actions.
  await ui.press({ key: 'runner:here:b1' })
  expect(await drawnTexts(ui)).toEqual(
    expect.arrayContaining([
      '│ [audit] started jb-1',
      'command: python runjob.py > /logs/jb-1.log 2>&1; echo DONE > /logs/jb-1.status',
      'log: /logs/jb-1.log',
      'Copy command',
      'Copy log path',
      'Explain',
    ]),
  )
  await ui.press({ key: 'copy-log:here:b1' })
  expect(copied).toEqual(['/logs/jb-1.log'])
  expect(toasts).toContain('Copied')
  await ui.press({ key: 'explain:here:b1' })
  expect(asked[0]).toContain('Command: python runjob.py > /logs/jb-1.log')
  expect(await drawnTexts(ui)).toContain('Scores head #123 on the sample set; 40 of 101 done.')

  // The time scale: twenty cells over four hours; a job seen an hour ago fills the last five.
  await clock.advance(60 * 60_000)
  await ui.press({ key: 'runner-view' })
  expect(await drawnTexts(ui)).toEqual(expect.arrayContaining(['Progress', `${'░'.repeat(15)}${'█'.repeat(5)}`]))
})

test('a watcher shows its chain as a tree', async ($, on) => {
  answerBandBeneath(on)
  const clock = mock.clock(on, { now: 3_000_000 })
  const files = new Map<string, string>()
  answerRegistry(on, clock, files)
  answerMeasure(on)
  on('agent.list', () => ({ value: [] }))
  answerLaunch(on, 'w1')
  await $.session.measure(MEASURED)
  files.set('/logs/jb-b4.status', 'RUN_DONE 0a1b2c3d\n')
  files.set('/logs/jb-b4.log', 'done')
  await $.tool.call({
    tool: 'Bash',
    command: 'L=/logs; until [ -f $L/jb-head1.status ]; do sleep 30; done; until grep -q RUN_DONE $L/jb-b4.status; do sleep 30; done',
    description: 'Wait for the head job',
    run_in_background: true,
  })
  const ui = await $.ui.mount({ plugin: 'context-band', surface: 'desktop', ...BAND })
  await openMenu(ui)
  await ui.press({ key: 'runners' })
  expect(await drawnTexts(ui)).toEqual(expect.arrayContaining(['├ jb-b4 RUN_DONE', '└ jb-head1 waiting']))
})

test('the transcript row that launched a runner joins its hover group', async ($, on) => {
  answerBandBeneath(on)
  on('ui.render', { component: 'ToolUse' }, () => ({ type: 'Text' as const, children: ['Bash(python runjob.py)'] }))
  const clock = mock.clock(on, { now: 3_000_000 })
  answerRegistry(on, clock, new Map())
  answerMeasure(on)
  let launchId = ''
  on('tool.call', { tool: 'Bash' }, ($, e) => {
    launchId = e.tool_use_id

    return { result: { backgroundTaskId: 'b1' }, text: 'Command running in background with ID: b1' }
  })
  await $.session.measure(MEASURED)
  await $.tool.call({ tool: 'Bash', command: 'python runjob.py', description: 'Head job', run_in_background: true })

  const row = await $.ui.mount({
    plugin: 'context-band',
    surface: 'desktop',
    component: 'ToolUse',
    requestId: launchId,
    props: { tool_use_id: launchId, tool: 'Bash', input: { command: 'python runjob.py' }, isRunning: false, isErrored: false, isInterrupted: false },
  })
  expect(await row.find({ type: 'Text', text: 'Bash(python runjob.py)' })).toBeDefined()
  expect(await row.find({ type: 'Text', text: '↳ runner in the band: Head job' })).toBeDefined()
})

test('a mod card that asks for a toolbar button gets one, with the live sessions counted, and loses it when switched off', async ($, on) => {
  answerBandBeneath(on)
  const clock = mock.clock(on, { now: 1_000_000 })
  const files = new Map<string, string>()
  const mtimes = new Map<string, number>()
  files.set('/home/me/.claude/skills/mod-sessions/mod.json', JSON.stringify({ order: 4, title: 'Sessions', button: { key: 'sessions', label: 'Sessions', count: 'sessions' } }))
  files.set('/home/me/.claude/skills/mod-sessions/.claude-plugin/plugin.json', JSON.stringify({ name: 'mod-sessions' }))
  files.set('/home/me/.claude/skills/mod-limits/mod.json', JSON.stringify({ order: 2, title: 'Limits' }))
  files.set('/home/me/.claude/skills/mod-limits/.claude-plugin/plugin.json', JSON.stringify({ name: 'mod-limits' }))
  answerRegistry(on, clock, files, mtimes)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  answerUsage(on, { isCompacted: false }, 124_000)
  on('tool.register', ($, e) => ({ value: { tool: `mcp__context-band__${e.name}` } }))
  await $.session.start({ cwd: '/work', surface: null, isInteractive: false })
  const ui = await $.ui.mount({ plugin: 'context-band', surface: 'desktop', ...BAND })
  await openMenu(ui)

  const tab = await ui.find({ type: 'Button', key: 'section:sessions' })
  expect(tab?.text).toBe('Sessions 1')
  expect(tab?.props.dimColor).toBe(true)
  await ui.press({ key: 'section:sessions' })
  expect((await ui.find({ type: 'Button', key: 'section:sessions' }))?.props.dimColor).toBe(false)
  await ui.press({ key: 'details' })
  expect((await ui.find({ type: 'Button', key: 'section:sessions' }))?.props.dimColor).toBe(true)

  await clock.advance(10)
  files.set('/home/me/.claude/mods/state.json', JSON.stringify({ off: ['mod-sessions'] }))
  mtimes.set('/home/me/.claude/mods/state.json', clock.now())
  await clock.advance(1_500)
  expect(await ui.find({ type: 'Button', key: 'section:sessions' })).toBeUndefined()
})

test('/band says the band in words and /runners opens the list', async ($, on) => {
  answerBandBeneath(on)
  const clock = mock.clock(on, { now: 1_000_000 })
  answerRegistry(on, clock, new Map())
  answerMeasure(on)
  on('agent.list', () => ({ value: [] }))
  await $.session.measure(MEASURED)
  await $.tool.call({ tool: PROGRESS, percent: 40, task: 'Port the parser', step: 'porting the lexer' })
  const command = { origin: { kind: 'composer' as const }, presentation: { isFullscreen: true, columns: 160 } }

  const said = await $.command.run({ command: 'band', args: '', ...command })
  expect(said.text).toBe("Context 62% (124k of 200k)\nTask 40%: Port the parser (porting the lexer)\nThis session's runners: nothing running")

  const ui = await $.ui.mount({ plugin: 'context-band', surface: 'desktop', ...BAND })
  await $.command.run({ command: 'runners', args: '', ...command })
  expect(await ui.find({ type: 'Text', text: 'no background work in any session' })).toBeDefined()
})

test('news follows the sound settings: no sound when sounds are off, the news spoken when the voice is on', async ($, on) => {
  answerBandBeneath(on)
  const clock = mock.clock(on, { now: 3_000_000 })
  const files = new Map<string, string>()
  const mtimes = new Map<string, number>()
  answerRegistry(on, clock, files, mtimes)
  answerMeasure(on)
  answerToasts(on)
  const played: string[] = []
  const spoken: string[] = []
  on('audio.play', ($, e) => {
    played.push(e.clip.asset ?? '')

    return { value: undefined }
  })
  on('audio.speak', ($, e) => {
    spoken.push(e.text)

    return { value: { via: 'system' as const } }
  })
  on('agent.list', () => ({ value: [] }))
  on('tool.call', { tool: 'Bash' }, () => ({ result: { backgroundTaskId: 'b1' }, text: 'Command running in background with ID: b1' }))
  files.set('/home/me/.claude/mods/state.json', JSON.stringify({ off: [], settings: { sounds: false, voice: true } }))
  await $.session.measure(MEASURED)
  files.set('/logs/jb-x.status', 'RUNNING\n')
  files.set('/logs/jb-x.log', 'working')
  await $.tool.call({ tool: 'Bash', command: 'python runjob.py > /logs/jb-x.log 2>&1; echo $? > /logs/jb-x.status', description: 'Job jb-x', run_in_background: true })
  const ui = await $.ui.mount({ plugin: 'context-band', surface: 'desktop', ...BAND })
  await openMenu(ui)
  await ui.press({ key: 'runners' })
  await ui.press({ key: 'runners' })

  files.set('/logs/jb-x.status', 'RUN_DONE\n')
  await ui.press({ key: 'runners' })
  expect(played).toEqual([])
  expect(spoken).toEqual(['Job jb-x: done'])
})

test('the band height: ▲ and ▼ step it a row a press from the toolbar, a cut leaves rows out from the bottom with a note, auto gives it back', async ($, on) => {
  answerBandBeneath(on)
  const clock = mock.clock(on, { now: 1_000_000 })
  const files = new Map<string, string>()
  answerRegistry(on, clock, files)
  answerMeasure(on)
  on('agent.list', () => ({ value: [] }))
  on('session.usage', ($, e) => ({
    value: { startedAt: 0, context: e.breakdown === undefined ? { ...MEASURED.context } : { ...MEASURED.context, breakdown: breakdownOf(124_000) }, rateLimits: [] },
  }))
  await $.session.measure(MEASURED)
  await $.tool.call({ tool: PROGRESS, percent: 40, task: 'Port the parser', step: 'porting the lexer' })
  const ui = await $.ui.mount({ plugin: 'context-band', surface: 'desktop', ...BAND })
  await openMenu(ui)
  const saved = () => JSON.parse(files.get('/home/me/.claude/mods/band.json') ?? 'null')
  const blanks = async () => (await ui.findAll({ type: 'Text', text: /^ $/ })).length
  const note = async () => (await ui.find({ type: 'Button', key: 'band-show-all' }))?.text

  // Auto: the toolbar first, the height at its right end, then the context row, the task last; no grip.
  const order = await drawnTexts(ui)
  expect(order.indexOf('Runners')).toBeLessThan(order.indexOf('height auto'))
  expect(order.indexOf('height auto')).toBeLessThan(order.indexOf('Context'))
  expect(order.indexOf('Context')).toBeLessThan(order.indexOf('Task'))
  expect(await ui.find({ type: 'Client' })).toBeUndefined()
  expect(await ui.find({ type: 'Button', key: 'band-auto' })).toBeUndefined()

  // ▲ from auto: a ceiling a row above what the band shows, so no blank row; every press one row, ▼ one row back.
  await ui.press({ key: 'band-taller' })
  const first = saved().rows as number
  expect(await ui.find({ type: 'Text', text: `height ${first}` })).toBeDefined()
  expect(await blanks()).toBe(0)
  await ui.press({ key: 'band-taller' })
  expect(saved()).toEqual({ rows: first + 1, isMenuOpen: true })
  expect(await blanks()).toBe(0)
  await ui.press({ key: 'band-shorter' })
  expect(saved()).toEqual({ rows: first, isMenuOpen: true })
  expect(await blanks()).toBe(0)

  // Details opened at that height: what does not fit leaves from the bottom and a note counts it;
  // the context row and the task stay, and each ▲ brings back one row, each ▼ takes one.
  await ui.press({ key: 'details' })
  const out = Number(/▾ (\d+) more /.exec((await note()) ?? '')?.[1])
  expect(out).toBeGreaterThan(5)
  expect(await note()).toMatch(/· show all$/)
  expect(await blanks()).toBe(0)
  expect(await drawnTexts(ui)).toEqual(expect.arrayContaining(['Context', 'Task']))
  await ui.press({ key: 'band-taller' })
  expect(await note()).toMatch(new RegExp(`▾ ${out - 1} more `))
  expect(await drawnTexts(ui)).toContain('Details')
  await ui.press({ key: 'band-taller' })
  expect(await note()).toMatch(new RegExp(`▾ ${out - 2} more `))
  await ui.press({ key: 'band-shorter' })
  expect(await note()).toMatch(new RegExp(`▾ ${out - 1} more `))

  // The note itself shows everything: its press gives the height back to auto, nothing is cut.
  await ui.press({ key: 'band-show-all' })
  expect(saved()).toEqual({ rows: null, isMenuOpen: true })
  expect(await note()).toBeUndefined()
  expect(await drawnTexts(ui)).toContain('height auto')
  expect(await ui.find({ type: 'Button', key: 'band-auto' })).toBeUndefined()

  const sized = await $.command.run({ command: 'band', args: 'size 12', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })
  expect(sized.text).toBe('Band height: 12 rows')
  expect(saved()).toEqual({ rows: 12, isMenuOpen: true })
  expect(await drawnTexts(ui)).toContain('height 12')
  // auto at the toolbar's right end does the same.
  await ui.press({ key: 'band-auto' })
  expect(saved()).toEqual({ rows: null, isMenuOpen: true })
})

test('the toolbar waits behind ⋯ at the right end of the readings; ⋯ opens and shuts it, and every session keeps the choice', async ($, on) => {
  answerBandBeneath(on)
  const clock = mock.clock(on, { now: 1_000_000 })
  const files = new Map<string, string>()
  const band = '/home/me/.claude/mods/band.json'
  files.set(band, JSON.stringify({ rows: null }))
  answerRegistry(on, clock, files)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  answerUsage(on, { isCompacted: false }, 124_000)
  on('tool.register', ($, e) => ({ value: { tool: `mcp__context-band__${e.name}` } }))
  on('agent.list', () => ({ value: [] }))
  answerMeasure(on)
  const toasts = answerToasts(on)
  await $.session.start({ cwd: '/work', surface: null, isInteractive: false })
  await $.session.measure(MEASURED)
  const ui = await $.ui.mount({ plugin: 'context-band', surface: 'desktop', ...BAND })
  const menu = () => ui.find({ type: 'Button', key: 'band-menu', text: '⋯' })
  const saved = () => JSON.parse(files.get(band) ?? 'null')

  // A file from before ⋯ says nothing of the menu: it is shut, the readings and ⋯ show, no toolbar.
  for (const key of ['runners', 'details', 'compact', 'mods', 'band-taller']) {
    expect(await ui.find({ type: 'Button', key })).toBeUndefined()
  }
  expect(await ui.find({ type: 'Text', text: 'height auto' })).toBeUndefined()
  // The token counts wait in the chip's card, shown only under the pointer.
  expect((await shownTexts(ui)).some(text => text.includes('124k of 200k'))).toBe(false)
  expect((await cardTexts(ui, 'context-band:context'))?.[2]).toMatch(/^124k of 200k/)
  expect((await menu())?.props.dimColor).toBe(true)

  // ⋯ opens the toolbar above the readings and keeps that for every session; pressed again it shuts.
  await ui.press({ key: 'band-menu' })
  const order = await drawnTexts(ui)
  expect(order.indexOf('Runners')).toBeLessThan(order.indexOf('Context'))
  expect(order).toContain('height auto')
  expect((await menu())?.props.dimColor).toBe(false)
  expect(saved()).toEqual({ rows: null, isMenuOpen: true })
  await ui.press({ key: 'band-menu' })
  expect(await ui.find({ type: 'Button', key: 'runners' })).toBeUndefined()
  expect(saved()).toEqual({ rows: null, isMenuOpen: false })

  // Another session opened it: this one follows at its next heartbeat.
  files.set(band, JSON.stringify({ rows: null, isMenuOpen: true }))
  await clock.advance(30_000)
  expect(await ui.find({ type: 'Button', key: 'runners' })).toBeDefined()
  await ui.press({ key: 'band-menu' })

  // Shut, a nearly full window still puts Compact beside ⋯, drawn as the main action.
  await $.session.measure({ ...MEASURED, context: { tokens: 170_000, window: 200_000, percent: 85 } })
  expect(toasts.length).toBeGreaterThan(0)
  expect(await ui.find({ type: 'Button', key: 'runners' })).toBeUndefined()
  expect((await ui.find({ type: 'Button', key: 'compact' }))?.props.variant).toBe('primary')
  const full = await drawnTexts(ui)
  expect(full.indexOf('Compact')).toBe(full.indexOf('⋯') - 1)
})

test('a set height counts the toolbar: shutting the menu makes the band that much shorter, with no blank rows in its place', async ($, on) => {
  answerBandBeneath(on)
  const clock = mock.clock(on, { now: 1_000_000 })
  const files = new Map<string, string>()
  answerRegistry(on, clock, files)
  answerMeasure(on)
  on('agent.list', () => ({ value: [] }))
  on('session.usage', ($, e) => ({
    value: { startedAt: 0, context: e.breakdown === undefined ? { ...MEASURED.context } : { ...MEASURED.context, breakdown: breakdownOf(124_000) }, rateLimits: [] },
  }))
  await $.session.measure(MEASURED)
  await $.tool.call({ tool: PROGRESS, percent: 40, task: 'Port the parser', step: 'porting the lexer' })
  const ui = await $.ui.mount({ plugin: 'context-band', surface: 'desktop', ...BAND })
  await openMenu(ui)
  // A blank row is a no-break space (BLANK_ROW), which no surface collapses.
  const blanks = async () => (await ui.findAll({ type: 'Text', text: /^\u00a0$/ })).length

  // A height a row taller than the band: a ceiling, not a floor, so no blank row fills it.
  expect(await drawnTexts(ui)).toContain('height auto')
  await ui.press({ key: 'band-taller' })
  expect(await ui.find({ type: 'Text', text: /^height \d+$/ })).toBeDefined()
  expect(await blanks()).toBe(0)

  // Shut: the toolbar's row goes and the band with it; still no blank row.
  await ui.press({ key: 'band-menu' })
  expect(await ui.find({ type: 'Button', key: 'runners' })).toBeUndefined()
  expect(await drawnTexts(ui)).toContain('Task')
  expect(await blanks()).toBe(0)

  // Open again: as before.
  await ui.press({ key: 'band-menu' })
  expect(await ui.find({ type: 'Button', key: 'runners' })).toBeDefined()
  expect(await blanks()).toBe(0)
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
