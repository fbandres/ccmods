import { expect, test } from 'claude-code/testing'

import type { PullRequest } from '../types'
import { fitPrRow, markOf, parsePrs, prsRepoOf, worstMark } from './prs'
import { widthOf } from './text'

test('prsRepoOf: the code repo itself, -issues repos too; others none', () => {
  expect(prsRepoOf('https://github.com/fbandres/ccmods.git')).toBe('fbandres/ccmods')
  expect(prsRepoOf('https://github.com/fbandres/ccmods-issues.git')).toBe('fbandres/ccmods-issues')
  expect(prsRepoOf('https://gitlab.com/fbandres/ccmods.git')).toBeUndefined()
})

const run = (conclusion: string | null, status = 'COMPLETED') => ({ __typename: 'CheckRun', status, conclusion })
const ctx = (state: string) => ({ __typename: 'StatusContext', state })

test('markOf: drafts first, then failed, changes requested, running, passed, none', () => {
  expect(markOf({ isDraft: true, statusCheckRollup: [run('FAILURE')] })).toBe('D')
  for (const failed of ['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE']) {
    expect(markOf({ statusCheckRollup: [run('SUCCESS'), run(failed)] })).toBe('✗')
  }
  expect(markOf({ statusCheckRollup: [ctx('ERROR')] })).toBe('✗')
  expect(markOf({ statusCheckRollup: [ctx('FAILURE')] })).toBe('✗')
  expect(markOf({ reviewDecision: 'CHANGES_REQUESTED', statusCheckRollup: [run('SUCCESS')] })).toBe('R')
  expect(markOf({ reviewDecision: 'CHANGES_REQUESTED', statusCheckRollup: [run('FAILURE')] })).toBe('✗')
  expect(markOf({ statusCheckRollup: [run(null, 'IN_PROGRESS'), run('SUCCESS')] })).toBe('●')
  expect(markOf({ statusCheckRollup: [ctx('PENDING')] })).toBe('●')
  expect(markOf({ statusCheckRollup: [ctx('EXPECTED')] })).toBe('●')
  expect(markOf({ statusCheckRollup: [run('SUCCESS'), run('NEUTRAL'), run('SKIPPED'), ctx('SUCCESS')] })).toBe('✓')
  expect(markOf({ statusCheckRollup: [] })).toBe('')
  expect(markOf({ statusCheckRollup: null })).toBe('')
  expect(markOf({ reviewDecision: 'APPROVED' })).toBe('')
  expect(markOf({ statusCheckRollup: [run('WEIRD'), run('SUCCESS')] })).toBe('✓')
  expect(markOf({ statusCheckRollup: [run('WEIRD'), ctx('ODD'), 'junk', null] })).toBe('')
})

test('parsePrs: newest first, clean titles, author login, mark filled in', () => {
  const json = JSON.stringify([
    { number: 3, title: 'Old one', isDraft: false, reviewDecision: '', statusCheckRollup: [], author: { login: 'alice' }, updatedAt: '2026-10-01T10:00:00Z', url: 'u3' },
    { number: 9, title: 'Fix\nscroll‮ 🧭', isDraft: true, statusCheckRollup: [], updatedAt: '2026-10-31T10:00:00Z', url: 'u9' },
  ])
  const [a, b] = parsePrs(json)
  expect(a).toEqual({ number: 9, title: 'Fix scroll 🧭', author: '', mark: 'D', updatedAt: '2026-10-31T10:00:00Z', url: 'u9' })
  expect(b?.author).toBe('alice')
  expect(b?.mark).toBe('')
  expect(() => parsePrs('nope')).toThrow()
})

const pr = (mark: PullRequest['mark'], title = 'A pull request'): PullRequest => ({ number: 12, title, author: '', mark, updatedAt: '', url: '' })

test('worstMark: failed beats changes requested; drafts and passes never count', () => {
  expect(worstMark([pr('✓'), pr('R')])).toBe('R')
  expect(worstMark([pr('R'), pr('✗')])).toBe('✗')
  expect(worstMark([pr('D'), pr('✓')])).toBeUndefined()
  expect(worstMark([])).toBeUndefined()
})

test('fitPrRow: keeps the mark, drops the age before the title gets short', () => {
  expect(fitPrRow(pr('✓', 'Add dark theme'), 50, '2h')).toEqual({ head: '#12 ', title: 'Add dark theme', age: '2h' })
  const narrow = fitPrRow(pr('✓', 'x'.repeat(40)), 20, '2h')
  expect(narrow.age).toBe('')
  expect(narrow.title.endsWith('…')).toBe(true)
  expect(narrow.head.length + widthOf(narrow.title) + 2).toBeLessThanOrEqual(20)
  const mid = fitPrRow(pr('✓', 'x'.repeat(40)), 30, '2h')
  expect(mid.age).toBe('2h')
  expect(mid.head.length + widthOf(mid.title) + 2 + 3).toBeLessThanOrEqual(30)
})
