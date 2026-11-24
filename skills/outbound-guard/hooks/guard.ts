// outbound-guard's logic, with no engine in it: what a shell command sends out
// of this machine, and what in that text must not go.

// The user's own list, under the home folder: never in a repository, since it names clients.
export const CONFIG_FILE = '.claude/outbound-guard.json'

export type Config = {
  // Names that must not reach a guarded place (a client's, a person's): whole words, any case.
  terms: string[]
  // Where those names and e-mail addresses must not go: a host, or a host and an owner
  // ("github.com/me"), as `place` writes it.
  guarded: string[]
  // The logins a post may @-mention, in lower case: anyone else is notified only on the user's word.
  mentions: string[]
  // The active gh account stays as it is: `gh auth switch`, `login` and `logout` are refused.
  lockGhAccount: boolean
  // GitHub may merge a pull request into a guarded repository. Off, since GitHub signs the commits
  // of a merge it makes (merge, squash or rebase) with the account's e-mail address unless the
  // account keeps it private.
  allowGithubMerge: boolean
}

export const NO_CONFIG: Config = { terms: [], guarded: [], mentions: [], lockGhAccount: false, allowGithubMerge: false }

export function parseConfig(text: string): Config {
  const raw: unknown = JSON.parse(text)
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('it is not a JSON object')
  const list = (key: string): string[] => {
    const value = (raw as Record<string, unknown>)[key]
    if (value === undefined) return []
    if (!Array.isArray(value) || value.some(v => typeof v !== 'string')) throw new Error(`"${key}" is not a list of strings`)

    return (value as string[]).map(v => v.trim()).filter(v => v !== '')
  }
  const flag = (key: string): boolean => {
    const value = (raw as Record<string, unknown>)[key]
    if (value === undefined) return false
    if (typeof value !== 'boolean') throw new Error(`"${key}" is not true or false`)

    return value
  }

  return {
    terms: list('terms'),
    guarded: list('guarded').map(place),
    mentions: list('mentions').map(m => m.replace(/^@/, '').toLowerCase()),
    lockGhAccount: flag('lockGhAccount'),
    allowGithubMerge: flag('allowGithubMerge'),
  }
}

// A remote or a repository as one comparable string: host and path in lower case, with no
// scheme, user, ".git" or trailing slash. `git@github.com:me/x.git` is `github.com/me/x`.
export function place(url: string): string {
  return url
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .replace(/^[^@/]+@/, '')
    .replace(/^([^/:]+):(?!\d)/, '$1/')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '')
}

// Where a send goes is guarded when it lies under a guarded place. An unknown target counts as
// guarded whenever anything is: the check then costs a false alarm at worst, never a leak.
export const isGuarded = (target: string | undefined, config: Config) =>
  config.guarded.length > 0 && (target === undefined || config.guarded.some(g => target === g || target.startsWith(`${g}/`)))

// ---------------------------------------------------------------- the command

// A word as the shell reads it: `text` with quotes removed, `isLiteral` false when it holds a
// variable or a command substitution the shell would expand.
export type Word = { text: string; isLiteral: boolean }
type Segment = { words: Word[]; heredocs: string[] }

// The cheap test every Bash call goes through first: a command that names none of these sends nothing.
export const mayBeOutbound = (command: string) => /\b(?:gh|glab)\b|\bgit\b[\s\S]*\b(?:push|commit)\b/.test(command)

const closeParen = (s: string, open: number): number => {
  let depth = 0
  for (let k = open; k < s.length; k++) {
    const ch = s[k]
    if (ch === '\\') k++
    else if (ch === "'") {
      const end = s.indexOf("'", k + 1)
      if (end < 0) return s.length - 1
      k = end
    } else if (ch === '(') depth++
    else if (ch === ')' && --depth === 0) return k
  }

  return s.length - 1
}

// The command cut into simple commands at `&&`, `||`, `;`, `|`, `&`, newlines and parentheses,
// each a list of words. A here-document's body is no command: it is kept apart, with the command
// it feeds (`gh api --input - <<EOF`).
// ponytail: a shell reader for what agents write, not a full one: no aliases, no `eval`.
export function segments(command: string): Segment[] {
  const out: Segment[] = []
  let cur: Segment = { words: [], heredocs: [] }
  let text = ''
  let isLiteral = true
  let isInWord = false
  const pending: { tag: string; isTabbed: boolean; seg: Segment }[] = []
  const endWord = () => {
    if (isInWord) cur.words.push({ text, isLiteral })
    text = ''
    isLiteral = true
    isInWord = false
  }
  const endSegment = () => {
    endWord()
    if (cur.words.length > 0) out.push(cur)
    cur = { words: [], heredocs: [] }
  }
  const n = command.length
  let i = 0
  const readHeredocs = () => {
    for (const { tag, isTabbed, seg } of pending) {
      const body: string[] = []
      while (i < n) {
        const nl = command.indexOf('\n', i)
        const end = nl < 0 ? n : nl
        const line = command.slice(i, end)
        i = end + 1
        if ((isTabbed ? line.replace(/^\t+/, '') : line) === tag) break
        body.push(line)
      }
      seg.heredocs.push(body.join('\n'))
    }
    pending.length = 0
  }

  while (i < n) {
    const c = command[i] ?? ''
    const next = command[i + 1] ?? ''
    if (c === '\\') {
      if (next !== '\n') {
        text += next
        isInWord = true
      }
      i += 2
    } else if (c === "'") {
      const end = command.indexOf("'", i + 1)
      const stop = end < 0 ? n : end
      text += command.slice(i + 1, stop)
      isInWord = true
      i = stop + 1
    } else if (c === '"') {
      let j = i + 1
      while (j < n && command[j] !== '"') {
        const d = command[j] ?? ''
        if (d === '\\' && j + 1 < n) {
          text += command[j + 1]
          j += 2
        } else if (d === '$' && command[j + 1] === '(') {
          const k = closeParen(command, j + 1)
          text += command.slice(j, k + 1)
          isLiteral = false
          j = k + 1
        } else {
          if (d === '$' || d === '`') isLiteral = false
          text += d
          j++
        }
      }
      isInWord = true
      i = j + 1
    } else if (c === '$' && next === '(') {
      const k = closeParen(command, i + 1)
      text += command.slice(i, k + 1)
      isLiteral = false
      isInWord = true
      i = k + 1
    } else if (c === '`') {
      const end = command.indexOf('`', i + 1)
      const stop = end < 0 ? n : end
      text += command.slice(i, stop + 1)
      isLiteral = false
      isInWord = true
      i = stop + 1
    } else if (c === '#' && !isInWord) {
      const end = command.indexOf('\n', i)
      i = end < 0 ? n : end
    } else if (c === '\n') {
      endSegment()
      i++
      readHeredocs()
    } else if (c === ' ' || c === '\t') {
      endWord()
      i++
    } else if (c === '<' && next === '<' && command[i + 2] !== '<' && command[i - 1] !== '<') {
      endWord()
      let j = i + 2
      const isTabbed = command[j] === '-'
      if (isTabbed) j++
      while (command[j] === ' ' || command[j] === '\t') j++
      let tag = ''
      const q = command[j]
      if (q === "'" || q === '"') {
        const end = command.indexOf(q, j + 1)
        tag = command.slice(j + 1, end < 0 ? n : end)
        j = end < 0 ? n : end + 1
      } else {
        const m = /^[^\s;&|<>()]+/.exec(command.slice(j))
        tag = (m?.[0] ?? '').replace(/\\/g, '')
        j += m?.[0].length ?? 0
      }
      pending.push({ tag, isTabbed, seg: cur })
      cur.words.push({ text: '<<', isLiteral: true })
      i = j
    } else if (c === '&' && (command[i - 1] === '>' || next === '>')) {
      text += c // 2>&1, &>file: a redirection, not a separator
      isInWord = true
      i++
    } else if (c === ';' || c === '&' || c === '|' || c === '(' || c === ')') {
      endSegment()
      i += (c === '&' || c === '|') && next === c ? 2 : 1
    } else {
      if (c === '$') isLiteral = false
      text += c
      isInWord = true
      i++
    }
  }
  endSegment()

  return out
}

const RESERVED = new Set(['{', '}', '!', 'if', 'then', 'else', 'elif', 'do', 'while', 'until', 'time', 'command', 'builtin', 'exec', 'nohup'])
const ASSIGN = /^([A-Za-z_][A-Za-z0-9_]*)=/

const normalize = (path: string) => {
  const parts: string[] = []
  for (const p of path.split('/')) {
    if (p === '' || p === '.') continue
    if (p === '..') parts.pop()
    else parts.push(p)
  }

  return `/${parts.join('/')}`
}

type Scope = { dir: string | undefined; vars: ReadonlyMap<string, string>; home: string | undefined }

// A word as a full path, where the command lets it be known: its variables set earlier in the
// command (`S=/tmp/x; … "$S/a.md"`), `~` and `$HOME`, the folder a `cd` moved to. Undefined when not.
export function pathOf(word: Word, scope: Scope): string | undefined {
  let s = word.text
  if (/\$\(|`/.test(s)) return undefined
  if (!word.isLiteral) {
    let isUnknown = false
    s = s.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (_, name: string) => {
      const value = scope.vars.get(name) ?? (name === 'HOME' ? scope.home : undefined)
      if (value === undefined) isUnknown = true

      return value ?? ''
    })
    if (isUnknown) return undefined
  }
  if (s === '~' || s.startsWith('~/')) {
    if (scope.home === undefined) return undefined
    s = scope.home + s.slice(1)
  }
  if (!s.startsWith('/')) {
    if (scope.dir === undefined) return undefined
    s = `${scope.dir}/${s}`
  }

  return normalize(s)
}

// Each simple command with what it runs as (its words, past leading assignments and keywords)
// and where: the folder it runs in, followed through the command's `cd`s (undefined after a `cd`
// to a place the command does not show), and the variables set before it.
export function steps(command: string, cwd: string | undefined, home: string | undefined, depth = 0) {
  const vars = new Map<string, string>()
  let dir = cwd
  const out: { argv: Word[]; heredocs: string[]; scope: Scope }[] = []
  for (const seg of segments(command)) {
    let at = 0
    const words = seg.words
    while (at < words.length && RESERVED.has(words[at]?.text ?? '')) at++
    const assigned: [string, Word][] = []
    while (at < words.length && ASSIGN.test(words[at]?.text ?? '')) {
      const w = words[at] as Word
      const name = ASSIGN.exec(w.text)?.[1] ?? ''
      assigned.push([name, { text: w.text.slice(name.length + 1), isLiteral: w.isLiteral }])
      at++
    }
    if ((words[at]?.text ?? '') === 'env') {
      at++
      while (at < words.length && (/^-/.test(words[at]?.text ?? '') || ASSIGN.test(words[at]?.text ?? ''))) at += words[at]?.text === '-u' ? 2 : 1
    }
    const argv = words.slice(at)
    const scope: Scope = { dir, vars: new Map(vars), home }
    if (argv.length === 0) {
      // `S=/tmp/x` alone sets a variable for the rest of the command.
      for (const [name, value] of assigned) {
        const known = value.isLiteral ? value.text : pathOf(value, scope)
        if (known === undefined) vars.delete(name)
        else vars.set(name, known)
      }
      continue
    }
    const name = argv[0]?.text ?? ''
    if (name === 'cd' || name === 'pushd') {
      // `cd -P dir`, `cd -- dir`: the folder is the last word that is not an option.
      const to = argv.slice(1).filter(w => !/^-[A-Za-z]*$|^--$/.test(w.text)).at(-1)
      dir = to === undefined ? home : pathOf(to, scope)
      continue
    }
    // `bash -c '…'` runs its text as a command of its own.
    if (/^(?:ba|z|da)?sh$/.test(name.replace(/^.*\//, '')) && argv[1]?.text === '-c' && argv[2] !== undefined && depth < 2) {
      out.push(...steps(argv[2].text, dir, home, depth + 1))
      continue
    }
    out.push({ argv, heredocs: seg.heredocs, scope })
  }

  return out
}

// ---------------------------------------------------------------- what is sent

export type Text = { label: string; text: string }
export type Post = {
  kind: 'post'
  // How the command reads in a message: "gh pr comment".
  what: string
  dir: string | undefined
  // The repository it goes to, where the command names it ("github.com/me/app").
  target: string | undefined
  // Text written into the command: titles, and the values of fields that are not a body.
  texts: Text[]
  // Files whose text is sent: a body file, an --input, a gist's files.
  files: { label: string; path: string }[]
  // What is wrong before any text is read: a body written inline, a path the guard cannot find.
  problems: string[]
  // `gh pr merge`: GitHub makes the commits, signed with the account's e-mail address.
  isMerge?: boolean
}
// `gh auth switch`, `login` or `logout`: a change of the active account.
export type Account = { kind: 'account'; what: string }
// `git commit`: nothing leaves yet, but the commit is signed with the e-mail address git is set to.
export type Commit = { kind: 'commit'; what: string; dir: string | undefined }
export type Push = {
  kind: 'push'
  what: string
  dir: string | undefined
  // The remote as written (a name or a URL), or undefined for the branch's own.
  remote: string | undefined
  // What to list the commits of: refs, or `--branches` and `--tags`.
  revs: string[]
  // A repository `gh repo create --push` makes: where it goes, and that no remote has its commits yet.
  isNew?: { target: string | undefined }
}
export type Send = Post | Push | Account | Commit

const BODY_KEYS = new Set(['body', 'description', 'message', 'note', 'notes', 'comment', 'text'])
const FILE_SUBSTITUTION = /^\$\(\s*(?:cat\s+(?:--\s+)?|<\s*)(['"]?)([^'"()\s]+)\1\s*\)$/

// The value of an option: `--body x`, `--body=x`, `-b x`. Returns the value and how many words it took.
function optionValue(words: Word[], at: number, names: readonly string[]): { value: Word; used: number } | undefined {
  const w = words[at]?.text ?? ''
  for (const name of names) {
    if (w === name && words[at + 1] !== undefined) return { value: words[at + 1] as Word, used: 2 }
    if (name.startsWith('--') && w.startsWith(`${name}=`)) return { value: { text: w.slice(name.length + 1), isLiteral: words[at]?.isLiteral ?? true }, used: 1 }
  }

  return undefined
}

const repoPlace = (value: string, host: string) => {
  const p = place(value)

  return /^[^/]+\.[^/]+\//.test(p) ? p : `${host}/${p}`
}

// gh and glab: a pull or merge request, an issue, a release, a gist, a repository made with
// --push, and `api` calls that write. Anything else they do sends nothing worth a look.
function cliSend(argv: Word[], heredocs: string[], scope: Scope): Send | undefined {
  const cli = argv[0]?.text.replace(/^.*\//, '') ?? ''
  const host = cli === 'gh' ? 'github.com' : undefined
  const noun = argv[1]?.text ?? ''
  const verb = argv[2]?.text ?? ''
  const POSTS: Record<string, string[]> =
    cli === 'gh'
      ? { pr: ['create', 'edit', 'comment', 'review', 'merge', 'close', 'reopen'], issue: ['create', 'edit', 'comment', 'close', 'reopen'], release: ['create', 'edit'], gist: ['create', 'edit'] }
      : { mr: ['create', 'update', 'note', 'merge', 'close', 'reopen'], issue: ['create', 'update', 'note', 'close', 'reopen'], release: ['create'] }
  const post: Post = { kind: 'post', what: `${cli} ${noun} ${verb}`.trim(), dir: scope.dir, target: undefined, texts: [], files: [], problems: [] }
  const fileOf = (w: Word, label: string) => {
    const path = pathOf(w, scope)
    if (path === undefined) post.problems.push(`${label} is ${w.text}, a path the guard cannot resolve: write it as a literal path.`)
    else post.files.push({ label, path })
  }

  if (noun === 'api') return apiSend(cli, argv.slice(2), heredocs, scope, post)
  if (cli === 'gh' && noun === 'auth' && (verb === 'switch' || verb === 'login' || verb === 'logout')) return { kind: 'account', what: `gh auth ${verb}` }
  if (cli === 'gh' && noun === 'pr' && verb === 'merge') post.isMerge = true
  if (cli === 'gh' && noun === 'repo' && verb === 'create') {
    const words = argv.slice(3)
    if (!words.some(w => w.text === '--push')) return undefined
    // The repository's name is the first word, when it is not an option.
    const name = words[0]?.text.startsWith('-') === false ? words[0].text : undefined

    return { kind: 'push', what: 'gh repo create --push', dir: scope.dir, remote: undefined, revs: ['--branches'], isNew: { target: name?.includes('/') ? repoPlace(name, 'github.com') : undefined } }
  }
  if (!POSTS[noun]?.includes(verb)) return undefined

  const words = argv.slice(3)
  // Which flag carries a text depends on the verb: `gh pr review --comment` only says what kind of
  // review it is (its text is -b), and `glab mr merge -d` removes the source branch.
  const inlineBody =
    cli === 'gh'
      ? noun === 'release'
        ? ['--notes', '-n']
        : verb === 'close' || verb === 'reopen'
          ? ['--comment', '-c']
          : ['--body', '-b']
      : noun === 'release'
        ? ['--notes', '-N']
        : verb === 'create' || verb === 'update'
          ? ['--description', '-d']
          : ['--message', '-m']
  const fileBody = cli === 'gh' ? ['--body-file', '--notes-file', '-F'] : noun === 'release' ? ['--notes-file', '-F'] : []
  const titles = cli === 'gh' ? ['--title', '-t', '--subject', '--desc'] : ['--title', '-t']
  const repo = ['--repo', '-R']
  for (let at = 0; at < words.length; ) {
    const asFile = optionValue(words, at, fileBody)
    if (asFile) {
      if (asFile.value.text === '-') post.problems.push(`the body comes from standard input (${words[at]?.text} -): write it to a file, show it to the user, and pass the file.`)
      else fileOf(asFile.value, `the body file ${asFile.value.text}`)
      at += asFile.used
      continue
    }
    const inline = optionValue(words, at, inlineBody)
    if (inline) {
      const fromFile = cli === 'glab' ? FILE_SUBSTITUTION.exec(inline.value.text) : null
      if (fromFile) fileOf({ text: fromFile[2] ?? '', isLiteral: !/\$/.test(fromFile[2] ?? '') }, `the text file ${fromFile[2]}`)
      else
        post.problems.push(
          cli === 'gh'
            ? `the text of ${words[at]?.text} is written into the command: write it to a file, show it to the user, and pass --body-file <literal path>.`
            : `the text of ${words[at]?.text} is written into the command: write it to a file, show it to the user, and pass ${words[at]?.text} "$(cat <literal path>)".`,
        )
      at += inline.used
      continue
    }
    const title = optionValue(words, at, titles)
    if (title) {
      post.texts.push({ label: `the ${words[at]?.text?.replace(/^-+/, '').replace(/=.*$/, '')}`, text: title.value.text })
      at += title.used
      continue
    }
    const named = optionValue(words, at, repo)
    if (named) {
      post.target = host ? repoPlace(named.value.text, host) : /^[^/]+\.[^/]+\//.test(place(named.value.text)) ? place(named.value.text) : undefined
      at += named.used
      continue
    }
    // A gist's files are its text.
    if (noun === 'gist' && !(words[at]?.text ?? '').startsWith('-') && !/^(?:-d|--desc|-f|--filename)$/.test(words[at - 1]?.text ?? '')) fileOf(words[at] as Word, `the gist file ${words[at]?.text}`)
    at++
  }

  return post
}

// `gh api` and `glab api`: a call that writes (a method other than GET, or fields with none
// named). A body field written inline is refused like an inline --body; any other field is
// read as text; `-F key=@file` and `--input file` are files.
function apiSend(cli: string, words: Word[], heredocs: string[], scope: Scope, post: Post): Post | undefined {
  let method: string | undefined
  let path: string | undefined
  let hasFields = false
  const SKIP = new Set(['-H', '--header', '--jq', '-q', '--template', '-t', '--hostname', '--cache', '-p', '--preview'])
  for (let at = 0; at < words.length; at++) {
    const w = words[at]?.text ?? ''
    const value = words[at + 1]
    if ((w === '-X' || w === '--method') && value) {
      method = value.text.toUpperCase()
      at++
    } else if (w.startsWith('--method=')) method = w.slice(9).toUpperCase()
    else if ((w === '-f' || w === '--raw-field' || w === '-F' || w === '--field') && value) {
      hasFields = true
      const eq = value.text.indexOf('=')
      const key = value.text.slice(0, eq < 0 ? undefined : eq)
      const v = eq < 0 ? '' : value.text.slice(eq + 1)
      const isTyped = w === '-F' || w === '--field'
      if (isTyped && v === '@-') post.problems.push(`the field ${key} comes from standard input: write it to a file and pass ${w} ${key}=@<literal path>.`)
      else if (isTyped && v.startsWith('@')) {
        const p = pathOf({ text: v.slice(1), isLiteral: value.isLiteral }, scope)
        if (p === undefined) post.problems.push(`the field ${key} reads ${v.slice(1)}, a path the guard cannot resolve: write it as a literal path.`)
        else post.files.push({ label: `the file of field ${key}`, path: p })
      } else if (BODY_KEYS.has(key.toLowerCase()))
        post.problems.push(`the field ${key} is written into the command: write the text to a file and pass -F ${key}=@<literal path>, or --input <literal path>.`)
      else post.texts.push({ label: `the field ${key}`, text: v })
      at++
    } else if (w === '--input' && value) {
      hasFields = true
      if (value.text === '-') {
        post.problems.push('the request body comes from standard input (--input -): write it to a file, show it to the user, and pass --input <literal path>.')
        for (const h of heredocs) post.texts.push({ label: 'the here-document', text: h })
      } else {
        const p = pathOf(value, scope)
        if (p === undefined) post.problems.push(`--input is ${value.text}, a path the guard cannot resolve: write it as a literal path.`)
        else post.files.push({ label: `the input file ${value.text}`, path: p })
      }
      at++
    } else if (w.startsWith('--input=')) {
      hasFields = true
      const p = pathOf({ text: w.slice(8), isLiteral: words[at]?.isLiteral ?? true }, scope)
      if (p === undefined) post.problems.push(`--input is ${w.slice(8)}, a path the guard cannot resolve: write it as a literal path.`)
      else post.files.push({ label: `the input file ${w.slice(8)}`, path: p })
    } else if (SKIP.has(w)) at++
    else if (!w.startsWith('-') && path === undefined) path = w
  }
  // A GraphQL query is sent with POST and only reads; a mutation writes.
  const isQuery = path === 'graphql' && !post.texts.some(t => /\bmutation\b/.test(t.text)) && post.files.length === 0 && post.problems.length === 0
  const writes = !isQuery && (method !== undefined ? method !== 'GET' && method !== 'HEAD' : hasFields)
  if (!writes) return undefined
  const repo = /^\/?(?:repos|projects)\/([^/]+)\/([^/?]+)/.exec(path ?? '')
  post.what = `${cli} api ${method ?? 'POST'} ${path ?? ''}`.trim()
  // A path with gh's placeholders ({owner}/{repo}) names the folder's own repository: found from its remote.
  post.target = repo && cli === 'gh' && !`${repo[1]}${repo[2]}`.includes('{') ? `github.com/${repo[1]?.toLowerCase()}/${repo[2]?.toLowerCase()}` : undefined

  return post
}

// git push: what it sends is the commits its refs hold that the remote does not have yet.
// git commit: what it signs the commit with.
function gitSend(argv: Word[], scope: Scope): Push | Commit | undefined {
  let dir = scope.dir
  let at = 1
  while (at < argv.length && argv[at]?.text !== 'push') {
    const w = argv[at]?.text ?? ''
    if (w === '-C' && argv[at + 1]) {
      const to = pathOf(argv[at + 1] as Word, { ...scope, dir })
      dir = to
      at += 2
    } else if (w === '-c' || w === '--git-dir' || w === '--work-tree' || w === '--namespace') at += 2
    else if (w.startsWith('-')) at++
    else if (w === 'commit') break
    else return undefined // another subcommand
  }
  if (argv[at]?.text === 'commit') return argv.some(w => w.text === '--dry-run') ? undefined : { kind: 'commit', what: 'git commit', dir }
  if (argv[at]?.text !== 'push') return undefined
  const positional: string[] = []
  const revs: string[] = []
  let isDelete = false
  for (let k = at + 1; k < argv.length; k++) {
    const w = argv[k]?.text ?? ''
    if (w === '-n' || w === '--dry-run') return undefined
    if (w === '-d' || w === '--delete') isDelete = true
    else if (w === '--all' || w === '--branches' || w === '--mirror') revs.push('--branches', ...(w === '--mirror' ? ['--tags'] : []))
    else if (w === '--tags') revs.push('--tags')
    else if (w === '-o' || w === '--push-option' || w === '--receive-pack' || w === '--exec' || w === '--repo') k++
    else if (!w.startsWith('-')) positional.push(w)
  }
  if (isDelete) return undefined
  const [remote, ...given] = positional
  // `tag v1` is the tag's own ref.
  const refspecs = given.flatMap((spec, k) => (spec === 'tag' && given[k + 1] !== undefined ? [] : given[k - 1] === 'tag' ? [`refs/tags/${spec}`] : [spec]))
  for (const spec of refspecs) {
    const src = spec.replace(/^\+/, '').split(':')[0] ?? ''
    if (src !== '') revs.push(src)
  }
  if (revs.length === 0 && refspecs.length > 0) return undefined // only deletions (":branch")

  return { kind: 'push', what: 'git push', dir, remote, revs: revs.length > 0 ? revs : ['HEAD'] }
}

// Every send in a command, in order.
export function plan(command: string, cwd: string | undefined, home: string | undefined): Send[] {
  if (!mayBeOutbound(command)) return []
  const out: Send[] = []
  for (const { argv, heredocs, scope } of steps(command, cwd, home)) {
    const name = argv[0]?.text.replace(/^.*\//, '') ?? ''
    const send = name === 'gh' || name === 'glab' ? cliSend(argv, heredocs, scope) : name === 'git' ? gitSend(argv, scope) : undefined
    if (send) out.push(send)
  }

  return out
}

// ---------------------------------------------------------------- what must not go

// Keys by the shape their issuers give them: few false alarms, so a hit is worth a stop.
const SECRETS: [string, RegExp][] = [
  ['a GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})/],
  ['a GitLab token', /\bglpat-[A-Za-z0-9_-]{20,}/],
  ['an Anthropic key', /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ['an OpenAI key', /\bsk-(?!ant-)(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}/],
  ['an AWS access key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['a Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['a Google API key', /\bAIza[0-9A-Za-z_-]{35}/],
  ['a Stripe key', /\b(?:sk|rk)_live_[0-9A-Za-z]{20,}/],
  ['a private key', /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/],
  ['a password in a URL', /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@'"]+:[^\s/@'"]{6,}@/i],
]

// A line marked so (a test that builds a fake key, say) is not read. The README says so; a refusal does not.
const ALLOWED = /outbound-guard:\s*allow/

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g
// What only looks like an address: a file named for a screen density (logo@2x.png) is one.
export const isHarmlessEmail = (email: string) =>
  /(?:^git@|^noreply@|^no-reply@|@users\.noreply\.github\.com$|[@.]example\.(?:com|org|net)$|\.(?:local|test|invalid)$|\.(?:png|jpe?g|gif|svg|webp|ico|pdf|css|js|ts|tsx|json|md|html)$)/i.test(email)

// The first characters of a secret, enough to find it, never enough to use it.
const masked = (s: string) => `${s.slice(0, 4)}…`

const termPattern = (term: string) => new RegExp(`(?<![\\p{L}\\p{N}_])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}_])`, 'iu')

export type Rules = { config: Config; isGuarded: boolean }

// The findings the guarded list causes, by how they start: a refusal names the list only for these.
export const NAME_FINDING = 'the name'
export const EMAIL_FINDING = 'the e-mail address'
export const isListFinding = (finding: string) => finding.includes(`${NAME_FINDING} "`) || finding.includes(`${EMAIL_FINDING} `) || finding.includes('whose name holds "')

// What one line holds that must not go: keys always; where the place is guarded, the names
// on the list and e-mail addresses.
export function lineFindings(line: string, rules: Rules): string[] {
  if (ALLOWED.test(line)) return []
  const out: string[] = []
  for (const [what, re] of SECRETS) {
    const m = re.exec(line)
    if (m) out.push(`${what} (${masked(m[0])})`)
  }
  if (rules.isGuarded) {
    for (const term of rules.config.terms) if (termPattern(term).test(line)) out.push(`${NAME_FINDING} "${term}"`)
    for (const email of line.match(EMAIL) ?? []) if (!isHarmlessEmail(email)) out.push(`${EMAIL_FINDING} ${email}`)
  }

  return out
}

// Code spans and blocks: an @ there notifies nobody.
const withoutCode = (text: string) => text.replace(/```[\s\S]*?```/g, m => m.replace(/[^\n]/g, ' ')).replace(/`[^`\n]*`/g, m => ' '.repeat(m.length))
// A login: letters, digits and hyphens, and an underscore in an enterprise-managed one (me_corp).
const MENTION = /(^|[^\p{L}\p{N}_.\/@`-])@([A-Za-z0-9](?:[A-Za-z0-9_-]{0,38}))(?![\p{L}\p{N}_-]*@)/gu

// A post's text read line by line: an em dash, an @-mention not on the list, and what
// `lineFindings` finds. Each finding says where: "<label> line <n>: …".
export function textFindings(item: Text, rules: Rules): string[] {
  const out: string[] = []
  const plain = withoutCode(item.text).split('\n')
  item.text.split('\n').forEach((line, k) => {
    const at = `${item.label}${item.text.includes('\n') ? ` line ${k + 1}` : ''}`
    if (line.includes('\u2014')) out.push(`${at}: an em dash; write "-" instead.`)
    const mentioned = [...(plain[k] ?? '').matchAll(MENTION)].map(m => m[2] ?? '').filter(name => !rules.config.mentions.includes(name.toLowerCase()))
    if (mentioned.length > 0)
      out.push(`${at}: ${mentioned.map(m => `@${m}`).join(', ')} would be notified, and is not on the mention list: write the name in backticks unless the user wants them notified.`)
    for (const f of lineFindings(line, rules)) out.push(`${at}: ${f}.`)
  })

  return out
}

// A file's text as sent: the string values of a JSON file (what an API call posts, with its
// escapes read), else the text itself.
export function sentText(text: string): string {
  const t = text.trim()
  if (!t.startsWith('{') && !t.startsWith('[')) return text
  try {
    const strings: string[] = []
    const walk = (v: unknown) => {
      if (typeof v === 'string') strings.push(v)
      else if (Array.isArray(v)) v.forEach(walk)
      else if (v !== null && typeof v === 'object') Object.values(v).forEach(walk)
    }
    walk(JSON.parse(t))

    return strings.join('\n')
  } catch {
    return text
  }
}

// ---------------------------------------------------------------- a push's commits

// The format of the log the guard reads: each commit starts with \x01, its fields split by \x02.
export const LOG_FORMAT = '%x01%H%x02%ae%x02%ce%x02%B%x02'

// What the commits of a push add that must not go: lines of their diffs, file names, messages,
// and (where the place is guarded) the authors' and committers' addresses.
export function pushFindings(log: string, rules: Rules): string[] {
  const out: string[] = []
  for (const chunk of log.split('\x01').slice(1)) {
    const [sha = '', author = '', committer = '', message = '', diff = ''] = chunk.split('\x02')
    const short = sha.slice(0, 7)
    if (rules.isGuarded)
      for (const email of new Set([author, committer])) if (email !== '' && !isHarmlessEmail(email)) out.push(`commit ${short} is signed with the e-mail address ${email}.`)
    message.split('\n').forEach(line => {
      for (const f of lineFindings(line, rules)) out.push(`the message of commit ${short}: ${f}.`)
    })
    let file = ''
    let lineNo = 0
    for (const line of diff.split('\n')) {
      if (line.startsWith('+++ ')) {
        file = line.slice(4).replace(/^b\//, '')
        if (rules.isGuarded) for (const term of rules.config.terms) if (termPattern(term).test(file)) out.push(`commit ${short} adds the file ${file}, whose name holds "${term}".`)
      } else if (line.startsWith('@@')) lineNo = Number(/\+(\d+)/.exec(line)?.[1] ?? '1')
      else if (line.startsWith('+')) {
        for (const f of lineFindings(line.slice(1), rules)) out.push(`${file}:${lineNo} (commit ${short}): ${f}.`)
        lineNo++
      } else if (!line.startsWith('-') && !line.startsWith('\\')) lineNo++
    }
  }

  return out
}

// The text of a refusal: what is wrong, then what to do. The model reads it as the tool's error.
export function refusal(what: string, problems: readonly string[]): string {
  const unique = [...new Set(problems)]
  const shown = unique.slice(0, 10)

  return [
    `outbound-guard stopped this command before it ran (\`${what}\`): it breaks a rule for what leaves this machine.`,
    ...shown.map(p => `- ${p}`),
    ...(unique.length > shown.length ? [`- and ${unique.length - shown.length} more like these.`] : []),
    'Nothing was sent. Fix these and run it again. If one is a false alarm, tell the user and let them decide.',
  ].join('\n')
}
