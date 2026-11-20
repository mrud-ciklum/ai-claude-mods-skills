declare module 'claude-code' {
  interface PluginState {
    'mod-compact-marks': {
      isOn: boolean
      isQuiet: boolean
      switchedOff: string[]
      switchSeenAt: number
      percent: number | null
      lastCompaction: { before: number | null; after: number | null } | null
    }
  }
}
