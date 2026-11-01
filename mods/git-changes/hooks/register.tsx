import { atom, read, update } from 'claude-code'
import type { EngineInterface as Engine, Register } from 'claude-code'

import type { FileChange, IssuesState, PrsState, RepoStatus } from '../types'
import { classifyGhFailure, ISSUES_LIMIT, issuesRepoOf, parseIssues } from './issues'
import { fitPrRow, MARK_COLOR, parsePrs, PRS_LIMIT, prsRepoOf, worstMark } from './prs'
import type { LineStat } from './status'
import { ageOf, fitIssueRow } from './issues'
import { arrivalOf, followed, scrolled, stepOf, windowOf, wrapMove } from './scroll'
import { countLines, fitRow, LETTER_COLOR, parseNumstat, parseStatus, withCounts } from './status'
import type { TabId } from './tabs'
import { tabTexts } from './tabs'
import { widthOf } from './text'
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
const ISSUES_INTERVAL_MS = 60_000 // never poll GitHub faster
const REFOCUS_MS = 60 // after a scroll, the newly drawn row takes the focus ring
const MAX_COUNTED_FILES = 50
const MAX_COUNTED_BYTES = 256 * 1024

const status = atom({ plugin: 'git-changes', key: 'status' } as const, null as RepoStatus | null)
const issues = atom({ plugin: 'git-changes', key: 'issues' } as const, null as IssuesState | null)
const prs = atom({ plugin: 'git-changes', key: 'prs' } as const, null as PrsState | null)

/** Where the `<repo>-issues` lookup stands: `none` and `off` are final for the session, `retrying` is not. */
type Detection = { kind: 'off' } | { kind: 'none'; reason: string } | { kind: 'retrying' } | { kind: 'detected'; target: string }
let detection: Detection = { kind: 'off' }
let issuesTimer: { cancel: () => void } | undefined
let isFetching = false
let fetchQueued = false // a tab press asked while a fetch ran: fetch once more after it
let lastIssuesRaw: string | undefined

/**
 * Where the PR list stands: `pending` until the first `gh pr list` answers (no
 * tab yet), then `ready`; `none` and `off` are final for the session.
 */
type PrSource = { kind: 'off' } | { kind: 'none'; reason: string } | { kind: 'pending'; target: string } | { kind: 'ready'; target: string }
let prSource: PrSource = { kind: 'off' }
let me: string | undefined // gh's login: these PRs' numbers draw bold
let isFetchingPrs = false
let prsInFlight: Promise<void> | undefined // the running fetch, for a new lookup to wait out
let prsQueued = false // a tab press asked while a fetch ran: fetch once more after it
let lastPrsRaw: string | undefined
/** Bumped by every lookup and by turning PRs off: a slower, older answer is then dropped. */
let prsRun = 0

type Tab = TabId
let tab: Tab = 'changes'
/** Each tab's first shown row: the mod scrolls its list itself, under a pinned header. */
const offsets: Record<Tab, number> = { changes: 0, issues: 0, prs: 0 }
/**
 * What each tab's last drawing measured, for ui.scroll and ui.focus: the list's
 * length, its rows of room, and its first body row. Per tab, so a hook that
 * fires between a tab press and the redraw never uses the other tab's room.
 */
const drawn: Record<Tab, { length: number; room: number; top: number; bodyRows: number }> = {
  changes: { length: 0, room: 1, top: 0, bodyRows: 1 },
  issues: { length: 0, room: 1, top: 0, bodyRows: 1 },
  prs: { length: 0, room: 1, top: 0, bodyRows: 1 },
}

/** The number of the issue or PR row the ring was last on; a number survives a fetch that re-sorts the list. */
let focusedRow: number | undefined

/** Opens `url` in the browser: xdg-open (Linux), then open (macOS), else copies it. */
async function openUrl($: Engine, url: string, surface: unknown) {
  for (const opener of ['xdg-open', 'open']) {
    try {
      if ((await $.process.run([opener, url])).exitCode === 0) return
    } catch {
      // Not on this machine: try the next.
    }
  }
  await $.ui.copy({ text: url, surface } as never).catch(() => {})
}

/** Rows left for a list (its markers included) under `pinnedRows` of header and footer. */
function listRoom(bodyRows: number, pinnedRows: number) {
  return Math.max(1, bodyRows - pinnedRows)
}

let timer: { cancel: () => void } | undefined
let isChecking = false
let pendingRefresh = false // asked while a refresh ran: run once more after it
let commandName = COMMAND // the name registerCommand actually got
let lastRaw: string | undefined
let root = ''
/** New files' line counts, kept while their size and mtime hold. */
const untrackedCache = new Map<string, { size: number; mtimeMs: number; stat: LineStat }>()

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
      const cached = untrackedCache.get(file.path)
      if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
        stats.set(file.path, cached.stat)
        continue
      }
      const text = await $.fs.read(path)
      if (typeof text !== 'string') continue
      const counted = countLines(text)
      untrackedCache.set(file.path, { size: stat.size, mtimeMs: stat.mtimeMs, stat: counted })
      stats.set(file.path, counted)
    } catch {
      // Gone or unreadable since git listed it: the row shows no counts.
    }
  }
  const listed = new Set(untracked.map(file => file.path))
  for (const path of untrackedCache.keys()) if (!listed.has(path)) untrackedCache.delete(path)

  return stats
}

/** A numstat run's output, or nothing when it failed (counts are extras). */
function numstatOf(run: { exitCode: number; stdout: string }) {
  return run.exitCode === 0 ? run.stdout : ''
}

async function refresh($: Engine): Promise<void> {
  if (isChecking) {
    pendingRefresh = true
    return
  }
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
    if (pendingRefresh) {
      pendingRefresh = false
      void refresh($).catch(() => {})
    }
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
    commandName = COMMAND
  } catch {
    try {
      await $.command.register({ name: FALLBACK_COMMAND, description: DESCRIPTION })
      commandName = FALLBACK_COMMAND
    } catch {
      // No command at all: the pane still opens from the stored state.
    }
  }
}

function startTimer($: Engine) {
  timer?.cancel()
  timer = $.clock.every(INTERVAL_MS, () => void tick($))
  issuesTimer?.cancel()
  issuesTimer = $.clock.every(ISSUES_INTERVAL_MS, () => void githubTick($).catch(() => {}))
}

function stopTimers() {
  timer?.cancel()
  timer = undefined
  issuesTimer?.cancel()
  issuesTimer = undefined
}

async function githubTick($: Engine) {
  if (!(await isPlaced($))) return
  if (prSource.kind === 'ready') void fetchPrs($).catch(() => {})
  if (detection.kind === 'retrying') await detectIssues($)
  else if (detection.kind === 'detected') await fetchIssues($)
}

function firstLine(text: string) {
  return (text.split('\n')[0] ?? '').trim()
}

/** Bumped by every detection and by turning issues off: a slower, older detection then drops its answer. */
let detectRun = 0

/** Finds `<owner>/<repo>-issues` from origin; on success fetches at once (not awaited). */
async function detectIssues($: Engine) {
  const run = ++detectRun
  const settle = (found: Detection) => {
    if (run !== detectRun) return false // turned off, or a newer detection, meanwhile
    detection = found
    return true
  }
  if ((await $.store.get('issues')) === false) {
    settle({ kind: 'off' })
    return
  }
  const origin = await $.process.run(['git', 'remote', 'get-url', 'origin']).catch(() => undefined)
  const target = origin?.exitCode === 0 ? issuesRepoOf(origin.stdout) : undefined
  if (!target) {
    settle({ kind: 'none', reason: 'origin is not a GitHub repo' })
    return
  }
  let view: { exitCode: number; stderr: string }
  try {
    view = await $.process.run(['gh', 'repo', 'view', target, '--json', 'name'])
  } catch {
    // A missing gh and one still running at the timeout both reject: ask gh itself, briefly.
    const isInstalled = await $.process.run(['gh', '--version'], { timeoutMs: 5000 } as never).then(
      () => true,
      () => false,
    )
    settle(isInstalled ? { kind: 'retrying' } : { kind: 'none', reason: 'gh is not installed' })
    return
  }
  if (view.exitCode === 0) {
    if (settle({ kind: 'detected', target })) void fetchIssues($).catch(() => {})
    return
  }
  // gh's own words decide: exit 4 or "gh auth login" is logged out, a missing repo is final, the rest retries.
  const failure = view.exitCode === 4 ? 'logged-out' : classifyGhFailure(view.stderr)
  if (failure === 'logged-out') settle({ kind: 'none', reason: 'gh is not logged in (run: gh auth login)' })
  else if (failure === 'not-found') settle({ kind: 'none', reason: `${target} not found or no access` })
  else settle({ kind: 'retrying' })
}

/** Reads the open issues; a failure keeps the last list and sets `error`. */
async function fetchIssues($: Engine, isUrgent = false): Promise<void> {
  if (detection.kind !== 'detected') return
  if (isFetching) {
    if (isUrgent) fetchQueued = true
    return
  }
  isFetching = true
  const failed = (error: string) =>
    update($, issues, now => ({ ...(now ?? { issues: [], isCapped: false, updatedAt: Date.now() }), error }))
  try {
    const run = await $.process.run([
      'gh', 'issue', 'list', '-R', detection.target, '--state', 'open', '--search', 'sort:updated-desc',
      '--limit', String(ISSUES_LIMIT), '--json', 'number,title,labels,updatedAt,url',
    ])
    if (run.exitCode !== 0) {
      lastIssuesRaw = undefined
      // gh names the repo in its errors; the pane never shows it.
      const said = firstLine(run.stderr).split(detection.target).join('the issues repo')
      await failed(classifyGhFailure(run.stderr) === 'not-found' ? 'GitHub: issues repo not found or no access' : `GitHub: ${said}`)
      return
    }
    if (run.stdout === lastIssuesRaw && (await read($, issues)) !== null) return
    let list: ReturnType<typeof parseIssues>
    try {
      list = parseIssues(run.stdout)
    } catch {
      lastIssuesRaw = undefined
      await failed('GitHub: unexpected reply from gh')
      return
    }
    lastIssuesRaw = run.stdout
    await update($, issues, () => ({ issues: list, isCapped: list.length >= ISSUES_LIMIT, updatedAt: Date.now() }))
  } catch {
    lastIssuesRaw = undefined
    await failed('GitHub: gh could not be run')
  } finally {
    isFetching = false
    if (fetchQueued) {
      fetchQueued = false
      void fetchIssues($).catch(() => {})
    }
  }
}

/** Whether gh is on this machine, when running it rejected: a hang and a missing binary both reject. */
function hasGh($: Engine) {
  return $.process.run(['gh', '--version'], { timeoutMs: 5000 } as never).then(
    () => true,
    () => false,
  )
}

/** Finds `<owner>/<repo>` from origin and fetches its PRs once (awaited); the login is read alongside. */
async function findPrs($: Engine) {
  const run = ++prsRun
  if ((await $.store.get('prs')) === false) {
    if (run === prsRun) prSource = { kind: 'off' }
    return
  }
  const origin = await $.process.run(['git', 'remote', 'get-url', 'origin']).catch(() => undefined)
  const target = origin?.exitCode === 0 ? prsRepoOf(origin.stdout) : undefined
  if (run !== prsRun) return
  if (!target) {
    prSource = { kind: 'none', reason: 'origin is not a GitHub repo' }
    return
  }
  prSource = { kind: 'pending', target }
  if (me === undefined) void readLogin($)
  await prsInFlight?.catch(() => {}) // an older fetch still running would turn this one away
  if (run !== prsRun) return
  await fetchPrs($)
}

let isLoginRead = false
/** gh's login, once per session; a failure leaves nothing bold. */
async function readLogin($: Engine) {
  if (isLoginRead) return
  isLoginRead = true
  try {
    const run = await $.process.run(['gh', 'api', 'user', '--jq', '.login'])
    if (run.exitCode === 0) me = run.stdout.trim() || undefined
  } catch {
    // No login: nothing is bold.
  }
}

/**
 * Reads the open PRs. While `pending`, a definitive failure ends the lookup
 * (no tab); anything else makes the source `ready`, a failure keeping the last
 * list and setting `error`.
 */
async function fetchPrs($: Engine, isUrgent = false): Promise<void> {
  if (prSource.kind !== 'pending' && prSource.kind !== 'ready') return
  if (isFetchingPrs) {
    if (isUrgent) prsQueued = true
    return
  }
  isFetchingPrs = true
  const running = fetchPrsOnce($, prSource.target)
  prsInFlight = running
  return running
}

/** One `gh pr list` for `target`; the caller has set `isFetchingPrs`, and the `finally` clears it. */
async function fetchPrsOnce($: Engine, target: string): Promise<void> {
  const run = prsRun
  const isCurrent = () => run === prsRun
  const ready = () => {
    prSource = { kind: 'ready', target }
  }
  const failed = async (error: string) => {
    lastPrsRaw = undefined
    ready()
    await update($, prs, now => ({ ...(now ?? { prs: [], isLoaded: false, isCapped: false, updatedAt: Date.now() }), error }))
  }
  try {
    let answer: { exitCode: number; stdout: string; stderr: string }
    try {
      answer = await $.process.run([
        'gh', 'pr', 'list', '-R', target, '--state', 'open', '--limit', String(PRS_LIMIT),
        '--json', 'number,title,isDraft,reviewDecision,statusCheckRollup,author,updatedAt,url',
      ])
    } catch {
      const isInstalled = await hasGh($)
      if (!isCurrent()) return
      if (!isInstalled && prSource.kind === 'pending') prSource = { kind: 'none', reason: 'gh is not installed' }
      else await failed('GitHub: gh could not be run')
      return
    }
    if (!isCurrent()) return
    if (answer.exitCode !== 0) {
      const failure = answer.exitCode === 4 ? 'logged-out' : classifyGhFailure(answer.stderr)
      if (prSource.kind === 'pending' && failure === 'logged-out') prSource = { kind: 'none', reason: 'gh is not logged in (run: gh auth login)' }
      else if (prSource.kind === 'pending' && failure === 'not-found') prSource = { kind: 'none', reason: `${target} not found or no access` }
      else await failed(`GitHub: ${firstLine(answer.stderr)}`)
      return
    }
    ready()
    if (answer.stdout === lastPrsRaw && (await read($, prs)) !== null) return
    let list: ReturnType<typeof parsePrs>
    try {
      list = parsePrs(answer.stdout)
    } catch {
      await failed('GitHub: unexpected reply from gh')
      return
    }
    lastPrsRaw = answer.stdout
    await update($, prs, () => ({ prs: list, isLoaded: true, isCapped: list.length >= PRS_LIMIT, updatedAt: Date.now() }))
  } catch {
    if (isCurrent()) await failed('GitHub: gh could not be run').catch(() => {})
  } finally {
    isFetchingPrs = false
    if (prsQueued) {
      prsQueued = false
      void fetchPrs($).catch(() => {})
    }
  }
}

async function show($: Engine) {
  startTimer($)
  lastRaw = undefined // reopening always redraws from a fresh read
  await $.ui.open({ id: PANE, title: TITLE, columns: DOCK_COLUMNS })
  void refresh($).catch(() => {}) // open first: a slow repo never holds the command
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

/** `/changes issues`: the Issues tab off or on, remembered on this machine. */
async function toggleIssues($: Engine) {
  const isOn = (await $.store.get('issues')) === false
  await $.store.set('issues', isOn)
  if (!isOn) {
    detectRun++ // a detection still running drops its answer
    detection = { kind: 'off' }
    focusedRow = undefined
    tab = 'changes'
    lastIssuesRaw = undefined
    await update($, issues, () => null)
    await update($, status, now => now && { ...now }) // draws without the tab bar
    return { text: 'Issues tab hidden.' }
  }
  await detectIssues($)
  await update($, status, now => now && { ...now })
  const found: Detection = detection
  if (found.kind === 'detected') return { text: 'Issues tab shown.' }
  if (found.kind === 'retrying') return { text: 'Issues tab on; GitHub is unreachable right now, retrying every minute.' }
  if (found.kind === 'none') return { text: `Issues tab on, but no issues repo was found: ${found.reason}.` }
  return { text: 'Issues tab shown.' }
}

/** `/changes prs`: the PRs tab off or on, remembered on this machine. */
async function togglePrs($: Engine) {
  const isOn = (await $.store.get('prs')) === false
  await $.store.set('prs', isOn)
  if (!isOn) {
    prsRun++ // a lookup or fetch still running drops its answer
    prSource = { kind: 'off' }
    if (tab === 'prs') tab = 'changes'
    lastPrsRaw = undefined
    await update($, prs, () => null)
    await update($, status, now => now && { ...now }) // draws without the tab
    return { text: 'PRs tab hidden.' }
  }
  await findPrs($)
  await update($, status, now => now && { ...now })
  const found: PrSource = prSource
  if (found.kind === 'none') return { text: `PRs tab on, but it can't be shown: ${found.reason}.` }
  const error = found.kind === 'ready' ? (await read($, prs))?.error : undefined
  if (error) return { text: 'PRs tab on; GitHub is unreachable right now, retrying every minute.' }
  return { text: 'PRs tab shown.' }
}

/** What `/changes <args>` does: no args toggles the pane, `issues` and `prs` their tabs. */
async function runCommand($: Engine, args: string) {
  const word = args.trim().toLowerCase()
  if (word === '') return toggle($)
  if (word === 'issues') return toggleIssues($)
  if (word === 'prs') return togglePrs($)
  return { text: `Usage: /${commandName} [issues|prs]` }
}

async function hide($: Engine) {
  stopTimers()
  await $.ui.close({ id: PANE })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await registerCommand($)
    const isGit = await isRepo($)
    if (isGit && (await $.store.get('shown')) !== false) await showOnStart($)
    if (isGit && e.isInteractive) {
      // GitHub never holds the session; -p and the SDK skip it
      void detectIssues($).catch(() => {})
      void findPrs($).catch(() => {})
    }
    void syncEditorTheme($).catch(() => {}) // the pane's fill follows the editor; never holds the session

    return next(e)
  })

  const failed = { text: 'git-changes: the pane could not be toggled; see the transcript.' }
  on('command.run', { command: COMMAND }, ($, e) => runCommand($, e.args)).catch(() => failed)
  on('command.run', { command: FALLBACK_COMMAND }, ($, e) => runCommand($, e.args)).catch(() => failed)

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE && e.origin.kind !== 'plugin') {
      stopTimers()
      if (e.origin.kind === 'person') await $.store.set('shown', false)
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: REFRESH_TOOLS }, async ($, e, next) => {
    const ran = await next(e)
    if (isShown()) void refresh($)

    return ran
  }).catch(($, e, next) => next(e))

  // The header stays: the engine's window never moves, the mod moves its own list and draws again.
  on('ui.scroll', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const measured = drawn[tab]
    if (e.pointer && e.pointer.row < measured.top) return {} // a wheel over the header
    const by = stepOf(e.by, measured.bodyRows, measured.room)
    const next = scrolled(offsets[tab], by, measured.length, measured.room)
    if (next !== offsets[tab]) {
      offsets[tab] = next
      await update($, status, now => now && { ...now }) // draws again
    }

    return {}
  }).catch(() => ({}))

  // Arrows move the ring between drawn rows; past an edge with rows beyond it, the list follows.
  on('ui.focus', { requestId: PANE }, async ($, e, next) => {
    if (tab === 'changes') {
      focusedRow = undefined
      return next(e)
    }
    const list = tab
    const isPrs = list === 'prs'
    const prefix = isPrs ? 'pr-' : 'issue-'
    const numbers = isPrs ? ((await read($, prs))?.prs ?? []).map(pr => pr.number) : ((await read($, issues))?.issues ?? []).map(issue => issue.number)
    const indexOf = (number: number | undefined) => numbers.indexOf(number ?? Number.NaN)
    const number = new RegExp(`^${prefix}(\\d+)$`).exec(e.element ?? '')?.[1]
    const arrived = arrivalOf(e.element, list, numbers)
    const previous = indexOf(focusedRow)
    const window = windowOf(numbers.length, offsets[list], drawn[list].room)
    const move = e.origin.kind === 'person' ? wrapMove(previous, arrived, window) : 0
    if (move === 0) {
      focusedRow = number === undefined ? undefined : Number(number)
      return next(e)
    }
    const stay = numbers[previous]
    const target = numbers[previous + move]
    if (stay === undefined || target === undefined) return next(e)
    offsets[list] = followed(offsets[list], previous + move, numbers.length, drawn[list].room)
    focusedRow = target
    await update($, status, now => now && { ...now }) // draws the new row
    const key = `${prefix}${target}`
    $.clock.after(REFOCUS_MS, () => void $.ui.focus({ requestId: PANE, key } as never).catch(() => {}))

    return next({ ...e, element: `${prefix}${stay}` }) // the ring waits on the row it left
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const now = await read($, status)
    if (!now) return <Text dimColor>Reading git status…</Text>

    // Read both lists every time: the read subscribes this pane, so a lookup that lands later draws the tab bar.
    const fetched = await read($, issues)
    const fetchedPrs = await read($, prs)
    const hasIssues = detection.kind === 'detected'
    const hasPrs = prSource.kind === 'ready'
    const hasTabs = hasIssues || hasPrs
    if ((tab === 'issues' && !hasIssues) || (tab === 'prs' && !hasPrs)) tab = 'changes'
    const known = hasIssues ? fetched : null
    const knownPrs = hasPrs ? fetchedPrs : null
    const width = Math.max(20, e.props.bodyColumns)
    const bodyRows = e.props.scroll.bodyRows
    const count = now.files.length
    const isDirty = count > 0
    const divider = <Text dimColor>{'─'.repeat(width)}</Text>
    const timeOf = (at: number) => new Date(at).toTimeString().slice(0, 8)
    const redraw = () => void update($, status, state => state && { ...state }).catch(() => {})

    const branchRow = (
      <Box justifyContent="space-between" gap={2}>
        <Text wrap="truncate-end">
          <Text bold>⎇ {now.isDetached ? `(${now.branch})` : now.branch}</Text>
          {isDirty && <Text color="warning"> ●</Text>}
        </Text>
        {(now.ahead > 0 || now.behind > 0) && (
          // A space after each triangle: fonts that draw it two columns wide never cover the count.
          <Box gap={2} flexShrink={0}>
            {now.ahead > 0 && <Text bold color="suggestion">{`▲ ${now.ahead}`}</Text>}
            {now.behind > 0 && <Text bold color="warning">{`▼ ${now.behind}`}</Text>}
          </Box>
        )}
      </Box>
    )

    const issuesCount = !known ? '…' : known.isCapped ? `${ISSUES_LIMIT}+` : String(known.issues.length)
    const prsCount = !knownPrs?.isLoaded ? '…' : knownPrs.isCapped ? `${PRS_LIMIT}+` : String(knownPrs.prs.length)
    const worst = worstMark(knownPrs?.prs ?? [])
    const texts = tabTexts(
      width,
      { changes: String(count), ...(hasIssues ? { issues: issuesCount } : {}), ...(hasPrs ? { prs: prsCount } : {}) },
      tab,
    )
    const tabButton = (which: Tab, countColor?: string) => {
      const text = texts[which]
      if (!text) return null
      const onPress = () => {
        tab = which
        focusedRow = undefined
        redraw()
        if (which === 'issues') void fetchIssues($, true).catch(() => {})
        if (which === 'prs') void fetchPrs($, true).catch(() => {})
      }
      const shown = <Text color={countColor}>{text.count}</Text>
      return (
        <Button key={`tab-${which}`} plain onPress={onPress}>
          {tab === which ? (
            <Text bold>
              {text.before}
              {shown}
              {text.after}
            </Text>
          ) : (
            <Text dimColor>
              {text.before}
              {shown}
              {text.after}
            </Text>
          )}
        </Button>
      )
    }
    const tabBar = hasTabs && (
      <Box gap={1}>
        {tabButton('changes')}
        {tabButton('issues')}
        {tabButton('prs', worst === '✗' ? 'error' : worst === 'R' ? MARK_COLOR.R : undefined)}
      </Box>
    )
    const footer = (at: number) => (
      <Text dimColor>
        updated {timeOf(at)} · /{commandName}
      </Text>
    )

    /** The Issues and PRs tabs' body: error, reading or empty line, the scrolled rows, the more button. */
    const githubBody = <T,>(list: {
      tab: 'issues' | 'prs'
      items: readonly T[]
      error?: string
      isLoaded: boolean
      readingText: string
      emptyText: string
      moreUrl: string
      updatedAt: number
      row: (item: T, at: number) => unknown
    }) => {
      const above = 3 + (list.error ? 1 : 0) // branch, tabs, divider; error
      const room = listRoom(bodyRows, above + 2) // + divider, footer
      const window = windowOf(list.items.length, offsets[list.tab], room)
      offsets[list.tab] = window.start
      Object.assign(drawn[list.tab], { length: list.items.length, room, top: above, bodyRows })
      const at = Date.now()

      return (
        <Box flexDirection="column">
          {branchRow}
          {tabBar}
          {divider}
          {list.error && <Text color="error">{list.error}</Text>}
          {!list.isLoaded && !list.error && <Text dimColor>{list.readingText}</Text>}
          {list.isLoaded && list.items.length === 0 && (
            <Box justifyContent="center">
              <Text color="success">{list.emptyText}</Text>
            </Box>
          )}
          {window.above > 0 && <Text dimColor> ↑ {window.above} above</Text>}
          {list.items.slice(window.start, window.end).map(item => list.row(item, at) as never)}
          {window.below > 0 && (
            <Button key={`${list.tab}-more`} plain dimColor onPress={press => void openUrl($, list.moreUrl, press.surface)}>
              {` ↓ ${window.below} more`}
            </Button>
          )}
          {divider}
          {footer(list.updatedAt)}
        </Box>
      )
    }

    if (tab === 'issues' && detection.kind === 'detected') {
      return githubBody({
        tab: 'issues',
        items: known?.issues ?? [],
        error: known?.error,
        isLoaded: known !== null,
        readingText: 'Reading issues…',
        emptyText: '✔ No open issues',
        moreUrl: `https://github.com/${detection.target}/issues`,
        updatedAt: known?.updatedAt ?? now.updatedAt,
        row: (issue, at) => {
          const row = fitIssueRow(issue, width, ageOf(issue.updatedAt, at))
          const tail = widthOf(row.label) + (row.label && row.age ? 1 : 0) + row.age.length
          const pad = tail ? ' '.repeat(Math.max(1, width - row.head.length - widthOf(row.title) - tail)) : ''
          return (
            <Button key={`issue-${issue.number}`} plain onPress={press => void openUrl($, issue.url, press.surface)}>
              <Text wrap="truncate-end">{`${row.head}${row.title}${pad}`}</Text>
              {row.label && <Text dimColor>{row.label}</Text>}
              {row.label && row.age ? ' ' : ''}
              {row.age}
            </Button>
          )
        },
      })
    }

    if (tab === 'prs' && prSource.kind === 'ready') {
      return githubBody({
        tab: 'prs',
        items: knownPrs?.prs ?? [],
        error: knownPrs?.error,
        isLoaded: knownPrs?.isLoaded ?? false,
        readingText: 'Reading pull requests…',
        emptyText: '✔ No open pull requests',
        moreUrl: `https://github.com/${prSource.target}/pulls`,
        updatedAt: knownPrs?.updatedAt ?? now.updatedAt,
        row: (pr, at) => {
          const row = fitPrRow(pr, width, ageOf(pr.updatedAt, at))
          const tail = 1 + (row.age ? row.age.length + 1 : 0) // the mark, then a space and the age
          const pad = ' '.repeat(Math.max(1, width - row.head.length - widthOf(row.title) - tail))
          const isMine = me !== undefined && pr.author === me
          const mark =
            pr.mark === 'D' ? <Text dimColor>D</Text> : pr.mark ? <Text color={MARK_COLOR[pr.mark]}>{pr.mark}</Text> : ' '
          return (
            <Button key={`pr-${pr.number}`} plain onPress={press => void openUrl($, pr.url, press.surface)}>
              <Text bold={isMine}>{row.head}</Text>
              <Text wrap="truncate-end">{`${row.title}${pad}`}</Text>
              {mark}
              {row.age ? ` ${row.age}` : ''}
            </Button>
          )
        },
      })
    }

    const added = now.files.reduce((sum, file) => sum + (file.added ?? 0), 0)
    const removed = now.files.reduce((sum, file) => sum + (file.removed ?? 0), 0)
    const hasLabel = isDirty && !hasTabs // the tab says it when there are tabs
    const above = 2 + (hasTabs ? 1 : 0) + (isDirty ? 1 : 0) + (hasLabel ? 1 : 0) + (now.error ? 1 : 0)
    const room = listRoom(bodyRows, above + 2) // + divider, footer
    const window = windowOf(count, offsets.changes, room)
    offsets.changes = window.start // a list that shrank pulls the window back
    Object.assign(drawn.changes, { length: count, room, top: above, bodyRows })
    const shown = now.files.slice(window.start, window.end)

    // Count columns line up across rows; dropped first when the pane is narrow.
    const plusWidth = Math.max(0, ...shown.map(file => (file.added ? `+${file.added}`.length : 0)))
    const minusWidth = Math.max(0, ...shown.map(file => (file.removed ? `-${file.removed}`.length : 0)))
    const countsWidth = Math.max(plusWidth + 1 + minusWidth, shown.some(file => file.isBinary) ? 3 : 0)
    const hasCounts = width - countsWidth >= 30

    return (
      <Box flexDirection="column">
        {branchRow}
        {tabBar}
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
        {hasLabel && (
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
        {window.above > 0 && <Text dimColor> ↑ {window.above} above</Text>}
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
        {window.below > 0 && <Text dimColor> ↓ {window.below} more</Text>}
        {divider}
        {footer(now.updatedAt)}
      </Box>
    )
  })
}
