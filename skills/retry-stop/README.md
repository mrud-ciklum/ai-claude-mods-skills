# retry-stop

A Claude Code mod that refuses a shell command that has just failed twice in a row with no file
edited between. The model is told to read the error and change something first: the command, a
file, or the approach.

## How it counts

- Each loop (the main conversation, each subagent) keeps its own count.
- The same command means the same words, whatever the spacing.
- A file edited (Edit, Write, NotebookEdit), another shell command that succeeds, or a different
  command clears the count. Reading files does not.
- A run another guard refused does not count as a failure.

Switch it off under Retry stop in the Mods panel.

## Limits

- A command that changes something outside the files (a package install, a server started in
  the background) clears nothing, so its retry after such a change can be refused once. Running a
  different command between clears it.

## Develop

```bash
claude plugin validate .
```

```bash
claude plugin test .
```
