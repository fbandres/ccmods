/**
 * Terminal columns, the way the pane's renderer counts them: East Asian wide
 * and fullwidth characters and emoji take two, combining marks and variation
 * selectors none. An approximation of Unicode's East Asian Width, enough that
 * a row never runs past the pane.
 */

const ZERO_WIDTH = /[\p{Mn}\p{Me}​-‏⁠-⁤︀-️]|[\u{E0100}-\u{E01EF}]/u
const EMOJI = /\p{Emoji_Presentation}/u
const PICTOGRAPH = /\p{Extended_Pictographic}/u
const WIDE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f], // Hangul Jamo
  [0x2e80, 0x303e], // CJK radicals, punctuation
  [0x3041, 0x33ff], // kana, CJK symbols
  [0x3400, 0x4dbf], // CJK extension A
  [0x4e00, 0x9fff], // CJK unified
  [0xa000, 0xa4cf], // Yi
  [0xa960, 0xa97f], // Hangul Jamo extended
  [0xac00, 0xd7a3], // Hangul syllables
  [0xf900, 0xfaff], // CJK compatibility
  [0xfe10, 0xfe19], // vertical forms
  [0xfe30, 0xfe6f], // CJK compatibility forms
  [0xff00, 0xff60], // fullwidth forms
  [0xffe0, 0xffe6], // fullwidth signs
  [0x1f300, 0x1f64f], // pictographs, emoticons
  [0x1f900, 0x1f9ff], // supplemental pictographs
  [0x20000, 0x3fffd], // CJK extensions B on
]

function isWide(char: string) {
  const code = char.codePointAt(0) ?? 0
  return EMOJI.test(char) || WIDE_RANGES.some(([low, high]) => code >= low && code <= high)
}

/** Each character with its columns; a pictograph asked to draw as emoji (U+FE0F next) takes two. */
function* cells(text: string): Generator<[string, number]> {
  const chars = [...text]
  for (let i = 0; i < chars.length; i++) {
    const char = chars[i] ?? ''
    if (ZERO_WIDTH.test(char)) yield [char, 0]
    else if (isWide(char) || (chars[i + 1] === '️' && PICTOGRAPH.test(char))) yield [char, 2]
    else yield [char, 1]
  }
}

/** The columns `text` takes in the terminal. */
export function widthOf(text: string): number {
  let width = 0
  for (const [, columns] of cells(text)) width += columns
  return width
}

/** The longest start of `text` that fits `columns`, keeping marks with their letter. */
export function sliceTo(text: string, columns: number): string {
  let width = 0
  let out = ''
  for (const [char, size] of cells(text)) {
    if (width + size > columns) break
    width += size
    out += char
  }
  return out
}

/** `text` cut to `width` columns, ending in `…`, with `keep` (an extension) kept at the end. */
export function cutTo(text: string, width: number, keep = ''): string {
  if (widthOf(text) <= width) return text
  const room = width - widthOf(keep) - 1
  if (room > 0) return `${sliceTo(text, room)}…${keep}`
  return width > 1 ? `${sliceTo(text, width - 1)}…` : sliceTo(text, Math.max(0, width))
}
