# ccmods

[![check](https://github.com/fbandres/ccmods/actions/workflows/check.yml/badge.svg)](https://github.com/fbandres/ccmods/actions/workflows/check.yml)

Mods for [Claude Code](https://docs.anthropic.com/en/docs/claude-code): small plugins that change Claude Code's own interface, such as live panes, gauges and status bands. This repo is a plugin marketplace, so you install mods with one command each.

## Quickstart

Give your coding agent this prompt:

```
Read https://github.com/fbandres/ccmods/blob/main/SETUP.md
and install the git-changes mod for me.
```

Or install it yourself, inside Claude Code:

```
/plugin marketplace add fbandres/ccmods
/plugin install git-changes@ccmods
/reload-plugins
```

## Mods

| Mod | What it does | Use |
|---|---|---|
| [git-changes](mods/git-changes/README.md) | Live Source Control pane: changed files, status letters, +/− line counts | `/changes` |
| [wpm-gauge](mods/wpm-gauge/README.md) | Words-per-minute gauge (5 coloured bars, streak peak, ⚡ at full speed) under the prompt box | always on |

## Requirements

- Claude Code **2.1.287 or newer** (mod / hooks-module support). Tested on 2.1.287 (stable) and 2.1.296 (latest).
- **git 2.15+** (git-changes only).
- A terminal font with `⎇ ● ✔ ⚡ ─`. Any modern font has them.
- macOS or Linux.

## Update or remove

```
claude plugin update <mod>@ccmods
claude plugin uninstall <mod>@ccmods
```

## Make your own mod

A mod is a Claude Code plugin whose `hooks/hooks.json` names a hooks module:

```
my-mod/
├── .claude-plugin/plugin.json   { "name": "my-mod", "version": "0.1.0", "description": "…" }
├── hooks/hooks.json             { "modules": ["./register.tsx"] }
└── hooks/register.tsx           export const register: Register = on => { … }
```

Both mods here are small, tested examples. Check yours with `claude plugin validate <folder>` and `claude plugin test <folder>`.

## License

[MIT](LICENSE)
