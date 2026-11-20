/** One rate-limit window as a response reported it (the engine's SessionRateLimit). */
export type LimitWindow = {
  /** `five_hour`, `seven_day`, or a gateway's `spend_limit`. */
  kind: string
  /** 0 to 100, at most one decimal; past 100 on an exceeded spend limit. */
  percentUsed: number
  /** When the window resets, as an ISO 8601 timestamp. */
  resetsAt?: string
}

/** The account's rate-limit windows as one response reported them. */
export type LimitsReading = {
  windows: LimitWindow[]
  /** When the reading was taken, in epoch milliseconds. */
  at: number
}

declare module 'claude-code' {
  interface PluginState {
    'mod-limits': {
      isOn: boolean
      switchSeenAt: number
      isQuiet: boolean
      switchedOff: string[]
      latest: LimitsReading | null
      now: number
      alerted: Record<string, number>
    }
  }
}
