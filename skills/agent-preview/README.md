# agent-preview

A Claude Code mod that shows a background agent's or a workflow's prompt before it starts, and
starts it only when you answer Launch.

## What it does

- Before the model starts a background agent (the Agent tool with `run_in_background`) or a
  workflow, a question shows what starts and its prompt (a workflow's script), cut to 1,500
  characters with a note of how much is left out.
- Launch starts it. Don't launch, or a dismissed question, refuses it: the model is told to show
  the prompt in the chat and ask you first.
- Agents in the foreground (a quick search) start unasked, unless Ask for is set to all.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| Ask for (Mods panel) | background | `all` asks about every agent, foreground ones included. |

Switch it off under Agent preview in the Mods panel.

## Limits

- Where nobody can be asked (a headless `claude -p` run), every background launch is refused.
- Agents a workflow starts are not asked about one by one: the workflow was.
- If the guard itself fails while asking, the launch is refused and the model is told so.

## Develop

```bash
claude plugin validate .
```

```bash
claude plugin test .
```
