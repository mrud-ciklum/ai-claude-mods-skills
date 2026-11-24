# resume-card

A Claude Code mod that shows, at the start of a session, how the last session in the same folder
ended: the summary it left when its turn closed (what changed, what is open, what was not
checked). One line above the prompt, until your first prompt or Hide.

## What it shows

- The newest earlier session in this folder (or a folder above it) from the last 14 days that left
  a summary, and how long ago it ended.
- `N more` (or Open) shows up to three such summaries in a pane, each with the question it asked
  you, if any.

The summaries are the recaps the Claude desktop app's wrap-up step writes at the end of a turn.
A session that never wrote one is skipped.

Switch it off under Resume card in the Mods panel.

## Limits

- It reads the last 512 KB of each transcript; a session whose last summary lies further back
  shows the one before it, or none.
- Transcripts are found from the folder the session starts in, the way Claude Code names its
  project folders.

## Develop

```bash
claude plugin validate .
```

```bash
claude plugin test .
```
