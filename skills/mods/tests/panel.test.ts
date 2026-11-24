import { expect, mock, test } from 'claude-code/testing'
import type { MockClock } from 'claude-code/testing'
import type { On, PaneOpenArgs, UiPane } from 'claude-code'

const HOME = '/home/me'
const SKILLS = `${HOME}/.claude/skills`
const SWITCHES = `${HOME}/.claude/mods/state.json`

const BAND = {
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 30,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const PANE = {
  component: 'Pane',
  requestId: 'mods',
  props: {
    title: 'Mods',
    isFocused: false,
    bodyColumns: 46,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const COMMAND = { origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } } as const

// Three installed mods and a plain skill, which carries no card and is not listed.
function installed(): Map<string, string> {
  const card = (order: number, title: string, summary: string) => JSON.stringify({ order, title, summary })
  const manifest = (name: string) => JSON.stringify({ name, version: '0.1.0' })

  return new Map([
    [`${SKILLS}/mods/mod.json`, card(0, 'Mods', 'This panel')],
    [`${SKILLS}/mods/.claude-plugin/plugin.json`, manifest('mods')],
    [`${SKILLS}/mod-limits/mod.json`, card(2, 'Subscription limits', 'How much is left')],
    [`${SKILLS}/mod-limits/.claude-plugin/plugin.json`, manifest('mod-limits')],
    [`${SKILLS}/context-band/mod.json`, card(1, 'Context band', 'Context above the prompt')],
    [`${SKILLS}/context-band/.claude-plugin/plugin.json`, manifest('context-band')],
    [`${SKILLS}/arch-atlas/SKILL.md`, '# a skill'],
  ])
}

type World = {
  files: Map<string, string>
  opened: PaneOpenArgs[]
  toasts: string[]
  panes: UiPane[]
  // Another session writing a file, stamped with the clock's time.
  write: (path: string, text: string) => void
}

// The disk in memory: a file's time is the clock's when it was written.
function answerWorld(on: On, clock: MockClock, files: Map<string, string>, isPlaced = true): World {
  const mtimes = new Map<string, number>()
  const world: World = {
    files,
    opened: [],
    toasts: [],
    panes: [],
    write: (path, text) => {
      files.set(path, text)
      mtimes.set(path, clock.now())
    },
  }
  const isDir = (path: string) => [...files.keys()].some(file => file.startsWith(`${path}/`))
  mock.env(on, { HOME })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('fs.exists', ($, e) => ({ value: files.has(e.path) || isDir(e.path) }))
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
  on('fs.list', ($, e) => {
    const names = new Set<string>()
    for (const path of files.keys()) {
      if (path.startsWith(`${e.path}/`)) {
        names.add(path.slice(e.path.length + 1).split('/')[0] ?? '')
      }
    }

    return {
      value: [...names].map(name => ({
        name,
        kind: files.has(`${e.path}/${name}`) ? ('file' as const) : ('dir' as const),
        size: 0,
        mtimeMs: 0,
        isLink: false,
      })),
    }
  })
  on('ui.open', ($, e) => {
    world.opened.push(e)
    world.panes = [{ id: e.id, title: e.title ?? e.id, isShown: true, isFocused: false, isPlaced }]

    return { value: isPlaced ? { isPlaced: true as const } : { isPlaced: false as const, reason: 'the terminal is 90 columns wide' } }
  })
  on('ui.panes', () => ({ value: world.panes }))
  on('ui.close', () => {
    world.panes = []

    return { value: undefined }
  })
  // What the engine draws in the band beneath the plugins: here, a line another mod drew.
  on('ui.render', { component: 'AbovePrompt' }, () => ({
    type: 'Box' as const,
    children: [{ type: 'Text' as const, children: ['Context 40%'] }],
  }))
  on('ui.toast', ($, e) => {
    world.toasts.push(e.text)

    return { value: undefined }
  })

  return world
}

function switchesIn(world: World): unknown {
  return JSON.parse(world.files.get(SWITCHES) ?? 'null')
}

test('a new session opens the panel, which lists the installed mods in their order with a switch each', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const world = answerWorld(on, clock, installed())

  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
  expect(world.opened.map(open => open.id)).toEqual(['mods'])

  for (const surface of ['terminal', 'desktop'] as const) {
    // The panel is in sight, so the band is left as the other mods drew it.
    const band = await $.ui.mount({ plugin: 'mods', surface, ...BAND })
    expect(await band.find({ type: 'Button', key: 'mods' })).toBeUndefined()
    expect(await band.find({ type: 'Text', text: 'Context 40%' })).toBeDefined()
    await band.unmount()

    const pane = await $.ui.mount({ plugin: 'mods', surface, ...PANE })
    expect(await pane.find({ type: 'Text', text: '2 of 2 on · applies to every session' })).toBeDefined()
    const titles = (await pane.findAll({ type: 'Text', text: /^(Mods|Context band|Subscription limits)$/ })).map(found => found.text)
    expect(titles).toEqual(['Mods', 'Mods', 'Context band', 'Subscription limits'])
    expect(await pane.find({ type: 'Button', key: 'switch:mods' })).toBeUndefined()
    expect(await pane.find({ type: 'Text', text: 'always' })).toBeDefined()
    expect(await pane.find({ type: 'Button', key: 'switch:context-band', text: 'Turn off' })).toBeDefined()
    expect(await pane.find({ type: 'Button', key: 'switch:mod-limits', text: 'Turn off' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /SKILL|arch-atlas/ })).toBeUndefined()
    await pane.unmount()
  }
})

test('a switch writes the shared file; all off and all on cover every listed mod but the panel', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const world = answerWorld(on, clock, installed())
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
  const pane = await $.ui.mount({ plugin: 'mods', surface: 'desktop', ...PANE })

  await clock.advance(10)
  await pane.press({ key: 'switch:mod-limits' })
  expect(switchesIn(world)).toMatchObject({ off: ['mod-limits'], isPaneWanted: true })
  expect(await pane.find({ type: 'Button', key: 'switch:mod-limits', text: 'Turn on' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: '1 of 2 on · applies to every session' })).toBeDefined()

  await clock.advance(10)
  await pane.press({ key: 'all-off' })
  expect(switchesIn(world)).toMatchObject({ off: ['context-band', 'mod-limits'] })
  expect(await pane.find({ type: 'Text', text: '0 of 2 on · applies to every session' })).toBeDefined()

  await clock.advance(10)
  await pane.press({ key: 'all-on' })
  expect(switchesIn(world)).toMatchObject({ off: [] })
  expect(await pane.find({ type: 'Text', text: '2 of 2 on · applies to every session' })).toBeDefined()
})

test('a switch another session flipped shows here within a poll', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const world = answerWorld(on, clock, installed())
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
  const pane = await $.ui.mount({ plugin: 'mods', surface: 'desktop', ...PANE })

  await clock.advance(100)
  world.write(SWITCHES, JSON.stringify({ off: ['context-band'], isPaneWanted: true, updatedAt: 1_100 }))
  expect(await pane.find({ type: 'Button', key: 'switch:context-band', text: 'Turn off' })).toBeDefined()

  await clock.advance(1_500)
  expect(await pane.find({ type: 'Button', key: 'switch:context-band', text: 'Turn on' })).toBeDefined()
})

test('with the band switched off and the panel closed, a Mods button of its own opens the panel', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const files = installed()
  files.set(SWITCHES, JSON.stringify({ off: ['context-band'], isPaneWanted: false, updatedAt: 900 }))
  const world = answerWorld(on, clock, files)
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
  expect(world.opened).toHaveLength(0)

  const band = await $.ui.mount({ plugin: 'mods', surface: 'desktop', ...BAND })
  expect(await band.find({ type: 'Text', text: 'Context 40%' })).toBeDefined()
  await clock.advance(10)
  await band.press({ key: 'mods' })
  expect(world.opened.map(open => open.id)).toEqual(['mods'])
  expect(switchesIn(world)).toMatchObject({ isPaneWanted: true })
  expect(await band.find({ type: 'Button', key: 'mods' })).toBeUndefined()

  // Closed from its frame: the next poll finds it gone and the button is back.
  world.panes = []
  await clock.advance(1_500)
  expect(await band.find({ type: 'Button', key: 'mods', text: 'Mods' })).toBeDefined()
})

test('while the band is on, the panel draws no button of its own in it', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const files = installed()
  files.set(SWITCHES, JSON.stringify({ off: [], isPaneWanted: false, updatedAt: 900 }))
  answerWorld(on, clock, files)
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })

  const band = await $.ui.mount({ plugin: 'mods', surface: 'desktop', ...BAND })
  expect(await band.find({ type: 'Button', key: 'mods' })).toBeUndefined()
  expect(await band.find({ type: 'Text', text: 'Context 40%' })).toBeDefined()
})

test('a session started after the person closed the panel leaves it closed', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const files = installed()
  files.set(SWITCHES, JSON.stringify({ off: [], isPaneWanted: false, updatedAt: 900 }))
  const world = answerWorld(on, clock, files)

  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
  expect(world.opened).toHaveLength(0)
})

test('/mods switches by number or name from the prompt and prints the list', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const world = answerWorld(on, clock, installed())
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })

  await clock.advance(10)
  const off = await $.command.run({ command: 'mods', args: 'off 2', ...COMMAND })
  expect(switchesIn(world)).toMatchObject({ off: ['mod-limits'] })
  expect(off.text).toBe('0 ● Mods - always\n1 ● Context band\n2 ○ Subscription limits')

  await clock.advance(10)
  await $.command.run({ command: 'mods', args: 'on mod-limits', ...COMMAND })
  expect(switchesIn(world)).toMatchObject({ off: [] })

  const unknown = await $.command.run({ command: 'mods', args: 'off 0', ...COMMAND })
  expect(unknown.text).toMatch(/^No mod to switch by that name or number: 0/)
})

test('where the surface places no pane, the list opens in the band, switches there and closes again', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const files = installed()
  files.set(SWITCHES, JSON.stringify({ off: ['context-band'], isPaneWanted: false, updatedAt: 900 }))
  const world = answerWorld(on, clock, files, false)
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
  const band = await $.ui.mount({ plugin: 'mods', surface: 'desktop', ...BAND })

  await band.press({ key: 'mods' })
  expect(world.opened).toHaveLength(1)
  expect(world.panes).toEqual([])
  const texts = async () => (await band.findAll({ type: 'Text' })).map(found => found.text)
  expect(await texts()).toEqual(
    expect.arrayContaining([
      'Mods',
      '1 of 2 on · applies to every session',
      '○ off',
      'Context band',
      '● on',
      'Subscription limits',
      'always',
    ]),
  )

  await clock.advance(10)
  await band.press({ key: 'switch:context-band' })
  expect(switchesIn(world)).toMatchObject({ off: [] })
  // The band is back on, so its toolbar carries the button; the list stays open until asked to close.
  expect(await band.find({ type: 'Button', key: 'mods' })).toBeUndefined()
  expect(await band.find({ type: 'Text', text: '2 of 2 on · applies to every session' })).toBeDefined()

  const closed = await $.command.run({ command: 'mods', args: '', ...COMMAND })
  expect(closed.text).toBe('0 ● Mods - always\n1 ● Context band\n2 ● Subscription limits')
  expect(await band.find({ type: 'Text', text: '2 of 2 on · applies to every session' })).toBeUndefined()
})

test('the quiet switch writes the shared file from the panel and from the prompt', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const world = answerWorld(on, clock, installed())
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
  const pane = await $.ui.mount({ plugin: 'mods', surface: 'desktop', ...PANE })
  expect(await pane.find({ type: 'Button', key: 'quiet', text: 'Quiet mode: off' })).toBeDefined()

  await clock.advance(10)
  await pane.press({ key: 'quiet' })
  expect(switchesIn(world)).toMatchObject({ quiet: true })
  expect(await pane.find({ type: 'Button', key: 'quiet', text: 'Quiet mode: on' })).toBeDefined()

  await clock.advance(10)
  const shown = await $.command.run({ command: 'mods', args: 'quiet off', ...COMMAND })
  expect(switchesIn(world)).toMatchObject({ quiet: false })
  expect(shown.text).not.toContain('Quiet mode on')
})

test('sounds and the voice are picked in the panel or from the prompt, and kept in the shared file', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const world = answerWorld(on, clock, installed())
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
  const pane = await $.ui.mount({ plugin: 'mods', surface: 'desktop', ...PANE })
  expect((await pane.find({ type: 'Select', key: 'setting:sounds' }))?.props.value).toBe('on')
  expect((await pane.find({ type: 'Select', key: 'setting:voice' }))?.props.value).toBe('off')

  await clock.advance(10)
  await pane.select({ key: 'setting:voice', value: 'on' })
  expect(switchesIn(world)).toMatchObject({ settings: { sounds: true, voice: true } })

  await clock.advance(10)
  const shown = await $.command.run({ command: 'mods', args: 'sounds off', ...COMMAND })
  expect(switchesIn(world)).toMatchObject({ settings: { sounds: false, voice: true } })
  expect(shown.text).toContain('Sounds off')
  expect(shown.text).toContain('Voice news on')
})

// A mod whose card offers choices: a model from the /config menu and an effort.
function withChoices(): Map<string, string> {
  const files = installed()
  files.set(
    `${SKILLS}/claim-check/mod.json`,
    JSON.stringify({
      order: 17,
      title: 'Claim check',
      summary: 'Checks each answer',
      settings: [
        { key: 'model', label: 'Model', options: 'models', default: 'sonnet' },
        { key: 'effort', label: 'Effort', options: ['low', 'medium', 'high', 'xhigh', 'max'], default: 'low' },
      ],
    }),
  )
  files.set(`${SKILLS}/claim-check/.claude-plugin/plugin.json`, JSON.stringify({ name: 'claim-check', version: '0.7.1' }))

  return files
}

const MODEL_ROW = {
  key: 'model',
  label: 'Model',
  kind: 'choice',
  value: 'opus',
  options: ['default', 'sonnet', 'opus', 'haiku', 'fable', 'best', 'sonnet[1m]', 'fable[1m]', 'opusplan'],
  provider: { plugin: 'engine', tier: 'core' },
  isLocked: false,
}

test("a mod's card can offer choices: the panel draws them under its row and keeps the pick in the shared file", async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const world = answerWorld(on, clock, withChoices())
  on('config.list', () => ({ value: [MODEL_ROW] }) as never)
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
  const pane = await $.ui.mount({ plugin: 'mods', surface: 'desktop', ...PANE })

  const model = await pane.find({ type: 'Select', key: 'mod-setting:claim-check:model' })
  expect(model?.props.value).toBe('sonnet')
  // The menu's models, less `default`, the plan-mode pairing and the 1M-context variants,
  // then the full ids that pin a version; a family alias is labelled as the latest.
  const offered = model?.props.options as { value: string; label: string }[]
  expect(offered.map(option => option.value)).toEqual([
    'sonnet',
    'opus',
    'haiku',
    'fable',
    'best',
    'claude-sonnet-5-5',
    'claude-opus-5-5',
    'claude-haiku-5-5',
    'claude-fable-5-2',
  ])
  expect(offered.map(option => option.label).slice(0, 6)).toEqual([
    'sonnet (latest)',
    'opus (latest)',
    'haiku (latest)',
    'fable (latest)',
    'best',
    'claude-sonnet-5-5',
  ])
  expect((await pane.find({ type: 'Select', key: 'mod-setting:claim-check:effort' }))?.props.value).toBe('low')
  // A mod whose card offers none gets no select.
  const keys = (await pane.findAll({ type: 'Select' })).map(found => found.key)
  expect(keys.filter(key => String(key).startsWith('mod-setting:'))).toEqual(['mod-setting:claim-check:model', 'mod-setting:claim-check:effort'])

  await clock.advance(10)
  await pane.select({ key: 'mod-setting:claim-check:model', value: 'claude-fable-5-2' })
  await clock.advance(10)
  await pane.select({ key: 'mod-setting:claim-check:effort', value: 'high' })
  expect(switchesIn(world)).toMatchObject({
    modSettings: { 'claim-check': { model: 'claude-fable-5-2', effort: 'high' } },
    settings: { sounds: true, voice: false },
  })
  expect((await pane.find({ type: 'Select', key: 'mod-setting:claim-check:model' }))?.props.value).toBe('claude-fable-5-2')
})

test('where the /config menu lists no models, a models choice offers the aliases every account has and the pinned ids', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  answerWorld(on, clock, withChoices())
  on('config.list', () => ({ value: [] }) as never)
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
  const pane = await $.ui.mount({ plugin: 'mods', surface: 'desktop', ...PANE })

  const model = await pane.find({ type: 'Select', key: 'mod-setting:claim-check:model' })
  expect((model?.props.options as { value: string }[]).map(option => option.value)).toEqual([
    'sonnet',
    'opus',
    'haiku',
    'claude-sonnet-5-5',
    'claude-opus-5-5',
    'claude-haiku-5-5',
    'claude-fable-5-2',
  ])
})

test('cards that name a group are listed in sections: Readings, Conversation, Checks, Guards, then the rest', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const card = (order: number, title: string, group?: string) => JSON.stringify({ order, title, summary: `${title} does a thing`, ...(group ? { group } : {}) })
  const manifest = (name: string) => JSON.stringify({ name, version: '0.1.0' })
  const files = new Map([
    [`${SKILLS}/mods/mod.json`, card(0, 'Mods')],
    [`${SKILLS}/mods/.claude-plugin/plugin.json`, manifest('mods')],
    [`${SKILLS}/guard/mod.json`, card(3, 'A guard', 'Guards')],
    [`${SKILLS}/guard/.claude-plugin/plugin.json`, manifest('guard')],
    [`${SKILLS}/reading/mod.json`, card(5, 'A reading', 'Readings')],
    [`${SKILLS}/reading/.claude-plugin/plugin.json`, manifest('reading')],
    [`${SKILLS}/check/mod.json`, card(1, 'A check', 'Checks')],
    [`${SKILLS}/check/.claude-plugin/plugin.json`, manifest('check')],
    [`${SKILLS}/loose/mod.json`, card(2, 'A loose one')],
    [`${SKILLS}/loose/.claude-plugin/plugin.json`, manifest('loose')],
  ])
  answerWorld(on, clock, files)
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })

  const pane = await $.ui.mount({ plugin: 'mods', surface: 'desktop', ...PANE })
  const texts = (await pane.findAll({ type: 'Text' })).map(found => found.text)
  const order = texts.filter(text => /^(Mods|Readings|Checks|Guards|Other|A reading|A check|A guard|A loose one)$/.test(text))
  expect(order).toEqual(['Mods', 'Mods', 'Readings', 'A reading', 'Checks', 'A check', 'Guards', 'A guard', 'Other', 'A loose one'])
  expect(texts).toContain('1 of 1 on')
  await pane.unmount()
})

test("a mod's model calls today, as cost-meter counts them, show under its row", async ($, on) => {
  const clock = mock.clock(on, { now: Date.parse('2026-11-24T12:00:00Z') })
  const files = installed()
  files.set(`${HOME}/.claude/mods/side-models.json`, JSON.stringify({ '2026-11-24': { 'context-band': { calls: 12, input: 220_000, output: 9_500, ms: 1 } }, '2026-11-23': { 'mod-limits': { calls: 1, input: 1, output: 1, ms: 1 } } }))
  answerWorld(on, clock, files)
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
  const pane = await $.ui.mount({ plugin: 'mods', surface: 'desktop', ...PANE })
  const texts = (await pane.findAll({ type: 'Text' })).map(found => found.text)
  expect(texts).toContain('Today: 230k tokens in 12 model calls')
  expect(texts.filter(text => text.startsWith('Today:'))).toHaveLength(1)
  await pane.unmount()
})
