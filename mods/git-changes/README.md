# git-changes

A live Source Control pane for Claude Code: see which files changed, and by how much, without running `git status`. On GitHub repos it also lists the open pull requests, and if the project keeps its GitHub issues in a `<repo>-issues` repo, the pane shows those too.

<img src="screenshot.png" alt="git-changes pane on the PRs tab" width="404">

## What it does

- Lists every changed file in the current repo, with a status letter: `M` modified, `A` added, `D` deleted, `R` renamed, `U` untracked, `!` conflict.
- Shows lines added (`+N`, green) and removed (`-N`, red) per file and in total. Binary files show `bin`.
- Colours file names by status, and strikes through deleted files.
- Shows the branch, a `●` when the tree is dirty, and a blue `▲ 1` / yellow `▼ 2` when you have unpushed or unpulled commits.
- Refreshes right after Claude edits files, and every 2 seconds while the pane is visible.
- Long lists scroll under a pinned header: mouse wheel, or PgUp/PgDn once the pane is focused.
- **Issues tab (optional, automatic).** When `origin` is `github.com/<owner>/<repo>` and a repo named `<owner>/<repo>-issues` exists, a `[Changes 3]  Issues 5` tab bar appears. The Issues tab lists the open issues, most recently updated first, with number, title, first label and age. Click an issue, or arrow to it and press Enter, to open it in your browser. With no such repo, there is no Issues tab.
- **PRs tab (automatic on GitHub).** When `origin` is `github.com/<owner>/<repo>`, a `PRs 3` tab lists every open pull request on that repo, whoever opened it, most recently updated first: number, title, one status mark and age. Your own PRs have a bold number. Click a PR, or arrow to it and press Enter, to open it in your browser.
- **The PRs count warns you.** It turns red when a ready PR has failing checks, and magenta when a PR has changes requested, so you notice from the Changes tab. Drafts never colour it.

| Mark | Meaning | Colour |
|---|---|---|
| `D` | Draft (always, whatever its checks) | dim |
| `✗` | A check failed | red |
| `R` | Changes requested | magenta |
| `●` | Checks still running | yellow |
| `✓` | All checks passed | green |
| *(blank)* | No checks | |

With no GitHub `origin` (or no `gh`), the pane has no tabs and looks as it always did.

## Install

Give your coding agent this prompt:

```
Read https://github.com/fbandres/ccmods/blob/main/SETUP.md
and install the git-changes mod for me.
```

Or install it yourself:

```
/plugin marketplace add fbandres/ccmods
/plugin install git-changes@ccmods
/reload-plugins
```

## Usage

- `/changes` shows or hides the pane. The choice is remembered on this machine for future sessions.
- `/changes issues` turns the Issues tab off, or on again (remembered on this machine). When it can't show the tab, it says why: no GitHub origin, no `-issues` repo, `gh` not installed, or `gh` not logged in.
- `/changes prs` turns the PRs tab off, or on again (remembered on this machine). When it can't show the tab, it says why: no GitHub origin, `gh` not installed, `gh` not logged in, or the repo not found.
- If a future Claude Code built-in ever takes `/changes`, the mod registers `/git-changes` instead, which does the same.

## How it works

- **Refresh:** after `Edit`, `Write` and `Bash` tool calls, every 2 s while the pane is placed, and when it opens.
- **Issues:** `gh repo view <owner>/<repo>-issues` once per session finds the repo, then `gh issue list --state open --search "sort:updated-desc" --limit 100` runs as soon as the repo is found, every 60 s while the pane is visible, and right away when you click the Issues tab. If GitHub is unreachable at start, it tries again every minute. A failed fetch keeps the last list and shows the error in the tab.
- **PRs:** `gh pr list -R <owner>/<repo> --state open --limit 100 --json number,title,isDraft,reviewDecision,statusCheckRollup,author,updatedAt,url` runs at start, every 60 s while the pane is visible, and right away when you click the PRs tab. The tab appears once that first call answers. `gh api user` runs once per session to know which PRs are yours. A failed fetch keeps the last list and shows the error in the tab.
- **Git:** three calls run in parallel, all with `--no-optional-locks` so they never block your own `git commit`:
  `git status --porcelain=v2 -b -z -uall`, `git diff --numstat -z` and `git diff --cached --numstat -z`.
- **New files:** git has no diff for them, so their lines are counted from disk (up to 50 files, 256 KB each). A file containing a NUL byte counts as binary.
- **One row per file:** when a file has both staged and unstaged changes, the most significant letter wins, `! > D > A > R > M > U`.
- **Cheap redraws:** nothing redraws while git's output and the new-file counts are unchanged.

| Letter | Meaning | Colour |
|---|---|---|
| `!` | Conflict | magenta |
| `D` | Deleted | red |
| `A` | Added | green |
| `R` | Renamed | green |
| `M` | Modified | yellow |
| `U` | Untracked | green |

## Limits

- The pane opens by itself only in terminals about 144 columns or wider. Otherwise run `/changes`.
- It's read-only: no staging, committing or diffs, and no editing of issues or pull requests.
- The Issues and PRs tabs need the [GitHub CLI](https://cli.github.com) installed and logged in (`gh auth login`). It only recognises `github.com` remotes and only looks at `origin`. It lists up to 100 issues (the tab reads `Issues 100+` past that).
- The PRs tab lists up to 100 open PRs (the tab reads `PRs 100+` past that). Since 0.4.0, a GitHub repo shows a tab bar (`Changes · PRs`) even without an issues repo; `/changes prs` turns it off.
- An issue or PR opens with `xdg-open` (Linux) or `open` (macOS). If neither works, its URL is copied to the clipboard instead.
- Claude Code fills the docked pane with its theme's `composerSidebarBackground` color, and a mod can't change that directly. In a VS Code-family terminal (VS Code, Cursor, …) the mod reads your editor theme on start and writes its terminal background into `~/.claude/themes/editor-match.json`. Pick **Match editor (git-changes)** once with `/theme`. An editor theme change applies from the next session.
- Row widths count wide characters (CJK, emoji) as two columns using a built-in table. A few rare symbols may still measure one column off in some terminals.
- The Issues and PRs tabs aren't looked up in non-interactive runs (`claude -p`, the SDK).

## License

MIT. See [LICENSE](../../LICENSE).
