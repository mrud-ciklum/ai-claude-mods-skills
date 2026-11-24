# context-band

A Claude Code mod that draws the band above the prompt: one line of readings, the task, the
runners, and the slots the other band mods draw into.

## What it shows

- **The readings line.** `Context 62%` first, then the chips of the other mods (limits, steps,
  Mac, git and the rest), with `⋯` at the right end. A chip turns amber from 60% and red from 80%.
  With the pointer on the Context chip, its card says the tokens used of the window
  (`124k of 200k`), what fills it most, and where auto-compaction starts.
- **The task.** The row right above the prompt, fed by the `task_progress` tool: the task, its
  percent and step, a plan's checklist when the model sends one, and the time left.
- **The toolbar**, behind `⋯`: Runners, Details, Compact, Mods, a button for each mod whose card
  asks for one (Sessions, Overview), and the band's height (`▲`, `▼`, `auto`). From 80% full,
  Compact also shows next to `⋯` with the menu shut.
- **Runners.** The background work of this session and the others still running elsewhere on
  this Mac: shells, agents and jobs named by the `runner_info` tool, each with its progress or its
  life on a four-hour scale.
- **Details.** What fills the context window, largest first, and the tool results it counted.

## Notices

- A toast when the context passes 80% and again at 90%.
- A runner that finishes, dies or stalls is announced once; its sound plays once per machine
  (`~/.claude/mods/alerts.json` keeps which session played it). Sounds and the spoken news follow
  the Mods panel's Sounds and Voice settings.

## Commands and tools

| Name | What it does |
| --- | --- |
| `/band` | The band in words: context, task and this session's runners. |
| `/runners` | Opens or closes the Runners list. |
| `task_progress` | The model reports the task, its percent, its step and an optional plan. |
| `runner_info` | The model names a piece of background work and where its progress shows. |

## Files

- `~/.claude/context-band/sessions/<session id>.json`: this session's entry (context, task,
  runners, turn), rewritten every 30 seconds. The other sessions' bands and the Sessions,
  Overview, Prompt hints, Runner cards and Spinner mods read these.
- `~/.claude/mods/band.json`: the band's height and whether the menu is open, shared by every
  session.

## For the other band mods

A mod draws into the band by hooking `ui.render` for `AbovePrompt` with `plugin: 'context-band'`
and putting its piece into one of three slots, with the shared band layout block:

- `CHIPS_SLOT`: the readings line. `placeReadings` puts each reading there as a chip, and its
  card, hidden until the pointer is on the chip, into `METERS_SLOT`.
- `METERS_SLOT`: under the readings line.
- `SECTIONS_SLOT`: above the task, for rows such as Sessions, Last time or a failing test run.

Pieces are keyed by kind, the mod's order and its name (`chip:06:mod-git`), and each slot keeps
them in key order. At a set height the band keeps to at most that many rows, and a note you can
press counts the rows left out.

Switch it off under Context band in the Mods panel.

## Develop

```bash
claude plugin validate .
```

```bash
claude plugin test .
```
