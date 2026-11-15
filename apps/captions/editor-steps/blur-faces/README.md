# Face Blur (a tool, from Community)

Covers faces in photos and videos before they are shared: every face, or only the ones the person names ("the
children", "everyone but me"). The faces are found and covered on the person's own device with the face detector
Apple builds into macOS and iOS (Vision). Nothing is uploaded. Only in "Only some faces" mode does the person's own AI
see small pictures of the faces it chooses between, and it is told never to identify anyone.

It is a download in Community (Explore and Other) on the Mac app's own server; a hosted server offers it by naming it
in `CT_PLUGINS` (`…,blur-faces`). Once on, it is a tile on Home, a page at `/blur-faces` and a section in Settings
(Settings → Face Blur: the same Faces, Which faces and Look as the page). The work runs:

- **in the Mac app**, on any server the window shows: the page picks files on this Mac, the Mac app finds and covers the faces and writes the covered
  copy beside the original;
- **in the iPhone app**: More → Face Blur shows on a server that has this plug-in; it picks from Photos and saves the
  covered copy to Photos.

In a plain browser the page says where it runs. The AI Editor's own step "Blur faces" (`editor-steps/face-blur`) is a
different plug-in: it blurs faces inside an edit with MediaPipe.

## Settings (per account)

`GET /api/x/blur-faces/settings` → `PUT` the same shape back:

```ts
{ mode: "all" | "some"; who: string; look: "blur" | "mosaic" | "solid"; auto: boolean }
// default { mode: "all", who: "Every child's face", look: "blur", auto: false }
```

`who` is used only in "some" mode. At most 500 characters.

## New Media Library files (`auto`)

With `auto` on, each photo and video that comes into the account's built-in Media Library is covered by a Mac of the
account's own, with the same settings, and the covered copy is added to the same library (so the same workspace) as
"<title> blurred", linked to the original (`derived_from`). The original is never changed, hidden or deleted.

- **Trigger:** the core event `library.version.probed` (the library's worker, after a file is read; not for music).
  Queued once per version, never for a file made from another (a covered copy, an export).
- **Queue:** `<data dir>/plugins/blur-faces/auto.json`. A Mac claims a file with the device job `faceblur` (the plug-in
  slot `deviceJobs`, PLUGINS.md); the claim carries `options: { mode, look, media }`. A Mac that goes quiet gives its file
  back; after three times, or a Mac's own failure, the file is failed and says why.
- **The Mac** (`FaceBlurAutoJob.swift`): `GET /api/devices/relay/job/faceblur/<id>` the original; in "some" mode `POST …/<id>`
  `{ faces }` → `{ blur }` (the server asks the person's AI, as `/pick`; a failed AI fails the file and nothing is
  written); no face covered → `POST …/<id>` `{ nothing: why }` and no copy; else `POST …/<id>/file` the MP4 or JPEG.
- **Where it shows:** Settings → Face Blur → New Media Library files. The switch shows when a Mac of the account lists
  `faceblur` (the Mac app from this version) and the Media Library is the built-in one (no plug-in's source is `main`),
  or while it is on; otherwise one line says why. Files that could not be covered are listed there with why and Try
  again; nothing is shown while all goes well. `GET /api/x/blur-faces/auto`, `POST /api/x/blur-faces/auto/retry`.

## Choosing faces (only "some" mode)

`POST /api/x/blur-faces/pick` with `{ who: string; faces: Array<{ id: string; picture: string; note: string }> }`
(`picture`: a JPEG as base64, no `data:` prefix, the face at up to three moments side by side, at most 200 KB; `note`: a
line such as "middle left of the frame; 12% of its width; seen for 4.2 s"; at most 40 faces) → `{ blur: string[] }`,
the ids to cover. With no AI connected, an AI that fails, or an answer with no `{"blur": [...]}`, the answer is an
error (409, `{ error }`, one sentence) and the device writes nothing. The prompt: match only what the instruction says
from what is visible, never identify anyone (`api/lib/face-pick.ts`, shared with the AI Editor step).

## The Mac app (page ↔ app)

On the `thisMac` handler (`src/lib/thisMac.ts`), string asks, each answered with JSON. Any ask can be answered with
`{ problem }` (one sentence), which the page shows.

| Ask | Answer |
|---|---|
| `faceblur:hello` | `{ ok: true, version: 1 }`. An older Mac app answers anything else: the page says to update the app |
| `faceblur:start:<json>` `{ files: string[], mode, look }` (paths on this Mac) | `{ job: string }` or `{ problem }` |
| `faceblur:state:<job>` | `{ done: boolean, items: Item[] }`, the faces without their pictures (polled twice a second) |
| `faceblur:faces:<json>` `{ job, path }` | `{ faces: Face[] }` with their pictures, read once per file |
| `faceblur:choose:<json>` `{ job, path, blur: string[], error?: string }` | `{ ok: true }`: writes (again) that item with those faces covered; with `error`, ends it as failed with that sentence and writes nothing |
| `faceblur:cancel:<job>` | `{ ok: true }` |
| `faceblur:show:<path>` | `{ ok: true }`: shows the file in Finder (a copy a job wrote, or a file picked or dropped here) |
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
