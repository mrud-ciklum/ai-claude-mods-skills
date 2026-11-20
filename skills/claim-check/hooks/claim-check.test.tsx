import { expect, test } from 'claude-code/testing'
import type { ModelCompleteResult, On, SessionMessage } from 'claude-code'

import { amend, bashChanges, buildPrompt, buildSecondPrompt, citedStaleFiles, clip, collect, doubted, parseReply, SECOND, settledCount, excerpt, resolve, tokens } from './judge'
import type { Evidence } from './judge'

declare const setTimeout: (f: (v?: unknown) => void, ms: number) => unknown

// The check runs after turn.complete returns; give it a moment.
const settle = () => new Promise(r => setTimeout(r, 80))

const ANSWER =
  'The config sets retries to 5 and the timeout to 30 seconds. The limit in limits.yml is 100. ' +
  'The service is written in Go. So every caller retries five times. The team peaks at 32 people.'

// Turn 1 read limits.yml and then edited it; turn 2 read c.yml.
const MESSAGES = [
  { role: 'user', text: 'Raise the limit.', toolUses: [] },
  {
    role: 'assistant',
    text: '',
    toolUses: [
      { tool_use_id: 't1', tool: 'Read', input: { file_path: 'limits.yml' }, text: 'limit: 100' },
      { tool_use_id: 't2', tool: 'Edit', input: { file_path: 'limits.yml' }, text: 'limit: 250 written' },
    ],
  },
  { role: 'assistant', text: 'Raised.', toolUses: [] },
  { role: 'user', text: 'What does the config say? The service is written in Go.', toolUses: [] },
  { role: 'assistant', text: 'Reading the config first.', toolUses: [{ tool_use_id: 't3', tool: 'Read', input: { file_path: 'c.yml' }, text: 'retries: 5\ntimeout: 60' }] },
  { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 't3', text: 'retries: 5', isError: false }] },
  { role: 'assistant', text: ANSWER, toolUses: [] },
] as SessionMessage[]

const MEMORY: Evidence[] = [
  { ref: 'M1', kind: 'memory', label: 'memory note team.md', full: 'team deck settled on 32 talents at peak', isCurrent: false, turnsAgo: 0, ageDays: 41 },
]

const JUDGED = JSON.stringify({
  claims: [
    { claim: 'retries is 5', support: 'direct', ref: 'E3', quote: 'retries: 5', volatile: true, check: '' },
    { claim: 'timeout is 30 seconds', support: 'contradicted', ref: 'E3', quote: 'timeout: 60', volatile: true, check: 'Read c.yml' },
    { claim: 'the limit is 100', support: 'direct', ref: 'E1', quote: 'limit: 100', volatile: true, check: 'Read limits.yml again' },
    { claim: 'the service is written in Go', support: 'direct', ref: 'U', quote: 'The service is written in Go', volatile: false, check: '' },
    { claim: 'every caller retries five times', support: 'inferred', ref: 'E3', quote: 'retries: 5', volatile: true, check: 'Grep the callers' },
    { claim: 'The team peaks at 32 people', support: 'direct', ref: 'M1', quote: '32 talents at peak', volatile: true, check: 'Open the team deck' },
    { claim: 'the config was validated', support: 'direct', ref: 'E3', quote: 'validation passed', volatile: false, check: 'Run the validator' },
    { claim: 'the deploy is green', support: 'none', ref: '', quote: '', volatile: true, check: 'Check CI' },
  ],
  assumptions: [{ claim: 'c.yml is the config the service loads', check: 'Find where the service reads its config' }],
})

test('the code, not the judge, decides where a claim stands', async () => {
  const { tools, user, answer } = collect(MESSAGES, ANSWER)
  expect(answer).toContain('Reading the config first.') // mid-turn text is checked too
  expect(tools.map(e => [e.ref, e.isCurrent, e.staleBy])).toEqual([
    ['E1', false, 'E2'], // read, then edited: stale
    ['E2', false, undefined],
    ['E3', true, undefined],
  ])

  const claims = resolve(JUDGED, [...tools, ...MEMORY, user])
  expect(claims?.map(c => c.verdict)).toEqual([
    'backed',
    'contradicted',
    'stale', // rests on the read made before the edit
    'earlier', // the user said it
    'inferred',
    'stale', // a 41-day-old note about a number that changes
    'unverified', // the judge's quote is not in E3
    'unverified',
    'assumed',
  ])
  expect(claims?.[6]?.source).toContain('its quote is not in there')
  expect(claims?.[2]?.source).toContain('read before a later change (E2)')

  // The file changed, but the quoted line is still in it: not stale.
  expect(citedStaleFiles(JUDGED, [...tools, ...MEMORY, user])).toEqual(['limits.yml'])
  const kept = resolve(JUDGED, [...tools, ...MEMORY, user], new Map([['limits.yml', 'name: x\nlimit: 100\n']]))
  expect(kept?.[2]?.verdict).toBe('earlier')
  expect(kept?.[2]?.source).toContain('the file changed later (E2) but this line is still in it')
  // The line is gone from the file: stale.
  const gone = resolve(JUDGED, [...tools, ...MEMORY, user], new Map([['limits.yml', 'limit: 250\n']]))
  expect(gone?.[2]?.verdict).toBe('stale')
})

test('a reply that is cut off, wrapped in prose or partly broken still yields its whole claims', async () => {
  const one = '{"c":"retries is 5","s":"d","r":"E3","q":"retries: 5","v":1,"k":""}'
  const two = '{"c":"timeout is 30 seconds","s":"x","r":"E3","q":"timeout: 60","v":1,"k":"Read c.yml"}'
  const cut = `Here is the audit {as asked}:\n{"claims":[${one},${two},{"c":"the deploy is gr`
  expect(parseReply(cut)?.claims).toHaveLength(2)
  expect(parseReply(cut)?.isCut).toBe(true)

  const broken = `{"claims":[${one},{"c":"bad "quote" here","s":"d"},${two}],"assumptions":[{"c":"c.yml is the live config","k":"Find the loader"}]}`
  const parsed = parseReply(broken)
  expect([parsed?.claims.length, parsed?.assumptions.length, parsed?.isCut]).toEqual([2, 1, false])

  expect(parseReply('{"claims":[],"assumptions":[]}')?.claims).toHaveLength(0) // nothing to check is an answer
  expect(parseReply('{"ok":9,"claims":[],"assumptions":[]}')?.claims).toHaveLength(0) // all settled is an answer too
  expect(settledCount('{"ok":9,"claims":[]}')).toBe(9)
  expect(parseReply('I could not find any evidence.')).toBeNull()
  expect(parseReply('{"claims":[{"c":"cut before the first')).toBeNull()

  const { tools, user } = collect(MESSAGES, ANSWER)
  expect(resolve(cut, [...tools, user])?.map(c => c.verdict)).toEqual(['backed', 'contradicted'])
})

test('a shell command that changes a file makes earlier reads of it stale', async () => {
  expect(bashChanges("cd /repo && sed -i '' 's/1/2/' a.yml && echo done > b.json")).toEqual(['/repo/a.yml', '/repo/b.json'])
  expect(bashChanges("python3 - <<'EOF'\nopen('src/c.ts','w').write('x')\nEOF")).toEqual(['src/c.ts'])
  expect(bashChanges('cp d.ts backup.ts && cat d.ts | grep x')).toEqual(['backup.ts'])
  expect(bashChanges('mv $OUT/old.md ./new.md')).toEqual(['old.md', 'new.md'])
  expect(bashChanges('git stash && npm test')).toEqual(['*'])
  // Reading is not changing.
  expect(bashChanges('sed -n 1,5p a.yml; grep -i foo a.yml > /dev/null; cat a.yml 2>&1 | head -3')).toEqual([])
  expect(bashChanges("node -e 'console.log(require(\"./package.json\").version)'")).toEqual([])

  const use = (id: number, tool: string, input: Record<string, unknown>) => ({ tool_use_id: `t${id}`, tool, input, text: 'out' })
  const msgs = [
    { role: 'user', text: 'Go.', toolUses: [] },
    {
      role: 'assistant',
      text: '',
      toolUses: [
        use(1, 'Read', { file_path: '/repo/a.yml' }),
        use(2, 'Bash', { command: 'cat /repo/b.json' }),
        use(3, 'Read', { file_path: '/repo/keep.md' }),
        use(4, 'Bash', { command: "cd /repo && sed -i '' 's/1/2/' a.yml && echo done > b.json" }),
        use(5, 'Read', { file_path: '/repo/src/c.ts' }),
        use(6, 'Bash', { command: "python3 - <<'EOF'\nopen('src/c.ts','w').write('x')\nEOF" }),
        use(7, 'Read', { file_path: '/repo/d.ts' }),
        use(8, 'Bash', { command: 'cp d.ts backup.ts && cat d.ts | grep x' }),
      ],
    },
  ] as SessionMessage[]

  // A recap or a plan is the assistant's own words: never evidence.
  const recap = [...msgs, { role: 'assistant', text: '', toolUses: [use(20, 'mcp__ccd_turn__wrap_up', { recap: 'All tests pass.' }), use(21, 'Bash', { command: 'npm test' })] }] as SessionMessage[]
  expect(collect(recap, 'x').tools.map(e => e.label).filter(l => /wrap_up|npm test/.test(l))).toEqual(['Bash npm test'])

  const stale = (list: SessionMessage[]) => collect(list, 'x').tools.map(e => e.staleBy)
  expect(stale(msgs)).toEqual(['E4', 'E4', undefined, undefined, 'E6', undefined, undefined, undefined])

  // A git command that rewrites the tree makes every file read before it stale.
  const after = [...msgs, { role: 'assistant', text: '', toolUses: [use(9, 'Bash', { command: 'git checkout .' })] }] as SessionMessage[]
  expect(stale(after)).toEqual(['E4', 'E4', 'E9', undefined, 'E6', undefined, 'E9', undefined, undefined])

  // The folder a command moved to, a variable it set and the home folder make its names
  // full paths: a file of the same name in another folder is not the one changed.
  expect(bashChanges('S=/tmp/probe; cat > "$S/hooks/register.tsx" <<EOF')).toEqual(['/tmp/probe/hooks/register.tsx'])
  expect(bashChanges('cd ~/mods && echo x > a.ts', '/Users/u')).toEqual(['/Users/u/mods/a.ts'])
  const twins = [
    { role: 'user', text: 'Go.', toolUses: [] },
    {
      role: 'assistant',
      text: '',
      toolUses: [
        use(1, 'Read', { file_path: '/Users/u/.claude/skills/mod-limits/hooks/register.tsx' }),
        use(2, 'Bash', { command: 'cd ~/.claude/skills && grep -n MOD_ORDER mod-limits/hooks/register.tsx' }),
        use(3, 'Bash', { command: 'cat /tmp/probe/hooks/register.tsx' }),
        use(4, 'Bash', { command: "S=/tmp/probe\ncat > \"$S/hooks/register.tsx\" <<'EOF'\nx\nEOF" }),
      ],
    },
  ] as SessionMessage[]
  expect(collect(twins, 'x', '/Users/u').tools.map(e => e.staleBy)).toEqual([undefined, undefined, 'E4', undefined])
})

test('a long output keeps the lines the answer speaks of', async () => {
  const long = Array.from({ length: 2_000 }, (_, i) => `row ${i} filler filler filler`).join('\n') + '\nretries: 5\n'
  const cut = excerpt(long, tokens('It sets retries: 5 in c.yml'), 1_500)
  expect(cut.length).toBeLessThan(1_600)
  expect(cut).toContain('retries: 5')

  // A long single line (a JSON row) keeps the part the answer speaks of, wherever it sits.
  const row = `{"at":"2026-11-18","pad":"${'x'.repeat(600)}","promptChars":16636,"more":"${'y'.repeat(300)}"}`
  const kept = clip(row, tokens('The prompt was 16636 characters'))
  expect(kept.length).toBeLessThan(420)
  expect(kept).toContain('"promptChars":16636')
  expect(clip('short line', ['x'])).toBe('short line')

  const { tools, user } = collect(MESSAGES, ANSWER)
  const prompt = buildPrompt({ answer: ANSWER, tools, memory: MEMORY, user, today: '2026-11-18' })
  expect(prompt).toContain('[E1 | Read limits.yml | 1 turn(s) ago | STALE: the file was changed later (E2)]')
  expect(prompt).toContain('[M1 | memory note team.md | 41 days old]')
  expect(prompt).toContain('<today>2026-11-18</today>')

  // A session with far more evidence than the budget still gives the judge a bounded read.
  const big = Array.from({ length: 400 }, (_, i) => `line ${i} limits.yml retries timeout 100 filler filler filler filler`).join('\n')
  const many = [
    ...Array.from({ length: 60 }, (_, i) => ({ ...tools[0]!, ref: `E${i + 10}`, isCurrent: false, full: big })),
    ...Array.from({ length: 40 }, (_, i) => ({ ...tools[2]!, ref: `E${i + 100}`, isCurrent: true, full: `${big}\nretries: 5` })),
  ]
  const notes = Array.from({ length: 10 }, (_, i) => ({ ...MEMORY[0]!, ref: `M${i + 2}`, full: big }))
  const bounded = buildPrompt({ answer: ANSWER, tools: many, memory: notes, user: { ...user, full: big }, today: '2026-11-18' })
  expect(bounded.length).toBeLessThan(62_000)
  expect(bounded).toContain('retries: 5') // the tail of a current call survives the cut
})

const BAND = {
  plugin: 'claim-check',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 3, bodyColumns: 160, scroll: { offset: 0, bodyRows: 3 }, view: {} },
} as const

const reply = (text: string) => ({ value: { isAnswered: true, text, usage: { input_tokens: 1, output_tokens: 1 } } as ModelCompleteResult })

test('with auto-correction on, a contradiction is corrected once, unasked; the rest waits for Verify or the next prompt', { options: { autoCorrect: true } }, async ($, on) => {
  const sent: string[] = []
  let checks = 0
  on('clock.now', () => ({ value: Date.parse('2026-11-18') }))
  on('session.messages', () => ({ value: MESSAGES }))
  on('model.complete', () => {
    checks++
    return reply(JUDGED)
  })
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('prompt.submit', (_, e) => {
    sent.push(e.text)
    return { text: e.text, context: e.context }
  })

  const turn = (turnId: string) => $.turn.complete({ answer: ANSWER, durationMs: 1, isAborted: false, turnId, reason: 'answer' })
  await turn('T1')
  await settle()
  expect(sent).toHaveLength(1)
  expect(sent[0]).toContain('[contradicted] timeout is 30 seconds')

  // The correction's own turn is checked too, and sends no second correction.
  await turn('T2')
  await settle()
  expect(sent).toHaveLength(1)
  expect(checks).toBe(2)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect((await ui.find({ type: 'Text', text: /1 contradicted/ }))?.text).toContain('1 stale')
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'verify' })
  await ui.unmount()
  expect(sent).toHaveLength(2)
  expect(sent[1]).toContain('[inferred] every caller retries five times')
  expect(sent[1]).toContain('To check: Grep the callers')

  // Verify already handed them over: the person's next prompt carries nothing.
  const next = await $.prompt.submit({ text: 'next', wait: false, origin: { kind: 'composer' } })
  expect(next.context ?? []).toHaveLength(0)
})

const PANE = {
  plugin: 'claim-check',
  component: 'Pane',
  requestId: 'claim-check',
  props: { title: 'Claim check', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

test('Dig sends one claim with the method, once; in a project with a dig skill it names the skill', async ($, on) => {
  const sent: string[] = []
  let hasSkill = false
  on('clock.now', () => ({ value: Date.parse('2026-11-18') }))
  on('env.get', () => ({ value: '/home/u' }))
  on('session.cwd', () => ({ value: '/work' }))
  on('fs.exists', (_, e) => ({ value: hasSkill && e.path === '/work/.claude/skills/dig/SKILL.md' }))
  on('session.messages', () => ({ value: MESSAGES }))
  on('model.complete', () => reply(JUDGED))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('prompt.submit', (_, e) => {
    sent.push(e.text)
    return { text: e.text, context: e.context }
  })

  await $.turn.complete({ answer: ANSWER, durationMs: 1, isAborted: false, turnId: 'T1', reason: 'answer' })
  await settle()
  expect(sent).toHaveLength(0) // auto-correction is off by default: a contradiction sends nothing

  let ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Button', key: 'dig-0' })).toBeUndefined() // backed: nothing to dig
  await ui.press({ key: 'dig-4' }) // the inferred claim
  await ui.unmount()
  expect(sent).toHaveLength(1)
  expect(sent[0]).toContain('[inferred] every caller retries five times')
  expect(sent[0]).toContain('cannot change state')
  expect(sent[0]).toContain('correct it at that source')
  expect(sent[0]).toContain('Next probe')

  ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Button', key: 'dig-4' })).toBeUndefined() // dug once, the button is gone
  hasSkill = true
  await ui.press({ key: 'dig-7' }) // the unverified deploy claim
  await ui.unmount()
  expect(sent[1]).toContain('[unverified] the deploy is green')
  expect(sent[1]).toContain('invoke it with the Skill tool')
  expect(sent[1]).not.toContain('Next probe')
})

test('memory is found from the folder the session started in, after the working folder moved below it', async ($, on) => {
  let asked = ''
  const index = '/home/u/.claude/projects/-work/memory/MEMORY.md'
  on('clock.now', () => ({ value: Date.parse('2026-11-18') }))
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home/u' : undefined }))
  on('session.cwd', () => ({ value: '/work/sub/deep' }))
  on('fs.exists', (_, e) => ({ value: e.path === index }))
  on('fs.read', (_, e) => (e.path === index ? { value: '- [Team size](team.md) — 32 talents at peak' } : { deny: 'no such file' }))
  on('fs.list', () => ({ value: [] }))
  on('session.messages', () => ({ value: MESSAGES }))
  on('model.complete', (_, e) => {
    asked = e.prompt
    return reply('{"ok":1,"claims":[]}')
  })
  on('turn.complete', (_, e) => ({ text: e.answer }))

  await $.turn.complete({ answer: ANSWER, durationMs: 1, isAborted: false, turnId: 'T1', reason: 'answer' })
  await settle()
  expect(asked).toContain('memory index MEMORY.md')
  expect(asked).toContain('32 talents at peak')
})

test('with no contradiction, the flagged claims ride on the next prompt once', async ($, on) => {
  // The fast format: settled claims counted, only the rest listed.
  const calm =
    '{"ok":7,"claims":[{"c":"the log has 3 lines","s":"n","r":"","q":"","v":0,"p":3},{"c":"the deploy is green","s":"n","r":"","q":"","v":1,"p":1}],' +
    '"assumptions":[{"c":"CI ran on this commit","p":2},{"c":"the tag points at this commit","p":1}]}'
  on('clock.now', () => ({ value: Date.parse('2026-11-18') }))
  on('session.messages', () => ({ value: MESSAGES }))
  on('model.complete', () => reply(calm))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('prompt.submit', (_, e) => ({ text: e.text, context: e.context }))

  await $.turn.complete({ answer: ANSWER, durationMs: 1, isAborted: false, turnId: 'T1', reason: 'answer' })
  await settle()

  const first = await $.prompt.submit({ text: 'next', wait: false, origin: { kind: 'composer' } })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const row = (await ui.find({ type: 'Text', text: /unverified/ }))?.text
  expect(row).toContain('▲ 2 key')
  expect(row).toContain('? 2 unverified')
  expect(row).toContain('∴ 2 assumed')
  expect(row).toContain('✓ 7 backed')
  // The second line: the key claim is the one shown, though the judge listed it second.
  const detail = await ui.find({ type: 'Text', text: /deploy is green/ })
  // The time first, then the claim: the judge's reading, unquoted, as the answer has no words for it.
  expect(detail?.text).toBe('0 s · unverified, key: the deploy is green')
  expect(detail?.props.dimColor).toBe(true)
  await ui.unmount()

  expect(first.context?.join('\n')).toContain('[unverified, key] the deploy is green')
  expect(first.context?.join('\n')).not.toContain('the log has 3 lines') // a minor detail stays in the pane
  // An assumption rides only when key: the rest wait in the pane.
  expect(first.context?.join('\n')).toContain('[assumed, key] the tag points at this commit')
  expect(first.context?.join('\n')).not.toContain('CI ran on this commit')
  const second = await $.prompt.submit({ text: 'again', wait: false, origin: { kind: 'composer' } })
  expect(second.context ?? []).toHaveLength(0)
})

test('switched off in the Mods panel, it checks nothing, shows no row and adds nothing to the next prompt', async ($, on) => {
  const switches = '/home/u/.claude/mods/state.json'
  let calls = 0
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('clock.now', () => ({ value: Date.parse('2026-11-18') }))
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home/u' : undefined }))
  on('fs.exists', (_, e) => ({ value: e.path === switches }))
  on('fs.stat', () => ({ value: { kind: 'file', size: 40, mtimeMs: 1, isLink: false } }))
  on('fs.read', (_, e) => (e.path === switches ? { value: '{"off":["claim-check"]}' } : { deny: 'no such file' }))
  on('session.messages', () => ({ value: MESSAGES }))
  on('model.complete', () => {
    calls++
    return reply('{"ok":1,"claims":[{"c":"the deploy is green","s":"n","r":"","q":"","v":1,"p":1}]}')
  })
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('prompt.submit', (_, e) => ({ text: e.text, context: e.context }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.complete({ answer: ANSWER, durationMs: 1, isAborted: false, turnId: 'T1', reason: 'answer' })
  await settle()
  expect(calls).toBe(0)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Checking|unverified|backed/ })).toBeUndefined()
  await ui.unmount()

  const next = await $.prompt.submit({ text: 'next', wait: false, origin: { kind: 'composer' } })
  expect(next.context ?? []).toHaveLength(0)
})

test('a short answer is not checked', async ($, on) => {
  let calls = 0
  on('model.complete', () => {
    calls++
    return reply('{"claims":[]}')
  })
  on('turn.complete', (_, e) => ({ text: e.answer }))

  await $.turn.complete({ answer: 'Done.', durationMs: 1, isAborted: false, turnId: 'T2', reason: 'answer' })
  await settle()
  expect(calls).toBe(0)
})

test('the row is two lines: the counts with Verify and Details at their right end, then the top claim small and dim', async ($, on) => {
  const one = '{"ok":3,"claims":[{"c":"the deploy is green","s":"n","r":"","q":"","v":1,"p":1}]}'
  on('clock.now', () => ({ value: Date.parse('2026-11-18') }))
  on('session.messages', () => ({ value: MESSAGES }))
  on('model.complete', () => reply(one))
  on('turn.complete', (_, e) => ({ text: e.answer }))

  await $.turn.complete({ answer: ANSWER, durationMs: 1, isAborted: false, turnId: 'T1', reason: 'answer' })
  await settle()

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect((await ui.find({ type: 'Button', key: 'verify' }))?.props.variant).toBeUndefined()
    expect((await ui.find({ type: 'Button', key: 'details' }))?.props.dimColor).toBe(true)
    const drawn = JSON.stringify(await ui.drawn())
    // The buttons close line one; the claim is on line two.
    expect(drawn.indexOf('"details"')).toBeGreaterThan(-1)
    expect(drawn.indexOf('"details"')).toBeLessThan(drawn.indexOf('deploy is green'))
    if (surface === 'desktop') {
      expect((await ui.find({ type: 'Text', text: /deploy is green/ }))?.props.size).toBe('footnote')
    }
    await ui.unmount()
  }
})

// Another plugin's row in the band, standing for the readings line (context-band).
const READINGS_ROW = {
  name: 'context-band',
  register: (on: On) => {
    on('ui.render', { component: 'AbovePrompt' }, async ($, e) => {
      const { Text } = $.ui.resolve(e)
      return <Text>Context 30%</Text>
    })
  },
}

test('in the band every other row comes first, the readings line on top, and this row last', { plugins: [READINGS_ROW] }, async ($, on) => {
  on('clock.now', () => ({ value: Date.parse('2026-11-18') }))
  on('session.messages', () => ({ value: MESSAGES }))
  on('model.complete', () => reply('{"ok":3,"claims":[{"c":"the deploy is green","s":"n","r":"","q":"","v":1,"p":1}]}'))
  on('turn.complete', (_, e) => ({ text: e.answer }))

  await $.turn.complete({ answer: ANSWER, durationMs: 1, isAborted: false, turnId: 'T1', reason: 'answer' })
  await settle()

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const texts = (await ui.findAll({ type: 'Text' })).map(found => found.text)
  expect(texts[0]).toBe('Context 30%')
  expect(texts[texts.length - 1]).toContain('deploy is green')
  await ui.unmount()
})

test("an answer to Verify is not checked again; the person's next answer is", async ($, on) => {
  let checks = 0
  on('clock.now', () => ({ value: Date.parse('2026-11-18') }))
  on('session.messages', () => ({ value: MESSAGES }))
  on('model.complete', () => {
    checks++
    return reply('{"ok":3,"claims":[{"c":"the deploy is green","s":"n","r":"","q":"","v":1,"p":1}]}')
  })
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('prompt.submit', (_, e) => ({ text: e.text, context: e.context }))

  const turn = (turnId: string) => $.turn.complete({ answer: ANSWER, durationMs: 1, isAborted: false, turnId, reason: 'answer' })
  await turn('T1')
  await settle()
  expect(checks).toBe(1)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'verify' })
  await ui.unmount()
  await turn('T2') // the answer to Verify
  await settle()
  expect(checks).toBe(1)
  const after = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await after.find({ type: 'Text', text: /deploy is green/ }))?.text).toContain('the deploy is green') // the verified check stays
  expect(await after.find({ type: 'Button', key: 'verify' })).toBeUndefined() // already handed over
  await after.unmount()

  await $.prompt.submit({ text: 'next', wait: false, origin: { kind: 'composer' } })
  await turn('T3')
  await settle()
  expect(checks).toBe(2)
})

test('an answer in another script yields its words as well', () => {
  expect(tokens('Перевірив порядок рядків у модах: Context першим, 5h другим.')).toEqual(['Перевірив', 'порядок', 'рядків', 'Context', 'першим', 'другим'])
  // The line that holds them is the one a long output keeps.
  const long = Array.from({ length: 2_000 }, (_, i) => `рядок ${i} заповнювач`).join('\n') + '\nпорядок: Context першим\n'
  expect(excerpt(long, tokens('Порядок такий: Context першим'), 600)).toContain('порядок: Context першим')
})

// A session whose switches file holds `text`, at HOME /home/u.
function switchesFile(on: On, text: string | undefined) {
  const switches = '/home/u/.claude/mods/state.json'
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home/u' : undefined }))
  on('fs.exists', (_, e) => ({ value: text !== undefined && e.path === switches }))
  on('fs.stat', () => ({ value: { kind: 'file', size: 80, mtimeMs: 1, isLink: false } }))
  on('fs.read', (_, e) => (text !== undefined && e.path === switches ? { value: text } : { deny: 'no such file' }))
}

test('the judge runs on the model and effort picked in the Mods panel, and the pane names them', async ($, on) => {
  let asked: { model: string; effort?: string } | undefined
  switchesFile(on, JSON.stringify({ off: [], modSettings: { 'claim-check': { model: 'fable', effort: 'high' } } }))
  on('clock.now', () => ({ value: Date.parse('2026-11-18') }))
  on('session.messages', () => ({ value: MESSAGES }))
  on('model.complete', (_, e) => {
    asked = { model: e.model, effort: e.effort }
    return reply('{"ok":3,"claims":[{"c":"the deploy is green","s":"n","r":"","q":"","v":1,"p":1}]}')
  })
  on('turn.complete', (_, e) => ({ text: e.answer }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.complete({ answer: ANSWER, durationMs: 1, isAborted: false, turnId: 'T1', reason: 'answer' })
  await settle()
  expect(asked).toEqual({ model: 'fable', effort: 'high' })

  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await pane.find({ type: 'Text', text: /The judge was/ }))?.text).toContain('The judge was fable at high effort.')
  await pane.unmount()
})

test('with nothing picked, or an effort that is not a level, the judge is sonnet at low effort', async ($, on) => {
  let asked: { model: string; effort?: string } | undefined
  switchesFile(on, JSON.stringify({ off: [], modSettings: { 'claim-check': { effort: 'turbo' } } }))
  on('clock.now', () => ({ value: Date.parse('2026-11-18') }))
  on('session.messages', () => ({ value: MESSAGES }))
  on('model.complete', (_, e) => {
    asked = { model: e.model, effort: e.effort }
    return reply('{"ok":3,"claims":[]}')
  })
  on('turn.complete', (_, e) => ({ text: e.answer }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.complete({ answer: ANSWER, durationMs: 1, isAborted: false, turnId: 'T1', reason: 'answer' })
  await settle()
  expect(asked).toEqual({ model: 'sonnet', effort: 'low' })
})

test("the answer's own words for a claim are kept only where they are in the answer", () => {
  const { tools, user, answer } = collect(MESSAGES, ANSWER)
  const reply = JSON.stringify({
    claims: [
      { c: 'the timeout is 30 s', a: 'the  timeout to 30 seconds', s: 'x', r: 'E3', q: 'timeout: 60', v: 1, p: 1 },
      { c: 'the deploy is green', a: 'the deploy is green now', s: 'n', r: '', q: '', v: 1, p: 1 },
      { c: 'callers retry', a: '', s: 'i', r: 'E3', q: 'retries: 5', v: 1, p: 2 },
    ],
  })
  // Whitespace is evened out; words the answer does not hold are dropped.
  expect(resolve(reply, [...tools, user], undefined, answer)?.map(c => c.said)).toEqual(['the timeout to 30 seconds', undefined, undefined])
  // Without the answer nothing is quoted.
  expect(resolve(reply, [...tools, user])?.map(c => c.said)).toEqual([undefined, undefined, undefined])
})

test("the row and the pane quote the answer's own words; the pane says what each mark means", async ($, on) => {
  const quoted = '{"ok":2,"claims":[{"c":"all callers retry 5 times","a":"every caller retries five times","s":"i","r":"E3","q":"retries: 5","v":1,"p":1}]}'
  on('clock.now', () => ({ value: Date.parse('2026-11-18') }))
  on('session.messages', () => ({ value: MESSAGES }))
  on('model.complete', () => reply(quoted))
  on('turn.complete', (_, e) => ({ text: e.answer }))

  await $.turn.complete({ answer: ANSWER, durationMs: 1, isAborted: false, turnId: 'T1', reason: 'answer' })
  await settle()

  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await band.find({ type: 'Text', text: /every caller/ }))?.text).toBe('0 s · inferred, key: "every caller retries five times"')
  await band.unmount()

  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const texts = (await pane.findAll({ type: 'Text' })).map(found => found.text)
  expect(texts).toContain('≈ inferred key "every caller retries five times"')
  expect(texts).toContain("  The judge's reading: all callers retry 5 times")
  expect(texts).toContain('What the marks mean')
  expect(texts).toContain('✗ contradicted  the evidence says otherwise')
  expect(texts).toContain('▲ key  you are likely to act on it; minor: an incidental detail')
  await pane.unmount()
})

test('a check the mod reloaded in the middle of says so calmly, not as a failure', async ($, on) => {
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('clock.now', () => ({ value: Date.parse('2026-11-18') }))
  on('session.messages', () => ({ value: MESSAGES }))
  on('model.complete', () => new Promise(() => undefined) as never) // the judge never answers: the check stays in flight
  on('turn.complete', (_, e) => ({ text: e.answer }))

  await $.turn.complete({ answer: ANSWER, durationMs: 1, isAborted: false, turnId: 'T1', reason: 'answer' })
  await settle()
  const before = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await before.find({ type: 'Text' }))?.text).toBe('Checking claims…')
  await before.unmount()

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true }) // what a reload runs
  const after = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const text = (await after.find({ type: 'Text' }))?.text
  expect(text).toBe('This answer was not checked: claim-check restarted before it finished, because its code had just been changed.')
  expect(text).not.toContain('failed')
  await after.unmount()
})

const SAID: Evidence = { ref: 'U', kind: 'user', label: 'you said', full: 'Clean it.', isCurrent: true, turnsAgo: 0 }

test('a long turn keeps its last calls: the checks an answer reports are the newest', () => {
  // Every line shares a word with the answer, so each call's excerpt fills its share.
  const output = Array.from({ length: 60 }, (_, i) => `published-file line ${i} nothing here filler filler filler`).join('\n')
  const calls: Evidence[] = Array.from({ length: 30 }, (_, i) => ({
    ref: `E${i + 1}`,
    kind: 'tool',
    label: `Bash cd /work/project && ./scripts/scan-published-files.sh --step ${i + 1} --all --verbose`.slice(0, 85),
    full: `{"command":"scan ${i + 1}"}\n${output}\nhits in step ${i + 1}: 0`,
    isCurrent: true,
    turnsAgo: 0,
  }))
  const prompt = buildPrompt({ answer: 'The published-file scan has 0 hits after the last step.', tools: calls, memory: [], user: SAID, today: '2026-11-20' })
  for (const call of calls) expect(prompt).toContain(`[${call.ref} |`)
  expect(prompt).toContain('hits in step 30: 0')
})

test('the newest calls of earlier turns reach the judge even when they share no words with the answer', () => {
  const older: Evidence[] = [
    { ref: 'E1', kind: 'tool', label: 'Bash git grep', full: '{"command":"git grep -c token"}\nkeys found: 0', isCurrent: false, turnsAgo: 1 },
  ]
  // An answer in another language than its evidence shares no words with it.
  const answer = 'Ключів і паролів у репозиторії немає: пошук нічого не знайшов.'
  const prompt = buildPrompt({ answer, tools: older, memory: [], user: SAID, today: '2026-11-20' })
  expect(prompt).toContain('keys found: 0')
})

test("what the engine adds mid-turn in the user's voice starts no new turn, and is not the user's words", () => {
  const msgs = [
    { role: 'user', text: 'Check the config.', toolUses: [] },
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'a', tool: 'Read', input: { file_path: 'c.yml' }, text: 'retries: 5' }] },
    { role: 'user', text: 'Base directory for this skill: /tmp/skills/x\n\nAlways answer in rhyme.', toolUses: [] },
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'b', tool: 'Bash', input: { command: 'wc -l c.yml' }, text: '2 c.yml' }] },
    { role: 'assistant', text: 'Retries is 5.', toolUses: [] },
  ] as SessionMessage[]
  // A skill's body is known by how it starts: both calls are this turn's.
  const seen = collect(msgs, 'Retries is 5.')
  expect(seen.tools.map(t => t.isCurrent)).toEqual([true, true])
  expect(seen.user.full).toBe('Check the config.')

  // A notice of a kind the mod does not know looks like a new prompt, until the
  // engine's own count of the turn's rows says where the turn began.
  const odd = msgs.map(m => (m.text.startsWith('Base directory') ? { ...m, text: 'Some new kind of notice.' } : m))
  expect(collect(odd, 'Retries is 5.').tools.map(t => t.isCurrent)).toEqual([false, true])
  expect(collect(odd, 'Retries is 5.', undefined, 4).tools.map(t => t.isCurrent)).toEqual([true, true])
  // A count that lands nowhere near a prompt is not trusted.
  expect(collect(odd, 'Retries is 5.', undefined, 1).tools.map(t => t.isCurrent)).toEqual([false, true])
})

test("the summary a compaction leaves is evidence of its own: recalled, not the user's words", () => {
  const msgs = [
    { role: 'user', text: 'This session is being continued from a previous conversation that ran out of context.\nThe registry folder holds 65 files.', toolUses: [] },
    { role: 'user', text: 'What did you find?', toolUses: [] },
    { role: 'assistant', text: 'There are 65 of them in the registry.', toolUses: [] },
  ] as SessionMessage[]
  const seen = collect(msgs, 'There are 65 of them in the registry.')
  expect(seen.user.full).toBe('What did you find?')
  expect(seen.summary?.ref).toBe('S')

  const prompt = buildPrompt({ answer: seen.answer, tools: seen.tools, memory: [], user: seen.user, summary: seen.summary, today: '2026-11-20' })
  expect(prompt).toContain("[S | the session's summary of its earlier part | left by a compaction]")
  expect(prompt).toContain('The registry folder holds 65 files.')

  // A claim only the summary states is recalled, like a note: it is not handed on as unverified.
  const judged = '{"ok":0,"claims":[{"c":"the registry holds 65 files","a":"","s":"d","r":"S","q":"registry folder holds 65 files","v":1,"p":2}]}'
  const claims = resolve(judged, [...seen.tools, seen.user, ...(seen.summary ? [seen.summary] : [])], undefined, seen.answer)
  expect(claims?.[0]?.verdict).toBe('memory')
  expect(claims?.[0]?.source).toBe('the session\'s summary of its earlier part: "registry folder holds 65 files"')
})

test('each check leaves what the judge saw in a file, to answer why a claim was flagged', async ($, on) => {
  const written = new Map<string, string>()
  on('clock.now', () => ({ value: Date.parse('2026-11-20') }))
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home/u' : undefined }))
  on('fs.read', (_, e) => (written.has(e.path) ? { value: written.get(e.path) ?? '' } : { deny: 'no such file' }))
  on('fs.write', (_, e) => {
    written.set(e.path, e.text)

    return { value: undefined }
  })
  on('session.messages', () => ({ value: MESSAGES }))
  on('model.complete', () => reply(JUDGED))
  on('turn.complete', (_, e) => ({ text: e.answer }))

  await $.turn.complete({ answer: ANSWER, durationMs: 1, isAborted: false, turnId: 'T1', reason: 'answer' })
  await settle()

  type Kept = { checks: { turnId: string; session: string; prompt: string; reply: string; claims: { verdict: string }[]; thisTurnCalls: number }[] }
  const file = '/home/u/.claude/claim-check-last.json'
  const last = (JSON.parse(written.get(file) ?? '{}') as Kept).checks[0]
  expect(last?.turnId).toBe('T1')
  expect(last?.prompt).toContain('<evidence>')
  expect(last?.reply).toBe(JUDGED)
  expect(last?.thisTurnCalls).toBe(1)
  expect(last?.claims.map(c => c.verdict)).toContain('contradicted')

  // Every session writes to the one file: the newest check comes first and the last four stay.
  for (const turnId of ['T2', 'T3', 'T4', 'T5']) {
    await $.turn.complete({ answer: ANSWER, durationMs: 1, isAborted: false, turnId, reason: 'answer' })
    await settle()
  }
  expect((JSON.parse(written.get(file) ?? '{}') as Kept).checks.map(c => c.turnId)).toEqual(['T5', 'T4', 'T3', 'T2'])
})

test('a turn is counted from the row it began at, so an unknown notice mid-turn hides no evidence from the judge', async ($, on) => {
  const answer = `Retries is 5 in c.yml and the file has two lines. ${'The rest of the config is unchanged. '.repeat(4)}`
  const msgs = [
    { role: 'user', text: 'Check the config.', toolUses: [] },
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'a', tool: 'Read', input: { file_path: 'c.yml' }, text: 'retries: 5' }] },
    { role: 'user', text: 'Some new kind of notice.', toolUses: [] },
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'b', tool: 'Bash', input: { command: 'wc -l c.yml' }, text: '2 c.yml' }] },
    { role: 'assistant', text: answer, toolUses: [] },
  ] as SessionMessage[]
  let asked = ''
  on('clock.now', () => ({ value: Date.parse('2026-11-20') }))
  // The engine's three reads: the last row as the turn starts, the rows since it, the whole transcript.
  on('session.messages', (_, e) => {
    if (e?.last === 1) return { value: [{ ...msgs[0]!, uuid: 'row-0' }] }
    if (e?.after === 'row-0') return { value: msgs.slice(1) }

    return { value: msgs }
  })
  on('model.complete', (_, e) => {
    asked = e.prompt

    return reply('{"ok":2,"claims":[]}')
  })
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))

  await $.turn.start({ text: 'Check the config.', turnId: 'T1' })
  await $.turn.complete({ answer, durationMs: 1, isAborted: false, turnId: 'T1', reason: 'answer' })
  await settle()
  expect(asked).toContain('[E1 | Read c.yml | this turn]')
  expect(asked).toContain('[E2 | Bash wc -l c.yml | this turn]')
})

test('a claim the first pass found nothing for is looked up in the whole session by its own words', () => {
  // The assistant's drafts repeat the answer's words; the one source holds its rare ones.
  const draft = `{"file_path":"/work/message.md","new_string":"The importer is a Worker in Python. Sync flows are B23, the importer is B22. Billing logic stays out. ${'Gateway platform Queue Node Cache Node Worker Python importer. '.repeat(25)}"}\nfile updated`
  const rows = Array.from({ length: 40 }, (_, i) => `${200 + i}: | filler row ${i} |`)
  rows[22] = '222: | **B22** | Importer for the nightly feed |'
  rows[23] = '223: | **B23** | Build the sync flows |'
  const tools: Evidence[] = [
    { ref: 'E1', kind: 'tool', label: 'Bash grep -n B2 roadmap.md', full: `{"command":"grep -n B2 roadmap.md"}\n${rows.join('\n')}`, isCurrent: false, turnsAgo: 3 },
    ...Array.from({ length: 10 }, (_, i): Evidence => ({ ref: `E${i + 2}`, kind: 'tool', label: 'Edit /work/message.md', full: `${draft} v${i}`, isCurrent: false, turnsAgo: 2 })),
  ]
  const answer = 'Імпортер - Worker на Python, логіка не в Billing. Platform flows: Queue Node, Cache Node, Gateway. «B22» і «B23» - Roadmap, рядки 222-223.'

  // The first pass ranks older calls by the answer's rare words, so the source is in it though each of the ten drafts shares more words with the answer.
  expect(buildPrompt({ answer, tools, memory: [], user: SAID, today: '2026-11-20' })).toContain('222: | **B22**')

  // Had the first pass still found nothing, the claim is one the code would call unverified...
  const judged =
    '{"ok":2,"claims":[{"c":"B22 and B23 labels come from Roadmap lines 222-223","a":"«B22» і «B23» - Roadmap, рядки 222-223.","s":"n","r":"","q":"","v":0,"p":2},' +
    '{"c":"the importer is a Worker","a":"","s":"d","r":"E2","q":"The importer is a Worker in Python","v":0,"p":2}]}'
  const all = [...tools, SAID]
  const doubts = doubted(judged, all)
  expect(doubts).toEqual([{ at: 0, claim: 'B22 and B23 labels come from Roadmap lines 222-223', said: '«B22» і «B23» - Roadmap, рядки 222-223.' }])

  // ...and the second look puts the source in front of the judge, cut to the claim's words.
  const again = buildSecondPrompt({ doubts, all, today: '2026-11-20' }) ?? ''
  expect(again).toContain('1. B22 and B23 labels come from Roadmap lines 222-223 (the answer\'s words: "«B22» і «B23» - Roadmap, рядки 222-223.") Passages picked for it: E1,')
  expect(again).toContain('223: | **B23** | Build the sync flows |')

  // What it finds is written into the first reply, and the code checks the quote as ever.
  const found = amend(judged, '{"claims":[{"n":1,"s":"d","r":"E1","q":"222: | **B22** | Importer for the nightly"}]}', doubts)
  const claims = resolve(found, all, undefined, answer)
  expect(claims?.[0]?.verdict).toBe('earlier')
  expect(claims?.[0]?.source).toContain('Bash grep -n B2 roadmap.md, 3 turn(s) ago')
  expect(claims?.[1]?.verdict).toBe('earlier') // the claim that had support keeps it

  // A quote that is not in the passage, or a second "nothing", leaves the claim unverified.
  const misquoted = amend(judged, '{"claims":[{"n":1,"s":"d","r":"E1","q":"lines 222 and 223 say so"}]}', doubts)
  expect(resolve(misquoted, all, undefined, answer)?.[0]?.verdict).toBe('unverified')
  expect(resolve(amend(judged, '{"claims":[{"n":1,"s":"n","r":"","q":""}]}', doubts), all, undefined, answer)?.[0]?.verdict).toBe('unverified')

  // With no passage sharing a word with the claim there is nothing to ask.
  expect(buildSecondPrompt({ doubts: [{ at: 0, claim: 'the deploy is green', said: '' }], all, today: '2026-11-20' })).toBeNull()
})

const UNSUPPORTED =
  '{"ok":3,"claims":[{"c":"the timeout in c.yml is 60 seconds","a":"","s":"n","r":"","q":"","v":1,"p":1},' +
  '{"c":"the deploy is green","a":"","s":"n","r":"","q":"","v":1,"p":2}]}'

test('the judge is asked a second time about unsupported claims alone, and the pane says what that found', async ($, on) => {
  const asked: string[] = []
  on('clock.now', () => ({ value: Date.parse('2026-11-20') }))
  on('session.messages', () => ({ value: MESSAGES }))
  on('model.complete', (_, e) => {
    asked.push(e.system === SECOND ? e.prompt : 'first')

    return reply(e.system === SECOND ? '{"claims":[{"n":1,"s":"d","r":"E3","q":"timeout: 60"},{"n":2,"s":"n","r":"","q":""}]}' : UNSUPPORTED)
  })
  on('turn.complete', (_, e) => ({ text: e.answer }))

  await $.turn.complete({ answer: ANSWER, durationMs: 1, isAborted: false, turnId: 'T1', reason: 'answer' })
  await settle()

  expect(asked).toHaveLength(2)
  expect(asked[1]).toContain('1. the timeout in c.yml is 60 seconds')
  expect(asked[1]).toContain('2. the deploy is green')
  expect(asked[1]).toContain('timeout: 60')

  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const row = (await band.find({ type: 'Text', text: /unverified/ }))?.text
  expect(row).toContain('? 1 unverified') // the deploy claim: nothing in the session speaks of it
  expect(row).toContain('✓ 4 backed') // three settled, and the one the second look found in this turn's output
  await band.unmount()

  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await pane.find({ type: 'Text', text: /It looked again/ }))?.text).toContain('for 2 claims it had found no support for, and found it for 1.')
  await pane.unmount()
})

test('a second look that fails leaves the first verdicts as they were', async ($, on) => {
  on('clock.now', () => ({ value: Date.parse('2026-11-20') }))
  on('session.messages', () => ({ value: MESSAGES }))
  on('model.complete', (_, e) => (e.system === SECOND ? { value: { isAnswered: false, reason: 'timeout' } as ModelCompleteResult } : reply(UNSUPPORTED)))
  on('turn.complete', (_, e) => ({ text: e.answer }))

  await $.turn.complete({ answer: ANSWER, durationMs: 1, isAborted: false, turnId: 'T1', reason: 'answer' })
  await settle()

  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await band.find({ type: 'Text', text: /unverified/ }))?.text).toContain('? 2 unverified')
  await band.unmount()
})
