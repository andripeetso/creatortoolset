# Media Library: blurred copies and proxies — plan

Status: built, 2026-11-25 (draft 5 with the owner's answers: §2, D3, D6, R13). Everything in §5 and §6 is in the code
but for the three lines of §7a. Tool: Media Library, with the Face Blur plug-in (`editor-steps/blur-faces`,
`docs/face-blur-intake-prd.md`). Replaces draft 3 (proxies alone).

## 1. The rule

Every clip is one chain, and each copy is made from the one before it:

```
Original  ─►  Blurred copy  ─►  Proxy
(as filmed)   (Blur faces on,    (Generate proxies on,
               the clip has       where one is needed: §2)
               faces)
```

- A clip with no blurred copy (Blur faces off, no face found, kept as filmed) skips that step: its proxy is made from
  the original.
- **Blur faces** and **Generate proxies** are two switches. Neither changes the other.
- A switch decides for files added from then on. Files already in the library are touched only by a press: What's made
  → Blurred copies or Proxies → Make N missing.
- Final renders use the blurred copy, or the original where the clip has none. Never the proxy.
- Blur is not a privacy wall inside the team. It matters in what is rendered. One promise stays: under Blur faces the
  server never keeps or shows the original of a clip with faces. A file from a phone passes through it, held, on its
  way to the computer that blurs it (R13).

## 2. What a proxy is for

Three reasons were named for proxies (owner, 2026-11-25). Each against the code:

| Reason | Needed? | Why |
|---|---|---|
| Lighter for the AI | No | Analysis makes its own small pieces from the file where it is: stills for descriptions (`work/library.ts:104` `cutStills`), contact sheets for shot descriptions and a small copy for a watch (`library/mac-look.ts`), sound for transcripts (`on-mac.ts`). A proxy is read when one is there (`shots.ts:28`, `timeline.ts:31`), never required |
| Editing in the Editor | Yes, later | The one place a proxy of every clip pays: scrubbing and previews. Parked with the Editor (§8) |
| Heavy or unplayable files | Yes, built | A clip the app can't play (a camera format) or over 1080p gets one (`media/proxy.ts` `needsProxy`) |
| The team and the server (not named) | Yes, built | With Upload → Proxies on, every video gets one: it is all the server and teammates have |

So **Generate proxies** means: a proxy where one is needed. That is a clip this computer can't play smoothly, and
every video while Upload → Proxies is on. It does not mean a proxy of every clip kept on the computer; that is decided
with the Editor.

**The main job of a proxy is the team's copy** (owner, 2026-11-25): a light file of every clip on the server, so the
people who share the library can watch it. For a library that blurs faces and shares with a team the setup is Blur
faces on, Generate proxies on, Upload → Proxies on: the server then holds one light copy of each clip, blurred where it
has faces.

## 3. Decisions

- **D1 Frame rate.** Every copy keeps its original's frame rate, always. A 119.88 fps clip gives a 119.88 fps blurred
  copy and a 119.88 fps proxy. Size, bitrate and codec may change; frame count and timing never do. No encode sets a
  rate.
- **D2 Where copies are written.** Blurred copies: the library's `Imports/Blurred` folder (Settings → Face Blur →
  Output can change it). Proxies: the computer's Download location (Settings → Storage). No new choice is added, and
  nothing is written to the internal disk because another disk is missing.
- **D3 Upload, under Blur faces.** Two rows, and what goes up is what is ticked, nothing else. **Blurred** sends each
  clip's blurred copy as it is, and a clip with no faces to blur as filmed (owner, 2026-11-25: "they should go up").
  **Proxies** sends the proxies and shows only while proxies are made. Proxies alone means only proxies go up.
- **D4 Words.** On screen the three files are Original, Blurred and Proxy (File row, Location menu, Upload rows); in a
  sentence "blurred copy". Never "blurred proxy".
- **D5 Nothing changes by itself.** A default that changes (R7) is stored first as each existing library reads it
  today.
- **D6 One proxy for each clip.** One file at the library's Proxy quality (540p, 720p or 1080p), for the team and for
  whatever plays it. No second kind for the Editor; if the Editor needs another, that is decided with it (§8).

## 4. What is built (`9a8453275`, with `9628e3ecf`, `ef8292c2b`, `e752de444`, `571f6fec2`)

| Blur faces | Generate proxies | Upload | A new clip with faces | A new clip with no faces |
|---|---|---|---|---|
| off | off | any | nothing made | nothing made |
| off | on | off | proxy from the original where needed, kept on the computer | same |
| off | on | Proxies | proxy of every video, uploaded | same |
| on | off | Blurred | blurred copy made, uploaded as it is | marked "No faces found", uploaded as filmed |
| on | on | off | blurred copy; a proxy from it where needed, kept on the computer | proxy from the original where needed |
| on | on | Proxies | blurred copy; proxy made from it and uploaded | proxy from the original, uploaded |
| on | on | Blurred + Proxies | both uploaded | original and its proxy uploaded |
| on | on | Blurred alone | blurred copy uploaded, **no proxy made** (R11) | uploaded as filmed, **no proxy made** (R11) |

Also built: the Proxy workflow card with both switches; What's made → Blurred copies (count, New files switch, Make N
missing); the switch asks about old files only when one has no answer; why a file is not blurred is kept
(`assets.blur_note`: no face found, left as it was, or kept by a person); the stored Upload's two parts under Blur
faces (`db.ts` `libraryUploadStored`); the migration that moved Blurred from the stored "proxies" to "originals".

## 5. Left open by earlier reviews

Each was found in review and not fixed. Checked against the code on 2026-11-25.

### Of `9628e3ecf` and `ef8292c2b` (Generate proxies its own switch)

- **L1 A hand upload can lose its only light copy.** Turning Generate proxies off deletes every waiting proxy job
  (`routes.ts:1298`). In a library that keeps only proxies on the server, a file uploaded by hand gets a proxy job
  whatever the switch says (`worker.ts` `onlyProxy`), and nothing queues it again. Fix: there, delete only the jobs of
  files on a computer (`source_key LIKE 'mac:%'`). Test: switch off with such a job waiting; the job stays.
- **L2 No test that hosting alone sends nothing.** `api/work/library.test.ts:51` set every test library to
  `proxy: true`. Add: a send job in a proxies-only library with the switch off carries `proxy.on === false` and no
  original.
- **L3 The proxy block of the work package** (`work/library-package.ts:425`) reads the add's answer twice inside an
  inline function. Read it once; same result. With L2.
- **Closed by `9a8453275`:** "What's made lets you turn plain proxies on under Blur faces". Generate proxies is a real
  switch there now, and the proxy is made from the blurred copy.
- **Closed, checked:** a proxy of an original waiting for its blur cannot leave its computer: the upload gate refuses
  it (`blur-faces.test.ts`, "a computer's own job files").

### Of `bd6ec6777`, `d8eaae081`, `a8c5cf231`, `57d507572` (clip panel: Frame rate, File, Location)

- **L4 Copy fails silently.** `ClipPanel.tsx:297` `copyText` does nothing when the browser has no clipboard (a server
  opened over plain http) or refuses. Fix: say "Could not copy" through `onError` in both cases.
- **L5 Location is hidden in the trash** (`ClipPanel.tsx:352`, `!inTrash &&`). It showed before. Remove the condition.
- **L6 No test for the Location menu.** `here` (`ClipPanel.tsx:291`) decides which file each item opens; swapped, Show
  original would open the blurred file. One test: a clip with both files here, the items, and the path each copies.
  It grows with R2.
- **L7** `copiedPath` (`ClipPanel.tsx:78`) also covers Copy link: rename it `copied`.

### Of `17791c46d` and `313ad6995` (time left, Preparing bar, timelines)

- **L8 Half of the timeline fix has no test.** `timeline.ts:746-748` lets a clip the sweep queued in the last six hours
  through after a press of Make. The test covers only a clip the sweep never queued. Extend it: sweep, press, sweep
  again is true; with no new press it is false.
- **L9** The estimate test (`estimate.test.ts:62`) cleans up only when it passes, so one failure shows as three. Use
  `try … finally`.
- **L10 The cut-off "Queueing" button was never diagnosed.** After Make is confirmed in What's made
  (`settings/Made.tsx`, the Retry and Make buttons) the button was drawn clipped at the closed dialog's edge. Reproduce
  it in the running app, find the cause, fix it. Done when a row goes Make → Queueing → "N files queued" with nothing
  clipped.
- **L11 The time left was fixed from the code, not from the data.** After the next deploy read What's made →
  Descriptions on a real library. If it still says hours for each file, copied jobs were not the only cause.

## 6. To build

In this order. Each is one small change with its test.

### Pinned rules

- **R1 Frame rate (D1).** Both encoders keep the rate today because neither sets one (`media/proxy.ts` `makeProxy`;
  `apps/mac` `FaceBlur/CoverExporter.swift:178-184` writes each frame it reads). Nothing tests it. Add: a proxy of a
  50 fps and of a 119.88 fps sample probes at its source's rate (`media/proxy.test.ts`); a blurred copy of a 30 fps
  and of a 60 fps sample has its source's rate (`FaceBlurTests.swift`). A line at each encoder says why no rate is
  set. Copies blurred by another tool and added later (`reconnect.ts`) are not checked.

### Clip panel

- **R2 Proxy in the File row and the Location menu.** The File row lists each file the clip has, in the chain's order:
  Original, Blurred, Proxy. Picking one plays it (`here.ts` `proxySource` plays the proxy already) and the Frame rate
  and Size rows describe it. The Location menu gains Show proxy in Finder and Copy proxy path where this computer
  keeps the proxy. The Mac app's answer about a clip carries the kept proxy's address already and must also carry its
  path; an older Mac app shows no proxy items rather than ones that do nothing. Test: L6, with the third file.

### Adding files

- **R3 The add sheet asks two things, not one of three.** Today: Generate proxies, Generate blurred versions or Skip
  processing (`library/ImportChoices.tsx:14`, `LibraryPage.tsx:462`). New: two checkboxes, Blur faces and Generate
  proxies, each starting from the library's and the folder's setting; neither ticked is today's Skip. The server takes
  both answers per file already (`assets.blur`, `assets.proxy`).

### Settings and setup

- **R4 Words.** `generateProxies` (`contracts/library.ts:936`): label "Generate proxies"; tip "A smaller copy is made
  of each new video too heavy to play smoothly, and of every new video while Upload to server sends proxies."
- **R5 Upload → Proxies shows only while Generate proxies is on**, in every library (today only under Blur faces) and
  in setup. Turning Generate proxies off turns Upload → Proxies off in the same save, with Undo for both.
- **R6 Setup asks, starting on No.** Setting up a Media Library asks about proxies already (its Proxy workflow step);
  the answer is filled in as Yes before the person chooses. New: the step's lead is "Make proxies?" with a Generate
  proxies checkbox, unticked (`Setup.tsx:87`). The chat's setup card stops turning proxies on unasked: `quickSetup`
  (`contracts/library.ts:1062`) sends `proxy: false`, and its route stores what it is sent, checked (`proxy === true`),
  where today it stores `proxy: true` whatever comes (`routes.ts:1358`).
- **R7 A new library starts with proxies off** (`SETTING_DEFAULTS.proxy`, `db.ts:202`). Before that default changes, a
  migration stores `proxy: true` on every library with no stored value, so no existing library changes (D5).

### Making proxies

- **R8 Old files never get a proxy unasked.** A file that comes back after being missing is probed again
  (`watch.ts:1010`) and that probe queues its proxy with no date check (`worker.ts:590`). Add `proxy` to the SINCE keys
  (`db.ts`, `proxySince`), check it at `worker.ts:590` and `on-mac.ts:291`, stamp it when the switch goes on, and
  migrate a stamp of now onto every library that is on. Tests: an old file probed again queues none, a new one does;
  the migration stamps an on-library only. Asked-for work (Make N missing, the add's own answer) is not gated.
  With it goes the hidden backfill: a save that turned Upload → Proxies on, or flipped the switch while proxies were
  hosted, queued a proxy for every old video without one (`routes.ts`, the settings save). No save queues old files
  now. What's made → Proxies → Make N missing is the way, and where Upload sends proxies it counts every video
  without one, since the team's copy is what a proxy is for (`made.ts` `missingOf`).
- **R9 The Download location's disk is not connected: no proxy.** Today the worker falls back to a folder on the
  internal disk (`work/cache.ts:20-21`). New: none is made and the clip says "Needs the Download location's disk".
- **R10 Under Blur faces, the phone.** The iPhone app sends its own 720p copy when the stored Upload is "proxies"
  (`apps/ios` `UploadEngine.swift:409`). The stored value means something else under Blur faces since `9a8453275`. Read
  what a kept-as-filmed upload from the phone does under each value and pin it with a test; change the app only if a
  case is wrong.
  **Pinned** (`api/library/held.test.ts`, "R10"), the same under none, proxies, originals and all:
  - A file to blur, sent as its original: taken and held (R13).
  - A file to blur, sent as the phone's 720p copy: refused at its start (409, `REFUSED_COPY`). The master is the
    original, so a smaller copy is never what is held.
  - Kept as filmed, sent as its original: taken and stored. A viewer gets it only where the Blurred row (stored
    originals or all) is on; elsewhere it waits for a computer, as a phone's file under Upload none always did.
  - Kept as filmed, sent as the 720p copy: taken, and that copy is all the server has of the clip. It plays where the
    Proxies row (stored proxies or all) is on.
  **One case is wrong in the app:** with Blur faces on and stored "proxies" it sends the 720p copy of a file to blur
  and gets the refusal. `UploadEngine.swift:409` must send the original whenever the library's `blurFaces` is on and
  the upload's own Blur faces switch is not off; kept as filmed stays as it is.
- **R11 Blurred or Originals without Proxies.** With Generate proxies on and the server keeping no proxy, a clip that
  needs one to play still gets none (`on-mac.ts:291` asks for Upload off). New: the computer that has the file makes
  it and keeps it (`library-package.ts` `keepsProxy` says so already). The riskiest item here: the same file also has
  a send job, and once its original is on the server the proxy job must stay with the computer. Test both orders. If
  the Mac app that reads `keepProxy` is newer than `MIN_MAC_APP`, raise it in the same commit.

### Files from a phone or a browser

- **R13 A file from a phone is a Media Library add, taken through the main computer.** Today, under Blur faces, a file
  sent from the phone or dropped in a browser is refused when it starts (`upload-gate.ts` `mayReceive`), unless its
  owner turns Blur faces off for that upload; a file dropped in a chat is kept as filmed and is not a library add. New
  (owner, 2026-11-25), the same for the phone's upload screen, a file dropped in the phone's chat and a browser:
  1. It is a Media Library add. One the library has already (the same fingerprint, `derived.ts` `duplicateOf`) is not
     added again; the chat uses the clip that is there.
  2. It is uploaded and held: played, shared and handed to no one but the main computer, the one with the library's
     Source media folder (the import rule, `routes.ts` `saveOnComputer`). With that computer offline it waits, held.
  3. The main computer copies it into the library's Imports folder. That copy is the master, and nothing is processed
     before it is there.
  4. Then it is processed as any file on that computer. Faces found: the blurred copy is made, the held file is
     deleted from the server, and what goes up follows Upload (D3). No faces: the held file stays as the clip's
     uploaded original where Upload → Blurred is on, and is deleted where it is off.
  The held file is the one case of an unblurred original with faces on the server, and it is there only until step 4.
  `api/prevention.test.ts` and `upload-gate.test.ts` get their rows (a route that takes a file). Its own change, after
  R1–R11.

  **Built, the server's side** (`api/library/held.ts`, `held.test.ts`; the phone's screens and the chat are next):
  - The gate (`upload-gate.ts` `holdsOriginal`): a file to blur from the phone's upload screen or a browser is taken
    under every Upload, a team member's too. A computer's own file is still refused (it is blurred where it is), and so
    is a smaller copy of a file to blur (R10). With no computer of the library's own account that has its Source media
    folder, the start is refused and says to add one (`REFUSED_NO_MAIN`): a file nothing can blur is not held.
  - Held: the version is recorded as on a computer (`source_key` `mac:<id>`, `asset_versions.held` 1) and the bytes
    wait in `library/held/<version id>`, outside the library's store, on the server's own disk even where the library
    keeps its files in a bucket. So no route that plays, shares, downloads or cuts a clip can reach them. The one way
    out is the main computer's copy (`mayPull`), and only until its master is there. No job is queued for the file.
  - The copy is a library save (`work/tasks/library-save.ts`, the task a save under Upload none uses, so the Mac app
    needs no update) for the library owner's computers that have the folder; a member's file never goes to the
    member's computer. It has no time limit, and nothing here is deleted for its age.
  - Step 4 is `settleHeld`, asked when a blurred copy joins the clip, when Face Blur finds no face, when a person keeps
    the clip as filmed, when Blur faces goes off, and at start. Its write names the hold it expects, so a late or a
    second answer never touches a clip settled meanwhile. A clip deleted for good takes its held file with it.
  - Not in this change: a file dropped in the phone's chat (still kept as filmed, and no library add); This Mac, where
    the server is the computer and an upload is kept as before.

  **Reading progress.** `GET /api/library/:id/intake` → `{ items: Intake[] }` (`contracts/library.ts`): the clips the
  server holds a file of now. With `?assets=<asset id>,<asset id>` (up to 200): those clips, the done ones too; one
  clip is a list of one. Each item is `{ assetId, versionId, step, waiting?, failed?, error?, result? }`:
  `step` is `held` (on the server; `waiting: true` while no computer is copying it), `computer` (its master is on the
  main computer; `waiting: true` while its blur can't start), `blurring`, `done` (`result`: `blurred`, `noFaces` or
  `asFilmed`) or `failed` (`failed`: `copy` or `blur`, and `error`, the reason). A copy that failed is asked for again
  with `POST /api/library/:id/assets/:assetId/intake/retry`; a blur that failed with Face Blur's own
  `POST /api/x/blur-faces/auto/retry`. The upload's finish answers `{ assetId, versionId, held: true, libraryId }` for
  a held file, so the phone has what the route needs. A clip's card carries `held: true` while its file is on the
  server only, and says "Waiting for the main computer" where it said "Not blurred yet".

  **The chat.** A photo or video sent with a message from the iPhone app is a Media Library add by the upload screen's
  own road (`apps/ios` `AssistantAdd`, `UploadEngine`): the message names its uploads (`uploads` on the turn), so the
  gate, the hold and the duplicate check are the ones above, and the chat uses the clip the library has. The ask is
  kept in the chat's own queue of replies that wait (`api/assistant.ts` `held`, on disk, taken up again at start) until
  every file's upload is in and its intake says done, read each time from `intakeOf` and never stored; then it runs
  once, on the asker's own AI, with each file as a library clip by its current version (the blurred copy where there is
  one). It has no time limit. While it waits the reply says what for ("Uploading 2 of 5", "Waiting for the main
  computer", "Blurring 1 of 2"); a file that failed keeps it waiting with the reason and Retry, and it goes on when the
  retry does. An ask whose chat was deleted, or whose file's upload failed or clip was deleted, is ended without
  running. One fact was added for it: the version an upload became is kept on its row (`uploads.version_id`), and a row
  in `chat_starts` is the claim of the one server process that starts a reply. The phone reads each file's step from
  the intake route, in the chat and in Upload's Activity; a photo also still goes to the reply as a picture, which
  does not wait for its add. Not in it: the web chat's dropped files, and a workspace whose library is a plug-in's.

### Checked in the running app

- **R12 Click through what `9a8453275` built**, which no one has: the Proxy workflow card under each switch; the
  Upload rows; What's made → Blurred copies with something missing and with nothing missing; turning Blur faces on in
  a library with and without unanswered files; a clip that says "No faces found"; Blur faces in the clip's menu.
  On a scratch library, never the owner's.

## 7. Order and size

1. L1–L9: nine small fixes, tests included. No behaviour a person sees changes except L4 and L5.
2. R1: tests and two comments.
3. R2, R3: the two screens people asked for.
4. R4–R7: words, setup, the default. R7's migration ships in the same commit as its default.
5. R8, R9: guards.
6. R10: a check, perhaps nothing to change.
7. R11: last, alone, with its two-order test.
8. R13: its own change, with the upload gate's tests first.
9. L10, L11, R12: in the running app, after a deploy.

## 7a. Built, and what is left

Built on 2026-11-25, each item with its test: L1–L9, R1–R11, R13 (the server, the iPhone app and the chat), and the
click-through of R12 in two browser engines on a Linux machine. Three reviews of the whole change followed, and their
findings are fixed. What the build found that the plan had wrong:

- **R1.** The proxy encode did not keep every frame of a clip with uneven frame times (a phone's): 90 frames became 82.
  It now counts time in the source's own ticks and writes each frame once (`-fps_mode vfr -enc_time_base:v demux`).
  The first of those flags alone made FFmpeg 6.1 write a frame for every tick. Proxies need FFmpeg 6.1 or newer; the
  doctor says so.
- **The first migration broke D5.** It stored an existing Blur faces library's Upload as Blurred with Generate proxies
  off, so the proxies the server held of clips kept as filmed stopped being served and new blurred copies went up
  whole. A later step puts such a library back to how it behaved: Generate proxies on, Upload → Proxies, Blurred off.
- **A clip found to have no faces was never sent.** It waited for its blur when it came in, so nothing asked for it
  afterwards. It follows Upload from the moment its answer is in (`derived.ts` `followUpload`).
- **R8 went further.** A save that turned Upload → Proxies on, or flipped the switch while proxies were hosted, queued
  a proxy for every old video. No save queues old files now.
- **R11 is narrower.** Where the server keeps originals and no proxy, the proxy of a file that came from a computer is
  that computer's own; another computer never downloads the original to make one, and the server never takes the job.

Left:

- **L10.** The cut-off "Queueing" button was not reproduced in Chromium or WebKit on Linux, at three widths, light and
  dark. The one moment a row's button is drawn cut is while the confirm fades in. Not checked in the Mac app's own
  engine, where it was seen.
- **L11.** The time left for descriptions, on a real library after a deploy.
- **In the running Mac and iPhone apps:** a blurred copy and a proxy made end to end, a held phone file pulled to the
  main computer, the chat carrying on, Show proxy in Finder. Built and unit-tested, never run on a device.

## 8. Parked: the Editor

Not built here, decided with the Editor: a proxy of every clip kept on the computer; the clip player and the Editor's
viewer playing this computer's proxy first (`here.ts` `editorProxy` has no caller); which file a teammate without the
original exports from; room on the Download location (a proxy not made for lack of room says nothing today,
`work/cache.ts`) and the kept list never shrinking.

Also not doing: the server making a proxy from a blurred copy it holds. Every blurred copy comes from a Mac, whose
send makes the proxy.

## 9. Open questions

- **Q1** A camera's slow-and-quick mode films at one rate and saves at another: the Frame rate row shows the saved
  rate. The filmed rate is in the camera's sidecar file, which the app does not read. Not planned.
- **Q2** R13, step 2: which computer is the main one when a library's Source media folder is on a network disk two
  computers reach. The first one online that reaches it, unless the owner wants to name one. Built that way: every
  computer of the owner's with a Source media folder for the library may take the file, and the first to ask does.

Answered (owner, 2026-11-25): a clip with no faces goes up as filmed under Blurred (D3); setup asks about proxies and
no library changes by itself (R6, R7); the Editor is a later conversation (§8).
