# outbound-guard

A Claude Code mod that stops a command before it sends text out of this machine, when that text
breaks a rule. It reads every Bash call; one that sends nothing, which is most of them, goes on
after one regular expression.

When it stops a command, the model gets the reasons as the tool's error. It fixes the text and runs
the command again, or asks you.

## What it stops

Posts: `gh pr`, `gh issue`, `gh release`, `gh gist`, a `gh api` or `glab api` call that writes,
`glab mr`, `glab issue`, `glab release`.

- A text written into the command: `--body "..."`, `-b "..."`, `-f body=...`, `--input -` with a
  here-document, `--body "$(cat <<EOF ...)"`. The text has to come from a file:
  `--body-file <path>`, `-F body=@<path>`, `--input <path>`; for glab, `-m "$(cat <path>)"`.
  A title may stay in the command.
- A file path the guard cannot resolve, such as a variable it does not see being set.
- In the text: an em dash; an @-mention of a login that is not on your list (in backticks it
  notifies nobody, so it is fine); a key.
- When the post goes to a guarded place: a name on your list, or an e-mail address. Noreply and
  `example.com` addresses are fine.

A GraphQL query sent with `gh api graphql` only reads, so it goes; a mutation is checked like a post.

Pushes: `git push`, and `gh repo create --push`, which pushes the whole history.

- The guard reads the commits the remote does not have yet: their added lines, file names and
  messages.
- A key stops a push to any place.
- When the push goes to a guarded place, a name on your list, an e-mail address, or a commit signed
  with a real e-mail address stops it too.

Other commands:

- `git commit` in a guarded repository, while git is set to sign it with a real e-mail address:
  the address would go out with the next push.
- `gh pr merge` into a guarded repository. GitHub signs the commits of a merge it makes (merge,
  squash or rebase) with the account's e-mail address unless the account keeps it private. Merge
  locally and push instead, or set `allowGithubMerge` once the account's address is private.
- `gh auth switch`, `login` and `logout`, when `lockGhAccount` is set: the active account stays as
  it is, and one command can use another account with `GH_TOKEN="$(gh auth token --user <login>)"`.

## Your list

`~/.claude/outbound-guard.json` is yours and never goes in a repository, since it names clients:

```json
{
  "terms": ["Acme"],
  "guarded": ["github.com/your-login"],
  "mentions": ["your-login"],
  "lockGhAccount": true,
  "allowGithubMerge": false
}
```

- `terms`: names that must not reach a guarded place. Whole words, any case.
- `guarded`: a host, or a host and an owner. Anything under it is guarded. A post whose target the
  guard cannot work out counts as guarded.
- `mentions`: the logins a post may @-mention.
- `lockGhAccount`: refuse `gh auth switch`, `login` and `logout`. Off unless set.
- `allowGithubMerge`: let GitHub merge pull requests into a guarded repository. Off unless set.

With no file, keys, inline texts, em dashes and mentions are still checked, and no place is
guarded. A file that is not valid JSON of this shape stops every post and push until it is
fixed; the refusal names the problem.

## Keys it knows

GitHub, GitLab, Anthropic, OpenAI, AWS, Slack, Google API and Stripe keys, private key blocks, and
passwords in URLs. A line that holds `outbound-guard: allow` is skipped, for a test that builds a
fake key.

## Limits

- It sees commands the model runs through Bash, including `bash -c '...'`. A script that posts on
  its own (Python calling the API, a shell script file), `eval` and aliases are not seen.
- It does not check that you approved the post. That stays your word in the chat.
- A push it cannot read (git fails, or the changes are over 4 MiB) is refused when it goes to a
  guarded place, and goes on with a notice anywhere else.
- An added line that itself begins with `++` reads as a diff header and is skipped.
- A command with no `cd` or `-C` of its own is read as running in the session's folder.
- Switch it off under Outbound guard in the Mods panel.

## Measured

On one machine's 80 newest transcripts, read on 24 November 2026 with this version's reader: 3,432
Bash commands named gh, glab or git push. 1,678 of them sent something: 1,507 posts and 265 pushes.
134 of the posts had their text written into the command and would have been stopped before any
file was read. Whether the files of the rest held an em dash, a mention or a name was not measured:
most of those files are gone.

## Develop

```bash
claude plugin validate .
```

```bash
claude plugin test .
```

`hooks/guard.ts` holds the logic, which needs no engine. `hooks/register.tsx` holds the hook and
the Mods panel switch.
