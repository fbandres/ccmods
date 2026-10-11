import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { barsOf, colorOf, gaugeOf, prune, wpmOf } from './wpm'
import type { Stroke } from './wpm'

const wpm = atom({ plugin: 'wpm-gauge', key: 'wpm' } as const, 0)
const peak = atom({ plugin: 'wpm-gauge', key: 'peak' } as const, 0)

// Longer single inserts are pastes, not typing.
const MAX_BURST = 8
// Recomputes the reading from the strokes still in the window; returns them.
async function refresh($: EngineInterface, strokes: Stroke[], now: number): Promise<Stroke[]> {
  const live = prune(strokes, now)
  const value = wpmOf(live, now)
  if ((await read($, wpm)) !== value) await update($, wpm, () => value)
  const charsInWindow = live.reduce((n, s) => n + s.chars, 0)
  // Peak belongs to the current typing streak: it clears once the gauge
  // drains to zero, and the next streak builds a fresh one.
  const best = await read($, peak)
  if (value === 0 && best !== 0) {
    await update($, peak, () => 0)
  } else if (charsInWindow >= 15 && value > best) {
    await update($, peak, () => value)
  }
  return live
}

export const register: Register = on => {
  let strokes: Stroke[] = []

  on('session.start', async ($, e, next) => {
    // Drain the gauge once typing stops.
    $.clock.every(1000, async () => {
      if (strokes.length) strokes = await refresh($, strokes, await $.clock.now())
    })
    return next(e)
  })

  on('prompt.edit', async ($, e, next) => {
    const result = await next(e)
    const typed = e.inputText.length
    const isTyping =
      typed > 0 && typed <= MAX_BURST && !e.key?.ctrl && !e.key?.meta && e.start === e.end
    if (isTyping) {
      const now = await $.clock.now()
      strokes.push({ at: now, chars: typed })
      strokes = await refresh($, strokes, now)
    }
    return result
  })

  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const value = await read($, wpm)
    const best = await read($, peak)
    const bars = barsOf(value)
    const color = colorOf(bars)
    const { filled, empty } = gaugeOf(bars)
    const { Box, Text } = $.ui.resolve(e)

    return (
      <Box flexDirection="row" justifyContent="space-between">
        <Box flexDirection="row">
          <Text color={color} bold={bars === 5}>{filled}</Text>
          <Text dimColor>{empty}</Text>
          <Text color={color} bold={bars === 5}>
            {` ${String(value).padStart(3)} WPM`}
          </Text>
          {bars === 5 ? <Text color={color}> ⚡</Text> : null}
          <Text dimColor>
            {best ? ` · peak ${best}` : ''}
          </Text>
        </Box>
        <Text dimColor>{e.props.hint ? ` ${e.props.hint}` : ''}</Text>
      </Box>
    )
  })
}
