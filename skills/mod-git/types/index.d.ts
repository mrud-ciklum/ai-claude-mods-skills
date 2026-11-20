/** The session folder's working tree, from `git status --porcelain=v2 --branch`. */
export type TreeState = {
  branch: string
  /** Commits ahead of and behind the upstream; null without one. */
  ahead: number | null
  behind: number | null
  /** Changed, staged and untracked paths. */
  changed: number
  staged: number
  untracked: number
}

/** The branch's pull request, from `gh pr view`. */
export type PullState = {
  number: number
  title: string
  /** OPEN, CLOSED or MERGED. */
  state: string
  isDraft: boolean
  /** APPROVED, CHANGES_REQUESTED, REVIEW_REQUIRED, or empty. */
  review: string
  checks: { passed: number; failed: number; pending: number }
  comments: number
  url: string
}

declare module 'claude-code' {
  interface PluginState {
    'mod-git': {
      isOn: boolean
      isQuiet: boolean
      switchedOff: string[]
      switchSeenAt: number
      tree: TreeState | null
      pull: PullState | null
      /** When the pull request was last asked for, epoch milliseconds. */
      pullAt: number
    }
  }
}
