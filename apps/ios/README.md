# Creator Toolset for iPhone

The phone side of Creator Toolset: talk to your AI, get footage into the Media Library, watch your finals and read
your scripts while you film. It talks to any Creator Toolset server: the one on your own computer, your own server,
or a hosted one.

Tabs: Chats · Edits · Upload · Finals · More (Edits and Finals only for an account that has them; each tab's badge
counts what waits there). The app follows the phone's light or dark look:

- **Chats** opens first: the assistant's chats, one row each, with a badge when one asks you something. The round
  button starts a new chat. Replies are text only: a picture in a reply keeps its description, and the app never
  loads an address a reply names. A photo or video sent with a message goes into the workspace's Media Library by
  Upload's own road (one the library has already is not added again), and the reply waits until every file is ready:
  uploaded, and where the library blurs faces, copied to the main computer and blurred there. Each file says where
  it is ("Uploading · 40%", "Waiting for the main computer", "Blurring") and the reply what it waits for; one that
  failed says why, with Retry. The message can be sent and the app closed: the server starts the reply by itself. On
  an older server, and in a workspace whose Media Library is a plug-in's, a video goes up as the chat's own file.
  Which of the two is asked of the server as the upload begins, never guessed: with no connection the message waits,
  Queued, and nothing of it goes up. A file taken off in Upload's Activity before it was in marks its message Not sent.
- **Edits**: each video in Review and each New edit as a card, with the picture of its newest cut, its step and a
  badge when it waits on you; the ones that wait on top, then Working and Done. Swipe a card to dismiss it, or to
  delete a Review video (it stays in Review's trash for 30 days). **New edit** at the top: pick clips from Photos (in
  the order picked), then Start; the clips go up by background transfers and the server starts the edit when the last
  one is in, with the phone locked or the app closed. Its card shows how far it is and opens the edit or its Review
  video; one that stopped offers Try again. The tab is there for an account with the AI Editor or Review. An edit or
  a Review video opens here, from a card, a link in a chat or a notification; each tab keeps its own screens. The
  line that tells the phone what changed is closed while the app is in the background.
- **Upload** is the camera roll. Pick clips and press Upload; they keep going with the phone locked. On a server whose
  Media Library belongs to a plug-in, the clips go there with the same sign-in. The Media Library sits beside the roll.
  A file the server holds for its blur says in Activity how far it is, as in a chat, until it is ready (read every 5
  seconds while it changes, up to a minute apart while it doesn't, and not at all once it failed, until Retry). A file to
  blur always goes up as it is, never as the phone's own 720p copy: the main computer needs the original.
- **Finals** shows what is ready to post and every finished piece: save it to Photos, copy its post description, split
  it into stories, send it to the team or mark it published.
- **More**: the tools the account has (Scripts opens a script to read while filming, with a record button that films
  with the script by the lens; Story Splitter cuts a video into stories on the phone; Caption Studio captions
  a video with the server's own layout and keeps the video on the phone until the server has it; Face Blur, on a
  server with the plug-in `blur-faces`, covers faces in photos and videos from Photos on the phone and saves the
  covered copy to Photos), and Settings: your
  computers, the account, notifications, appearance, Wi-Fi-only uploads and Photos access.

On a server with a plug-in for the AI Editor, each AI Editor edit is a card on Edits and opens its own thread, and the
phone registers for push (then it posts no notifications of its own, so nothing is told twice). Share → Creator
Toolset links your own post to its Workshop project or saves a link to the Analyzer, using the sign-in the app shares
through its keychain group.

## Connecting a computer

Three ways, all on one screen (the first screen, and More → Add a computer later):

- **Sign in with Apple or Google.** The phone signs in to your Creator Toolset account on creatortoolset.com (the
  same account as the Mac app's) and lists your computers: the hosted servers that account signed in to, and the
  computers you added to it. With exactly one, it connects straight away. A hosted server is signed in to with the
  same Apple or Google sign-in; a computer added to the account asks for its own password once. Nothing is asked of
  creatortoolset.com before you press a sign-in button. More → Account → Sign out forgets the account on the phone;
  the computers already connected stay.
- **Scan the code.** On the computer, open Settings → Computers → Add your phone and scan the code with **this app**:
  the code signs in once, so the Camera app would spend it in Safari.
- **Type the address** (an address with no scheme is `http` for a local address and `https` otherwise) and sign in
  with your username and password. A server without sign-in opens with its address alone.

An account with a sign-in code turned on asks for it after the password (here and for a computer on the account): the
six digits from an authenticator app, which the iPhone's Passwords app can fill in, or one of its recovery codes. On a
server that asks every account for a code, one without it is sent to the server's sign-in page to set it up first.

Each sign-in cookie is kept in the Keychain and sent only to its server; the account's token is kept there too and
goes only to creatortoolset.com. The app never sends a request or its sign-in to another site's address, even one the
server passed on. The Keychain items sit in a group the app shares with its Share extension
(`com.creatortoolset.ios.shared`, in both targets' entitlements).

## Plug-ins

The phone learns what the server has the way the computer's app does: `GET /api/plugins` (which plug-ins),
`GET /api/auth/check` (which tools the account has) and `GET /api/library/:id/sources` (whether a plug-in's source
is the Media Library). A plug-in's screens live in `CreatorToolset/Studio/` and show only on a server that has it.

## Build and test

Xcode 26 or newer.

```sh
pnpm build:ios                         # simulator build
pnpm test:ios                          # unit tests (IOS_SIMULATOR=… picks the device)
```

The tests in `ServerTests.swift` run against a real server when one is given, and are skipped otherwise: sign-in,
the one-time sign-in link, a 70 MB upload in three chunks, the duplicate answer, a New edit of two clips (waiting
on its uploads, then started with both as its sources), and the routes each screen reads.

```sh
TEST_RUNNER_CT_TEST_SERVER=http://127.0.0.1:43127 TEST_RUNNER_CT_TEST_PASSWORD=<APP_SECRET> pnpm test:ios
```

Run the server with a scratch `DATA_DIR` for this: the test signs in as `admin` and adds files to its library.
`TEST_RUNNER_CT_TEST_STUDIO=1` when that server has the studio plug-in.
`-startTab <0-4>` or `-startTab chats|edits|upload|finals|more` as a launch argument opens that tab (for simulator
screenshots); in a debug build `-localServer <address>` adds a server without sign-in, `-OpenPath /assistant` (or any
page path) opens its screen on its tab, and
`-signinDemo list|none|password|old|add|problem|partly|code|wrong|setup` shows the sign-in screen with a made-up account and asks no server anything
(`-servers '<hex of a saved list's JSON>'` gives one launch a connected computer, so the tabs show).
`-newEdit YES` opens New edit on Edits, and in a debug build `-newEditFiles <path>,<path>` picks those files.

The server side of the contract is `apps/captions/api/ios-contract.test.ts` with
`apps/captions/api/__fixtures__/ios-public-paths.json`: every path the app calls. Add a path there when the app
starts calling it.

## On a phone, and TestFlight

Open `CreatorToolset.xcodeproj`, pick your team under Signing & Capabilities and run. To upload a build to App Store
Connect: `DEVELOPMENT_TEAM=<team id> pnpm --filter @creator-toolset/ios ios:archive` (the bundle id needs an App
Store Connect record under that team; a fork changes `PRODUCT_BUNDLE_IDENTIFIER` first).

### App Review

The app does nothing without a server, so each submission gives the reviewer a username and password for a test
account on a server with content in it (Tools → Computers → Add a computer → type its address, then the password
sign-in), in App Store Connect's sign-in fields, never in this repository. The notes to paste with it:

- Creator Toolset connects to the person's own Creator Toolset server: on their computer, on their home network
  (`http://` addresses, hence `NSAllowsArbitraryLoads`) or on a server they run. Nothing is hosted for them.
- Native screens: Chats, Upload (Photos to the server, in the background), Finals, Scripts with a prompter camera,
  Face Blur, Story Splitter, Caption Studio. Tools with no screen of their own open the server's web pages.
- Background modes: `audio` keeps a video playing in Picture in Picture and the read-aloud of a reply going with the
  phone locked; `fetch` resumes a waiting upload and looks for what is waiting on the person.
- Account: Sign in with Apple, Google or GitHub makes a creatortoolset.com account. Tools → Account → Delete account
  deletes it; Tools → Settings links the Privacy Policy and Terms.
