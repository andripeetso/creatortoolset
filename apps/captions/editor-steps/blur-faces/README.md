# Face Blur (a tool, from Community)

Covers faces in photos and videos before they are shared: every face, or only the ones the person names ("the
children", "everyone but me"). The faces are found and covered on the person's own device with the face detector
Apple builds into macOS and iOS (Vision). Nothing is uploaded. Only in "Only some faces" mode does the person's own AI
see small pictures of the faces it chooses between, and it is told never to identify anyone.

It is a download in Community (Explore and Other) on the Mac app's own server; a hosted server offers it by naming it
in `CT_PLUGINS` (`…,blur-faces`). Once on, it is a tile on Home, a page at `/blur-faces` and a section in Settings
(Settings → Face Blur: the same Faces, Which faces and Look as the page). It works only in the workspaces it is
switched on for (Settings → Face Blur, Workspaces, at the top; a new install starts off in every workspace, and one
installed before this stayed on only in the workspace its account worked in then). The work runs:

- **in the Mac app**, on any server the window shows: the page picks files on this Mac, the Mac app finds and covers the faces and writes the covered
  copy beside the original;
- **in the iPhone app**: More → Face Blur shows on a server that has this plug-in; it picks from Photos and saves the
  covered copy to Photos.

In a plain browser the page says where it runs.

## Settings (per workspace)

`GET /api/x/blur-faces/settings` → `PUT` the same shape back, for the workspace the request works in (`X-CT-Workspace`).
A PUT changes only the fields it sends, so an app from before a field existed never resets it. The file keeps the
account's settings from before they were per workspace, which each workspace starts from, and each workspace's own.

```ts
{ mode: "all" | "some"; who: string; look: "blur" | "mosaic" | "solid";
  strength: number;  // 0…1: the blur, or the mosaic's squares
  softness: number;  // 0…1: how far the edge fades out (Solid's starts at 0, the others at 0.45)
  size: number;      // 0.8…2: the cover against the face it covers (smaller would leave the face showing)
  color: string }    // "#rrggbb", Solid's
// default { mode: "all", who: "Every child's face", look: "blur", strength: 0.5, softness: 0.45, size: 1,
//           color: "#343434" }
```

The style is the engine's (`FaceBlur/Cover.swift` `LookPreset`): the Mac app's jobs and test runs, the automatic covers
(the device job's options carry it as text) and the iPhone app all draw with it. `GET /api/x/blur-faces/example` →
`{ picture }`: the example picture (a base64 JPEG, a still from Tears of Steel, CC BY 3.0). The Style card's picture is the
test: the example, or a photo or video the person picks in the Mac app (Choose a file), covered with the current settings
and written nowhere. With "Only some faces" the person's AI picks from the faces found, once per file and Which faces
(`/pick`); moving a slider only draws again.

`who` is used only in "some" mode. At most 500 characters.

## New Media Library files

Each photo and video marked Blur faces (the file's blur answer, set when it comes in: `blur` "yes", contracts `Blur`)
that a Mac indexes into a built-in Media Library of a workspace where Face Blur is on (the library's
`settings.projectId`) is covered on that Mac, where the file is, with the faces described in Which faces. The copy
becomes the clip's blurred version (`blurred_of`, the original's full SHA-256): the app plays, edits and exports it
from then on, and under Upload Proxies its Mac makes the team's proxy from it (job `send`). No plain proxy is made of
the original. The whole design: `docs/face-blur-intake-prd.md`.

- **Trigger:** on-Mac indexing of a yes-file (`library.version.blur` from `on-mac.ts`), a file marked Blur faces later
  (`library.version.blur`), the worker's `library.version.probed`, and a sweep a few seconds after the server starts.
  Queued once per version, only for a file with a path on a Mac (`mac_path`, `mac_device`), never for a file marked no,
  one with a blurred version already, or a file made from another.
- **Queue:** `<data dir>/plugins/blur-faces/auto.json`, a map by version id. A done file is dropped from it.
- **Claim:** the device job `faceblur-intake`, only by the Mac that indexed the file, only while the account has an AI
  provider and Which faces is said, and not while it is paused. Options: `media`, `path` (the original on that Mac),
  `out` (the library's `Imports/Blurred` on that Mac, else `Blurred/` beside the original) and the style.
- **The Mac** (`FaceBlurAutoJob.swift`): the steps are in the PRD's §3a. `{ back }` (the disk is not connected) puts
  the file back, not offered to that Mac for 10 minutes; `{ nothing }` or an empty pick keeps the file as filmed (its
  answer no); an AI provider that cannot answer gives `409 { error, back: true }`, puts the file back with no try and
  pauses the account until its limit resets (15 minutes when it gives no time); `{ made }` records the copy.
- **Where it shows:** Settings → Face Blur → New Media Library files, only when something is wrong: "Needs the Mac app",
  "Needs an AI provider", "Needs Which faces", "Paused until 14:00", and the files that failed, with Retry.
  `GET /api/x/blur-faces/auto` → `{ can, why?, pausedUntil?, running, failed }`, `POST /api/x/blur-faces/auto/retry`.

## Choosing faces (only "some" mode)

`POST /api/x/blur-faces/pick` with `{ who: string; faces: Array<{ id: string; picture: string; note: string }> }`
(`picture`: a JPEG as base64, no `data:` prefix, the face at up to three moments side by side, at most 200 KB; `note`: a
line such as "middle left of the frame; 12% of its width; seen for 4.2 s"; at most 40 faces) → `{ blur: string[] }`,
the ids to cover. With no AI connected, an AI that fails, or an answer with no `{"blur": [...]}`, the answer is an
error (409, `{ error }`, one sentence; at the AI's usage limit also `limit: { until }`, ms or null, shown as the chat's amber notice) and the device writes nothing. The prompt: match only what the instruction says
from what is visible, never identify anyone (`api/lib/face-pick.ts`, shared with the AI Editor step).

## The Mac app (page ↔ app)

On the `thisMac` handler (`src/lib/thisMac.ts`), string asks, each answered with JSON. Any ask can be answered with
`{ problem }` (one sentence), which the page shows.

| Ask | Answer |
|---|---|
| `faceblur:hello` | `{ ok: true, version: 2 }` (1: no styles or test runs). An older Mac app answers anything else: the page says to update the app |
| `faceblur:start:<json>` `{ files: string[], mode, look, strength?, softness?, size?, color? }` (paths on this Mac) | `{ job: string }` or `{ problem }` |
| `faceblur:state:<job>` | `{ done: boolean, items: Item[] }`, the faces without their pictures (polled twice a second) |
| `faceblur:faces:<json>` `{ job, path }` | `{ faces: Face[] }` with their pictures, read once per file |
| `faceblur:choose:<json>` `{ job, path, blur: string[], error?: string }` | `{ ok: true }`: writes (again) that item with those faces covered; with `error`, ends it as failed with that sentence and writes nothing |
| `faceblur:cancel:<job>` | `{ ok: true }` |
| `faceblur:show:<path>` | `{ ok: true }`: shows the file in Finder (a copy a job wrote, or a file picked or dropped here) |
| `faceblur:try:<json>` `{ picture: base64 } or { path }, look, strength?, softness?, size?, color?, blur?: string[], facesOnly?: boolean` | `{ kind, faces: [{ id, picture, note }], frames: string[] }`: a preview or a test run, written nowhere. `frames`: the covered photo, or three moments of a video (where the covered faces show), base64 JPEGs at most 1280 px; `blur` left out covers every face; `facesOnly` gives no frames (the first half of an "Only some faces" run). The last file's scan is kept, so a new style only draws again. `path` must be a file picked or dropped here |
| `faceblur:pick` | `{ paths: string[] }`: Choose files in this app's own open panel, on whichever server the window shows (`[]` when cancelled). The picks join the files Face Blur may take. An older Mac app answers with a problem: the page then uses its file input, which gives paths only on this Mac's own server |

```ts
type Item = {
  path: string; name: string;
  stage: "queued" | "scanning" | "choosing" | "writing" | "done" | "failed";
  progress: number;                 // 0…1 within the stage
  faces?: Face[];                   // once scanned; no `picture` in the state
  out?: string;                     // the covered copy, once done
  error?: string;                   // one sentence, when failed
  note?: string;                    // a done item that wrote nothing: "No face found, nothing written"
};
type Face = { id: string; picture?: string; note: string; blur: boolean };
```

- "all": scan, then write with every face covered, no stop.
- "some": scan, then stage `choosing`: the page sends the faces to `/pick` and answers `faceblur:choose` with the ids.
  A failed pick is sent as `faceblur:choose` with `error`: the item ends as failed and nothing is written.
- A copy is written only when it covers a face. No face found, or none chosen (by the AI or the switches): the item
  is done with `note` and no copy (an earlier copy stays as it was). The engine refuses such a write itself
  (`CoverPipeline.NothingToCover`), on the iPhone too.
- A done item keeps its faces: the page shows them with a switch each, and `faceblur:choose` writes it again.
- The copy: `<name> blurred.mp4` (H.264, at most 1920 px, no location, device or date metadata) or `<name> blurred.jpg`
  (no EXIF), beside the original; a number is added when the name is taken.

## The iPhone app

`GET /api/plugins` lists `blur-faces` and the account has its gate → More shows Face Blur (`FaceBlurView.swift`). The
same settings (editable there too) and `/pick`; photos and videos are picked in Photos and copied as they are into the
app's temporary folder, covered one at a time and saved to Photos (add-only). A failed pick fails that file and
writes nothing; so does a file with no face found or none chosen, and its row says so. A done file shows its faces with
a switch each and Blur again, which saves a new copy to Photos (the earlier one stays there, and the row says so). The
picked files are removed when the Face Blur screen closes and its work is done.

The engine is `FaceBlur/` in both apps, byte for byte the same files: change it in one, copy it to the other.
`diff -r apps/mac/Sources/CreatorToolsetMac/FaceBlur apps/ios/CreatorToolset/FaceBlur` prints nothing when they match.
