export type TabId = 'changes' | 'issues' | 'prs'
/** One tab's label in three pieces, so the count can take its own colour. */
export type TabText = { before: string; count: string; after: string }

const ORDER: readonly TabId[] = ['changes', 'issues', 'prs']
const NAMES: ReadonlyArray<Record<TabId, string>> = [
  { changes: 'Changes', issues: 'Issues', prs: 'PRs' },
  { changes: 'Chg', issues: 'Iss', prs: 'PR' },
  { changes: 'C', issues: 'I', prs: 'P' },
]

/**
 * The labels of the tabs that have a count, in order, for `width` columns (one
 * space between them): the active one in brackets. Full names, then short
 * ones, then letters, so the bar stays on one row.
 */
export function tabTexts(width: number, counts: { changes: string; issues?: string; prs?: string }, active: TabId) {
  const shown = ORDER.filter(id => counts[id] !== undefined)
  let texts: Partial<Record<TabId, TabText>> = {}
  for (const names of NAMES) {
    texts = {}
    for (const id of shown) {
      const isActive = id === active
      texts[id] = { before: `${isActive ? '[' : ' '}${names[id]} `, count: counts[id] ?? '', after: isActive ? ']' : ' ' }
    }
    const length = shown.reduce((sum, id) => sum + (texts[id]?.before.length ?? 0) + (texts[id]?.count.length ?? 0) + (texts[id]?.after.length ?? 0), 0)
    if (length + shown.length - 1 <= width) break
  }
  return texts
}
