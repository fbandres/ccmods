/** The Claude Code theme this mod keeps in step with the editor; picked once with /theme. */
export const THEME_SLUG = 'editor-match'
const THEME_NAME = 'Match editor (git-changes)'
export const DEFAULT_THEMES = ['Dark 2026', 'Dark Modern'] // VS Code's default dark, newest first
const BACKGROUND_KEYS = ['terminal.background', 'panel.background', 'editor.background']
export const MAX_INCLUDES = 5

export type Colors = Record<string, string>
export type ThemeEntry = { id?: string; label?: string; uiTheme?: string; path: string }

/** JSON with comments and trailing commas, as VS Code writes settings and themes. */
export function parseJsonc(text: string): unknown {
  let out = ''
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (char === '"') {
      const start = i
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === '\\') i++
      out += text.slice(start, i + 1)
    } else if (char === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
      out += '\n'
    } else if (char === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      i = end < 0 ? text.length : end + 1
    } else {
      out += char
    }
  }

  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'))
}

/** `#rgb`, `#rrggbb` or `#rrggbbaa` (alpha dropped) as `#rrggbb`; anything else is no color. */
export function normalizeHex(value: unknown) {
  if (typeof value !== 'string') return undefined
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(value.trim())?.[1]
  if (!hex) return undefined
  const full = hex.length === 3 ? [...hex].map(digit => digit + digit).join('') : hex.slice(0, 6)

  return `#${full.toLowerCase()}`
}

/** Whether a setting's theme name names this theme ("Default Dark Modern" names "Dark Modern"). */
export function isThemeNamed(entry: ThemeEntry, name: string) {
  const bare = (text: string) => text.replace(/^Default /, '').toLowerCase()
  return [entry.id, entry.label].some(own => own !== undefined && bare(own) === bare(name))
}

/** The terminal's background: the theme's colors under the person's customizations. */
export function pickBackground(themeColors: Colors, customizations: unknown, themeName: string) {
  const all = isRecord(customizations) ? customizations : {}
  const scoped = all[`[${themeName}]`]
  const colors = { ...themeColors, ...stringsOf(all), ...(isRecord(scoped) ? stringsOf(scoped) : {}) }
  for (const key of BACKGROUND_KEYS) {
    const hex = normalizeHex(colors[key])
    if (hex) return hex
  }

  return undefined
}

/** The theme file Claude Code reads from ~/.claude/themes. */
export function themeFile(background: string, isLight: boolean) {
  const theme = { name: THEME_NAME, base: isLight ? 'light' : 'dark', overrides: { composerSidebarBackground: background } }
  return `${JSON.stringify(theme, null, 2)}\n`
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function stringsOf(record: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => typeof value === 'string')) as Colors
}
