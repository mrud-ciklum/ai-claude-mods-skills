declare module 'claude-code' {
  interface PluginState {
    'style-check': {
      // The Mods panel's switch, read from ~/.claude/mods/state.json (the family's shared block).
      isOn: boolean
      isQuiet: boolean
      switchedOff: string[]
      switchSeenAt: number
      // What the last answer broke, handed to the next prompt once.
      pending: string[]
    }
  }
}
