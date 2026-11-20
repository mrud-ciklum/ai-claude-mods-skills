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
| stale | Backed only by a read made before the file changed, or by an old memory note about something that changes. |
| assumed | The answer relies on it but never states or checks it. |
| inferred | It follows from evidence by reasoning; nothing states it. |
| memory | From a memory note or `CLAUDE.md`. |
| earlier | From an earlier turn's tool output, or your own words. |
| backed | Stated by this turn's tool output. Counted, not listed. |

Each listed claim is also rated key, normal or minor. Key means you are likely to act on it.

- **Details** opens a pane with every listed claim, its source and its priority, and a legend of the marks at its foot.
- **Verify** sends the model a prompt to check the flagged claims with read-only tools.
- **Dig** (per claim, in the pane) has the model measure one claim properly and correct it at its source if it was wrong.
- Flagged claims that are not minor are handed to the model with your next prompt, once, so it can check or retract them.

## How it works

1. When a turn ends, the mod gathers the session's tool calls, your prompts, `CLAUDE.md`, the memory index and the memory notes closest to the answer.
2. It cuts that down to about 53,000 characters: the lines that share the answer's rarest words, plus the head and tail of each output.
3. A judge model says how each claim relates to a passage and quotes 3 to 8 words from it.
4. Code, not the judge, does the rest. It checks that the quote is really in the cited evidence, works out where the evidence came from and how old it is, and marks a read as stale when the file was changed afterwards (by an edit or a shell command) and the quoted line is gone.

The check runs after the answer is shown, so it never delays a reply.

## What it sends and what it costs

Each check is one extra model call on your own account. It sends the judge:

- excerpts of the session's tool output (file contents, command output)
- your prompts in the session
- `CLAUDE.md`, the memory index, and up to 4 memory notes

Measured on Sonnet in a session with about 200 tool calls: 7,000 to 10,000 input tokens and 400 to 500 output tokens per check, about 3 seconds.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| Judge model | sonnet | haiku is faster and misses more; opus is slower and stricter. |
| Model (Mods panel) | Judge model | Picked under the mod's row in the Mods panel: an alias the /config menu offers (`sonnet (latest)` follows each new version), or a full model id such as `claude-sonnet-5-5` to pin one. Wins over Judge model. |
| Effort (Mods panel) | low | The judge's reasoning effort: low, medium, high, xhigh or max. Higher is slower and costs more. |
| Auto-correct contradictions | off | When on, a contradicted claim sends one correction prompt unasked. |
| Timing log | summary | Writes one line per check to `~/.claude/claim-check-timings.jsonl`. `stages` adds a line per step; `off` writes nothing. |

## Limits

- Claims counted as backed are trusted. Only listed claims have their quote checked.
- At most 8 claims and 3 assumptions are listed per answer.
- Trimming means the judge sometimes misses a passage that was there, and a true claim shows as unverified.
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
