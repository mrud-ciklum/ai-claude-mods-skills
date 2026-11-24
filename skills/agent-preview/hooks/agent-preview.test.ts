import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { questionOf } from './register'

type Caller = { tool: { call: (input: Record<string, unknown>) => Promise<unknown> } }

// The engine as the guard meets it: the question dialog answered with `answer` (undefined: dismissed), and the launches.
function world(on: On, answer: () => string | undefined, switches?: string) {
  const launched: string[] = []
  const asked: string[] = []
  const file = '/home/u/.claude/mods/state.json'
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home/u' : undefined }))
  on('fs.exists', (_, e) => ({ value: e.path === file && switches !== undefined }))
  on('fs.stat', () => ({ value: { kind: 'file', size: 80, mtimeMs: 1, isLink: false } }))
  on('fs.read', (_, e) => (e.path === file && switches !== undefined ? { value: switches } : { deny: 'no such file' }))
  on('tool.call', (_, e) => {
    if (e.tool === 'AskUserQuestion') {
      const question = e.questions[0]?.question ?? ''
      asked.push(question)
      const picked = answer()
      if (picked === undefined) return { deny: 'dismissed' }

      return { result: { questions: e.questions, answers: { [question]: picked } } }
    }
    launched.push(String(e.tool))

    return { result: { content: [{ type: 'text', text: 'done' }] } } as never
  })
  const call = async ($: unknown, input: Record<string, unknown>): Promise<string | undefined> => {
    const r = (await ($ as Caller).tool.call(input)) as { deny?: string; isError?: boolean; text?: string }

    return r.deny ?? (r.isError === true ? (r.text ?? 'refused') : undefined)
  }

  return { launched, asked, call }
}

const BACKGROUND = { tool: 'Agent', description: 'Survey the repo', prompt: 'Read every README and list the mods.', run_in_background: true }

test('a background agent starts only on Launch, after the question shows its prompt', async ($, on) => {
  let answer: string | undefined = 'Launch'
  const w = world(on, () => answer)
  expect(await w.call($, BACKGROUND)).toBeUndefined()
  expect(w.asked[0]).toContain('Launch this background agent: "Survey the repo"?')
  expect(w.asked[0]).toContain('Read every README and list the mods.')
  answer = "Don't launch"
  expect(await w.call($, BACKGROUND)).toContain('the user did not approve this launch')
  answer = undefined
  expect(await w.call($, BACKGROUND)).toContain('nobody approved this launch')
  expect(w.launched).toEqual(['Agent'])
})

test('a workflow is asked about too; a foreground agent and other tools go on unasked', async ($, on) => {
  const w = world(on, () => 'Launch')
  expect(await w.call($, { tool: 'Workflow', script: 'export const meta = { name: "review" }' })).toBeUndefined()
  expect(w.asked).toHaveLength(1)
  expect(await w.call($, { tool: 'Agent', description: 'Find a file', prompt: 'Where is X?' })).toBeUndefined()
  expect(await w.call($, { tool: 'Read', file_path: '/a.md' })).toBeUndefined()
  expect(w.asked).toHaveLength(1)
})

test('with "Ask for: all" in the Mods panel a foreground agent is asked about', async ($, on) => {
  const w = world(on, () => 'Launch', JSON.stringify({ off: [], modSettings: { 'agent-preview': { scope: 'all' } } }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect(await w.call($, { tool: 'Agent', description: 'Find a file', prompt: 'Where is X?' })).toBeUndefined()
  expect(w.asked).toHaveLength(1)
})

test('switched off in the Mods panel, a background agent starts unasked', async ($, on) => {
  const w = world(on, () => "Don't launch", JSON.stringify({ off: ['agent-preview'] }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect(await w.call($, BACKGROUND)).toBeUndefined()
  expect(w.asked).toEqual([])
})

test('a long prompt is cut in the question, which says how much is left out', () => {
  const q = questionOf('Agent', { description: 'Big', prompt: 'x'.repeat(2_000), run_in_background: true })
  expect(q).toContain('… (500 more characters)')
})
