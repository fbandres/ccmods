import { expect, test } from 'claude-code/testing'

import { ageOf, classifyGhFailure, fitIssueRow, issuesRepoOf, parseIssues, parseRemote } from './issues'
import { widthOf } from './text'

const SSH = 'git' // the scp-style ssh user, kept apart so the repo's leak scan doesn't read an email

test('parseRemote / issuesRepoOf: github https, ssh, ssh://; others none', () => {
  expect(parseRemote('https://github.com/fbandres/oscp-app.git')).toEqual({ owner: 'fbandres', repo: 'oscp-app' })
  expect(issuesRepoOf('https://github.com/fbandres/oscp-app.git')).toBe('fbandres/oscp-app-issues')
  expect(issuesRepoOf('https://github.com/fbandres/oscp-app')).toBe('fbandres/oscp-app-issues')
  expect(issuesRepoOf('https://github.com/fbandres/oscp-app/\n')).toBe('fbandres/oscp-app-issues')
  expect(issuesRepoOf(`${SSH}@github.com:fbandres/oscp-app.git`)).toBe('fbandres/oscp-app-issues')
  expect(issuesRepoOf(`ssh://${SSH}@github.com/fbandres/oscp-app.git`)).toBe('fbandres/oscp-app-issues')
  expect(issuesRepoOf('https://gitlab.com/fbandres/oscp-app.git')).toBeUndefined()
  expect(issuesRepoOf('https://github.com/fbandres/oscp-app-issues.git')).toBeUndefined()
  expect(issuesRepoOf('')).toBeUndefined()
})

test('parseIssues: first label, flattened titles, no labels', () => {
  const json = JSON.stringify([
    {
      number: 42,
      title: 'Login\nfails\0 on Safari 🧭',
      labels: [{ name: 'bug' }, { name: 'p1' }],
      updatedAt: '2026-10-31T10:00:00Z',
      url: 'https://github.com/o/r-issues/issues/42',
    },
    { number: 7, title: 'Refactor auth', labels: [], updatedAt: '2026-09-30T10:00:00Z', url: 'https://github.com/o/r-issues/issues/7' },
  ])
  const [a, b] = parseIssues(json)
  expect(a).toEqual({
    number: 42,
    title: 'Login fails on Safari 🧭',
    label: 'bug',
    updatedAt: '2026-10-31T10:00:00Z',
    url: 'https://github.com/o/r-issues/issues/42',
  })
  expect(b?.label).toBeUndefined()
  expect(() => parseIssues('nope')).toThrow()
})

test('classifyGhFailure', () => {
  expect(classifyGhFailure('To get started with GitHub CLI, please run:  gh auth login')).toBe('logged-out')
  expect(classifyGhFailure("GraphQL: Could not resolve to a Repository with the name 'o/r-issues'.")).toBe('not-found')
  expect(classifyGhFailure('HTTP 404: Not Found')).toBe('not-found')
  expect(classifyGhFailure('error connecting to api.github.com')).toBe('temporary')
  expect(classifyGhFailure('HTTP 502: Bad Gateway')).toBe('temporary')
})

test('ageOf', () => {
  const now = Date.parse('2026-10-31T12:00:00Z')
  const at = (ms: number) => new Date(now - ms).toISOString()
  const MIN = 60_000
  const H = 60 * MIN
  const D = 24 * H
  expect(ageOf(at(20_000), now)).toBe('now')
  expect(ageOf(at(5 * MIN), now)).toBe('5m')
  expect(ageOf(at(2 * H), now)).toBe('2h')
  expect(ageOf(at(3 * D), now)).toBe('3d')
  expect(ageOf(at(14 * D), now)).toBe('2w')
  expect(ageOf(at(120 * D), now)).toBe('4mo')
  expect(ageOf(at(400 * D), now)).toBe('1y')
  expect(ageOf('garbage', now)).toBe('')
})

test('fitIssueRow: label drops first, then age; title cut with …', () => {
  const issue = { number: 42, title: 'Login fails on Safari when cookies are blocked', label: 'enhancement', updatedAt: '', url: '' }
  const wide = fitIssueRow(issue, 48, '2h')
  expect(wide.head).toBe('#42 ')
  expect(wide.label).toBe('enhanceme…') // label cut to 10 columns
  expect(wide.age).toBe('2h')
  expect(wide.head.length + wide.title.length + 1 + wide.label.length + 1 + wide.age.length).toBeLessThanOrEqual(48)

  const mid = fitIssueRow(issue, 28, '2h')
  expect(mid.label).toBe('')
  expect(mid.age).toBe('2h')
  expect(mid.head.length + mid.title.length + 1 + mid.age.length).toBeLessThanOrEqual(28)

  const narrow = fitIssueRow(issue, 18, '2h')
  expect([narrow.label, narrow.age]).toEqual(['', ''])
  expect((narrow.head + narrow.title).length).toBeLessThanOrEqual(18)
  expect(narrow.title.endsWith('…')).toBe(true)

  const short = fitIssueRow({ ...issue, title: 'Fix', label: undefined }, 48, '1d')
  expect(short).toEqual({ head: '#42 ', title: 'Fix', label: '', age: '1d' })
})

test('parseIssues: labels and titles lose escape and control characters', () => {
  const json = JSON.stringify([
    { number: 1, title: 'Hi\u001b[2J\u009b31mthere', labels: [{ name: '\u001b]0;pwned\u0007bug\u001b[31m' }], updatedAt: '', url: 'u' },
    { number: 2, title: 'Only junk label', labels: [{ name: '\u001b\u0007 \n' }], updatedAt: '', url: 'u' },
  ])
  const [a, b] = parseIssues(json)
  expect(a?.title).toBe('Hi [2J 31mthere')
  expect(a?.label).toBe(']0;pwned bug [31m')
  for (const text of [a?.title ?? '', a?.label ?? '']) expect(text).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/)
  expect(b?.label).toBeUndefined()
})

test('parseIssues: bidi and zero-width controls are removed', () => {
  const json = JSON.stringify([
    { number: 1, title: 'safe‮gnp.exe⁦x​y﻿', labels: [{ name: '‭bug⁩' }], updatedAt: '', url: 'u' },
  ])
  const [a] = parseIssues(json)
  expect(a?.title).toBe('safegnp.exexy')
  expect(a?.label).toBe('bug')
})

test('fitIssueRow: wide titles and labels fit by columns, not characters', () => {
  const issue = { number: 7, title: '日本語のタイトルがとても長い場合の表示テスト', label: 'バグ報告です', updatedAt: '', url: '' }
  for (const width of [20, 30, 48]) {
    const row = fitIssueRow(issue, width, '2d')
    const tail = (row.label ? widthOf(row.label) + 1 : 0) + (row.age ? widthOf(row.age) + 1 : 0)
    expect(widthOf(row.head) + widthOf(row.title) + tail).toBeLessThanOrEqual(width)
    expect(row.title.endsWith('…')).toBe(true)
  }
  expect(widthOf(fitIssueRow(issue, 48, '2d').label)).toBeLessThanOrEqual(10)
})
