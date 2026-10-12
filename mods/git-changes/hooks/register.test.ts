import type { On } from 'claude-code'
import type { Engine, EngineMount } from 'claude-code/testing'
import { expect, mock, test } from 'claude-code/testing'

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

/** Runs `/changes` as the person typing it does. */
const runChanges = ($: Engine) => $.command.run(CHANGES)

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
}

/**
 * Answers the plugin's git calls and file reads from `git()`. `status` counts
 * `git status` runs; `argv` holds every git argv seen.
 */
function fakeGit(on: On, git: () => Git) {
  const calls = { status: 0, argv: [] as string[][] }
  on('process.run', async (_$, e) => {
    const now = git()
    calls.argv.push([...e.argv])
    if (e.argv[1] === 'rev-parse') {
      return now.isRepo === false ? ran(128, '', 'fatal: not a git repository') : ran(0, `${ROOT}\n`, '')
    }
    if (e.argv.includes('diff')) {
      const isStaged = e.argv.includes('--cached')
      const isDefault = now.stdout === undefined
      return ran(0, (isStaged ? now.staged : now.unstaged) ?? (isDefault && !isStaged ? DIRTY_UNSTAGED : ''), '')
    }
    calls.status++
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
      : { value: { kind: 'file' as const, size: text.length, mtimeMs: 0, isLink: false } }
  })
  on('fs.read', async (_$, e) => {
    const text = fileOf(e.path)
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

const mountPane = (ui: EngineMount, surface: 'terminal' | 'desktop', bodyRows = 20) =>
  ui.mount({
    plugin: PLUGIN,
    surface,
    component: 'Pane',
    requestId: PLUGIN,
    props: {
      title: 'Source Control',
      isFocused: false,
      bodyColumns: 40,
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
    expect(await pane.find({ text: /… 4 more/ })).toBeDefined()
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

test('sync shows only the non-zero side, coloured, with words while there is room', async ($, on) => {
  mock.store(on, { shown: false })
  const clock = mock.clock(on)
  fakePanes(on)
  let git: Git = { stdout: CLEAN_HEAD + '# branch.upstream origin/main\0# branch.ab +1 -0\0' }
  fakeGit(on, () => git)
  await runChanges($)

  const pane = await mountPane($.ui, 'terminal')
  expect((await pane.findAll({ text: /^↑1 to push$/ })).map(node => node.props.color)).toContain('suggestion')
  expect(await pane.find({ text: /↓/ })).toBeUndefined()

  git = { stdout: CLEAN_HEAD + '# branch.upstream origin/main\0# branch.ab +2 -3\0' }
  await clock.advance(2000)
  expect((await pane.findAll({ text: /^↑2 to push$/ })).map(node => node.props.color)).toContain('suggestion')
  expect((await pane.findAll({ text: /^↓3 to pull$/ })).map(node => node.props.color)).toContain('warning')
})
