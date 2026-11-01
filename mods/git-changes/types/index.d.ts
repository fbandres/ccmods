export type Letter = '!' | 'D' | 'A' | 'R' | 'M' | 'U'
export type FileChange = {
  path: string
  letter: Letter
  /** Lines added and removed, staged and unstaged together; absent when unknown. */
  added?: number
  removed?: number
  isBinary?: boolean
}
export type RepoStatus = {
  branch: string
  isDetached: boolean
  ahead: number
  behind: number
  files: FileChange[]
  error?: string
  updatedAt: number
}

export type Issue = { number: number; title: string; label?: string; updatedAt: string; url: string }
export type IssuesState = {
  issues: Issue[]
  /** True when gh returned the limit: there may be more. */
  isCapped: boolean
  error?: string
  updatedAt: number
}

/** A PR's one status mark, most urgent first: draft, checks failed, changes requested, checks running, checks passed, none. */
export type PrMark = 'D' | '✗' | 'R' | '●' | '✓' | ''
export type PullRequest = { number: number; title: string; author: string; mark: PrMark; updatedAt: string; url: string }
export type PrsState = {
  prs: PullRequest[]
  /** False until a list has arrived: a first fetch that failed leaves it false. */
  isLoaded: boolean
  /** True when gh returned the limit: there may be more. */
  isCapped: boolean
  error?: string
  updatedAt: number
}

declare module 'claude-code' {
  interface PluginState {
    'git-changes': { status: RepoStatus | null; issues: IssuesState | null; prs: PrsState | null }
  }
}
