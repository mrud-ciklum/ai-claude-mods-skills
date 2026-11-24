// One mod's last test run: how many passed and failed, the failing test names, and when it ran.
export type Run = { folder: string; name: string; state: 'running' | 'passed' | 'failed' | 'error'; passed: number; failed: number; failures: string[]; at: number; detail?: string }

declare module 'claude-code' {
  interface PluginState {
    'test-watch': {
      // The Mods panel's switch, read from ~/.claude/mods/state.json (the family's shared block).
      isOn: boolean
      isQuiet: boolean
      switchedOff: string[]
      switchSeenAt: number
      // The last run of each mod the turns edited, by folder.
      runs: Run[]
      // The files the running turn edited.
      edited: string[]
    }
  }
}
