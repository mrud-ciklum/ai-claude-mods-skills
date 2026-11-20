declare module 'claude-code' {
  interface PluginState {
    'mod-tool-groups': {
      isOn: boolean
      isQuiet: boolean
      switchedOff: string[]
      switchSeenAt: number
      openGroups: string[]
    }
  }
}
