// Worst first: the order the pane lists them in.
export type Verdict =
  | 'contradicted' // the evidence says otherwise
  | 'unverified' // nothing behind it, or the judge's quote was not found
  | 'stale' // backed only by a read made before a later change, an old note about something that changes, or the summary for such a fact
  | 'assumed' // relied on, never stated or checked
  | 'inferred' // follows from evidence by reasoning, not observed
  | 'memory' // from a memory note, CLAUDE.md, or the summary a compaction left (a fact that does not change)
  | 'earlier' // from an earlier turn's tool output, or the user's own words
  | 'backed' // stated by this turn's tool output

export type Claim = {
  claim: string // the judge's reading of it, in its words
  said?: string // the answer's own words for it: the judge's quote of the answer, found there by code
  verdict: Verdict
  source: string
  check: string // how to verify it with a tool
  priority: 1 | 2 | 3 // 1 key (the user will act on it), 2 normal, 3 minor detail
  isDug?: boolean // its Dig button was pressed
  isMarkedWrong?: boolean // its Wrong button was pressed: the person says the flag is false
}

export type Check = {
  turnId: string
  status: 'checking' | 'done' | 'failed' | 'interrupted' // interrupted: the mod reloaded mid-check
  claims: Claim[] // the ones worth showing: everything but the settled
  settled: number // claims this turn's evidence states outright: counted by the judge, not listed
  error?: string
  // Where the time went, for the pane, and the judge's model and effort (absent in older checks).
  // `lookedAgain` claims went to the second look (a search of the whole session by the claim's own
  // words); `foundAgain` of them came back with support. Both absent when there was no second look.
  stats?: {
    gatherSeconds: number
    judgeSeconds: number
    promptChars: number
    replyTokens: number
    isCut: boolean
    model?: string
    effort?: string
    lookedAgain?: number
    foundAgain?: number
    secondModel?: string // the model the second look ran on
  }
  // The flagged claims were already handed to the model (next prompt, Verify, or auto-correction).
  isFedBack: boolean
}

// The judge's model and effort as picked in the Mods panel; absent, the Judge model setting and low.
// `secondLook: false` when the panel switches the second look off, 'opus' when it runs on Opus;
// absent, it is on and runs on the first pass's model.
export type Picks = { model?: string; effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'; secondLook?: false | 'opus' }

declare module 'claude-code' {
  interface PluginState {
    'claim-check': {
      last: Shaped<Check | null>
      // Auto-corrections sent since the person's last own prompt.
      autoCount: number
      // The Mods panel's switch for this mod, read from ~/.claude/mods/state.json.
      isOn: boolean
      // That file's modification time when last read.
      switchSeenAt: number
      // Whether the running turn answers this mod's Verify or Dig prompt: its answer is not checked.
      isOwnTurn: boolean
      // The judge's model and effort picked in the Mods panel, read from ~/.claude/mods/state.json.
      picks: Picks
      // The transcript's last row when the running turn began; null when it could not be read.
      turnStart: { turnId: string; uuid: string } | null
      // The folder under the config folder that holds this session's transcript, once found.
      sessionFolder: { session: string; dir: string } | null
      // The flags marked wrong in this project's feedback file, by verdict.
      wrongTally: Record<string, number> | null
    }
  }
}
