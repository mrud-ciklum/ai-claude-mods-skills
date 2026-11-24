# lesson-catcher

A Claude Code mod that notices when a prompt corrects the model ("you again", "I already told
you", "ти знову", "я ж казав", "не так,") and offers, in one line above the prompt, to keep the
correction as a rule.

## What it does

- Remember sends the model your words and asks it to save them as a feedback memory under its
  memory rules: what to do differently, why, and when it applies, updating a memory that already
  covers it instead of adding a second one. The model says in one line what it saved.
- Dismiss, or your next prompt, takes the line away.
- Nothing is saved without a press.

Switch it off under Lesson catcher in the Mods panel.

## Limits

- It knows a correction by its words, in Ukrainian and English. A correction in other words
  ("this is wrong, redo it") is not caught, and a sentence that only quotes such words may be.

## Develop

```bash
claude plugin validate .
```

```bash
claude plugin test .
```
