/** One reading of this Mac, shared by every session through ~/.claude/mods/machine.json. */
export type MachineReading = {
  /** When it was taken, epoch milliseconds. */
  at: number
  /** memory_pressure's free percentage; null when it could not be read. */
  freePct: number | null
  /** The data volume: percent used, and kilobytes free and in all; null when df failed. */
  disk: { usedPct: number; freeKb: number; totalKb: number } | null
  /** The agent gate's live slots, and its budget at this free percentage. */
  slots: { live: number; budget: number } | null
  /** True while the gate's kill switch file is there. */
  isGateOff: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'mod-machine': {
      isOn: boolean
      isQuiet: boolean
      switchedOff: string[]
      switchSeenAt: number
      reading: MachineReading | null
    }
  }
}
