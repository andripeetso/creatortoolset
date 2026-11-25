# Media Library: blurred copies and proxies — plan

Status: draft 4, 2026-11-25. Replaces draft 3 (proxies alone). The chain itself is built (`9a8453275`); this is what is
left, in build order, with the review findings three earlier changes left open (§5). Tool: Media Library, with the Face
Blur plug-in (`editor-steps/blur-faces`, `docs/face-blur-intake-prd.md`).

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
- Blur is not a privacy wall inside the team. It matters in what is rendered. One promise stays: under Blur faces an
  original with faces is never uploaded.

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

## 3. Decisions

- **D1 Frame rate.** Every copy keeps its original's frame rate, always. A 119.88 fps clip gives a 119.88 fps blurred
  copy and a 119.88 fps proxy. Size, bitrate and codec may change; frame count and timing never do. No encode sets a
  rate.
- **D2 Where copies are written.** Blurred copies: the library's `Imports/Blurred` folder (Settings → Face Blur →
  Output can change it). Proxies: the computer's Download location (Settings → Storage). No new choice is added, and
  nothing is written to the internal disk because another disk is missing.
- **D3 Upload, under Blur faces.** Two rows: **Blurred** sends the blurred copies as they are; **Proxies** sends the
  proxies and shows only while proxies are made. A clip with no blurred copy goes up only as its proxy.
- **D4 Words.** On screen the three files are Original, Blurred and Proxy (File row, Location menu, Upload rows); in a
  sentence "blurred copy". Never "blurred proxy".
- **D5 Nothing changes by itself.** A default that changes (R7) is stored first as each existing library reads it
  today.

## 4. What is built (`9a8453275`, with `9628e3ecf`, `ef8292c2b`, `e752de444`, `571f6fec2`)

| Blur faces | Generate proxies | Upload | A new clip with faces | A new clip with no faces |
|---|---|---|---|---|
| off | off | any | nothing made | nothing made |
| off | on | off | proxy from the original where needed, kept on the computer | same |
| off | on | Proxies | proxy of every video, uploaded | same |
| on | off | Blurred | blurred copy made, uploaded as it is | marked "No faces found", nothing uploaded |
| on | on | off | blurred copy; a proxy from it where needed, kept on the computer | proxy from the original where needed |
| on | on | Proxies | blurred copy; proxy made from it and uploaded | proxy from the original, uploaded |
| on | on | Blurred + Proxies | both uploaded | its proxy uploaded |
| on | on | Blurred alone | blurred copy uploaded, **no proxy made** (R11) | **no proxy made** (R11) |

Also built: the Proxy workflow card with both switches; What's made → Blurred copies (count, New files switch, Make N
missing); the switch asks about old files only when one has no answer; why a file is not blurred is kept
(`assets.blur_note`: no face found, left as it was, or kept by a person); the stored Upload read per file
(`db.ts` `blurUpload`); the migration that moved Blurred from the stored "proxies" to "originals".

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
- **R6 Setup asks, starting on No.** The Proxy workflow step's lead is "Make proxies?" with a Generate proxies
  checkbox, unticked (`Setup.tsx:87`). The chat's setup card stops turning proxies on unasked: `quickSetup`
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
- **R9 The Download location's disk is not connected: no proxy.** Today the worker falls back to a folder on the
  internal disk (`work/cache.ts:20-21`). New: none is made and the clip says "Needs the Download location's disk".
- **R10 Under Blur faces, the phone.** The iPhone app sends its own 720p copy when the stored Upload is "proxies"
  (`apps/ios` `UploadEngine.swift:409`). The stored value means something else under Blur faces since `9a8453275`. Read
  what a kept-as-filmed upload from the phone does under each value and pin it with a test; change the app only if a
  case is wrong.
- **R11 Blurred or Originals without Proxies.** With Generate proxies on and the server keeping no proxy, a clip that
  needs one to play still gets none (`on-mac.ts:291` asks for Upload off). New: the computer that has the file makes
  it and keeps it (`library-package.ts` `keepsProxy` says so already). The riskiest item here: the same file also has
  a send job, and once its original is on the server the proxy job must stay with the computer. Test both orders. If
  the Mac app that reads `keepProxy` is newer than `MIN_MAC_APP`, raise it in the same commit.

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
8. L10, L11, R12: in the running app, after a deploy.

## 8. Parked: the Editor

Not built here, decided with the Editor: a proxy of every clip kept on the computer; the clip player and the Editor's
viewer playing this computer's proxy first (`here.ts` `editorProxy` has no caller); which file a teammate without the
original exports from; room on the Download location (a proxy not made for lack of room says nothing today,
`work/cache.ts`) and the kept list never shrinking.

Also not doing: the server making a proxy from a blurred copy it holds. Every blurred copy comes from a Mac, whose
send makes the proxy.

## 9. Open questions

- **Q1** A clip with no faces has no blurred copy, so Upload → Blurred sends nothing for it; it reaches the server
  only as a proxy. Kept as built unless the owner wants its original sent under Blurred.
- **Q2** R7 keeps proxies on for libraries that never stored the switch. Draft 3 read them as off.
- **Q3** A camera's slow-and-quick mode films at one rate and saves at another: the Frame rate row shows the saved
  rate. The filmed rate is in the camera's sidecar file, which the app does not read. Not planned.
