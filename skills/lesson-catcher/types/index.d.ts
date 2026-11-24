declare module 'claude-code' {
  interface PluginState {
    'lesson-catcher': {
      // The Mods panel's switch, read from ~/.claude/mods/state.json (the family's shared block).
      isOn: boolean
      isQuiet: boolean
      switchedOff: string[]
      switchSeenAt: number
      // The last prompt that read as a correction, until saved, dismissed or the next prompt.
      lesson: { text: string; at: number } | null
      // Whether the prompt running now is this mod's own: it is never a correction.
      isOwnPrompt: boolean
    }
  }
}
