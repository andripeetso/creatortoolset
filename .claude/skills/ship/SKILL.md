---
name: ship
description: Release the Mac app with everything on main that is ready - wait for the other agents, run the tests, wait for CI, build, publish and check it. Use when the maintainer says "ship", "release" or "get it live".
---

# Ship a release

Only when the maintainer asked for it in this conversation. AGENTS.md, "Releases", has the rules; these are the steps.

1. **Version.** `gh release list --limit 1` gives the last one. Any new feature since: `0.<minor+1>.0`, fixes only:
   `0.<minor>.<patch+1>`. `CRITICAL=1` only when the maintainer says so, or the release fixes data loss, a broken
   link to the server, or an app that does not open.
2. **Wait for the other agents.** `git status --short`: every change not committed is another agent's work in
   progress. Ask the maintainer which features are done; wait until those are committed. Never commit, stash or
   reset another agent's files.
3. **Pull.** `git pull --ff-only`. It leaves the other agents' changes as they are, and stops without touching
   anything when one is in the way or main has gone two ways: then ask. No stash, no rebase.
4. **Push and wait for CI.** `git push`, then wait until `gh run list --commit "$(git rev-parse HEAD)" --workflow
   ci.yml` shows `success`. CI is the test: it runs `pnpm check` and `pnpm test` on the commit itself, where a run
   in this folder would also test the other agents' unfinished changes. Red: fix what is yours, push, wait again;
   anything else, tell the maintainer which test and which commit. `release.sh` refuses a commit CI has not passed.
5. **Notes.** `git log v<last>..HEAD --format=%s` and write what a person gets, in plain words, one line each, into a
   file outside the repository.
6. **Build.** From this checkout, with HEAD on the pushed commit, in the background (it takes a while):
   `SIGN_IDENTITY="<Developer ID Application identity, security find-identity -v -p codesigning>"
   NOTARY_PROFILE=creator-toolset NOTES=<file> [CRITICAL=1] apps/mac/scripts/release.sh <version>`.
   The log must say `check-page-opens: ok` (search it with `grep -a`). It refuses a version that has a release or
   draft already: never delete someone's draft to get past it, ask.
7. **Try it.** Open the disk image from the build folder it names; the app must open a window past the CT mark.
8. **Publish.** `gh release edit v<version> --draft=false`. Check the feed:
   `curl -sL https://github.com/$(gh repo view --json nameWithOwner -q .nameWithOwner)/releases/latest/download/appcast.xml | grep -a shortVersionString`.
   A server that deploys from `main`: check its `/api/health` once it has restarted.
9. **Report.** The version, its link, what is in it, and which agents' work shipped, so the maintainer can close them.
