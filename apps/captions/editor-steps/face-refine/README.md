# Face refinement (AI Editor step)

Evens out the speaker's skin and lifts the dark circles under the eyes, on this computer, for every recording a
draft shows on V1. It leaves beard, brows, eyes, lips and nostrils alone and keeps the pores. It runs after the
B-roll and before Voice (`order` 20).

- **Which frames:** `faceRanges` takes what V1 shows and leaves out what V2 covers. It adds 25 frames either side for
  trims and joins pieces less than 50 frames apart. Frames outside those ranges are copied as they are.
- **The copy:** the whole file again, every frame, as ProRes 422 HQ 10-bit, with the source's size, frame rate,
  timecode, colour tags and sound, so every cut stays put. A phone file's rotation is applied once. A file with no
  face in any frame keeps playing from the original.
- **Cache:** the cache key is the file, its size and mtime, the ranges, the look and the engine, so a draft made again
  reuses its copy.
- **Smoothing:** Light, Medium (the default, smooth 0.28 + under-eye 0.6) or Strong.

## How it works

`engine.ts` holds the engine, a Python file kept as text so the plug-in stays one bundle.

1. MediaPipe face landmarks and face-skin segmentation (selfie_multiclass) run on half-size frames.
2. A skin-only mask is built: the face oval, times the segmentation's face skin, minus beard (by texture), eyes,
   brows, lips and nostrils.
3. A skin-weighted guided filter evens out blotches, and the pore band is put back.
4. The hollows under the eyes are moved toward the cheek's tone.
5. Landmarks are smoothed over time (One Euro, both ways), segmentation is averaged over ±2 frames and the beard mask
   is carried over, so the mask doesn't crawl.

Only the union of the face crops passes through Python, as 10-bit YUV. It goes back as a difference, which the
encoder's ffmpeg lays over the source it decodes itself, so every pixel outside the face is the source's own.

## The runtime: Python, set up on first use

The first time the step runs (never before it is switched on), it sets itself up in
`<data dir>/plugins/editor-face-refine/`:

1. It finds a Python 3.9+ (Homebrew, python.org, or the developer tools' `/usr/bin/python3`, which it tries only
   when the developer tools are installed, so the macOS install dialog never opens).
2. It makes its own venv and installs `mediapipe==1.2.2` and `opencv-contrib-python==5.0.0.93` (about 400 MB).
3. It downloads the two models from Google's MediaPipe model storage and checks their SHA-256.
4. It writes `ready` only after the engine's self-test passes.

When something is missing, the step fails with a message that names it, for example "Face refinement needs Python 3
on this Mac: …". On a Mac that needs Apple silicon: MediaPipe has no Intel macOS build.

**Why Python and not onnxruntime-node** (which the app already has): the look is defined by MediaPipe's own
landmarker (478 points plus irises, with its video tracking) and the selfie_multiclass face-skin class. Using ONNX
would mean ONNX conversions of both, plus porting the landmarker's detector/tracker pipeline and OpenCV's filters to
TypeScript. That is a new engine whose output would have to be matched again, frame by frame. The Python port matches
the original look exactly:
- With the original's package versions, the frames it retouches are bit-identical to the original engine's on a test
  clip.
- On a fresh venv (Python 3.14, the newest NumPy), it was within 0.6 of a code value (8-bit).

A clean venv from the system's own Python installed and ran it in under two minutes. The cost is a one-time download
and a Python on the Mac. The ONNX route was not tried: the reasons above were enough to pick Python first.

## Disk

Each copy is the whole recording in ProRes 422 HQ, about 1.4 GB a minute at 1080x1920 25p and about 5.5 GB a minute
at 2160x3840. It is written in the edit's folder in the data folder, and Voice, when it runs after, makes one more
copy of it.

## Not checked yet

- the no-Python and Intel Mac messages (the code paths are there, but no such Mac was tried)
- variable-frame-rate phone files: the copy is written at the file's nominal rate
- HDR and full-range sources: the retouch maths assumes BT.709 limited range (the source's own tags are kept)

## Check it

```sh
node scripts/plugin-build.mjs check editor-steps/face-refine
pnpm exec vitest run editor-steps/face-refine   # the engine test runs once the step has set itself up in DATA_DIR
```
