# Blur faces at intake — Product Requirements

Status: draft 3, 2026-11-22 · Tool: Face Blur (`editor-steps/blur-faces`) · Touches: Media Library, the Mac app's
FaceBlur engine

Aim: every Blur faces file gets properly blurred, as fast as possible, with no extra steps for the person. The person
reviews everything before it is posted; this is not a security feature, and nothing here makes the app slower or
stricter than it is today.

## 1. Problem

Face Blur's automatic covering (`plugin.ts`, "Covering what comes into the Media Library") barely runs for files that
live on a Mac:

- A file indexed in place on a Mac (`on-mac.ts`, `source_key` `mac:<id>`) is not queued: only the server's worker
  fires `library.version.probed`.
- A file queued anyway goes to any Mac of the account, which tries to download the original from the server
  (`FaceBlurAutoJob.swift:62` → `autoJobs.input` → `blobs.localCopy`). The server has no bytes for a `mac:` file, the
  Mac returns silently, and the job sits for the 2-hour hold. Thousands of files stall.
- A Mac file without a full SHA-256 (indexed while Blur faces was off) is saved as a new clip, not as its blurred
  version (`plugin.ts:349-353`).
- The default covers every face (`plugin.ts:49`), and a usage limit marks file after file failed (`plugin.ts:333`).
- The library still makes a plain proxy of a Blur faces file, a full encode for nothing.
- Blur faces can be on with Face Blur off, and files then wait forever.

## 2. How it works

```
file comes in on a Mac, marked Blur faces
  ─► queued
  ─► the Mac that has the file reads it where it is
       finds faces (Apple Vision) ─► the AI provider picks the ones matching Which faces
       writes the blurred copy: 1080p, high bitrate
  ─► recorded as the clip's blurred version (the app plays, edits and exports it from then on)
  ─► Upload → Blurred: that copy is uploaded as it is. Upload → Proxies (with Generate proxies on): its Mac makes the
     proxy from the copy and uploads that. Either, both or neither
```

The chain is **Original → Blurred copy → Proxy** (owner, 2026-11-25). Blur faces and Generate proxies are two switches
and neither changes the other. No proxy is ever made of a Blur faces file's original: with Generate proxies on, the
proxy is made from the blurred copy, by the Mac that made the copy. A file with no blurred copy (no face found, or kept
as filmed) follows Upload as any file does: its proxy is made from its original, and under Blurred it goes up as filmed.
Under Blur faces the stored Upload (`db.ts` `libraryUploadStored`) has two parts: Originals is the Blurred row, Proxies
the Proxies row. An original waiting for its blur follows neither. The
blurred copy is saved as a version (`blurred_of`), not as a proxy
file, so exports on the owner's own Mac use it too (they read the original when the file is on that Mac).

## 3. Requirements

### Getting every file blurred

- **R1** Every Blur faces file is queued: when a Mac indexes it (`on-mac.ts`), when a file is marked Blur faces later
  (`library.version.blur`, as today), and once when the server starts, for every Blur faces file already waiting.
- **R2** Only a Mac of the library's account that has the file (`mac_device` / `version_places`) takes it. The claim
  carries the file's place; the Mac opens it where it is. No download.
- **R3** The job is a new kind (`faceblur-intake`), so older Mac apps (which cover every face) never take it.
  `MIN_MAC_APP` is raised to that release.

### Choosing faces

- **R4** Always the faces described in Settings → Face Blur → Which faces, for the file's workspace, chosen by the
  account's AI provider (`/pick`). Never every face.
- **R5** No AI provider, or Which faces empty: nothing is taken; Settings → Face Blur says "Needs an AI provider" or
  "Needs Which faces".
- **R6** Usage limit or AI error: the file goes back in the queue (no try counted, nothing written), and that
  account's queue pauses until the limit resets, or 15 minutes when the provider gives no time. Settings shows "Paused
  until 14:00".
- **R7** Faces found but none matched, or no face at all: no copy; the file's answer becomes no (kept as filmed), so
  it plays as filmed and is not queued again.

### The copy

- **R8** Video: H.264, long side 1920 px, sound kept, bitrate pinned at about 20 Mbps (the engine uses
  `AVAssetExportPresetHighestQuality` today; check a 4K sample with ffprobe first). Photos: JPEG, as today.
- **R9** The Mac hashes the original (full SHA-256) while it reads it, writes the copy into the library's Imports
  folder on that Mac, and records it as the clip's blurred version with only the record sent to the server. No
  round trip of the file through the server's staging (today's `saveOnComputer` path uploads it and downloads it
  back). The copy is then sent as Upload asks (Blurred: the copy; Proxies: the proxy made from it).
- **R10** No proxy is made of a Blur faces file's original (`on-mac.ts`, `worker.ts`); its proxy is made from its
  blurred copy.
- **R10a** Why a file's answer is no is kept (`assets.blur_note`, contracts `BlurNote`): `none`, Face Blur went over it
  and found no face ("No faces found" on the clip); `skipped`, it was in the library when Blur faces went on and was
  left as it was; absent, a person kept it as filmed. Switching Blur faces on never touches the files already there
  unless the person answers Blur all files. What's made → Blurred copies counts the skipped ones as missing, and its Make
  hands them to Face Blur; with none missing, the switch asks nothing.

### Screens

- **R11** The Blur faces checkbox beside Add remembers the last choice per library.
- **R12** The library's Blur faces switch and checkbox show only while Face Blur is on in that workspace.
- **R13** On the file: "Blur queued", "Blurring", "Could not blur" with Retry.

### Unchanged

Descriptions, transcripts, card pictures and every existing upload rule work as today. Copies blurred elsewhere before
are added as any folder with Blur faces unticked; they are never blurred again.

## 3a. Job protocol (server ↔ Mac)

Kind `faceblur-intake` (the old `faceblur` kind is removed; the Mac app lists only the new one). Device token routes as
today (`/api/devices/relay/job/faceblur-intake/:id`, `…/:id/fail`); there is no GET of the original.

Claim options (all strings): `media` (`video` | `photo`), `path` (the original's absolute path on this Mac: the
version's `mac_path`, claimed only by its `mac_device`), `out` (an absolute folder on this Mac to write the copy into,
by Settings → Face Blur → Output → Location: "Blurred folder" is the library's Imports/Blurred there, or
Blurred/ beside the original when there is none; "Beside the original" is the original's own folder; "Custom folder"
is the folder chosen), `longSide` (`1920` | `3840` | `0`, 0 keeping the original's size: Resolution 1080p / 4K /
Original), `bitrate` (bits per second, `10000000` … `80000000`: Bitrate 10 / 20 / 40 / 80 Mbps), and the style
(`look`, `strength`, `softness`, `size`, `color`).

The Mac, in order:

1. `path` missing or unreadable (disk not connected): `POST …/:id { back: "<why>" }` → the server puts the file back
   with no try and does not offer it to this Mac again for 10 minutes. Mac ends the job as `.gone`.
2. Full SHA-256 of the original (streamed, CryptoKit).
3. Scan. No face: `POST …/:id { nothing: "No face found", sha256 }` → the server sets the file's answer to no.
4. `POST …/:id { faces: [{ id, picture, note }], sha256 }` → `200 { blur: [ids] }`. An empty list means none matched:
   the server has set the answer to no and ended the job; the Mac writes nothing (`.done`). `409 { error, back: true }`
   means the AI provider could not answer (limit or error): the server has put the file back and paused the account;
   the Mac writes nothing and ends as `.gone` (not a failure).
5. Write `<out>/<original base name> blurred.mp4` (or `.jpg`, numbered when taken) through the engine's hidden partial
   file (`.<name>.<id>.partial.mp4`), renamed when it checks out. Video: H.264 (`AVAssetExportPresetHighestQuality`),
   long side 1920, sound kept; the bitrate is the encoder's at that preset (an export session cannot pin it; pinning
   needs an AVAssetWriter path, done only if the 20-clip test shows it too low). The original must be inside a folder
   this Mac shares with the Media Library (`MediaFiles.gate`); one outside fails the job.
6. `POST …/:id { made: { path, size, quick, sha256, duration?, width?, height?, thumb? } }` (the copy's own values;
   `quick` as the Mac's indexing computes it; `thumb` a base64 JPEG) → the server records it with `indexOnMac(…,
   { blurredOf: <original sha256> })` so it becomes the clip's current, blurred version, sets the original's
   `full_sha256` if missing, and ends the job.
7. Anything else: `POST …/:id/fail { error }` as today.

`GET /api/x/blur-faces/auto` → `{ can, why?, pausedUntil?, running: string[], failed: [{ versionId, title, error }] }`
(version ids), read by Settings → Face Blur and the Media Library.

## 4. Changes by place

| Place | Change |
|---|---|
| `editor-steps/blur-faces/plugin.ts` | Kind `faceblur-intake`; claim only by the Mac that has the file; R4–R7; queue kept as a map by version (no scan per event); start-up sweep (R1) |
| `api/library/on-mac.ts` | Queue a Blur faces file when indexed (R1); no proxy job for it (R10); record a blurred copy sent by the job (R9) |
| `api/library/worker.ts` | No proxy for a Blur faces file without a blurred copy (R10) |
| `apps/mac` `FaceBlurAutoJob.swift` | Open from the place, hash while reading, write to Imports, send the record, pinned bitrate (R8) |
| `src/pages/LibraryPage.tsx`, library settings | R11, R12, R13 |
| `MacAppUpdateBanner.tsx` | `MIN_MAC_APP` (R3) |

## 5. Tests

- A Blur faces file indexed on a Mac is queued and claimed only by that Mac; no request for its bytes.
- No provider or empty Which faces: no claim. A limit puts the file back and pauses the account's claims.
- None matched: answer becomes no, not queued again.
- The copy becomes the current version with `blurred_of`; under Upload None no file bytes reach the server.
- No proxy job for a Blur faces file's original.

## 6. Before the big run

Run 20 real clips first (small faces in the background, profiles, fast motion) and look at them. Apple Vision misses
some small and side-on faces; if it does, tune the engine before covering thousands of files.

## 7. Open

- **Q1** Two files at a time per Mac (a Mac Studio has room) or one? Measure one file's time first, then decide.
