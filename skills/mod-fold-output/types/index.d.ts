declare module 'claude-code' {
  interface PluginState {
    'mod-fold-output': {
      isOn: boolean
      isQuiet: boolean
      switchedOff: string[]
      switchSeenAt: number
      openResults: string[]
    }
  }
}
