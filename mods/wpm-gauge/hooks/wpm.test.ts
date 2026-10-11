import { expect, test } from 'claude-code/testing'

import { barsOf, colorOf, gaugeOf, wpmOf } from './wpm'

const typeAt = (wpm: number, seconds: number) => {
  const perChar = 60_000 / (wpm * 5)
  const n = Math.round((seconds * 1000) / perChar)
  return Array.from({ length: n }, (_, i) => ({ at: i * perChar, chars: 1 }))
}
const lastAt = (strokes: { at: number }[]) => strokes[strokes.length - 1]?.at ?? 0

test('no typing reads zero and an empty gauge', async () => {
  expect(wpmOf([], 1000)).toBe(0)
  expect(barsOf(0)).toBe(0)
  expect(gaugeOf(0).empty).toBe('▱▱▱▱▱')
  expect(colorOf(0)).toBe('subtle')
})

test('steady 50 WPM reads about 50 and fills 3 bars', async () => {
  const strokes = typeAt(50, 8)
  const w = wpmOf(strokes, lastAt(strokes))
  expect(Math.abs(w - 50) <= 2).toBe(true)
  expect(barsOf(w)).toBe(3)
})

test('fast typing maxes out at 5 bars', async () => {
  const strokes = typeAt(120, 5)
  expect(barsOf(wpmOf(strokes, lastAt(strokes)))).toBe(5)
})

test('gauge drains to zero after 10s idle', async () => {
  const strokes = typeAt(80, 3)
  expect(wpmOf(strokes, 3000 + 10_500)).toBe(0)
})
