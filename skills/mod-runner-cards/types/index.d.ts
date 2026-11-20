/** A runner as the band publishes it, as far as a card reads it. */
export type CardRunner = {
  id: string
  status: string
  description: string
  endedAt: number | null
  info?: { title: string } | null
  progress?: { percent: number | null; targets: Array<{ status: string; done: number | null; total: number | null }> } | null
}

declare module 'claude-code' {
  interface PluginState {
    'mod-runner-cards': {
      isOn: boolean
      isQuiet: boolean
      switchedOff: string[]
      switchSeenAt: number
      runners: CardRunner[]
      hereId: string
    }
  }
}
