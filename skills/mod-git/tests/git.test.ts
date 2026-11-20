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
  props: { hasSurvey: false, isWorking: false, maxRows: 30, bodyColumns: 160, scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const
const STATUS = [
  '# branch.oid 1a2b3c4d',
  '# branch.head research/123-parser-bakeoff',
  '# branch.upstream origin/research/123-parser-bakeoff',
  '# branch.ab +2 -1',
  '1 .M N... 100644 100644 100644 aaa bbb src/a.py',
  '1 M. N... 100644 100644 100644 aaa bbb src/b.py',
  '? notes.md',
].join('\n')
const PULL = JSON.stringify({
  number: 345,
  title: 'parser: tokenizer bake-off',
  state: 'OPEN',
  isDraft: false,
  reviewDecision: 'CHANGES_REQUESTED',
  statusCheckRollup: [{ conclusion: 'SUCCESS' }, { conclusion: 'SUCCESS' }, { conclusion: 'FAILURE' }, { status: 'IN_PROGRESS', conclusion: '' }],
  comments: [{}, {}],
  url: 'https://github.com/o/r/pull/345',
})

type World = { files: Map<string, string>; ran: string[][] }

function answerWorld(on: On, clock: MockClock, pullExit = 0): World {
  const world: World = { files: new Map(), ran: [] }
  mock.env(on, { HOME })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/work/app' }))
  on('fs.exists', ($, e) => ({ value: world.files.has(e.path) }))
  on('fs.read', ($, e) => {
    const text = world.files.get(e.path)

    return text === undefined ? { deny: `ENOENT: ${e.path}` } : { value: text }
  })
  on('fs.write', ($, e) => {
    world.files.set(e.path, e.text)

    return { value: undefined }
  })
  on('fs.stat', () => ({ deny: 'ENOENT' }))
  on('process.run', ($, e) => {
    world.ran.push([...e.argv])
    const isGh = e.argv[0] === 'gh'

    return {
      value: {
        exitCode: isGh ? pullExit : 0,
        stdout: isGh ? (pullExit === 0 ? PULL : '') : STATUS,
        stderr: '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }
  })
  on('tool.call', { tool: 'Bash' }, () => ({ result: {}, text: '' }))
  on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'Box' as const, children: [{ type: 'Text' as const, children: ['beneath'] }] }))

  return world
}

test('a branch behind its upstream and a pull request that needs a look show as one row each', { plugins: [BAND_ROW] }, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const world = answerWorld(on, clock)
  await $.session.start({ cwd: '/work/app', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'mod-git', surface: 'desktop', ...BAND })
  expect((await ui.findAll({ type: 'Text' })).map(found => found.text)).toEqual([
    'Git',
    '3',
    'research/123-parser-bakeoff · ↑2 ↓1',
    'PR',
    '#345',
    'checks 2/4, 1 failed, 1 running · changes requested',
    'beneath',
  ])
  expect((await ui.find({ type: 'Text', text: '#345' }))?.props.color).toBe('error')
  expect(world.ran.filter(argv => argv[0] === 'gh')).toHaveLength(1)

  // Within three minutes the pull request is not asked for again; a push asks at once.
  await clock.advance(60_000)
  expect(world.ran.filter(argv => argv[0] === 'gh')).toHaveLength(1)
  await $.tool.call({ tool: 'Bash', command: 'git push origin HEAD' })
  expect(world.ran.filter(argv => argv[0] === 'gh')).toHaveLength(2)
})

test('a branch without a pull request shows only the git row', { plugins: [BAND_ROW] }, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  answerWorld(on, clock, 1)
  await $.session.start({ cwd: '/work/app', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'mod-git', surface: 'desktop', ...BAND })
  const texts = (await ui.findAll({ type: 'Text' })).map(found => found.text)
  expect(texts).toContain('Git')
  expect(texts).not.toContain('PR')
})
