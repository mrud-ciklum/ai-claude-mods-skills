import { expect, mock, test } from 'claude-code/testing'
import type { ElementQuery, FoundElement, MockClock } from 'claude-code/testing'
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
const REGISTRY = `${HOME}/.claude/context-band/sessions`
const MINUTE = 60_000
const NOW = 50_000_000

const BAND = {
  component: 'AbovePrompt',
  props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 40, bodyColumns: 140, scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const
const COMMAND = { origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } } as const

type World = { files: Map<string, string>; toasts: string[]; played: string[]; sent: Array<{ to: unknown; text: string }>; write: (path: string, text: string) => void }

function answerWorld(on: On, clock: MockClock): World {
  const files = new Map<string, string>()
  const mtimes = new Map<string, number>()
  const world: World = {
    files,
    toasts: [],
    played: [],
    sent: [],
    write: (path, text) => {
      files.set(path, text)
      mtimes.set(path, clock.now())
    },
  }
  const isDir = (path: string) => [...files.keys()].some(file => file.startsWith(`${path}/`))
  mock.env(on, { HOME })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'sess-here' }))
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
      ? { value: { kind: 'file' as const, size: 1, mtimeMs: mtimes.get(e.path) ?? clock.now(), isLink: false } }
      : isDir(e.path)
        ? { value: { kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false } }
        : { deny: `ENOENT: ${e.path}` },
  )
  on('fs.list', ($, e) => ({
    value: [...files.keys()]
      .filter(path => path.startsWith(`${e.path}/`) && !path.slice(e.path.length + 1).includes('/'))
      .map(path => ({ name: path.slice(e.path.length + 1), kind: 'file' as const, size: 1, mtimeMs: mtimes.get(path) ?? 0, isLink: false })),
  }))
  on('ui.toast', ($, e) => {
    world.toasts.push(e.text)

    return { value: undefined }
  })
  on('audio.play', ($, e) => {
    world.played.push(e.clip.asset ?? '')

    return { value: undefined }
  })
  on('session.send', ($, e) => {
    world.sent.push({ to: e.to, text: e.text })

    return { isDelivered: true as const }
  })
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'Box' as const, children: [{ type: 'Text' as const, children: ['beneath'] }] }))

  return world
}

function card(sessionId: string, cwd: string, extra: Record<string, unknown>): string {
  return JSON.stringify({ sessionId, cwd, task: null, runners: [], updatedAt: NOW, isEnded: false, ...extra })
}

async function drawnTexts(ui: { findAll: (query: ElementQuery) => Promise<FoundElement[]> }): Promise<string[]> {
  return (await ui.findAll({})).filter(found => found.type === 'Text' || found.type === 'Button').map(found => found.text)
}

test('the section lists every live session: this one first, then who waits with what it asks, then the working and the idle ones', { plugins: [BAND_ROW] }, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const world = answerWorld(on, clock)
  world.write(`${REGISTRY}/sess-here.json`, card('sess-here', '/work/app', { fill: 32, task: { title: 'Mod 0', percent: 45 }, turn: { isWorking: true, since: NOW - MINUTE } }))
  world.write(
    `${REGISTRY}/sess-a.json`,
    card('sess-a', '/work/trial', {
      fill: 71,
      task: { title: 'Rescore #123', percent: 80 },
      turn: { isWorking: false, since: NOW - 15 * MINUTE },
      said: 'Rescore done: +0.004 score. Publish the delta?',
      ending: 'answer',
      runners: [{ id: 'b1', status: 'running', description: 'job', endedAt: null }],
    }),
  )
  world.write(`${REGISTRY}/sess-b.json`, card('sess-b', '/work/app', { fill: 12, turn: { isWorking: true, since: NOW - 2 * MINUTE }, asked: 'Check CI on #125' }))
  world.write(`${REGISTRY}/sess-c.json`, card('sess-c', '/work/new', { fill: 3, turn: { isWorking: false, since: 0 } }))
  world.write(`${REGISTRY}/sess-old.json`, card('sess-old', '/work/old', { isEnded: true }))
  world.write('/work/trial/.git/HEAD', 'ref: refs/heads/fix/123\n')
  world.write('/work/app/.git', 'gitdir: /repos/app.git/worktrees/app\n')
  world.write('/repos/app.git/worktrees/app/HEAD', 'ref: refs/heads/research/123\n')
  // A submodule's .git points at its git folder relative to itself.
  world.write('/work/new/.git', 'gitdir: ../.git/modules/new\n')
  world.write('/work/.git/modules/new/HEAD', 'ref: refs/heads/feat/rel\n')
  await $.session.start({ cwd: '/work/app', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'mod-sessions', surface: 'desktop', ...BAND })
  expect(await drawnTexts(ui)).toEqual(['beneath'])

  await $.command.run({ command: 'sessions', args: '', ...COMMAND })
  const texts = await drawnTexts(ui)
  expect(texts).toEqual(
    expect.arrayContaining([
      'Sessions',
      '4 live · 1 waits for you',
      '"wait" - the session finished its work and stands until you write to it; switch to it in the session list',
      '● this one',
      'app · research/123',
      'Mod 0 · 45%',
      '◌ wait 15m',
      '71%',
      'trial · fix/123',
      'new · feat/rel',
      'asks: Rescore done: +0.004 score. Publish the delta?',
      '1 runner',
      '● working',
      'working on: "Check CI on #125"',
      '○ idle',
      '⚠ this folder is open in another session too',
      'Ask for a report',
      'Summarize this session',
    ]),
  )
  expect(texts.indexOf('● this one')).toBeLessThan(texts.indexOf('◌ wait 15m'))
  expect(texts.indexOf('◌ wait 15m')).toBeLessThan(texts.indexOf('● working'))
  expect(texts.indexOf('● working')).toBeLessThan(texts.indexOf('○ idle'))
  expect(texts).not.toContain('old')
  // One line on what each session does or waits for: no prompt quoted as a name, no task of a waiting one, no bar.
  expect(texts).not.toContain('Rescore #123 · 80%')
  expect(texts).not.toContain('no task')
  expect(texts.join(' ')).not.toMatch(/[█░]/)
  expect((await ui.find({ type: 'Text', text: '◌ wait 15m' }))?.props.color).toBe('warning')

  await ui.press({ key: 'report:sess-a' })
  expect(world.sent).toHaveLength(1)
  expect(String(world.sent[0]?.to)).toContain('sess-a')
  expect(world.sent[0]?.text).toContain('what are you doing now')
  expect(world.toasts).toEqual(['Report requested: trial'])
})

test('a session that worked a while and came to rest is announced once, with one sound per machine', { plugins: [BAND_ROW] }, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const world = answerWorld(on, clock)
  world.write(`${REGISTRY}/sess-a.json`, card('sess-a', '/work/trial', { task: { title: 'Rescore #123', percent: 80 }, turn: { isWorking: true, since: NOW - 5 * MINUTE } }))
  world.write(`${REGISTRY}/sess-b.json`, card('sess-b', '/work/quick', { turn: { isWorking: true, since: NOW - 10_000 } }))
  await $.session.start({ cwd: '/work/app', surface: 'desktop', isInteractive: true })

  await clock.advance(10_000)
  world.write(
    `${REGISTRY}/sess-a.json`,
    card('sess-a', '/work/trial', {
      updatedAt: clock.now(),
      task: { title: 'Rescore #123', percent: 100 },
      turn: { isWorking: false, since: clock.now() },
      said: 'Publish the delta on #123?',
      ending: 'answer',
    }),
  )
  world.write(`${REGISTRY}/sess-b.json`, card('sess-b', '/work/quick', { updatedAt: clock.now(), turn: { isWorking: false, since: clock.now() } }))
  await clock.advance(15_000)
  expect(world.toasts).toEqual(['◌ trial "Rescore #123" finished and waits for you - asks: Publish the delta on #123?'])
  expect(world.played).toEqual(['sounds/waiting.aiff'])

  await clock.advance(15_000)
  expect(world.toasts).toHaveLength(1)
})

test('the first prompt after half an hour away names the sessions that finished meanwhile, says what runners did, and opens the list', { plugins: [BAND_ROW] }, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const world = answerWorld(on, clock)
  await $.session.start({ cwd: '/work/app', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'first', wait: false, origin: { kind: 'composer' } })

  await clock.advance(40 * MINUTE)
  const now = clock.now()
  world.write(
    `${REGISTRY}/sess-a.json`,
    card('sess-a', '/work/trial', {
      updatedAt: now,
      turn: { isWorking: false, since: now - MINUTE },
      asked: 'Rescore #123',
      runners: [
        { id: 'b1', status: 'completed', description: 'job 1', endedAt: now - 5 * MINUTE },
        { id: 'b2', status: 'failed', description: 'job 2', endedAt: now - 3 * MINUTE },
        { id: 'b3', status: 'completed', description: 'earlier', endedAt: NOW - 5 * MINUTE },
      ],
    }),
  )
  // A second session in the same folder: counted by the folder, not quoted by its prompt.
  world.write(`${REGISTRY}/sess-d.json`, card('sess-d', '/work/trial', { updatedAt: now, turn: { isWorking: false, since: now - 2 * MINUTE }, asked: 'Так, зливай обидва', said: 'Merged both.' }))
  // Resting since before the absence, or never run: not news, not named.
  world.write(`${REGISTRY}/sess-b.json`, card('sess-b', '/work/early', { updatedAt: now, turn: { isWorking: false, since: NOW - 5 * MINUTE } }))
  world.write(`${REGISTRY}/sess-c.json`, card('sess-c', '/work/new', { updatedAt: now, turn: { isWorking: false, since: 0 } }))
  const ui = await $.ui.mount({ plugin: 'mod-sessions', surface: 'desktop', ...BAND })
  await $.prompt.submit({ text: 'back', wait: false, origin: { kind: 'composer' } })
  // One line: who waits, by folder, then what the runners did; no prompt quoted.
  expect(world.toasts).toContain('2 sessions wait for you: trial ×2 · 1 runner done · 1 runner died. See Sessions in the band.')
  expect(world.toasts.join(' ')).not.toContain('Rescore #123')
  expect(await drawnTexts(ui)).toEqual(expect.arrayContaining(['Sessions', 'trial', 'done: Merged both.']))
})

test('the summary asks a small model for five points, shows them and copies them', { plugins: [BAND_ROW] }, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const world = answerWorld(on, clock)
  on('session.messages', () => ({
    value: [
      { role: 'user' as const, text: 'Make mod 0', toolUses: [] },
      { role: 'assistant' as const, text: 'Made the panel', toolUses: [] },
    ],
  }))
  const prompts: string[] = []
  on('model.complete', ($, e) => {
    prompts.push(e.prompt)

    return {
      value: {
        isAnswered: true as const,
        text: '- Asked for mod 0\n- Panel done\n- Doing sessions\n- Nothing blocks\n- Next Mac and git',
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    }
  })
  const copied: string[] = []
  on('ui.copy', ($, e) => {
    copied.push(e.text)

    return { value: { isCopied: true as const } }
  })
  world.write(`${REGISTRY}/sess-here.json`, card('sess-here', '/work/app', { turn: { isWorking: false, since: NOW } }))
  await $.session.start({ cwd: '/work/app', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'sessions', args: '', ...COMMAND })
  const ui = await $.ui.mount({ plugin: 'mod-sessions', surface: 'desktop', ...BAND })

  await ui.press({ key: 'summary' })
  expect(prompts[0]).toContain('User: Make mod 0')
  expect(await drawnTexts(ui)).toEqual(expect.arrayContaining(['• Asked for mod 0', '• Next Mac and git', 'Copy', 'Hide']))
  await ui.press({ key: 'summary-copy' })
  expect(copied[0]).toBe('- Asked for mod 0\n- Panel done\n- Doing sessions\n- Nothing blocks\n- Next Mac and git')
})
