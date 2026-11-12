# Creator Toolset for iPhone

The phone side of Creator Toolset: talk to your AI, get footage into the Media Library, watch your finals and read
your scripts while you film. It talks to any Creator Toolset server: the one on your own computer, your own server,
or a hosted one.

Tabs:

- **Chats**: the app's Assistant, the same chat as on the computer.
- **Upload**: pick clips from Photos or Files, then Upload. Each file is copied into the app first, then sent in
  32 MB chunks (or straight to the library's storage bucket) by background transfers: uploads carry on with the
  phone locked or the app closed, and resume from the server's own byte count after a dropped connection. The server
  says when a file is already in the library.
- **Finals**: what is ready to post, then the finished pieces, each version in the iPhone's player.
- **Scripts**: the Workshop sessions that are ready to film, read big, scrolling on their own, and filmed with the
  script on screen (takes go to Photos).
- **More**: your computers, the account, the Media Library, the rest of the web app signed in, and Wi-Fi-only uploads.

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
goes only to creatortoolset.com.

## Build and test

Xcode 26 or newer.

```sh
pnpm build:ios                         # simulator build
pnpm test:ios                          # unit tests (IOS_SIMULATOR=… picks the device)
```

The tests in `ServerTests.swift` run against a real server when one is given, and are skipped otherwise: sign-in,
the one-time sign-in link, a 70 MB upload in three chunks, the duplicate answer, and the routes each screen reads.

```sh
TEST_RUNNER_CT_TEST_SERVER=http://127.0.0.1:43127 TEST_RUNNER_CT_TEST_PASSWORD=<APP_SECRET> pnpm test:ios
```

Run the server with a scratch `DATA_DIR` for this: the test signs in as `admin` and adds files to its library.
`-startTab <0-4>` as a launch argument opens that tab (for simulator screenshots); in a debug build
`-signinDemo list|none|password|old|add|problem|partly|code|setup` shows the sign-in screen with a made-up account and asks no server anything
(`-servers '<hex of a saved list's JSON>'` gives one launch a connected computer, so the tabs show).

The server side of the contract is `apps/captions/api/ios-contract.test.ts` with
`apps/captions/api/__fixtures__/ios-public-paths.json`: every path the app calls. Add a path there when the app
starts calling it.

## On a phone, and TestFlight

Open `CreatorToolset.xcodeproj`, pick your team under Signing & Capabilities and run. To upload a build to App Store
Connect: `DEVELOPMENT_TEAM=<team id> pnpm --filter @creator-toolset/ios ios:archive` (the bundle id needs an App
Store Connect record under that team; a fork changes `PRODUCT_BUNDLE_IDENTIFIER` first).
