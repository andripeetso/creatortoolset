# Face Blur (a tool, from Community)

Covers faces in photos and videos before they are shared: every face, or only the ones the person names ("the
children", "everyone but me"). The faces are found and covered on the person's own device with the face detector
Apple builds into macOS and iOS (Vision). Nothing is uploaded. Only in "Only some faces" mode does the person's own AI
see small pictures of the faces it chooses between, and it is told never to identify anyone.

It is a download in Community (Other) and, once on, a tile on Home and a page at `/blur-faces`. The work runs:

- **in the Mac app**: the page picks files on this Mac, the Mac app finds and covers the faces and writes the covered
  copy beside the original;
- **in the iPhone app**: More → Face Blur shows on a server that has this plug-in; it picks from Photos and saves the
  covered copy to Photos.

In a plain browser the page says where it runs. The AI Editor's own step "Blur faces" (`editor-steps/face-blur`) is a
different plug-in: it blurs faces inside an edit with MediaPipe.

## Settings (per account)

`GET /api/x/blur-faces/settings` → `PUT` the same shape back:

```ts
{ mode: "all" | "some"; who: string; look: "blur" | "mosaic" | "solid" }
// default { mode: "all", who: "Every child's face", look: "blur" }
```

`who` is used only in "some" mode. At most 500 characters.

## Choosing faces (only "some" mode)

`POST /api/x/blur-faces/pick` with `{ who: string; faces: Array<{ id: string; picture: string; note: string }> }`
(`picture`: a JPEG as base64, no `data:` prefix, the face at up to three moments side by side, at most 200 KB; `note`: a
line such as "middle left of the frame; 12% of its width; seen for 4.2 s"; at most 40 faces) → `{ blur: string[] }`,
the ids to cover. With no AI connected, an AI that fails, or an answer with no `{"blur": [...]}`, the answer is an
error (409, `{ error }`, one sentence) and the device writes nothing. The prompt: match only what the instruction says
from what is visible, never identify anyone (`api/lib/face-pick.ts`, shared with the AI Editor step).

## The Mac app (page ↔ app)

On the `thisMac` handler (`src/lib/thisMac.ts`), string asks, each answered with JSON:

| Ask | Answer |
|---|---|
| `faceblur:hello` | `{ ok: true, version: 1 }`. An older Mac app answers anything else: the page says to update the app |
| `faceblur:start:<json>` `{ files: string[], mode, look }` (paths on this Mac) | `{ job: string }` or `{ problem }` |
| `faceblur:state:<job>` | `{ done: boolean, items: Item[] }` |
| `faceblur:choose:<json>` `{ job, path, blur: string[], error?: string }` | `{ ok: true }`: writes (again) that item with those faces covered; with `error`, ends it as failed with that sentence and writes nothing |
| `faceblur:cancel:<job>` | `{ ok: true }` |
| `faceblur:show:<path>` | `{ ok: true }`: shows the file in Finder |

```ts
type Item = {
  path: string; name: string;
  stage: "queued" | "scanning" | "choosing" | "writing" | "done" | "failed";
  progress: number;                 // 0…1 within the stage
  faces?: Array<{ id: string; picture: string; note: string; blur: boolean }>;  // once scanned
  out?: string;                     // the covered copy, once done
  error?: string;                   // one sentence, when failed
};
```

- "all": scan, then write with every face covered, no stop.
- "some": scan, then stage `choosing`: the page sends the faces to `/pick` and answers `faceblur:choose` with the ids.
  A failed pick is sent as `faceblur:choose` with `error`: the item ends as failed and nothing is written.
- A done item keeps its faces: the page shows them with a switch each, and `faceblur:choose` writes it again.
- The copy: `<name> blurred.mp4` (H.264, at most 1920 px, no location, device or date metadata) or `<name> blurred.jpg`
  (no EXIF), beside the original; a number is added when the name is taken.

## The iPhone app

`GET /api/plugins` lists `blur-faces` → More shows Face Blur. Same settings and `/pick`, the same engine
(`FaceBlur/` in both apps, the same files), saves to Photos.
