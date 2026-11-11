# AGENTS.md

Guide for coding agents (and people) working in this repository. Keep it short and true: when a rule here
stops being true, fix the rule in the same change.

## What this is

Creator Toolset: open-source tools for content creators (captions, audio enhancement, client review, video
cleaning, story splitting, video notes, guides, an Instagram content analyzer, a writing workspace and AI providers).
It is one person's app: no sign-up, no invites, no user management. It runs as one web app on the user's machine or
on their own server, plus a Mac app that relays AI requests to the Claude Code or Codex tool its owner installed
and signed in to with their own subscription.

| Folder | What | Stack |
|---|---|---|
| `apps/captions/` | The web app and its server: UI in `src/`, API in `api/`, shared types in `contracts/`, the database schema in `db/` | React, Vite, Hono, tRPC, TypeScript |
| `apps/mac/` | The Mac app: a native shell around the web app, the server it runs on this Mac (bundled by `scripts/build-app.sh`), the list of servers it can open (This Mac and yours, by address), plus the local AI runner and its menu bar item | SwiftUI, Swift Package Manager, Sparkle |
| `apps/ios/` | The iPhone app: the Assistant, uploads into the Media Library (background, resumable), Finals, scripts to film, and the web app for the rest. Talks to any server by address or one-time sign-in link | SwiftUI, Xcode project |
| `apps/obsidian/` | An Obsidian plugin: a vault folder's notes and the Content Workshop in step (status both ways, Send, exports). Its own npm lockfile, outside the pnpm workspace | TypeScript, esbuild |
| `scripts/` | Repository checks (`check-public.sh`) and the public-repo patterns in `scripts/public/` | Bash |
| `.githooks/` | `pre-commit` (public-repo guard, secret scan) | Bash |

Start with `apps/captions/README.md` for the app, `SELF_HOSTING.md` for running a server, and
`apps/mac/README.md` for the Mac app, `apps/ios/README.md` for the iPhone app.

## Changing the app for one person: a plug-in first

Two kinds of work happen in a checkout of this repository, and they go to different places:

- **Work on the app itself.** Its maintainers and contributors fix or build something for everyone who uses it. That
  goes in the app's own code, by the rules below, and the rest of this section is not for that work.
- **One person's own copy.** Someone who uses the app wants it to work their way: a tool they miss, a step done
  differently, a page for their own process. Don't edit the app's own files for that, and don't fork.

Not told which? `git log -1 --author="$(git config user.email)"` answers it: someone with commits in this
repository works on the app itself.

For one person's own copy, work down this list and stop at the first that does the job:

1. **A setting**, or the tool's own Defaults dialog.
2. **A pack** (no code): frameworks, caption styles, instructions on top of the AI prompts
   (`apps/captions/docs/features/packs.md`).
3. **Their own AI with the app's tools** (Settings → Headless access): a job the AI can do with the tools that exist
   needs no change to the app.
4. **A plug-in**: a folder of their own. It adds pages, Home tiles, Settings sections, API routes, tools for
   their AI and buttons on items, and it can take the place of some built-in pages. With the downloaded Mac app it
   goes in `~/Library/Application Support/Creator Toolset/plugins/<id>/` and they switch it on in the app: nothing
   to install, no checkout. In a checkout it is `apps/captions/plugins/<id>/`; on a fresh clone run `pnpm install`
   first (`apps/captions/scripts/plugins.mjs`, which loads the plug-ins there, imports `dotenv`).
   [PLUGINS.md](PLUGINS.md) is the guide, and `apps/captions/plugin-examples/hello` is the one to copy.
5. **A plug-in plus one new slot**, when no slot fits: the smallest slot in the app (PLUGINS.md, "When no slot
   fits"), everything else in the plug-in.
6. **A fork** is the last choice. Tell the person before you start.

Why: a plug-in folder is outside the app's own code (the Mac app's plug-ins folder, or `apps/captions/plugins/`,
which git ignores), so an update never touches it. An edit to one of the app's
own files conflicts with every update from then on. A bug in the app is the exception: fix it in the app's own code
and offer the fix as a pull request, so the person doesn't carry it.

## Commands

```sh
pnpm install                                   # one lockfile for the workspace (pnpm 10, see root package.json)
pnpm --filter @creator-toolset/captions dev    # dev server on http://localhost:43127 (no sign-in while APP_SECRET is unset)
pnpm test                                      # all test suites (turbo)
pnpm check                                     # TypeScript, apps/captions
pnpm build                                     # production build of the web app
pnpm build:mac                                 # Mac app bundle with its server (apps/mac/scripts/build-app.sh, Apple silicon)
pnpm test:mac                                  # Mac app tests (swift test)
pnpm build:ios                                 # iPhone app, simulator build (apps/ios/README.md)
pnpm test:ios                                  # iPhone app tests
pnpm --filter @creator-toolset/captions run doctor   # checks a running install; bare `pnpm doctor` is pnpm's own command
scripts/check-public.sh                        # the public-repo guard; the pre-commit hook runs it too
```

Enable the hooks once per clone: `git config core.hooksPath .githooks`.

## Rules that matter

**AI providers.** A server's AI providers are a person's own Claude Code or Codex, installed on their own Mac and
signed in with their own subscription, paired through the Mac app. They answer only the requests and background work
of the account that owns them. Never add a path that runs one person's subscription for another person, and never
let a request from one account reach another account's provider.

**Community carries no code.** What people share with each other through Community is text and settings: packs
(prompts, frameworks, caption styles) and, as they are added, other things the app reads as a list of choices.
Never add a way to list, install or update code from Community, and never send text other people wrote to an AI
run that has tools on someone's computer (the assistant). A plug-in is a person's own, made on their own Mac: it
has the app's full access and is never listed. A tool that many people need is built into the app.

**Whose keys pay.** Every paid service call (AI on an API key, transcription, audio engines, research, Apify)
gets its key from `keyFor` in `apps/captions/api/my-keys.ts`; never read a service key from `process.env` in a
feature. Each user adds their own keys, Apify included, in Settings → API keys and pays their
provider. The server's keys serve only the admin's own work, never their AI (an admin's AI is their own provider or
own key). AI with no provider and no own key fails with a message saying what to add; the Workshop has no
API-key path at all.

**No scraping.** Social platforms come only from the official logins and the user's own Apify key, never from
their web pages, logged in or not; no browser automation of other services. The one page fetch is Knowledge → Add a
link (`webPageText` in `api/lib/workshop/source-files.ts`): the single public page the user pasted, no login, no
crawling, inside addresses and social platforms refused.

**Accounts and access.** With `APP_SECRET` unset the server is open and every request runs as a local admin.
That is for one person's own machine only. Production refuses to start without `APP_SECRET`; the owner account is
made from it on first start (`api/users.ts`). Someone with no session on a share link is `VISITOR` (every app off);
keep access checks where the routes are mounted (`api/boot.ts`), not inside each handler.

**No secrets in code, docs or fixtures.** Keys, tokens, cookies and passwords come from environment variables or
per-user files written with mode 0600. Read them with `process.env` at the point of use (paid service keys only
through `keyFor`, above), and list every new
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
repository root) and `Caddyfile`; `apps/captions/scripts/setup-server.sh <domain>` writes `.env` and starts it. Do not change the image's user, its read-only root or its dropped capabilities without a reason
written in the pull request.

## Releases

The Mac app is released on this repository's GitHub Releases, and every installed copy updates itself from the
newest one. A release reaches everyone's Mac, so make one only when the maintainer says to.

- `apps/mac/scripts/release.sh <version>` (see `apps/mac/README.md`, "Download and updates") builds from a clean
  checkout of a pushed commit and always makes a **draft**. Open the disk image, click through what changed, then
  publish with `gh release edit v<version> --draft=false`.
- Versions: `0.<minor>.0` when a release brings new features, `0.<minor>.<patch>` for fixes only. Never reuse or
  move a tag. The build number (the commit count) is what the updater compares, so release from `main` only.
- Each release carries the disk image, `appcast.xml` (the update feed) and the source of the bundled FFmpeg
  (GPL). Don't drop any of the three.
- The notes list what a person gets, in plain words; `release.sh` drafts them from the commit subjects.

## Working in the code

- Routes: each `api/*.ts` file exports a Hono app; `api/boot.ts` mounts them and applies the account gate.
- Client: `src/App.tsx` lists the routes. Tools are switched per account in `api/users.ts` (`TOOLS`).
- Types shared by client and server live in `contracts/`.
- Where things live (the app's one system; put new work in the matching place):
  - **Home** = the tools you use (its groups are `TOOL_GROUPS` in `contracts/tools.ts`; `src/lib/tools.ts` is the
    top bar's tool menu and the plug-in tiles). **Settings** = how the app is set up: General, Appearance, Tools,
    AI (Providers, Scheduled tasks, Usage), Hardware (Devices, Storage, Servers), Connections (Social accounts,
    API keys, Headless access), People (Team, Admin; on a hosted server). **The account button** = you.
  - Inside a tool = that tool's own choices (its page, its Defaults dialog).
  - **Community** = everything added to the app. Installed shows **Plug-ins** (code: built into this server, or on
    the Mac app's own server the folders in the person's plug-ins folder, each with its switch) and then **Packs**
    (content you switch on per project and can remove).
  - A plug-in's pieces show up where the built-in ones do: its Settings section in the matching group or Admin tab,
    its tiles on Home, its pages in place of built-in ones. The Plug-ins list is the one place that names it.
  - Plug-in authors: add each piece to the matching place above, and give the plug-in `name` and `about` (one line)
    in both `plugin.ts` and `web.tsx` (`plugin-examples/hello` shows it). `GET /api/plugins` and Community read these.
  - Settings groups and the sidebar: `src/components/settings/nav.ts`; kit: `src/components/settings/ui.tsx`.
- Plug-ins get in two ways. Compiled in: `scripts/plugins.mjs` writes the registries at build time. From a folder,
  on the Mac app's own server only: `scripts/plugin-build.mjs` builds one folder by itself, `api/lib/folder-plugins.ts`
  loads what the Mac app says is on (`apps/mac` `Plugins.swift` keeps the person's Switch on clicks) and
  `src/lib/folder-plugins.tsx` adds the page halves before the first render. A screen reads the plug-in list when it
  is drawn, never when its file loads. A folder plug-in that fails is left out and named; it never stops the app.
- Long-running work (exports, enhancement, the Mac relay) runs in background queues with concurrency limits set
  by environment variables; keep those limits when you add work to them.
- Status fields (jobs, sessions, sources, exports): the union lives once (a `contracts/` file or the module's
  `as const` array, which the client imports, never retypes), its allowed moves sit next to it as a `Moves` table
  (`apps/captions/api/lib/transition.ts`), and every write goes through `move()` (`canMove()` in background loops;
  a route answers 409). Reads never write: a stale `running`/`processing`/`thinking` is reconciled once at startup.
