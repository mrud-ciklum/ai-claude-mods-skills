import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { rememberPrompt, soundsLikeCorrection } from './register'

const BAND = { plugin: 'lesson-catcher', surface: 'desktop', component: 'AbovePrompt', props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 30, bodyColumns: 100, scroll: { offset: 0, bodyRows: 30 }, view: {} } } as const

function world(on: On, switches?: string) {
  const sent: string[] = []
  const file = '/home/u/.claude/mods/state.json'
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('clock.now', () => ({ value: 1_000 }))
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home/u' : undefined }))
  on('fs.exists', (_, e) => ({ value: e.path === file && switches !== undefined }))
  on('fs.stat', () => ({ value: { kind: 'file', size: 80, mtimeMs: 1, isLink: false } }))
  on('fs.read', (_, e) => (e.path === file && switches !== undefined ? { value: switches } : { deny: 'no such file' }))
  on('prompt.submit', (_, e) => {
    sent.push(e.text)

    return { text: e.text, context: e.context }
  })

  return { sent }
}

const say = ($: unknown, text: string) => ($ as { prompt: { submit: (i: never) => Promise<unknown> } }).prompt.submit({ text, wait: false, origin: { kind: 'composer' } } as never)

test('a correction brings a Remember button that has the model save it; the next prompt is not caught again', async ($, on) => {
  const w = world(on)
  await say($, 'Ти знову поставив тире, я ж просив дефіс.')
  const band = await $.ui.mount(BAND)
  expect(await band.find({ type: 'Text', text: 'Lesson' })).toBeDefined()
  await band.press({ key: 'lesson-remember' })
  expect(w.sent.at(-1)).toContain('The user just corrected you. Their words:')
  expect(w.sent.at(-1)).toContain('Ти знову поставив тире, я ж просив дефіс.')
  expect(await band.find({ type: 'Text', text: 'Lesson' })).toBeUndefined()
  await band.unmount()
})

test('Dismiss clears it, and a prompt that is no correction brings nothing', async ($, on) => {
  world(on)
  await say($, 'I already told you not to merge on GitHub.')
  const band = await $.ui.mount(BAND)
  await band.press({ key: 'lesson-dismiss' })
  expect(await band.find({ type: 'Text', text: 'Lesson' })).toBeUndefined()
  await say($, 'Now add the README, please.')
  expect(await band.find({ type: 'Text', text: 'Lesson' })).toBeUndefined()
  await band.unmount()
})

test('switched off in the Mods panel, nothing is caught', async ($, on) => {
  world(on, JSON.stringify({ off: ['lesson-catcher'] }))
  await ($ as never as { session: { start: (i: never) => Promise<unknown> } }).session.start({ cwd: '/', surface: 'desktop', isInteractive: true } as never)
  await say($, 'You did it again.')
  const band = await $.ui.mount(BAND)
  expect(await band.find({ type: 'Text', text: 'Lesson' })).toBeUndefined()
  await band.unmount()
})

test('what reads as a correction, and what does not', () => {
  for (const text of ['ти знову забув', 'Я ж казав - без тире', 'не так, переробляй', 'You again forgot the tests', "that's not what I asked", 'Why did you push?'])
    expect([text, soundsLikeCorrection(text)]).toEqual([text, true])
  for (const text of ['Так, публікуй', 'ні', 'Add a test for this', 'Не треба', 'знову запусти тести'])
    expect([text, soundsLikeCorrection(text)]).toEqual([text, false])
  expect(rememberPrompt('x')).toContain('Update an existing memory that covers it')
})
