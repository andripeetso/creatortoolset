# AGENTS.md

Guide for coding agents (and people) working in this repository. Keep it short and true: when a rule here
stops being true, fix the rule in the same change.

## What this is

Creator Toolset: open-source tools for content creators (captions, audio enhancement, client review,
story splitting, video notes, guides, an Instagram content analyzer, a writing workspace and AI providers).
It is one person's app: no sign-up, no invites, no user management. It runs as one web app on the user's machine or
on their own server, plus a Mac app that relays AI requests to the Claude Code or Codex tool its owner installed
and signed in to with their own subscription.

| Folder | What | Stack |
|---|---|---|
| `apps/captions/` | The web app and its server: UI in `src/`, API in `api/`, shared types in `contracts/` | React, Vite, Hono, tRPC, TypeScript |
| `apps/mac/` | The Mac app: a native shell around the web app, the server it runs on this Mac (bundled by `scripts/build-app.sh`), the list of servers it can open (This Mac and yours, by address), plus the local AI runner and its menu bar item | SwiftUI, Swift Package Manager, Sparkle |
| `apps/ios/` | The iPhone app: the Assistant, uploads into the Media Library (background, resumable), Finals, scripts to film, and the web app for the rest. Talks to any server by address or one-time sign-in link | SwiftUI, Xcode project |
| `apps/swift-shared/` | What the Mac and iPhone apps both use (the Keychain item helper, the host rules), as a local Swift package; `pnpm test:mac` runs its tests | Swift Package Manager |
| `apps/captions/public/helper/` | The helper for a Linux computer (with or without an NVIDIA card): pairs with a one-time code and runs speech-to-text models for its owner's server. The server hands these files out at `/helper/` | Python 3, faster-whisper, onnx-asr, systemd --user |
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
let a request from one account reach another account's provider. The one other AI is a model the admin of their own
install runs themselves and types in by address (Settings → API keys → Local model, `apps/captions/api/local-model.ts`):
text jobs only, refused on Creator Toolset Cloud, and the app never downloads, detects or suggests a model.

**What other people share carries no code.** What people share with each other through Community is text and
settings: packs (prompts, frameworks, caption styles, a Home layout), each read as data. Never add a way for someone
outside the team to list, install or update code through Community, and never put a pack's text into an AI run that
has tools on someone's computer (the assistant). Every `packInstructions` call names its job's AI: a run with tools (the Workshop's chat turn or fact
check on the Mac), or an AI program not in `TOOLS_OFF_DRIVERS`, gets only the app's own shipped packs. A plug-in a person makes is their own, on their own Mac, with the
app's full access. Code that Community offers is the team's own, reviewed like the app's code.

**Whose keys pay.** Every paid service call (AI on an API key, transcription, audio engines, research, Apify)
gets its key from `keyFor` in `apps/captions/api/my-keys.ts`; never read a service key from `process.env` in a
feature. Each user adds their own keys, Apify included, in Settings → API keys and pays their
provider. The server's keys serve only the admin's own work, never their AI (an admin's AI is their own provider or
own key), with one exception: the admin's Team use switch (Settings → API keys → Server keys) gives the admin's own team the server's keys, and members on a team budget run their AI on its Anthropic key, billed to that budget (`serverKeyOf`, `teamAiKey`). AI with no provider and no own key fails with a message saying what to add; the Workshop has no
API-key path at all.

**Accounts and access.** With `APP_SECRET` unset the server is open and every request runs as a local admin.
That is for one person's own machine only. Production refuses to start without `APP_SECRET`; the owner account is
made from it on first start (`api/users.ts`). Someone with no session on a share link is `VISITOR` (every app off);
keep access checks where the routes are mounted (`api/boot.ts`), not inside each handler.
Every way in ends in a session of its own (`api/lib/clients.ts`): a sign-in's cookie is the token of one, as a paired
phone's token is, so each other one is listed in Settings → Computers (Phones and browsers) and revoked by itself; the one a page is open in ends with Sign out. A sign-in route sets its cookie with
`setLoginCookie`, never a value of its own (`sign-in-answers.test.ts` fails a route whose cookie has no session); a call
the server makes as an account to a service that asks back who it is uses `ownLogin`. A device's token is never read
from a cookie, where it would count as the account itself.
On This Mac the Mac app makes the owner's account and its password itself ("admin", shown to nobody): a person's name on
screen comes from `shownName` (`api/users.ts`; `me.name` in the pages), never the username, and a sign-in name, a
password, its code and Sign out are shown only where `signsIn` (`src/lib/auth.ts`) says the person has their own.
One account in the Mac app (owner, 2026-11-26): the Creator Toolset account is the sign-in, on servers too. A server
that takes it (`accountTicketHost`, `account` in `GET /api/account/providers`) shows that account as its only account
section in Settings → Account, and its sign-in page's Google, Apple and GitHub buttons sign in through it
(`Shell.swift` `pageSignIn`). Never draw a server's own Sign-ins list beside it there.

**The browser is for viewing** (owner, 2026-11-26). People work in the Mac app's window and the iPhone app, which both
show the web app's pages. A plain browser is for hosting, viewing, sharing and downloading: share links with no
account, and, signed in, what the account may see (the Media Library, Review, Finals and the rest of its pages).
- Sign-in and what a signed-in account may view keep working in a plain browser: never block or remove them
  (`apps/captions/src/components/AuthGate.dom.test.tsx` holds the sign-in page).
- On a server that asks for a sign-in, an account in a plain browser is view-only (`viewOnlyIn`, `api/users.ts`; the
  page's `me.viewOnly`): every tool is Read there, an admin's too (the gates in `api/boot.ts`, `canChange` in the
  pages), and there is no assistant, no chat mode and no setup. Only the tools that hold something to look at are
  there (`VIEWED`, `contracts/tools.ts`): the others have no tile and no page (`canUse`). The server
  refuses every change from it but what `VIEW_ONLY_WRITES` (`api/boot.ts`) names: its own sign-in and account, and a
  reviewer's comments and approval on a cut. A new way to make or change something checks `canChange`.
- Tools are built for the apps. A control that needs the Mac app stays hidden in a plain browser (`thisMacBridge()`,
  `hasThisMac()`), as it does in the iPhone app's pages, and gets no stand-in there. "Does nothing in a browser" is
  not a finding for such a control: judge a tool's screen as the Mac app shows it.
- "In the browser" in code and commit messages mostly means in the page (a worker, the page's own export, its
  storage), which the Mac app runs too. Write "in the page", and "a plain browser" for the program.

**No secrets in code, docs or fixtures.** Keys, tokens, cookies and passwords come from environment variables or
per-user files written with mode 0600. Read them with `process.env` at the point of use (paid service keys only
through `keyFor`, above), and list every new
variable in `apps/captions/.env.example` with no value. Never print a secret in logs, errors or the UI.

**Public repo.** Everything here is published. Do not add the names, hosts, addresses, account or app ids of any
real person, business, server or platform account. Examples and fixtures use the made-up brand "Tiny Acrobatics"
(handle `tinyacrobatics`). `scripts/check-public.sh` enforces the lists in `scripts/public/`; a hit fails the
pre-commit hook. Do not name the products a feature was modelled on: describe what the feature does.

**Files and work stay on the person's computers.** Everything works locally unless it was marked to run on the server.
The server serves: reviews, Finals, uploads to the team and proxies for the team. It processes (decodes, encodes,
transcribes, renders) only where Settings → Server's video work is on; otherwise the work waits for one of the
person's computers and never falls through to the server (`mayRunHere`, `api/work/place.ts`). A computer's own file is
indexed where it is and its bytes come to the server only where the library's Upload setting sends them; a file a
person uploads by hand is taken (`mayReceive`, `api/library/upload-gate.ts`). Nothing is deleted for its age: people
empty their trash and remove exports themselves. The Media Library is the only source. Where a file is comes from its
place record. Never say a file is not on this computer without checking Settings → Folders and the place rows.
`api/prevention.test.ts` and `api/library/upload-gate.test.ts` hold the lists: a new process the server starts, a new
route that takes a file and a new deletion by age each need a row there.

**Tests live next to the code.** `foo.ts` is tested by `foo.test.ts` in the same folder. Run the test file you
changed, then `pnpm test` before a pull request. Keep a new test small: it should fail if the logic breaks.

**Keep changes small.** Delete code for removed features rather than leaving switches that do nothing. Each
remaining tool must keep working on its own. Prefer the standard library and the dependencies already in the
workspace over a new package.

**Storage on the developer's machine.** Build output, renders, downloads and scratch files belong on a
dedicated external disk when there is one, not in the repository or the home folder. Generated tools under
`apps/captions/runtime/` (ffmpeg and fingerprint builds) are not source: never commit them.

**Images and deploys.** The Docker kit is `apps/captions/Dockerfile` with `docker-compose.yml` (build context: the
repository root) and `Caddyfile`; `apps/captions/scripts/setup-server.sh <domain>` writes `.env` and starts it. Do not change the image's user, its read-only root or its dropped capabilities without a reason
written in the pull request.

## Several agents in one checkout

Often several agents work in this one folder on `main` at once, each on its own feature. The changes in the folder
that are not yours are another agent's unfinished work.

- Commit only what you changed, by path: `git commit -- <your files>`. Never `git add -A`, `commit -a`, a stash, a
  checkout or a reset of files you did not change. In a file another agent also changed, commit your own lines only,
  through an index of your own, so what another agent staged stays out: `export GIT_INDEX_FILE=<scratch>/index`,
  `git read-tree HEAD`, `git apply --cached <a patch of your lines>`, `git commit`, then `unset GIT_INDEX_FILE` and
  `git reset -q -- <the file>`.
- Run the tests of the files you changed before you commit. A failure in a file you did not touch may be another
  agent halfway through: say so rather than change it.
- After a push, check CI on your commit (`gh run list --commit <sha>`) and fix what you broke. A server that deploys
  from `main` takes a push live without a release.
- Never make a release unless the maintainer asked you to. One agent makes it, by the `ship` skill
  (`.claude/skills/ship/SKILL.md`).
- When you are done, say which commits are yours and stop.

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
- `release.sh` refuses a commit CI has not passed and a version that has a release already, a draft included.
- The notes list what a person gets, in plain words; `release.sh` drafts them from the commit subjects.
- `CRITICAL=1` marks a release people must not skip (data loss, a broken link to the server): installed copies ask
  for the restart in a card at once. Keep it for those; everything else waits in the corner's Restart to update.
- A server's pages can be newer than someone's Mac app (teammates update at different times). When a page change
  needs a newer Mac app, raise `MIN_MAC_APP` (`apps/captions/src/components/MacAppUpdateBanner.tsx`) to that
  release in the same commit: once an older app has downloaded the update, a dialog blocks it until it restarts
  (Restart to update), instead of a feature that does nothing.

## The words for where work lives

Three levels, the same in every screen, doc, notice and AI prompt (tool names stay as they are):

- **Server**: where the data lives. Creator Toolset Cloud is one server; a studio's own box is another
  (Settings → Servers).
- **Workspace**: one brand you make content for, with its audience, voice, call to action, context files and social
  accounts. In code it is still the Workshop `Project` (`api/lib/workshop/types.ts`), `projectId`, `ProjectSwitcher`,
  `useWorkspace`.
- **Project**: one video, reel, carousel or ad being made. In code: a Workshop session (`SessionMeta`), a Caption
  Studio project (`api/projects.ts`), a Review project. An AI Editor edit is called an edit.
- A **piece** is one written document inside a project (`Document`). The **team** is the people who share a server
  (Settings → Team, `contracts/workspaces.ts`), not a level above workspaces.

Never put "project" on screen for the brand-level thing, or "session" for a project.

Where a clip's original is, for each computer (`contracts/places.ts`):

- **Here**: this computer reads the original now; the player says `Original`. **Away**: its disk isn't connected here;
  the player plays the server's copy and says `Proxy`, and the line under it says the disk "isn't connected".
  **Gone**: the disk is here and the file isn't where it was: the clip is "Missing here".
- **Reconnect**: a gone file found again by its size and fingerprint, applied without asking ("Find missing files",
  "reconnected", "Moved: 2025 → Archive/2025 (48 files)").
- In code the disk is a **root** (`rootKey`), the path inside it the root path (`root_rel`), and one computer's own
  path a **place** (`version_places`). On screen never "root", "place", "relink", "offline media" or "device".

## The words for where work runs

Where the data lives and which machine does the work are two questions. Keep them apart in comments, docs, prompts
and answers:

- A **server** comes in three kinds, named by `CT_SERVER` and read only through `api/lib/env.ts`. **This Mac**
  (`mac`) is the server built into the Mac app (`apps/mac` `Server.swift`, which sets `CT_LOCAL=1`): one person's,
  and it is their own computer. **A Server** (`server`) is one somebody runs on a box for themselves or their team
  and opens by its address. **Creator Toolset Cloud** (`cloud`) is ours, for many separate teams. "The server does
  X" says which kind: on This Mac it means the person's own computer. In code: `serverKind()`, `hasTeam()` (Server
  and Cloud: Team, invites, server keys, budgets) and `isCloud()` (guards against tenants who don't trust each other);
  never read `CT_SERVER`, `CT_MODE` or `CT_LOCAL` for the kind anywhere else.
- A **computer** is a Mac or PC signed in to a server through the app, or a Linux helper. In code: `device`,
  "paired Mac", `relay`, `helper`. It is the machine its person sits at, not a second one. On screen and in prose say
  "computer" or "their Mac", never "paired Mac" or "device".
- **Work** is whatever reads or writes video or sound: the library's index, proxies, transcripts, the AI Editor's
  steps, previews, exports. **AI** is a language-model call and goes its own road (`api/ai-complete.ts` `aiFor`), to
  the asker's own AI.
- Which machine runs a piece of work is written in the code, never guessed: an AI Editor step with `source: "core"`
  (`api/editor/engine.ts`) and a library job (`api/library/worker.ts`) run on the server they belong to; a `device`
  kind (`contracts/devices.ts`) runs on a computer of the account that asked. Read it there before saying who does
  what.

## Working in the code

- Routes: each `api/*.ts` file exports a Hono app; `api/boot.ts` mounts them and applies the account gate.
- Client: `src/App.tsx` lists the routes. Tools are switched per account in `api/users.ts` (`TOOLS`).
- Types shared by client and server live in `contracts/`.
- Where things live (the app's one system; put new work in the matching place):
  - **Home** = the tools you use (its groups are `TOOL_GROUPS` in `contracts/tools.ts`; `src/lib/tools.ts` is the
    top bar's tool menu and the plug-in tiles). **Settings** = how the app is set up, grouped by whose setting it
    is: You (General, Appearance, Tools, Dictation, Computers, Servers, Providers, Headless access: the same in every
    workspace), Workspace (Details, Social accounts, Folders, Scheduled tasks, Memory: what belongs to one
    workspace; Folders also holds Folder access, what this Mac may read, the same in every workspace), Server (Video work, Team, Storage, API keys: what this server does and keeps, and who is on it; an
    admin sees everyone's, a member their own), Tool settings (a page per tool: the Media Library's, with its sound
    effects, and Voice's are there). No group of one page: a page joins the group it belongs to, and a thing with
    one or two rows is a section of the page it belongs to, never a page of its own. There is no Admin page: the
    server's own accounts are in Team, its projects in Storage, its keys in API keys. **The account button** = you.
  - **Settings covers every workspace** (owner, 2026-11-16). It never follows the workspace the window is in without
    saying so. A page whose content belongs to a workspace draws the workspace selector in its header
    (`WorkspacePick`, `src/components/settings/workspace-pick.tsx`): a list page (`mode="list"`) starts on All
    workspaces and each row carries its `WorkspaceTag`; a page of single values (`mode="one"`) shows the chosen
    workspace's. A thing moves between workspaces from its row's menu (`moveItems`: "Move to …", "Use in every
    workspace"). The selector never switches the window's workspace; a request for the shown workspace sends it
    itself (`inWorkspace`). A page with no selector is the same in every workspace. A plug-in's or a tool's page
    whose values are per workspace does the same.
  - Inside a tool = that tool's own choices (its page, its Defaults dialog).
  - **A tool is what you use; plug-ins, packs and skills are what you add to it; Community is where you find more.**
    Settings → Tools lists every tile with its Home switch and nothing else: a row never opens a page. A tool that
    has something to set or add (packs reach it, a plug-in adds a step or a section that names it, the Screen
    Recorder's settings in the Mac app) has a page of its own in the sidebar's Tool settings block,
    `/settings/tools/<tile>`, every section open: the plug-in sections that name it, its plug-ins (an AI Editor step
    with its switch for new edits), the installed packs that reach it, its skills by place, and "Browse Community". The
    map from a pack slot to its tool is `SLOT_TOOL` (`contracts/packs.ts`), from a Community kind `KIND_TOOL`
    (`packs-helpers.ts`); a new slot or kind goes in that map, never a page of its own.
  - **Community** = finding more, sorted the same way: one section per tool (`/community/tool/<tile>`: the team's
    plug-ins for it, then the packs that reach it, each row labelled with its kind), Home layouts, Other (plug-ins
    that name no tool). Installed shows **Plug-ins** (built into this server, or on the Mac app's own server the
    folders in the person's plug-ins folder, each with its switch) and then **Packs**. **Skills** lists every skill by
    the place it acts, the assistant's included (no tool page has those).
  - A plug-in's pieces show up where the built-in ones do: its steps and skills on its tool's page, its Settings
    section in the matching group (no group, or a server-wide `adminTab` one: the Plug-ins block), its tiles on Home, its pages
    in place of built-in ones. Community → Installed is the one place that names the whole plug-in.
  - Plug-in authors: add each piece to the matching place above, and give the plug-in `name` and `about` (one line)
    in both `plugin.ts` and `web.tsx` (`plugin-examples/hello` shows it). `GET /api/plugins` and Community read these.
  - Settings groups and the sidebar: `src/components/settings/nav.ts`; kit: `src/components/settings/ui.tsx`.
  - One setting, one section. Before adding a section, look at the whole page it lands on: when a section for that
    thing is there already, add rows to its card, under no heading of their own. A switch that turns the rows on or
    off is the first row of their card, never a section of its own. `section-titles.test.ts` fails when two files
    make a section of the same name.
  - **Settings wording** (owner, 2026-11-16: "standard", not "whimsical"). `settings-wording.test.ts` holds the
    banned forms.
    - A title (page, section, row) is a noun of one to three words. Never a sentence, a question, "How …", "Who …"
      or a verb. The row title names the setting; the control says the value.
    - A description is optional and is one sentence saying what the setting changes. None when the title and the
      control already say it. No second sentence, no steps, no example.
    - Nobody is speaking: no "I", "me", "my". "Your" only to tell the person's thing from the server's ("Your
      keys"); never "your AI".
    - Things do not act like people: not "answers", "shows up", "finds it by itself", "comes back", "is gone",
      "no longer here". Say the state: "Offline", "Not found", "Added".
    - A full stop ends a description. Never a title, button, menu item, status, badge or option.
    - A confirm says what is removed in one sentence, and what is kept only when the person would fear losing it.
      No promise about what is read, collected or sent.
    - An empty list is "No <things>" and its one button. What is missing is "Needs <the thing as Settings names
      it>". A state that is fine shows nothing, or the green mark (`InUse`).
    - Names: computer ("This Mac" and "Mac app" only as the names of those two; never device, machine, worker,
      helper, pairing), workspace (never project, team or brand for it), team (the people on a server, nothing
      else), server (never site or cloud, apart from the name Creator Toolset Cloud), AI provider (never your AI,
      own AI, connected AI), key (an outside service's) and access key (Headless access), Media Library, social
      account (Instagram …) and sign-in (Google, Apple).
    - Verbs: Add (bring in something that exists), New … then Create (make one), Save (an edit), Change (replace
      one value), Remove (off a list; the thing still exists), Delete (the thing is destroyed), Disconnect (end a
      sign-in to an outside service), Turn on / Turn off, Test, Retry, Clear (a cache), Empty (the trash).
    - A trade word (MCP, Bearer, PATH, .env) needs its meaning beside it or a plain word instead.
    - A search row's title (`search.ts`) is the title on the page, word for word.
  - **Settings controls and saving** (owner, 2026-11-16). `settings-wording.test.ts` holds the mechanical ones.
    - A switch's title names what is on while the switch is on: the title followed by "on" reads right. No negative
      ("Don't show …"). Never "Enable" / "Disable": in a sentence it is "Turn on" / "Turn off".
    - A row's title does not repeat its section's or its page's words (inside "Notifications" the row is "Email"). A
      page with one section does not print the page's name again as the section's title: a `Section` titled as its
      page prints no title (the frame gives the page's title, `PageTitleContext`), and its action stays at the right.
    - The line under a title never restates the title. Where the control does not show the current value (a button
      that opens a dialog), the line is the value ("Every Monday at 9:00", a folder's path).
    - A switch is only for a change that applies at once. In a form with Save or Create, an on/off choice is a
      checkbox.
    - A page, card or dialog either saves each change at once, or is a form with one Save. Never both in one card,
      never a Save per section. Save is never hidden or greyed out while its form is on screen: pressed with
      something missing, it says what is missing, at the field (`required`). A submit that is busy may show it.
    - A control that saves its value at once (a switch, a select, a field that commits) wraps the save in `markSave`
      (`page-action.tsx`), a save kept in the browser or told to the Mac app too: the header says "Saving", then
      "Saved". An action that adds or removes a row needs none. Beyond that, a save is confirmed only when the change
      cannot be seen on screen. A save that fails keeps what the person
      typed.
    - A main switch at the top of a section turns off everything under it, and the rows under it show only while it
      is on.
    - A page with more than about a dozen rows is split. A folded "Advanced" block needs three rows or more.
    - An error says what happened and what to do next ("Could not load folders" with Retry; "Needs an AI provider").
  - **App wording** (owner, 2026-11-16: "the same kind of language audit" for the whole app). Every screen, toast,
    tooltip and server message a person reads follows "Settings wording" above (`src/app-wording.test.ts` holds the
    mechanical ones, and the few lines kept as the owner's own); what that bullet does not say:
    - **AI is the default here, so nothing is labelled as AI.** No "AI", "by AI", "AI-made", "smart" on an option, a
      button, a badge or a section: say what the thing does ("Automatic", "Descriptions", "Suggested"). No wand or
      sparkle icon: `CtMark` on what is made for the person, else the icon of what the button does. Allowed: the
      names AI Editor, AI provider, AI apps, and a sentence that must name it to be true.
    - A label is a noun of one to three words, or for an action a specific verb with its object ("Delete video",
      "Add folder"); never "OK", "Yes", "Got it". No full stop on any one-line label, badge, tab, status or option.
      A field's label says what goes in it; with a label there is no example placeholder.
    - Running text is optional and one sentence. An empty list is "No <things>" and its one button; an empty tool
      screen is a place to drop the raw material with its one button. No line that only says a feature exists.
    - States: fine shows nothing. Missing is "Needs <thing>". Work in progress is what is being done, with a count
      where there is one ("Transcribing", "Uploading 3 of 12", "Queued"). An error is "Could not <verb> <thing>" with
      Retry beside it, never a raw server line, a status code or blame; a thing that is not there is "<Thing> not
      found". A toast only when the change cannot be seen, in a few words.
    - Names: the tools by their Home names (`HOME_TILE_NAMES`: Content Analyzer, Content Workshop, Media Library …,
      never "the Analyzer", "Workshop", "the library" for the tool). Captions are the lines on a video; the text under
      a post is its post description. Video Notes holds recordings, the Media Library clips, the Designer designs; a
      Content Analyzer group of posts is a topic; the Content Workshop's panels are Writing, Chat and Browse. This
      computer / Server, never "this device" or "cloud". One spelling: colour.
    - Verbs, beside the Settings list: Edit (open to change), Rename, Export (make a file; never "render" on a
      button), Download (get it), Upload, Copy, Share, Send to <tool>, Analyze (the Content Analyzer's run). Cancel
      stops what has not happened; Stop stops what is running. In a sentence it is still "try again later".
    - A tooltip may keep a how-to that is said nowhere else, and a credit or licence line stays. Cut the visible
      paragraph, never the only place a fact lives.
    - A screen that asks the person something by design keeps its question: first-run setup's titles ("What do you want
      to do first?", "Where are your videos?", "How do you work best?"), the new chat screen ("What should we make?"), the
      chat list's "Needs you". The owner's own labels stay as they are: "Write it for me", "My words only", "New edit
      defaults", "Headless access", "Sign-in code", the Media Library's "Standard" / "Automatic" / "None", the
      rolls A-roll and B-roll, the grade panel's control names.
    - Not app wording: what the AI writes, the prompts, and the tool definitions an AI reads (`api/mcp.ts`,
      `api/mcp-tools/`; a change there needs the store check first).
- Plug-ins get in two ways. Compiled in: `scripts/plugins.mjs` writes the registries at build time. From a folder,
  on the Mac app's own server only: `scripts/plugin-build.mjs` builds one folder by itself, `api/lib/folder-plugins.ts`
  loads what the Mac app says is on (`apps/mac` `Plugins.swift` keeps the person's Switch on clicks) and
  `src/lib/folder-plugins.tsx` adds the page halves before the first render. A screen reads the plug-in list when it
  is drawn, never when its file loads. A folder plug-in that fails is left out and named; it never stops the app.
- A move with an opposite (a status, a place, the trash, a pin) can be taken back: once the server has it, call
  `undoable(what, back, count)` (`src/lib/undo.ts`). It shows the notice with Undo and owns ⌘Z while the notice is up.
  `back` puts each thing where it was through the routes that exist; a move with no way back (a delete that removes
  files) gets none.
- Long-running work (exports, enhancement, the Mac relay) runs in background queues with concurrency limits set
  by environment variables; keep those limits when you add work to them.
- Status fields (jobs, sessions, sources, exports): the union lives once (a `contracts/` file or the module's
  `as const` array, which the client imports, never retypes), its allowed moves sit next to it as a `Moves` table
  (`apps/captions/contracts/transition.ts`; `api/lib/transition.ts` hands it on), and every write goes through `move()` (`canMove()` in background loops;
  a route answers 409). Reads never write: a stale `running`/`processing`/`thinking` is reconciled once at startup.
  A table nothing passes to `move()`/`canMove()` fails `transition.test.ts`; a status only its own run writes needs none.
- Work that answers later (a job, a request, an `await`) checks it is still wanted before it writes:
  - A row in SQLite: the write names the state it expects (`WHERE id = ? AND state = 'running'`), so a late answer
    never moves a job stopped meanwhile (`api/library/jobs.ts`).
  - A screen: what is in flight is state its button reads, so the button is off while it runs; a ref alone is not
    enough. An answer for something that changed since (another project, a dialog opened again, Cancel) is dropped.
  - The Mac and iPhone apps: after an `await`, compare the server, token or run with the one that asked, then assign.
