import { expect, test } from 'claude-code/testing'

import type { TabText } from './tabs'
import { tabTexts } from './tabs'

const joined = (t: TabText | undefined) => (t ? t.before + t.count + t.after : undefined)
const all = (texts: ReturnType<typeof tabTexts>) => ({ changes: joined(texts.changes), issues: joined(texts.issues), prs: joined(texts.prs) })

test('tabTexts: full names, then short, then letters, always within the width', () => {
  expect(tabTexts(40, { changes: '2', issues: '5' }, 'changes').changes).toEqual({ before: '[Changes ', count: '2', after: ']' })
  expect(all(tabTexts(40, { changes: '2', issues: '5' }, 'changes'))).toEqual({ changes: '[Changes 2]', issues: ' Issues 5 ', prs: undefined })
  expect(all(tabTexts(40, { changes: '2', issues: '5' }, 'issues'))).toEqual({ changes: ' Changes 2 ', issues: '[Issues 5]', prs: undefined })
  expect(all(tabTexts(20, { changes: '999', issues: '100+' }, 'changes'))).toEqual({ changes: '[Chg 999]', issues: ' Iss 100+ ', prs: undefined })
  expect(all(tabTexts(20, { changes: '123456', issues: '100+' }, 'issues'))).toEqual({ changes: ' C 123456 ', issues: '[I 100+]', prs: undefined })
  for (const width of [20, 22, 25, 26, 30]) {
    const t = all(tabTexts(width, { changes: '1234', issues: '100+' }, 'changes'))
    expect((t.changes?.length ?? 0) + 1 + (t.issues?.length ?? 0)).toBeLessThanOrEqual(width)
  }
})

test('tabTexts: PRs without Issues, and all three in order', () => {
  const two = tabTexts(40, { changes: '2', prs: '3' }, 'prs')
  expect(Object.keys(two)).toEqual(['changes', 'prs'])
  expect(joined(two.prs)).toBe('[PRs 3]')
  expect(all(tabTexts(40, { changes: '2', issues: '5', prs: '3' }, 'changes'))).toEqual({ changes: '[Changes 2]', issues: ' Issues 5 ', prs: ' PRs 3 ' })
  expect(all(tabTexts(26, { changes: '40', issues: '63', prs: '7' }, 'changes'))).toEqual({ changes: '[Chg 40]', issues: ' Iss 63 ', prs: ' PR 7 ' })
  for (const width of [22, 24, 26, 30]) {
    const t = all(tabTexts(width, { changes: '40', issues: '100+', prs: '7' }, 'prs'))
    expect((t.changes?.length ?? 0) + (t.issues?.length ?? 0) + (t.prs?.length ?? 0) + 2).toBeLessThanOrEqual(width)
  }
})
