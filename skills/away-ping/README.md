# away-ping

A Claude Code mod that sends a notification through your own channel (the one Claude Code's
notifications use) when an answer ends with a question for you, or when a turn ran long.

## What it sends

- **Claude asks**: the answer's last sentence, when it is a question. Sent whatever the turn's
  length: the session waits for you.
- **Claude finished**: after a turn longer than the Long turn setting, how long it took and the
  answer's first line.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| Long turn (Mods panel) | 5 min | 1 min, 5 min, 15 min, or never (questions only). |

Switch it off under Away ping in the Mods panel.

## Limits

- It cannot tell whether you are looking at the session: it sends either way.
- Where Claude Code already notifies at the end of a long turn, a long turn can bring two
  notifications; set Long turn to never to keep only the questions.

## Develop

```bash
claude plugin validate .
```

```bash
claude plugin test .
```
