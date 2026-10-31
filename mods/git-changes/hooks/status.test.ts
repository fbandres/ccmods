import { expect, test } from 'claude-code/testing'

import { countLines, fitRow, parseNumstat, parseStatus, pickLetter, withCounts } from './status'
import { widthOf } from './text'

const HEAD = '# branch.oid 1a2b3c4d5e6f\0# branch.head main\0'
const NOW = 1_760_000_000_000

test('pickLetter: one letter per file, ! > D > A > R > M > U', () => {
  expect(pickLetter('.', 'M', 'ordinary')).toBe('M')
  expect(pickLetter('M', 'M', 'ordinary')).toBe('M')
  expect(pickLetter('A', 'M', 'ordinary')).toBe('A')
  expect(pickLetter('M', 'D', 'ordinary')).toBe('D')
  expect(pickLetter('D', '.', 'ordinary')).toBe('D')
  expect(pickLetter('R', '.', 'renamed')).toBe('R')
  expect(pickLetter('R', 'M', 'renamed')).toBe('R')
  expect(pickLetter('R', 'D', 'renamed')).toBe('D')
  expect(pickLetter('U', 'U', 'unmerged')).toBe('!')
  expect(pickLetter('?', '?', 'untracked')).toBe('U')
})

test('modified and untracked', () => {
  const raw =
    HEAD +
    '1 .M N... 100644 100644 100644 aaa bbb package-lock.json\0' +
    '? assets/logo.png\0'
  expect(parseStatus(raw, NOW)).toEqual({
    branch: 'main',
    isDetached: false,
    ahead: 0,
    behind: 0,
    updatedAt: NOW,
    files: [
      { path: 'package-lock.json', letter: 'M' },
      { path: 'assets/logo.png', letter: 'U' },
    ],
  })
})

test('staged add with unstaged edit is one row, A', () => {
  const raw = HEAD + '1 AM N... 000000 100644 100644 000 bbb api/New.cs\0'
  expect(parseStatus(raw, NOW).files).toEqual([{ path: 'api/New.cs', letter: 'A' }])
})

test('deleted', () => {
  const raw = HEAD + '1 D. N... 100644 000000 000000 aaa 000 old.ts\0'
  expect(parseStatus(raw, NOW).files).toEqual([{ path: 'old.ts', letter: 'D' }])
})

test('renamed: new path only, no phantom row for the original', () => {
  const raw = HEAD + '2 R. N... 100644 100644 100644 aaa aaa R100 src/new.ts\0src/old.ts\0'
  expect(parseStatus(raw, NOW).files).toEqual([{ path: 'src/new.ts', letter: 'R' }])
})

test('conflict', () => {
  const raw = HEAD + 'u UU N... 100644 100644 100644 100644 aaa bbb ccc api/Program.cs\0'
  expect(parseStatus(raw, NOW).files).toEqual([{ path: 'api/Program.cs', letter: '!' }])
})

test('path with spaces', () => {
  const raw = HEAD + '1 .M N... 100644 100644 100644 aaa bbb docs/my notes ñ.md\0'
  expect(parseStatus(raw, NOW).files).toEqual([{ path: 'docs/my notes ñ.md', letter: 'M' }])
})

test('detached HEAD shows the short sha', () => {
  const raw = '# branch.oid a1b2c3d4e5f6\0# branch.head (detached)\0'
  const status = parseStatus(raw, NOW)
  expect(status.branch).toBe('a1b2c3d')
  expect(status.isDetached).toBe(true)
})

test('initial commit keeps the branch name', () => {
  const raw = '# branch.oid (initial)\0# branch.head main\0? README.md\0'
  const status = parseStatus(raw, NOW)
  expect(status.branch).toBe('main')
  expect(status.isDetached).toBe(false)
})

test('ahead and behind', () => {
  const raw = HEAD + '# branch.upstream origin/main\0# branch.ab +2 -1\0'
  const status = parseStatus(raw, NOW)
  expect(status.ahead).toBe(2)
  expect(status.behind).toBe(1)
})

test('clean repo', () => {
  expect(parseStatus(HEAD, NOW).files).toEqual([])
})

test('fitRow: name and dim parent folder when both fit', () => {
  expect(fitRow('frontend/src/index.ts', 40)).toEqual({ name: 'index.ts', dir: 'frontend/src' })
  expect(fitRow('package-lock.json', 40)).toEqual({ name: 'package-lock.json', dir: '' })
})

test('fitRow: folder is cut first, then the name keeps its extension', () => {
  expect(fitRow('frontend/src/features/index.ts', 20)).toEqual({ name: 'index.ts', dir: 'frontend/s…' })
  expect(fitRow('docs/quarterly-review-deck.pptx', 16)).toEqual({ name: 'quarterly-….pptx', dir: '' })
})

test('fitRow: no extension, plain cut', () => {
  expect(fitRow('a-very-long-makefile-name', 10)).toEqual({ name: 'a-very-lo…', dir: '' })
})

test('parseNumstat: counts, binary, rename and spaces', () => {
  const raw =
    '40\t15\tpackage-lock.json\0' +
    '-\t-\tdocs/logo.png\0' +
    '3\t1\t\0src/old.ts\0src/new.ts\0' +
    '2\t0\tdocs/my notes.md\0'
  expect([...parseNumstat(raw)]).toEqual([
    ['package-lock.json', { added: 40, removed: 15, isBinary: false }],
    ['docs/logo.png', { added: 0, removed: 0, isBinary: true }],
    ['src/new.ts', { added: 3, removed: 1, isBinary: false }],
    ['docs/my notes.md', { added: 2, removed: 0, isBinary: false }],
  ])
})

test('parseNumstat: empty output', () => {
  expect(parseNumstat('').size).toBe(0)
})

test('countLines: lines added by a new file', () => {
  expect(countLines('a\nb\nc\n')).toEqual({ added: 3, removed: 0, isBinary: false })
  expect(countLines('a\nb')).toEqual({ added: 2, removed: 0, isBinary: false })
  expect(countLines('')).toEqual({ added: 0, removed: 0, isBinary: false })
  expect(countLines('PNG\0\x01')).toEqual({ added: 0, removed: 0, isBinary: true })
})

test('withCounts: staged and unstaged add up per file; unknown files stay bare', () => {
  const raw =
    HEAD +
    '1 MM N... 100644 100644 100644 aaa bbb api.ts\0' +
    '1 .M N... 100644 100644 100644 aaa bbb logo.png\0' +
    '1 .M N... 100644 100644 100644 aaa bbb untouched.ts\0'
  const unstaged = parseNumstat('2\t1\tapi.ts\0-\t-\tlogo.png\0')
  const staged = parseNumstat('5\t3\tapi.ts\0')
  expect(withCounts(parseStatus(raw, NOW), [unstaged, staged]).files).toEqual([
    { path: 'api.ts', letter: 'M', added: 7, removed: 4, isBinary: false },
    { path: 'logo.png', letter: 'M', added: 0, removed: 0, isBinary: true },
    { path: 'untouched.ts', letter: 'M' },
  ])
})

test('fitRow: wide file names are cut by columns, keeping the extension', () => {
  const row = fitRow('ドキュメント/四半期レビュー資料.pptx', 16)
  expect(row.dir).toBe('')
  expect(row.name.endsWith('….pptx')).toBe(true)
  expect(widthOf(row.name)).toBeLessThanOrEqual(16)
  const both = fitRow('資料/メモ.md', 20)
  expect(both).toEqual({ name: 'メモ.md', dir: '資料' })
  expect(widthOf(fitRow('フォルダ名がとても長い/メモ.md', 16).dir) + 1 + widthOf('メモ.md')).toBeLessThanOrEqual(16)
})
