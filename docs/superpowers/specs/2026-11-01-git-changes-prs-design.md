# git-changes 0.4.0: Pull requests tab

Date: 2026-11-01
Mod: `mods/git-changes` (currently 0.3.2)

## Why

The owner wants to see, from the Source Control pane, whether anything is waiting as a pull request: what's open, and which PRs are blocked (failing checks, changes requested), still drafts, or ready. Today that means leaving the terminal for github.com. The pane already shows changed files and, optionally, issues from a `<repo>-issues` repo. PRs go next to them as a third tab that works the same way the Issues tab does.

## Goals

1. A **PRs** tab listing **every open pull request on `origin`'s GitHub repo**, whoever opened it.
2. One **status mark** per row so a PR's state reads at a glance.
3. The **PRs tab count is coloured** by the worst state, so a failing PR is noticeable from the Changes tab.
4. **On by default** for any GitHub `origin`. `/changes prs` toggles it, and the choice is remembered on this machine, mirroring `/changes issues`.

## Non-goals

- Only the current branch's PR, or a header line for it. (Considered: "D. full tab + current-branch header". Rejected for now; it may come later.)
- Filtering to "mine" or "review requested". Your own PRs are only shown in bold.
- Checking out, merging, approving or commenting on PRs. The pane stays read-only.
- An inline detail view (individual checks, reviewers). Clicking opens the browser.
- PRs from the `-issues` repo, other remotes, or non-github.com hosts.

## Anti-goals (a failure even if it works)

- A slow or failing `gh pr list` delaying the session start, the pane opening, the git refresh, or the Issues fetch. PRs are extra.
- Polling GitHub faster than once per 60 s.
- A click that changes the working tree.
- Breaking the Issues tab or the Changes-only layout for non-GitHub repos.

## Behaviour

### Flow

```
 session start / pane opens / `/changes prs` turned on
          │
 store 'prs' === false ──► feature off: no PRs tab, no fetch
          │
 git remote get-url origin ── not github.com ──► no PRs tab (reason: origin is not a GitHub repo)
          │ github.com/<owner>/<repo>
 gh missing / logged out ──────────────────────► no PRs tab (reason given by /changes prs)
          │
 gh pr list -R <owner>/<repo> --state open --limit 100 \
   --json number,title,isDraft,reviewDecision,statusCheckRollup,author,updatedAt,url
          │
   ├─ as soon as the target is known
   ├─ every 60 s while the pane is placed
   └─ right away when the PRs tab is clicked
          │
 each PR → one mark (precedence below) → rows; worst mark → tab count colour
```

- Target is `<owner>/<repo>` from `origin`, parsed by the existing `parseRemote`. Unlike Issues, there is no repo-existence probe: the first `gh pr list` is the probe. `classifyGhFailure` decides: `logged-out` and `not-found` are definitive (no tab, reason kept); `temporary` keeps the tab with an error line and retries on the 60 s tick. **The tab appears only once the first fetch has answered** (no tab while it runs), so a logged-out or missing `gh` never makes a tab flash up and vanish. If the first fetch fails temporarily, the tab shows as `PRs …` with the error line. *(Builder's call, from the review.)*
- `gh` not installed (spawn fails) is definitive: no tab, reason `gh is not installed`.
- A repo whose name ends in `-issues` still gets a PRs tab (it is a real repo); only the Issues lookup skips it.
- **Logged-in user** for the bold "yours" rule: `gh api user --jq .login` once per session, in parallel with the first fetch. If it fails, nothing is bold; it is not retried.

### Fetching

Same rules as Issues, but independent of them:

- At most one PR fetch runs at a time. A request arriving mid-fetch is dropped, unless it came from a tab click, which queues exactly one more.
- Fire and forget into its own atom (`prs`). Never touches the status or issues atoms or the git timer.
- No redraw when the JSON is unchanged.
- Failure after a success: keep the last list and show one red line `GitHub: <first stderr line>` in the PRs tab. The next success clears it.
- Sort: by `updatedAt`, newest first, sorted client-side (`gh pr list` has no sort flag for this without `--search`; builder may use `--search "sort:updated-desc"` instead if it behaves the same).
- `--limit 100`. When 100 come back the tab reads `PRs 100+` and the list ends with a `↓ more` button opening `https://github.com/<owner>/<repo>/pulls`.

### Status mark per PR

One mark, the most urgent that applies, in this order:

| Mark | Colour | When |
|---|---|---|
| `D` | grey (dim) | `isDraft`. A draft always shows `D`, whatever its checks or reviews |
| `✗` | red | any check failed: CheckRun `conclusion` in `FAILURE, TIMED_OUT, CANCELLED, ACTION_REQUIRED, STARTUP_FAILURE`, or StatusContext `state` in `FAILURE, ERROR` |
| `R` | magenta | `reviewDecision === 'CHANGES_REQUESTED'` |
| `●` | yellow | any check still running: CheckRun `status` not `COMPLETED`, or StatusContext `state` in `PENDING, EXPECTED` |
| `✓` | green | there are checks and all passed (`SUCCESS`, `NEUTRAL`, `SKIPPED`) |
| *(blank)* | | no checks at all |

`statusCheckRollup` mixes CheckRun (`status`, `conclusion`) and StatusContext (`state`) items; handle both. Unknown values count as neither failed nor running. `reviewDecision` `APPROVED` gets no mark of its own (it shows as `✓` only if checks pass).

### Tab bar

- Order: **Changes · Issues · PRs**. Without an Issues tab: **Changes · PRs**. Without either: no tab bar (exactly as 0.3.2).
- **Change from 0.3.x:** a GitHub repo with no `-issues` repo now gets a tab bar (`[Changes 4]  PRs 3`) where it used to have none. This is the owner's choice (tab shows for any GitHub origin).
- Count: number of open PRs, `…` only after a temporary first-fetch failure, `100+` at the cap.
- **Count colour** (whether or not the PRs tab is active): red if any PR is `✗`, else magenta if any is `R`, else the tab's normal style. Drafts never colour the count; since a draft's mark is always `D`, this is simply the worst mark over all rows. Only the number is coloured, not the name.
- Narrow widths: `tabTexts` grows to three tabs and falls back `Changes/Issues/PRs` → `Chg/Iss/PR` → `C/I/P`.
- Each session starts on the Changes tab. If the PRs tab disappears (toggle off, definitive failure) while active, switch to Changes.

### PR rows

```
#12 Add dark theme                       ✓   2h
```

- `#number` (bold when `author.login` equals the logged-in user), title cut with `…`, the mark, and the age since `updatedAt` (existing `ageOf`), right-aligned.
- Narrow: the age drops first, then the title shrinks to its 12-column minimum; the mark always stays. Reuse or generalise `fitIssueRow`.
- Titles are cleaned with the same `plainText` sanitising as issue titles (control, bidi and zero-width characters).
- Each row is a `Button` with key `pr-<number>`. Click or Enter opens `url` with the existing `openUrl` (xdg-open / open, clipboard fallback).
- Empty: `✔ No open pull requests`, centred, as for issues.
- Scrolling, pinned header, focus-follows-arrows: identical to the Issues tab, with its own entry in `offsets` and `drawn`.

### `/changes prs`

Flips store key `prs` (default on), case-insensitive, and also works as `/git-changes prs`.

| Situation | Reply |
|---|---|
| turned off | `PRs tab hidden.` |
| turned on, fetch ok | `PRs tab shown.` |
| turned on, temporary failure | `PRs tab on; GitHub is unreachable right now, retrying every minute.` |
| turned on, definitive failure | `PRs tab on, but it can't be shown: <reason>.` Reasons: `origin is not a GitHub repo`, `gh is not installed`, `gh is not logged in (run: gh auth login)`, `<owner>/<repo> not found or no access`. |

Turning off hides the tab, stops fetches, and switches to Changes if PRs was active. The usage message for unknown arguments now lists `issues` and `prs`.

### Footer

On the PRs tab, `updated HH:MM:SS` is the time of the last successful PR fetch.

## Constraints

- Same structure as the Issues feature: pure logic (rollup → mark, worst mark, row fitting, JSON parsing, three-tab `tabTexts`) in a plain `.ts` module (e.g. `hooks/prs.ts`) with `prs.test.ts`; wiring and rendering in `register.tsx`. Share helpers with `issues.ts` instead of copying them (`parseRemote`, `plainText`, `ageOf`, `classifyGhFailure`, row fitting).
- `gh` remains the only external dependency, and optional.
- Existing tests keep passing; `register.test.ts` gains cases for the PRs tab, the toggle, the count colour, and the tab bar appearing for a GitHub repo without an issues repo.
- Types: `PullRequest` and `PrsState` in `types/index.d.ts`, and a `prs` atom key in `PluginState['git-changes']`.
- Version `0.4.0` in `.claude-plugin/plugin.json`, description mentions pull requests. README: the PRs tab, the marks table, `/changes prs`, the count colour, refresh rule in "How it works", the 100 cap in "Limits", and the note that GitHub repos now always show a tab bar.

## Decided by the owner

All open PRs on `origin` (not just the current branch's, not just mine) · shown as a tab, always for a GitHub origin, toggled by `/changes prs` · rows show number, title, one status mark, age; own PRs bold · click or Enter opens the browser, nothing else · the tab count is coloured by the worst state (red failing, magenta changes requested) · drafts never colour the count and always show `D`.

## Builder's calls (made during design, changeable)

- Mark precedence `D > ✗ > R > ● > ✓ > blank` (drafts first was the owner's call).
- Sorted by most recently updated; 100-PR cap with `100+` and a "more" row.
- Refresh, error handling and single-flight fetching copied from Issues (60 s while visible, plus on tab click).
- Tab order Changes · Issues · PRs; short names `Chg/Iss/PR`, then `C/I/P`.
- "Yours" = `author.login` matches `gh api user`.
- No separate existence probe: the first `gh pr list` decides whether the tab shows.

## Left to the builder

Exact atom/state shapes, module names, how `tabTexts` is generalised to N tabs, how much of the Issues wiring is shared versus parallel, and the exact wording of the usage line.
