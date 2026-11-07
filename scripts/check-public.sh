#!/usr/bin/env bash
# Guard for the public repository. Fails when a private name, host, address or account id shows up in a file,
# when a file has a private name, or when gitleaks finds a secret. Run by hand, by .githooks/pre-commit,
# and before any push to the public repo.
#   scripts/check-public.sh
# The patterns live in scripts/public/deny.txt and deny-files.txt. Add to them, don't delete from them.
set -uo pipefail
cd "$(git rev-parse --show-toplevel)" || exit 1
fail=0

# Lines of a pattern file without comments or blanks (a blank pattern would match every line).
patterns() { grep -vE '^(#|$)' "$1"; if [ -n "${2:-}" ] && [ -f "$2" ]; then grep -vE '^(#|$)' "$2"; fi; true; }
# The owner's literal names and addresses stay in local files outside the repo (see scripts/public/deny.txt).
deny_local="${CT_PUBLIC_DENY_LOCAL:-$HOME/.config/creator-toolset/public-deny.local.txt}"
deny_files_local="${CT_PUBLIC_DENY_FILES_LOCAL:-$HOME/.config/creator-toolset/public-deny-files.local.txt}"
[ -f "$deny_local" ] || echo "check-public: no local list at $deny_local, only the generic patterns ran" >&2

# 1. Private mentions in file contents. scripts/public/ holds the patterns themselves, so it is skipped.
hits=$(grep -rIEn -f <(patterns scripts/public/deny.txt "$deny_local") \
  --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist --exclude-dir=.turbo \
  --exclude-dir=build --exclude-dir=.build . \
  | grep -v '^\./scripts/public/' || true)
if [ -n "$hits" ]; then
  echo "private mentions (scripts/public/deny.txt):"
  echo "$hits" | cut -c1-240
  fail=1
fi

# 2. Private file names, anywhere in the tree.
# build/ and .build/ are the Mac app's ignored build output (its Swift packages' checkouts, the bundled server)
names=$(find . \( -name node_modules -o -name .git -o -name dist -o -name .turbo -o -name build -o -name .build \) -prune -o -type f -print \
  | grep -iE -f <(patterns scripts/public/deny-files.txt "$deny_files_local") || true)
if [ -n "$names" ]; then
  echo "private file names (scripts/public/deny-files.txt):"
  echo "$names"
  fail=1
fi

# 3. Secrets, when gitleaks is installed (brew install gitleaks). It scans the files, not history.
if command -v gitleaks >/dev/null 2>&1; then
  if ! leaks=$(gitleaks dir . --redact --no-banner --exit-code 1 2>&1); then
    echo "gitleaks found something (values redacted):"
    echo "$leaks"
    fail=1
  fi
else
  echo "check-public: gitleaks not installed, secret scan skipped (brew install gitleaks)" >&2
fi

if [ "$fail" -ne 0 ]; then
  echo "check-public: FAILED. Remove the private text or file, or add a documented exception to the pattern list." >&2
  exit 1
fi
echo "check-public: ok"
