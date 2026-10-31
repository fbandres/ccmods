import type { On } from 'claude-code'
import type { Engine, EngineMount } from 'claude-code/testing'
import { expect, mock, test } from 'claude-code/testing'
import type { IssuesState } from '../types'

declare function setTimeout(fn: (value?: unknown) => void, ms: number): unknown // the test runtime has it; the mod's lib does not declare it

const PLUGIN = 'git-changes'
const CLEAN_HEAD = '# branch.oid 1a2b3c4d5e6f\0# branch.head main\0'
const DIRTY =
  CLEAN_HEAD +
  '1 .M N... 100644 100644 100644 aaa bbb package-lock.json\0' +
  '? assets/logo.png\0'

const CHANGES = {
  command: 'changes',
  args: '',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: false, columns: 120 },
} as const

/** Lets fire-and-forget work (the refresh after opening) finish. */
const settle = () => new Promise(resolve => setTimeout(resolve, 30))

/** Runs `/changes` as the person typing it does, then lets the git read land. */
async function runChanges($: Engine) {
  const answer = await $.command.run(CHANGES)
  await settle()
  return answer
}

/** An op hook's answer: the process result as `{ value }`. */
const ran = (exitCode: number, stdout: string, stderr: string) => ({
  value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false },
})

const ROOT = '/repo'
const DIRTY_UNSTAGED = '40\t15\tpackage-lock.json\0'
const DIRTY_FILES: Record<string, string> = { 'assets/logo.png': '\x89PNG\0\x1a' }

type Git = {
  isRepo?: boolean
  exitCode?: number
  stdout?: string
  stderr?: string
  /** `git diff --numstat -z` and `--cached` output. */
  unstaged?: string
  staged?: string
  /** Untracked files' contents, by repo-relative path. */
  files?: Record<string, string>
  /** `git remote get-url origin`; null for no origin. Default: a github.com remote. */
  origin?: string | null
  /** The gh CLI; absent means gh is not installed. */
  gh?: Gh
  /** The browser openers: ok (exit 0), fail (exit 1) or missing. Default xdg-open ok. */
  opener?: { xdg?: 'ok' | 'fail' | 'missing'; open?: 'ok' | 'fail' | 'missing' }
  /** When set, `git status` waits for it before answering. */
  gate?: Promise<void>
  /** Untracked files' mtimes, by repo-relative path (default 0). */
  mtimes?: Record<string, number>
}

type Gh = {
  loggedOut?: boolean
  /** `gh repo view`: found, missing (not found), down (network) or hang (still running at the timeout). Default found. */
  repo?: 'found' | 'missing' | 'down' | 'hang'
  /** `gh auth status` fails although the token is fine (a network check failing). */
  authBroken?: boolean
  /** When set, `gh repo view` waits for it before answering. */
  gate?: Promise<void>
  /** `gh issue list` JSON; default `[]`. */
  list?: string
  listError?: string
}

const ORIGIN = 'https://github.com/fbandres/oscp-app.git'
const TARGET = 'fbandres/oscp-app-issues'

/** `count` issues as gh prints them, newest number first. */
function issuesJson(count: number, labels = ['bug']) {
  return JSON.stringify(
    Array.from({ length: count }, (_, i) => ({
      number: count - i,
      title: `Issue number ${count - i}`,
      labels: labels.map(name => ({ name })),
      updatedAt: '2026-10-31T10:00:00Z',
      url: `https://github.com/${TARGET}/issues/${count - i}`,
    })),
  )
}

/** Answers gh's calls from `gh`; rejects as a missing binary does when absent. */
async function answerGh(gh: Gh | undefined, argv: readonly string[]) {
  if (!gh) return { deny: 'gh: command not found' }
  const loggedOutText = 'To get started with GitHub CLI, please run:  gh auth login'
  if (argv[1] === '--version') return ran(0, 'gh version 2.45.0\n', '')
  if (argv[1] === 'auth') return gh.loggedOut || gh.authBroken ? ran(1, '', 'You are not logged into any GitHub hosts. To log in, run: gh auth login') : ran(0, '', '')
  if (argv[1] === 'repo') {
    if (gh.gate) await gh.gate
    if (gh.loggedOut) return ran(4, '', loggedOutText)
    if (gh.repo === 'missing') return ran(1, '', `GraphQL: Could not resolve to a Repository with the name '${argv[3]}'. (repository)`)
    if (gh.repo === 'down') return ran(1, '', 'error connecting to api.github.com')
    if (gh.repo === 'hang') return { deny: 'gh is still running after 30000 ms' }
    return ran(0, '{"name":"oscp-app-issues"}', '')
  }
  if (argv[1] === 'issue') return gh.listError ? ran(1, '', gh.listError) : ran(0, gh.list ?? '[]', '')
  return ran(1, '', 'unknown gh command')
}

/**
 * Answers the plugin's git calls and file reads from `git()`. `status` counts
 * `git status` runs; `argv` holds every git argv seen.
 */
function fakeGit(on: On, git: () => Git) {
  const calls = { status: 0, reads: 0, argv: [] as string[][] }
  on('process.run', async (_$, e) => {
    const now = git()
    calls.argv.push([...e.argv])
    if (e.argv[0] === 'gh') return answerGh(now.gh, e.argv)
    if (e.argv[0] === 'xdg-open' || e.argv[0] === 'open') {
      const how = (e.argv[0] === 'xdg-open' ? now.opener?.xdg : now.opener?.open) ?? (e.argv[0] === 'xdg-open' ? 'ok' : 'missing')
      return how === 'missing' ? { deny: `${e.argv[0]}: not found` } : ran(how === 'ok' ? 0 : 1, '', '')
    }
    if (e.argv[1] === 'remote') return now.origin === null ? ran(2, '', 'error: No such remote') : ran(0, `${now.origin ?? ORIGIN}\n`, '')
    if (e.argv[1] === 'rev-parse') {
      return now.isRepo === false ? ran(128, '', 'fatal: not a git repository') : ran(0, `${ROOT}\n`, '')
    }
    if (e.argv.includes('diff')) {
      const isStaged = e.argv.includes('--cached')
      const isDefault = now.stdout === undefined
      return ran(0, (isStaged ? now.staged : now.unstaged) ?? (isDefault && !isStaged ? DIRTY_UNSTAGED : ''), '')
    }
    calls.status++
    if (now.gate) await now.gate
    return ran(now.exitCode ?? 0, now.stdout ?? DIRTY, now.stderr ?? '')
  })
  const fileOf = (path: string) => {
    const now = git()
    const files = now.files ?? (now.stdout === undefined ? DIRTY_FILES : {})
    return files[path.replace(`${ROOT}/`, '')]
  }
  on('fs.stat', async (_$, e) => {
    const text = fileOf(e.path)
    return text === undefined
      ? { deny: 'no such file' }
      : { value: { kind: 'file' as const, size: text.length, mtimeMs: git().mtimes?.[e.path.replace(`${ROOT}/`, '')] ?? 0, isLink: false } }
  })
  on('fs.read', async (_$, e) => {
    const text = fileOf(e.path)
    calls.reads++
    return text === undefined ? { deny: 'no such file' } : { value: text }
  })
  return calls
}

/** Stands in for the surface: panes open placed unless `placed.value` is false. */
function fakePanes(on: On) {
  const placed = { value: true, isOpen: false, columns: undefined as number | undefined }
  on('ui.open', async ($, e) => {
    placed.isOpen = true
    placed.columns = e.columns
    return { value: { isPlaced: true as const } }
  })
  on('ui.close', async () => {
    placed.isOpen = false
    return { value: undefined }
  })
  on('ui.panes', async () => ({
    value: placed.isOpen
      ? [{ id: PLUGIN, title: 'Source Control', isShown: placed.value, isFocused: false, isPlaced: placed.value, plugin: PLUGIN }]
      : [],
  }))
  return placed
}

const mountPane = (ui: EngineMount, surface: 'terminal' | 'desktop', bodyRows = 20, bodyColumns = 40) =>
  ui.mount({
    plugin: PLUGIN,
    surface,
    component: 'Pane',
    requestId: PLUGIN,
    props: {
      title: 'Source Control',
      isFocused: false,
      bodyColumns,
      placement: 'dock',
      scroll: { offset: 0, bodyRows },
    } as never,
  })

const SIX_FILES =
  CLEAN_HEAD + ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts'].map(name => `? ${name}\0`).join('')

for (const surface of ['terminal', 'desktop'] as const) {
  test(`/changes opens the pane and lists files with their letters (${surface})`, async ($, on) => {
    mock.store(on, { shown: false })
    mock.clock(on)
    const panes = fakePanes(on)
    fakeGit(on, () => ({}))

    const { text } = await runChanges($)
    expect(text).toBe('Source Control pane shown.')
    expect(panes.columns).toBe(53)

    const pane = await mountPane($.ui, surface)
    expect(await pane.find({ text: /main/ })).toBeDefined()
    expect((await pane.find({ text: /^ ●$/ }))?.props.color).toBe('warning')
    expect((await pane.find({ text: /^ 2 $/ }))?.props.inverse).toBe(true)
    expect((await pane.find({ text: /^package\-lock\.json$/ }))?.props.color).toBe('warning')
    expect(await pane.findAll({ text: /^\+40$/ })).toHaveLength(2) // the row and the header total
    expect((await pane.findAll({ text: /^\-15$/ })).map(one => one.props.color)).toEqual(['error', 'error'])
    expect(await pane.find({ text: /^bin$/ })).toBeDefined()
    const letters = await pane.findAll({ text: /^[MU]$/ })
    expect(letters.map(one => [one.text, one.props.color])).toEqual([
      ['M', 'warning'],
      ['U', 'success'],
    ])
  })

  test(`clean repo says No changes (${surface})`, async ($, on) => {
    mock.store(on, { shown: false })
    mock.clock(on)
    fakePanes(on)
    fakeGit(on, () => ({ stdout: CLEAN_HEAD }))

    await runChanges($)
    const pane = await mountPane($.ui, surface)
    expect(await pane.find({ text: /Working tree clean/ })).toBeDefined()
  })

  test(`git failure shows the error, keeps the list, and recovers (${surface})`, async ($, on) => {
    mock.store(on, { shown: false })
    const clock = mock.clock(on)
    fakePanes(on)
    let git: Git = {}
    fakeGit(on, () => git)

    await runChanges($)
    git = { exitCode: 128, stderr: 'fatal: Unable to create index.lock: File exists.\nmore' }
    await clock.advance(2000)

    const pane = await mountPane($.ui, surface)
    expect(await pane.find({ text: /git status failed: fatal: Unable to create index\.lock/ })).toBeDefined()
    expect(await pane.find({ text: /^package\-lock\.json$/ })).toBeDefined()

    git = { stdout: CLEAN_HEAD }
    await clock.advance(2000)
    await pane.redraw()
    expect(await pane.find({ text: /git status failed/ })).toBeUndefined()
    expect(await pane.find({ text: /Working tree clean/ })).toBeDefined()
  })

  test(`the list fits the pane body, not the terminal (${surface})`, async ($, on) => {
    mock.store(on, { shown: false })
    mock.clock(on)
    fakePanes(on)
    fakeGit(on, () => ({ stdout: SIX_FILES }))

    await runChanges($)
    const pane = await mountPane($.ui, surface, 9) // 7 fixed rows + 2 files
    expect(await pane.find({ text: 'b.ts' })).toBeDefined()
    expect(await pane.find({ text: 'c.ts' })).toBeUndefined()
    expect(await pane.find({ text: /↓ 4 more/ })).toBeDefined()
    expect(await pane.find({ text: /above/ })).toBeUndefined()
  })

  test(`a first git failure never claims No changes (${surface})`, async ($, on) => {
    mock.store(on, { shown: false })
    mock.clock(on)
    fakePanes(on)
    fakeGit(on, () => ({ exitCode: 128, stderr: 'fatal: bad object HEAD' }))

    await runChanges($)
    const pane = await mountPane($.ui, surface)
    expect(await pane.find({ text: /git status failed: fatal: bad object HEAD/ })).toBeDefined()
    expect(await pane.find({ text: /Working tree clean/ })).toBeUndefined()
  })
}

test('git runs without optional locks and lists untracked files one by one', async ($, on) => {
  mock.store(on, { shown: false })
  mock.clock(on)
  fakePanes(on)
  const calls = fakeGit(on, () => ({}))

  await runChanges($)
  expect(calls.argv).toContainEqual(['git', '--no-optional-locks', 'status', '--porcelain=v2', '-b', '-z', '-uall'])
  expect(calls.argv).toContainEqual(['git', '--no-optional-locks', 'diff', '--numstat', '-z'])
  expect(calls.argv).toContainEqual(['git', '--no-optional-locks', 'diff', '--cached', '--numstat', '-z'])
})

test('/changes shows a pane that is open but not placed, and ticks skip git while unplaced', async ($, on) => {
  mock.store(on, { shown: false })
  const clock = mock.clock(on)
  const placed = fakePanes(on)
  const calls = fakeGit(on, () => ({}))

  await runChanges($)
  placed.value = false
  const before = calls.status
  await clock.advance(4000)
  expect(calls.status).toBe(before)

  const { text } = await runChanges($)
  expect(text).toBe('Source Control pane shown.')
})

test('the timer runs every 2s only while shown', async ($, on) => {
  mock.store(on, { shown: false })
  const clock = mock.clock(on)
  fakePanes(on)
  const calls = fakeGit(on, () => ({}))

  await runChanges($)
  const afterOpen = calls.status
  await clock.advance(2000)
  await clock.advance(2000)
  expect(calls.status).toBe(afterOpen + 2)

  const { text } = await runChanges($)
  expect(text).toBe('Source Control pane hidden.')
  await clock.advance(6000)
  expect(calls.status).toBe(afterOpen + 2)
})

test('outside a git repo /changes says so and opens nothing', async ($, on) => {
  mock.store(on, { shown: false })
  mock.clock(on)
  fakePanes(on)
  const calls = fakeGit(on, () => ({ isRepo: false }))

  const { text } = await runChanges($)
  expect(text).toBe('Not a git repository.')
  expect(calls.status).toBe(0)
})

test('a refused /changes falls back to /git-changes and the pane still opens on start', async ($, on) => {
  mock.store(on)
  mock.clock(on)
  const placed = fakePanes(on)
  fakeGit(on, () => ({}))
  const registered: string[] = []
  on('command.register', async (_$, e) => {
    if (e.name === 'changes') return { deny: 'a built-in has this name' }
    registered.push(e.name)
    return { value: { command: e.name } }
  })
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  expect(registered).toEqual(['git-changes'])
  expect(placed.isOpen).toBe(true)

  const { text } = await $.command.run({ ...CHANGES, command: 'git-changes' })
  expect(text).toBe('Source Control pane hidden.')
})

test('line counts refresh when an already-modified file changes again', async ($, on) => {
  mock.store(on, { shown: false })
  const clock = mock.clock(on)
  fakePanes(on)
  let git: Git = {}
  fakeGit(on, () => git)

  await runChanges($)
  git = { stdout: DIRTY, unstaged: '41\t15\tpackage-lock.json\0', files: DIRTY_FILES }
  await clock.advance(2000)

  const pane = await mountPane($.ui, 'terminal')
  expect(await pane.findAll({ text: /^\+41$/ })).toHaveLength(2)
})

test('an edit to an untracked file updates its count', async ($, on) => {
  mock.store(on, { shown: false })
  const clock = mock.clock(on)
  fakePanes(on)
  const untracked = CLEAN_HEAD + '? notes.md\0'
  let git: Git = { stdout: untracked, files: { 'notes.md': 'a\nb\n' } }
  fakeGit(on, () => git)

  await runChanges($)
  git = { stdout: untracked, files: { 'notes.md': 'a\nb\nc\n' } }
  await clock.advance(2000)

  const pane = await mountPane($.ui, 'terminal')
  expect(await pane.findAll({ text: /^\+3$/ })).toHaveLength(2)
  expect((await pane.find({ text: /^notes\.md$/ }))?.props.color).toBe('success')
})

test('a deleted file is red and struck through', async ($, on) => {
  mock.store(on, { shown: false })
  mock.clock(on)
  fakePanes(on)
  fakeGit(on, () => ({ stdout: CLEAN_HEAD + '1 D. N... 100644 000000 000000 aaa 000 old.ts\0', staged: '0\t30\told.ts\0' }))

  await runChanges($)
  const pane = await mountPane($.ui, 'terminal')
  const name = await pane.find({ text: /^old\.ts$/ })
  expect(name?.props.color).toBe('error')
  expect(name?.props.strikethrough).toBe(true)
  expect(await pane.findAll({ text: /^\-30$/ })).toHaveLength(2)
})

test('an emptied status is read again although git says the same', async ($, on) => {
  mock.store(on, { shown: false })
  const clock = mock.clock(on)
  fakePanes(on)
  fakeGit(on, () => ({}))
  // The session's state empties (a resume, a reload) until the plugin writes again.
  let isEmptied = false
  on('state.get', async (_$, e, next) => {
    const held = await next(e)
    return isEmptied && 'value' in held && held.value ? { value: { ...held.value, value: null } } : held
  })
  on('state.set', async (_$, e, next) => {
    isEmptied = false
    return next(e)
  })
  await runChanges($)

  isEmptied = true
  const pane = await mountPane($.ui, 'terminal')
  expect(await pane.find({ text: /Reading git status/ })).toBeDefined()

  await clock.advance(2000)
  expect(await pane.find({ text: /main/ })).toBeDefined()
})

test('sync shows only the non-zero side as a coloured triangle', async ($, on) => {
  mock.store(on, { shown: false })
  const clock = mock.clock(on)
  fakePanes(on)
  let git: Git = { stdout: CLEAN_HEAD + '# branch.upstream origin/main\0# branch.ab +1 -0\0' }
  fakeGit(on, () => git)
  await runChanges($)

  const pane = await mountPane($.ui, 'terminal')
  expect((await pane.findAll({ text: /^▲ 1$/ })).map(node => node.props.color)).toContain('suggestion')
  expect(await pane.find({ text: /▼/ })).toBeUndefined()

  git = { stdout: CLEAN_HEAD + '# branch.upstream origin/main\0# branch.ab +2 -3\0' }
  await clock.advance(2000)
  expect((await pane.findAll({ text: /^▲ 2$/ })).map(node => node.props.color)).toContain('suggestion')
  expect((await pane.findAll({ text: /^▼ 3$/ })).map(node => node.props.color)).toContain('warning')
})

test('a long branch name is cut, never the sync counts', async ($, on) => {
  mock.store(on, { shown: false })
  mock.clock(on)
  fakePanes(on)
  const branch = 'feature/a-very-long-branch-name-that-cannot-fit-in-the-pane'
  fakeGit(on, () => ({ stdout: `# branch.oid 1a2b\0# branch.head ${branch}\0# branch.ab +12 -3\0` }))
  await runChanges($)

  const pane = await mountPane($.ui, 'terminal')
  expect(await pane.find({ text: /^▲ 12$/ })).toBeDefined()
  expect(await pane.find({ text: /^▼ 3$/ })).toBeDefined()
})

test('untracked files are read once while their size and mtime hold', async ($, on) => {
  mock.store(on, { shown: false })
  const clock = mock.clock(on)
  fakePanes(on)
  const files = Object.fromEntries(['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts'].map(name => [name, 'x\n']))
  let git: Git = { stdout: SIX_FILES, files }
  const calls = fakeGit(on, () => git)

  await runChanges($)
  await clock.advance(2000)
  await clock.advance(2000)
  expect(calls.reads).toBe(6)

  git = { stdout: SIX_FILES, files, mtimes: { 'c.ts': 5 } }
  await clock.advance(2000)
  expect(calls.reads).toBe(7)
})

/** A promise and the function that resolves it. */
function held() {
  let release = () => {}
  const promise = new Promise<void>(resolve => (release = resolve))
  return { promise, release }
}

test('/changes opens the pane before git answers', async ($, on) => {
  mock.store(on, { shown: false })
  mock.clock(on)
  const panes = fakePanes(on)
  const gate = held()
  fakeGit(on, () => ({ gate: gate.promise }))

  const running = $.command.run(CHANGES)
  for (let waited = 0; !panes.isOpen && waited < 2000; waited += 20) await new Promise(r => setTimeout(r, 20))
  expect(panes.isOpen).toBe(true)
  gate.release()
  await running
})

test('the footer names /git-changes when /changes was refused', async ($, on) => {
  mock.store(on)
  mock.clock(on)
  fakePanes(on)
  fakeGit(on, () => ({}))
  on('command.register', async (_$, e) => {
    if (e.name === 'changes') return { deny: 'a built-in has this name' }
    return { value: { command: e.name } }
  })
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await settle()
  const pane = await mountPane($.ui, 'terminal')
  expect(await pane.find({ text: /· \/git-changes$/ })).toBeDefined()
})

test('a refresh asked during a refresh runs once more afterwards', async ($, on) => {
  mock.store(on, { shown: false })
  const clock = mock.clock(on)
  fakePanes(on)
  let git: Git = {}
  const calls = fakeGit(on, () => git)
  await runChanges($)
  await settle()

  const gate = held()
  git = { gate: gate.promise }
  const before = calls.status
  await clock.advance(2000) // starts a refresh that waits on git
  await settle()
  await clock.advance(2000) // asked while it runs
  await clock.advance(2000) // asked again: still only one queued
  git = {}
  gate.release()
  await settle()
  expect(calls.status).toBe(before + 2)
})

/** The issues value the plugin last wrote, as its `state.set` carries it. */
function watchIssues(on: On) {
  const seen = { value: null as IssuesState | null }
  on('state.set', async (_$, e, next) => {
    if ((e as { key?: string }).key === 'issues') seen.value = (e as { value: IssuesState | null }).value
    return next(e)
  })
  return seen
}
const ghRuns = (calls: { argv: string[][] }, sub: string) => calls.argv.filter(argv => argv[0] === 'gh' && argv[1] === sub)

/** Starts a session the way Claude Code does, the pane shown by default. */
async function startSession($: Engine, on: On) {
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await settle()
}

test('issues are fetched after start without delaying the pane', async ($, on) => {
  mock.store(on)
  mock.clock(on)
  const panes = fakePanes(on)
  const issues = watchIssues(on)
  const gate = held()
  const calls = fakeGit(on, () => ({ gh: { gate: gate.promise, list: issuesJson(3) } }))

  await startSession($, on)
  expect(panes.isOpen).toBe(true)
  expect(calls.status).toBeGreaterThan(0)
  expect(ghRuns(calls, 'issue')).toHaveLength(0)

  gate.release()
  await settle()
  expect(ghRuns(calls, 'repo')[0]).toEqual(['gh', 'repo', 'view', TARGET, '--json', 'name'])
  expect(ghRuns(calls, 'issue')[0]).toEqual([
    'gh', 'issue', 'list', '-R', TARGET, '--state', 'open', '--search', 'sort:updated-desc', '--limit', '100',
    '--json', 'number,title,labels,updatedAt,url',
  ])
  expect(issues.value?.issues.map(issue => issue.number)).toEqual([3, 2, 1])
})

for (const [name, git] of [
  ['a non-GitHub origin', { origin: 'https://gitlab.com/fbandres/oscp-app.git', gh: {} }],
  ['no origin', { origin: null, gh: {} }],
  ['a missing gh', {}],
  ['a logged-out gh', { gh: { loggedOut: true } }],
  ['an unknown issues repo', { gh: { repo: 'missing' } }],
] as const) {
  test(`${name} never fetches issues`, async ($, on) => {
    mock.store(on)
    const clock = mock.clock(on)
    fakePanes(on)
    const issues = watchIssues(on)
    const calls = fakeGit(on, () => git as Git)

    await startSession($, on)
    await clock.advance(60_000)
    await settle()
    expect(ghRuns(calls, 'issue')).toHaveLength(0)
    expect(issues.value).toBeNull()
  })
}

test('a GitHub outage at start retries on the 60s tick', async ($, on) => {
  mock.store(on)
  const clock = mock.clock(on)
  fakePanes(on)
  const issues = watchIssues(on)
  let gh: Gh = { repo: 'down' }
  const calls = fakeGit(on, () => ({ gh }))

  await startSession($, on)
  expect(ghRuns(calls, 'issue')).toHaveLength(0)

  gh = { list: issuesJson(2) }
  await clock.advance(60_000)
  await settle()
  expect(ghRuns(calls, 'issue')).toHaveLength(1)
  expect(issues.value?.issues).toHaveLength(2)
})

test('issues refresh every 60s only while placed', async ($, on) => {
  mock.store(on)
  const clock = mock.clock(on)
  const placed = fakePanes(on)
  const issues = watchIssues(on)
  const calls = fakeGit(on, () => ({ gh: {} }))

  await startSession($, on)
  expect(ghRuns(calls, 'issue')).toHaveLength(1)
  await clock.advance(30_000)
  await settle()
  expect(ghRuns(calls, 'issue')).toHaveLength(1)
  await clock.advance(30_000)
  await settle()
  expect(ghRuns(calls, 'issue')).toHaveLength(2)

  placed.value = false
  await clock.advance(120_000)
  await settle()
  expect(ghRuns(calls, 'issue')).toHaveLength(2)
})

test('store issues=false skips detection entirely', async ($, on) => {
  mock.store(on, { issues: false })
  const clock = mock.clock(on)
  fakePanes(on)
  const issues = watchIssues(on)
  const calls = fakeGit(on, () => ({ gh: {} }))

  await startSession($, on)
  await clock.advance(60_000)
  await settle()
  expect(calls.argv.filter(argv => argv[0] === 'gh')).toHaveLength(0)
})

test('a fetch failure keeps the last list and sets the error', async ($, on) => {
  mock.store(on)
  const clock = mock.clock(on)
  fakePanes(on)
  const issues = watchIssues(on)
  let gh: Gh = { list: issuesJson(2) }
  fakeGit(on, () => ({ gh }))

  await startSession($, on)
  gh = { listError: 'HTTP 502: Bad Gateway\nmore' }
  await clock.advance(60_000)
  await settle()
  const now = issues.value
  expect(now?.issues).toHaveLength(2)
  expect(now?.error).toBe('GitHub: HTTP 502: Bad Gateway')

  gh = { list: issuesJson(2) }
  await clock.advance(60_000)
  await settle()
  expect(issues.value?.error).toBeUndefined()
})

test('100 issues marks the list capped', async ($, on) => {
  mock.store(on)
  mock.clock(on)
  fakePanes(on)
  const issues = watchIssues(on)
  fakeGit(on, () => ({ gh: { list: issuesJson(100) } }))

  await startSession($, on)
  expect(issues.value?.isCapped).toBe(true)
})

/** Records what the plugin copies to the clipboard. */
function fakeCopy(on: On) {
  const copied: string[] = []
  on('ui.copy', async (_$, e) => {
    copied.push(e.text)
    return { value: { isCopied: true as const } }
  })
  return copied
}

const opened = (calls: { argv: string[][] }) => calls.argv.filter(argv => argv[0] === 'xdg-open' || argv[0] === 'open')

test('no issues repo: no tab bar, the pane as before', async ($, on) => {
  mock.store(on)
  mock.clock(on)
  fakePanes(on)
  fakeGit(on, () => ({}))
  await startSession($, on)

  const pane = await mountPane($.ui, 'terminal')
  expect(await pane.find({ key: 'tab-issues' })).toBeUndefined()
  expect(await pane.find({ text: /CHANGES/ })).toBeDefined()
})

test('a detected issues repo shows the tab bar, on Changes', async ($, on) => {
  mock.store(on)
  mock.clock(on)
  fakePanes(on)
  fakeGit(on, () => ({ gh: { list: issuesJson(5) } }))
  await startSession($, on)

  const pane = await mountPane($.ui, 'terminal')
  expect(await pane.find({ text: /^\[Changes 2\]$/ })).toBeDefined()
  expect(await pane.find({ text: /^ Issues 5 $/ })).toBeDefined()
  expect(await pane.find({ text: /^package\-lock\.json$/ })).toBeDefined()
})

test('pressing the Issues tab fetches at once and lists the issues', async ($, on) => {
  mock.store(on)
  mock.clock(on)
  fakePanes(on)
  const calls = fakeGit(on, () => ({ gh: { list: issuesJson(3) } }))
  await startSession($, on)
  const before = ghRuns(calls, 'issue').length

  const pane = await mountPane($.ui, 'terminal')
  await pane.press({ key: 'tab-issues' })
  await settle()
  await pane.redraw()
  expect(ghRuns(calls, 'issue').length).toBe(before + 1)
  expect(await pane.find({ text: /^\[Issues 3\]$/ })).toBeDefined()
  expect(await pane.find({ text: /#3 / })).toBeDefined()
  expect(await pane.find({ text: /Issue number 3/ })).toBeDefined()
  expect(await pane.find({ text: /^bug$/ })).toBeDefined()
  expect(await pane.find({ text: /^package\-lock\.json$/ })).toBeUndefined()
})

test('0 issues shows No open issues and never the repo name', async ($, on) => {
  mock.store(on)
  mock.clock(on)
  fakePanes(on)
  fakeGit(on, () => ({ gh: { list: '[]' } }))
  await startSession($, on)

  const pane = await mountPane($.ui, 'terminal')
  expect(await pane.find({ text: /^ Issues 0 $/ })).toBeDefined()
  await pane.press({ key: 'tab-issues' })
  await settle()
  await pane.redraw()
  expect(await pane.find({ text: /✔ No open issues/ })).toBeDefined()
  expect(await pane.find({ text: /oscp-app-issues/ })).toBeUndefined()
})

test('100 issues reads Issues 100+', async ($, on) => {
  mock.store(on)
  mock.clock(on)
  fakePanes(on)
  fakeGit(on, () => ({ gh: { list: issuesJson(100) } }))
  await startSession($, on)

  const pane = await mountPane($.ui, 'terminal')
  expect(await pane.find({ text: /^ Issues 100\+ $/ })).toBeDefined()
})

for (const [name, opener, argv, isCopied] of [
  ['xdg-open', { xdg: 'ok' }, [['xdg-open']], false],
  ['open when xdg-open is missing', { xdg: 'missing', open: 'ok' }, [['xdg-open'], ['open']], false],
  ['the clipboard when neither opens', { xdg: 'fail', open: 'fail' }, [['xdg-open'], ['open']], true],
] as const) {
  test(`pressing an issue opens it with ${name}`, async ($, on) => {
    mock.store(on)
    mock.clock(on)
    fakePanes(on)
    const copied = fakeCopy(on)
    const calls = fakeGit(on, () => ({ gh: { list: issuesJson(3) }, opener }))
    await startSession($, on)

    const pane = await mountPane($.ui, 'terminal')
    await pane.press({ key: 'tab-issues' })
    await settle()
    await pane.redraw()
    await pane.press({ key: 'issue-2' })
    await settle()
    const url = `https://github.com/${TARGET}/issues/2`
    expect(opened(calls)).toEqual(argv.map(([cmd]) => [cmd, url]))
    expect(copied).toEqual(isCopied ? [url] : [])
  })
}

test('the issues error shows in the Issues tab only', async ($, on) => {
  mock.store(on)
  const clock = mock.clock(on)
  fakePanes(on)
  let gh: Gh = { list: issuesJson(2) }
  fakeGit(on, () => ({ gh }))
  await startSession($, on)
  gh = { listError: 'HTTP 502: Bad Gateway' }
  await clock.advance(60_000)
  await settle()

  const pane = await mountPane($.ui, 'terminal')
  expect(await pane.find({ text: /GitHub: HTTP 502/ })).toBeUndefined()
  await pane.press({ key: 'tab-issues' })
  await settle()
  await pane.redraw()
  expect(await pane.find({ text: /GitHub: HTTP 502/ })).toBeDefined()
  expect(await pane.find({ text: /Issue number 2/ })).toBeDefined()
})

test('the more row under a long issue list opens the full list', async ($, on) => {
  mock.store(on)
  mock.clock(on)
  fakePanes(on)
  const calls = fakeGit(on, () => ({ gh: { list: issuesJson(30) } }))
  await startSession($, on)

  const pane = await mountPane($.ui, 'terminal', 12)
  await pane.press({ key: 'tab-issues' })
  await settle()
  await pane.redraw()
  expect(await pane.find({ text: /↓ \d+ more/ })).toBeDefined()
  await pane.press({ key: 'issues-more' })
  await settle()
  expect(opened(calls)).toEqual([['xdg-open', `https://github.com/${TARGET}/issues`]])
})

/** Runs `/changes <args>` (or the fallback name) and lets background work land. */
async function runArgs($: Engine, args: string, command = 'changes') {
  const answer = await $.command.run({ ...CHANGES, command, args })
  await settle()
  return answer
}

/** A store that remembers writes, readable by the test. */
function fakeStore(on: On, entries: Record<string, unknown> = {}) {
  const store: Record<string, unknown> = { ...entries }
  on('store.get', async (_$, e) => ({ value: store[e.key] }))
  on('store.set', async (_$, e) => {
    store[e.key] = e.value
    return { value: undefined }
  })
  return store
}

test('/changes issues hides the tab and remembers it, and shows it again', async ($, on) => {
  const store = fakeStore(on)
  mock.clock(on)
  fakePanes(on)
  fakeGit(on, () => ({ gh: { list: issuesJson(2) } }))
  await startSession($, on)
  const pane = await mountPane($.ui, 'terminal')
  await pane.press({ key: 'tab-issues' })
  await settle()

  expect((await runArgs($, 'issues')).text).toBe('Issues tab hidden.')
  expect(store.issues).toBe(false)
  await pane.redraw()
  expect(await pane.find({ key: 'tab-issues' })).toBeUndefined()
  expect(await pane.find({ text: /^package\-lock\.json$/ })).toBeDefined()

  expect((await runArgs($, 'issues')).text).toBe('Issues tab shown.')
  expect(store.issues).toBe(true)
  await pane.redraw()
  expect(await pane.find({ key: 'tab-issues' })).toBeDefined()
})

for (const [why, git, reply] of [
  ['a non-GitHub origin', { origin: 'https://gitlab.com/fbandres/oscp-app.git', gh: {} }, 'origin is not a GitHub repo'],
  ['an unknown repo', { gh: { repo: 'missing' } }, `${TARGET} not found or no access`],
  ['no gh', {}, 'gh is not installed'],
  ['a logged-out gh', { gh: { loggedOut: true } }, 'gh is not logged in (run: gh auth login)'],
] as const) {
  test(`turning issues on with ${why} says why there is no tab`, async ($, on) => {
    fakeStore(on, { issues: false })
    mock.clock(on)
    fakePanes(on)
    fakeGit(on, () => git as Git)
    await startSession($, on)

    expect((await runArgs($, 'issues')).text).toBe(`Issues tab on, but no issues repo was found: ${reply}.`)
  })
}

test('turning issues on while GitHub is down says it retries', async ($, on) => {
  fakeStore(on, { issues: false })
  mock.clock(on)
  fakePanes(on)
  fakeGit(on, () => ({ gh: { repo: 'down' } }))
  await startSession($, on)

  expect((await runArgs($, 'issues')).text).toBe('Issues tab on; GitHub is unreachable right now, retrying every minute.')
})

test('/changes ISSUES with spaces works; other arguments get the usage line', async ($, on) => {
  fakeStore(on)
  mock.clock(on)
  fakePanes(on)
  fakeGit(on, () => ({ gh: {} }))
  await startSession($, on)

  expect((await runArgs($, '  ISSUES ')).text).toBe('Issues tab hidden.')
  expect((await runArgs($, 'foo')).text).toBe('Usage: /changes [issues]')
})

test('/git-changes issues works the same', async ($, on) => {
  fakeStore(on)
  mock.clock(on)
  fakePanes(on)
  fakeGit(on, () => ({ gh: {} }))
  on('command.register', async (_$, e) =>
    e.name === 'changes' ? { deny: 'a built-in has this name' } : { value: { command: e.name } },
  )
  await startSession($, on)

  expect((await runArgs($, 'issues', 'git-changes')).text).toBe('Issues tab hidden.')
  expect((await runArgs($, 'nope', 'git-changes')).text).toBe('Usage: /git-changes [issues]')
})

test('a pane drawn before detection finishes gains the tab bar when issues arrive', async ($, on) => {
  mock.store(on)
  mock.clock(on)
  fakePanes(on)
  const gate = held()
  fakeGit(on, () => ({ gh: { gate: gate.promise, list: issuesJson(4) } }))
  await startSession($, on)

  const pane = await mountPane($.ui, 'terminal')
  expect(await pane.find({ key: 'tab-issues' })).toBeUndefined()
  gate.release()
  await settle()
  expect(await pane.find({ text: /^ Issues 4 $/ })).toBeDefined()
})

test('a gh call that times out during detection retries instead of claiming gh is missing', async ($, on) => {
  fakeStore(on, { issues: false })
  const clock = mock.clock(on)
  fakePanes(on)
  let gh: Gh = { repo: 'hang' }
  const calls = fakeGit(on, () => ({ gh }))
  await startSession($, on)

  expect((await runArgs($, 'issues')).text).toBe('Issues tab on; GitHub is unreachable right now, retrying every minute.')
  gh = { list: issuesJson(1) }
  await clock.advance(60_000)
  await settle()
  expect(ghRuns(calls, 'issue')).toHaveLength(1)
})

test('an offline start is not mistaken for logged out when gh auth status fails', async ($, on) => {
  fakeStore(on, { issues: false })
  mock.clock(on)
  fakePanes(on)
  fakeGit(on, () => ({ gh: { repo: 'down', authBroken: true } }))
  await startSession($, on)

  expect((await runArgs($, 'issues')).text).toBe('Issues tab on; GitHub is unreachable right now, retrying every minute.')
})

test('a fetch error never shows the issues repo name', async ($, on) => {
  mock.store(on)
  const clock = mock.clock(on)
  fakePanes(on)
  let gh: Gh = { list: issuesJson(2) }
  fakeGit(on, () => ({ gh }))
  await startSession($, on)
  gh = { listError: `GraphQL: Could not resolve to a Repository with the name '${TARGET}'. (repository)` }
  await clock.advance(60_000)
  await settle()

  const pane = await mountPane($.ui, 'terminal')
  await pane.press({ key: 'tab-issues' })
  await settle()
  await pane.redraw()
  expect(await pane.find({ text: /GitHub: issues repo not found or no access/ })).toBeDefined()
  expect(await pane.find({ text: /oscp-app-issues/ })).toBeUndefined()
})

test('turning issues off while detection is still running keeps them off', async ($, on) => {
  fakeStore(on)
  mock.clock(on)
  fakePanes(on)
  const gate = held()
  const calls = fakeGit(on, () => ({ gh: { gate: gate.promise, list: issuesJson(2) } }))
  await startSession($, on)

  expect((await runArgs($, 'issues')).text).toBe('Issues tab hidden.')
  gate.release()
  await settle()
  expect(ghRuns(calls, 'issue')).toHaveLength(0)
  const pane = await mountPane($.ui, 'terminal')
  expect(await pane.find({ key: 'tab-issues' })).toBeUndefined()
})

test('an issue row with no label or age never runs past a narrow pane', async ($, on) => {
  mock.store(on)
  mock.clock(on)
  fakePanes(on)
  const list = JSON.stringify([
    { number: 1234, title: 'A long title that has to be cut short', labels: [], updatedAt: 'garbage', url: `https://github.com/${TARGET}/issues/1234` },
  ])
  fakeGit(on, () => ({ gh: { list } }))
  await startSession($, on)

  const pane = await mountPane($.ui, 'terminal', 20, 20)
  await pane.press({ key: 'tab-issues' })
  await settle()
  await pane.redraw()
  const row = await pane.find({ key: 'issue-1234' })
  expect(row).toBeDefined()
  expect(row!.text.length).toBeLessThanOrEqual(20)
})
