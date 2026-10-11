# Setting up ccmods (instructions for coding agents)

You are installing one or more mods from the ccmods marketplace into the person's Claude Code. Follow these steps in order. Stop and ask the person whenever a step says so.

1. **Check Claude Code.** Run `claude --version`. Mods need hooks-module support, available from 2.1.287 (tested on 2.1.287 and 2.1.296). If the version is older, stop and tell the person to update Claude Code first.
2. **Pick the mods.** If the person named a mod, use it. Otherwise list the mods with their descriptions and ask which to install:
   - `git-changes`: a live Source Control pane of changed files with +/- line counts, toggled with `/changes`.
   - `wpm-gauge`: a words-per-minute gauge under the prompt box.
3. **Check git (git-changes only).** Run `git --version`; it must be 2.15 or newer. If it isn't, stop and tell the person.
4. **Add the marketplace.** Run `claude plugin marketplace list`.
   - If `ccmods` is listed with the source `fbandres/ccmods`, it's already added; continue.
   - If a marketplace named `ccmods` points anywhere else, **stop and ask the person**. Adding it again would silently re-point their existing marketplace.
   - Otherwise run `claude plugin marketplace add fbandres/ccmods`.
5. **Install.** For each chosen mod, run `claude plugin install <mod>@ccmods`.
6. **Load and verify.** Ask the person to run `/reload-plugins` in Claude Code. Then:
   - git-changes: ask them to run `/changes`; a "Source Control" pane opens. In terminals narrower than about 144 columns, it opens only when asked like this.
   - wpm-gauge: ask them to type in the prompt box; a 5-bar gauge appears under it.
7. **Report.** Tell the person what was installed, how to toggle it, and how to remove it: `claude plugin uninstall <mod>@ccmods`.
