/** One runner of a session, as far as this mod reads it. */
export type SessionRunner = {
  id: string
  status: string
  description: string
  endedAt: number | null
  info?: { title: string } | null
  progress?: { targets: Array<{ status: string }> } | null
}

/** One session's entry in ~/.claude/context-band/sessions, as the band publishes it. */
export type SessionCard = {
  sessionId: string
  cwd: string
  task: { title: string; percent: number } | null
  runners: SessionRunner[]
  updatedAt: number
  isEnded: boolean
  fill?: number | null
  turn?: { isWorking: boolean; since: number }
  /** The last prompt there, its first line; absent from older bands. */
  asked?: string | null
  /** The gist of its last answer: the question it ends on, else its first sentence; absent from older bands. */
  said?: string | null
  /** How that last turn ended: answer, aborted, refusal or error; absent from older bands. */
  ending?: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'mod-sessions': {
      isOn: boolean
      isQuiet: boolean
      switchedOff: string[]
      switchSeenAt: number
      /** The live sessions, this one included, as their files last said. */
      sessions: SessionCard[]
      /** Each working directory's checked-out branch, by directory. */
      branches: Record<string, string>
      /** This session's id. */
      hereId: string
      isOpen: boolean
      /** Since when each other session has been working, by session id: the start of the turn it ran. */
      workingSince: Record<string, number>
      /** When the person last sent a prompt here, epoch ms; 0 before the first. */
      lastPromptAt: number
      /** The model's five-point summary of this session, once asked for. */
      summary: string[] | null
      isSummarizing: boolean
    }
  }
}
