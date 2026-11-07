# Creator Toolset (the Mac app)

A Mac app (macOS 14+, SwiftUI; Sparkle for updates, the only package) that opens the Creator Toolset site in
a window and adds what a browser tab can't: this Mac as an AI device in the menu bar, Review
notes as Mac notifications, and a Dock badge.

## Why it is a shell

The app is a thin native shell around the same web UI, plus the local runner
it supervises: the web stays the one UI. A fix on the site reaches
the Mac app on the next load, and freelancers, guests and the demo keep using the website.
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

With no signing identity the app is ad-hoc signed: it runs on the Mac that built it, but other Macs
refuse it. With no `SPARKLE_PUBLIC_KEY` and `FEED_URL` the app has no updater; Check for Updates does nothing.
Notarize a Developer ID build yourself with `xcrun notarytool submit … --wait` and `xcrun stapler staple`
before you hand it out.

The Mac app's site address is a setting, not a build setting: the default is `https://creatortoolset.com`,
and **Mac settings…** changes it (or `defaults write com.creatortoolset.mac siteAddress https://your.site`).

Notifications need the `.app` bundle (`UNUserNotificationCenter`), so `swift run` won't do.
The bundle id is `com.creatortoolset.mac`; the icon is `AppIcon.png` (1024 px), converted to `.icns` by the
build script.

## Download and updates

The site can serve the app's download and its Sparkle appcast (`apps/captions/api/mac-app.ts`). With
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
- Log in once. The login lives in WebKit's own persistent store, so it survives relaunches.
- **Go** menu: ⌘1 Home, ⌘2 Workshop, ⌘3 Analyzer; ⌘[ and ⌘] go
  back and forward; ⌘R reloads. The routes are the ones in `apps/captions/src/App.tsx`.
- **Settings** (⌘,) opens the site's Settings page in the window. **Mac settings…** (the menu bar)
  is this app's own: the site address (default `https://creatortoolset.com`; use
  `http://localhost:3000` for the dev server) and **Use this Mac for my AI**.
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
- the toggle **Use this Mac for my AI**;
- **Open Creator Toolset**, **Open Workshop**, **Open app log**, Settings, Mac settings, Check for Updates, Quit.

## Runs your AI

Any signed-in account can use this Mac for its AI. Turn
**Use this Mac for my AI** on (menu bar or Mac settings; off by default). The first time, the app
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
- `UserDefaults`: the site address, the AI-on flag, this Mac's device id per site, and the ids of notes
  already shown (random ids, no content).
- `~/.cache/creator-toolset/workshop/`: a Workshop session's folder while its Claude session is kept (14 days).

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
- `Sources/CreatorToolsetMac/Logic.swift`: the pure helpers the tests cover.
- `Tests/CreatorToolsetMacTests/LogicTests.swift`: the pure helpers (site address, cookies, downloads, notes).
- `Tests/CreatorToolsetMacTests/RelayTests.swift`: the relay offline (request checks, command line,
  env, stream, usage, folder, sessions, report). `CT_REAL_CLAUDE=1 swift test --filter RealRun`
  makes one real `claude` call through `~/.claude-work` (a fraction of a cent).
- `scripts/build-app.sh`: builds the `.app` (the environment variables above).

## Not checked yet

The app has not been launched on a Mac in this build (so far it has been built and unit-tested).
Drag-and-drop, the notification banners and the menu bar item still need
a manual check by the owner. The device runner has run one real Claude call and a full job against a
local stand-in for the site's routes; pairing against the real site and the Keychain prompt on first
pairing still need a check on a signed build.
