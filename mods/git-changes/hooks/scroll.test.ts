import { expect, test } from 'claude-code/testing'

import { arrivalOf, followed, scrolled, stepOf, windowOf, wrapMove } from './scroll'

test('windowOf: everything fits, no markers', () => {
  expect(windowOf(5, 0, 8)).toEqual({ start: 0, end: 5, above: 0, below: 0 })
  expect(windowOf(5, 3, 8)).toEqual({ start: 0, end: 5, above: 0, below: 0 }) // offset ignored when it fits
})

test('windowOf: top, middle, end of a long list', () => {
  expect(windowOf(40, 0, 8)).toEqual({ start: 0, end: 7, above: 0, below: 33 })
  expect(windowOf(40, 14, 8)).toEqual({ start: 14, end: 20, above: 14, below: 20 })
  expect(windowOf(40, 33, 8)).toEqual({ start: 33, end: 40, above: 33, below: 0 })
})

test('windowOf: an offset past the end clamps (the list shrank)', () => {
  expect(windowOf(10, 30, 8)).toEqual({ start: 3, end: 10, above: 3, below: 0 })
  expect(windowOf(0, 5, 8)).toEqual({ start: 0, end: 0, above: 0, below: 0 })
  expect(windowOf(40, -4, 8)).toEqual({ start: 0, end: 7, above: 0, below: 33 })
})

test('windowOf: tiny rooms still show something', () => {
  expect(windowOf(40, 0, 1)).toEqual({ start: 0, end: 1, above: 0, below: 0 }) // room < 3: rows only, no markers
  expect(windowOf(40, 10, 2)).toEqual({ start: 10, end: 12, above: 0, below: 0 })
  expect(windowOf(40, 39, 2)).toEqual({ start: 38, end: 40, above: 0, below: 0 }) // clamps to the last full window
  expect(windowOf(40, 0, 0)).toEqual({ start: 0, end: 1, above: 0, below: 0 })
})

test('scrolled: wheel and pages clamp at both ends', () => {
  expect(scrolled(0, -1, 40, 8)).toBe(0)
  expect(scrolled(0, 8, 40, 8)).toBe(8)
  expect(scrolled(30, 8, 40, 8)).toBe(33)
})

test('followed: brings a row into view with the least move', () => {
  expect(followed(0, 3, 40, 8)).toBe(0) // already visible
  expect(followed(0, 7, 40, 8)).toBe(2) // just below: becomes the last visible row of a middle window
  expect(followed(20, 15, 40, 8)).toBe(15) // above: becomes the first row
  expect(followed(0, 39, 40, 8)).toBe(33) // the last row: the end window
})

test('stepOf: wheel ticks pass through, engine pages become list pages', () => {
  expect(stepOf(1, 52, 8)).toBe(1)
  expect(stepOf(-3, 52, 8)).toBe(-3)
  expect(stepOf(52, 52, 8)).toBe(6) // a page: the rows between the markers
  expect(stepOf(-52, 52, 8)).toBe(-6)
  expect(stepOf(52, 52, 2)).toBe(1)
  expect(stepOf(0, 52, 8)).toBe(0)
})

test('wrapMove: only the ring stepping off an edge row onto its neighbour button is a one-row move', () => {
  const middle = windowOf(40, 14, 8) // rows 14..19 show, rows hide above and below
  expect(wrapMove(19, 'after', middle)).toBe(1) // ↓ from the last row onto the more row
  expect(wrapMove(14, 'before', middle)).toBe(-1) // ↑ from the first row onto the Issues tab
  expect(wrapMove(14, 15, middle)).toBe(0) // an ordinary step
  expect(wrapMove(19, 14, middle)).toBe(0) // a click on the first row: not a wrap
  expect(wrapMove(14, 19, middle)).toBe(0) // a click on the last row
  expect(wrapMove(16, 'after', middle)).toBe(0) // a click on the more row from mid-list
  const end = windowOf(40, 33, 8) // nothing below
  expect(wrapMove(39, 'after', end)).toBe(0)
  expect(wrapMove(-1, 33, end)).toBe(0) // first focus
})

test('arrivalOf: any tab above the list is before it, the more row after, a row its index', () => {
  expect(arrivalOf('tab-prs', 'issues', [5, 4])).toBe('before')
  expect(arrivalOf('tab-changes', 'issues', [5, 4])).toBe('before')
  expect(arrivalOf('tab-prs', 'prs', [9])).toBe('before')
  expect(arrivalOf('issues-more', 'issues', [5, 4])).toBe('after')
  expect(arrivalOf('prs-more', 'prs', [9])).toBe('after')
  expect(arrivalOf('issue-4', 'issues', [5, 4])).toBe(1)
  expect(arrivalOf('pr-9', 'prs', [9])).toBe(0)
  expect(arrivalOf('pr-9', 'issues', [9])).toBe(-1)
  expect(arrivalOf(undefined, 'prs', [9])).toBe(-1)
})
