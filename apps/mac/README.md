# Creator Toolset (the Mac app)

A Mac app (macOS 14+, SwiftUI; Sparkle for updates, the only package) that opens a Creator Toolset server (the one it
runs on this Mac, or your own) in a window and adds what a browser tab can't: this Mac as an AI device in the menu bar, Review
notes as Mac notifications, a Dock badge, and the Screen Recorder (macOS 15 or newer, `Recorder.swift`; on macOS 14
the Record menu says "Screen recording needs macOS 15").

## Why it is a shell

The app is a thin native shell around the same web UI, plus the local runner
it supervises: the web stays the one UI. A fix on the site reaches
the Mac app on the next load, and a reviewer on a share link keeps using the website.
Nothing here re-builds a screen. The native parts only do what a web page can't: run this
Mac's AI jobs, draw an edit's cards, post notifications, set the Dock badge, and record the screen.

## Build and run

```sh
cd apps/mac
pnpm mac:build        # scripts/build-app.sh → build/Creator Toolset.app
pnpm mac:open         # launch it
pnpm mac:test         # swift test (the logic and the relay)
```

**A first run as a new user, beside the released app:** `scripts/fresh-user.sh` builds a copy with its own bundle id
(`com.creatortoolset.mac.fresh`, "Creator Toolset Fresh") into `build/fresh` (`FRESH_DIR=…` for another folder), wipes
only that copy's state (defaults, Application Support "Creator Toolset (fresh)", WebKit, caches, logs, its five Keychain
services), and opens it. `--rebuild` rebuilds first, `--keep` opens it without wiping. Its server uses port 43129 and it
does not claim `creatortoolset://` links. Only a bundle id that extends the released one (`com.creatortoolset.mac.<name>`)
is such a copy (`Identity.swift`); every other id keeps the app's usual names.

Build settings are environment variables, read by `scripts/build-app.sh` at build time. None is required:

| Variable | Default | What it does |
|---|---|---|
| `SIGN_IDENTITY` | ad-hoc (`-`) | Code-signing identity, e.g. `Developer ID Application: Your Name (TEAMID)`. Set = a release build (`CTChannel` in Info.plist) |
| `SPARKLE_PUBLIC_KEY` | none | EdDSA public key of your Sparkle signing key (`generate_keys` from Sparkle) |
| `FEED_URL` | none | Appcast URL the app reads for updates. Set it together with `SPARKLE_PUBLIC_KEY`, or neither |
| `BUILD_NUMBER` | commit count | Build number, e.g. to test an update locally |
| `NOTARY_PROFILE` | none | A `notarytool store-credentials` keychain profile. With `SIGN_IDENTITY`, the script notarizes and staples the app |
| `CT_BUILD_CACHE` | `build/cache` | Where the Node, FFmpeg and fingerprint source downloads are kept between builds |
| `BUNDLE_ID` | `com.creatortoolset.mac` | Bundle id. An installed build keeps its own id, or it can't receive its updates |
| `APP_NAME` | `Creator Toolset` | The name in the menu bar and the Dock |
| `DEFAULT_SERVER` | none | A server added to the Servers list once, on first launch (https, or localhost) |

These can also live in `apps/mac/build.env` (git-ignored; copy `build.env.example`). The file is read first, and a
setting already in the environment wins over it, so `release.sh`'s public feed and key are never overridden by it.

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

A build with the server opens the server on this Mac (next section). Other servers are added by address (see
"Servers"); a build has no default remote site unless its `build.env` sets `DEFAULT_SERVER`. A build without the server (`swift run`) has no "This Mac" entry and
opens the servers you added, or asks for one.

## Servers

The window shows one server at a time: **This Mac** (the bundled server, when the build has it) or a server added by
address. The list is `servers` in UserDefaults, `[{id, name, url}]` for the added ones (This Mac is never stored), and
`currentServer` is the one open (`this-mac`, an added id, or none). `Servers.swift`.

- **Where:** the **Servers** menu in the main menu bar, the same menu in the menu bar item, the picker right of the
  window buttons in the page's top bar (`TitleBar.swift`; the page keeps 124 px for both, `apps/captions/src/index.css`;
  hidden in full screen), and the **This Mac** window.
- **Switching:** ⌥⌘1…⌥⌘9 in the Servers menu. ⌘⇧3–6 are the system's screenshot keys and ⌃⌘ digits reach the
  Workshop's list (`WorkshopSidebar.tsx` treats Control as Command), so the servers take Option-Command. Switching to
  This Mac starts the server here; switching away stops it, and the AI runner follows the window (one runner at a time).
- **Add server:** an address (`https://tools.example.com`; a bare name gets `https://`; http only for this Mac's
  loopback, because the session cookie goes by hand) or a one-time sign-in link from a server you are signed in to
  elsewhere (`…/api/auth/link/<code>`): the window opens the server and loads the link, which signs it in. Otherwise
  sign in on the server's own page. A server already in the list is opened, not added twice. **Rename** and
  **Remove** are in This Mac → Servers.
- **Cookies:** WebKit keeps one store, keyed by host, so each server's sign-in stays its own. Two servers on the same
  host with different ports (two loopback servers) would share it.
- **None picked:** with This Mac's server off and nothing added (or the open server removed) the window shows "Pick or
  add a server": This Mac's server, the added ones, Add server and Run your own server.
- **Migration:** the first launch of this version turns the old `siteAddress` (when set) into an added server and keeps
  This Mac open unless `runServerHere` was off. The old keys are left for older copies of the app.

### Run your own server

**Servers → Run your own server…** opens a window with the short form of `SELF_HOSTING.md`: a server (any small VPS or
a machine at home that stays on, x86_64 Linux with Docker), a DNS A record for the domain, one command on the server
(`apps/captions/scripts/setup-server.sh <domain>`: `.env` with the domain and a random `APP_SECRET`, then
`docker compose up -d --build`; Caddy gets the certificate), Add server, and the person's own keys. **Check** runs
`GET https://<domain>/api/health` (read as two checks, HTTPS valid and the app answering, with what to do for a DNS,
port, certificate or 502 failure: `healthChecks` in `Servers.swift`) and `/api/auth/check` with the window's cookies
for that host (signed in).

## The server on this Mac

`Server.swift` starts `Resources/server/bin/node dist/boot.js` with the working directory `Resources/server`
(so `runtime/ffmpeg`, the fingerprint tools and `dist/public` are found with no setting), `runtime/` first on
its `PATH` (ffprobe), and `NODE_ENV=production`, `PORT`, `HOST=127.0.0.1`, `DATA_DIR`, `APP_SECRET`,
`PLAYWRIGHT_BROWSERS_PATH`, `CT_LOCAL=1` and `CT_EXIT_WITH_PARENT=1`; a release build (one `build-app.sh` signed with
`SIGN_IDENTITY`, marked `CTChannel` in its Info.plist) also passes `CT_CHANNEL=release` and `CT_VERSION` (the app's
version). Ad-hoc builds and `swift run` leave both unset. Plug-ins add `CT_PLUGINS_ON` and `CT_PLUGINS_PAUSED` (see "Plug-ins"). The window shows the CT mark drawing itself
and opens `http://127.0.0.1:43128` once `/api/health` answers (polled every 200 ms, up to 30 s).

- **Data:** `~/Library/Application Support/Creator Toolset/data` by default (see "Data location"); Chromium goes
  to `…/Creator Toolset/runtime/chromium`.
- **APP_SECRET:** made once (32 random bytes) and kept in the Keychain (service `com.creatortoolset.mac.server`).
  The server makes the owner account, `admin`, with it as the password; see "First run".
- **Port:** 43128, changed in This Mac (Change port). If something answers there, the app asks it for its
  `environment`: the same id as the data folder's `environment.json` and a pid in `DATA_DIR/server.pid` that is
  this app's `node` means a server left from an earlier run, which is stopped; anything else shows "Port 43128 is
  in use by another program". The app never picks another port by itself, because saved addresses carry it.
- **Crashes:** restarted after 1, 2, 4, 8 s. The fifth crash in five minutes pauses the plug-ins once, when one is
  on and they are not paused yet, and starts again (see "Plug-ins"); otherwise it stops trying and the window and
  the menu say "The server stopped. Open server log".
- **Quit:** the app closes the server's stdin, sends SIGTERM, waits up to 10 s, then SIGKILL. If the app itself
  dies, the closed stdin stops the server (`CT_EXIT_WITH_PARENT`).
- **Log:** `~/Library/Logs/Creator Toolset Server.log` (the server's output plus the app's notes about it), `.1`
  past 10 MB; **Open server log** in the menu bar and This Mac.

### First run

1. The app starts its server and the server makes the owner account (`admin`, password = `APP_SECRET`). Nothing
   is asked: the password stays in the Keychain.
2. Once `/api/health` answers, the app signs the window in by itself: `GET /api/auth/check` with the window's
   cookies, and if that isn't signed in, `POST /api/auth/login` as the owner. The cookie it gets goes into the
   window's WebKit store before the page loads, so the sign-in page never shows.
3. This Mac pairs as the owner's AI device (`POST /api/devices`, see "Runs your AI") with no toggle. On a server
   with `CT_LOCAL=1` the server puts the default Claude provider on the owner's first paired Mac, so the AI answers
   once `claude` is installed and signed in.
4. The page opens the first-run setup (`SetupDialog` in `apps/captions`) inside the window, three screens
   (`SETUP_PATH` in `src/lib/setup.ts`): **Connect your AI** (a row per AI app on this Mac, whose one button is
   Install, Sign in or Connect, whichever is still missing: `AiPanel.tsx`), **What do you make?** (turns on the
   tools that fit and makes the first project when the account has none) and **How do you work best?** (in the
   app, in your own AI, or both). After "In my own AI" or "Both", **Add Creator Toolset to your AI** follows. The
   AI screen looks again every 20 s and whenever the app comes to the front, so an AI app installed in Terminal
   shows up without a reload. Settings → Tools shows what each tool still needs, and after **Not now** Home keeps
   a **Finish setting up** card that opens setup again.

The optional account sign-in is not part of this: the server on your Mac works without one.

The app's window is the way in: it has no "open in browser". The server keeps one-time sign-in links
(`POST /api/auth/link`, `GET /api/auth/link/<code>`: one use, 60 s, memory only, never logged) for pairing a phone
later; nothing in the app uses them yet.

### Plug-ins

A plug-in is a folder the person's own AI writes into `~/Library/Application Support/Creator Toolset/plugins/<folder>/`
(the `Creator Toolset (fresh)` folder for a copy). Its server half and web half run only when this app says they are on.

- **Switch on** is this app's own alert, a sheet on the window, not a page's: the server takes a copy of the folder and
  builds it (nothing runs yet), then the alert names the plug-in, the folder it is, and what it can reach. The alert
  has no default button: Return does nothing, Escape cancels, and only a click on Switch On records it. The page asks with `plugin:on:<folder>`, `plugin:off:<id>`,
  `plugin:show:<folder>`, `plugins:resume`, `plugins:state` and `plugins:auto:on|off` over the `thisMac` handler,
  honoured only while This Mac shows this app's own server, and only from a page of that server's own host and port
  (`isSite`, `Plugins.swift`).
- **What the alert stops, and what it does not.** It stops a page (the app's own, a plug-in's, any other site), a tool
  the app offers a connected AI, and an accident: none of them can make a plug-in run without the person seeing the
  alert. It does not stop a program that already runs as the person on this Mac, such as an AI with a shell or a
  plug-in's own server half. In the builds that are released the record is in the file-based Keychain (next point),
  and such a program can write the approved copy and the record itself. Closing that needs a provisioning profile.
- **A changed folder** of a plug-in that is on is taken up by this app, by itself, unless **Update automatically**
  (the last row of the Plug-ins list) is off. Every 5 s the app stats the folders the plug-ins were switched on from.
  A folder that is the same at two looks in a row is sent to the server's prepare (a copy and a test build; nothing
  runs). A copy that builds waits until the server has nothing running, then the record takes its fingerprint and the
  server restarts; the window goes back to the page it was on. "Nothing running" is: no row in the menu bar's Running
  list (a Workshop reply being written, a plug-in's work, an AI request on this Mac), the recorder closed, and no
  program started by the server still running (ffmpeg, a build). It does not see an upload in flight or work inside
  the server that starts no program. A version that doesn't build is left out and its row says why. A plug-in taken
  up five times in five minutes (one that writes into its own folder) waits for a click from then on. Switching
  Update automatically off needs no question; switching it back on is this app's alert, because the ask comes from
  the page, where a plug-in's own pages run. With it on, the Switch On alert ends with "Later changes to its folder
  run by themselves unless you switch off Update automatically."
- **A change never gets more than the person agreed to.** The record keeps whether the alert they agreed to said the
  plug-in runs on this Mac (it had a server half). A changed folder that adds a server half to a plug-in with pages
  only is not taken up by itself, whatever Update automatically says: its row says "The new version would run on this
  Mac, so it waits for you." and Use the new version shows the alert that says so. The alert's own sentence is the
  same for both kinds ("It runs on this Mac inside the app, with the app's access to your files, your keys and the
  internet"): a plug-in's page is drawn as the app's own page, signed in as the person, so it can press what they
  can, the provider settings that start a program on this Mac and the assistant included. Pages only is no lesser kind.
- **Nothing before the sign-in.** A folder plug-in with `openRoutes` or `publicRoutes` is left out
  (`api/lib/folder-plugins.ts`): with other devices on, this server answers the whole network.
- **The record** is one Keychain generic-password item: `{ on: { id: { fingerprint, folder, server } }, waits }` (the
  clicks, the folder each was switched on from, whether it ran on this Mac, and Update automatically off as `waits`), service
  `AppIdentity.keychain("plugins")` (`com.creatortoolset.mac.plugins`, a copy's own), account `approved`. A build with a provisioning profile keeps it in the data-protection Keychain, which no other
  program can reach, and never reads the file-based one. A build without a profile can't write there
  (errSecMissingEntitlement, -34018) and keeps the record in the file-based Keychain. That one is weaker: another
  program can change an item there with no prompt (measured on a throwaway item), so it stops an edit to a file, not
  a program that calls the Keychain on purpose. No release has a profile yet (`scripts/app.entitlements` holds the
  microphone and the camera only), so every released build is the weaker case. Nothing about plug-ins goes in
  UserDefaults or a file, except the paused flag (`pluginsPaused`).
- **Env:** `CT_PLUGINS_ON=id:fingerprint,…` (sorted by id, left out when none is on) and `CT_PLUGINS_PAUSED=1` when
  paused, plus `CT_PLUGINS_FOLDERS={"id":"folder",…}` so the server's list tells the folder that is on from another
  folder stating the same id. With paused the server lists the plug-ins that are on and loads none.
- **Restart:** a change (switch on or off, a new version, paused or back on) stops and starts the server without
  counting a crash; the window shows the starting page and loads the page it was on again when the server answers,
  so it sees the new set. Stopping closes the server's stdin and waits half a second before SIGTERM: a plug-in that
  was loading right then is not blamed for it (the server takes its loading mark down first).
- **Time limits** (the server's, `api/lib/folder-plugins.ts` `pluginLimits`): this app ends a server that has not
  answered 30 s after it started, without knowing why. So the plug-ins have 20 s in all before the first answer: 10 s
  for the builds (they run side by side), 8 s for each one's load. One that is too slow is left out and named, the
  others load. Switch On refuses a plug-in whose build does not finish in those 10 s (a tighter limit, 5 s, refused
  a good plug-in on a busy Mac in a real run). A changed folder the server refused is looked into once more 30 s
  later by this app, and only once. In the page, all the page halves together have
  10 s before the first screen (`src/lib/folder-plugins.tsx`).
- **Known limit:** a plug-in that is left out after its file was loaded (it failed a check, or took too long) has
  already run its top-level code in the server, and what that started (a timer, a listener) goes on until the server
  next starts. One that took too long is not loaded again until it is switched off and on or changes; one that failed
  a check is loaded and checked again at each start.
- **Five crashes:** with a plug-in on and not paused, the app pauses them once, logs a line, clears the crash list
  and starts again. Otherwise the server stops trying, as above.
- **This Mac:** a Plug-ins row, shown only while one is on: `N on`, or `Off` when paused, with Switch All Off or
  Switch Back On.

### Access from other devices

Off by default: the server listens on `127.0.0.1` only. The switch **Let phones and other computers sign in**
under **This Mac → Access from other devices** asks for a
password of your own first (twice, 10 characters or more): the app changes the owner's password with
`POST /api/auth/password` (the window gets its new cookie in the same answer), keeps it in the Keychain
(`owner-password`), and restarts the server on every interface (`HOST=0.0.0.0`). Phones and other computers
then sign in as `admin` with that password. The server refuses a sign-in or a sign-in link from any address
but loopback while the owner's password is still `APP_SECRET` (`CT_LOCAL=1`, `api/auth.ts`), so turning the
listener on by hand can't open the account. The pairing QR for phones comes in a later change.

### Data location

**This Mac → Data location** shows the folder, how much it holds and the free space on its disk, with
**Show in Finder** and **Move…**. Move… takes an empty folder on a disk with room for the data plus 10 %, stops
the server, and moves the folder: a rename on the same disk, else a copy with `ditto` (file modes kept) checked
by file count and size. The app then starts the server there. A copy keeps the old folder until **Remove old
copy**, which puts it in the Trash.

If the data folder is on a disk that isn't connected, the server doesn't start and the window says "Your data is
on *disk*, which isn't connected". It never starts on a new empty folder instead, which would look like lost
data. Connect the disk and reopen the app, or **Choose another folder…** (no copy). Under 10 GB free on the data
disk, the menu bar and This Mac say so.

Notifications need the `.app` bundle (`UNUserNotificationCenter`), so `swift run` won't do.
The bundle id is `com.creatortoolset.mac`; the icon is `AppIcon.png` (1024 px), converted to `.icns` by the
build script.

## Download and updates

Releases are on this repository's GitHub Releases page. `scripts/release.sh <version>` builds the app from a clean
checkout of the current (pushed) commit, signs and notarizes it, and makes a draft release with three files: the
disk image, `appcast.xml` (the update feed) and the source of the bundled FFmpeg. Try the disk image, then publish
the draft with `gh release edit v<version> --draft=false`:

```sh
SIGN_IDENTITY="Developer ID Application: …" NOTARY_PROFILE=… apps/mac/scripts/release.sh 0.2.0
```

A release build reads its feed at `releases/latest/download/appcast.xml`, so publishing a release updates every
installed copy. Builds you make yourself have no updater unless you set both `SPARKLE_PUBLIC_KEY` and `FEED_URL`.
With them set, Sparkle reads the appcast every hour, downloads a
newer build, checks its EdDSA signature and installs it when the app quits (Check for Updates… in the app
menu and the menu bar item). The page inside the window updates with every site deploy: it offers a Reload
when one lands.

- The version people see is the one given to `release.sh`; the build number is the repo's commit count
  (`build-app.sh`), so each release is newer.
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
- With the server on this Mac the window signs in by itself ("First run"). For another server, log in once: the
  login lives in WebKit's own persistent store, so it survives relaunches.
- **Go** menu: ⌘1 Home, ⌘2 Workshop, ⌘3 AI Editor, ⌘4 Finals, ⌘5 Analyzer (the server lists the ones the account
  may open, `APP_TOOLS` in `apps/captions/api/activity.ts`; the keys are `appToolShortcuts` in `PluginMenu.swift`);
  ⌘[ and ⌘] go back and forward; ⌘R reloads. The routes are the ones in `apps/captions/src/App.tsx`.
- **Record** menu (macOS 15 or newer): New Recording…, Stop Recording (⌥⌘.), All Recordings (the `/record` page),
  then the recorder's own items: its shortcut, Record Button in Menu Bar, Recordings Folder… and Show Recordings.
- **Links.** The app registers `creatortoolset://`: `creatortoolset://review/<id>?v=2` opens that page in the
  window and brings it forward, also with the window closed. A link to the window's own site handed to the app
  (`open -a "Creator Toolset" <url>`) opens there too. `appHref` in `Logic.swift`.
- **Account.** Setup's **Connect your computers** screen (`src/components/setup/ConnectStep.tsx` shows
  `AccountStep.tsx`, through the page's `account` message handler) signs in with Apple, Google or GitHub: the app
  opens `<account server>/api/account/login/apple?app=1` (or `google`, `github`) in the system's sign-in sheet,
  the server ends on `creatortoolset://account?code=<one-time code>`, and the app swaps the code at `POST /api/account/token` for a token it keeps in the Keychain (`GET /api/account/me` checks
  it). The name and email become the owner's profile on the server on this Mac (`api/owner-profile.ts`). Until the
  account server's sign-in page redirects to Apple, Google or GitHub (or while it can't be reached), the step says so and lets
  you go on. A `creatortoolset://account` link is swapped only while a sign-in from this app is in flight, and the
  page's `account` messages are answered only for the window's own page, never a frame inside it. The account
  server is in This Mac → Account (default `https://creatortoolset.com`, the only place the app names it; empty = no
  account step, for your own server). `Account.swift`.
- **Add this Mac to my account…** (Servers menu): makes the server on this Mac reachable from your other devices
  through the connect service (default `https://connect.creatortoolset.com`, UserDefaults `connectBroker`; empty =
  off). The browser opens the site's page with the code filled in; you sign in and say yes, the page hands back to the
  app (`creatortoolset://connect`) and the tunnel starts. Nothing is sent to the service before that press, or before
  you sign in to an account (then the Servers list shows the account's other computers). `Connect.swift`.
- **Settings…** (⌘,, the one Settings item) opens the server's Settings in the window; with no server picked it opens
  This Mac. The Servers menu and the menu bar item (**This Mac…**) open the native **This Mac** window: Servers,
  **Use this Mac for my AI**, the server here (on or off, port, log, Data location, Access from other devices) and
  the account server; the page's Settings has no entry for it. A page that posts `this-mac` to the `window` message
  handler opens it too. `ThisMac.swift`.
- The page learns this Mac's device id on the open server as `<html data-mac-device>` (a user script, renewed on
  each switch and pairing), so Settings → Providers can say "This Mac (*name*) answers your AI" rather than
  another Mac's name.
- File inputs open the Mac's own open panel. Downloads land in `~/Downloads` (a name taken
  gets ` (2)`). One download is not kept as it is: the screen recording editor's export with no background
  (`….ctalpha.mp4`: every frame's colours and its matte in one H.264 picture) is made into a see-through
  `.mov` (ProRes 4444 with an alpha channel, the sound copied) and shown in Finder (`AlphaVideo.swift`; the page
  offers it where `<html data-mac-record-alpha>` is set). It is large, about 3 GB a minute, so a Save dialog asks
  where it goes and everything is written in that folder; the page hears how far it is (`mac-alpha` events) and its
  Stop ends it (`record-alpha-stop`). `target=_blank`, `window.open` and links to other sites open in the default
  browser.
- **Local files** (`ctlocal://`, `ProjectScheme.swift`): `ctlocal://<recording>/<file>` serves a screen recording's
  files to its editor, with ranges, several requests at once. `ctlocal://media/<base64url of a path>` serves an edit's
  original video and sound files (mov, mp4, m4v, mxf, wav, aif, aiff, m4a, mp3, flac, caf) to Review's player, but
  only from folders you chose in the app's own open panel, which the page asks for with `{ask: folder}` on its
  `mediaAccess` message handler; any other path gets 403, 404 or 415 and no contents (`MediaFiles.swift`).
- Drag and drop: a drop zone on the page gets the files as on the web. A file dropped
  anywhere else is ignored, so it can't replace the page.
- The site's `confirm` and `prompt` show as Mac dialogs; WebKit would otherwise show nothing.

## The menu bar

The icon is a small dark pill with the Creator Toolset mark (the logo's one-stroke C and T, drawn in code from
`ToolsetLogo` in `apps/captions`, `MenuIcon.swift`) and a status dot: a hollow ring when nothing runs here, green
when the server here runs or this Mac answers AI, violet while it runs an AI job, amber when the server here
failed, the last AI job or poll failed, or the data disk is nearly full (`menuStatus` in `Servers.swift`). It is a
colour image, not a template, with a light rim so it reads on light and dark menu bars. A count between the mark and
the dot says how many things wait for you. A click opens a panel (`Activity.swift`):

- **Running**: Workshop replies being written, plug-in work and this Mac's AI requests, each with "Working" on the right;
- **Waiting on you**: Workshop sessions with a new reply ("Ready") and plug-in items waiting; a row opens its page in
  the window. A part shows its label only when it has rows; with neither, one quiet line says so;
- the last AI error, a notice, and "Only N GB free on the data disk" under 10 GB;
- menu rows (`PanelMenuRow`: a title, its key in grey on the right): **Open Creator Toolset**, **Record Screen**
  (**Stop Recording** while it records) and **Settings & More**, which holds "AI on this Mac: …", "Server on this
  Mac: …", **Use this Mac for my AI**, **Screen Recordings** (macOS 15 or newer), **Servers**, **This Mac…**, Settings,
  **Open at login**, **Open app log**, **Open server log** (with the server), Check for Updates, Quit.

`PANEL_SHOTS=<folder> swift test --filter PanelShotsTests` draws the panel with sample rows, light and dark, to PNGs.

Closing the last window takes the app out of the Dock and the app switcher; it stays in the menu bar. A copy in
/Applications opens at login (on once by default; the switch in Settings & More turns it off).

## Runs your AI

Any signed-in account can use this Mac for its AI. With the server on this Mac it is on by itself (see "First
run"); for another server, turn **Use this Mac for my AI** on (menu bar or This Mac). The first time, the app
pairs this Mac with the account: `POST /api/devices` with the window's cookies, body `{name, version}`.
The site returns a device token once. The token goes to the Keychain (service
`com.creatortoolset.mac.device`, account = the site's host); the device id goes to
UserDefaults. Turning it off stops the runner and keeps the pairing. **Remove this Mac from my account** also
calls `DELETE /api/devices/:id`. If the site answers 401 to the runner, the token was revoked: the app
drops it and turns the setting off, with a note in the menu.

While it is on, `Relay.swift` long-polls `POST /api/devices/relay/wait` (empty body; 204 = nothing;
up to 4 jobs at once) with `Authorization: Bearer <token>`. Each job runs the way
the Mac relay runs a Claude request (`ClaudeRun.swift`, `ClaudeRequest.swift`):
the official `claude` command-line tool (Claude Code) found on PATH or in `~/.local/bin`, `/opt/homebrew/bin` or
`/usr/local/bin`, never a copy inside another app, signed in through the request's
home folder (its `settings.json` `env` rides along, the API key is dropped), `--permission-mode dontAsk`,
the Workshop folder read with Read, Glob and Grep (never allowed up front, so Claude Code's own rule keeps them in the
folder and dontAsk refuses any other path; no link stays in a run folder), streamed text posted to `/api/devices/relay/<id>/text`
(at most every 0.4 s, at least every 20 s), tool calls to `/step`, then `/done` with the answer and its
usage, or `/fail` with the error (and `limit` / `gone` flags). A text post that answers 404 stops the run.
The assistant's turns (`asks` with `mcp`) also get this Mac's tools, Bash, Read, Glob, Grep, Edit and Write, in
`~/Library/Application Support/Creator Toolset/assistant/<server>/` (kept between turns), with Claude Code's own permission
rules (`--permission-mode manual --permission-prompt-tool stdio --input-format stream-json`): what Claude Code treats as
safe runs at once, and each question it would ask a person arrives on its stdout as a `can_use_tool` request. The app posts
it to `/api/devices/relay/<id>/ask` every 2 s until the person answers it in the chat (allowed / denied / expired after
10 min) and writes the answer to claude's stdin; a no tells Claude not to try another way. Only the web and the app's MCP
tools are allowed up front. An older server never sends `asks`, so its turns run as before.
The other drivers in `runnableDrivers` run here too (Gemini with `gemini -o stream-json` in plan mode, the prompt on stdin, API keys left out of its environment, its own `~/.gemini`); any other driver fails with `onlyRunnableMessage`.
Codex runs as `codex exec --json`, the prompt on stdin, in a permission profile of its own that reads only its folder
and the system's own files, writes nothing and has no network, and with `--ignore-user-config`, so none of the MCP
servers in the person's `config.toml` are in an app run (`codexArguments`). A Codex without profiles is not run: it is
answered with "too old to run here", which Connect your AI reads as outdated and updates. OpenCode and the other ACP
kinds always run in a fresh folder of the run's own; OpenCode's rules leave it its read, search and listing tools
inside that folder (`acpRules`). An assistant turn (`mcp`) gives Codex the app's MCP server for that run only:
the server's address with `-c mcp_servers.creator-toolset.*`, its calls approved, and the job token in the
`CREATOR_TOOLSET_MCP_TOKEN` variable, never an argument.
Once at start and hourly the app posts `POST /api/devices/relay/report` (`MacReport.swift`): which
CLIs are installed (with `--version`) and the Claude and Codex config folders, read only. Nothing is ever
written there.

## Draws an edit's cards

While **Use this Mac for my AI** is on, the same runner also draws the AI Editor's cards for the account's own edits
(`CardJobs.swift`, `KitRunner.swift`, `CardClip.swift`). It makes no request of its own to find out whether one
waits. The long poll it already holds says which editor kinds this Mac would take now (`"editor": ["cards-draw"]`
beside `blobs` in the body of `relay/wait`), and a server with such a step queued answers that poll with
`{"editor": true}`. Only then does the Mac post `POST /api/devices/relay/editor/claim` with
`{"kinds":["cards-draw"]}`. A server that never answers so, which is every server without the card step, is never
asked. The poll lists no kind while cards are being drawn and for 25 s after a hint that led to no step (an hour
after a claim the server refused), so a server that hints wrongly gets one claim, not a loop. The server can say the
same on its answer to a step's `done` or `fail` (`"editor": true` beside `ok`), and the next step is then claimed at
once; without it the next step is seen on a later poll, up to 25 s on.

A step it gets is read with `GET /api/devices/relay/editor/job/<id>/cards`:
`{ width, height, fps, script, cards: [{ id, seconds, content }] }`, one script for every card of a version. Each card
is drawn frame by frame at that size and rate, made into an H.264 `.mp4` with no sound, plus three PNG stills 540 px
wide (the first, middle and last frame), and posted to `…/job/<id>/cards/<cardId>` as multipart: `clip`, then `still`
three times. What the script leaves unpainted is black. The step ends with `…/done`, or with `…/fail` and a sentence
a person can read ("Card 2 of 6 took longer than 20 seconds to draw."); `…/beat` goes out every 15 s meanwhile. Every
card that drew is sent even when another failed, and the server tries a failed step again, so a card's id can arrive
more than once. A step is one of the runner's four slots and only one is drawn at a time; the menu bar's row says
"Drawing cards". A card that fails is told to the server and written to the app log, never shown as an AI error.

**The script is the person's AI's output and is never trusted.** It runs only in a web view made for that one card
(`KitRunner.swift`), never in the app's window or its pages. What holds it, each measured by a script that tries the
opposite against a listener on this Mac (`KitSandboxTests.swift`):

- The script's page is a sandboxed frame (scripts only) of a page whose Content-Security-Policy is
  `default-src 'none'`: nothing loads or is sent (fetch, sockets, images, fonts, frames, workers), and the engine
  refuses the frame's own navigations, forms and new windows before the app is asked.
- The web view refuses every navigation but that page and that frame. It has no message handlers, cookies or storage
  of the app's, and its own data store is gone with the card. It can read no file.
- Lockdown Mode is on for the page, because the policy does not govern WebRTC. A card's script therefore has no
  WebRTC, WebAssembly, WebGL or Web Audio.
- Lockdown Mode and the preconnect switch below could fail to take without saying so. So before the first card a
  page with no card's script in it is asked two things of its own engine: is WebRTC gone, and does it no longer know
  `preconnect` as a link type (`relList.supports`, which reads the setting the click's preconnect reads). If either
  answer is wrong, nothing is drawn. It has the DOM, CSS, SVG and a 2D canvas, the system's fonts and `data:`
  images.
- WebKit's link preconnect is switched off for the page: a link with `target="_blank"` that the script clicks, or a
  `<link rel="preconnect">`, otherwise opens a connection whatever the policy says. WebKit has no public switch for
  it, so this uses a private one (`_features`, `_setEnabled:forFeature:`, `_isEnabledForFeature:` on
  `WKPreferences`). A Mac whose WebKit lacks one of them draws no card: the step fails with a sentence saying which,
  and from then on its long poll lists no kind (`"editor": []`), so the server stops counting on it.
- Whatever else asks for a name outside this Mac is handed to a proxy address where nothing listens (port 1 on this
  Mac), set on the page's own data store.
- One limit of 20 s covers the whole card: its page loading, every call into the script and every picture. The
  page's process is ended with every card (`SIGKILL` to the process `_webProcessIdentifier` names, another private
  call): a script that loops forever otherwise keeps a processor busy until the app quits, and WebKit's own kill
  does not stop it. Each card's page has a process of its own.

Not measured: a DNS lookup that sends nothing else (the switch for `<link rel="dns-prefetch">` is turned off where
this macOS has it, but nothing here can watch a lookup); the proxy for a bare address outside this Mac (trying one
would be real traffic; a name goes to the proxy); a script that takes memory without end (the limit and the end of
its process stop it, after up to 20 s). See also "Not checked yet".

## Dictation

Talk, and the words are pasted where the cursor is, in any app (`Dictation/`). On for everyone from the first launch,
but nothing asks for a permission and nothing downloads until the first press of a talk key. A model already on this
Mac loads at launch, in the background, so the keys work at once (the first load in a new app takes minutes while Core
ML compiles it, then about 2 s).

- Four keys, each the person's own (`Dictation/DictationKeys.swift`): **Talk** (a key or combination taps to start and
  stop, or a modifier like fn or right ⌥ is held while talking; a hold shorter than 0.3 s, or one with another key,
  does nothing), **History** (the last recordings: copy a transcript, transcribe a failed one again), **Transcribe a
  file** (audio or video, on this Mac) and **Cancel** (the recording or the transcription in progress; nothing is
  pasted, History still gets it). The first keys: F13–F16 on a keyboard that has them (Apple's full-size ones, by name)
  or where dictation ran before; otherwise hold fn to talk and no key for the other three (the menu bar panel and
  Settings open them). Bound keys are taken from macOS, so its own brightness keys don't also act on F14/F15.
- Each key is chosen in the key picker the recording shortcut also uses: a key with ⌘, ⌥ or ⌃, or a function key
  alone; Talk also takes a modifier pressed and let go on its own. A key another action or the recording shortcut has
  is refused with a sentence. While the picker is open no key works, so pressing one chooses it.
- The first press of Talk, or the menu bar's Dictate, opens the setup page (`Dictation/SetupGuide.swift`) until it was
  gone through once (Get Started, or closed); Settings' Set up opens it any time. One page: the talk key, the languages
  (the server's Voice languages, else the Mac's, until ticked), Microphone and Accessibility with their own Allow,
  where speech turns into text (this Mac's model with its download, or your speech server), and Get Started once both
  permissions are given. Opening it starts loading the model, or downloading it when it is not here and no speech
  server is set. Nothing opens it by itself at launch. Later presses while something is missing use the pill at the bottom of the screen: what to allow, with the System
  Settings pane, and the download's progress. Before Accessibility no key tap can exist, so the keys are Carbon
  hotkeys and the hold key is read from the modifier state ten times a second (a hold of 1 s with no other key counts
  as the first press). Switching dictation off stops a download in progress.
- A speech server of the person's own (Settings → Speech server, empty by default; the earlier dictation app's is
  taken over once): each recording is POSTed to it as a WAV and its `{"text"}` used; when it doesn't answer in
  4 s plus a quarter of the recording's length, this Mac's model writes it down. With no model on this Mac, nothing
  downloads then: the recording waits in History. While the model is still loading, the pill says "Getting the speech
  model ready" instead of counting seconds.
- Speech becomes text on this Mac with Whisper (WhisperKit, Core ML); the default model is Whisper Large v3 Turbo
  (1.6 GB) in `~/Library/Application Support/Creator Toolset/dictation/models`. A complete copy in the earlier
  dictation app's models folder is loaded where it is, never downloaded again or removed. Whisper is told the languages from the server's Voice settings (`GET /api/voice-prefs`) when it has
  them, else it chooses among the Mac's own languages.
- The text is pasted with ⌘V through the clipboard, which is put back once the app has read it; a password field
  gets nothing. Recordings and transcripts are kept in `dictation/recordings` (the last 10 by default).
- Settings → AI → Voice → Dictation on the site shows and sets it (`thismac-dictation:<what>:<value>`,
  `Dictation.bridgeState`); the app keeps the values in `UserDefaults` (`dictation.*`). The earlier dictation app's
  choices are taken over once (F13–F16, with its hold key as Talk if it had one).
- While that earlier app runs (by bundle id, `Dictation.earlierAppOpen`, from NSWorkspace's launch and quit
  notifications) dictation here registers no key, Carbon or tap, and a recording or transcription in progress pastes
  nothing; Settings says so in one line. Its keys come back when that app quits. The menu bar's Dictate then reads
  "Dictate here": a click quits that app and switches dictation on here.

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
- `UserDefaults`: the servers and the one open, the server's port, the AI-on flag, this Mac's device
  id per site, the ids of notes already shown (random ids, no content), and the folders whose original media files
  the page may play (`mediaFolders`).
- With the server: its data folder and log (see "The server on this Mac"), its `APP_SECRET` and, once you set one,
  the owner's password in the Keychain; the data folder's path, the old copy after a move, and whether other
  devices may connect, in `UserDefaults`.
- Plug-ins: the record of the Switch On clicks (ids and fingerprints) in the Keychain (see "Plug-ins"); whether
  they are paused, in `UserDefaults`.
- The runner's folder: `relay/` in the data folder for the server on this Mac (so it moves with the data), else
  `~/Library/Application Support/Creator Toolset/relay/<site>`. In it, `workshop/` holds a Workshop session's
  folder while its Claude session is kept (14 days) and `blobs/` big files by their hash (30 days).
- `~/Library/Application Support/Creator Toolset/assistant/<server>/`: the assistant's own folder (its working folder on this Mac).
- `cards/<step>/` in the runner's folder: the clip of the card being drawn, removed when its step ends.

The site's login cookie lives in WebKit's own store for the app (like Safari's), so the login lasts
between launches; Sign out on the site clears it. The one secret the app keeps is the device token of
**Use this Mac for my AI**, in the Keychain (see "Runs your AI").

## Layout

- `Package.swift`: one executable target and its tests.
- `Sources/CreatorToolsetMac/CreatorToolsetMacApp.swift`: scenes, the Servers and Go menus, the menu bar
  menu, the "Pick or add a server" screen.
- `Sources/CreatorToolsetMac/ThisMac.swift`: the This Mac window and the Run your own server guide.
- `Sources/CreatorToolsetMac/Servers.swift`: the server list, Add server's input, the guide's health reading and the
  menu bar status (plain functions).
- `Sources/CreatorToolsetMac/MenuIcon.swift`: the menu bar pill.
- `Sources/CreatorToolsetMac/Shell.swift`: the web view's behaviour, the state the menu bar
  shows, notifications, the site client.
- `Sources/CreatorToolsetMac/TitleBar.swift`: the window without a title bar (the web view,
  its window buttons and the drag).
- `Sources/CreatorToolsetMac/Relay.swift`: pairing (Keychain), the device API, the runner (slots, poll, report).
- `Sources/CreatorToolsetMac/ClaudeRequest.swift`: a request's options, the `claude` command line and
  environment, the stream reading, usage, folder sync (plain functions).
- `Sources/CreatorToolsetMac/ClaudeRun.swift`: one Claude run (the process, streaming, the answer).
- `Sources/CreatorToolsetMac/MacReport.swift`: the CLIs and config folders the Mac reports.
- `Sources/CreatorToolsetMac/CardJobs.swift`: one card step (the read, each card, the upload, done or fail, the lease).
- `Sources/CreatorToolsetMac/KitRunner.swift`: the web view a card's script is shut in, its time limit and its frames.
- `Sources/CreatorToolsetMac/CardClip.swift`: a card's frames as an H.264 clip and three stills.
- `Sources/CreatorToolsetMac/Server.swift`: the server on this Mac (start, health wait, port, crashes, log, stop,
  the owner's password, data location).
- `Sources/CreatorToolsetMac/Plugins.swift`: plug-ins (the asks, Switch on's alert, the record in the Keychain, the
  paused flag, the server's environment and the five-crash rule).
- `Sources/CreatorToolsetMac/Dictation/`: dictation (`Dictation.swift` the settings, the first press and the keys'
  routing; `Keys.swift` the taps; `Audio.swift`, `HALInput.swift` the microphone; `Whisper.swift` the model;
  `Controller.swift` the loop; `Paste.swift` the paste; `Pill.swift`; `History.swift` History and Transcribe a file).
- `Sources/CreatorToolsetMac/Logic.swift`: the pure helpers the tests cover.
- `Tests/CreatorToolsetMacTests/LogicTests.swift`: the pure helpers (site address, cookies, downloads, notes).
- `Tests/CreatorToolsetMacTests/AlphaVideoTests.swift`: the see-through video (the packed download's name and
  halves, one frame joined by hand, a small packed file converted for real with its sound, a file that is no video).
- `Tests/CreatorToolsetMacTests/ServersTests.swift`: the list (migration, This Mac, add, rename, remove, none picked),
  Add server's input, the guide's health reading, the menu bar status and the page's device marker.
- `Tests/CreatorToolsetMacTests/RelayTests.swift`: the relay offline (request checks, command line,
  env, stream, usage, folder, sessions, report). `CT_REAL_CLAUDE=1 swift test --filter RealRun`
  makes one real `claude` call through `~/.claude-work` (a fraction of a cent).
- `Tests/CreatorToolsetMacTests/KitSandboxTests.swift`: what a card's script can't do (reach the network, read a file,
  leave its page, run past its limit, leave a process behind), each beside a control that can.
- `Tests/CreatorToolsetMacTests/CardJobsTests.swift`: a card step against a stand-in server (`FakeSite.swift`): the
  claim and its pace, the read, the upload, each way a step ends. `CT_CARD_REPORT=<folder> swift test --filter
  testReportOneCard` writes one card's clip and stills there.
- `Tests/CreatorToolsetMacTests/CardClipTests.swift`, `KitRunnerTests.swift`: the clip, the stills, the frames.
- `Tests/CreatorToolsetMacTests/ServerTests.swift`: the restart backoff, the log rotation, the pid check, the
  missing disk, a move's checks, folder sizes and the runner's folder.
- `Tests/CreatorToolsetMacTests/PluginsTests.swift`: the plug-in asks, the server's environment, the Switch on
  alert's words, the five-crash rule, and the record (its Keychain round trip uses its own test service).
- `scripts/build-app.sh`: builds the `.app` with its server (the environment variables above);
  `scripts/node.entitlements`: the JIT entitlement for the bundled `node`.

## Not checked yet

The first run, Access from other devices and Data location (Local server 4–6) are unit-tested
(the server's sign-in rules in `apps/captions/api/local-server.test.ts`, the Mac's checks in `ServerTests.swift`)
but not yet launched: the window's cookie landing in WebKit's store before the page loads, the setup inside the
window, auto-pairing on a fresh data folder, the Keychain prompt for `owner-password` on a signed build, a real
`ditto` move to an external disk and back, and the unplugged-disk message still need a run on a Mac.

The card step (see "Draws an edit's cards") has run only in the tests, on macOS 26 on Apple silicon, against a
stand-in for the server: not in the launched app, not in a signed build with the hardened runtime, not against a real
server, and not on macOS 14 or 15. For those, WebKit's source as it shipped with 14.0 and 15.0 was read: it has
every call the card's page uses (the feature list and its switch, the link preconnect feature behind which the
click's preconnect sits, the page's process id, Lockdown Mode for one page), so they are expected to draw. Each call
is looked for before it is used, and a Mac that lacks one draws no card and says which. Whether
Lockdown Mode for a page shows anything the first time in a real app bundle, and what the drawing costs the window
while a person uses the app or records (each frame is taken on the main thread, at the screen's scale), are not known.

The app has not been launched on a Mac in this build (so far it has been built and unit-tested). The plug-ins'
alert, the record's Keychain path on a signed build, the restart's page reload and the five-crash pause have not
been run on a Mac either.
Drag-and-drop, the notification banners and the menu bar item still need
a manual check by the owner. The device runner has run one real Claude call and a full job against a
local stand-in for the site's routes; pairing against the real site and the Keychain prompt on first
pairing still need a check on a signed build.
