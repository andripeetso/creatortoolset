#!/usr/bin/env bash
# Self-test for scripts/check-public.sh. Builds a scratch repo with a made-up private name and checks that the
# guard passes a git-ignored plug-in file, fails the same file once it is staged, fails on a private name in a
# tracked file, fails on a token in a tracked file, and fails when gitleaks is missing.
#   scripts/public/check-public.test.sh
set -uo pipefail
src="$(cd "$(dirname "$0")/../.." && pwd)"
base="${CT_TEST_TMP:-/Volumes/WinningFriends/ct-tmp}"
[ -d "$(dirname "$base")" ] || base="${TMPDIR:-/tmp}"
mkdir -p "$base" && T=$(mktemp -d "$base/check-public.XXXXXX") || exit 1
trap 'rm -rf "$T" "$T.lists"' EXIT

cd "$T" && git init -q . && mkdir scripts && cp -R "$src/scripts/public" "$src/scripts/check-public.sh" scripts/
lists="$T.lists" && mkdir -p "$lists"  # the local lists live outside the scratch repo
printf 'Zorblax\n' > "$lists/deny.local"
printf 'zorblax\n' > "$lists/denyfiles.local"
export CT_PUBLIC_DENY_LOCAL="$lists/deny.local" CT_PUBLIC_DENY_FILES_LOCAL="$lists/denyfiles.local"
printf 'apps/captions/plugins/\n' > .gitignore
printf 'hello\n' > README.md
git add .gitignore README.md scripts && git -c user.email=t@t -c user.name=t commit -qm base

# A plug-in folder the repo ignores, with a private name in its path and content, and a token in its content.
mkdir -p apps/captions/plugins/zorblax
printf 'Zorblax plug-in\n' > apps/captions/plugins/zorblax/zorblax-notes.ts
printf 'token = "%s"\n' "ghp_""XK9Qm2Lp7Rt4Vw8Zb3Nc6Hd1Jf5Gs0Ya2UeK" > apps/captions/plugins/zorblax/keys.ts

fails=0
expect() { # expect <want: pass|fail> <name> <command...>
  local want="$1" name="$2"; shift 2
  "$@" >/dev/null 2>&1; local got=$?
  if { [ "$want" = pass ] && [ "$got" -eq 0 ]; } || { [ "$want" = fail ] && [ "$got" -ne 0 ]; }; then
    echo "ok   $name"
  else
    echo "FAIL $name (exit $got, wanted $want)"; fails=$((fails + 1))
  fi
}
guard() { bash "$T/scripts/check-public.sh"; }

expect pass "ignored plug-in file with a private name and a token passes" guard

git add -f apps/captions/plugins/zorblax/zorblax-notes.ts
expect fail "same file staged (forced past .gitignore) fails on its name and content" guard
git rm -q --cached -f apps/captions/plugins/zorblax/zorblax-notes.ts

git add -f apps/captions/plugins/zorblax/keys.ts
expect fail "staged file with a token fails the secret scan" guard
git rm -q --cached -f apps/captions/plugins/zorblax/keys.ts

printf 'Zorblax in a tracked file\n' > README.md
expect fail "private name in a tracked file fails" guard
git checkout -q -- README.md

expect pass "clean tree passes again" guard

PATH=/usr/bin:/bin expect fail "missing gitleaks fails closed" guard

echo "$fails failing"
[ "$fails" -eq 0 ]
