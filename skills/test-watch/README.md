# test-watch

A Claude Code mod that runs a mod's tests after a turn that edited its files, and shows the result
in one line above the prompt.

## What it does

- It notes the files each Edit and Write of a turn changed. When the turn ends, it finds the mod
  each file belongs to (the nearest folder above it with `.claude-plugin/plugin.json`) and runs
  `claude plugin test <folder>` for each such mod, one after the other, in the background.
- The line shows each mod's last run: `claim-check 41 ✓`, `outbound-guard 19/20 ✗`, or
  `running…`. Why opens a pane with the failing tests; Hide clears the line.

Switch it off under Test watch in the Mods panel.

## Limits

- Only mods: other projects' tests (pytest, npm test) are not run.
- Files changed by a shell command are not seen, only those of the edit tools.
- A run is stopped after three minutes and shown as not run.

## Develop

```bash
claude plugin validate .
```

```bash
claude plugin test .
```
