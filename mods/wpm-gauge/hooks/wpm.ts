// Pure gauge math, kept apart from the hooks so tests can drive it directly.

export const WINDOW_MS = 10_000
export const BARS = 5
export const WPM_PER_BAR = 20
// Below this many characters in the window the reading is too noisy to trust.
const MIN_CHARS = 3
// A short burst over a near-zero span would read as thousands of WPM.
const MIN_SPAN_MS = 2_000

export type Stroke = { at: number; chars: number }

export function prune(strokes: readonly Stroke[], now: number): Stroke[] {
  return strokes.filter(s => now - s.at <= WINDOW_MS)
}

// Standard WPM: one word = 5 characters.
export function wpmOf(strokes: readonly Stroke[], now: number): number {
  const live = prune(strokes, now)
  const chars = live.reduce((n, s) => n + s.chars, 0)
  if (chars < MIN_CHARS) return 0
  const span = Math.max(MIN_SPAN_MS, now - (live[0]?.at ?? now))
  return Math.round(chars / 5 / (span / 60_000))
}

export function barsOf(wpm: number): number {
  if (wpm <= 0) return 0
  return Math.min(BARS, Math.floor(wpm / WPM_PER_BAR) + 1)
}

const TIER_COLORS = ['#e5534b', '#f0883e', '#d4b106', '#3fb950', '#39c5cf']

export function colorOf(bars: number): string {
  return TIER_COLORS[bars - 1] ?? 'subtle'
}

export function gaugeOf(bars: number): { filled: string; empty: string } {
  return { filled: '▰'.repeat(bars), empty: '▱'.repeat(BARS - bars) }
}
