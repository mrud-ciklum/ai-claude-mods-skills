# bash-guard

A Claude Code mod that stops a shell command before it runs when it would run for minutes for
nothing. The model gets the reason as the tool's error and changes the command.

## What it stops

- A search or print of the Claude Code binary (`$CLAUDE_CODE_EXECPATH`) or of an app bundle:
  hundreds of megabytes.
- A recursive search of the whole home folder or the disk (`grep -r … ~`, `rg … /`), and `find`
  over either with no `-maxdepth`.
- A file of more than 100 MB read whole by grep, rg, awk, sed, cat, jq and the like. Piped into
  `head`, it goes on.
- With Background preflight on (the default): a background run of tests, a benchmark, a migration,
  an ingest or a training that starts without `set -euo pipefail` and without the git SHA
  (`git rev-parse --short HEAD`). A failure would be hidden by a pipe, and the result would name no
  commit.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| Background preflight (Mods panel) | on | Off lets a background run start without the preflight. |

Switch the whole guard off under Bash guard in the Mods panel.

## Limits

- It reads the command's text. A script that greps a big file from inside is not seen.
- Quotes are not followed when the command is cut into parts, so a `;` inside quotes can make a
  part look shorter than it is. That can only make it stop less.
- If the guard itself fails, the command goes on: it guards time, not safety.

## Develop

```bash
claude plugin validate .
```

```bash
claude plugin test .
```
