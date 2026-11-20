import { expect, mock, test } from 'claude-code/testing'
import type { MockClock } from 'claude-code/testing'
import type { On } from 'claude-code'

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
const BAND = {
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 30, bodyColumns: 140, scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const
const MEMORY = 'The system has 19327352832 (1179648 pages with a page size of 16384).\nSystem-wide memory free percentage: 76%\n'
const DF = 'Filesystem 1024-blocks Used Available Capacity iused ifree %iused Mounted on\n/dev/disk3s5 482797652 435846444 21662368 96% 4661087 216623680 2% /System/Volumes/Data\n'

type World = { files: Map<string, string>; ran: string[] }

function answerWorld(on: On, clock: MockClock, files: Map<string, string>, free = MEMORY): World {
  const world: World = { files, ran: [] }
  const mtimes = new Map<string, number>()
  mock.env(on, { HOME })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('fs.exists', ($, e) => ({ value: files.has(e.path) }))
  on('fs.read', ($, e) => {
    const text = files.get(e.path)

    return text === undefined ? { deny: `ENOENT: ${e.path}` } : { value: text }
  })
  on('fs.write', ($, e) => {
    files.set(e.path, e.text)
    mtimes.set(e.path, clock.now())

    return { value: undefined }
  })
  on('fs.stat', ($, e) =>
    files.has(e.path) ? { value: { kind: 'file' as const, size: 1, mtimeMs: mtimes.get(e.path) ?? 0, isLink: false } } : { deny: `ENOENT: ${e.path}` },
  )
  on('process.run', ($, e) => {
    world.ran.push(e.argv[0] ?? '')
    const stdout = e.argv[0] === 'memory_pressure' ? free : DF

    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'Box' as const, children: [{ type: 'Text' as const, children: ['beneath'] }] }))

  return world
}

test('calm memory is a chip, a nearly full disk a red row; the reading is shared with the other sessions', { plugins: [BAND_ROW] }, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const files = new Map<string, string>([[`${HOME}/.claude/hooks/.agent_launches.json`, JSON.stringify([{ t: NOW / 1000 - 60, tool: 'Agent' }, { t: NOW / 1000 - 3_600, tool: 'Agent' }])]])
  const world = answerWorld(on, clock, files)
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ plugin: 'mod-machine', surface: 'desktop', ...BAND })
  expect((await ui.findAll({ type: 'Text' })).map(found => found.text)).toEqual([
    'Disk',
    '96%',
    `${'█'.repeat(19)}${'░'}`,
    '20.7 GB free',
    'RAM',
    '24%',
    'beneath',
  ])
  expect((await ui.find({ type: 'Text', text: '96%' }))?.props.color).toBe('error')
  expect(JSON.parse(files.get(`${HOME}/.claude/mods/machine.json`) ?? 'null')).toMatchObject({ freePct: 76, slots: { live: 1, budget: 4 } })
  expect(world.ran).toEqual(['memory_pressure', 'df'])
})

test('a fresh reading from another session is reused; amber memory is a row with its free share and the gate slots', { plugins: [BAND_ROW] }, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const files = new Map<string, string>([
    [`${HOME}/.claude/mods/machine.json`, JSON.stringify({ at: NOW - 5_000, freePct: 40, disk: { usedPct: 50, freeKb: 230 * 1024 * 1024, totalKb: 460 * 1024 * 1024 }, slots: { live: 1, budget: 2 }, isGateOff: false })],
  ])
  const world = answerWorld(on, clock, files)
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'mod-machine', surface: 'desktop', ...BAND })
  expect(world.ran).toEqual([])
  expect((await ui.findAll({ type: 'Text' })).map(found => found.text)).toEqual([
    'Memory',
    '60%',
    `${'█'.repeat(12)}${'░'.repeat(8)}`,
    '40% free · slots 1/2',
    'Disk',
    '50% · 230 GB free',
    'beneath',
  ])
  expect((await ui.find({ type: 'Text', text: '60%' }))?.props.color).toBe('warning')
})

test('in quiet mode only what needs a look shows: a full disk, not calm memory', { plugins: [BAND_ROW] }, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const files = new Map<string, string>([[`${HOME}/.claude/mods/state.json`, JSON.stringify({ off: [], quiet: true })]])
  answerWorld(on, clock, files)
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'mod-machine', surface: 'desktop', ...BAND })
  const texts = (await ui.findAll({ type: 'Text' })).map(found => found.text)
  expect(texts).toContain('Disk')
  expect(texts).not.toContain('Memory')
})
