# git-changes 0.3.0: Issues tab and review fixes

Date: 2026-10-31
Mod: `mods/git-changes` (currently 0.2.1)

## Why

The owner keeps each project's GitHub issues in a separate repo named after the project with an `-issues` suffix: the code lives in `fbandres/oscp-app` and its issues in `fbandres/oscp-app-issues`. They want to see a project's open issues next to its changed files, in the same Source Control pane, without leaving the terminal to look them up. Clicking an issue opens it on github.com, which is where they read the details.

The feature has to be optional and needs no setup: it appears on its own in projects that have an issues repo, can be turned off, and changes nothing in projects that don't have one.

## Goals

1. An **Issues** tab next to a **Changes** tab in the existing pane, listing the open issues of `<owner>/<repo>-issues`.
2. The issues repo is **auto-detected** from the `origin` remote. No configuration.
3. **On by default** when detected. `/changes issues` toggles it, and the choice is remembered on this machine.
4. **Long lists scroll**, with the header and footer pinned, on both tabs. This replaces today's dead-end `… N more`.
5. Fix four issues found in a review of 0.2.1 (see "Review fixes").

## Non-goals

- Reading issue bodies or comments in the pane. A click opens the browser. (A drill-down details view was considered and rejected.)
- Creating, closing, labelling or commenting on issues.
- Issues from the code repo itself, or from any repo not named `<repo>-issues`.
- Filtering (assigned to me, by label) or choosing the sort order.
- Non-GitHub remotes (GitLab, Bitbucket, GitHub Enterprise hosts).

## Anti-goals (a failure even if it works)

- Showing the issues repo's name in the pane. The owner explicitly does not want the `owner/repo-issues` line.
- A slow or failing GitHub call delaying the session start, the pane opening, or the git refresh. Issues are extra. Git status must never wait on them.
- Changing what the pane looks like in a project with no issues repo, or with the feature turned off. In both cases it must look exactly like 0.2.1, with no tab bar.
- Hammering GitHub. Never poll faster than once per 60 s.

## Behaviour

### Detection (once per session, and again when `/changes issues` turns it on)

```
store 'issues' === false ──► feature off: no detection, no tab
otherwise:
  git remote get-url origin
    ├─ https://github.com/<owner>/<repo>(.git)   ┐
    ├─ git@github.com:<owner>/<repo>(.git)       ├─► target = <owner>/<repo>-issues
    ├─ ssh://git@github.com/<owner>/<repo>(.git) ┘
    └─ no origin / other host ──► no tab
  gh repo view <target> --json name
    ├─ exit 0 ──► detected: show tab, start fetching
    └─ gh missing / not logged in / not found / no access ──► no tab
```

- If `<repo>` already ends in `-issues`, do not detect (`x-issues-issues` is never wanted).
- **Definitive vs temporary failure** *(builder's call)*: "no origin / other host", "gh is not installed", "gh is not logged in" (`gh auth status` fails) and "not found" (`gh repo view` stderr contains `Could not resolve to a Repository` / HTTP 404) are definitive: no tab, no retry this session. Anything else (offline, timeout, 5xx) is temporary: retry on the 60 s issues tick while the pane is placed, until it succeeds or fails definitively. The tab bar may then appear mid-session. While retrying, `/changes issues` replies `Issues tab on; GitHub is unreachable right now, retrying every minute.`
- Keep the detected target and the reason for a failed detection in module state. The reason is used by `/changes issues` (below).

### Fetching

```
gh issue list -R <target> --state open --search "sort:updated-desc" --limit 100 \
  --json number,title,labels,updatedAt,url
```

- When: as soon as detection succeeds, then every **60 s** while the pane is placed, and **immediately** when the person clicks the Issues tab. It stops while the pane is hidden, the same rule the git timer follows.
- At most one fetch runs at a time. A request that arrives mid-fetch is dropped, unless it came from a tab click: then one fetch is queued.
- A fetch never blocks: it is fired and forgotten, writes its result to its own atom, and never touches the git status atom or the git timer.
- No redraw when the JSON is unchanged (same idea as `lastRaw`).
- Failure after a successful detection: keep the last list on screen and show one red line, `GitHub: <first stderr line>`, in the Issues tab. The next successful fetch clears it.
- `--limit 100`. When 100 come back, the tab reads `Issues 100+`.

### `/changes issues`

`command.run` already receives `args`. `/changes` with no args behaves exactly as today. `/changes issues` (trimmed, case-insensitive) flips the store key `issues` (default on) and replies:

| Situation | Reply |
|---|---|
| turned off | `Issues tab hidden.` |
| turned on, detected | `Issues tab shown.` |
| turned on, not detected | `Issues tab on, but no issues repo was found: <reason>.` Reasons: `origin is not a GitHub repo`, `fbandres/x-issues not found or no access`, `gh is not installed`, `gh is not logged in (run: gh auth login)`. |

Turning it off hides the tab right away, stops issue fetches, and switches to the Changes tab. Turning it on runs detection again. The fallback command `/git-changes issues` works the same way. Any other argument replies with a one-line usage message.

### Tabs

- The tab bar appears only when the issues repo is detected and the feature is on. Otherwise the pane renders exactly as 0.2.1.
- The bar is the second row, under the branch line: `[Changes 40]  Issues 63`. The active tab is in brackets and bold, the other dim. Both are `Button`s, so they can be clicked or focused and pressed with Enter.
- Changes tab count = number of changed files. Issues tab count = number of open issues (`100+` at the cap). The count shows as soon as detection succeeds, `Issues …` until the first fetch returns.
- Each session starts on the Changes tab. The active tab is not remembered.
- With 0 open issues the tab stays (`Issues 0`) and its body shows `✔ No open issues`, centered, the same way `✔ Working tree clean` shows. The repo name is never shown.

### Issues tab rows

```
#42 Login fails on Safari  bug  2h
```

- `#number`, title (cut with `…` to fit), the first label's name (dim, cut to 10 columns, nothing when unlabelled), and the age since `updatedAt` (`now`, `5m`, `2h`, `3d`, `2w`, `4mo`, `1y`), right-aligned like the line counts.
- The whole row is a `Button` (owner's decision). A plain click, or Enter while the row has focus, opens the issue's `url` in the browser through the platform opener: `$.process.run(['xdg-open', url])` on Linux, `['open', url]` on macOS (pick by `process.platform` / `$.env`, builder's call). If the opener fails, copy the URL with `$.ui.copy` as a fallback. Not a `Link`: OSC 8 links need Ctrl/Cmd+click, can't be reached with the keyboard, and print the URL inline in terminals without link support.
- A narrow pane drops the label first, then the age, the same way the counts drop today.

### Pinned header, scrolling list (both tabs)

```
┌─ Source Control ───────────────────┐
│ ⎇ main ●                    ▲ 1    │  pinned
│ [Changes 40]  Issues 63            │  pinned (only when the tab bar shows)
│ +812 -204                 40 files │  pinned (Changes tab, when dirty)
│────────────────────────────────────│  pinned
│ ↑ 14 above                         │  ┐ only when rows are hidden above
│  …visible slice of the list…       │  │ scrolls
│ ↓ 19 more                          │  ┘ only when rows are hidden below
│────────────────────────────────────│  pinned
│ updated 14:02:11 · /changes        │  pinned
└────────────────────────────────────┘
```

- The mod draws only the visible slice `list.slice(offset, offset + room)`. `room` is `scroll.bodyRows` minus the pinned rows and minus one row for each `↑`/`↓` marker that shows.
- **Wheel and PgUp/PgDn** scroll the list. The mod intercepts `ui.scroll` for its pane (`component: 'Pane', requestId: 'git-changes'`): it applies `e.by` to its own offset for the active tab, clamps it to `[0, max(0, length - room)]`, and passes the event on with the engine's `offset` pinned at 0 so the body itself never moves. Then it redraws. A wheel tick over the header is ignored (`e.pointer.row` outside the list rows).
- **Arrow keys move the focus** (owner's decision). The tabs and the Issues rows are `Button`s, so arrows move the engine's focus ring between them. The mod listens to `ui.focus` and, when the focused row falls outside the visible slice, moves the offset just enough to bring it into view (like `block: 'nearest'`). For that, each Issues row `Button` gets a stable `key` (`issue-<number>`). Changes rows are not buttons: on the Changes tab only the tab buttons take focus, and the list scrolls by wheel and PgUp/PgDn only.
- Each tab keeps its own offset in module state. When a list shrinks (files committed, issues closed), the offset is clamped so the window is never empty past the end.
- On the Issues tab, the `↓ N more` row is also a `Button` that opens `https://github.com/<target>/issues` the same way rows do.
- **Risk, checked first:** the API says the engine scrolls "while it has rows to scroll", so a slice that fits the body may not raise `ui.scroll` for the wheel or PgUp/PgDn, and arrows may not raise `ui.focus` across a slice that changes. The first build step is a throwaway spike that checks (a) wheel and PgUp/PgDn reach the `ui.scroll` hook when the drawn tree fits the body, and (b) arrowing past the last visible row raises `ui.focus` so the slice can follow. If (a) fails, try drawing the tree one row taller than the body (a blank row) so the engine always has rows to scroll. If that also fails, stop and ask the owner before falling back to "the whole body scrolls natively".

### Footer

Unchanged except for review fix 4: `updated HH:MM:SS · /<command>`. On the Issues tab the time is that of the last successful issue fetch.

## Review fixes (bundled into 0.3.0)

1. **Untracked line counts re-read every 2 s.** `untrackedStats` reads up to 50 files × 256 KB from disk one after another on every tick. Cache counts by path, keyed on `size` + `mtimeMs` from the `stat` it already calls, and only read files whose key changed. Drop cache entries for paths no longer listed.
2. *(covered by the scrolling section: rows past the pane height were unreachable.)*
3. **`/changes` waits for git before opening.** `show()` awaits `refresh()` before `ui.open`. Open first and refresh after, as `showOnStart` does (keep `lastRaw = undefined` so it redraws).
4. **Footer always says `/changes`.** Remember which name `registerCommand` actually registered and print that.
5. **Post-edit refresh dropped mid-refresh.** When `refresh()` is asked while `isChecking`, set a `pending` flag. When the running refresh finishes, run once more if it is set. Never queue more than one.

## Constraints

- Plugin API only (`$.process.run`, `$.fs`, `$.store`, atoms, `ui.render`, `ui.scroll`, `command.run`), the same style and module layout as 0.2.1. Pure logic (remote URL parsing, gh JSON parsing, age formatting, row fitting, offset clamping) goes in plain `.ts` files with unit tests, as `status.ts` and `theme.ts` do today. Rendering and wiring stay in `register.tsx`.
- `gh` is the only dependency added, and it is optional: without it the feature quietly has no tab.
- Must keep passing the existing tests. New pure functions get tests in the same style (`*.test.ts` next to the file).
- Version bump to `0.3.0` in `.claude-plugin/plugin.json`. README updated: the Issues tab, `/changes issues`, the `gh` requirement, scrolling, the 100-issue cap, and the new refresh rule in "How it works".
- Types: extend `types/index.d.ts` with an `Issue` type and a new atom key (for example `issues`) in the `PluginState['git-changes']` declaration.

## Decided by the owner

Tabs in one pane · the tab shows even with 0 issues, and the repo name is never shown · a click opens the browser, no in-pane details · all open issues, most recently updated first · auto-on with a `/changes issues` toggle, remembered on this machine · refresh every 60 s while visible plus on tab click · pinned header with a scrolling list, spike first · all review fixes in the same release · issue rows open on a plain click or Enter (buttons, not terminal links) · arrows move focus and the list follows, wheel and PgUp/PgDn scroll.

## Builder's calls (made during design, changeable)

- Uses `gh` (handles auth and private repos), not `$.http.fetch` with a token.
- Detection happens once per session. A repo created mid-session shows up next session or after `/changes issues` off/on.
- Row content: number, title, first label, age. The label is dropped first when narrow.
- The cap is 100 issues, shown as `100+`.
- Each session starts on the Changes tab.
- The last list stays up with one error line when a fetch fails.
- Only `github.com` remotes are recognised. `origin` is the only remote consulted.
- Temporary detection failures (offline, timeout, 5xx) retry every 60 s. Definitive ones (not found, gh missing or logged out, non-GitHub origin) don't.
- If the browser opener fails, the URL is copied to the clipboard instead.

## Left to the builder

Exact atom/state shape, file names for the new pure modules, the exact spelling of usage and error replies (within the table above), and the spike's mechanics.
