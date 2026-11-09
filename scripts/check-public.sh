#!/usr/bin/env bash
# Guard for the public repository. Fails when a private name, host, address or account id shows up in a file,
# when a file has a private name, or when gitleaks finds a secret. Run by hand, by .githooks/pre-commit,
# and before any push to the public repo.
#   scripts/check-public.sh
# Only files git would commit are checked: tracked and staged files, plus untracked files .gitignore does not
# exclude. Git-ignored files (plug-in folders under apps/captions/plugins/, .env, build output)
# never leave the machine, so they are skipped. A staged file is checked even if an ignore rule matches it.
# The patterns live in scripts/public/deny.txt and deny-files.txt. Add to them, don't delete from them.
# gitleaks is required: without it the guard fails (fail closed).
set -uo pipefail
cd "$(git rev-parse --show-toplevel)" || exit 1
fail=0

# Lines of a pattern file without comments or blanks (a blank pattern would match every line).
patterns() { grep -vE '^(#|$)' "$1"; if [ -n "${2:-}" ] && [ -f "$2" ]; then grep -vE '^(#|$)' "$2"; fi; true; }
# Literal private names and addresses stay in local files outside the repo (see scripts/public/deny.txt).
deny_local="${CT_PUBLIC_DENY_LOCAL:-$HOME/.config/creator-toolset/public-deny.local.txt}"
deny_files_local="${CT_PUBLIC_DENY_FILES_LOCAL:-$HOME/.config/creator-toolset/public-deny-files.local.txt}"
[ -f "$deny_local" ] || echo "check-public: no local list at $deny_local, only the generic patterns ran" >&2

# The files that could be committed (existing ones; a staged deletion has nothing to scan).
files=()
while IFS= read -r f; do
  [ -f "$f" ] && files+=("$f")
done < <(git ls-files --cached --others --exclude-standard)

# 1. Private mentions in file contents. scripts/public/ holds the patterns themselves, so it is skipped.
hits=""
if [ ${#files[@]} -gt 0 ]; then
  hits=$(grep -IEn -f <(patterns scripts/public/deny.txt "$deny_local") -- "${files[@]}" \
    | grep -v '^scripts/public/' || true)
fi
if [ -n "$hits" ]; then
  echo "private mentions (scripts/public/deny.txt):"
  echo "$hits" | cut -c1-240
  fail=1
fi

# 2. Private file names among the same files.
names=""
if [ ${#files[@]} -gt 0 ]; then
  names=$(printf '%s\n' "${files[@]}" | grep -iE -f <(patterns scripts/public/deny-files.txt "$deny_files_local") || true)
fi
if [ -n "$names" ]; then
  echo "private file names (scripts/public/deny-files.txt):"
  echo "$names"
  fail=1
fi

# 3. Secrets (gitleaks, brew install gitleaks). It scans the working tree, so the git-ignored paths are
# allowlisted for it: gitleaks dir does not read .gitignore. gitleaks:allow comments still apply.
if ! command -v gitleaks >/dev/null 2>&1; then
  echo "check-public: gitleaks not installed (brew install gitleaks). The guard fails without the secret scan." >&2
  fail=1
else
  # Git-ignored paths as regex lines: a directory is a prefix, a file must match whole.
  ignored=$(git ls-files -o -i --exclude-standard --directory \
    | sed -E 's/[].[*^$+?(){}|]/\\&/g' \
    | awk '{ p = "^" $0; if ($0 !~ /\/$/) p = p "$"; printf "  \047%s\047,\n", p }')
  toml=$(printf '[extend]\nuseDefault = true\n')
  if [ -n "$ignored" ]; then
    toml="$toml$(printf '\n[[allowlists]]\ndescription = "git-ignored paths stay on this machine"\npaths = [\n%s\n]\n' "$ignored")"
  fi
  if ! leaks=$(GITLEAKS_CONFIG_TOML="$toml" gitleaks dir . --redact --no-banner --exit-code 1 2>&1); then
    echo "gitleaks found something (values redacted):"
    echo "$leaks"
    fail=1
  fi
fi

if [ "$fail" -ne 0 ]; then
  echo "check-public: FAILED. Remove the private text or file, or add a documented exception to the pattern list." >&2
  exit 1
fi
echo "check-public: ok"
