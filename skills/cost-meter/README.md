# cost-meter

A Claude Code mod that counts the model calls other mods make (a judge, a second look) on your
account: calls, tokens and time per mod and per day. The Mods panel shows each mod's day under its
row, and a daily cap can stop them.

## What it does

- Every `$.model.complete` call of a mod passes through it. When the call answers, it adds the
  call, its tokens (input, cache reads and writes included, and output) and its time to
  `~/.claude/mods/side-models.json`, a day per key, the last 14 days. The file holds counts only,
  no prompt and no answer. Every session counts into it.
- The Mods panel reads it: `Today: 230k tokens in 12 model calls` under a mod that made calls.
- With a Daily cap set, a call made once the day's tokens reach the cap is not made: the calling
  mod gets an unanswered result (`aborted`), and a notice names the mod. From 80% of the cap, a line
  above the prompt shows the day's tokens against it.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| Daily cap (Mods panel) | off | 500k, 1M, 2M or 5M tokens a day for all mods together. |

Switch it off under Side-model cost in the Mods panel: nothing is counted or stopped then.

## Limits

- It counts calls made through `$.model.complete`. The conversation's own model calls are not a
  mod's and are not counted.
- Two sessions writing the file at the same moment can lose one call's count.

## Develop

```bash
claude plugin validate .
```

```bash
claude plugin test .
```
