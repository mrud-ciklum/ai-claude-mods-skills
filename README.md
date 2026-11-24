# claude-mods-skills

Claude Code mods and skills.

- **Mods:** a band of readings above the prompt (context, limits, forecast, the Mac, git), a
  Mods panel that turns each one on and off, `claim-check`, which has a second model check
  every answer's claims against the session's evidence, and `outbound-guard`, which stops a post
  or a push whose text breaks a rule.
- **Skills:** `arch-atlas`, which builds a verified, code-anchored map of a project's
  architecture.

Each folder under `skills/` is one mod or one skill. Claude Code loads every folder in
`~/.claude/skills/`: a mod (it has a `.claude-plugin/plugin.json`) as a plugin, a skill (it has
a `SKILL.md`) as a skill. Installing means linking these folders there.

## The mods

| # | Folder | Group | Title | What it does |
| --- | --- | --- | --- | --- |
| 0 | `mods` | - | Mods | This panel: turns mods on and off in every session |
| 1 | `context-band` | Readings | Context band | Context, Compact, the task and runners above the prompt |
| 2 | `mod-limits` | Readings | Subscription limits | The 5-hour and weekly limits: how much is used and when they reset |
| 3 | `mod-forecast` | Readings | Context forecast | Steps left to auto-compact, a sparkline of the fill and what the last step took |
| 4 | `mod-sessions` | Readings | Sessions | Every live session: task, context, who waits for you; a report, a summary and what happened while you were away |
| 5 | `mod-machine` | Readings | Mac | Free memory and agent slots from the launch gate, free disk space |
| 6 | `mod-git` | Readings | Git and PR | The branch, its changes, how far ahead and behind; the branch's PR with checks, review and open review threads |
| 7 | `mod-quiet-tools` | Conversation | Quiet service calls | Hides task_progress and runner_info calls from the conversation: the band shows them anyway |
| 8 | `mod-tool-groups` | Conversation | Tool groups in one line | "read 6 files · 2 searches · 1 command" instead of a column of rows; a click opens it |
| 9 | `mod-runner-cards` | Conversation | Runner cards | A background launch shows as a card with its live state and a progress bar |
| 10 | `mod-turn-stats` | Readings | Turn summary | Under each answer: how long the turn took, the context it added and the tools it ran |
| 11 | `mod-task-spinner` | Conversation | Spinner with the task step | While the model works, the spinner shows the task step and percent |
| 12 | `mod-fold-output` | Conversation | Fold long output | Long command output folds to a few lines and a "show all" button |
| 13 | `mod-compact-marks` | Readings | Compact marks | After a compaction, the context before and after: "context 82% → 31%" |
| 14 | `mod-prompt-hints` | Readings | Prompt hints | Under the prompt: "context 82% - press Compact", "2 sessions waiting for you", "runner died" |
| 15 | `mod-mode-badge` | Readings | Mode badge | One colored badge by the prompt: model, effort and session modes |
| 16 | `mod-mission` | Readings | Overview (Mission Control) | Everything in one place: context over time, limits, every session's runners on a timeline, sessions, Mac and PR - with charts |
| 17 | `claim-check` | Checks | Claim check | After each answer, a second model checks its claims against the session's evidence; doubtful ones show above the prompt |
| 18 | `outbound-guard` | Guards | Outbound guard | Stops a post or a push whose text breaks a rule: an inline body, an em dash, an unapproved @-mention, a key, a client's name in a public repository |
| 19 | `bash-guard` | Guards | Bash guard | Stops a command that would hang on a huge file, a binary or the whole disk, and a background test run without set -euo pipefail and a git SHA |
| 20 | `agent-preview` | Guards | Agent preview | Shows a background agent's or a workflow's prompt and launches it only when you press Launch |
| 21 | `retry-stop` | Guards | Retry stop | Refuses the third run of a command that failed twice in a row with no edit between |
| 22 | `resume-card` | Readings | Resume card | At the start of a session, the last session in this folder: what it did and what it left open |
| 23 | `cost-meter` | Readings | Side-model cost | Today's model calls made by mods: tokens and time per mod, with a daily cap that stops them |
| 24 | `test-watch` | Checks | Test watch | After a turn that edited a mod's files, runs that mod's tests and shows the result above the prompt |

The Mods panel lists them by group: Readings (above the prompt), Conversation (how the
conversation looks), Checks (of the answers) and Guards (of what leaves the machine).

## The skills

| Folder | What it does |
| --- | --- |
| `arch-atlas` | Builds a grounded, interactive atlas of a project's architecture, from input to output: a code-anchored knowledge base and a single-file HTML map. Use it to map, teach or document a whole system, or to re-check an atlas after the code changed. |

Skills have no `mod.json`, so the Mods panel does not list them.

## Requirements

- Claude Code with hooks-module mods. Tested on Claude Code 2.1.330.
- macOS for `mod-machine` (it runs `memory_pressure` and `df`).
- `git` for `mod-git`; `gh`, signed in, for its pull request line.

## Install

One mod from the marketplace this repository is:

In Claude Code:

```text
/plugin install claim-check --marketplace mrud-ciklum/ai-claude-mods-skills
```

Or all of them, as links into a clone, so a `git pull` updates them:

```bash
git clone https://github.com/mrud-ciklum/ai-claude-mods-skills.git ~/code/claude-mods-skills
```

```bash
~/code/claude-mods-skills/install.sh
```

`install.sh` links each folder of `skills/` (mods and skills alike) into `~/.claude/skills/`. A real folder of the
same name already there is moved first to `~/.claude/mods-backup-<date-time>/`, outside the
skills folder, so it does not load. Then start a new Claude Code session.

Your switches and settings in `~/.claude/mods/` are kept as they are. Type `/mods` to open
the Mods panel.

## Update

```bash
cd ~/code/claude-mods-skills && git pull
```

The links point into the clone, so a pull updates every mod and skill; start a new session to load them.

## Develop

Edit a mod or skill in the clone. A session that has the mod loaded reloads it at the end of the turn
that changed its files.

```bash
cd ~/code/claude-mods-skills/skills/claim-check && claude plugin validate . && claude plugin test .
```

Every mod passes its tests. GitHub Actions (`.github/workflows/mods.yml`) validates and tests
every mod on each pull request.

## claim-check

- One extra model call per answer of 150 characters or more, on your account. Its README
  measured 7,000 to 10,000 input tokens and about 3 seconds per check on Sonnet.
- It sends the judge excerpts of the session's tool output, your prompts, `CLAUDE.md` and up to
  4 memory notes.
- The model and effort are picked under its row in the Mods panel; turn it off there too.

See `skills/claim-check/README.md` for the details.

## outbound-guard

- It reads every Bash call and stops a `gh` or `glab` post or a `git push` whose text breaks a
  rule. The model gets the reasons and fixes the text, or asks you.
- The names it keeps out of public repositories live in `~/.claude/outbound-guard.json`, which
  is yours and never goes in a repository.
- Turn it off in the Mods panel.

See `skills/outbound-guard/README.md` for the details.

## License

MIT, see `LICENSE`.
