import type { FileChange, Letter, RepoStatus } from '../types'

export type LineStat = { added: number; removed: number; isBinary: boolean }

export type EntryKind = 'ordinary' | 'renamed' | 'unmerged' | 'untracked'

export const LETTER_COLOR: Record<Letter, string> = {
  '!': 'merged',
  D: 'error',
  A: 'success',
  R: 'success',
  M: 'warning',
  U: 'success',
}

/**
 * One display letter for a file, from porcelain v2's X (staged) and Y
 * (unstaged) codes and the entry kind. Priority: ! > D > A > R > M > U.
 */
export function pickLetter(x: string, y: string, kind: EntryKind): Letter {
  if (kind === 'unmerged') return '!'
  if (kind === 'untracked') return 'U'
  const codes = x + y
  if (codes.includes('D')) return 'D'
  if (codes.includes('A')) return 'A'
  if (kind === 'renamed' || codes.includes('R')) return 'R'
  return 'M'
}

/** The text after the first `count` space-separated fields of `line`. */
function after(line: string, count: number): string {
  let at = 0
  for (let n = 0; n < count; n++) at = line.indexOf(' ', at) + 1
  return line.slice(at)
}

export function parseStatus(raw: string, now: number): RepoStatus {
  const files: FileChange[] = []
  let oid = ''
  let head = ''
  let ahead = 0
  let behind = 0
  const entries = raw.split('\0')

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    if (!entry) continue

    if (entry.startsWith('# branch.oid ')) oid = entry.slice('# branch.oid '.length)
    else if (entry.startsWith('# branch.head ')) head = entry.slice('# branch.head '.length)
    else if (entry.startsWith('# branch.ab ')) {
      const [plus, minus] = entry.slice('# branch.ab '.length).split(' ')
      ahead = Math.abs(Number(plus))
      behind = Math.abs(Number(minus))
    } else if (entry[0] === '1') {
      files.push({ path: after(entry, 8), letter: pickLetter(entry.charAt(2), entry.charAt(3), 'ordinary') })
    } else if (entry[0] === '2') {
      files.push({ path: after(entry, 9), letter: pickLetter(entry.charAt(2), entry.charAt(3), 'renamed') })
      i++ // -z puts the original path in the next entry
    } else if (entry[0] === 'u') {
      files.push({ path: after(entry, 10), letter: pickLetter(entry.charAt(2), entry.charAt(3), 'unmerged') })
    } else if (entry[0] === '?') {
      files.push({ path: entry.slice(2), letter: pickLetter('?', '?', 'untracked') })
    }
  }

  const isDetached = head === '(detached)'

  return {
    branch: isDetached ? oid.slice(0, 7) : head,
    isDetached,
    ahead,
    behind,
    files,
    updatedAt: now,
  }
}

/** Cuts `text` to `width`, ending in `…`, keeping `keep` chars at the end. */
function cut(text: string, width: number, keep = ''): string {
  if (text.length <= width) return text
  const room = width - keep.length - 1
  return room > 0 ? text.slice(0, room) + '…' + keep : text.slice(0, width - 1) + '…'
}

/**
 * The row's file name and its dim parent folder, fitted to `width`
 * columns (a space between them). The folder is cut first, then dropped,
 * then the name is cut keeping its extension.
 */
export function fitRow(path: string, width: number): { name: string; dir: string } {
  const slash = path.lastIndexOf('/')
  const base = path.slice(slash + 1)
  const folder = slash === -1 ? '' : path.slice(0, slash)
  const dot = base.lastIndexOf('.')
  const ext = dot > 0 ? base.slice(dot) : ''

  if (base.length >= width) return { name: cut(base, width, ext), dir: '' }

  const dirRoom = width - base.length - 1
  if (!folder || dirRoom < 4) return { name: base, dir: '' }

  return { name: base, dir: cut(folder, dirRoom) }
}

/** `git diff --numstat -z` output, by path. A rename counts under its new path. */
export function parseNumstat(raw: string): Map<string, LineStat> {
  const stats = new Map<string, LineStat>()
  const entries = raw.split('\0')

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    if (!entry) continue

    const [plus = '', minus = '', named = ''] = entry.split('\t')
    let path = named
    if (!path) {
      path = entries[i + 2] ?? '' // -z rename: the old path, then the new one
      i += 2
    }
    const isBinary = plus === '-'
    stats.set(path, {
      added: isBinary ? 0 : Number(plus),
      removed: isBinary ? 0 : Number(minus),
      isBinary,
    })
  }

  return stats
}

/** A new file's stat: every line added. A NUL byte marks it binary. */
export function countLines(text: string): LineStat {
  if (text.includes('\0')) return { added: 0, removed: 0, isBinary: true }
  if (!text) return { added: 0, removed: 0, isBinary: false }
  const breaks = text.split('\n').length - 1

  return { added: text.endsWith('\n') ? breaks : breaks + 1, removed: 0, isBinary: false }
}

/** Adds each file's line counts, summed across `stats` (unstaged, staged, new files). */
export function withCounts(status: RepoStatus, stats: readonly ReadonlyMap<string, LineStat>[]): RepoStatus {
  const files = status.files.map(file => {
    const found = stats.map(map => map.get(file.path)).filter(stat => stat !== undefined)
    if (found.length === 0) return file

    return {
      ...file,
      added: found.reduce((sum, stat) => sum + stat.added, 0),
      removed: found.reduce((sum, stat) => sum + stat.removed, 0),
      isBinary: found.some(stat => stat.isBinary),
    }
  })

  return { ...status, files }
}
