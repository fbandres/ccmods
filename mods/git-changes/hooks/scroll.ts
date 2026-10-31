/** Which rows of a list show: `[start, end)`, and how many hide above and below (a marker row each). */
export type ListWindow = { start: number; end: number; above: number; below: number }

function clamp(value: number, low: number, high: number) {
  return Math.min(Math.max(value, low), high)
}

/**
 * The window over a list of `length` rows that starts near `offset`, in `room`
 * rows that also hold the `↑ N above` / `↓ N more` markers. Under 3 rows of
 * room the markers are dropped and rows fill it.
 */
export function windowOf(length: number, offset: number, room: number): ListWindow {
  const rows = Math.max(1, room)
  if (length <= rows) return { start: 0, end: length, above: 0, below: 0 }
  if (rows < 3) {
    const start = clamp(offset, 0, length - rows)
    return { start, end: start + rows, above: 0, below: 0 }
  }

  const start = clamp(offset, 0, length - (rows - 1)) // at the end only the ↑ marker shows
  const shown = rows - (start > 0 ? 1 : 0)
  if (start + shown >= length) return { start, end: length, above: start, below: 0 }
  const end = start + shown - 1

  return { start, end, above: start, below: length - end }
}

/** The offset after moving `by` rows (a wheel tick, a page), clamped to the list. */
export function scrolled(offset: number, by: number, length: number, room: number): number {
  return windowOf(length, offset + by, room).start
}

/** The offset nearest `offset` whose window shows row `index`. */
export function followed(offset: number, index: number, length: number, room: number): number {
  const now = windowOf(length, offset, room)
  if (index < now.start) return windowOf(length, index, room).start
  if (index < now.end) return now.start
  for (let start = now.start + 1; start < length; start++) {
    const next = windowOf(length, start, room)
    if (index < next.end) return next.start
  }

  return now.start
}

/**
 * Rows to move for a `ui.scroll` step: a wheel tick as given, an engine page
 * (`by` of a whole body or more) as one list page, the rows between the markers.
 */
export function stepOf(by: number, bodyRows: number, room: number): number {
  if (Math.abs(by) < bodyRows) return by
  return Math.sign(by) * Math.max(1, room - 2)
}
