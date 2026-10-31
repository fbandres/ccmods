# git-changes

A live Source Control pane for Claude Code: see which files changed, and by how much, without running `git status`. If the project keeps its GitHub issues in a `<repo>-issues` repo, the pane shows those too.

![git-changes pane](screenshot.png)

## What it does

- Lists every changed file in the current repo, with a status letter: `M` modified, `A` added, `D` deleted, `R` renamed, `U` untracked, `!` conflict.
- Shows lines added (`+N`, green) and removed (`-N`, red) per file and in total. Binary files show `bin`.
- Colours file names by status, and strikes through deleted files.
- Shows the branch, a `●` when the tree is dirty, and a blue `▲ 1` / yellow `▼ 2` when you have unpushed or unpulled commits.
- Refreshes right after Claude edits files, and every 2 seconds while the pane is visible.
- Long lists scroll under a pinned header: mouse wheel, or PgUp/PgDn once the pane is focused.
- **Issues tab (optional, automatic).** When `origin` is `github.com/<owner>/<repo>` and a repo named `<owner>/<repo>-issues` exists, a `[Changes 3]  Issues 5` tab bar appears. The Issues tab lists the open issues, most recently updated first, with number, title, first label and age. Click an issue, or arrow to it and press Enter, to open it in your browser. With no such repo, the pane has no tabs and looks as it always did.

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
- If a future Claude Code built-in ever takes `/changes`, the mod registers `/git-changes` instead, which does the same.

## How it works

- **Refresh:** after `Edit`, `Write` and `Bash` tool calls, every 2 s while the pane is placed, and when it opens.
- **Issues:** `gh repo view <owner>/<repo>-issues` once per session finds the repo, then `gh issue list --state open --search "sort:updated-desc" --limit 100` runs as soon as the repo is found, every 60 s while the pane is visible, and right away when you click the Issues tab. If GitHub is unreachable at start, it tries again every minute. A failed fetch keeps the last list and shows the error in the tab.
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
- It's read-only: no staging, committing or diffs, and no editing of issues.
- The Issues tab needs the [GitHub CLI](https://cli.github.com) installed and logged in (`gh auth login`). It only recognises `github.com` remotes and only looks at `origin`. It lists up to 100 issues (the tab reads `Issues 100+` past that).
- An issue opens with `xdg-open` (Linux) or `open` (macOS). If neither works, its URL is copied to the clipboard instead.
- Claude Code fills the docked pane with its theme's `composerSidebarBackground` color, and a mod can't change that directly. In a VS Code-family terminal (VS Code, Cursor, …) the mod reads your editor theme on start and writes its terminal background into `~/.claude/themes/editor-match.json`. Pick **Match editor (git-changes)** once with `/theme`. An editor theme change applies from the next session.
- Row widths count wide characters (CJK, emoji) as two columns using a built-in table. A few rare symbols may still measure one column off in some terminals.
- The Issues tab isn't looked up in non-interactive runs (`claude -p`, the SDK).

## License

MIT. See [LICENSE](../../LICENSE).
