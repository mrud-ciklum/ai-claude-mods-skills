import { expect, mock, test } from 'claude-code/testing'
import type { MockClock, Mounted } from 'claude-code/testing'
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
  props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 30, bodyColumns: 160, scroll: { offset: 0, bodyRows: 30 }, view: {} },
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
  author: { login: 'me' },
})
// Three review threads: one resolved, one where the author answered last, one where a reviewer did.
const THREADS = JSON.stringify({
  data: {
    repository: {
      pullRequest: {
        reviewThreads: {
          nodes: [
            { isResolved: true, comments: { nodes: [{ author: { login: 'reviewer' } }] } },
            { isResolved: false, comments: { nodes: [{ author: { login: 'me' } }] } },
            { isResolved: false, comments: { nodes: [{ author: { login: 'reviewer' } }] } },
          ],
        },
      },
    },
  },
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
    const isThreads = isGh && e.argv[1] === 'api'

    return {
      value: {
        exitCode: isGh ? pullExit : 0,
        stdout: isThreads ? THREADS : isGh ? (pullExit === 0 ? PULL : '') : STATUS,
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

test('the branch and its pull request are chips on the band\'s one line; one that needs a look turns red', { plugins: [BAND_ROW] }, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const world = answerWorld(on, clock)
  await $.session.start({ cwd: '/work/app', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'mod-git', surface: 'desktop', ...BAND })
  expect(await shownTexts(ui)).toEqual(['Git', '3', 'PR', '#345', 'beneath'])
  // The pull request's checks, review and threads wait in its chip's card.
  expect(await cardTexts(ui, 'mod-git:PR')).toEqual(['PR', '#345', 'checks 2/4, 1 failed, 1 running · changes requested · 2 open threads, 1 wait for the author'])
  expect(await cardTexts(ui, 'mod-git:Git')).toEqual(['Git', '3', 'research/123-parser-bakeoff · ↑2 ↓1'])
  expect((await ui.find({ type: 'Text', text: '#345' }))?.props.color).toBe('error')
  // The threads are asked for with the pull request's own owner, name and number.
  expect(world.ran.find(argv => argv[1] === 'api')?.slice(-6)).toEqual(['-F', 'owner=o', '-F', 'name=r', '-F', 'number=345'])
  expect(world.ran.filter(argv => argv[0] === 'gh' && argv[1] === 'pr')).toHaveLength(1)

  // Within three minutes the pull request is not asked for again; a push asks at once.
  await clock.advance(60_000)
  expect(world.ran.filter(argv => argv[0] === 'gh' && argv[1] === 'pr')).toHaveLength(1)
  await $.tool.call({ tool: 'Bash', command: 'git push origin HEAD' })
  expect(world.ran.filter(argv => argv[0] === 'gh' && argv[1] === 'pr')).toHaveLength(2)
})

test('a branch without a pull request shows only the git row', { plugins: [BAND_ROW] }, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  answerWorld(on, clock, 1)
  await $.session.start({ cwd: '/work/app', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'mod-git', surface: 'desktop', ...BAND })
  const texts = await shownTexts(ui)
  expect(texts).toContain('Git')
  expect(texts).not.toContain('PR')
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
