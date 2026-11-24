declare module 'claude-code' {
  interface PluginState {
    'retry-stop': {
      // The Mods panel's switch, read from ~/.claude/mods/state.json (the family's shared block).
      isOn: boolean
      isQuiet: boolean
      switchedOff: string[]
      switchSeenAt: number
    }
  }
}
