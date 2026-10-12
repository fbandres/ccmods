import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { expect, mock, test } from 'claude-code/testing'

import { isThemeNamed, normalizeHex, parseJsonc, pickBackground, themeFile } from './theme'

const HOME = '/h/dev'
const APP = '/Applications/Visual Studio Code.app/Contents/Resources/app'
const BUILT_IN = `${APP}/extensions`
const OUT = `${HOME}/.claude/themes/editor-match.json`

test('parseJsonc reads comments and trailing commas, keeping // inside strings', () => {
  const text = '{\n  // the theme\n  "a": "http://x", /* old */\n  "b": [1, 2,],\n}'
  expect(parseJsonc(text)).toEqual({ a: 'http://x', b: [1, 2] })
})

test('normalizeHex widens #rgb, drops alpha and refuses non-hex', () => {
  expect(normalizeHex('#ABC')).toBe('#aabbcc')
  expect(normalizeHex('#191A1BFF')).toBe('#191a1b')
  expect(normalizeHex('red')).toBeUndefined()
  expect(normalizeHex(3)).toBeUndefined()
})

test('isThemeNamed matches id or label, with or without "Default "', () => {
  expect(isThemeNamed({ id: 'Dark Modern', path: '' }, 'Default Dark Modern')).toBe(true)
  expect(isThemeNamed({ label: 'One Dark Pro', path: '' }, 'one dark pro')).toBe(true)
  expect(isThemeNamed({ id: 'Dark+', path: '' }, 'Dark Modern')).toBe(false)
})

test('pickBackground: terminal, then panel, then editor; customizations win, scoped ones most', () => {
  const theme = { 'editor.background': '#121314', 'panel.background': '#191a1b' }
  expect(pickBackground(theme, undefined, 'Dark 2026')).toBe('#191a1b')
  expect(pickBackground({ 'editor.background': '#121314' }, {}, 'Dark 2026')).toBe('#121314')
  expect(pickBackground(theme, { 'terminal.background': '#000000' }, 'Dark 2026')).toBe('#000000')
  const scoped = { 'terminal.background': '#000000', '[Dark 2026]': { 'terminal.background': '#111111' } }
  expect(pickBackground(theme, scoped, 'Dark 2026')).toBe('#111111')
  expect(pickBackground({}, {}, 'Dark 2026')).toBeUndefined()
})

/** A file system in memory: reads, lists and records writes. */
function fakeFs(on: On, files: Record<string, string>) {
  const written: Record<string, string> = {}
  on('fs.read', async (_$, e) => {
    const text = written[e.path] ?? files[e.path]
    return text === undefined ? { deny: 'no such file' } : { value: text }
  })
  on('fs.list', async (_$, e) => {
    const names = new Set(
      Object.keys(files)
        .filter(path => path.startsWith(`${e.path}/`))
        .map(path => path.slice(e.path.length + 1).split('/')[0] ?? ''),
    )
    return { value: [...names].map(name => ({ name, kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false })) }
  })
  on('fs.write', async (_$, e) => {
    written[e.path] = e.text
    return { value: undefined }
  })
  return written
}

const VSCODE_ENV = {
  TERM_PROGRAM: 'vscode',
  VSCODE_GIT_ASKPASS_MAIN: `${BUILT_IN}/git/dist/askpass-main.js`,
  HOME,
}

const VSCODE_FILES = {
  [`${APP}/product.json`]: JSON.stringify({ nameShort: 'Code', dataFolderName: '.vscode' }),
  [`${BUILT_IN}/theme-defaults/package.json`]: JSON.stringify({
    contributes: {
      themes: [
        { id: 'Dark 2026', uiTheme: 'vs-dark', path: './themes/2026-dark.json' },
        { id: 'Light Modern', uiTheme: 'vs', path: './themes/light_modern.json' },
      ],
    },
  }),
  [`${BUILT_IN}/theme-defaults/themes/2026-dark.json`]: JSON.stringify({
    include: './dark_modern.json',
    type: 'dark',
    colors: { 'terminal.background': '#191A1B' },
  }),
  [`${BUILT_IN}/theme-defaults/themes/dark_modern.json`]: JSON.stringify({ colors: { 'editor.background': '#1F1F1F' } }),
  [`${BUILT_IN}/theme-defaults/themes/light_modern.json`]: '{ "type": "light", "colors": { "editor.background": "#FFFFFF", }, }',
}

async function start($: Engine, on: On) {
  mock.store(on, { shown: false })
  const clock = mock.clock(on)
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.settle()
}

test('in VS Code with no theme set, the default dark theme\'s terminal background is written', async ($, on) => {
  mock.env(on, VSCODE_ENV)
  const written = fakeFs(on, VSCODE_FILES)

  await start($, on)
  expect(JSON.parse(written[OUT] ?? 'null')).toEqual({
    name: 'Match editor (git-changes)',
    base: 'dark',
    overrides: { composerSidebarBackground: '#191a1b' },
  })
})

test('the chosen theme and its customizations decide; a light theme makes a light base', async ($, on) => {
  mock.env(on, VSCODE_ENV)
  const settings = '{\n  // mine\n  "workbench.colorTheme": "Light Modern",\n}'
  const written = fakeFs(on, { ...VSCODE_FILES, [`${HOME}/Library/Application Support/Code/User/settings.json`]: settings })

  await start($, on)
  expect(written[OUT]).toBe(themeFile('#ffffff', true))
})

test('outside a VS Code terminal nothing is written', async ($, on) => {
  mock.env(on, { TERM_PROGRAM: 'iTerm.app', HOME })
  const written = fakeFs(on, VSCODE_FILES)

  await start($, on)
  expect(written).toEqual({})
})
