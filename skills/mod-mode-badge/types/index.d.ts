declare module 'claude-code' {
  interface PluginState {
    'mod-mode-badge': {
      isOn: boolean
      isQuiet: boolean
      switchedOff: string[]
      switchSeenAt: number
      model: string
      effort: string | null
    }
  }
}
