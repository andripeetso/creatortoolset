# Creator Toolset (the Mac app)

A Mac app (macOS 14+, SwiftUI; Sparkle for updates, the only package) that opens the Creator Toolset site in
a window and adds what a browser tab can't: this Mac as an AI device in the menu bar, Review
notes as Mac notifications, and a Dock badge.

## Why it is a shell

The app is a thin native shell around the same web UI, plus the local runner
it supervises: the web stays the one UI. A fix on the site reaches
the Mac app on the next load, and a reviewer on a share link keeps using the website.
Nothing here re-builds a screen. The native parts only do what a web page can't: run this
Mac's AI jobs, post notifications, and set the Dock badge.

## Build and run

```sh
cd apps/mac
pnpm mac:build        # scripts/build-app.sh → build/Creator Toolset.app
pnpm mac:open         # launch it
pnpm mac:test         # swift test (the logic and the relay)
```

Build settings are environment variables, read by `scripts/build-app.sh` at build time. None is required:

| Variable | Default | What it does |
|---|---|---|
| `SIGN_IDENTITY` | ad-hoc (`-`) | Code-signing identity, e.g. `Developer ID Application: Your Name (TEAMID)` |
| `SPARKLE_PUBLIC_KEY` | none | EdDSA public key of your Sparkle signing key (`generate_keys` from Sparkle) |
| `FEED_URL` | none | Appcast URL the app reads for updates. Set it together with `SPARKLE_PUBLIC_KEY`, or neither |
| `BUILD_NUMBER` | commit count | Build number, e.g. to test an update locally |
| `NOTARY_PROFILE` | none | A `notarytool store-credentials` keychain profile. With `SIGN_IDENTITY`, the script notarizes and staples the app |
| `SSCD_CACHE` | none | A verified SSCD model folder (`apps/captions/scripts/install-sscd-runtime.mjs`). Unset: the app ships without it and the Video Cleaner's duplicate check skips that score |
| `CT_BUILD_CACHE` | `build/cache` | Where the Node, FFmpeg and fingerprint source downloads are kept between builds |

With no signing identity the app is ad-hoc signed: it runs on the Mac that built it, but other Macs
refuse it. With no `SPARKLE_PUBLIC_KEY` and `FEED_URL` the app has no updater; Check for Updates does nothing.
A Developer ID build needs notarization before you hand it out: set `NOTARY_PROFILE`, or run
`xcrun notarytool submit … --wait` and `xcrun stapler staple` yourself.

The build also makes the server the app runs (`Contents/Resources/server`, about 320 MB, Apple silicon only):
Node 22 (pinned version and SHA-256 in the script), `pnpm build`'s `dist/`, the two packages the server bundle
leaves outside (`onnxruntime-node`, darwin-arm64 only, and `playwright-chromium` without its browser), FFmpeg
and ffprobe (`apps/captions/scripts/install-ffmpeg-runtime-mac.sh`, pinned and checksummed) and the fingerprint
tools (`install-fingerprint-runtime.sh`, which needs `brew install libomp` on the build Mac). Every program in
it is signed before the app; with `SIGN_IDENTITY` they get the hardened runtime, and `node` also gets the JIT
entitlement (`scripts/node.entitlements`). Chromium for caption exports is downloaded on the first export.

A build with the server opens the server on this Mac (next section). **Mac settings… → Run the server on this
Mac** off opens a site instead: the default is `https://creatortoolset.com`, and the Site field changes it (or
`defaults write com.creatortoolset.mac siteAddress https://your.site`). A build without the server (`swift run`)
always opens the site.

## The server on this Mac

`Server.swift` starts `Resources/server/bin/node dist/boot.js` with the working directory `Resources/server`
(so `runtime/ffmpeg`, the fingerprint tools and `dist/public` are found with no setting), `runtime/` first on
its `PATH` (ffprobe), and `NODE_ENV=production`, `PORT`, `HOST=127.0.0.1`, `DATA_DIR`, `APP_SECRET`,
`PLAYWRIGHT_BROWSERS_PATH`, `CT_LOCAL=1` and `CT_EXIT_WITH_PARENT=1`. The window shows "Starting the server
on this Mac…" and opens `http://127.0.0.1:43128` once `/api/health` answers (polled every 200 ms, up to 30 s).

- **Data:** `~/Library/Application Support/Creator Toolset/data` by default (see "Data location"); Chromium goes
  to `…/Creator Toolset/runtime/chromium`.
- **APP_SECRET:** made once (32 random bytes) and kept in the Keychain (service `com.creatortoolset.mac.server`).
  The server makes the owner account, `admin`, with it as the password; see "First run".
- **Port:** 43128, changed in Mac settings (Change port). If something answers there, the app asks it for its
  `environment`: the same id as the data folder's `environment.json` and a pid in `DATA_DIR/server.pid` that is
  this app's `node` means a server left from an earlier run, which is stopped; anything else shows "Port 43128 is
  in use by another program". The app never picks another port by itself, because saved addresses carry it.
- **Crashes:** restarted after 1, 2, 4, 8 s; the fifth crash in five minutes stops trying and the window and
  the menu say "The server stopped. Open server log".
- **Quit:** the app closes the server's stdin, sends SIGTERM, waits up to 10 s, then SIGKILL. If the app itself
  dies, the closed stdin stops the server (`CT_EXIT_WITH_PARENT`).
- **Log:** `~/Library/Logs/Creator Toolset Server.log` (the server's output plus the app's notes about it), `.1`
  past 10 MB; **Open server log** in the menu bar and Mac settings.

### First run

1. The app starts its server and the server makes the owner account (`admin`, password = `APP_SECRET`). Nothing
   is asked: the password stays in the Keychain.
2. Once `/api/health` answers, the app signs the window in by itself: `GET /api/auth/check` with the window's
   cookies, and if that isn't signed in, `POST /api/auth/login` as the owner. The cookie it gets goes into the
   window's WebKit store before the page loads, so the sign-in page never shows.
3. This Mac pairs as the owner's AI device (`POST /api/devices`, see "Runs your AI") with no toggle. On a server
   with `CT_LOCAL=1` the server puts the default Claude provider on the owner's first paired Mac, so the AI answers
   once `claude` is installed and signed in.
4. The page opens the first-run setup (`SetupDialog` in `apps/captions`) inside the window: the account, which
   tools you use, the first project (only for the Workshop or the Analyzer), your AI (only when a ticked tool uses
   it: the Mac's report shows whether `claude` or `codex` is on its PATH or in `~/.local/bin`, `/opt/homebrew/bin`
   or `/usr/local/bin`, the official install and sign-in commands, a check that runs one line through it, and
   "Which plan are you on?", filled in from what `claude auth status --json` itself says), then what's left for
   the ticked tools (all optional). The AI step looks again every 5 s, and the app reports its tools again
   whenever it comes to the front, so a tool installed in Terminal shows up without a reload. These are the same
   screens as Settings; Settings → Setup shows every tool's readiness and runs setup again.

A creatortoolset.com account is not part of this: the server on your Mac works without one.

The app's window is the way in: it has no "open in browser". The server keeps one-time sign-in links
(`POST /api/auth/link`, `GET /api/auth/link/<code>`: one use, 60 s, memory only, never logged) for pairing a phone
later; nothing in the app uses them yet.

### Access from other devices

Off by default: the server listens on `127.0.0.1` only. **Mac settings → Access from other devices** asks for a
password of your own first (twice, 6 characters or more): the app changes the owner's password with
`POST /api/auth/password` (the window gets its new cookie in the same answer), keeps it in the Keychain
(`owner-password`), and restarts the server on every interface (`HOST=0.0.0.0`). Phones and other computers
then sign in as `admin` with that password. The server refuses a sign-in or a sign-in link from any address
but loopback while the owner's password is still `APP_SECRET` (`CT_LOCAL=1`, `api/auth.ts`), so turning the
listener on by hand can't open the account. The pairing QR for phones comes in a later change.

### Data location

**Mac settings → Data location** shows the folder, how much it holds and the free space on its disk, with
**Show in Finder** and **Move…**. Move… takes an empty folder on a disk with room for the data plus 10 %, stops
the server, and moves the folder: a rename on the same disk, else a copy with `ditto` (file modes kept) checked
by file count and size. The app then starts the server there. A copy keeps the old folder until **Remove old
copy**, which puts it in the Trash.

If the data folder is on a disk that isn't connected, the server doesn't start and the window says "Your data is
on *disk*, which isn't connected". It never starts on a new empty folder instead, which would look like lost
data. Connect the disk and reopen the app, or **Choose another folder…** (no copy). Under 10 GB free on the data
disk, the menu bar and Mac settings say so.

Notifications need the `.app` bundle (`UNUserNotificationCenter`), so `swift run` won't do.
The bundle id is `com.creatortoolset.mac`; the icon is `AppIcon.png` (1024 px), converted to `.icns` by the
build script.

## Download and updates

The app's download and its Sparkle appcast are hosted outside this repository; the web app serves neither. With
`SPARKLE_PUBLIC_KEY` and `FEED_URL` set at build time, Sparkle reads the appcast every 4 hours, downloads a
newer build, checks its EdDSA signature and installs it when the app quits (Check for Updates… in the app
menu and the menu bar item). The page inside the window updates with every site deploy: it offers a Reload
when one lands.

- The build number is the repo's commit count (`build-app.sh`), so each release is newer.
- Keep the Sparkle private key somewhere safe. Lose it and installed copies can't take updates any more;
  back it up with `generate_keys -x <file>`.
- Other people's Macs need a Developer ID build and notarization: an ad-hoc one is refused by Gatekeeper,
  and its Keychain token prompts again after every update.

## App log

`~/Library/Logs/Creator Toolset.log` ("Open app log" in the menu bar): launches, page loads that
failed, a page whose web process ended, the page's script errors and a page left blank. A failed
load shows "Can't reach … Trying again" and retries every 5 s; a dead or blank page reloads (a blank
one at most once a minute). A crash of the app itself is macOS's report in
`~/Library/Logs/DiagnosticReports`.

## The window

- No title bar: the page's top bar runs to the window's top edge with the
  window buttons centred in it, and its empty parts move the window (double-click does what
  System Settings says for a title bar). The page leaves room for the buttons on its
  `[data-titlebar]` rows when `<html>` has `mac-app` (`apps/captions/src/index.css`); a new
  top bar that doesn't use `AppBar` needs the attribute. `TitleBar.swift`.
- With the server on this Mac the window signs in by itself ("First run"). For a remote site, log in once: the
  login lives in WebKit's own persistent store, so it survives relaunches.
- **Go** menu: ⌘1 Home, ⌘2 Workshop, ⌘3 Analyzer; ⌘[ and ⌘] go
  back and forward; ⌘R reloads. The routes are the ones in `apps/captions/src/App.tsx`.
- **Links.** The app registers `creatortoolset://`: `creatortoolset://review/<id>?v=2` opens that page in the
  window and brings it forward, also with the window closed. A link to the window's own site handed to the app
  (`open -a "Creator Toolset" <url>`) opens there too. `appHref` in `Logic.swift`.
- **Account.** The first run's step 1 (`src/components/setup/AccountStep.tsx`, through the page's `account` message
  handler) signs in with Apple or Google: the app opens `<account server>/api/account/login/apple?app=1` (or
  `google`) in the system's sign-in sheet, the server ends on `creatortoolset://account?code=<one-time code>`, and the
  app swaps the code at `POST /api/account/token` for a token it keeps in the Keychain (`GET /api/account/me` checks
  it). The name and email become the owner's profile on the server on this Mac (`api/owner-profile.ts`). Until the
  account server's sign-in page redirects to Apple or Google (or while it can't be reached), the step says so and lets
  you go on. A `creatortoolset://account` link is swapped only while a sign-in from this app is in flight, and the
  page's `account` messages are answered only for the window's own page, never a frame inside it. The account
  server is in Mac settings → Account (default `https://creatortoolset.com`; empty = no account step, for your own
  server). `Account.swift`.
- **Settings** (⌘,) opens the site's Settings page in the window. **Mac settings…** (the menu bar)
  is this app's own: **Use this Mac for my AI**, the server (on or off, port, log, Data location,
  Access from other devices), and with the server off the site address (default `https://creatortoolset.com`;
  use `http://localhost:3000` for the dev server).
- File inputs open the Mac's own open panel. Downloads land in `~/Downloads` (a name taken
  gets ` (2)`). `target=_blank`, `window.open` and links to other sites open in the default
  browser.
- Drag and drop: a drop zone on the page gets the files as on the web. A file dropped
  anywhere else is ignored, so it can't replace the page.
- The site's `confirm` and `prompt` show as Mac dialogs; WebKit would otherwise show nothing.

## The menu bar

The icon shows whether this Mac answers AI jobs: moon = off, wand = on, wand with sparkles = running a
job. The menu shows:

- "AI on this Mac: off / on / running N" and the last AI error (see "Runs your AI");
- "Server on this Mac: starting / running on port 43128 / …" when the app runs the server;
- the toggle **Use this Mac for my AI**;
- "Only N GB free on the data disk" under 10 GB;
- **Open Creator Toolset**, **Open Workshop**, **Open app log**, **Open server log** (with the server), Settings,
  Mac settings, Check for Updates, Quit.

## Runs your AI

Any signed-in account can use this Mac for its AI. With the server on this Mac it is on by itself (see "First
run"); for a remote site, turn **Use this Mac for my AI** on (menu bar or Mac settings). The first time, the app
pairs this Mac with the account: `POST /api/devices` with the window's cookies, body `{name, version}`.
The site returns a device token once. The token goes to the Keychain (service
`com.creatortoolset.mac.device`, account = the site's host); the device id goes to
UserDefaults. Turning it off stops the runner and keeps the pairing. **Forget this Mac** also
calls `DELETE /api/devices/:id`. If the site answers 401 to the runner, the token was revoked: the app
drops it and turns the setting off, with a note in the menu.

While it is on, `Relay.swift` long-polls `POST /api/devices/relay/wait` (empty body; 204 = nothing;
up to 4 jobs at once) with `Authorization: Bearer <token>`. Each job runs the way
the Mac relay runs a Claude request (`ClaudeRun.swift`, `ClaudeRequest.swift`):
the official `claude` command-line tool (Claude Code) found on PATH or in `~/.local/bin`, `/opt/homebrew/bin` or
`/usr/local/bin`, never a copy inside another app, signed in through the request's
home folder (its `settings.json` `env` rides along, the API key is dropped), `--permission-mode dontAsk`,
the Workshop folder read with Read, Glob and Grep, streamed text posted to `/api/devices/relay/<id>/text`
(at most every 0.4 s, at least every 20 s), tool calls to `/step`, then `/done` with the answer and its
usage, or `/fail` with the error (and `limit` / `gone` flags). A text post that answers 404 stops the run.
Only Claude runs here: a Grok or Codex request fails with "This Mac runs Claude only for now".
Once at start and hourly the app posts `POST /api/devices/relay/report` (`MacReport.swift`): which
CLIs are installed (with `--version`) and the Claude and Codex config folders, read only. Nothing is ever
written there.

## Notifications and the Dock badge

Every 30 s the app asks `GET /api/review/notifications`. Each new unread item becomes a banner
worded as the bell words it (`NotificationBell.tsx`). A click opens the note's link in the
window and marks it read on the site. The first run shows nothing; it only remembers what is
already there. The Dock badge is the unread count.

The inbox only holds comment, reply, approved, changes, version, ready ,
producing and delivered (a freelancer on a Workshop share link). It has no item for a Workshop
reply finishing or an AI edit failing, so those notifications need a server change in
`apps/captions/api` first. That is not done here.

## What it reads and stores

- The site's API, with the window's own cookies from WebKit's store. The app reads them to
  make the request and does not keep them.
- `UserDefaults`: the site address, whether the server runs here and its port, the AI-on flag, this Mac's device
  id per site, and the ids of notes already shown (random ids, no content).
- With the server: its data folder and log (see "The server on this Mac"), its `APP_SECRET` and, once you set one,
  the owner's password in the Keychain; the data folder's path, the old copy after a move, and whether other
  devices may connect, in `UserDefaults`.
- The runner's folder: `relay/` in the data folder for the server on this Mac (so it moves with the data), else
  `~/Library/Application Support/Creator Toolset/relay/<site>`. In it, `workshop/` holds a Workshop session's
  folder while its Claude session is kept (14 days) and `blobs/` big files by their hash (30 days).

The site's login cookie lives in WebKit's own store for the app (like Safari's), so the login lasts
between launches; Sign out on the site clears it. The one secret the app keeps is the device token of
**Use this Mac for my AI**, in the Keychain (see "Runs your AI").

## Layout

- `Package.swift`: one executable target and its tests.
- `Sources/CreatorToolsetMac/CreatorToolsetMacApp.swift`: scenes, the Go menu, the menu bar
  menu, Settings.
- `Sources/CreatorToolsetMac/Shell.swift`: the web view's behaviour, the state the menu bar
  shows, notifications, the site client.
- `Sources/CreatorToolsetMac/TitleBar.swift`: the window without a title bar (the web view,
  its window buttons and the drag).
- `Sources/CreatorToolsetMac/Relay.swift`: pairing (Keychain), the device API, the runner (slots, poll, report).
- `Sources/CreatorToolsetMac/ClaudeRequest.swift`: a request's options, the `claude` command line and
  environment, the stream reading, usage, folder sync (plain functions).
- `Sources/CreatorToolsetMac/ClaudeRun.swift`: one Claude run (the process, streaming, the answer).
- `Sources/CreatorToolsetMac/MacReport.swift`: the CLIs and config folders the Mac reports.
- `Sources/CreatorToolsetMac/Server.swift`: the server on this Mac (start, health wait, port, crashes, log, stop,
  the owner's password, data location).
- `Sources/CreatorToolsetMac/Logic.swift`: the pure helpers the tests cover.
- `Tests/CreatorToolsetMacTests/LogicTests.swift`: the pure helpers (site address, cookies, downloads, notes).
- `Tests/CreatorToolsetMacTests/RelayTests.swift`: the relay offline (request checks, command line,
  env, stream, usage, folder, sessions, report). `CT_REAL_CLAUDE=1 swift test --filter RealRun`
  makes one real `claude` call through `~/.claude-work` (a fraction of a cent).
- `Tests/CreatorToolsetMacTests/ServerTests.swift`: the restart backoff, the log rotation, the pid check, the
  missing disk, a move's checks, folder sizes and the runner's folder.
- `scripts/build-app.sh`: builds the `.app` with its server (the environment variables above);
  `scripts/node.entitlements`: the JIT entitlement for the bundled `node`.

## Not checked yet

The first run, Access from other devices and Data location (Local server 4–6) are unit-tested
(the server's sign-in rules in `apps/captions/api/local-server.test.ts`, the Mac's checks in `ServerTests.swift`)
but not yet launched: the window's cookie landing in WebKit's store before the page loads, the setup inside the
window, auto-pairing on a fresh data folder, the Keychain prompt for `owner-password` on a signed build, a real
`ditto` move to an external disk and back, and the unplugged-disk message still need a run on a Mac.

The app has not been launched on a Mac in this build (so far it has been built and unit-tested).
Drag-and-drop, the notification banners and the menu bar item still need
a manual check by the owner. The device runner has run one real Claude call and a full job against a
local stand-in for the site's routes; pairing against the real site and the Keychain prompt on first
pairing still need a check on a signed build.
