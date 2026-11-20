declare module 'claude-code' {
  interface PluginState {
    'mod-turn-stats': {
      isOn: boolean
      isQuiet: boolean
      switchedOff: string[]
      switchSeenAt: number
      carried: number | null
      turnStart: { tokens: number | null; tools: number } | null
      tools: number
    }
  }
}
