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
3. **Test.** `git pull --rebase --autostash`, then `pnpm test` and `pnpm check`. A failure in your own change: fix
   it. Anything else: stop and tell the maintainer which test and which commit.
4. **Push and wait for CI.** `git push`, then wait until `gh run list --commit "$(git rev-parse HEAD)" --workflow
   ci.yml` shows `success`. Red: fix, push, wait again. `release.sh` refuses a commit CI has not passed.
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
