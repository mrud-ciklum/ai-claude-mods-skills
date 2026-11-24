# test-watch

A Claude Code mod that runs a mod's tests after a turn that edited its files, and shows the result
in the band above the prompt.

## What it does

- It notes the files each Edit and Write of a turn changed. When the turn ends, it finds the mod
  each file belongs to (the nearest folder above it with `.claude-plugin/plugin.json`) and runs
  `claude plugin test <folder>` for each such mod, one after the other, in the background.
- While the tests pass or run, it is one chip on the band's line: `Tests 45 ✓`, or `Tests …`
  while a run is going.
- When some fail, it is a row instead: `Tests 1 ✗` and each mod's last run
  (`claim-check 41 ✓ · outbound-guard 19/20`). Why opens a pane with the failing tests; Hide
  clears the row.

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
