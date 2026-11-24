# claim-check

A Claude Code mod that checks every answer against the evidence the session actually had. After each answer, a second model reads the turn's tool output and sorts the answer's factual claims by what backs them. Claims with nothing behind them, or with evidence that says otherwise, show up in a row above the prompt.

It checks that a claim has a source. It does not check that the source is right.

## What you see

Two lines above the prompt, under the other mods' rows, after each answer of 150 characters or more:

```
▲ 1 key · ✗ 1 contradicted · ? 2 unverified · ≈ 1 inferred · ✓ 7 backed        [ Verify ] [ Details ]
3 s · unverified, key: "the deploy is green"
```

The second line names the claim that matters most. Quoted text is the answer's own words, kept only when the code finds them in the answer; unquoted text is the judge's reading of the claim.

| Verdict | Meaning |
| --- | --- |
| contradicted | The evidence says otherwise. |
| unverified | Nothing in the session supports it, or the judge cited a passage that is not there. |
| stale | Backed only by a read made before the file changed, by an old memory note about something that changes, or by the summary a compaction left when the fact can change. |
| assumed | The answer relies on it but never states or checks it. |
| inferred | It follows from evidence by reasoning; nothing states it. |
| memory | From a memory note or `CLAUDE.md`, or from the summary a compaction left when the fact cannot change. |
| earlier | From an earlier turn's tool output, or your own words. |
| backed | Stated by this turn's tool output. Counted, not listed. |

Each listed claim is also rated key, normal or minor. Key means you are likely to act on it.

- **Details** opens a pane with every listed claim, its source and its priority, and a legend of the marks at its foot.
- **Verify** sends the model a prompt to check the flagged claims with read-only tools.
- **Dig** (per claim, in the pane) has the model measure one claim properly and correct it at its source if it was wrong.
- **Wrong** (per claim, in the pane) says the flag is false. The claim shows as marked, and a line goes to `claim-check-feedback.jsonl` in the project's folder under `~/.claude/projects/` (the last 500). The pane counts them by verdict: that is how to tell which verdicts are wrong most often.
- Flagged claims that are not minor are handed to the model with your next prompt, once, so it can check or retract them. An assumption is handed over only when it is key; the rest stay in the pane.

## How it works

1. When a turn ends, the mod gathers the session's tool calls, your prompts, `CLAUDE.md`, the memory index and the memory notes closest to the answer. If the session was compacted, the summary it left counts as evidence of its own kind: a claim only the summary states shows as `memory`, or as `stale` when the fact can change, not as unverified.
2. It cuts that down to about 59,000 characters. Every tool call of the turn gets a share (short outputs whole, long ones cut to the lines that share the answer's rarest words plus their head and tail; a call's input keeps its own line breaks, so a long command or a file written through one is cut by lines too). Of older calls it keeps those that hold the answer's rare words (a word found in few calls weighs more, so the model's own drafts, which repeat the answer, do not crowd out the sources), and the newest eight whatever they say.
3. A judge model says how each claim relates to a passage and quotes 3 to 8 words from it.
4. Claims the judge found no support for get a second look, unless they are minor or the second look is switched off. It looks for support only and never adds a contradiction. For each, the mod searches every tool call of the session by the claim's own words (any word of four letters or more that says something, whatever the case, plus the answer's wording; a word counts where a word of the passage starts with it, so `flag` finds `flags` and `main` does not find `remain`), this turn's calls apart from the older ones, and asks the judge once more about those claims alone, with up to two passages of this turn and two older ones for each. The first pass reads a cut-down view chosen by the whole answer, so a passage that backs one claim can be missing from it.
5. Code, not the judge, does the rest. It checks that each quote is really in the cited evidence, works out where the evidence came from and how old it is, and marks a read as stale when the file was changed afterwards (by an edit or a shell command) and the quoted line is gone. A file a command wrote itself (its own log) does not make what the command printed stale when it is rewritten later; what the command wrote into it does.
6. What the answer says about its own limits ("not checked", "не перевіряв") is a caveat, not a claim: it is never flagged.

The check runs after the answer is shown, so it never delays a reply. Only the transcript is read before the turn is handed back (13 ms as a rule, 78 ms at most in 145 logged checks), so that a prompt queued behind the turn cannot mix its rows into the check.

## What it sends and what it costs

Each check is one extra model call on your own account, and a second, smaller one when the first leaves claims that are not minor without support (up to about 10,000 characters; switch it off under Second look in the Mods panel). It sends the judge:

- excerpts of the session's tool output (file contents, command output)
- your prompts in the session
- the summary a compaction left, when there is one
- `CLAUDE.md`, the memory index, and up to 4 memory notes

Measured on Sonnet with version 0.7 in a session with about 200 tool calls: 7,000 to 10,000 input tokens and 400 to 500 output tokens per check, about 3 seconds. From the local log on 24 November 2026: 129 checks on Sonnet at low effort took 5.3 s at the median for the judge; 12 checks of 0.9.4 on Opus at high effort took 21.9 s at the median, with 19,095 input and 2,214 output tokens at the median. Hence the `opus` choice for the second look alone.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| Judge model | sonnet | haiku is faster and misses more; opus is slower and stricter. |
| Model (Mods panel) | Judge model | Picked under the mod's row in the Mods panel: an alias the /config menu offers (`sonnet (latest)` follows each new version), or a full model id such as `claude-sonnet-5-5` to pin one. Wins over Judge model. |
| Effort (Mods panel) | low | The judge's reasoning effort: low, medium, high, xhigh or max. Higher is slower and costs more. |
| Second look (Mods panel) | on | Whether claims left without support are looked up in the whole session and judged once more. `opus` runs that second call on Opus while the first pass keeps its model: a strong judge only where it is needed. Off saves the second call. |
| Auto-correct contradictions | off | When on, a contradicted claim sends one correction prompt unasked. |
| Timing log | summary | Writes one line per check to `~/.claude/claim-check-timings.jsonl`, and the project's last four checks as the judge saw them (the prompts, the replies, the verdicts) to `claim-check-last.json` in the project's folder under `~/.claude/projects/`. `stages` adds a line per step; `off` writes neither. |

## Why was this flagged?

Open `claim-check-last.json` in the project's own folder under `~/.claude/projects/`: the folder that holds the session's transcripts, named after the path the session started in (`~/.claude/projects/-Users-me-code-app/` for `/Users/me/code/app`). It holds the project's last four checks, newest first. Each names its session and folder and carries the exact prompt the judge read (so you can see whether the passage was there), its reply, the second look's prompt and reply when there was one, and the verdicts the code made of them.

The file holds excerpts of the project's sessions, like the transcripts next to it, and nothing of any other project: a session writes only to the folder that holds its own transcript, also while its working folder is somewhere else. That folder is found from the working folder when a check runs, and remembered; until it is found, nothing is written. Versions 0.9.0 to 0.9.2 kept one file for all projects, `~/.claude/claim-check-last.json`; it is no longer written and can be deleted.

## Limits

- Claims counted as backed are trusted. Only listed claims have their quote checked.
- At most 8 claims and 2 assumptions are listed per answer.
- Trimming means the judge sometimes misses a passage that was there, and a true claim shows as unverified. In a turn with more than about 57 tool calls the oldest calls are left out.
- What a compaction removed cannot be checked again: such claims rest on the summary alone.
- The second look finds a passage by the claim's words. A claim that only follows from numbers in the output, or that the evidence puts in other words, is still not found. Nor is one in a session where every passage shares the same vocabulary: no word is rare enough to point at the right one. An output of more than 100,000 characters is searched by its head and tail only.
- A prompt that begins with a notice of the engine (`<system-reminder>`) counts by the words after it; a new kind of notice in front of typed words would hide them.
- Where a turn begins is taken from the engine when the turn starts. Without that (the mod loaded mid-turn), text the engine adds in your voice is told apart by how it starts (a skill's body, a command's output), and a new kind may be taken for a prompt.
- Shell changes are detected from the command's text (redirects, `sed -i`, `mv`, `rm`, `cp` destinations, script writes, git commands that rewrite the tree). A name is made a full path where the command shows its folder (`cd /x && …`), a variable it set (`S=/tmp/x; … $S/a.ts`) or the home folder; otherwise its tail is compared. A formatter run on a whole directory is not seen.
- Memory is found only while the session stays in or below the folder it started in.
- Subagent turns are not checked, and neither are answers to Verify or Dig: checking those would ask for another Verify, round after round.

## Develop

```bash
claude plugin validate .
```

```bash
claude plugin test .
```

`hooks/judge.ts` holds the logic that needs no engine. `hooks/register.tsx` holds the hooks, the row and the pane. Editing the mod in a session that has it loaded reloads it at the end of the turn, which drops the check in flight for that turn.
