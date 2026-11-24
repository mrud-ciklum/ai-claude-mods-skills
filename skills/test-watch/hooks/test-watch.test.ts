import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { readRun } from './register'

declare const setTimeout: (f: (v?: unknown) => void, ms: number) => unknown
const settle = () => new Promise(r => setTimeout(r, 60))

const MOD = '/work/repo/skills/demo'
// The rows draw into the band's own row (context-band), which the engine asks only of a plugin
// of that name: this stand-in hooks it and passes down to what lies beneath.
const BAND_ROW = {
  name: 'context-band',
  register: (on: On) => {
    on('ui.render', { component: 'AbovePrompt' }, ($, e, next) => next(e))
  },
}

const BAND = { plugin: 'test-watch', surface: 'desktop', component: 'AbovePrompt', props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 30, bodyColumns: 100, scroll: { offset: 0, bodyRows: 30 }, view: {} } } as const
const PANE = { plugin: 'test-watch', surface: 'desktop', component: 'Pane', requestId: 'test-watch', props: { title: 'Test watch', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } } as const
const OUTPUT = '(pass) reads a thing [3.10ms]\n(fail) writes a thing [2.00ms]\n  AssertionError: nope\n\n 1 pass\n 1 fail\nRan 2 tests across 1 file.'

function world(on: On, output: () => { exitCode: number; stdout: string }, switches?: string) {
  const runs: string[][] = []
  const state = '/home/u/.claude/mods/state.json'
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('clock.now', () => ({ value: 1_000 }))
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home/u' : e.name === 'CLAUDE_CODE_EXECPATH' ? '/bin/claude' : undefined }))
  on('fs.exists', (_, e) => ({ value: e.path === `${MOD}/.claude-plugin/plugin.json` || (e.path === state && switches !== undefined) }))
  on('fs.stat', () => ({ value: { kind: 'file', size: 80, mtimeMs: 1, isLink: false } }))
  on('fs.read', (_, e) => (e.path === state && switches !== undefined ? { value: switches } : { deny: 'no such file' }))
  on('process.run', (_, e) => {
    runs.push([...e.argv])
    const r = output()

    return { value: { exitCode: r.exitCode, stdout: r.stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('tool.call', () => ({ result: { filePath: '', oldString: '', newString: '', originalFile: '', structuredPatch: [], userModified: false, replaceAll: false } }) as never)
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('ui.open', () => ({ value: { isPlaced: true } }))

  return { runs }
}

type Caller = { tool: { call: (input: Record<string, unknown>) => Promise<unknown> }; turn: { complete: (input: never) => Promise<unknown> } }
const edit = ($: unknown, file: string) => ($ as Caller).tool.call({ tool: 'Edit', file_path: file, old_string: 'a', new_string: 'b' })
const endTurn = ($: unknown, turnId: string) => ($ as Caller).turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId, reason: 'answer' } as never)

test("after a turn that edited a mod's files, that mod's tests run once and the row shows the result", { plugins: [BAND_ROW] }, async ($, on) => {
  const w = world(on, () => ({ exitCode: 1, stdout: OUTPUT }))
  await edit($, `${MOD}/hooks/register.tsx`)
  await edit($, `${MOD}/hooks/guard.ts`)
  await edit($, '/work/repo/README.md') // in no mod
  await endTurn($, 'T1')
  await settle()
  expect(w.runs).toEqual([['/bin/claude', 'plugin', 'test', MOD]])
  const band = await $.ui.mount(BAND)
  const texts = (await band.findAll({ type: 'Text' })).map(found => found.text)
  expect(texts.slice(texts.indexOf('Tests'), texts.indexOf('Tests') + 3)).toEqual(['Tests', '1 ✗', 'demo 1/2'])
  await band.press({ key: 'tests-why' })
  await band.unmount()
  const pane = await $.ui.mount(PANE)
  expect((await pane.findAll({ type: 'Text' })).map(found => found.text)).toEqual([MOD, '✗ writes a thing'])
  await pane.unmount()
})

test('a passing run is a quiet chip with its count; a turn with no edit runs nothing', { plugins: [BAND_ROW] }, async ($, on) => {
  const w = world(on, () => ({ exitCode: 0, stdout: ' 41 pass\n 0 fail\n' }))
  await endTurn($, 'T0')
  await settle()
  expect(w.runs).toEqual([])
  await edit($, `${MOD}/README.md`)
  await endTurn($, 'T1')
  await settle()
  const band = await $.ui.mount(BAND)
  const texts = (await band.findAll({ type: 'Text' })).map(found => found.text)
  expect(texts.slice(texts.indexOf('Tests'), texts.indexOf('Tests') + 2)).toEqual(['Tests', '41 ✓'])
  expect(await band.find({ type: 'Button', key: 'tests-why' })).toBeUndefined()
  await band.unmount()
})

test('switched off in the Mods panel, nothing runs', async ($, on) => {
  const w = world(on, () => ({ exitCode: 0, stdout: '' }), JSON.stringify({ off: ['test-watch'] }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await edit($, `${MOD}/hooks/register.tsx`)
  await endTurn($, 'T1')
  await settle()
  expect(w.runs).toEqual([])
})

test("the test runner's output is read into counts and failing names", () => {
  expect(readRun(OUTPUT)).toEqual({ passed: 1, failed: 1, failures: ['writes a thing'] })
})
