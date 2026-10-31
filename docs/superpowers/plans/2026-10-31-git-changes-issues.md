# git-changes 0.3.0 (Issues tab, scrolling, review fixes) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an auto-detected Issues tab (open issues of `<owner>/<repo>-issues`) to the git-changes pane. Give both tabs a pinned header with a scrolling list. Fix four review findings.

**Architecture:** Pure logic goes in small `.ts` modules with unit tests, the way `status.ts` and `theme.ts` work today: `scroll.ts` (window maths) and `issues.ts` (remote parsing, gh JSON, ages, row fitting, error classes). `register.tsx` does the wiring: a second atom for issues, a 60 s issues timer next to the 2 s git timer, `ui.scroll` and `ui.focus` hooks that move the mod's own per-tab offsets, and tab and row `Button`s.

**Tech Stack:** TypeScript + JSX against the `claude-code` plugin API, tests with `claude-code/testing` (`claude plugin test`), GitHub via the `gh` CLI run with `$.process.run`.

**Spec:** `docs/superpowers/specs/2026-10-31-git-changes-issues-design.md`. Read it before any task. The behaviour tables and copy live there.

## Global Constraints

- All paths below are relative to `mods/git-changes/` unless they start with `docs/`.
- The plugin API only. No npm dependencies. `gh` is optional at runtime: without it there is no tab and nothing breaks.
- The issues repo is `<owner>/<repo>-issues` from `origin` on `github.com` only. Never detect when `<repo>` already ends in `-issues`.
- Fetch: `gh issue list -R <target> --state open --search "sort:updated-desc" --limit 100 --json number,title,labels,updatedAt,url`.
- Detect: `gh repo view <target> --json name`. Logged-out check: `gh auth status`.
- Issues refresh: every **60 000 ms** while the pane is placed, plus immediately on an Issues tab press. Git stays at 2000 ms. Never poll GitHub faster than 60 s.
- Issues work never delays session start, the pane opening, or the git refresh. Always fire and forget it.
- Never render the issues repo name in the pane.
- No issues repo, or feature off: the pane renders exactly as 0.2.1, with **no tab bar**.
- Store key `issues` (boolean, default on). Store key `shown` is unchanged.
- Version `0.3.0` in `.claude-plugin/plugin.json`.
- Copy (verbatim): `Issues tab hidden.` · `Issues tab shown.` · `Issues tab on, but no issues repo was found: <reason>.` · `Issues tab on; GitHub is unreachable right now, retrying every minute.` · `✔ No open issues` · `↑ N above` · `↓ N more` · error line `GitHub: <first stderr line>`.
- Reasons (verbatim): `origin is not a GitHub repo` · `<target> not found or no access` · `gh is not installed` · `gh is not logged in (run: gh auth login)`.
- Run all tests: `claude plugin test mods/git-changes` from the repo root. Full check: `sh scripts/check.sh`.

## Review Focus

1. **The list shrinks while scrolled** (commit 30 files while scrolled to row 25). The offset must clamp so the window is never empty or past the end. Test in Task 3 (`windowOf` with an offset past the end) and Task 4 (render after the file count drops).
2. **A narrow pane (bodyColumns ≈ 24) with long titles and labels.** Rows must never wrap. The label drops first, then the age. Test in Task 5 (`fitIssueRow` at width 24).
3. **`gh` present but logged out, or the network down at start.** It must not be reported as "not found". Logged out is definitive; a timeout or 5xx retries. Test in Task 5 (`classifyGhFailure`) and Task 6 (a retry tick turns into a tab).
4. **The pane height is tiny** (bodyRows smaller than the pinned rows + 3). It must not crash or show negative counts. Show at least one row, with the markers dropped. Test in Task 3 (`windowOf` with room 1 and 2).
5. **An issue title with a NUL, newline or emoji**, or `labels: []`. The title is flattened to one line and a missing label renders nothing. Test in Task 5 (`parseIssues`).

---

### Task 0: Spike: does pinned scrolling reach the hooks? (throwaway, not committed)

**Files:**
- Create (throwaway): `/tmp/claude-…/scratchpad/scroll-spike/` (a copy of the mod), or a stash on a scratch branch

**Interfaces:** none. This task produces a yes/no answer that goes into Task 4.

- [ ] **Step 1:** In a copy of the mod, change the Pane render to draw a fixed header (2 rows), a slice of 40 dummy rows sized to `e.props.scroll.bodyRows - 4`, keyed `Button`s for 3 of them (`key="row-N"`), and a footer. Add `on('ui.scroll', { component: 'Pane', requestId: 'git-changes' }, ($, e) => { log(e.by, e.origin, e.pointer); return {} })` and `on('ui.focus', { requestId: 'git-changes' }, async ($, e, next) => { log(e.element); return next(e) })`. Log to a file with `$.fs.write`.
- [ ] **Step 2:** Load it with `claude --plugin-dir <copy>` and open the pane. Then:
  1. Wheel over the list.
  2. Focus the pane and press PgDn/PgUp.
  3. Press the arrows across the buttons.

  Check the log.
- [ ] **Step 3:** Record the result in the Task 4 notes, in the plan or in the PR description:
  - (a) Do the wheel and PgUp/PgDn raise `ui.scroll` when the tree fits?
  - (b) If not, do they once the tree is one blank row taller than `bodyRows`?
  - (c) Does `ui.focus` fire on arrow moves, with `element` set?

  If (a) and (b) both fail, **stop and ask the owner** (spec: Risk). Do not fall back silently.

---

### Task 1: Review fix 1: cache untracked line counts

**Files:**
- Modify: `hooks/register.tsx` (`untrackedStats`, module state)
- Test: `hooks/register.test.ts`

**Interfaces:**
- Produces: module state `const untrackedCache = new Map<string, { size: number; mtimeMs: number; stat: LineStat }>()`. `untrackedStats($, files)` keeps its signature.

- [ ] **Step 1: Write the failing test** `untracked files are read once while their size and mtime hold`
  - Extend `fakeGit` so `fs.stat` returns `mtimeMs` from an optional `mtimes?: Record<string, number>` (default 0), and count `fs.read` calls in `calls.reads`.
  - Open the pane with `SIX_FILES`-style untracked files, then tick the clock 2 s twice. Assert `calls.reads === 6`.
  - Bump one file's `mtimes` and tick again. Assert `calls.reads === 7`.
- [ ] **Step 2:** Run `claude plugin test mods/git-changes`. Expected: the new test FAILS (reads = 18).
- [ ] **Step 3:** Implement. Use the cached `stat` when `size` and `mtimeMs` both match. After each pass, delete cache keys not in this pass's untracked list.
- [ ] **Step 4:** Run the tests. Expected: all PASS.
- [ ] **Step 5:** Commit: `git commit -m "fix(git-changes): cache untracked line counts by size and mtime"`

---

### Task 2: Review fixes 3, 4, 5: instant open, the real command name, a queued refresh

**Files:**
- Modify: `hooks/register.tsx` (`show`, `registerCommand`, `refresh`, footer)
- Test: `hooks/register.test.ts`

**Interfaces:**
- Produces: module state `let commandName: string = COMMAND`, set by `registerCommand` to whichever name registered. `let pendingRefresh = false`.

- [ ] **Step 1: Write the failing tests**
  - `/changes opens the pane before git answers`: make `git status` hang on a promise you control. Run `/changes` without awaiting, then assert `panes.isOpen === true` before resolving git.
  - `the footer names /git-changes when /changes was refused`: reuse the setup of the existing test `a refused /changes falls back…`, mount the pane, and assert `find({ text: /· \/git-changes$/ })` is defined.
  - `an edit during a refresh triggers one more refresh`: hold `git status` on a promise. Fire two `tool.call` Edit events while it's held, then release. Assert `calls.status` rose by exactly 2 (the held one + one queued), not 3.
- [ ] **Step 2:** Run the tests. Expected: the three new tests FAIL.
- [ ] **Step 3:** Implement:
  - `show()`: `startTimer`, `lastRaw = undefined`, `await ui.open`, then `void refresh($).catch(() => {})`.
  - `refresh()`: when `isChecking`, set `pendingRefresh = true` and return. In `finally`, if `pendingRefresh` is set, clear it and call `void refresh($)`.
  - Footer: `` `updated ${time} · /${commandName}` ``. Drop the words "to hide" so it fits with tabs. Update the existing footer assertion if one exists.
- [ ] **Step 4:** Run the tests. Expected: all PASS.
- [ ] **Step 5:** Commit: `git commit -m "fix(git-changes): open instantly, name the registered command, queue a refresh mid-refresh"`

---

### Task 3: `scroll.ts`: window maths

**Files:**
- Create: `hooks/scroll.ts`
- Test: `hooks/scroll.test.ts`

**Interfaces:**
- Produces:
  - `export type ListWindow = { start: number; end: number; above: number; below: number }`. Rows `[start, end)` show. `above`/`below` are hidden counts; a marker row shows when non-zero.
  - `export function windowOf(length: number, offset: number, room: number): ListWindow`. `room` = rows available for the list **including** marker rows.
  - `export function scrolled(offset: number, by: number, length: number, room: number): number`: the new clamped offset (`windowOf(length, offset + by, room).start`).
  - `export function followed(offset: number, index: number, length: number, room: number): number`: the smallest move of `offset` that brings `index` into `[start, end)`.

- [ ] **Step 1: Write the failing tests** in `hooks/scroll.test.ts`:

```ts
test('windowOf: everything fits, no markers', () => {
  expect(windowOf(5, 0, 8)).toEqual({ start: 0, end: 5, above: 0, below: 0 })
  expect(windowOf(5, 3, 8)).toEqual({ start: 0, end: 5, above: 0, below: 0 }) // offset ignored when it fits
})
test('windowOf: top, middle, end of a long list', () => {
  expect(windowOf(40, 0, 8)).toEqual({ start: 0, end: 7, above: 0, below: 33 })
  expect(windowOf(40, 14, 8)).toEqual({ start: 14, end: 20, above: 14, below: 20 })
  expect(windowOf(40, 33, 8)).toEqual({ start: 33, end: 40, above: 33, below: 0 })
})
test('windowOf: an offset past the end clamps (the list shrank)', () => {
  expect(windowOf(10, 30, 8)).toEqual({ start: 3, end: 10, above: 3, below: 0 })
  expect(windowOf(0, 5, 8)).toEqual({ start: 0, end: 0, above: 0, below: 0 })
})
test('windowOf: tiny rooms still show something', () => {
  expect(windowOf(40, 0, 1)).toEqual({ start: 0, end: 1, above: 0, below: 0 }) // room < 3: rows only, no markers
  expect(windowOf(40, 10, 2)).toEqual({ start: 10, end: 12, above: 0, below: 0 })
  expect(windowOf(40, 39, 2)).toEqual({ start: 38, end: 40, above: 0, below: 0 }) // clamps to the last full window
})
test('scrolled: wheel and pages clamp at both ends', () => {
  expect(scrolled(0, -1, 40, 8)).toBe(0)
  expect(scrolled(0, 8, 40, 8)).toBe(8)
  expect(scrolled(30, 8, 40, 8)).toBe(33)
})
test('followed: brings a row into view with the least move', () => {
  expect(followed(0, 3, 40, 8)).toBe(0) // already visible
  expect(followed(0, 7, 40, 8)).toBe(2) // just below: becomes the last visible row of a middle window
  expect(followed(20, 15, 40, 8)).toBe(15) // above: becomes the first row
})
```

- [ ] **Step 2:** Run `claude plugin test mods/git-changes`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement** `windowOf` with this algorithm. The tests pin the rest:

```
if length <= room → {0, length, 0, 0}
room = max(1, room)
if room < 3       → start = clamp(offset, 0, length - room); end = start + room; above = below = 0
maxStart = length - (room - 1)          // at the end only the ↑ marker shows
start = clamp(offset, 0, maxStart)
rows  = room - (start > 0 ? 1 : 0)
if start + rows >= length → end = length, below = 0
else                      → rows -= 1, end = start + rows, below = length - end
above = start
```

`followed`: if `index < start` the result is `index`. If `index >= end`, search upward from `start` for the first offset whose window contains `index`, at most `length` steps.

- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5:** Commit: `git commit -m "feat(git-changes): window maths for a pinned scrolling list"`

---

### Task 4: Pinned scrolling on the Changes list

**Files:**
- Modify: `hooks/register.tsx` (render, a new `ui.scroll` hook, module state)
- Test: `hooks/register.test.ts`

**Interfaces:**
- Consumes: `windowOf`, `scrolled` (Task 3). The Task 0 result (whether the tree must be one blank row taller than `bodyRows`).
- Produces:
  - `type Tab = 'changes' | 'issues'`.
  - Module state `let tab: Tab = 'changes'` and `const offsets: Record<Tab, number> = { changes: 0, issues: 0 }`.
  - `function listRoom(bodyRows: number, pinnedRows: number): number` = `Math.max(1, bodyRows - pinnedRows)`.
  - Task 7 reuses all of this.

- [ ] **Step 1: Write the failing tests**
  - Replace the current `… N more` expectation (search the test file for `more`) with: mount with `bodyRows` so only 3 list rows fit and 6 files, and assert `↓ 3 more` (or the exact count `windowOf` gives) and no `↑` row.
  - `the wheel scrolls the file list and the header stays`: raise a scroll through `$.ui.scroll({ in: PLUGIN, to: { key: 'file-f.ts' } })`. Files get `key={`file-${path}`}` on their row `Box`. Re-find, and assert `↑ N above` shows, `⎇ main` still shows, and `f.ts` is visible.

    If the harness can't raise `ui.scroll` this way, cover the hook with a direct unit test of a small exported `onScroll(offset, e, length, room)` helper instead, and note it in the commit.
  - `committing files while scrolled clamps the window`: scroll to the end, switch the fake to `CLEAN_HEAD + two files`, tick 2 s, and assert both files show with no markers.
- [ ] **Step 2:** Run the tests. Expected: the new and changed tests FAIL.
- [ ] **Step 3: Implement**
  - Render: `pinned` = header rows actually drawn (branch 1, totals 1 if dirty, divider 1, error 1 if any, `CHANGES` label 1 if dirty, divider 1, footer 1). `room = listRoom(bodyRows, pinned)`. `w = windowOf(files.length, offsets.changes, room)`. Draw `↑ ${w.above} above` when `w.above`, the rows `files.slice(w.start, w.end)`, then `↓ ${w.below} more` when `w.below`. Both markers are `dimColor`.
  - Write the clamped `w.start` back to `offsets.changes` (module state, no atom write).
  - Apply the Task 0 finding: if needed, append one blank `<Text> </Text>` row so the tree exceeds `bodyRows`.
  - Hook: `on('ui.scroll', { component: 'Pane', requestId: PANE }, async ($, e) => { … return {} })`.
    - Ignore events where `e.pointer` is set and `e.pointer.row` is above the list's first row.
    - Otherwise set `offsets[tab] = scrolled(offsets[tab], e.by, length, roomFromLastRender)` and nudge a redraw with `update($, status, s => s && { ...s })`.
    - Keep `lastRoom` and `lastListTop` in module state from the last render.
  - Returning `{}` without `next` keeps the engine's window at 0 (claude-code.d.ts example at `'ui.scroll'`).
- [ ] **Step 4:** Run the tests. Expected: all PASS, including every existing test.
- [ ] **Step 5:** Commit: `git commit -m "feat(git-changes): pinned header with a scrolling file list"`

---

### Task 5: `issues.ts`: pure issue logic

**Files:**
- Create: `hooks/issues.ts`
- Modify: `types/index.d.ts`
- Test: `hooks/issues.test.ts`

**Interfaces:**
- Produces, in `types/index.d.ts`:

```ts
export type Issue = { number: number; title: string; label?: string; updatedAt: string; url: string }
export type IssuesState = { issues: Issue[]; isCapped: boolean; error?: string; updatedAt: number }
// PluginState['git-changes'] gains: issues: IssuesState | null
```

- Produces, in `hooks/issues.ts`:
  - `export const ISSUES_LIMIT = 100`.
  - `export function parseRemote(url: string): { owner: string; repo: string } | undefined`.
  - `export function issuesRepoOf(url: string): string | undefined`: `"owner/repo-issues"`, or undefined (non-GitHub, or the repo already ends in `-issues`).
  - `export function parseIssues(json: string): Issue[]`: throws on invalid JSON. Flattens whitespace and control characters in titles to single spaces. `label` = `labels[0]?.name`.
  - `export type GhFailure = 'logged-out' | 'not-found' | 'temporary'`.
  - `export function classifyGhFailure(stderr: string): GhFailure`.
  - `export function ageOf(iso: string, now: number): string`.
  - `export function fitIssueRow(issue: Issue, width: number, age: string): { head: string; title: string; label: string; age: string }`. `head` = `#N`, then one space. Empty `label`/`age` means dropped.

- [ ] **Step 1: Write the failing tests** in `hooks/issues.test.ts`:

```ts
test('parseRemote / issuesRepoOf: github https, ssh, ssh://; others none', () => {
  expect(issuesRepoOf('https://github.com/fbandres/oscp-app.git')).toBe('fbandres/oscp-app-issues')
  expect(issuesRepoOf('https://github.com/fbandres/oscp-app')).toBe('fbandres/oscp-app-issues')
  expect(issuesRepoOf('git@github.com:fbandres/oscp-app.git')).toBe('fbandres/oscp-app-issues')
  expect(issuesRepoOf('ssh://git@github.com/fbandres/oscp-app.git')).toBe('fbandres/oscp-app-issues')
  expect(issuesRepoOf('https://gitlab.com/fbandres/oscp-app.git')).toBeUndefined()
  expect(issuesRepoOf('https://github.com/fbandres/oscp-app-issues.git')).toBeUndefined()
  expect(issuesRepoOf('')).toBeUndefined()
})
test('parseIssues: first label, flattened titles, no labels', () => {
  const json = JSON.stringify([
    { number: 42, title: 'Login\nfails\0 on Safari 🧭', labels: [{ name: 'bug' }, { name: 'p1' }], updatedAt: '2026-10-31T10:00:00Z', url: 'https://github.com/o/r-issues/issues/42' },
    { number: 7, title: 'Refactor auth', labels: [], updatedAt: '2026-09-30T10:00:00Z', url: 'https://github.com/o/r-issues/issues/7' },
  ])
  const [a, b] = parseIssues(json)
  expect(a).toEqual({ number: 42, title: 'Login fails on Safari 🧭', label: 'bug', updatedAt: '2026-10-31T10:00:00Z', url: 'https://github.com/o/r-issues/issues/42' })
  expect(b.label).toBeUndefined()
  expect(() => parseIssues('nope')).toThrow()
})
test('classifyGhFailure', () => {
  expect(classifyGhFailure('To get started with GitHub CLI, please run:  gh auth login')).toBe('logged-out')
  expect(classifyGhFailure('GraphQL: Could not resolve to a Repository with the name \'o/r-issues\'.')).toBe('not-found')
  expect(classifyGhFailure('HTTP 404: Not Found')).toBe('not-found')
  expect(classifyGhFailure('error connecting to api.github.com')).toBe('temporary')
  expect(classifyGhFailure('HTTP 502: Bad Gateway')).toBe('temporary')
})
test('ageOf', () => {
  const now = Date.parse('2026-10-31T12:00:00Z')
  const at = (ms: number) => new Date(now - ms).toISOString()
  const MIN = 60_000, H = 60 * MIN, D = 24 * H
  expect(ageOf(at(20_000), now)).toBe('now')
  expect(ageOf(at(5 * MIN), now)).toBe('5m')
  expect(ageOf(at(2 * H), now)).toBe('2h')
  expect(ageOf(at(3 * D), now)).toBe('3d')
  expect(ageOf(at(14 * D), now)).toBe('2w')
  expect(ageOf(at(120 * D), now)).toBe('4mo')
  expect(ageOf(at(400 * D), now)).toBe('1y')
})
test('fitIssueRow: label drops first, then age; title cut with …', () => {
  const issue = { number: 42, title: 'Login fails on Safari when cookies are blocked', label: 'enhancement', updatedAt: '', url: '' }
  const wide = fitIssueRow(issue, 48, '2h')
  expect(wide.label).toBe('enhanceme…') // label cut to 10 columns
  expect(wide.age).toBe('2h')
  const mid = fitIssueRow(issue, 30, '2h')
  expect(mid.label).toBe('')
  expect(mid.age).toBe('2h')
  const narrow = fitIssueRow(issue, 24, '2h')
  expect([narrow.label, narrow.age]).toEqual(['', ''])
  expect((narrow.head + narrow.title).length).toBeLessThanOrEqual(24)
  expect(narrow.title.endsWith('…')).toBe(true)
})
```

- [ ] **Step 2:** Run the tests. Expected: FAIL, module not found.
- [ ] **Step 3: Implement.**
  - `ageOf` thresholds: < 1 min `now`, < 60 min `Nm`, < 24 h `Nh`, < 7 d `Nd`, < 30 d `floor(d/7)w`, < 365 d `floor(d/30)mo`, else `floor(d/365)y`.
  - `fitIssueRow`: keep a title of at least 12 columns. Drop the label when `head + 12 + 1 + label + 1 + age > width`. Then drop the age by the same rule without the label.
  - `classifyGhFailure`: match `/gh auth login|not logged in|authentication/i` first, then `/Could not resolve to a Repository|HTTP 404|Not Found/`.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5:** Commit: `git commit -m "feat(git-changes): issue parsing, ages, row fitting and gh error classes"`

---

### Task 6: Detection and fetching (no UI yet)

**Files:**
- Modify: `hooks/register.tsx`
- Test: `hooks/register.test.ts`

**Interfaces:**
- Consumes: everything from Task 5.
- Produces:
  - `const issues = atom({ plugin: 'git-changes', key: 'issues' } as const, null as IssuesState | null)`.
  - `type Detection = { kind: 'off' } | { kind: 'none'; reason: string } | { kind: 'retrying' } | { kind: 'detected'; target: string }`, module state `let detection: Detection = { kind: 'off' }`.
  - `async function detectIssues($: Engine): Promise<void>`: sets `detection`. On `detected` it calls `void fetchIssues($)`.
  - `async function fetchIssues($: Engine, isUrgent = false): Promise<void>`: one in flight at a time. `isUrgent` queues one more. Skips the write when the stdout matches `lastIssuesRaw`.
  - The issues timer `issuesTimer` is started by `startTimer` and cancelled by `hide` and by `ui.close`. Each tick: `retrying` → `detectIssues`, `detected` → `fetchIssues`, only while `isPlaced`.

- [ ] **Step 1: Write the failing tests.**
  - Add `fakeGh(on, gh: () => Gh)` with `Gh = { missing?: boolean; loggedOut?: boolean; repo?: 'found' | 'missing' | 'down'; list?: string; listError?: string }`.
    - `missing` makes `process.run` reject for argv[0] `gh`.
    - `loggedOut` makes `gh auth status` exit 1.
    - `repo` drives `gh repo view`: `down` exits 1 with `error connecting to api.github.com`.
  - Extend `fakeGit` with `origin?: string | null` for `git remote get-url origin`. Answer it before the status branch, and default to `https://github.com/fbandres/oscp-app.git`.
  - Tests:
    - `issues are fetched after start without delaying the pane`: assert the pane opens and `status` shows while `gh repo view` is still held.
    - `a non-GitHub origin, a missing gh, a logged-out gh and an unknown repo never fetch issues` (four cases): assert no `gh issue list` argv was seen, and `read($, issues)` stays null.
    - `a GitHub outage at start retries on the 60s tick`: `repo: 'down'` first, then `found`. Advance 60 s and assert `gh issue list` ran.
    - `issues refresh every 60s only while placed`.
    - `store issues=false skips detection entirely`: no `gh` argv at all.
    - `a fetch failure keeps the last list and sets error`: the first list succeeds. Then `listError: 'HTTP 502: Bad Gateway'`, tick, and assert the old issues remain and `error === 'GitHub: HTTP 502: Bad Gateway'`.
    - `100 issues sets isCapped`.
- [ ] **Step 2:** Run the tests. Expected: the new tests FAIL.
- [ ] **Step 3: Implement.**
  - Detection order:
    1. Store `issues === false` → `off`.
    2. `git remote get-url origin` → `issuesRepoOf` → undefined → `none('origin is not a GitHub repo')`.
    3. `gh repo view <target> --json name`. A rejected run → `none('gh is not installed')`. Exit 0 → `detected`.
    4. Otherwise run `gh auth status`. Non-zero → `none('gh is not logged in (run: gh auth login)')`.
    5. Otherwise `classifyGhFailure(stderr)`: `not-found` → `none(`${target} not found or no access`)`, else `retrying`.
  - Call `detectIssues` from `session.start` after `showOnStart`, fire and forget, in the same place as `syncEditorTheme`.
- [ ] **Step 4:** Run the tests. Expected: all PASS.
- [ ] **Step 5:** Commit: `git commit -m "feat(git-changes): detect <repo>-issues and fetch open issues every 60s"`

---

### Task 7: Tabs and the Issues tab

**Files:**
- Modify: `hooks/register.tsx` (render, press handlers, a `ui.focus` hook, `openUrl`)
- Test: `hooks/register.test.ts`

**Interfaces:**
- Consumes: `tab`, `offsets`, `listRoom` (Task 4). `windowOf`, `followed` (Task 3). The `issues` atom, `detection`, `fetchIssues` (Task 6). `fitIssueRow`, `ageOf`, `ISSUES_LIMIT` (Task 5).
- Produces:
  - `async function openUrl($: Engine, url: string, surface: unknown): Promise<void>`: tries `['xdg-open', url]`, then `['open', url]` (rejection or non-zero exit counts as failure), then `$.ui.copy({ text: url, surface })`.
  - Button keys: `tab-changes`, `tab-issues`, `issue-<number>`, `issues-more`.

- [ ] **Step 1: Write the failing tests.**
  - `no issues repo: no tab bar, pane as before`: assert there's no `find({ key: 'tab-issues' })`.
  - `detected: tab bar shows counts and starts on Changes`: `Changes 2` is bold and in brackets, `Issues 5` is dim.
  - `pressing the Issues tab fetches now and lists rows`: `press({ key: 'tab-issues' })`. Assert a `gh issue list` ran immediately, without waiting for the 60 s tick, and that `#42`, the title, `bug` and the age show.
  - `0 issues shows ✔ No open issues and never the repo name`: assert there's no element matching `/oscp-app-issues/`.
  - `100 issues: tab reads Issues 100+`.
  - `pressing an issue opens it with xdg-open, then open, then copies`: three runs of the fake process (xdg-open ok / xdg-open fails + open ok / both fail). Assert the argv sequence, and that the clipboard call happened in the last case. Use `mock` for `ui.copy` if the harness provides it, otherwise an `on('ui.copy', …)` fake.
  - `the issues error line renders in the Issues tab only`.
  - `issues-more opens the full issue list`: assert `https://github.com/fbandres/oscp-app-issues/issues`.
  - `a focused issue below the window scrolls into view`: raise focus with `$.ui.focus({ in: PLUGIN, element: 'issue-7' })`, or call the exported helper if the harness can't. Assert `#7` is visible and `↑ N above` shows.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Tab bar only when `detection.kind === 'detected'`. It goes in the row under the branch line: `<Button key="tab-changes">` and `<Button key="tab-issues">`, with the active one bold and in brackets, the other dimColor.
  - Issues count: `…` before the first fetch, `100+` when `isCapped`.
  - Pressing `tab-issues` sets `tab = 'issues'` and calls `void fetchIssues($, true)`.
  - Issues body: an error line (`color="error"`) when there's an error; `✔ No open issues` centred at 0; otherwise windowed rows via `windowOf(len, offsets.issues, room)`.
  - Each row is `<Button key={`issue-${n}`} onPress={p => openUrl($, url, p.surface)}>` containing the `head`, the title, a dim label, and a right-aligned age.
  - The `↓ N more` row becomes `<Button key="issues-more">` opening `https://github.com/${target}/issues`.
  - The footer time is the issues `updatedAt` on the Issues tab.
  - `on('ui.focus', { requestId: PANE }, …)`: when `e.element` matches `issue-(\d+)`, set `offsets.issues = followed(…)` for its index, nudge a redraw, and `return next(e)`.
  - Turning the tab off, or losing detection, resets `tab = 'changes'`.
- [ ] **Step 4:** Run the tests. Expected: all PASS.
- [ ] **Step 5:** Commit: `git commit -m "feat(git-changes): Changes / Issues tabs with clickable issue rows"`

---

### Task 8: `/changes issues` toggle, README, version, full check

**Files:**
- Modify: `hooks/register.tsx` (`toggle`, the command handlers)
- Modify: `README.md`, `.claude-plugin/plugin.json`
- Test: `hooks/register.test.ts`

**Interfaces:**
- Consumes: `detection`, `detectIssues`, `issuesTimer`, `tab` (Tasks 4, 6, 7).
- Produces: `async function toggleIssues($: Engine): Promise<{ text: string }>`.

- [ ] **Step 1: Write the failing tests** (pass `args: 'issues'` in a copy of `CHANGES`):
  - `/changes issues hides the tab and remembers it`: the reply is `Issues tab hidden.`, `store.issues === false`, no `tab-issues`, and the Changes list shows.
  - `/changes issues shows it again`: the reply is `Issues tab shown.` and the tab is back.
  - `turning it on without an issues repo explains why`: four cases, one reply for each of the four reasons in the copy list.
  - `turning it on while GitHub is down says it retries`.
  - `/changes ISSUES  (case, spaces) works; /changes foo replies usage`: the usage text is `Usage: /changes [issues]`, with the registered command name substituted.
  - `/git-changes issues works the same`.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3: Implement.** Branch the `command.run` handlers on `e.args.trim().toLowerCase()`: `''` → `toggle`, `'issues'` → `toggleIssues`, anything else → usage.
  - **Off:** set the store, `detection = { kind: 'off' }`, `tab = 'changes'`, `update(issues, () => null)`.
  - **On:** set the store, `await detectIssues($)` (awaited here, so the reply can say what happened), then reply from `detection.kind`.
- [ ] **Step 4:** Run the tests. Expected: all PASS.
- [ ] **Step 5: Docs and version.**
  - `plugin.json` `"version": "0.3.0"`. Add `and the project's open issues` to `description`.
  - README:
    - "What it does": Issues tab bullet points.
    - "Usage": `/changes issues`.
    - "How it works": gh commands, the 60 s rule, detection.
    - "Limits": needs `gh` logged in, github.com only, 100-issue cap. Remove "It's read-only: no staging…" only if it's no longer true (it still is; keep it).
    - Mention scrolling (wheel, PgUp/PgDn, arrows on issues).
- [ ] **Step 6:** Run `sh scripts/check.sh` from the repo root. Expected: every line `✔`, including `git-changes: Ran N tests`, `types check` and `leak scan clean`. The leak scan flags `/home/` and emails, so keep both out of the README and the tests.
- [ ] **Step 7:** Manual check: `claude --plugin-dir mods/git-changes` in a repo whose `-issues` sibling exists, and in one without. Check against the spec's ASCII mockups: the tabs, a click opening the browser, wheel/PgDn scrolling, and arrows following focus.
- [ ] **Step 8:** Commit: `git commit -m "feat(git-changes): /changes issues toggle; 0.3.0 docs"`
