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

declare module 'claude-code' {
  interface PluginState {
    'git-changes': { status: RepoStatus | null }
  }
}
