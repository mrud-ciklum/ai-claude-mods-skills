declare module 'claude-code' {
  interface PluginState {
    'mod-quiet-tools': {
      isOn: boolean
      isQuiet: boolean
      switchedOff: string[]
      switchSeenAt: number
    }
  }
}
