// bash-guard's rules, with no engine in them: what in a shell command would run for minutes
// for nothing, and what a long background run must start with.

// A file this large is not read whole by a search or a print: it takes minutes and floods the context.
export const BIG_FILE_BYTES = 100 * 1024 * 1024

// The commands that read their files whole.
const READERS = /^(?:grep|egrep|fgrep|rg|ag|ack|awk|gawk|sed|cat|less|more|jq|strings|sort|uniq|wc)$/

// A here-document's body is text, not a command: it is set aside before the command is read.
export const withoutHeredocs = (command: string) =>
  command.replace(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[^\n]*\n[\s\S]*?\n\s*\2\s*(?=\n|$)/g, '<<heredoc')

// The simple commands of a command line: cut at && || ; | and newlines. Quotes are not followed:
// a separator inside quotes cuts there too, which can only make a part look shorter.
export const parts = (command: string) =>
  withoutHeredocs(command)
    .split(/&&|\|\||[;|\n]/)
    .map(part => part.trim())
    .filter(part => part !== '')

// A part's words as the shell splits them: quoted runs joined to what touches them
// ("$X"/a is one word), the quotes taken off.
const words = (part: string) => part.match(/(?:"[^"]*"|'[^']*'|[^\s"'])+/g)?.map(w => w.replace(/(["'])(.*?)\1/g, '$2')) ?? []

// The home folder or the disk's root, as a command may name them.
const isWideRoot = (path: string, home: string | undefined) =>
  path === '/' || path === '~' || path === '~/' || path === '$HOME' || path === '${HOME}' || path === '$HOME/' || (home !== undefined && (path === home || path === `${home}/`))

// Why the command would run for minutes, one reason per finding; none when it is fine.
export function heavyReasons(command: string, home: string | undefined): string[] {
  const out: string[] = []
  for (const part of parts(command)) {
    const argv = words(part)
    const name = (argv[0] ?? '').replace(/^.*\//, '')
    // The binary itself, not a path built from it (a file next to it is a file like any other).
    const isBinary = (w: string) => /^\$\{?CLAUDE_CODE_EXECPATH\}?$/.test(w)
    if (READERS.test(name) && argv.some(w => isBinary(w) || /\.app\/Contents\/(?:MacOS|Resources)\//.test(w)))
      out.push(`\`${name}\` reads the Claude Code binary or an app bundle, hundreds of megabytes: it runs for minutes. Read the docs or the types the CLI writes instead.`)
    const isRecursive = name === 'rg' || name === 'ag' || ((name === 'grep' || name === 'egrep') && argv.some(w => /^-[A-Za-z]*[rR][A-Za-z]*$|^--recursive$|^--dereference-recursive$/.test(w)))
    if (isRecursive && argv.slice(1).some(w => isWideRoot(w, home)))
      out.push(`\`${name}\` searches the whole ${argv.slice(1).some(w => w === '/') ? 'disk' : 'home folder'}: it runs for minutes. Search the folder that holds the answer.`)
    if (name === 'find' && argv[1] !== undefined && isWideRoot(argv[1], home) && !argv.includes('-maxdepth'))
      out.push(`\`find\` walks the whole ${argv[1] === '/' ? 'disk' : 'home folder'} with no -maxdepth: it runs for minutes. Start from the folder that holds the answer, or add -maxdepth.`)
  }

  return out
}

// The files a command would read whole, as written: the arguments of a reader that are not
// options. A command piped into `head` reads only what head takes, so its parts are left out.
export function readFiles(command: string): string[] {
  const out: string[] = []
  const all = parts(command)
  const isHeaded = /\|\s*head\b/.test(withoutHeredocs(command))
  if (isHeaded) return out
  for (const part of all) {
    const argv = words(part)
    const name = (argv[0] ?? '').replace(/^.*\//, '')
    if (!READERS.test(name)) continue
    // The first word of grep, rg, awk, sed and jq is their pattern or program, not a file.
    const takesProgram = /^(?:grep|egrep|fgrep|rg|ag|ack|awk|gawk|sed|jq)$/.test(name)
    let isProgramSeen = !takesProgram
    for (const w of argv.slice(1)) {
      if (w.startsWith('-')) continue
      if (!isProgramSeen) {
        isProgramSeen = true
        continue
      }
      if (!/[<>$`*?]/.test(w.replace(/^\$\{?HOME\}?/, '~'))) out.push(w)
    }
  }

  return out
}

// A file named in the command as a full path: `~` and `$HOME` read as the home folder, a
// relative name from the folder the command starts in.
export function fullPath(name: string, home: string | undefined, cwd: string | undefined): string | undefined {
  const n = name.replace(/^\$\{?HOME\}?/, '~')
  if (n === '~' || n.startsWith('~/')) return home === undefined ? undefined : `${home}${n.slice(1)}`
  if (n.startsWith('/')) return n
  if (cwd === undefined || n.startsWith('$')) return undefined

  return `${cwd.replace(/\/$/, '')}/${n.replace(/^\.\//, '')}`
}

// A long run: tests, a benchmark, a migration, an ingest or a training.
const LONG_RUN = /\b(?:pytest|plugin\s+test|(?:npm|pnpm|yarn)\s+(?:run\s+)?test|go\s+test|cargo\s+test|bench(?:mark)?s?|migrat(?:e|ion)s?|ingest\w*|train(?:ing)?)\b/i
const FAILS_LOUD = /\bset\s+-[a-z]*e[a-z]*\b|\bset\s+-o\s+errexit\b/
const NAMES_COMMIT = /\bgit\b[^\n|;&]*\brev-parse\b|\bgit\s+log\s+-1\b|\bgit\s+describe\b/

// Why a background run must not start as written: a long run that hides a failure, or whose result names no commit.
export function preflightReasons(command: string): string[] {
  const text = withoutHeredocs(command)
  if (!LONG_RUN.test(text)) return []
  const missing = [...(FAILS_LOUD.test(text) ? [] : ['`set -euo pipefail`, so a failure is not hidden by a pipe']), ...(NAMES_COMMIT.test(text) ? [] : ['the git SHA (`git rev-parse --short HEAD`), so the result names its commit'])]

  return missing.length === 0 ? [] : [`this background run of tests, a benchmark or a migration starts without ${missing.join(' and without ')}. Start it with: set -euo pipefail; git rev-parse --short HEAD; then the run.`]
}

export function refusal(reasons: readonly string[]): string {
  return ['bash-guard stopped this command before it ran:', ...reasons.map(r => `- ${r}`), 'Change the command and run it again. If it has to run as it is, tell the user, who can switch Bash guard off in the Mods panel.'].join('\n')
}
