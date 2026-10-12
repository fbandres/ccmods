import { atom, read, update } from 'claude-code'
import type { EngineInterface as Engine, Register } from 'claude-code'

import type { FileChange, RepoStatus } from '../types'
import type { LineStat } from './status'
import { countLines, fitRow, LETTER_COLOR, parseNumstat, parseStatus, withCounts } from './status'
import type { Colors, ThemeEntry } from './theme'
import { DEFAULT_THEMES, isRecord, isThemeNamed, MAX_INCLUDES, parseJsonc, pickBackground, stringsOf, THEME_SLUG, themeFile } from './theme'

const PANE = 'git-changes'
const TITLE = 'Source Control'
const INTERVAL_MS = 2000
const DOCK_COLUMNS = 53 // the dock's opening width; a width the person drags to wins
const REFRESH_TOOLS = ['Edit', 'Write', 'Bash'] as const
const COMMAND = 'changes'
const FALLBACK_COMMAND = 'git-changes' // if a built-in ever takes /changes
const DESCRIPTION = 'Show or hide the Source Control pane of changed files'
const GIT_STATUS = ['git', '--no-optional-locks', 'status', '--porcelain=v2', '-b', '-z', '-uall']
const GIT_NUMSTAT = ['git', '--no-optional-locks', 'diff', '--numstat', '-z']
const GIT_NUMSTAT_STAGED = ['git', '--no-optional-locks', 'diff', '--cached', '--numstat', '-z']
const MAX_COUNTED_FILES = 50
const MAX_COUNTED_BYTES = 256 * 1024

const status = atom({ plugin: 'git-changes', key: 'status' } as const, null as RepoStatus | null)

let timer: { cancel: () => void } | undefined
let isChecking = false
let lastRaw: string | undefined
let root = ''

function isShown() {
  return timer !== undefined
}

async function isRepo($: Engine) {
  try {
    const run = await $.process.run(['git', 'rev-parse', '--show-toplevel'])
    if (run.exitCode !== 0) return false
    root = run.stdout.trim()
    return true
  } catch {
    return false
  }
}

function showError($: Engine, error: string) {
  return update($, status, now => ({
    ...(now ?? { branch: '', isDetached: false, ahead: 0, behind: 0, files: [], updatedAt: Date.now() }),
    error,
  }))
}

/** Line counts of new files, read from disk: small text files only. */
async function untrackedStats($: Engine, files: readonly FileChange[]) {
  const stats = new Map<string, LineStat>()
  const untracked = files.filter(file => file.letter === 'U').slice(0, MAX_COUNTED_FILES)
  for (const file of untracked) {
    const path = root ? `${root}/${file.path}` : file.path
    try {
      const stat = await $.fs.stat(path)
      if (stat.kind !== 'file' || stat.size > MAX_COUNTED_BYTES) continue
      const text = await $.fs.read(path)
      if (typeof text === 'string') stats.set(file.path, countLines(text))
    } catch {
      // Gone or unreadable since git listed it: the row shows no counts.
    }
  }

  return stats
}

/** A numstat run's output, or nothing when it failed (counts are extras). */
function numstatOf(run: { exitCode: number; stdout: string }) {
  return run.exitCode === 0 ? run.stdout : ''
}

async function refresh($: Engine) {
  if (isChecking) return
  isChecking = true
  try {
    const [run, unstagedRun, stagedRun] = await Promise.all([
      $.process.run(GIT_STATUS),
      $.process.run(GIT_NUMSTAT),
      $.process.run(GIT_NUMSTAT_STAGED),
    ])
    if (run.exitCode !== 0) {
      lastRaw = undefined
      await showError($, `git status failed: ${run.stderr.split('\n')[0]}`)
      return
    }
    const parsed = parseStatus(run.stdout, Date.now())
    const unstaged = numstatOf(unstagedRun)
    const staged = numstatOf(stagedRun)
    const fresh = await untrackedStats($, parsed.files)
    // An edit to an already-changed or new file changes no status line: the key holds every source.
    const raw = [run.stdout, unstaged, staged, JSON.stringify([...fresh])].join('\0\0')
    // Unchanged output skips the write only while a status is kept: the session's state can be emptied under us.
    if (raw === lastRaw && (await read($, status)) !== null) return
    lastRaw = raw
    const counted = withCounts(parsed, [parseNumstat(unstaged), parseNumstat(staged), fresh])
    await update($, status, () => counted)
  } catch {
    lastRaw = undefined
    await showError($, 'git status failed: git could not be started')
  } finally {
    isChecking = false
  }
}

async function readJsonc($: Engine, path: string) {
  try {
    const text = await $.fs.read(path)
    return typeof text === 'string' ? parseJsonc(text) : undefined
  } catch {
    return undefined
  }
}

function dirOf(path: string) {
  return path.slice(0, path.lastIndexOf('/'))
}

/** A theme file's colors, its `include` chain beneath them. */
async function themeColors($: Engine, path: string, depth = 0): Promise<{ colors: Colors; type?: string }> {
  const theme = await readJsonc($, path)
  if (!isRecord(theme)) return { colors: {} }
  const base =
    typeof theme.include === 'string' && depth < MAX_INCLUDES
      ? await themeColors($, `${dirOf(path)}/${theme.include.replace(/^\.\//, '')}`, depth + 1)
      : { colors: {} }
  const type = typeof theme.type === 'string' ? theme.type : base.type

  return { colors: { ...base.colors, ...(isRecord(theme.colors) ? stringsOf(theme.colors) : {}) }, type }
}

/** The first extension under these folders that contributes a theme by this name. */
async function findTheme($: Engine, folders: readonly string[], names: readonly string[]) {
  for (const name of names) {
    for (const folder of folders) {
      const entries = await $.fs.list(folder).catch(() => [])
      for (const entry of entries) {
        if (entry.kind !== 'dir') continue
        const extension = `${folder}/${entry.name}`
        const manifest = await readJsonc($, `${extension}/package.json`)
        const contributes = isRecord(manifest) && isRecord(manifest.contributes) ? manifest.contributes : {}
        const themes = Array.isArray(contributes.themes) ? (contributes.themes as ThemeEntry[]) : []
        const match = themes.find(theme => isRecord(theme) && typeof theme.path === 'string' && isThemeNamed(theme, name))
        if (match) return { ...match, path: `${extension}/${match.path.replace(/^\.\//, '')}`, name }
      }
    }
  }

  return undefined
}

/**
 * Reads the VS Code family editor this session runs in (VS Code, Cursor, ...) and writes its
 * terminal background into ~/.claude/themes/editor-match.json. Quietly does nothing elsewhere.
 */
async function syncEditorTheme($: Engine) {
  const [program, askpass, home] = await Promise.all([
    $.env.get('TERM_PROGRAM'),
    $.env.get('VSCODE_GIT_ASKPASS_MAIN'),
    $.env.get('HOME'),
  ])
  const cut = askpass?.indexOf('/extensions/git/') ?? -1
  if (program !== 'vscode' || !askpass || cut < 0 || !home) return

  const app = askpass.slice(0, cut) // .../Contents/Resources/app
  const product = await readJsonc($, `${app}/product.json`)
  if (!isRecord(product) || typeof product.nameShort !== 'string') return
  const dataFolder = typeof product.dataFolderName === 'string' ? product.dataFolderName : '.vscode'

  const userDirs = [`${home}/Library/Application Support/${product.nameShort}/User`, `${home}/.config/${product.nameShort}/User`]
  let settings: unknown
  for (const dir of userDirs) {
    settings = await readJsonc($, `${dir}/settings.json`)
    if (settings !== undefined) break
  }
  const all = isRecord(settings) ? settings : {}
  const chosen = typeof all['workbench.colorTheme'] === 'string' ? [all['workbench.colorTheme']] : DEFAULT_THEMES

  const theme = await findTheme($, [`${home}/${dataFolder}/extensions`, `${app}/extensions`], chosen)
  if (!theme) return
  const { colors, type } = await themeColors($, theme.path)
  const background = pickBackground(colors, all['workbench.colorCustomizations'], theme.name)
  if (!background) return

  const isLight = type === 'light' || theme.uiTheme === 'vs' || theme.uiTheme === 'hc-light'
  const path = `${home}/.claude/themes/${THEME_SLUG}.json`
  const text = themeFile(background, isLight)
  if ((await $.fs.read(path).catch(() => undefined)) !== text) await $.fs.write(path, text)
}

async function isPlaced($: Engine) {
  return (await $.ui.panes()).some(pane => pane.id === PANE && pane.isPlaced)
}

async function tick($: Engine) {
  if (await isPlaced($)) await refresh($)
}

/** Registers /changes, or /git-changes when the engine refuses the name. */
async function registerCommand($: Engine) {
  try {
    await $.command.register({ name: COMMAND, description: DESCRIPTION })
  } catch {
    try {
      await $.command.register({ name: FALLBACK_COMMAND, description: DESCRIPTION })
    } catch {
      // No command at all: the pane still opens from the stored state.
    }
  }
}

function startTimer($: Engine) {
  timer?.cancel()
  timer = $.clock.every(INTERVAL_MS, () => void tick($))
}

async function show($: Engine) {
  startTimer($)
  lastRaw = undefined // reopening always redraws from a fresh read
  await refresh($)
  await $.ui.open({ id: PANE, title: TITLE, columns: DOCK_COLUMNS })
}

/** On start: open at once, read git after, so a slow repo never holds the session. */
async function showOnStart($: Engine) {
  startTimer($)
  await $.ui.open({ id: PANE, title: TITLE, columns: DOCK_COLUMNS })
  void refresh($).catch(() => {}) // the module may unload before git answers
}

async function toggle($: Engine) {
  if (!(await isRepo($))) return { text: 'Not a git repository.' }

  const willShow = !(await isPlaced($))
  await $.store.set('shown', willShow)
  await (willShow ? show($) : hide($))

  return { text: `Source Control pane ${willShow ? 'shown' : 'hidden'}.` }
}

async function hide($: Engine) {
  timer?.cancel()
  timer = undefined
  await $.ui.close({ id: PANE })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await registerCommand($)
    if ((await $.store.get('shown')) !== false && (await isRepo($))) await showOnStart($)
    void syncEditorTheme($).catch(() => {}) // the pane's fill follows the editor; never holds the session

    return next(e)
  })

  const failed = { text: 'git-changes: the pane could not be toggled; see the transcript.' }
  on('command.run', { command: COMMAND }, $ => toggle($)).catch(() => failed)
  on('command.run', { command: FALLBACK_COMMAND }, $ => toggle($)).catch(() => failed)

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE && e.origin.kind !== 'plugin') {
      timer?.cancel()
      timer = undefined
      if (e.origin.kind === 'person') await $.store.set('shown', false)
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: REFRESH_TOOLS }, async ($, e, next) => {
    const ran = await next(e)
    if (isShown()) void refresh($)

    return ran
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const now = await read($, status)
    if (!now) return <Text dimColor>Reading git status…</Text>

    const width = Math.max(20, e.props.bodyColumns)
    const count = now.files.length
    const isDirty = count > 0
    const fixedRows = 4 + (isDirty ? 3 : 0) + (now.error ? 1 : 0) // header, dividers, footer; totals, label, "more"; error
    const room = Math.max(1, e.props.scroll.bodyRows - fixedRows)
    const shown = now.files.slice(0, room)
    const hiddenCount = count - shown.length
    const added = now.files.reduce((sum, file) => sum + (file.added ?? 0), 0)
    const removed = now.files.reduce((sum, file) => sum + (file.removed ?? 0), 0)
    const sync = now.ahead || now.behind ? `↑${now.ahead} ↓${now.behind}` : ''
    const divider = <Text dimColor>{'─'.repeat(width)}</Text>

    // Count columns line up across rows; dropped first when the pane is narrow.
    const plusWidth = Math.max(0, ...shown.map(file => (file.added ? `+${file.added}`.length : 0)))
    const minusWidth = Math.max(0, ...shown.map(file => (file.removed ? `-${file.removed}`.length : 0)))
    const countsWidth = Math.max(plusWidth + 1 + minusWidth, shown.some(file => file.isBinary) ? 3 : 0)
    const hasCounts = width - countsWidth >= 30

    return (
      <Box flexDirection="column">
        <Box justifyContent="space-between">
          <Text>
            <Text bold>⎇ {now.isDetached ? `(${now.branch})` : now.branch}</Text>
            {isDirty && <Text color="warning"> ●</Text>}
          </Text>
          {sync && <Text dimColor>{sync}</Text>}
        </Box>
        {isDirty && (
          <Box justifyContent="space-between">
            <Box gap={2}>
              <Text color="success">{`+${added}`}</Text>
              <Text color="error">{`-${removed}`}</Text>
            </Box>
            <Text dimColor>{count === 1 ? '1 file' : `${count} files`}</Text>
          </Box>
        )}
        {divider}
        {now.error && <Text color="error">{now.error}</Text>}
        {isDirty && (
          <Box justifyContent="space-between">
            <Text dimColor bold>
              CHANGES
            </Text>
            <Text inverse color="suggestion">{` ${count} `}</Text>
          </Box>
        )}
        {!isDirty && !now.error && (
          <Box justifyContent="center">
            <Text color="success">✔ Working tree clean</Text>
          </Box>
        )}
        {shown.map(file => {
          const color = LETTER_COLOR[file.letter]
          const row = fitRow(file.path, width - 4 - (hasCounts ? countsWidth + 1 : 0))
          return (
            <Box justifyContent="space-between">
              <Text>
                {' '}
                <Text color={color} strikethrough={file.letter === 'D'}>
                  {row.name}
                </Text>
                {row.dir && <Text dimColor> {row.dir}</Text>}
              </Text>
              <Box gap={1}>
                {hasCounts && file.isBinary && <Text dimColor>bin</Text>}
                {hasCounts && !file.isBinary && plusWidth > 0 && (
                  <Text color="success">{(file.added ? `+${file.added}` : '').padStart(plusWidth)}</Text>
                )}
                {hasCounts && !file.isBinary && minusWidth > 0 && (
                  <Text color="error">{(file.removed ? `-${file.removed}` : '').padStart(minusWidth)}</Text>
                )}
                <Text color={color}>{file.letter}</Text>
              </Box>
            </Box>
          )
        })}
        {hiddenCount > 0 && <Text dimColor> … {hiddenCount} more</Text>}
        {divider}
        <Text dimColor>updated {new Date(now.updatedAt).toTimeString().slice(0, 8)} · /changes to hide</Text>
      </Box>
    )
  })
}
