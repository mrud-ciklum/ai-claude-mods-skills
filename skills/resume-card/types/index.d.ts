// How one earlier session in this folder ended: the summary it left, and the question it asked, if any.
export type Recap = { at: number; recap: string; ask?: string }

declare module 'claude-code' {
  interface PluginState {
    'resume-card': {
      // The Mods panel's switch, read from ~/.claude/mods/state.json (the family's shared block).
      isOn: boolean
      isQuiet: boolean
      switchedOff: string[]
      switchSeenAt: number
      // The earlier sessions' summaries, newest first; null until read.
      recaps: Recap[] | null
      // Hidden by its button, or by the first prompt of this session.
      isHidden: boolean
    }
  }
}
