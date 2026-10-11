#!/bin/sh
# Checks the marketplace and every mod, then scans the repo for leaks.
# Usage: sh scripts/check.sh   (ALLOW_MISSING_SCREENSHOTS=1 while screenshots are pending)
set -u
cd "$(dirname "$0")/.." || exit 1

status=0
pass() { printf '✔ %s\n' "$1"; }
fail() { printf '✘ %s\n' "$1"; status=1; }
note() { printf '· %s\n' "$1"; }

# Files that would be published: tracked, plus untracked ones not ignored.
files=$(git ls-files --cached --others --exclude-standard)

if claude plugin validate . >/dev/null 2>&1; then pass 'marketplace validates'; else fail 'marketplace: run `claude plugin validate .`'; fi

for mod in mods/*/; do
  [ -d "$mod" ] || continue   # no mods yet
  name=$(basename "$mod")
  if claude plugin validate "$mod" >/dev/null 2>&1; then pass "$name: validates"; else fail "$name: run \`claude plugin validate $mod\`"; fi

  if out=$(claude plugin test "$mod" 2>&1); then
    pass "$name: $(printf '%s\n' "$out" | grep -E '^Ran ' | head -1)"
  else
    printf '%s\n' "$out" | grep -E '^\(fail\)|Error|Expected|Received' | head -20
    fail "$name: tests"
  fi

  if [ -d "${mod}.claude-plugin/types" ]; then
    if command -v tsc >/dev/null 2>&1; then tsc_cmd=tsc; else tsc_cmd='npx -y -p typescript tsc'; fi
    if $tsc_cmd -p "$mod" >/dev/null 2>&1; then pass "$name: types check"; else fail "$name: run \`tsc -p $mod\`"; fi
  else
    note "$name: tsc skipped (no .claude-plugin/types; they appear once Claude Code loads the mod)"
  fi
done

# Every relative link and image in every README must resolve.
for readme in $(printf '%s\n' "$files" | grep -E '(^|/)README\.md$'); do
  dir=$(dirname "$readme")
  for target in $(grep -oE '\]\([^)#]+' "$readme" | sed 's/^](//' | grep -vE '^(https?:|mailto:)'); do
    if [ ! -e "$dir/$target" ]; then
      case "$target" in
        *screenshot.png) if [ "${ALLOW_MISSING_SCREENSHOTS:-}" = 1 ]; then note "$readme: $target pending"; continue; fi ;;
      esac
      fail "$readme: broken link $target"
    fi
  done
done

# Leak scan: generic patterns are public; private names come from the git-ignored denylist.
scan=$(printf '%s\n' "$files" | grep -v '^scripts/check.sh$')
generic='/Users/|/home/|[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z.]{2,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
hits=$(printf '%s\n' "$scan" | xargs grep -InE "$generic" 2>/dev/null)
if [ -f .local/leak-denylist.txt ]; then
  private=$(printf '%s\n' "$scan" | xargs grep -InFi -f .local/leak-denylist.txt 2>/dev/null)
  hits=$(printf '%s\n%s\n' "$hits" "$private" | grep -v '^$')
else
  note 'leak scan: no .local/leak-denylist.txt, generic patterns only'
fi
if [ -n "$hits" ]; then printf '%s\n' "$hits"; fail 'leak scan'; else pass 'leak scan clean'; fi

exit $status
