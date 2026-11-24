import { expect, test } from 'claude-code/testing'
import type { ModelCompleteResult, On, SessionMessage } from 'claude-code'

import { amend, bashChanges, buildPrompt, buildSecondPrompt, citedStaleFiles, claimWords, clip, collect, doubted, holds, parseReply, SECOND, SECOND_BUDGET, settledCount, SYSTEM, excerpt, resolve, tokens } from './judge'
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

// The band's row (context-band) with its three slots, the readings line holding the context.
const BAND_ROW = {
  name: 'context-band',
  register: (on: On) => {
    on('ui.render', { component: 'AbovePrompt' }, async ($, e) => {
      const { Box, Text } = $.ui.resolve(e)
      return (
        <Box flexDirection="column">
          <Box key="context-band:chips" columnGap={2} flexWrap="wrap">
            <Text>Context 30%</Text>
          </Box>
          <Box key="context-band:meters" flexDirection="column" />
          <Box key="context-band:sections" flexDirection="column" />
        </Box>
      )
    })
  },
}

// The texts on screen now, in order: a card waiting hidden for the pointer is left out.
type DrawnNode = { type?: string; props?: { display?: unknown }; hover?: { scope?: unknown; display?: unknown }; children?: unknown[] }
const textsIn = (node: unknown, isShownOnly: boolean): string[] => {
  if (typeof node === 'string' || typeof node === 'number') return [String(node)]
  if (typeof node !== 'object' || node === null) return []
  const drawn = node as DrawnNode
  if (isShownOnly && drawn.props?.display === 'none') return []
  const inner = (drawn.children ?? []).flatMap(child => textsIn(child, isShownOnly))
  return drawn.type === 'Text' ? [inner.join('')] : inner
}
const cardIn = (node: unknown, scope: string): unknown => {
  if (typeof node !== 'object' || node === null) return undefined
  const drawn = node as DrawnNode
  if (drawn.props?.display === 'none' && drawn.hover?.scope === scope) return drawn
  for (const child of drawn.children ?? []) {
    const found = cardIn(child, scope)
    if (found !== undefined) return found
  }
  return undefined
}

test('with the band, the check is a chip on its line with a card under the pointer, and its own row is gone', { plugins: [BAND_ROW] }, async ($, on) => {
  on('clock.now', () => ({ value: Date.parse('2026-11-18') }))
  on('session.messages', () => ({ value: MESSAGES }))
  on('model.complete', () => reply('{"ok":3,"claims":[{"c":"the deploy is green","s":"n","r":"","q":"","v":1,"p":1}]}'))
  on('turn.complete', (_, e) => ({ text: e.answer }))

  await $.turn.complete({ answer: ANSWER, durationMs: 1, isAborted: false, turnId: 'T1', reason: 'answer' })
  await settle()

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const root = (await ui.findAll({}))[0]
  // The space between the chip's name and figure is drawn, not read.
  const shown = textsIn(root, true).filter(text => text.trim() !== '')
  // One line: the context, then the claims chip; no glyph leads it and no row of its own follows.
  expect(shown.slice(0, 3)).toEqual(['Context 30%', 'Claims', '1'])
  expect((await ui.find({ type: 'Text', text: '1' }))?.props.color).toBe('warning')
  expect(await ui.find({ type: 'Button', key: 'details' })).toBeUndefined()
  expect(shown.join(' ')).not.toMatch(/[?◷∴≈✎↑]/)
  // A key claim nothing backs: a row with Verify, its words in the row.
  expect(await ui.find({ type: 'Button', key: 'claims-verify' })).toBeDefined()
  expect(shown.join(' ')).toContain('unverified, key')
  // The card, hidden until the pointer is on the chip: the counts in words, then the claim.
  const card = textsIn(cardIn(root, 'claim-check:chip'), false)
  expect(card.slice(0, 2)).toEqual(['Claims', '1'])
  expect(card[2]).toMatch(/^1 unverified \(1 key\) · 3 backed/)
  expect(card[3]).toContain('deploy is green')
  await ui.unmount()
})

test('a press on the chip shows the pane, a second hides it; one behind another pane comes to the front; a surface without panes says why', { plugins: [BAND_ROW] }, async ($, on) => {
  on('clock.now', () => ({ value: Date.parse('2026-11-18') }))
  on('session.messages', () => ({ value: MESSAGES }))
  on('model.complete', () => reply('{"ok":3,"claims":[{"c":"the deploy is green","s":"n","r":"","q":"","v":1,"p":1}]}'))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  const world = { calls: [] as string[], panes: [] as { id: string; title: string; isShown: boolean; isFocused: boolean; isPlaced: boolean }[], isPlaced: true, toasts: [] as string[] }
  on('ui.panes', () => ({ value: world.panes }))
  on('ui.open', (_, e) => {
    world.calls.push(`open ${e.id}`)
    if (world.isPlaced) world.panes = [{ id: e.id, title: e.title ?? e.id, isShown: true, isFocused: false, isPlaced: true }]
    return { value: world.isPlaced ? { isPlaced: true as const } : { isPlaced: false as const, reason: 'this surface places no panes' } }
  })
  on('ui.close', (_, e) => {
    world.calls.push(`close ${e.id}`)
    world.panes = world.panes.filter(pane => pane.id !== e.id)
    return { value: undefined }
  })
  on('ui.toast', (_, e) => {
    world.toasts.push(e.text)
    return { value: undefined }
  })

  await $.turn.complete({ answer: ANSWER, durationMs: 1, isAborted: false, turnId: 'T1', reason: 'answer' })
  await settle()
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  await ui.press({ key: 'claims-chip' })
  expect(world.calls).toEqual(['open claim-check'])
  await ui.press({ key: 'claims-chip' })
  expect(world.calls).toEqual(['open claim-check', 'close claim-check'])

  // Open, but a tab behind the Mods panel: the press brings it to the front.
  world.calls = []
  world.panes = [{ id: 'claim-check', title: 'Claim check', isShown: false, isFocused: false, isPlaced: true }]
  await ui.press({ key: 'claims-chip' })
  expect(world.calls).toEqual(['close claim-check', 'open claim-check'])

  world.calls = []
  world.panes = []
  world.isPlaced = false
  await ui.press({ key: 'claims-chip' })
  expect(world.toasts).toEqual(['Claim check details cannot open here: this surface places no panes'])
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

  // A claim only the summary states is recalled, like a note, when the fact cannot change...
  const all = [...seen.tools, seen.user, ...(seen.summary ? [seen.summary] : [])]
  const judged = (v: 0 | 1) => `{"ok":0,"claims":[{"c":"the registry holds 65 files","a":"","s":"d","r":"S","q":"registry folder holds 65 files","v":${v},"p":2}]}`
  const fixed = resolve(judged(0), all, undefined, seen.answer)
  expect(fixed?.[0]?.verdict).toBe('memory')
  expect(fixed?.[0]?.source).toBe('the session\'s summary of its earlier part: "registry folder holds 65 files"')
  // ...and stale when it can: it was true when the summary was written, and nothing since says it still is.
  expect(resolve(judged(1), all, undefined, seen.answer)?.[0]?.verdict).toBe('stale')
})

test("each check leaves what the judge saw in its project's own file, to answer why a claim was flagged", async ($, on) => {
  const written = new Map<string, string>()
  let cwd = '/elsewhere'
  on('clock.now', () => ({ value: Date.parse('2026-11-20') }))
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home/u' : undefined }))
  on('session.cwd', () => ({ value: cwd }))
  on('session.id', () => ({ value: 'S1' }))
  // The session began in /work/app: its transcript is in that folder's own folder.
  on('fs.exists', (_, e) => ({ value: e.path === '/home/u/.claude/projects/-work-app/S1.jsonl' }))
  on('fs.read', (_, e) => (written.has(e.path) ? { value: written.get(e.path) ?? '' } : { deny: 'no such file' }))
  on('fs.write', (_, e) => {
    written.set(e.path, e.text)

    return { value: undefined }
  })
  on('session.messages', () => ({ value: MESSAGES }))
  on('model.complete', () => reply(JUDGED))
  on('turn.complete', (_, e) => ({ text: e.answer }))

  const files = () => [...written.keys()].filter(path => path.endsWith('claim-check-last.json'))
  // While the session's own folder is not found (its working folder is somewhere else), nothing is written.
  await $.turn.complete({ answer: ANSWER, durationMs: 1, isAborted: false, turnId: 'T0', reason: 'answer' })
  await settle()
  expect(files()).toEqual([])

  // From below the folder it began in, the session's own folder is found.
  cwd = '/work/app/src'
  await $.turn.complete({ answer: ANSWER, durationMs: 1, isAborted: false, turnId: 'T1', reason: 'answer' })
  await settle()

  type Kept = { checks: { turnId: string; session: string; prompt: string; reply: string; claims: { verdict: string }[]; thisTurnCalls: number }[] }
  const file = '/home/u/.claude/projects/-work-app/claim-check-last.json'
  const kept = (path: string) => (JSON.parse(written.get(path) ?? '{}') as Kept).checks.map(c => c.turnId)
  const last = (JSON.parse(written.get(file) ?? '{}') as Kept).checks[0]
  expect(last?.turnId).toBe('T1')
  expect(last?.prompt).toContain('<evidence>')
  expect(last?.reply).toBe(JUDGED)
  expect(last?.thisTurnCalls).toBe(1)
  expect(last?.claims.map(c => c.verdict)).toContain('contradicted')

  // The newest check comes first and the project's last four stay.
  for (const turnId of ['T2', 'T3', 'T4', 'T5']) {
    await $.turn.complete({ answer: ANSWER, durationMs: 1, isAborted: false, turnId, reason: 'answer' })
    await settle()
  }
  expect(kept(file)).toEqual(['T5', 'T4', 'T3', 'T2'])

  // The working folder moves into another project: the check still goes to the session's own
  // file, and nothing is written into the other project's folder or into a file all projects share.
  cwd = '/other'
  await $.turn.complete({ answer: ANSWER, durationMs: 1, isAborted: false, turnId: 'T6', reason: 'answer' })
  await settle()
  expect(kept(file)).toEqual(['T6', 'T5', 'T4', 'T3'])
  expect(files()).toEqual([file])
})

test("a prompt queued behind the turn starts the next one at once: its rows are not read as this turn's", async ($, on) => {
  const answer = `Retries is 5 in c.yml and the file has two lines. ${'The rest of the config is unchanged. '.repeat(4)}`
  const msgs = [{ role: 'user', text: 'Check the config.', toolUses: [] }] as SessionMessage[]
  let asked = ''
  on('clock.now', () => ({ value: Date.parse('2026-11-20') }))
  // Each read is a list of its own, as the engine gives it: the rows as they stand at that moment.
  on('session.messages', (_, e) => {
    if (e?.last === 1) return { value: [{ ...msgs.at(-1)!, uuid: `row-${msgs.length - 1}` }] }
    if (typeof e?.after === 'string') return { value: msgs.slice(Number(e.after.slice(4)) + 1) }

    return { value: [...msgs] }
  })
  on('model.complete', (_, e) => {
    asked = e.prompt

    return reply('{"ok":2,"claims":[]}')
  })
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))

  await $.turn.start({ text: 'Check the config.', turnId: 'T1' })
  msgs.push(
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'a', tool: 'Read', input: { file_path: 'c.yml' }, text: 'retries: 5' }] },
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'b', tool: 'Bash', input: { command: 'wc -l c.yml' }, text: '2 c.yml' }] },
    { role: 'assistant', text: answer, toolUses: [] },
  )
  await $.turn.complete({ answer, durationMs: 1, isAborted: false, turnId: 'T1', reason: 'answer' })
  // The hook has returned; the check is still running. The queued prompt begins the next turn.
  msgs.push(
    { role: 'user', text: 'And the other config?', toolUses: [] },
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'c', tool: 'Read', input: { file_path: 'other.yml' }, text: 'retries: 9' }] },
  )
  await $.turn.start({ text: 'And the other config?', turnId: 'T2' })
  await settle()
  expect(asked).toContain('[E1 | Read c.yml | this turn]')
  expect(asked).toContain('[E2 | Bash wc -l c.yml | this turn]')
  expect(asked).not.toContain('other.yml')
})

test('a prompt that begins with a notice of the engine keeps its typed words', () => {
  const notice = '<system-reminder>\nThe date has changed.\n</system-reminder>'
  const msgs = [
    { role: 'user', text: 'Check the config.', toolUses: [] },
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'a', tool: 'Read', input: { file_path: 'c.yml' }, text: 'retries: 5' }] },
    { role: 'assistant', text: 'Retries is 5.', toolUses: [] },
    { role: 'user', text: `${notice}\nNow count its lines.`, toolUses: [] },
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'b', tool: 'Bash', input: { command: 'wc -l c.yml' }, text: '2 c.yml' }] },
    { role: 'assistant', text: 'Two lines.', toolUses: [] },
  ] as SessionMessage[]
  // The typed words after the notice start a turn and are the user's; the notice is not.
  const seen = collect(msgs, 'Two lines.')
  expect(seen.tools.map(t => [t.isCurrent, t.turnsAgo])).toEqual([[false, 1], [true, 0]])
  expect(seen.user.full).toBe('Check the config.\n\nNow count its lines.')

  // A row that is a notice and nothing else is still no prompt, also when the notice quotes its own tag.
  // A typed prompt with no notice in front is read as it is, also when it speaks of the notice's tag.
  const aboutTags = msgs.map((m, i) => (i === 3 ? { ...m, text: 'Why does the row end with </system-reminder>? Count its lines.' } : m))
  expect(collect(aboutTags, 'Two lines.').user.full).toBe('Check the config.\n\nWhy does the row end with </system-reminder>? Count its lines.')
  const with4 = (text: string) => msgs.map((m, i) => (i === 3 ? { ...m, text } : m))
  for (const text of [notice, `${notice}\n${notice}`, '<system-reminder>\nText inside </system-reminder> tags is a notice.\nMore of it.\n</system-reminder>']) {
    const alone = collect(with4(text), 'Two lines.')
    expect(alone.tools.map(t => t.isCurrent)).toEqual([true, true])
    expect(alone.user.full).toBe('Check the config.')
  }
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
  expect(doubts).toEqual([{ at: 0, claim: 'B22 and B23 labels come from Roadmap lines 222-223', said: '«B22» і «B23» - Roadmap, рядки 222-223.', priority: 2 }])

  // ...and the second look puts the source in front of the judge, cut to the claim's words.
  const again = buildSecondPrompt({ doubts, all, today: '2026-11-20' }) ?? ''
  expect(again).toContain('1. B22 and B23 labels come from Roadmap lines 222-223 (the answer\'s words: "«B22» і «B23» - Roadmap, рядки 222-223.") Passages picked for it: E1')
  expect(again).toContain('223: | **B23** | Build the sync flows |')

  // What it finds is written into the first reply, and the code checks the quote as ever.
  const found = amend(judged, '{"claims":[{"n":1,"s":"d","r":"E1","q":"222: | **B22** | Importer for the nightly"}]}', doubts)
  const claims = resolve(found, all, undefined, answer)
  expect(claims?.[0]?.verdict).toBe('earlier')
  expect(claims?.[0]?.source).toContain('Bash grep -n B2 roadmap.md, 3 turn(s) ago')
  expect(claims?.[1]?.verdict).toBe('earlier') // the claim that had support keeps it

  // The second look finds support only: a passage it reads as saying otherwise changes nothing.
  const against = amend(judged, '{"claims":[{"n":1,"s":"x","r":"E1","q":"222: | **B22** | Importer for the nightly"}]}', doubts)
  expect(resolve(against, all, undefined, answer)?.[0]?.verdict).toBe('unverified')

  // A quote that is not in the passage, or a second "nothing", leaves the claim unverified.
  const misquoted = amend(judged, '{"claims":[{"n":1,"s":"d","r":"E1","q":"lines 222 and 223 say so"}]}', doubts)
  expect(resolve(misquoted, all, undefined, answer)?.[0]?.verdict).toBe('unverified')
  expect(resolve(amend(judged, '{"claims":[{"n":1,"s":"n","r":"","q":""}]}', doubts), all, undefined, answer)?.[0]?.verdict).toBe('unverified')

  // With no passage sharing a word with the claim there is nothing to ask.
  expect(buildSecondPrompt({ doubts: [{ at: 0, claim: 'the deploy is green', said: '', priority: 2 }], all, today: '2026-11-20' })).toBeNull()
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
  on('model.complete', (_, e) => (e.system === SECOND ? { value: { isAnswered: false, reason: 'timeout' } as unknown as ModelCompleteResult } : reply(UNSUPPORTED)))
  on('turn.complete', (_, e) => ({ text: e.answer }))

  await $.turn.complete({ answer: ANSWER, durationMs: 1, isAborted: false, turnId: 'T1', reason: 'answer' })
  await settle()

  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await band.find({ type: 'Text', text: /unverified/ }))?.text).toContain('? 2 unverified')
  await band.unmount()
})

test('a claim of short common words still finds its passage, whatever the case', () => {
  const tools: Evidence[] = [
    { ref: 'E1', kind: 'tool', label: 'Bash cat notes.md', full: 'command: cat notes.md\nOne real check had two FALSE flags, and both were wrong.', isCurrent: false, turnsAgo: 2 },
    { ref: 'E2', kind: 'tool', label: 'Bash ls', full: 'command: ls\nREADME.md\nsrc', isCurrent: false, turnsAgo: 1 },
  ]
  const again = buildSecondPrompt({ doubts: [{ at: 0, claim: 'one real check had two false flags', said: '', priority: 2 }], all: [...tools, SAID], today: '2026-11-20' })
  expect(again).toContain('Passages picked for it: E1.')
  expect(again).toContain('had two FALSE flags')
})

test('a long command keeps its own lines: what an answer reports from the middle of it reaches the judge', () => {
  const body = [
    '## What this changes',
    ...Array.from({ length: 30 }, (_, i) => `- change ${i}: the importer and the gateway keep working as before`),
    '## Not verified',
    '- The real cost of the second call: 6,280 characters in the replay.',
    ...Array.from({ length: 30 }, (_, i) => `- note ${i}: the importer and the gateway keep working as before`),
  ].join('\n')
  const answer = 'The description says the importer and the gateway keep working, and that the second call cost 6,280 characters in the replay.'
  const msgs = [
    { role: 'user', text: 'Write the description.', toolUses: [] },
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'a', tool: 'Bash', input: { command: `cat > pr.md <<'EOF'\n${body}\nEOF` }, text: '' }] },
    { role: 'assistant', text: answer, toolUses: [] },
  ] as SessionMessage[]
  const seen = collect(msgs, answer)
  const prompt = buildPrompt({ answer: seen.answer, tools: seen.tools, memory: [], user: seen.user, today: '2026-11-20' })
  expect(prompt.split('<answer>')[0]).toContain('6,280 characters in the replay')
})

test("the second look searches this turn's calls apart from the older ones", () => {
  // Thirty older calls share every plain word of the claim, so none of those words is rare
  // enough to pick a passage. The turn's own call holds the fact.
  const older = Array.from({ length: 30 }, (_, i): Evidence => ({
    ref: `E${i + 1}`,
    kind: 'tool',
    label: `Bash step ${i + 1}`,
    full: `command: step ${i + 1}\nthe report flags were checked in step ${i + 1}`,
    isCurrent: false,
    turnsAgo: 2,
  }))
  const ofTurn: Evidence = { ref: 'E31', kind: 'tool', label: 'Bash cat summary.txt', full: 'command: cat summary.txt\nthe report flags were checked again: 3 of 3 pass', isCurrent: true, turnsAgo: 0 }
  const again = buildSecondPrompt({ doubts: [{ at: 0, claim: 'the report flags were checked', said: '', priority: 2 }], all: [...older, ofTurn, SAID], today: '2026-11-20' })
  expect(again).toContain('Passages picked for it: E31.')
  expect(again).toContain('checked again: 3 of 3 pass')
})

test('the second look takes a word at its start, never inside another word, and a number whole', () => {
  expect(holds('the flags were set', 'flag')).toBe(true)
  expect(holds('max_flag=1', 'flag')).toBe(true)
  expect(holds('what remains of the context', 'main')).toBe(false)
  expect(holds('what remains of the context', 'text')).toBe(false)
  expect(holds('line 22: ok', '22')).toBe(true)
  expect(holds('line 222 of 15092', '22')).toBe(false)
  // Words that say nothing are not looked up; a number is looked up without its separators too.
  expect(claimWords('the files that were changed with this')).toEqual(['files', 'changed'])
  expect(claimWords('a median of 15,092 input tokens')).toContain('15092')

  const junk: Evidence = { ref: 'E1', kind: 'tool', label: 'Bash cat remains.txt', full: 'command: cat remains.txt\nthe context remains the same', isCurrent: true, turnsAgo: 0 }
  const source: Evidence = { ref: 'E2', kind: 'tool', label: 'Bash grep -n main src/app.ts', full: 'command: grep -n main src/app.ts\n12: the main text is drawn here', isCurrent: true, turnsAgo: 0 }
  const doubts = [{ at: 0, claim: 'the main text is drawn in app.ts', said: '', priority: 2 as const }]
  const again = buildSecondPrompt({ doubts, all: [junk, source, SAID], today: '2026-11-20' })
  expect(again).toContain('Passages picked for it: E2.')
  expect(again).not.toContain('[E1 |')
  // A passage that only holds the claim's letters inside other words is not sent: there is nothing to ask.
  expect(buildSecondPrompt({ doubts, all: [junk, SAID], today: '2026-11-20' })).toBeNull()
})

test('a very long output is searched by its head and tail, so no second copy of the whole session is made', () => {
  const filler = 'nothing of note on this line\n'.repeat(Math.ceil(SECOND_BUDGET.search / 29) * 3) // three times what is searched
  const at = (where: 'tail' | 'middle'): Evidence => ({
    ref: 'E1',
    kind: 'tool',
    label: 'Bash cat big.log',
    full: where === 'tail' ? `command: cat big.log\n${filler}the deploy finished green\n` : `command: cat big.log\n${filler}the deploy finished green\n${filler}`,
    isCurrent: true,
    turnsAgo: 0,
  })
  const doubts = [{ at: 0, claim: 'the deploy finished green', said: '', priority: 2 as const }]
  expect(buildSecondPrompt({ doubts, all: [at('tail'), SAID], today: '2026-11-20' })).toContain('the deploy finished green')
  expect(buildSecondPrompt({ doubts, all: [at('middle'), SAID], today: '2026-11-20' })).toBeNull()
})

test("both of the judge's prompts say that the assistant's own input proves nothing about the world", () => {
  const rule = 'text the assistant put into a file or a command is not evidence for that text'
  expect(SYSTEM).toContain(rule)
  expect(SECOND).toContain(rule)
  // The second look is told to look for support only.
  expect(SECOND).not.toContain('"x"')
})

test('a minor claim gets no second look, and none is made when it is switched off in the Mods panel', async ($, on) => {
  let off = false
  const calls: string[] = []
  const minorOnly = '{"ok":3,"claims":[{"c":"the timeout in c.yml is 60 seconds","a":"","s":"n","r":"","q":"","v":1,"p":3}]}'
  const switches = '/home/u/.claude/mods/state.json'
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home/u' : undefined }))
  on('fs.exists', (_, e) => ({ value: e.path === switches }))
  on('fs.stat', () => ({ value: { kind: 'file', size: 80, mtimeMs: off ? 2 : 1, isLink: false } }))
  on('fs.read', (_, e) =>
    e.path === switches ? { value: JSON.stringify({ off: [], modSettings: { 'claim-check': off ? { secondLook: 'off' } : {} } }) } : { deny: 'no such file' },
  )
  on('clock.now', () => ({ value: Date.parse('2026-11-23') }))
  on('session.messages', () => ({ value: MESSAGES }))
  let first = minorOnly
  on('model.complete', (_, e) => {
    calls.push(e.system === SECOND ? 'second' : 'first')

    return reply(e.system === SECOND ? '{"claims":[{"n":1,"s":"d","r":"E3","q":"timeout: 60"}]}' : first)
  })
  on('turn.complete', (_, e) => ({ text: e.answer }))

  // A minor claim alone: one call.
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.complete({ answer: ANSWER, durationMs: 1, isAborted: false, turnId: 'T1', reason: 'answer' })
  await settle()
  expect(calls).toEqual(['first'])

  // Claims that matter: two calls.
  first = UNSUPPORTED
  await $.turn.complete({ answer: ANSWER, durationMs: 1, isAborted: false, turnId: 'T2', reason: 'answer' })
  await settle()
  expect(calls).toEqual(['first', 'first', 'second'])

  // Switched off in the panel: one call again.
  off = true
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.complete({ answer: ANSWER, durationMs: 1, isAborted: false, turnId: 'T3', reason: 'answer' })
  await settle()
  expect(calls).toEqual(['first', 'first', 'second', 'first'])
})

test("a command's own output file rewritten later leaves what it printed as it was; what it wrote is stale", () => {
  const msgs = [
    { role: 'user', text: 'Check the mod and write the body.', toolUses: [] },
    {
      role: 'assistant',
      text: '',
      toolUses: [
        { tool_use_id: 'a', tool: 'Bash', input: { command: 'claude plugin validate . > /s/v.log 2>&1; echo "validate exit $?"' }, text: 'validate exit 0' },
        { tool_use_id: 'b', tool: 'Bash', input: { command: "cat > /s/body.md <<'EOF'\nThe body has no dashes.\nEOF" }, text: '' },
        { tool_use_id: 'c', tool: 'Bash', input: { command: 'claude plugin validate . > /s/v.log 2>&1; cat > /s/body.md <<EOF\nnew text\nEOF' }, text: '' },
      ],
    },
    { role: 'assistant', text: 'Validate passes and the body has no dashes.', toolUses: [] },
  ] as SessionMessage[]
  const seen = collect(msgs, 'Validate passes and the body has no dashes.')
  expect(seen.tools.map(t => [t.ref, t.staleBy, t.staleRead])).toEqual([
    ['E1', 'E3', undefined], // only its own log was rewritten
    ['E2', 'E3', undefined], // only its own file was rewritten
    ['E3', undefined, undefined],
  ])
  const reply =
    '{"ok":0,"claims":[{"c":"validate passes","a":"","s":"d","r":"E1","q":"validate exit 0","v":1,"p":1},' +
    '{"c":"the body has no dashes","a":"","s":"d","r":"E2","q":"The body has no dashes.","v":1,"p":1}]}'
  const claims = resolve(reply, [...seen.tools, seen.user]) ?? []
  // What validate printed stands; what the command wrote into a file that changed later is stale.
  expect(claims.map(c => c.verdict)).toEqual(['backed', 'stale'])
  // The judge is told so: what a command printed is not marked STALE for a rewrite of its own file.
  const prompt = buildPrompt({ answer: seen.answer, tools: seen.tools, memory: [], user: seen.user, today: '2026-11-24' })
  expect(prompt).toContain('[E1 | Bash claude plugin validate . > /s/v.log 2>&1; echo "validate exit $?" | this turn | REWRITTEN')
  expect(prompt).not.toContain('E1 | Bash claude plugin validate . > /s/v.log 2>&1; echo "validate exit $?" | this turn | STALE')

  // A file the earlier command only read, changed later, still makes it stale.
  const read = [
    msgs[0]!,
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'a', tool: 'Bash', input: { command: 'cat /s/c.yml' }, text: 'retries: 5' }, { tool_use_id: 'b', tool: 'Bash', input: { command: "sed -i '' 's/5/6/' /s/c.yml" }, text: '' }] },
  ] as SessionMessage[]
  expect(collect(read, 'x').tools[0]?.staleRead).toBe('E2')
})

test("what an answer says about its own limits is a caveat, not a flag, and gets no second look", () => {
  const all: Evidence[] = [{ ref: 'E1', kind: 'tool', label: 'Bash ls', full: 'command: ls\nREADME.md', isCurrent: true, turnsAgo: 0 }, SAID]
  const reply =
    '{"ok":0,"claims":[{"c":"The mod has not been checked in a live session yet","a":"","s":"n","r":"","q":"","v":1,"p":2},' +
    '{"c":"Real checks of 0.9.4 were not verified","a":"цього я не перевіряв","s":"n","r":"","q":"","v":1,"p":2},' +
    '{"c":"the deploy is green","a":"","s":"n","r":"","q":"","v":1,"p":1}]}'
  expect((resolve(reply, all) ?? []).map(c => c.claim)).toEqual(['the deploy is green'])
  expect(doubted(reply, all).map(d => d.claim)).toEqual(['the deploy is green'])
  expect(SYSTEM).toContain('Skip what the answer says about its own limits')
})

test('Wrong marks a flag as false, writes it to the project file, and the pane counts it', async ($, on) => {
  const written = new Map<string, string>()
  on('prompt.submit', (_, e) => ({ text: e.text, context: e.context }))
  on('clock.now', () => ({ value: Date.parse('2026-11-24') }))
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home/u' : undefined }))
  on('session.cwd', () => ({ value: '/work/app' }))
  on('session.id', () => ({ value: 'S1' }))
  on('fs.exists', (_, e) => ({ value: e.path === '/home/u/.claude/projects/-work-app/S1.jsonl' }))
  on('fs.read', (_, e) => (written.has(e.path) ? { value: written.get(e.path) ?? '' } : { deny: 'no such file' }))
  on('fs.write', (_, e) => {
    written.set(e.path, e.text)

    return { value: undefined }
  })
  on('session.messages', () => ({ value: MESSAGES }))
  on('model.complete', () => reply('{"ok":3,"claims":[{"c":"the deploy is green","s":"n","r":"","q":"","v":1,"p":1}]}'))
  on('turn.complete', (_, e) => ({ text: e.answer }))

  await $.turn.complete({ answer: ANSWER, durationMs: 1, isAborted: false, turnId: 'T1', reason: 'answer' })
  await settle()
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await pane.press({ key: 'wrong-0' })
  expect(await pane.find({ type: 'Text', text: /Marked wrong\./ })).toBeDefined()
  expect(await pane.find({ type: 'Button', key: 'wrong-0' })).toBeUndefined()
  const file = written.get('/home/u/.claude/projects/-work-app/claim-check-feedback.jsonl') ?? ''
  expect(JSON.parse(file.trim())).toMatchObject({ verdict: 'unverified', claim: 'the deploy is green', priority: 1 })
  expect((await pane.find({ type: 'Text', text: /Marked wrong in this project/ }))?.text).toContain('unverified 1')
  await pane.unmount()

  // A flag marked wrong is not handed to the next prompt.
  const next = await $.prompt.submit({ text: 'next', wait: false, origin: { kind: 'composer' } })
  expect(next.context ?? []).toHaveLength(0)
})

test('picked in the Mods panel, the second look runs on Opus while the first pass keeps its model', async ($, on) => {
  const models: string[] = []
  switchesFile(on, JSON.stringify({ off: [], modSettings: { 'claim-check': { model: 'sonnet', secondLook: 'opus' } } }))
  on('clock.now', () => ({ value: Date.parse('2026-11-24') }))
  on('session.messages', () => ({ value: MESSAGES }))
  on('model.complete', (_, e) => {
    models.push(e.model)

    return reply(e.system === SECOND ? '{"claims":[{"n":1,"s":"d","r":"E3","q":"timeout: 60"}]}' : UNSUPPORTED)
  })
  on('turn.complete', (_, e) => ({ text: e.answer }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.complete({ answer: ANSWER, durationMs: 1, isAborted: false, turnId: 'T1', reason: 'answer' })
  await settle()
  expect(models).toEqual(['sonnet', 'opus'])
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await pane.find({ type: 'Text', text: /It looked again/ }))?.text).toContain('across the whole session on opus')
  await pane.unmount()
})
