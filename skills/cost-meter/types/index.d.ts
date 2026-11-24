// Today's model calls by mods, per mod: calls, tokens in and out, and milliseconds.
export type Tally = Record<string, { calls: number; input: number; output: number; ms: number }>

declare module 'claude-code' {
  interface PluginState {
    'cost-meter': {
      // The Mods panel's switch, read from ~/.claude/mods/state.json (the family's shared block).
      isOn: boolean
      isQuiet: boolean
      switchedOff: string[]
      switchSeenAt: number
      // Today's tally, and the day it counts.
      today: { day: string; byMod: Tally } | null
    }
  }
}
