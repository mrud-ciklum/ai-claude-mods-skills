import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { LOG_FORMAT, NO_CONFIG, lineFindings, parseConfig, place, plan, segments, textFindings } from './guard'

// Fake keys are put together here, so this file never holds a key's own shape.
const TOKEN = ['gh', 'p_'].join('') + 'Ab1Cd2Ef3'.repeat(4)
const JANE = ['jane', 'initech.io'].join('@')
const WORK = ['me', 'company.io'].join('@')
const CONFIG_PATH = '/home/u/.claude/outbound-guard.json'
const CONFIG = JSON.stringify({ terms: ['Initech'], guarded: ['github.com/me'], mentions: ['me', 'friend'] })

type Git = (argv: readonly string[]) => { exitCode?: number; stdout?: string; stderr?: string; isTruncated?: boolean } | 'fails'
type Caller = { tool: { call: (input: { tool: 'Bash'; command: string }) => Promise<unknown> } }

// The engine as the guard meets it: a home folder, a session folder, files, git, and Bash, which
// records what it was asked to run. `bash` answers the refusal's text, or undefined when the command ran.
function world(on: On, opts: { files?: Record<string, string>; config?: string | null; git?: Git } = {}) {
  const files = new Map(Object.entries(opts.files ?? {}))
  if (opts.config !== null) files.set(CONFIG_PATH, opts.config ?? CONFIG)
  const ran: string[] = []
  const gitCalls: string[][] = []
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home/u' : undefined }))
  on('session.cwd', () => ({ value: '/work/app' }))
  on('fs.read', (_, e) => (files.has(e.path) ? { value: files.get(e.path) ?? '' } : { deny: 'no such file' }))
  on('process.run', (_, e) => {
    gitCalls.push([...e.argv])
    const r = opts.git?.(e.argv) ?? { exitCode: 1, stderr: 'not a git repository' }
    if (r === 'fails') return { deny: 'git could not start' }

    return { value: { exitCode: r.exitCode ?? 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '', isStdoutTruncated: r.isTruncated ?? false, isStderrTruncated: false } }
  })
  on('tool.call', (_, e) => {
    ran.push(e.tool === 'Bash' ? e.command : e.tool)

    return { result: { stdout: '', stderr: '', interrupted: false } }
  })
  const bash = async ($: unknown, command: string): Promise<string | undefined> => {
    const r = (await ($ as Caller).tool.call({ tool: 'Bash', command })) as { deny?: string; isError?: boolean; text?: string }

    return r.deny ?? (r.isError === true ? (r.text ?? 'refused') : undefined)
  }

  return { ran, gitCalls, bash }
}

// git as a repository answers: its remotes, the branch's push remote, and the log of what a push sends.
const repo =
  (remotes: Record<string, string>, log: string): Git =>
  argv => {
    const i = argv.indexOf('get-url')
    if (i >= 0) {
      const url = remotes[argv[argv.length - 1] ?? '']

      return url === undefined ? { exitCode: 2, stderr: 'No such remote' } : { stdout: `${url}\n` }
    }
    if (argv.includes('@{push}')) return { stdout: 'origin/main\n' }
    if (argv.includes('log')) return { stdout: log }

    return { exitCode: 1, stderr: 'unexpected' }
  }

// One commit as `git log -p --format=LOG_FORMAT` prints it.
const commit = (opts: { sha?: string; email?: string; message?: string; file?: string; added: string[] }) =>
  LOG_FORMAT.replace('%x01', '\x01')
    .replace('%H', opts.sha ?? 'abc1234def')
    .replace('%x02%ae', `\x02${opts.email ?? 'me@users.noreply.github.com'}`)
    .replace('%x02%ce', `\x02${opts.email ?? 'me@users.noreply.github.com'}`)
    .replace('%x02%B', `\x02${opts.message ?? 'Add a thing'}\n`)
    .replace(/%x02$/, '\x02') +
  `\ndiff --git a/${opts.file ?? 'src/x.ts'} b/${opts.file ?? 'src/x.ts'}\n--- a/${opts.file ?? 'src/x.ts'}\n+++ b/${opts.file ?? 'src/x.ts'}\n@@ -1,2 +1,${2 + opts.added.length} @@\n line one\n${opts.added.map(a => `+${a}`).join('\n')}\n line two\n`

test('a command that sends nothing runs as it is, and no git is called for it', async ($, on) => {
  const w = world(on)
  for (const command of [
    'ls -la',
    'gh pr view 1 --json title',
    'git status && echo push',
    'git push --dry-run',
    'git push origin --delete old-branch',
    "cat > notes.md <<'EOF'\ngh pr comment 1 --body \"x\"\nEOF",
    'gh api repos/me/app/pulls/1 --jq .title',
    'glab mr merge 5 -d',
  ])
    expect(await w.bash($, command)).toBeUndefined()
  expect(w.ran).toHaveLength(8)
  expect(w.gitCalls.filter(c => c.includes('log'))).toEqual([])
})

test('a post whose text is written into the command is refused; one from a clean file goes', async ($, on) => {
  const w = world(on, { files: { '/tmp/b.md': 'Fixed in abc1234.\nThe tests pass.' }, git: repo({ origin: 'https://github.com/acme-corp/app.git' }, '') })
  const inline = await w.bash($, 'gh pr comment 1 --body "Looks good"')
  expect(inline).toContain('outbound-guard stopped this command')
  expect(inline).toContain('--body-file <literal path>')
  expect(await w.bash($, "gh pr comment 1 --body \"$(cat <<'EOF'\nhello\nEOF\n)\"")).toContain('written into the command')
  expect(await w.bash($, 'glab mr note 5 -m "hi"')).toContain('"$(cat <literal path>)"')

  expect(await w.bash($, 'gh pr comment 1 --body-file /tmp/b.md')).toBeUndefined()
  // A path the command builds from its own variables and `cd` is followed.
  expect(await w.bash($, 'S=/tmp; cd /work/app && gh pr comment 1 --body-file "$S/b.md"')).toBeUndefined()
  expect(await w.bash($, 'cd /tmp && gh pr review 1 --approve -F b.md')).toBeUndefined()
  expect(await w.bash($, 'glab mr note 5 -m "$(cat /tmp/b.md)"')).toBeUndefined()
  expect(w.ran).toHaveLength(4)

  expect(await w.bash($, 'gh pr comment 1 --body-file "$X/b.md"')).toContain('write it as a literal path')
  expect(await w.bash($, 'gh pr comment 1 --body-file /tmp/missing.md')).toContain('cannot be read')
})

test('a body file is read line by line: an em dash, a mention nobody approved, a key', async ($, on) => {
  const body = ['Thanks @friend and @stranger.', 'Install `@types/node` and mail noreply@anthropic.com.', 'Done \u2014 merged.', `token: ${TOKEN}`, `Ask ${JANE}.`].join('\n')
  const w = world(on, { files: { '/tmp/b.md': body } })
  const said = (await w.bash($, 'gh pr comment 1 -R acme-corp/app --body-file /tmp/b.md')) ?? ''
  expect(said).toContain('the body file /tmp/b.md line 1: @stranger would be notified')
  expect(said).not.toContain('@friend')
  expect(said).not.toContain('@types')
  expect(said).not.toContain('@anthropic')
  expect(said).toContain('line 3: an em dash')
  expect(said).toContain('line 4: a GitHub token (ghp_…)')
  expect(said).not.toContain(TOKEN) // the key itself is never repeated
  expect(said).not.toContain(JANE) // addresses count only where the place is guarded
  expect(w.ran).toEqual([])
})

test("a client's name and an e-mail address stop a post to a guarded place, and nowhere else", async ($, on) => {
  const body = `Shipped for Initech. Ask ${JANE}, or me@users.noreply.github.com.`
  const w = world(on, { files: { '/tmp/b.md': body }, git: repo({ origin: 'git@github.com:me/app.git' }, '') })
  const said = (await w.bash($, 'gh pr comment 1 -R me/app --body-file /tmp/b.md')) ?? ''
  expect(said).toContain('the name "Initech"')
  expect(said).toContain(`the e-mail address ${JANE}`)
  expect(said).not.toContain('noreply')
  expect(said).toContain('(github.com/me/app counts as guarded')
  expect(await w.bash($, 'gh pr comment 1 -R acme-corp/app --body-file /tmp/b.md')).toBeUndefined()
  // With no --repo, the folder's own remote says where the post goes.
  expect(await w.bash($, 'gh pr comment 1 --body-file /tmp/b.md')).toContain('the name "Initech"')
  // A title is text too.
  expect(await w.bash($, 'gh pr create -R me/app --title "Initech import" --body-file /tmp/clean.md')).toContain('the title: the name "Initech"')
})

test('an API call is checked by the text it posts, with JSON escapes read', async ($, on) => {
  const w = world(on, {
    files: { '/tmp/r.json': '{"body":"Done \\u2014 thanks"}', '/tmp/clean.md': 'Done - thanks' },
    git: repo({ origin: 'https://github.com/acme-corp/app.git' }, ''),
  })
  expect(JSON.parse('{"body":"Done \\u2014 thanks"}')).toEqual({ body: 'Done \u2014 thanks' }) // the file holds the escape, not the dash
  expect(await w.bash($, 'gh api repos/acme-corp/app/issues/1/comments -f body="hi"')).toContain('the field body is written into the command')
  expect(await w.bash($, 'gh api -X POST repos/acme-corp/app/pulls/1/comments/9/replies --input /tmp/r.json')).toContain('an em dash')
  expect(await w.bash($, 'gh api -X PATCH repos/acme-corp/app/pulls/comments/9 -F body=@/tmp/clean.md')).toBeUndefined()
  expect(await w.bash($, "gh api repos/acme-corp/app/issues/1/comments --input - <<'EOF'\n{\"body\":\"hi\"}\nEOF")).toContain('standard input')

  // A GraphQL query only reads; a mutation is checked like any post.
  expect(await w.bash($, "gh api graphql -f query='query { viewer { login } }'")).toBeUndefined()
  expect(await w.bash($, "gh api graphql -f query='mutation { addComment(input: {body: \"Done \u2014 ok\"}) { clientMutationId } }'")).toContain('an em dash')
})

test('a review says its kind with --comment and its text with -b', async ($, on) => {
  const w = world(on, { files: { '/tmp/b.md': 'ok' }, git: repo({ origin: 'https://github.com/acme-corp/app.git' }, '') })
  expect(await w.bash($, 'gh pr review 1 --comment --body-file /tmp/b.md')).toBeUndefined()
  expect(await w.bash($, 'gh pr review 1 --comment -b "ok"')).toContain('the text of -b is written into the command')
  expect(await w.bash($, 'gh pr close 1 -c "dup"')).toContain('the text of -c is written into the command')
})

test('a push is checked by the commits the remote does not have yet', async ($, on) => {
  let remotes: Record<string, string> = { origin: 'git@github.com:me/app.git' }
  let log = commit({ added: ["const client = 'Initech'"] })
  const w = world(on, { git: argv => repo(remotes, log)(argv) })

  const said = (await w.bash($, 'cd /work/app && git push')) ?? ''
  expect(said).toContain('src/x.ts:2 (commit abc1234): the name "Initech"')
  const listed = w.gitCalls.find(c => c.includes('log')) ?? []
  expect(listed.slice(0, 3)).toEqual(['git', '-C', '/work/app'])
  expect(listed.slice(-3)).toEqual(['HEAD', '--not', '--remotes=origin'])

  // The same commit to a place that is not guarded goes.
  remotes = { origin: 'https://gitlab.example.com/team/app.git' }
  expect(await w.bash($, 'git push -u origin main')).toBeUndefined()

  // A key stops a push to any place.
  log = commit({ added: [`key = "${TOKEN}"`] })
  expect(await w.bash($, 'git push origin main')).toContain('src/x.ts:2 (commit abc1234): a GitHub token')

  // To a guarded place, a commit signed with a real address stops it, and so does a name in its message.
  remotes = { origin: 'https://github.com/me/app' }
  log = commit({ email: WORK, message: 'Port the Initech importer', added: ['ok'] })
  const signed = (await w.bash($, 'git -C /work/app push')) ?? ''
  expect(signed).toContain(`commit abc1234 is signed with the e-mail address ${WORK}`)
  expect(signed).toContain('the message of commit abc1234: the name "Initech"')
  // A file named for a screen density is no address, and a key's own issuer is named once.
  log = commit({ added: ['<img src="logo@2x.png">', `k = "${['sk', 'ant', 'api03'].join('-')}-${'Ab1'.repeat(12)}"`] })
  const one = (await w.bash($, 'git push')) ?? ''
  expect(one).not.toContain('logo@2x.png')
  expect(one).toContain('an Anthropic key')
  expect(one).not.toContain('an OpenAI key')
  // The guarded list is named only for what the list caused.
  expect(one).not.toContain('counts as guarded')
  // A line marked for the guard is not read.
  log = commit({ added: [`const fake = '${TOKEN}' // outbound-guard: allow`] })
  expect(await w.bash($, 'git push')).toBeUndefined()
})

test('gh repo create --push sends the whole history, and the guard reads all of it', async ($, on) => {
  const w = world(on, { git: repo({}, commit({ added: ['Initech'] })) })
  expect(await w.bash($, 'gh repo create me/new --public --source . --push')).toContain('the name "Initech"')
  // Its name says where it goes: another owner is not guarded.
  expect(await w.bash($, 'gh repo create acme-corp/tool --private --source . --push')).toBeUndefined()
  const listed = w.gitCalls.find(c => c.includes('log')) ?? []
  expect(listed).not.toContain('--not')
  expect(listed).toContain('--branches')
})

test('a guarded push the guard cannot read is refused; elsewhere it goes on', async ($, on) => {
  let remotes: Record<string, string> = { origin: 'https://github.com/me/app' }
  const w = world(on, { git: argv => (argv.includes('log') ? 'fails' : repo(remotes, '')(argv)) })
  expect(await w.bash($, 'git push')).toContain('could not read what this push sends')
  remotes = { origin: 'https://gitlab.example.com/team/app' }
  expect(await w.bash($, 'git push')).toBeUndefined()
  // A cd the guard cannot follow leaves it not knowing the repository.
  expect(await w.bash($, 'cd "$WHERE" && git push')).toContain('cannot tell which repository')
})

test('with no list, keys and inline bodies are still caught; a broken list stops what it would check', async ($, on) => {
  const files = { '/tmp/b.md': `Initech ${TOKEN}` }
  const none = world(on, { config: null, files })
  const said = (await none.bash($, 'gh pr comment 1 -R me/app --body-file /tmp/b.md')) ?? ''
  expect(said).toContain('a GitHub token')
  expect(said).not.toContain('Initech')
  expect(parseConfig(CONFIG)).toEqual({ terms: ['Initech'], guarded: ['github.com/me'], mentions: ['me', 'friend'], lockGhAccount: false, allowGithubMerge: false })
  expect(() => parseConfig('{"lockGhAccount": "yes"}')).toThrow('"lockGhAccount" is not true or false')
  expect(() => parseConfig('{"terms": "Initech"}')).toThrow('"terms" is not a list of strings')
})

test('a broken list is named in the refusal', async ($, on) => {
  const w = world(on, { config: '{"terms": "Initech"}', files: { '/tmp/b.md': 'ok' } })
  expect(await w.bash($, 'gh pr comment 1 --body-file /tmp/b.md')).toContain('outbound-guard.json cannot be read ("terms" is not a list of strings)')
  expect(await w.bash($, 'ls')).toBeUndefined()
})

test('bash -c and a subshell are read like any command', async ($, on) => {
  const w = world(on)
  expect(await w.bash($, "bash -c 'gh pr comment 1 --body hi'")).toContain('written into the command')
  expect(await w.bash($, '(cd /work/app && gh pr comment 1 -b hi)')).toContain('written into the command')
})

test('switched off in the Mods panel, it lets every command through', async ($, on) => {
  const switches = '/home/u/.claude/mods/state.json'
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('fs.exists', (_, e) => ({ value: e.path === switches }))
  on('fs.stat', () => ({ value: { kind: 'file', size: 40, mtimeMs: 1, isLink: false } }))
  const w = world(on, { files: { [switches]: '{"off":["outbound-guard"]}' } })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect(await w.bash($, 'gh pr comment 1 --body "inline"')).toBeUndefined()
  expect(w.ran).toEqual(['gh pr comment 1 --body "inline"'])
})

test('with the account locked, gh auth switch, login and logout are refused', async ($, on) => {
  const w = world(on, { config: JSON.stringify({ lockGhAccount: true }) })
  expect(await w.bash($, 'gh auth switch --user other')).toContain('the active gh account stays as it is')
  expect(await w.bash($, 'gh auth logout -u me')).toContain('lockGhAccount')
  expect(await w.bash($, 'gh auth status')).toBeUndefined()
  expect(await w.bash($, 'GH_TOKEN="$(gh auth token --user me)" gh pr view 1')).toBeUndefined()
})

test('with the account not locked, gh auth switch goes', async ($, on) => {
  const w = world(on, { config: JSON.stringify({}) })
  expect(await w.bash($, 'gh auth switch --user other')).toBeUndefined()
})

test("GitHub's own merge of a guarded repository is refused: it signs the commits with the account's address", async ($, on) => {
  const w = world(on, { git: repo({ origin: 'https://github.com/me/app.git' }, '') })
  expect(await w.bash($, 'gh pr merge 3 --rebase')).toContain('Merge locally instead')
  expect(await w.bash($, 'gh pr merge 3 -R acme-corp/app --squash')).toBeUndefined()
})

test('with allowGithubMerge, GitHub may merge a guarded repository', async ($, on) => {
  const w = world(on, { config: JSON.stringify({ guarded: ['github.com/me'], allowGithubMerge: true }), git: repo({ origin: 'https://github.com/me/app.git' }, '') })
  expect(await w.bash($, 'gh pr merge 3 --rebase')).toBeUndefined()
})

test('a commit in a guarded repository must be signed with a noreply address', async ($, on) => {
  let email = 'me@company.example.org'
  const w = world(on, {
    git: argv => (argv.includes('user.email') ? { stdout: `${email}\n` } : repo({ origin: 'git@github.com:me/app.git' }, '')(argv)),
  })
  expect(await w.bash($, 'cd /work/app && git commit -qm "x"')).toBeUndefined() // example.org is no one's real address
  email = ['me', 'company.io'].join('@')
  expect(await w.bash($, 'cd /work/app && git commit -qm "x"')).toContain('set git config user.email in this repository to a noreply address')
  email = '1+me@users.noreply.github.com'
  expect(await w.bash($, 'git -C /work/app commit -qam "x"')).toBeUndefined()
  expect(await w.bash($, 'git commit --dry-run')).toBeUndefined()
})

test('glab: a description written into the command is refused; one read from a file goes, and an API write is read', async ($, on) => {
  const w = world(on, { files: { '/tmp/d.md': 'Fixes the import.' }, git: repo({ origin: 'https://gitlab.example.com/team/app.git' }, '') })
  expect(await w.bash($, 'glab mr create -t "Import" -d "Fixes the import"')).toContain('the text of -d is written into the command')
  expect(await w.bash($, 'glab mr create -t "Import" -d "$(cat /tmp/d.md)"')).toBeUndefined()
  expect(await w.bash($, 'glab api -X POST projects/1/issues -f description="x"')).toContain('the field description is written into the command')
  expect(await w.bash($, 'glab api -X PUT projects/1/merge_requests/2 --input /tmp/d.md')).toBeUndefined()
})

test('the reader: places, here-documents, here-strings and marked lines', () => {
  expect(place('git@github.com:Me/App.git')).toBe('github.com/me/app')
  expect(place('https://user@gitlab.example.com/team/app/')).toBe('gitlab.example.com/team/app')
  expect(place('ssh://git@github.com:22/me/app')).toBe('github.com:22/me/app')
  expect(segments("cat > a.md <<'EOF' && gh pr comment 1 --body-file a.md\nline with gh pr comment -b x\nEOF").map(s => s.words.map(w => w.text)[0])).toEqual(['cat', 'gh'])
  expect(segments('grep x <<< "gh pr comment -b y"').map(s => s.words.length)).toEqual([4])
  // `cd` with options, and a tag pushed by its keyword.
  // Redirections are not refs: what the push sends is HEAD.
  expect(plan('git push -q origin main 2>&1 | grep -v remote', '/w', '/h')).toEqual([{ kind: 'push', what: 'git push', dir: '/w', remote: 'origin', revs: ['main'] }])
  expect(plan('git push > /tmp/push.log 2> /tmp/err.log', '/w', '/h')).toEqual([{ kind: 'push', what: 'git push', dir: '/w', remote: undefined, revs: ['HEAD'] }])
  expect(plan('cd -P /work/other && git push origin tag v1', '/w', '/h')).toEqual([{ kind: 'push', what: 'git push', dir: '/work/other', remote: 'origin', revs: ['refs/tags/v1'] }])
  expect(plan('echo "gh pr comment 1 -b x"', '/w', '/h')).toEqual([])
  expect(lineFindings(`x = '${TOKEN}' // outbound-guard: allow`, { config: NO_CONFIG, isGuarded: false })).toEqual([])
  // An enterprise-managed login holds an underscore, and is read whole.
  const listed = { config: { ...NO_CONFIG, mentions: ['me_corp'] }, isGuarded: false }
  expect(textFindings({ label: 'the body', text: 'Thanks @me_corp.' }, listed)).toEqual([])
  expect(textFindings({ label: 'the body', text: 'Thanks @me_other.' }, listed)[0]).toContain('@me_other would be notified')
})
