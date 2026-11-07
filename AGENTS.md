# AGENTS.md

Guide for coding agents (and people) working in this repository. Keep it short and true: when a rule here
stops being true, fix the rule in the same change.

## What this is

Creator Toolset: open-source tools for content creators (captions, audio enhancement, client review, video
cleaning, story splitting, video notes, guides, an Instagram content analyzer, a writing workspace, teams and
AI providers). It runs as one web app on the user's machine or on their own server, plus a Mac app that
relays AI requests to the Claude Code or Codex tool its owner installed and signed in to with their own subscription.

| Folder | What | Stack |
|---|---|---|
| `apps/captions/` | The web app and its server: UI in `src/`, API in `api/`, shared types in `contracts/`, the database schema in `db/` | React, Vite, Hono, tRPC, TypeScript |
| `apps/mac/` | The Mac app: a native shell around the web app, plus the local AI runner and its menu bar item | SwiftUI, Swift Package Manager, Sparkle |
| `scripts/` | Repository checks (`check-public.sh`) and the public-repo patterns in `scripts/public/` | Bash |
| `.githooks/` | `pre-commit` (public-repo guard, secret scan) | Bash |

Start with `apps/captions/README.md` for the app, `SELF_HOSTING.md` for running a server, and
`apps/mac/README.md` for the Mac app.

## Commands

```sh
pnpm install                                   # one lockfile for the workspace (pnpm 10, see root package.json)
pnpm --filter @creator-toolset/captions dev    # dev server on http://localhost:43127 (no sign-in while APP_SECRET is unset)
pnpm test                                      # all test suites (turbo)
pnpm check                                     # TypeScript, apps/captions
pnpm build                                     # production build of the web app
pnpm build:mac                                 # Mac app bundle (apps/mac/scripts/build-app.sh)
pnpm test:mac                                  # Mac app tests (swift test)
pnpm --filter @creator-toolset/captions run doctor   # checks a running install; bare `pnpm doctor` is pnpm's own command
scripts/check-public.sh                        # the public-repo guard; the pre-commit hook runs it too
```

Enable the hooks once per clone: `git config core.hooksPath .githooks`.

## Rules that matter

**AI providers.** A server's AI providers are a person's own Claude Code or Codex, installed on their own Mac and
signed in with their own subscription, paired through the Mac app. They answer only the requests and background work
of the account that owns them. Members use their own providers, or a
monthly API budget that the workspace owner sets. Never add a path that runs one person's subscription for
another person, and never let a request from one account reach another account's provider.

**Accounts and access.** With `APP_SECRET` unset the server is open and every request runs as a local admin.
That is for one person's own machine only. Production refuses to start without `APP_SECRET`. Guests and the demo
account have their own limits (see `api/boot.ts`, `api/users.ts`); keep those checks where the routes are mounted,
not inside each handler.

**No secrets in code, docs or fixtures.** Keys, tokens, cookies and passwords come from environment variables or
per-user files written with mode 0600. Read them with `process.env` at the point of use, and list every new
variable in `apps/captions/.env.example` with no value. Never print a secret in logs, errors or the UI.

**Public repo.** Everything here is published. Do not add the names, hosts, addresses, account or app ids of any
real person, business, server or platform account. Examples and fixtures use the made-up brand "Tiny Acrobatics"
(handle `tinyacrobatics`). `scripts/check-public.sh` enforces the lists in `scripts/public/`; a hit fails the
pre-commit hook. Do not name the products a feature was modelled on: describe what the feature does.

**Tests live next to the code.** `foo.ts` is tested by `foo.test.ts` in the same folder. Run the test file you
changed, then `pnpm test` before a pull request. Keep a new test small: it should fail if the logic breaks.

**Keep changes small.** Delete code for removed features rather than leaving switches that do nothing. Each
remaining tool must keep working on its own. Prefer the standard library and the dependencies already in the
workspace over a new package.

**Storage on the developer's machine.** Build output, renders, downloads and scratch files belong on a
dedicated external disk when there is one, not in the repository or the home folder. Generated tools under
`apps/captions/runtime/` (ffmpeg, fingerprint and SSCD builds) are not source: never commit them.

**Images and deploys.** The Docker kit is `apps/captions/Dockerfile` with `docker-compose.yml` (build context: the
repository root). Do not change the image's user, its read-only root or its dropped capabilities without a reason
written in the pull request.

## Working in the code

- Routes: each `api/*.ts` file exports a Hono app; `api/boot.ts` mounts them and applies the account gate.
- Client: `src/App.tsx` lists the routes. Tools are switched per account in `api/users.ts` (`TOOLS`).
- Types shared by client and server live in `contracts/`.
- Long-running work (exports, enhancement, the Mac relay) runs in background queues with concurrency limits set
  by environment variables; keep those limits when you add work to them.
