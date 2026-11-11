# Blur faces (AI Editor step)

Blurs or pixelates the faces the person names in "What to blur" ("Every face except the person speaking", the
default; "the people in the background"; "everyone but me"), in every video a draft shows: the speaker's (V1) and the B-roll
(V2). It runs after Face refinement and before Voice (`order` 30).

1. **Which frames:** what V1 shows where B-roll doesn't cover it, and what V2 shows, 25 frames either side for trims,
   pieces less than 50 frames apart joined (`blurRanges`). Photos are left alone, and the draft's notes name them.
2. **Finding faces:** MediaPipe's face detector (BlazeFace short range) on every other frame of those ranges, on the
   whole frame and on two grids of overlapping tiles (half and a third of the short side), so small faces in the
   background are found too (the smallest tried: 90 px wide in a 1080 px frame). A face found in several tiles is one box.
3. **Tracks:** each box goes on the track it overlaps best, seen less than 12 frames ago (`buildTracks`). A track
   seen fewer than 3 times is dropped.
4. **Which tracks:** the person's own AI (`completeVisionWithFallback`) gets one picture per track (three moments
   side by side) and a line about each: speaker footage or B-roll, whether it is the person speaking (the largest
   face on V1, there the longest), where, how big, how long. It is told to match only what the instruction says and
   never to identify anyone, and answers `{"blur": ["T2", …]}`. With no AI connected the step fails and says to
   connect one.
5. **The copy:** the chosen tracks blurred with a soft-edged ellipse a little larger than the face box, filled in
   across gaps and held 6 frames before and after. The whole file again, every frame, as ProRes 422 HQ 10-bit with
   the source's size, frame rate, timecode and sound. Pixels outside the ellipses are the source's own. A file with
   nothing to blur is not copied, and the draft's notes say when no face was found or none matched.

The cache key is the file, its size and mtime, the ranges, the instruction, the look and the engine, so a draft made
again reuses its copy and asks the AI nothing.

## Runtime

The Python is Face refinement's, shared (`api/editor/mediapipe.ts`, `<data dir>/runtime/mediapipe-<hash>/`): a Mac
with both steps downloads it once. The model is downloaded on first use with its SHA-256 checked, into
`<data dir>/plugins/editor-face-blur/models/`.

## Disk

About 1.4 GB for each minute of video at 1080x1920 (ProRes 422 HQ), for each file it blurs.

## Not checked yet

- footage with real crowds, motion blur and faces in profile (the real run was on composited copies of one
  portrait clip)
- faces smaller than 90 px wide in a 1080 px frame (not tried)
- variable-frame-rate phone files: the copy is written at the file's nominal rate

## Check it

```sh
node scripts/plugin-build.mjs check editor-steps/face-blur
pnpm exec vitest run editor-steps/face-blur   # the engine test runs once a face step has set up its Python in DATA_DIR
```
