declare module 'claude-code' {
  interface PluginState {
    'mod-prompt-hints': {
      isOn: boolean
      isQuiet: boolean
      switchedOff: string[]
      switchSeenAt: number
      percent: number | null
      waiting: number
      dead: number
      hereId: string
    }
  }
}
