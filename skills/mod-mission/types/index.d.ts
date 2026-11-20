/** One point of this session's context fill: when, and how full in percent. */
export type FillPoint = { at: number; percent: number }

/** A runner on the timeline: whose, what, from when to when, and how it ended. */
export type TimelineRunner = {
  where: string
  title: string
  seenAt: number
  endedAt: number | null
  state: 'live' | 'done' | 'dead'
}

/** One live session, as far as the overview reads it. */
export type SessionLine = { where: string; task: string | null; percent: number | null; fill: number | null; isWorking: boolean | null }

/** What the overview shows, gathered from the files the other mods share. */
export type Overview = {
  limits: Array<{ kind: string; percentUsed: number; resetsAt?: string }>
  runners: TimelineRunner[]
  sessions: SessionLine[]
  machine: { freePct: number | null; diskUsedPct: number | null } | null
  pull: { number: number; state: string; failed: number; passed: number; pending: number; review: string } | null
  at: number
}

declare module 'claude-code' {
  interface PluginState {
    'mod-mission': {
      isOn: boolean
      isQuiet: boolean
      switchedOff: string[]
      switchSeenAt: number
      fillHistory: FillPoint[]
      overview: Overview | null
      isOpen: boolean
      isPaneShown: boolean
    }
  }
}
