import { expect, mock, test } from 'claude-code/testing'
import type { MockClock } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { TurnStepResult } from 'claude-code'

const HOME = '/home/me'
const NOW = 1_760_000_000_000

// The disk in memory, with HOME set; a file's time is the clock's when it was written.
function answerDisk(on: On, clock: MockClock, files: Map<string, string>): void {
  mock.env(on, { HOME })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'sess-here' }))
  on('fs.exists', ($, e) => ({ value: files.has(e.path) || [...files.keys()].some(path => path.startsWith(`${e.path}/`)) }))
  on('fs.read', ($, e) => {
    const text = files.get(e.path)

    return text === undefined ? { deny: `ENOENT: ${e.path}` } : { value: text }
  })
  on('fs.stat', ($, e) => (files.has(e.path) ? { value: { kind: 'file' as const, size: 1, mtimeMs: clock.now(), isLink: false } } : { deny: 'ENOENT' }))
  on('fs.list', ($, e) => ({
    value: [...files.keys()]
      .filter(path => path.startsWith(`${e.path}/`))
      .map(path => ({ name: path.slice(e.path.length + 1), kind: 'file' as const, size: 1, mtimeMs: clock.now(), isLink: false })),
  }))
}


test('a long turn gets a line beneath its answer: time, context added and tools; a short one none', async ($, on) => {
  answerDisk(on, mock.clock(on, { now: NOW }), new Map())
  const carried = [40_000, 58_000]
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('tool.call', () => ({ result: {}, text: 'ok' }))
  on('turn.step', async function* ($, e) {
    const response: TurnStepResult = {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'tool_use',
      usage: { input_tokens: 0, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: carried[e.index] ?? 0, model: e.model },
    }

    return response
  })
  const step = async (index: number) => {
    const stream = $.turn.step({ turnId: 't1', index, model: 'claude-opus-5-5', messageCount: 3 })
    for await (const _chunk of stream) {
      // drained
    }
    await stream.result
  }
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
  await step(0)
  await $.turn.start({ text: 'Fix it', turnId: 't1' })
  await $.tool.call({ tool: 'Read', file_path: '/a' })
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  await $.tool.call({ tool: 'Edit', file_path: '/a', old_string: 'a', new_string: 'b' })
  await step(1)
  const done = await $.turn.complete({ answer: 'Done.', durationMs: 130_000, isAborted: false, turnId: 't1', reason: 'answer' })
  expect(done.text).toBe('⏱ 2m 10s · +18k context · 3 tools')

  const quick = await $.turn.complete({ answer: 'Yes.', durationMs: 4_000, isAborted: false, turnId: 't2', reason: 'answer' })
  expect(quick.text).toBe('Yes.')
})
