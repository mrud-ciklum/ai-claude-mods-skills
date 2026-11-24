/** What the last main-loop step added to the context, and its biggest tool result. */
export type StepGain = {
  /** Tokens the step's request carried over the previous step's; 0 after a compaction. */
  added: number
  /** The tool whose results the step carried most of, by its label, and their tokens. */
  top: { tool: string; tokens: number } | null
}

declare module 'claude-code' {
  interface PluginState {
    'mod-forecast': {
      isOn: boolean
      switchSeenAt: number
      isQuiet: boolean
      switchedOff: string[]
      /** The tokens the last main-loop step was answered over. */
      tokens: number | null
      /** Where auto-compaction starts, in tokens; null when it is off or not yet read. */
      compactAt: number | null
      /** When compactAt was last read, epoch milliseconds. */
      compactAtReadAt: number
      /** The last few steps' growth in tokens, oldest first; compactions are left out. */
      growth: number[]
      /** Characters of tool results per tool label since the last step. */
      stepTools: Record<string, number>
      lastStep: StepGain | null
    }
  }
}
