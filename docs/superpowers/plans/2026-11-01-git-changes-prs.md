# git-changes 0.4.0 (PRs tab) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a PRs tab to the git-changes pane. It lists every open pull request on `origin`, gives each row a status mark, and colours the tab count by the worst ready PR. `/changes prs` toggles the tab.

**Architecture:** Pure logic goes in new plain modules with unit tests, as Issues did: `prs.ts` (gh JSON → `PullRequest`, marks, row fitting) and `tabs.ts` (the tab bar's text, generalised from `issues.ts` to three tabs). `register.tsx` gets a third atom (`prs`), a PR source state machine beside the Issues `Detection`, a single-flight `fetchPrs` driven by the existing 60 s GitHub timer, the `/changes prs` toggle, and a PRs tab body that shares one renderer with the Issues tab.

**Tech Stack:** TypeScript + JSX against the `claude-code` plugin API. Tests use `claude-code/testing` (`claude plugin test`). GitHub is reached through the `gh` CLI via `$.process.run`.

**Spec:** `docs/superpowers/specs/2026-11-01-git-changes-prs-design.md`. Read it before any task. The mark table, the replies and the copy are defined there.

## Global Constraints

- Paths are relative to `mods/git-changes/` unless they start with `docs/`.
- Plugin API only, no npm dependencies. `gh` stays optional: without it there is no PRs tab and nothing breaks.
- Target is `<owner>/<repo>` from `origin` (existing `parseRemote`), github.com only. A repo ending in `-issues` still gets PRs.
- Fetch: `gh pr list -R <owner>/<repo> --state open --limit 100 --json number,title,isDraft,reviewDecision,statusCheckRollup,author,updatedAt,url`. Sort by `updatedAt` newest first, client-side.
- Login: `gh api user --jq .login`, once per session. On failure nothing is bold and the call is not retried.
- PR refresh runs on the existing 60 000 ms GitHub tick while the pane is placed, and immediately on a PRs tab press. Never faster.
- PR work never delays the session start, the pane opening, the git refresh or the Issues fetch. Fire and forget it everywhere except inside `/changes prs`.
- The tab appears only after the first `gh pr list` answers. A definitive first failure (logged out, not found, gh missing) means no tab and no retry this session.
- Mark precedence: `D > ✗ > R > ● > ✓ > ''`. Colours: `✗` `error`, `R` `merged` (the theme's magenta, already used for `!`), `●` `warning`, `✓` `success`, `D` `dimColor`.
- The count is coloured by the worst mark over all rows: `error` if any `✗`, else `merged` if any `R`. Drafts always mark `D`, so they never colour it.
- Store key `prs` (boolean, default on). Keys `shown` and `issues` are unchanged.
- Tab order Changes · Issues · PRs. Names `Changes/Issues/PRs`, then `Chg/Iss/PR`, then `C/I/P`.
- Copy (verbatim): `PRs tab hidden.` · `PRs tab shown.` · `PRs tab on; GitHub is unreachable right now, retrying every minute.` · `PRs tab on, but it can't be shown: <reason>.` · `✔ No open pull requests` · `Usage: /<command> [issues|prs]` · error line `GitHub: <first stderr line>` · `GitHub: unexpected reply from gh` · `GitHub: gh could not be run`.
- Reasons (verbatim): `origin is not a GitHub repo` · `gh is not installed` · `gh is not logged in (run: gh auth login)` · `<owner>/<repo> not found or no access`.
- Version `0.4.0`.
- Run the tests: `claude plugin test mods/git-changes` from the repo root. Full check: `sh scripts/check.sh`.

## Review Focus

1. **A logged-out or missing `gh` on a GitHub repo.** No tab ever flashes, and Changes looks as it did in 0.3.2. Test in Task 3 (`a logged-out gh never shows a PRs tab`).
2. **A mixed `statusCheckRollup`** with CheckRun and StatusContext items, null `conclusion` while running, and unknown states. Unknown counts as neither failed nor running. Test in Task 1 (`markOf` cases).
3. **`/changes prs` turned off while the first fetch is still running.** The late answer must not bring the tab back. Test in Task 3 (generation counter).
4. **A narrow pane (bodyColumns 24) with three tabs and long PR titles.** The tab bar stays on one row, the mark never drops, and the age drops before the title goes under 12 columns. Tests in Task 1 (`fitPrRow`) and Task 2 (`tabTexts` widths).
5. **The PRs tab is active when it disappears** (toggled off, or the list fails after a success). It switches to Changes only when the tab goes away. A fetch error keeps the tab and the last list. Test in Task 4.

---

### Task 1: `prs.ts`: parse, mark, fit

**Files:**
- Create: `hooks/prs.ts`, `hooks/prs.test.ts`
- Modify: `hooks/issues.ts` (export `plainText`), `types/index.d.ts`

**Interfaces:**
- Consumes: `parseRemote`, `plainText` (now exported), `ageOf` from `issues.ts`; `cutTo`, `widthOf` from `text.ts`.
- Produces (types, in `types/index.d.ts`):
  ```ts
  export type PrMark = 'D' | '✗' | 'R' | '●' | '✓' | ''
  export type PullRequest = { number: number; title: string; author: string; mark: PrMark; updatedAt: string; url: string }
  export type PrsState = { prs: PullRequest[]; isLoaded: boolean; isCapped: boolean; error?: string; updatedAt: number }
  // PluginState['git-changes'] gains: prs: PrsState | null
  ```
- Produces (in `prs.ts`):
  - `PRS_LIMIT = 100`
  - `prsRepoOf(url: string): string | undefined`: `owner/repo`, or undefined for a non-GitHub remote.
  - `markOf(pr: { isDraft?: boolean; reviewDecision?: string | null; statusCheckRollup?: readonly unknown[] | null }): PrMark`
  - `parsePrs(json: string): PullRequest[]`: throws on non-JSON, sorts newest `updatedAt` first, cleans titles with `plainText`, sets `author` to `author.login ?? ''`.
  - `worstMark(prs: readonly PullRequest[]): '✗' | 'R' | undefined`
  - `MARK_COLOR: Record<'✗' | 'R' | '●' | '✓', string>`: `{ '✗': 'error', R: 'merged', '●': 'warning', '✓': 'success' }`
  - `fitPrRow(pr: PullRequest, width: number, age: string): { head: string; title: string; age: string }`: `head` is `#N `. Two columns are always reserved for the mark and a space; the age drops when `head + 12 + 2 + age + 1 > width`; the title is cut with `…`.

- [ ] **Step 1: Write the failing tests** in `hooks/prs.test.ts`:
  - `prsRepoOf`: `https://github.com/fbandres/ccmods.git` → `fbandres/ccmods`. `…/ccmods-issues.git` → `fbandres/ccmods-issues`. A gitlab URL → `undefined`.
  - `markOf`, one `expect` per case:
    - `{isDraft:true, statusCheckRollup:[{conclusion:'FAILURE',status:'COMPLETED'}]}` → `'D'`
    - a failed CheckRun (`FAILURE`, `TIMED_OUT`, `CANCELLED`, `ACTION_REQUIRED`, `STARTUP_FAILURE`) → `'✗'`
    - a StatusContext `{state:'ERROR'}` → `'✗'`
    - `reviewDecision:'CHANGES_REQUESTED'` with passing checks → `'R'`
    - `CHANGES_REQUESTED` with a failure → `'✗'`
    - `{status:'IN_PROGRESS', conclusion:null}` → `'●'`
    - `{state:'PENDING'}` → `'●'`
    - `{state:'EXPECTED'}` → `'●'`
    - all of `SUCCESS`, `NEUTRAL`, `SKIPPED` → `'✓'`
    - `statusCheckRollup: []` or `null` → `''`
    - `APPROVED` with no checks → `''`
    - one `{conclusion:'WEIRD', status:'COMPLETED'}` beside a `SUCCESS` → `'✓'`
    - only unknown items → `''`
  - `parsePrs`: two PRs given oldest first come back newest first. The title `'Fix\nscroll‮ 🧭'` becomes `'Fix scroll 🧭'`. `author: {login:'alice'}` gives `'alice'`, and a missing author gives `''`. `mark` is filled in. `parsePrs('nope')` throws.
  - `worstMark`: `[✓, R]` → `'R'`, `[R, ✗]` → `'✗'`, `[D, ✓]` → `undefined`, `[]` → `undefined`.
  - `fitPrRow`:
    - Width 50: `#12 `, the full title, and age `2h`.
    - Width 24, 40-column title: the age is `''`, the title ends `…`, and `head + widthOf(title) + 2 <= 24`.
    - Width 30: the age is kept when it fits beside a 12-column title.
- [ ] **Step 2: Run** `claude plugin test mods/git-changes`. Expected: `prs.test.ts` fails, unable to resolve `./prs`.
- [ ] **Step 3: Implement** the types and `prs.ts` with the signatures above. Export `plainText` from `issues.ts` without changing it. A rollup item is a StatusContext when it has `state`, otherwise a CheckRun (`status`, `conclusion`).
- [ ] **Step 4: Run** the tests. Expected: all pass, the existing ones included.
- [ ] **Step 5: Commit** `git add hooks/prs.ts hooks/prs.test.ts hooks/issues.ts types/index.d.ts && git commit -m "feat(git-changes): parse PRs and their status marks"`

### Task 2: `tabs.ts`: tab bar text for up to three tabs

**Files:**
- Create: `hooks/tabs.ts`, `hooks/tabs.test.ts`
- Modify: `hooks/issues.ts` (remove `tabTexts` and `TAB_NAMES`), `hooks/issues.test.ts` (move the `tabTexts` test), `hooks/register.tsx` (import from `./tabs`, render the pieces)

**Interfaces:**
- Produces:
  ```ts
  export type TabId = 'changes' | 'issues' | 'prs'
  export type TabText = { before: string; count: string; after: string }
  export function tabTexts(width: number, counts: { changes: string; issues?: string; prs?: string }, active: TabId): Partial<Record<TabId, TabText>>
  ```
  A tab is present when its count is defined. The active tab reads `[` + name + ` ` | count | `]`, an inactive one ` ` + name + ` ` | count | ` `. Try the full names, then the short ones, then letters; take the first set where the texts plus one space between each fit `width`, else the letters.

- [ ] **Step 1: Write the failing tests** in `hooks/tabs.test.ts`. Port the four existing `tabTexts` expectations with the old strings rebuilt as `before + count + after`. For example, `tabTexts(40, {changes:'2', issues:'5'}, 'changes').changes` → `{before:'[Changes ', count:'2', after:']'}`. Add:
  - `tabTexts(40, {changes:'2', prs:'3'}, 'prs')` gives two tabs, no `issues` key, and `prs` joins to `'[PRs 3]'`.
  - `tabTexts(40, {changes:'2', issues:'5', prs:'3'}, 'changes')` joins to `'[Changes 2]'`, `' Issues 5 '`, `' PRs 3 '`.
  - At width 26 with counts `'40'`, `'63'`, `'7'`: the short names, `' PR 7 '`.
  - At every width in `[20, 22, 24, 26, 30]` with `'1234'`, `'100+'`, `'100+'`: the joined lengths plus 2 are `<= width`.
- [ ] **Step 2: Run** the tests. Expected: `tabs.test.ts` fails, unable to resolve `./tabs`.
- [ ] **Step 3: Implement** `tabs.ts`. Delete `tabTexts`/`TAB_NAMES` from `issues.ts` and their test from `issues.test.ts`. In `register.tsx`, type `Tab` as `TabId` and render each tab button as `<Text bold|dimColor>{before}<Text>{count}</Text>{after}</Text>`. Still pass only `changes` and `issues` here; PRs arrive in Task 4.
- [ ] **Step 4: Run** the tests. Expected: all pass, `register.test.ts` included. If `find({ text: /^\[Changes 2\]$/ })` no longer matches because the count is now its own `Text`, match the outer button's text the way the testing API reports nested text, and record the change in the commit message. Don't change what the person sees.
- [ ] **Step 5: Commit** `git add hooks/tabs.ts hooks/tabs.test.ts && git commit -am "refactor(git-changes): tab bar text for up to three tabs"`

### Task 3: Fetching PRs, the PR source, `/changes prs`

**Files:**
- Modify: `hooks/register.tsx`, `hooks/register.test.ts`

**Interfaces:**
- Consumes: `prsRepoOf`, `parsePrs`, `PRS_LIMIT` (Task 1); `classifyGhFailure` (existing).
- Produces (module state in `register.tsx`, used by Task 4):
  ```ts
  const prs = atom({ plugin: 'git-changes', key: 'prs' } as const, null as PrsState | null)
  type PrSource = { kind: 'off' } | { kind: 'none'; reason: string } | { kind: 'pending'; target: string } | { kind: 'ready'; target: string }
  let prSource: PrSource
  let me: string | undefined                      // gh login, for bold rows
  async function findPrs($: Engine): Promise<void> // store check → origin → pending → login (not awaited) + first fetch (awaited)
  async function fetchPrs($: Engine, isUrgent?: boolean): Promise<void>
  ```
- Behaviour of `fetchPrs` (runs only while `pending` or `ready`; single-flight with its own `isFetchingPrs`/`prsQueued`; a `prsRun` generation counter is bumped by `findPrs` and by turning PRs off, and a stale answer is dropped):
  - Exit 0 → `ready`. Parse it: a throw sets the error `GitHub: unexpected reply from gh`. An unchanged raw output skips the write while the atom isn't null. Otherwise write `{ prs, isLoaded: true, isCapped: prs.length >= PRS_LIMIT, updatedAt: Date.now() }`.
  - Non-zero exit: failure = exit 4 → `logged-out`, else `classifyGhFailure(stderr)`.
    - While `pending`, a definitive failure → `none`, with reason `gh is not logged in (run: gh auth login)` or `<target> not found or no access`.
    - Otherwise (temporary, or already `ready`) → `ready`, keeping the last list (or `{prs: [], isLoaded: false, …}`), with error `GitHub: <first stderr line>`.
  - Spawn rejects: probe `gh --version` with `timeoutMs: 5000`, the way `detectIssues` does.
    - Missing while `pending` → `none` / `gh is not installed`.
    - Missing once `ready` → error `GitHub: gh could not be run`.
    - Present → treated as temporary.
- Wiring:
  - `session.start` calls `void findPrs($)` next to `detectIssues`, under the same `isGit && e.isInteractive` guard.
  - `issuesTick` becomes `githubTick` and also calls `fetchPrs` when `ready`.
  - `runCommand` handles `prs` via `togglePrs`; the usage line becomes `[issues|prs]`.
  - `togglePrs` mirrors `toggleIssues`. Off: bump `prsRun`, `prSource = off`, null the atom, switch `tab` to changes if it was `prs`, redraw. On: `await findPrs($)`, then reply from the table. `pending` can't remain after an awaited `findPrs`.

- [ ] **Step 1: Extend the fake** in `register.test.ts`. Add to `Gh`: `prs?: string` (default `'[]'`), `prsError?: string`, `prsExit?: number`, `prsGate?: Promise<void>`, `login?: string` (default `'fbandres'`, `apiError` makes `gh api` fail). In `answerGh`: `argv[1] === 'pr'` answers from these (`loggedOut` → exit 4 with the logged-out text); `argv[1] === 'api'` answers the login. Add `prsJson(specs: Array<Partial<{number, title, isDraft, reviewDecision, checks, login, updatedAt}>>)` and `watchPrs(on)`, the same way `issuesJson`/`watchIssues` work.
- [ ] **Step 2: Write the failing tests:**
  - `PRs are fetched after start with the agreed argv`: one `gh pr list` argv equals the Global Constraints command for `fbandres/oscp-app`. `watchPrs` holds 2 PRs with `isLoaded: true`.
  - `the PR fetch never delays the pane`: with `prsGate` held, `/changes` still opens and git rows render. Release the gate.
  - `a logged-out gh never shows a PRs tab`: `prSource` ends `none`, the atom stays null, and after `clock.advance(60_000)` there is no second `gh pr list`.
  - `no gh: no PRs fetch and no tab` (the existing `{}` git config).
  - `a first fetch that fails temporarily keeps retrying`: `prsError: 'error connecting to api.github.com'` gives the error `GitHub: error connecting to api.github.com` and `isLoaded: false`. After the tick, with `prs` restored, the error is gone and `isLoaded: true`.
  - `a fetch failure after success keeps the last list`.
  - `PRs refresh every 60s only while placed` (mirror the Issues test).
  - `store prs=false never calls gh pr`.
  - `/changes prs hides and remembers, then shows`, with the replies `PRs tab hidden.` and `PRs tab shown.` and `store.prs` false, then true.
  - Parametrised `turning PRs on with <why> says why` for the four reasons, plus `turning PRs on while GitHub is down says it retries`.
  - `turning PRs off during the first fetch keeps them off`: hold `prsGate`, toggle off, release, settle. The source is `off` and the atom is null.
  - `/changes PRS with spaces works; the usage line lists both`: `Usage: /changes [issues|prs]`. `/git-changes prs` works the same.
  - `the login is read once per session`: there is exactly one `gh api` call after two ticks.
- [ ] **Step 3: Run** the tests. Expected: the new tests fail. Some existing tests will also fail only because a GitHub fake now answers `gh pr` or the usage line changed (for example `store issues=false skips detection entirely`, which counts every gh call, and the usage tests). Fix those by filtering to the gh subcommand they mean or by setting `prs: false` in their store. Never weaken an assertion about Issues or Changes. List each one you touch in the commit message.
- [ ] **Step 4: Implement** the state, `findPrs`, `fetchPrs`, the tick, the toggle and the command, as specified above.
- [ ] **Step 5: Run** the tests. Expected: all pass.
- [ ] **Step 6: Commit** `git commit -am "feat(git-changes): fetch open PRs and /changes prs"`

### Task 4: The PRs tab: tab bar, rows, count colour, focus

**Files:**
- Modify: `hooks/register.tsx`, `hooks/register.test.ts`

**Interfaces:**
- Consumes: `tabTexts`/`TabId` (Task 2), `prs`, `prSource`, `me`, `fetchPrs` (Task 3), `fitPrRow`, `worstMark`, `MARK_COLOR` (Task 1).
- Produces: the PR row button keys `pr-<number>`, `prs-more` and `tab-prs`, used in the tests.

Decisions:
- `hasTabs = detection.kind === 'detected' || prSource.kind === 'ready'`. Only present tabs get buttons. A render that finds `tab` pointing at an absent tab sets it back to `changes`.
- The PRs count is `'…'` while `!isLoaded`, `100+` when capped, otherwise the length. Its count `Text` gets `color={worst === '✗' ? 'error' : worst === 'R' ? 'merged' : undefined}`, active or not.
- Pressing `tab-prs` sets the tab, clears the focused row, redraws and calls `fetchPrs($, true)`.
- Extract the Issues body (error line, reading or empty line, `↑ above`, rows, `↓ more` button, divider, footer) into one helper that both tabs use. It is parameterised by items, key prefix, more key, more URL, empty text, reading text and a row renderer. The Issues output must not change.
- PR row: `<Button key={`pr-${n}`}>`. Its `head` is bold when `me && pr.author === me`, followed by title and padding, then the mark (`D` is `dimColor`; others take `MARK_COLOR`; an empty mark draws a space), a space, and the age. The empty text is `✔ No open pull requests`. The more URL is `https://github.com/<target>/pulls`. The footer time comes from `PrsState.updatedAt`.
- `offsets`, `drawn` and the focus hook gain `prs`. Generalise `focusedIssue` to `focusedRow` and the `ui.focus` hook to the active list. For Issues that is `issue-`, `issues-more`, `tab-issues`; for PRs, `pr-`, `prs-more`, `tab-prs`. The Changes tab keeps returning `next(e)`.

- [ ] **Step 1: Write the failing tests:**
  - `a GitHub repo with no issues repo shows Changes and PRs tabs` (`gh: { repo: 'missing', prs: prsJson([{},{},{}]) }`): `[Changes 2]` and ` PRs 3 ` are present, `tab-issues` is absent, and the `CHANGES` label is gone because the tab says it.
  - `three tabs in order` with an issues repo and PRs.
  - `pressing the PRs tab fetches at once and lists PRs newest first`. The rows `#12 `, title and age are present, and `package-lock.json` is gone.
  - `marks are drawn and coloured`: one PR each of draft-failing, failing, changes requested, running, passing and no checks. The mark texts are `D`, `✗`, `R`, `●`, `✓`; the colours are `error`, `merged`, `warning`, `success`; `D` has `dimColor`.
  - `the count is red when a ready PR fails, magenta for changes requested, plain otherwise`. With a failing draft only, it is plain. Check from the Changes tab.
  - `my PRs have a bold number` (`login: 'fbandres'`, one PR by `fbandres`, one by `alice`). With `apiError`, nothing is bold.
  - `0 PRs shows No open pull requests`.
  - `pressing a PR opens it`, which runs `xdg-open` with its url.
  - `the more row under a long PR list opens /pulls` (bodyRows small, 30 PRs).
  - `arrowing past the last visible PR scrolls the list` (mirror the Issues focus test).
  - `turning PRs off while on the PRs tab returns to Changes`, and `a fetch error keeps the PRs tab and its rows, with the error line`.
  - `a narrow pane (bodyColumns 24) keeps three tabs on one row and every PR mark visible`.
  - The existing Issues render tests pass unchanged, apart from the Task 3 notes.
- [ ] **Step 2: Run** the tests. Expected: the new tests fail.
- [ ] **Step 3: Implement** the decisions above.
- [ ] **Step 4: Run** the tests. Expected: all pass.
- [ ] **Step 5: Commit** `git commit -am "feat(git-changes): PRs tab with status marks and a coloured count"`

### Task 5: Version, README, full check

**Files:**
- Modify: `.claude-plugin/plugin.json`, `README.md`

- [ ] **Step 1: Bump** `plugin.json` to `"version": "0.4.0"`, with description `Live Source Control pane: the repo's changed files, open pull requests and the project's open issues, toggled with /changes`.
- [ ] **Step 2: Update the README:**
  - The intro mentions PRs.
  - "What it does" gets a **PRs tab** bullet: all open PRs on origin, newest first, the number, title, mark and age, your own PRs in bold, click or Enter to open.
  - Add the marks table from the spec, with drafts always `D`.
  - Explain the coloured count.
  - "Usage" adds `/changes prs`.
  - "How it works" adds the `gh pr list` call, `gh api user` once, the 60 s refresh and the immediate fetch on a tab press.
  - "Limits" adds the 100-PR cap (`PRs 100+`) and notes that GitHub repos now show a tab bar even without an issues repo.
- [ ] **Step 3: Run** `sh scripts/check.sh` from the repo root. Expected: every line `✔`, including `git-changes: Ran N tests` and the type check.
- [ ] **Step 4: Commit** `git commit -am "git-changes 0.4.0: PRs tab"`
