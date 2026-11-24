# style-check

A Claude Code mod that checks each answer against two writing rules, without a model: no em
dashes, and the language you picked. What an answer breaks shows in a line under it, and rides
with your next prompt as a reminder the model reads and you do not.

## What it checks

- Em dashes in the answer's prose. Code blocks, inline code and links are left out.
- With Answer language set to `uk` or `en`: an answer of 80 letters or more that is mostly in
  another script. `uk` wants at least half of the letters Cyrillic; `en` at most 30%.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| Answer language (Mods panel) | any | `uk` or `en` checks the language too. |

Switch it off under Style check in the Mods panel.

## Limits

- The language check counts scripts, not languages: Ukrainian and Russian look alike to it.
- Another mod's line under an answer (Turn summary) is kept, and this one joins it.

## Develop

```bash
claude plugin validate .
```

```bash
claude plugin test .
```
