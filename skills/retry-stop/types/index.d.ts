declare module 'claude-code' {
  interface PluginState {
    'retry-stop': {
      // The Mods panel's switch, read from ~/.claude/mods/state.json (the family's shared block).
      isOn: boolean
      isQuiet: boolean
      switchedOff: string[]
      switchSeenAt: number
      // The last shell command of each loop ("main" or an agent's id), and how many times in a row it failed.
      streaks: Record<string, { command: string; failures: number }>
    }
  }
}
