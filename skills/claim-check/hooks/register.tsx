import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Check, Claim, Picks, Verdict } from '../types'
import { buildPrompt, citedStaleFiles, collect, hits, parseReply, resolve, settledCount, SYSTEM, tokens } from './judge'
import type { Evidence } from './judge'

const NAME = 'claim-check'
const PANE = 'claim-check'
const MAX_REPLY = 1_200 // tokens: 8 listed claims and 3 assumptions take about 500
const MIN_CHARS = 150 // shorter answers are chat, not claims
const NOTES = 4 // memory notes sent to the judge: the ones that share most words with the answer

const last = atom({ plugin: 'claim-check', key: 'last' } as const, null, { shape: 'check-4' })
const autoCount = atom({ plugin: 'claim-check', key: 'autoCount' } as const, 0)
// The Mods panel's switch for this mod: off means no checks, no row, nothing handed to the next prompt.
const isOn = atom({ plugin: 'claim-check', key: 'isOn' } as const, true)
// The switches file's modification time when last read: a poll reads the file only once it changed.
const switchSeenAt = atom({ plugin: 'claim-check', key: 'switchSeenAt' } as const, -1)
// Whether the turn running now answers this mod's Verify or Dig prompt.
const isOwnTurn = atom({ plugin: 'claim-check', key: 'isOwnTurn' } as const, false)
// The judge's model and effort picked in the Mods panel, read with the switch.
const picks = atom({ plugin: 'claim-check', key: 'picks' } as const, {} as Picks)
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
// The judge's effort until one is picked: the check stays quick.
const DEFAULT_EFFORT = 'low'

// Worst first.
const VERDICTS: Verdict[] = ['contradicted', 'unverified', 'stale', 'assumed', 'inferred', 'memory', 'earlier', 'backed']
const MARK: Record<Verdict, string> = {
  contradicted: '✗',
  unverified: '?',
  stale: '◷',
  assumed: '∴',
  inferred: '≈',
  memory: '✎',
  earlier: '↑',
  backed: '✓',
}
const COLOR = {
  contradicted: 'error',
  unverified: 'warning',
  stale: 'warning',
  assumed: 'warning',
  inferred: 'warning',
  memory: 'subtle',
  earlier: 'subtle',
  backed: 'success',
} as const

// What matters most first: a contradiction, then what the user will act on, then how bad the verdict is.
const byWeight = (a: Claim, b: Claim) =>
  Number(b.verdict === 'contradicted') - Number(a.verdict === 'contradicted') ||
  a.priority - b.priority ||
  VERDICTS.indexOf(a.verdict) - VERDICTS.indexOf(b.verdict)
const done = (check: Check | null) => (check?.status === 'done' ? check.claims : [])
const pick = (check: Check | null, verdicts: Verdict[]) => done(check).filter(c => verdicts.includes(c.verdict)).sort(byWeight)
// Handed to the next prompt unasked: never a minor detail (those stay in the pane), six at most.
export const flagged = (check: Check | null) =>
  pick(check, ['contradicted', 'unverified', 'stale', 'assumed'])
    .filter(c => c.priority < 3 || c.verdict === 'contradicted')
    .slice(0, 6)
// What the Verify button asks about: those, what was only reasoned, and the minor ones too, the weightiest first.
export const verifiable = (check: Check | null) => pick(check, ['contradicted', 'unverified', 'stale', 'assumed', 'inferred']).slice(0, 8)
const TAG = { 1: 'key', 2: '', 3: 'minor' } as const

const lines = (list: Claim[]) =>
  list
    .map(
      c =>
        `- [${c.verdict}${c.priority === 1 ? ', key' : ''}] ${c.claim}${c.said ? ` (your words: "${c.said}")` : ''}` +
        `${c.source ? ` (${c.source})` : ''}${c.check ? ` To check: ${c.check}` : ''}`,
    )
    .join('\n')
// How a claim reads to a person: the answer's own words in quotes where the
// code found them in the answer, else the judge's reading, unquoted.
const shown = (c: Claim) => (c.said ? `"${c.said}"` : c.claim)

// What each mark means, at the foot of the Details pane.
const LEGEND: [Verdict, string][] = [
  ['contradicted', 'the evidence says otherwise'],
  ['unverified', 'nothing in the session backs it, or the judge cited a passage that is not there'],
  ['stale', 'backed only by a read made before the file changed, or by an old memory note'],
  ['assumed', 'the answer relies on it but never states or checks it'],
  ['inferred', 'follows from the evidence by reasoning; nothing states it'],
  ['memory', 'from a memory note or CLAUDE.md'],
  ['earlier', "from an earlier turn's tool output, or your own words"],
  ['backed', "stated by this turn's tool output; counted, not listed"],
]

const VERSION = '0.7.1'
// What the row says when a reload of this mod cut a check short.
const INTERRUPTED = 'This answer was not checked: claim-check restarted before it finished, because its code had just been changed.'
export const TIMINGS = '.claude/claim-check-timings.jsonl' // under the home folder; the last 200 lines
// off: nothing. summary: one line per check and per load. stages: a line at each step of a check too.
let logMode = 'summary'

async function logTiming($: EngineInterface, row: Record<string, unknown>, level: 'summary' | 'stages' = 'summary') {
  if (logMode === 'off' || (level === 'stages' && logMode !== 'stages')) return
  const home = await $.env.get('HOME')
  if (!home) return
  const path = `${home}/${TIMINGS}`
  const old = await $.fs.read(path).catch(() => '')
  const line = JSON.stringify({ at: new Date(await $.clock.now()).toISOString(), ...row })
  await $.fs.write(path, [...old.split('\n').filter(Boolean).slice(-199), line].join('\n') + '\n')
}

// The memory folder is named after the folder the session started in, and
// the working folder may have moved below it since (a `cd` in a command):
// try the working folder, then each folder above it.
// ponytail: a session that moved to an unrelated folder finds no memory.
async function memoryDir($: EngineInterface, config: string, cwd: string): Promise<string | undefined> {
  let at = cwd
  for (let i = 0; i < 12 && at !== ''; i++) {
    const dir = `${config}/projects/${at.replace(/[^A-Za-z0-9]/g, '-')}/memory`
    if (await $.fs.exists(`${dir}/MEMORY.md`).catch(() => false)) return dir
    at = at.slice(0, at.lastIndexOf('/'))
  }

  return undefined
}

const noteCache = new Map<string, { size: number; full: string }>()

// CLAUDE.md, the memory index, and the notes that share most words with the
// answer, each with its age. Nothing here is fatal: no memory, no evidence.
async function loadMemory($: EngineInterface, answer: string, now: number): Promise<Evidence[]> {
  const home = await $.env.get('HOME')
  if (!home) return []
  const config = (await $.env.get('CLAUDE_CONFIG_DIR')) || `${home}/.claude`
  const cwd = await $.session.cwd()
  const dir = (await memoryDir($, config, cwd)) ?? `${config}/projects/${cwd.replace(/[^A-Za-z0-9]/g, '-')}/memory`
  const text = (path: string) => $.fs.read(path).catch(() => '')
  const out: Evidence[] = []
  const add = (label: string, full: string, ageDays?: number) => {
    if (full.trim()) out.push({ ref: `M${out.length + 1}`, kind: 'memory', label, full, isCurrent: false, turnsAgo: 0, ageDays })
  }

  add('instructions ~/.claude/CLAUDE.md', await text(`${config}/CLAUDE.md`))
  add('instructions CLAUDE.md', await text(`${cwd}/CLAUDE.md`))
  add('memory index MEMORY.md', await text(`${dir}/MEMORY.md`))

  // A note is read again only when its size changed (the listing gives sizes for free).
  // ponytail: an edit that keeps the byte count is missed until the next reload.
  const toks = tokens(answer)
  const names = (await $.fs.list(dir).catch(() => []))
    .filter(f => f.kind === 'file' && f.name.endsWith('.md') && f.name !== 'MEMORY.md')
    .slice(0, 300)
  const notes = await Promise.all(
    names.map(async f => {
      const path = `${dir}/${f.name}`
      const hit = noteCache.get(path)
      const full = hit?.size === f.size ? hit.full : await text(path)
      noteCache.set(path, { size: f.size, full })

      return { name: f.name, full }
    }),
  )
  const best = notes
    .map(n => ({ ...n, score: hits(n.full, toks) }))
    .filter(n => n.score >= 3)
    .sort((a, b) => b.score - a.score)
    .slice(0, NOTES)

  for (const n of best) {
    const stamp = /^\s*modified:\s*(\S+)/m.exec(n.full)?.[1]
    const at = stamp ? Date.parse(stamp) : (await $.fs.stat(`${dir}/${n.name}`).catch(() => undefined))?.mtimeMs
    add(`memory note ${n.name}`, n.full, at && !Number.isNaN(at) ? Math.max(0, Math.floor((now - at) / 86_400_000)) : undefined)
  }

  return out
}

// Submits a Verify or Dig prompt and marks the turn it starts, whose answer is
// then not checked again (turn.complete). The engine passes the submission
// through every hook but this plugin's own, so the mark is set here, not there.
// ponytail: a prompt the person queues before this one runs clears the mark first.
async function submitOwn($: EngineInterface, text: string) {
  await update($, isOwnTurn, () => true)
  await $.prompt.submit({ text })
}

async function verify($: EngineInterface) {
  const check = await read($, last)
  const list = verifiable(check)
  if (!check || check.isFedBack || list.length === 0) return
  await update($, last, cur => (cur ? { ...cur, isFedBack: true } : cur))
  await submitOwn(
    $,
    'Verify these claims from your last answer with tools, one by one, not from memory. ' +
      'For each: state it as one falsifiable sentence, use the cheapest check first, and use read-only checks only ' +
      '(never test a write against a real record). ' +
      'Report each as confirmed, killed (with the correction) or needs a bigger instrument.\n' +
      lines(list),
  )
}

// What a Dig button is offered for: anything not seen in a tool's output or said by the user.
const DIGGABLE: Verdict[] = ['contradicted', 'unverified', 'stale', 'assumed', 'inferred', 'memory']

const hasDigSkill = async ($: EngineInterface) => {
  const home = await $.env.get('HOME')
  const cwd = await $.session.cwd()
  const spots = [`${cwd}/.claude/skills/dig/SKILL.md`, `${cwd}/skills/dig/SKILL.md`, `${home}/.claude/skills/dig/SKILL.md`]

  return (await Promise.all(spots.map(p => $.fs.exists(p).catch(() => false)))).some(Boolean)
}

// One claim, measured properly: the method of the dig skill, or the skill itself where the project has one.
async function dig($: EngineInterface, turnId: string, index: number) {
  const check = await read($, last)
  const claim = check?.turnId === turnId ? check.claims[index] : undefined
  if (!claim || claim.isDug) return
  await update($, last, cur =>
    cur?.turnId === turnId ? { ...cur, claims: cur.claims.map((c, i) => (i === index ? { ...c, isDug: true } : c)) } : cur,
  )
  const method = (await hasDigSkill($).catch(() => false))
    ? 'This project has a dig skill: invoke it with the Skill tool for this claim and follow it.'
    : [
        'Measure it; do not reason about it.',
        '1. State it as one falsifiable sentence, and name where the claim lives (a file and line, a memory note, a doc) if it lives anywhere.',
        '2. Design the probe so it cannot change state: reads and read-only commands only. Never test a write against a real record; if only a write could settle it, stop and ask.',
        '3. Use the cheapest instrument first.',
        '4. Give a verdict: confirmed, killed, or needs a bigger instrument.',
        '5. If the claim was wrong or stale and lives in a file, correct it at that source and say which file you changed. Fix nothing else.',
        '6. End with "Next probe: …".',
      ].join('\n')
  await submitOwn($, `Dig into one claim from your last answer.\n${lines([claim])}\n${method}`)
}

export const register: Register = (on, options) => {
  const isAutoCorrecting = options.autoCorrect === true // off unless switched on
  const judge = typeof options.judgeModel === 'string' && options.judgeModel !== '' ? options.judgeModel : 'sonnet'
  logMode = typeof options.timingLog === 'string' ? options.timingLog : 'summary'

  // Runs at every load and reload: proves the log can be written and says which copy is running.
  on('session.start', async ($, e, next) => {
    await watchSwitch($)
    void logTiming($, { version: VERSION, event: 'loaded', root: $.plugin.root, judge }).catch(() => undefined)
    // A reload drops a check in flight, and its "checking" state would stay up for good.
    await update($, last, (cur): Check | null =>
      cur?.status === 'checking' ? { ...cur, status: 'interrupted' } : cur,
    )

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined || e.reason !== 'answer') return next(e)
    if (!(await read($, isOn))) return next(e)
    // An answer to Verify or Dig is not checked again: its check would flag the
    // verification's own claims and ask for another Verify, round after round.
    // The row keeps the check of the answer that was verified.
    if (await read($, isOwnTurn)) return next(e)

    const turnId = e.turnId
    const finalAnswer = e.answer
    const checking: Check = { turnId, status: 'checking', claims: [], settled: 0, isFedBack: false }
    await update($, last, () => (finalAnswer.length < MIN_CHARS ? null : checking))
    if (finalAnswer.length < MIN_CHARS) return next(e)

    const settle = (to: Check) => update($, last, cur => (cur?.turnId === turnId ? to : cur)) // a newer turn's check wins

    // Runs after the hook returns, so the answer is never held up.
    void (async () => {
      const now = await $.clock.now()
      // With the log set to "stages", a line per stage: if a check hangs, the last line says where.
      const stage = (event: string, more: Record<string, unknown> = {}) =>
        logTiming($, { version: VERSION, turnId, event, ...more }, 'stages').catch(() => undefined)
      await stage('start', { answerChars: finalAnswer.length })
      const msgs = await $.session.messages()
      const gotTranscript = await $.clock.now()
      await stage('transcript', { ms: gotTranscript - now, messages: 'deny' in msgs ? 'denied' : msgs.length })
      const home = (await $.env.get('HOME').catch(() => undefined)) || undefined
      const { tools, user, answer } = collect('deny' in msgs ? [] : msgs, finalAnswer, home)
      const memory = await loadMemory($, answer, now).catch(() => [])
      const gotMemory = await $.clock.now()
      await stage('memory', { ms: gotMemory - gotTranscript, toolCalls: tools.length, memoryItems: memory.length })
      const prompt = buildPrompt({ answer, tools, memory, user, today: new Date(now).toISOString().slice(0, 10) })
      // The Mods panel's pick wins over the Judge model setting.
      const pick = await read($, picks)
      const model = pick.model ?? judge
      const effort = pick.effort ?? DEFAULT_EFFORT
      const asked = await $.clock.now()
      await stage('asking', { buildMs: asked - gotMemory, promptChars: prompt.length, model, effort })
      const r = await $.model.complete({ model, system: SYSTEM, prompt, maxTokens: MAX_REPLY, effort, timeoutMs: 180_000 })
      const answered = await $.clock.now()
      const stats = {
        gatherSeconds: Math.round((asked - now) / 1000),
        judgeSeconds: Math.round((answered - asked) / 1000),
        promptChars: prompt.length,
        replyTokens: r.isAnswered ? r.usage.output_tokens : 0,
        isCut: r.isAnswered && (parseReply(r.text)?.isCut ?? true),
        model,
        effort,
      }
      // One line per check: where the time went and what came out.
      const summary = (outcome: string, claims: Claim[] = [], settled = 0) =>
        logTiming($, {
          version: VERSION,
          turnId,
          event: 'answered',
          model,
          effort,
          transcriptMs: gotTranscript - now,
          toolCalls: tools.length,
          memoryMs: gotMemory - gotTranscript,
          memoryItems: memory.length,
          buildMs: asked - gotMemory,
          judgeMs: answered - asked,
          promptChars: prompt.length,
          replyTokens: stats.replyTokens,
          inputTokens: r.isAnswered ? r.usage.input_tokens : 0,
          outcome,
          settled,
          flags: Object.fromEntries(VERDICTS.map(v => [v, claims.filter(c => c.verdict === v).length] as const).filter(([, n]) => n > 0)),
          key: claims.filter(c => c.priority === 1).length,
        }).catch(() => undefined) // a log that cannot be written costs nothing
      const all = [...tools, ...memory, user]
      // A read made before a later change counts as stale only if its quote is gone from the file now.
      const fresh = new Map<string, string>()
      for (const file of r.isAnswered ? citedStaleFiles(r.text, all) : []) {
        const text = await $.fs.read(file).catch(() => undefined)
        if (text !== undefined) fresh.set(file, text)
      }
      const claims = r.isAnswered ? resolve(r.text, all, fresh, answer) : null
      if (!claims) {
        const error = !r.isAnswered
          ? r.reason
          : r.usage.output_tokens >= MAX_REPLY
            ? `the judge's reply was cut off at ${MAX_REPLY} tokens before its first claim`
            : `the judge did not answer in JSON (${r.text.length} characters, starting "${r.text.slice(0, 80).replace(/\s+/g, ' ')}")`
        await summary(r.isAnswered ? 'unreadable' : r.reason)
        await settle({ turnId, status: 'failed', claims: [], settled: 0, isFedBack: false, error, stats })
        return
      }
      const settled = settledCount(r.isAnswered ? r.text : '')
      await summary(stats.isCut ? 'cut' : 'ok', claims, settled)
      const result = await settle({ turnId, status: 'done', claims, settled, isFedBack: false, stats })

      // A contradiction is corrected unasked, once per prompt of the person's.
      const wrong = claims.filter(c => c.verdict === 'contradicted' && c.priority < 3) // never a turn spent on a detail
      if (isAutoCorrecting && wrong.length > 0 && result?.turnId === turnId && (await read($, autoCount)) < 1) {
        await update($, autoCount, n => n + 1)
        await settle({ turnId, status: 'done', claims, settled, isFedBack: true, stats })
        // Its answer is checked as usual: autoCount already keeps this to one round.
        await $.prompt.submit({
          text:
            'Your last answer makes claims that its own evidence contradicts. ' +
            'Re-check each with tools and post a short correction.\n' +
            lines(wrong),
        })
      }
    })().catch(async err => {
      await logTiming($, { version: VERSION, turnId, event: 'error', error: String(err) }).catch(() => undefined)
      await update($, last, (cur): Check | null => (cur?.turnId === turnId ? { ...cur, status: 'failed', error: String(err) } : cur))
    })

    return next(e)
  })

  // Hand the flagged claims to the next turn, once.
  on('prompt.submit', async ($, e, next) => {
    // Any other prompt starts a turn of someone else's: its answer is checked (submitOwn sets the mark).
    // A meta prompt inside a turn leaves the mark as it is.
    const isOwn = e.origin.kind === 'plugin' && e.origin.name === NAME // Verify, Dig, or an auto-correction
    if (!e.isMeta && isOwn !== (await read($, isOwnTurn))) await update($, isOwnTurn, () => isOwn)
    if (isOwn) return next(e)
    if ((await read($, autoCount)) > 0) await update($, autoCount, () => 0)
    if (e.isMeta || e.command) return next(e)
    if (!(await read($, isOn))) return next(e)

    const check = await read($, last)
    const list = flagged(check)
    if (!check || check.isFedBack || list.length === 0) return next(e)

    await update($, last, cur => (cur ? { ...cur, isFedBack: true } : cur))
    const note =
      'claim-check mod: a second model checked your previous answer against its evidence and flagged these claims ' +
      '(contradicted by the evidence, backed by nothing, backed only by something stale, or assumed):\n' +
      lines(list) +
      '\nWhere one matters to this reply, verify it or say plainly that it is unverified.'

    return next({ ...e, context: [...(e.context ?? []), note] })
  }).catch(($, e, next) => next(e)) // a failure here never holds up the prompt: it goes on as typed

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const check = await read($, last)
    if (e.props.hasSurvey || !check || !(await read($, isOn))) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    if (check.status === 'checking') return <Text dimColor>Checking claims…</Text>
    if (check.status === 'failed') return <Text dimColor>Claim check failed: {check.error}</Text>
    // Not a failure: the mod's files changed and it reloaded while checking (it only happens while a mod is being edited).
    if (check.status === 'interrupted') return <Text dimColor>{INTERRUPTED}</Text>
    if (check.claims.length === 0 && check.settled === 0) return <Text dimColor>No checkable claims.</Text>

    // Backed claims are counted by the judge, not listed: add its count to any it listed anyway.
    const counts = VERDICTS.map(v => [v, check.claims.filter(c => c.verdict === v).length + (v === 'backed' ? check.settled : 0)] as const).filter(
      ([, n]) => n > 0,
    )
    const worst = verifiable(check)[0]
    const keys = verifiable(check).filter(c => c.priority === 1).length
    // The second line, small and dim: how long the check took, then the claim that matters most,
    // whole up to the line's end (a long one is cut there, not mid-word at a fixed count).
    const took = check.stats ? `${check.stats.gatherSeconds + check.stats.judgeSeconds} s` : ''
    const top = worst ? `${worst.verdict}${worst.priority === 1 ? ', key' : ''}: ${shown(worst)}` : ''
    const detail = [took, top].filter(Boolean).join(' · ')

    // Line one: the verdict counts, the buttons at its right end; line two: the detail.
    return (
      <Box flexDirection="column">
        <Box justifyContent="space-between" alignItems="center" columnGap={2}>
          <Text wrap="truncate-end">
            {keys > 0 ? <Text color="error">{`▲ ${keys} key · `}</Text> : null}
            {counts.map(([v, n], i) => (
              <Text color={COLOR[v]}>
                {i > 0 ? ' · ' : ''}
                {MARK[v]} {n} {v}
              </Text>
            ))}
          </Text>
          <Box columnGap={1} flexShrink={0}>
            {worst && !check.isFedBack ? <Button key="verify" label="Verify" onPress={() => verify($)} /> : null}
            <Button key="details" label="Details" dimColor onPress={() => void $.ui.open({ id: PANE, title: 'Claim check' })} />
          </Box>
        </Box>
        {detail !== '' ? (
          // marginTop: a desktop button is taller than a line of text; xs keeps Details off this line (no row on the terminal).
          <Box marginTop="xs">
            <Text dimColor size="footnote" wrap="truncate-end">
              {detail}
            </Text>
          </Box>
        ) : null}
      </Box>
    )
  })

  // The band's order: every other row first (the readings line on top), this mod's row last.
  on('ui.render', { component: 'AbovePromptList' }, async ($, e, next) => {
    const rows = e.props.rows
    const mine = rows.filter(row => row.plugin === NAME)
    if (mine.length === 0 || rows[rows.length - 1]?.plugin === NAME) return next(e)

    return next({ ...e, props: { ...e.props, rows: [...rows.filter(row => row.plugin !== NAME), ...mine] } })
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    if (!(await read($, isOn))) return <Text dimColor>Claim check is off. Turn it on in the Mods panel.</Text>
    const legend = (
      <Box flexDirection="column" marginTop={1}>
        <Text bold dimColor>
          What the marks mean
        </Text>
        {LEGEND.map(([v, meaning]) => (
          <Text>
            <Text color={COLOR[v]}>
              {MARK[v]} {v}
            </Text>
            <Text dimColor>{`  ${meaning}`}</Text>
          </Text>
        ))}
        <Text>
          <Text color="error">▲ key</Text>
          <Text dimColor>{'  you are likely to act on it; minor: an incidental detail'}</Text>
        </Text>
        <Text dimColor>Quoted text is the answer's own words; unquoted text is the judge's reading of a claim.</Text>
      </Box>
    )
    const check = await read($, last)
    if (!check || check.status !== 'done') {
      return (
        <Box flexDirection="column">
          <Text dimColor>{check?.status === 'checking' ? 'Checking claims…' : check?.status === 'interrupted' ? INTERRUPTED : 'No check yet.'}</Text>
          {legend}
        </Box>
      )
    }
    const turnId = check.turnId
    const order = check.claims
      .map((c, index) => ({ ...c, index }))
      .sort(byWeight)

    return (
      <Box flexDirection="column">
        {verifiable(check).length > 0 && !check.isFedBack ? (
          <Box marginBottom={1}>
            <Button key="verify-all" label="Verify flagged claims" variant="primary" onPress={() => verify($)} />
          </Box>
        ) : null}
        {check.settled > 0 ? (
          <Box marginBottom={1}>
            <Text color="success">
              ✓ {check.settled} claim{check.settled === 1 ? ' is' : 's are'} stated by this turn's tool output (counted, not listed).
            </Text>
          </Box>
        ) : null}
        {check.stats ? (
          <Box marginBottom={1}>
            <Text dimColor>
              Checked in {check.stats.gatherSeconds + check.stats.judgeSeconds} s (gathering evidence {check.stats.gatherSeconds} s, judge{' '}
              {check.stats.judgeSeconds} s). The judge read {Math.round(check.stats.promptChars / 1000)}k characters and wrote{' '}
              {check.stats.replyTokens} tokens.{check.stats.model ? ` The judge was ${check.stats.model} at ${check.stats.effort ?? DEFAULT_EFFORT} effort.` : ''}
              {check.stats.isCut ? ' Its reply was cut off, so some claims may be missing.' : ''}
            </Text>
          </Box>
        ) : null}
        {order.map(c => (
          <Box flexDirection="column" marginBottom={1}>
            <Text>
              <Text color={COLOR[c.verdict]}>
                {MARK[c.verdict]} {c.verdict}
              </Text>
              {TAG[c.priority] ? <Text color={c.priority === 1 ? 'error' : 'subtle'}> {TAG[c.priority]}</Text> : null}{' '}
              {shown(c)}
            </Text>
            {c.said ? <Text dimColor>  The judge's reading: {c.claim}</Text> : null}
            {c.source ? <Text dimColor>  {c.source}</Text> : null}
            {c.check ? <Text dimColor>  To check: {c.check}</Text> : null}
            {DIGGABLE.includes(c.verdict) && !c.isDug ? (
              <Box>
                <Button key={`dig-${c.index}`} label="Dig" onPress={() => dig($, turnId, c.index)} />
              </Box>
            ) : null}
          </Box>
        ))}
        {legend}
      </Box>
    )
  })
}

// ---- mods switch ----
// The Mods panel writes the names of the mods turned off to this file under
// HOME, and every mod of the family reads it; a mod not named there is on.
// A trimmed copy of the block the other mods carry (no quiet mode here).
const SWITCHES_FILE = '.claude/mods/state.json'
// How soon a switch flipped in any session reaches this one.
const SWITCH_POLL_MS = 1_500

// Reads the switch now, then keeps polling it.
async function watchSwitch($: EngineInterface): Promise<boolean> {
  const isNowOn = await refreshSwitch($)
  $.clock.every(SWITCH_POLL_MS, () => {
    void refreshSwitch($)
  })

  return isNowOn
}

// Reads the file only once its modification time moved; a file caught
// half-written fails to parse and is read again at the next poll.
async function refreshSwitch($: EngineInterface): Promise<boolean> {
  try {
    const home = await $.env.get('HOME')
    if (home === undefined || home === '') return await read($, isOn)
    const path = `${home.replace(/\/$/, '')}/${SWITCHES_FILE}`
    let isNowOn = true
    if (await $.fs.exists(path)) {
      const { mtimeMs } = await $.fs.stat(path)
      if (mtimeMs === (await read($, switchSeenAt))) return await read($, isOn)
      const data: unknown = JSON.parse(await $.fs.read(path))
      await update($, switchSeenAt, () => mtimeMs)
      const record = typeof data === 'object' && data !== null ? (data as { off?: unknown; modSettings?: unknown }) : {}
      const off = Array.isArray(record.off) ? record.off.filter((name): name is string => typeof name === 'string') : []
      isNowOn = !off.includes(NAME)
      const picked = picksIn(record.modSettings)
      if (JSON.stringify(picked) !== JSON.stringify(await read($, picks))) await update($, picks, () => picked)
    }
    if (isNowOn !== (await read($, isOn))) await update($, isOn, () => isNowOn)

    return isNowOn
  } catch (error) {
    $.ui.log(`${NAME}: could not read the mods switches: ${error instanceof Error ? error.message : String(error)}`, { to: 'debug' })

    return read($, isOn)
  }
}
// This mod's choices in the switches file (the Mods panel writes them under
// `modSettings`): the judge's model, and its effort when it is one of the five levels.
function picksIn(value: unknown): Picks {
  const all = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
  const mine = typeof all[NAME] === 'object' && all[NAME] !== null ? (all[NAME] as Record<string, unknown>) : {}
  const model = typeof mine.model === 'string' && mine.model.trim() !== '' ? mine.model.trim() : undefined
  const effort = EFFORTS.find(level => level === mine.effort)

  return { ...(model === undefined ? {} : { model }), ...(effort === undefined ? {} : { effort }) }
}
// ---- end of mods switch ----
