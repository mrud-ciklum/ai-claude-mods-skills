declare module 'claude-code' {
  interface PluginState {
    'mod-task-spinner': {
      isOn: boolean
      isQuiet: boolean
      switchedOff: string[]
      switchSeenAt: number
      task: { title: string; percent: number; step?: string | null } | null
      hereId: string
    }
  }
}
