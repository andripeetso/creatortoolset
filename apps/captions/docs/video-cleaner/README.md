# Video Cleaner — what it does and how it cleans

Video Cleaner lets you upload a video once, edit it, compare it with the original,
inspect its metadata, and download the result when you are happy with it.
You can also upload a second video for comparison or move a clip between Cleaner
and Caption Studio.

**Your local original is never overwritten.** Measurements compare the files you
provide. They are not Instagram or Facebook originality scores, and there is no
platform “pass” score.

## Start here

Open **Guide** in the Cleaner header to read this document in a modal. Section
links jump within the guide; close it with the close button or Escape to return
to your current edit.

1. Open **Video Cleaner** at `/clean` and upload an MP4, MOV, M4V, MKV or WebM.
   Uploading happens in the background; you can choose settings while it runs.
2. Click **Edit clip** beside **Current edit** to open the separate editor.
   Watch the original and adjusted preview side by side, then **Apply changes**.
3. The top score cards automatically update **PDQ, SSCD, color, contrast and
   brightness**. Hover, focus or tap any card for an explanation.
4. Use **Measure full scores** for the encoded output, TMK, shared-frame matching
   and motion estimates. This uses a temporary render and then deletes it.
5. Choose a cleanup preset. **Check cleanup** verifies metadata removal without
   running the perceptual measurements.
6. Download the MP4 or send it to Caption Studio. Metadata cleanup and unique
   file hashing are enabled by default.

A number marked **Previous settings** belongs to an earlier adjustment. Wait for
the automatic estimate or run full measurement again before comparing it with
current settings. An unavailable or failed measurement is shown explicitly;
a dash does not mean a perfect score.

## Editing tools

| Tool                                  | What it changes                                                           |
| ------------------------------------- | ------------------------------------------------------------------------- |
| Cleaner presets                       | A look plus a small reframe, flip or speed change; see below              |
| Brightness, contrast, saturation      | The appearance of the picture                                             |
| Look presets                          | Natural, Bright, Vivid, Soft and Monochrome color settings                |
| Crop                                  | Original aspect ratio, 9:16, 1:1, 4:5 or 16:9                             |
| Zoom and horizontal/vertical position | Framing within the crop                                                   |
| Rotate and flip                       | Quarter-turn rotation, horizontal or vertical mirroring                   |
| Trim                                  | Start and end of the retained video                                       |
| Speed                                 | The editor slider runs from **90% to 110%**, with 100% as normal speed    |
| Volume and mute                       | Audio level or removal of audible sound                                   |
| Cuts and scene order                  | Detect likely scene boundaries, adjust retained ranges and reorder scenes |
| Saved presets and snapshots           | Reuse settings without making another video copy                          |

Cuts and scene order are inside the Editor. Automatic cut detection proposes
boundaries from visual changes; review them, since flashes and fast movement can
look like cuts. Up to 64 scene ranges are supported, each at least 0.1 seconds.
Trims, cuts and speed change the output timeline.

Look presets affect color settings. Custom presets are stored in this browser
and exclude source-specific trim/cut ranges. They contain settings, not media.
Snapshots belong to the current page session. Reloading a session URL restores
the uploaded source while it exists, but not every unsaved setting.

The playing preview uses a browser canvas. A paused preview can use a frame
rendered with the export filters. Decoder color handling, scaling and compression
can make previews differ slightly from the downloaded video. Full measurements
use the actual encoded output.

## Cleaner presets

Presets sit above **Adjust your own**. Hover a preset for what it changes; one
click sets the look and framing, and trim, scenes and sound stay as they are.
Each preset was measured on eight test
videos (reels, a short clip and raw phone/DJI footage) with this page's own
full measurement.

| Preset         | What changes                                       | Reference checks                                                     |
| -------------- | -------------------------------------------------- | -------------------------------------------------------------------- |
| **Just clean** | Nothing in the picture                             | All three still match                                                |
| **Light**      | 5% zoom kept to the bottom, Bright look            | PDQ and vPDQ outside on every video; TMK still matches               |
| **Reframe**    | 12% zoom kept to the bottom-right corner           | All three outside on every vertical video; not on a landscape clip   |
| **Mirror**     | Flipped, 5% zoom kept to the bottom                | All three outside on every video                                     |
| **Strong**     | Flipped, 10% corner zoom, Vivid look, 5% faster    | All three outside on every video, by the widest margin               |

What the tests showed:

- **Color looks, speed, trims, scene order and grain do almost nothing** to
  these checks. PDQ follows the picture's light-and-dark structure, and TMK is
  built to survive timing changes.
- **Moving the picture works.** A zoom anchored to an edge or corner moves every
  part of the frame, so it beats a larger centered zoom: 12% in a corner does
  more than 20% in the middle.
- **Mirroring text.** Mirror and Strong also mirror burned-in captions and
  logos. Use Reframe for videos with text.
- **A flip alone is easy to undo.** PDQ's reference hasher can compare the
  mirrored picture too; a plain flip then matches again (8 bits). Mirror's 5%
  zoom keeps even that comparison outside (46 bits or more).
- **Landscape clips** keep their coarse structure through small crops. Cropping
  one to 9:16 for a reel is enough by itself; otherwise use Mirror or Strong.
- **SSCD stays high** (0.87–0.94 for these presets). A learned copy detector
  still sees the same video. The presets move the public hash checks, not
  every possible detector.

## Duplicate check

Admins get **Check against my posts** under the preview: the upload measured
against every reel you've posted, with the five closest, what they share and
what to change.

| Measure | Read it as |
| --- | --- |
| **Same voiceover** | Share of this video's audio that is the same recording as the post, and the longest stretch in a row. One take through another microphone still matches; a new take doesn't. |
| **Same frames** | Share of its frames that are near-identical to the post's. For reference: reused b-roll under a new voiceover is fine. |
| **First 3 s** | The same, for the opening. |
| **Spoken phrases** | Share of its spoken 4-word phrases already said in the post. |

Instagram says it matches on visual and audio signals and names a new
voiceover as a real change, so re-record or use different takes for a variant.
The verdict looks at the voice: red when half of it is the same recording as a
post, amber past 20%, one 5-second stretch, or 60% of the same words. The
cutoffs are ours; Meta publishes none. The line above the posts counts how
many of your last 30 days' posts re-use an earlier one: Instagram wants most of
them original. How it works: docs/VIDEO-CLEANER.md "Duplicate check".

## Clip editor workspace

**Edit clip** opens a modal with its own draft and undo history. It reuses the
Cleaner preview, adjustments, preset storage and source-time mapping, plus Caption
Studio's audio-decoding worker and time formatting. It does not open or overwrite
a Caption Studio project. **Apply changes** updates the current Cleaner edit;
**Cancel** or Escape discards the modal's changes. Applying does not render or
store another video. Presets explicitly saved in the editor remain in the browser.

- Drag scene blocks to reorder them. Drag either edge to trim; source in/out
  fields allow precise values. Timeline zoom and Fit help with long clips.
- Click the ruler to seek. **Split at playhead** or **S** divides the scene at its
  actual source moment, including the current speed. Splitting alone does not
  change the video. Arrow controls also move scenes without dragging.
- Duplicate or delete a selected scene, or set its in/out point at the playhead.
  At least one scene remains. Trim handles support arrow-key steps of 1/30 second.
- Undo/redo buttons and **Cmd/Ctrl Z**, **Cmd/Ctrl Shift Z** affect this modal draft.
- **Detect scenes** proposes cuts; review and apply them explicitly. This replaces
  the current scene order, and can be undone. Lower thresholds find smaller changes.
- Thumbnails are generated locally. **Load waveform** uses the existing audio worker
  on demand; a restored session may need to download the source into browser memory.
  The waveform follows reordered cuts and speed. It is not an audio fingerprint.
- **Compare & measure** shows the existing fast scores and full-file measurement
  controls for the draft. A current full measurement follows the applied edit back
  to Cleaner. Closing the modal cancels its unfinished work.

## Comparison timeline

The **Edit source map** updates immediately from the selected source ranges. It
shows which footage is retained, moved or removed even at 101% speed. These are
known editing instructions, not a claim that the pictures remain identical.

The measured **Comparison timeline** searches every comparison frame against
all sampled original frames, independently of their timestamps. This helps locate
shared material that has moved to another scene or shifted in time. It decodes a denser set of
up to 256 samples per video at intervals of 0.25 seconds or longer. This adds
analysis time to full measurements, but needs no additional video render and
saves no media copy. The existing 64-sample vPDQ score is unchanged.

| Label | Meaning |
| --- | --- |
| Shared sample | A qualifying PDQ match was found at another source moment |
| Multiple possible locations | Distant source samples match almost equally well; repeats/static footage make the location uncertain |
| No sampled match | No qualifying reference match in this sampled set; this does not prove that footage is new |
| Insufficient detail | The comparison frame or all source frames lack reliable visual detail |

Both sides must have PDQ quality at least 50 and matching distance at most 31.
Matches within four bits of the best result at nonadjacent source samples are
ambiguous. Timeline bins represent approximate sampled moments, not a continuous
frame-by-frame classification. The longest sequence requires at least three
consecutive, unambiguous matches advancing in source order; its length spans the
first and last samples and remains an estimate. Small speed differences can still
produce a run, but sparse sampling can miss speed-shifted or short shots.

For two uploads, select a matched bin to seek both previews to its corresponding
moments. Playback retains that local time offset; it does not automatically correct
speed drift. **Reset alignment** returns to matching timestamps. The current-edit
map seeks the output preview while its original view shows the known source moment.

**Change report** downloads a readable Markdown table of time ranges, source
locations and distances. The JSON fingerprint report also includes the map.
Previous settings remain explicitly stale. Audio is not fingerprinted or included
in these similarity results; use the audio selector to listen separately.
None of these measurements guarantees non-detection, originality or recommendation
eligibility on a platform.

## Reference assessment

The **Public reference assessment** above the scores compares this pair against
published matching settings. It gives an interpretation of the measurements;
it does not provide a calibrated probability that Meta will approve a video,
consider it original, or fail to recognize it. **Meta outcome stays unknown.**

| Check                  | Within the reference match range                                                                                | Outside the reference match range |
| ---------------------- | --------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| PDQ frame pairs        | Each reliable pair has 0–31 differing bits                                                                      | A pair has 32–256 differing bits  |
| TMK+PDQF               | L1 and L2 are both at least 0.70                                                                                | Either score is below 0.70        |
| vPDQ published example | At least 80% of the comparison's qualifying unique frames match the original; original coverage threshold is 0% | Comparison coverage is below 80%  |

PDQ shows **how many reliable pairs match**, not whether the average crosses 31.
For example, distances 0 and 80 have an average of 40, but one frame still
matches. An unreadable or low-detail sample stays inconclusive. A live PDQ check
can update immediately; a complete assessment requires current encoded scores.

The vPDQ rule is the documentation's **directional example**, not an official
production default. A short excerpt can have 100% comparison coverage while
covering only part of the original. Swapping the uploaded files can change this
example's result. The per-frame distance and quality settings must also match
the expected 31-bit and quality-50 settings.

The overall interpretation is **within these reference match ranges**, **outside
these reference match ranges**, or **mixed reference results**. Missing results,
low-detail pairs and previous settings produce a partial assessment. An outside
result applies only to these checks and samples; it is not a platform pass.
SSCD, color, contrast, brightness and motion remain descriptive because no
validated pass cutoff has been established for them here. No pass probability
or invented SSCD bands are calculated.

The JSON comparison report includes the assessment, rule version and source
links, along with the underlying measured scores. Sources:
[PDQ's 31-bit reference](https://github.com/facebook/ThreatExchange/blob/main/python-threatexchange/threatexchange/signal_type/pdq/pdq_utils.py),
[TMK's 0.70 defaults](https://github.com/facebook/ThreatExchange/blob/main/tmk/cpp/bin/tmk_default_thresholds.h),
and the [vPDQ comparison example](https://github.com/facebook/ThreatExchange/tree/main/vpdq#comparison-matching-algorithm).

## What each number means

### Fast automatic measurements

These use up to **four matching source moments**. Source frames are reduced to a
maximum of 768 pixels before applying edits. Cuts and speed are accounted for
when matching an adjusted frame with its source frame.

| Measurement              | Read it as                                                                                                                                                                                                |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **PDQ distance**         | Mean differing bits in 256-bit frame fingerprints. **0 = identical hashes**; larger = more different. The maximum is the largest reliable pair distance.                                                  |
| **Reliable frame pairs** | How many sampled pairs have PDQ quality of at least 50 on both sides. Only these pairs contribute to the PDQ summary. No reliable pairs means no mean distance.                                           |
| **SSCD similarity**      | Mean cosine similarity of Meta's public SSCD image descriptors. The scale is **−1 to 1**, with **1 most similar**. The minimum is the least similar sampled pair. It is not a whole-video temporal score. |
| **Color difference**     | Mean CIE Lab **ΔE76** between corresponding sampled pixels. **0 = identical sampled colors**. Color, brightness and geometric changes can all increase it.                                                |
| **Contrast change**      | Change in luma standard deviation, in **percentage points**. Positive means a greater spread of light and dark values. The card also shows the original and adjusted spread.                              |
| **Brightness**           | Mean luma before and after: **0% black, 100% white**. This is a measured image property, not the slider position.                                                                                         |

Color, contrast and brightness use 64×64 frames, sRGB/D65 assumptions for Lab and
Rec.709 RGB weights for luma. They are our visual diagnostics, not Meta hashes or
calibrated HDR/color-management measurements. Cropping changes which pixels are
compared and can affect all three.

PDQ is based on luminance structure, so a visible color change may have a small
PDQ effect. SSCD uses a learned 512-value descriptor and a different comparison.
The scores do not have to move together.

### Full measurements

**Measure full scores** renders the current edit temporarily. It adds the
following and verifies PDQ, SSCD and the visual diagnostics using up to **eight
encoded frame pairs**. These encoded results can differ from fast estimates.

| Measurement                             | Read it as                                                                                                                                      |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| **TMK temporal · L2**                   | Similarity including content and timing, from **0 to 1**. Higher is more similar. Scene order, speed and cuts can affect it.                    |
| **TMK average · L1**                    | Average visual-feature cosine similarity, from **−1 to 1**. Read alongside L2; it does not describe scene timing by itself.                     |
| **vPDQ · original found**               | Percentage of the original's unique qualifying frame hashes that have a match somewhere in the comparison.                                      |
| **vPDQ · comparison found**             | Percentage of the comparison's unique qualifying frame hashes that have a match somewhere in the original.                                      |
| **Motion jitter · original/comparison** | Estimated changes in global frame translation. Lower means steadier estimated motion in the sampled windows. This is a rough motion diagnostic. |

**Why two vPDQ percentages?** Suppose the original has ten unique qualifying
frames and the comparison contains five of them. Original found can be 50%,
while comparison found is 100%. These percentages describe sampled unique
hashes, not exact percentages of playback time.

Cleaner implements the public vPDQ unordered matching method with Meta's native
PDQ hasher. Each complete video is sampled independently at one-second intervals,
or wider intervals to cap it at 64 frames. Duplicate hashes are counted once;
quality must be at least 50, and a match allows at most 31 differing bits. These
are explicit comparison settings, not claimed Meta platform thresholds. Frame
order is ignored. Short overlaps can be missed by sampling, and a video with no
qualifying frames gets no percentage.

**Motion jitter** uses up to three 1.25-second windows per video, at 8 fps on a
64×64 grid. It estimates translation between adjacent frames and reports the
root-mean-square change in that translation, in grid pixels per frame-step².
Flat frames, boundary-sized shifts and large residual changes are excluded.
The card reports usable frame triples and rejected pairs. It cannot isolate
camera shake from subject motion, zoom, cuts or speed changes. Some cuts may
escape rejection. A blank result means insufficient usable motion samples.
Original and comparison windows are sampled independently, so trims may change
which content is evaluated. This is not an optical-flow or stabilization grade.

The older **0–1 score** is still present: **TMK temporal · L2**. SSCD is a separate
image-descriptor score. Both are visible in the score area.

### File hashes versus visual fingerprints

**MD5** identifies file bytes. Removing metadata or adding container padding can
change MD5 while leaving the picture and visual scores unchanged. The unique
hash option adds harmless MP4 `free`-box padding; it does not edit the picture.
For a given upload and unchanged settings, padding is deterministic so repeated
measure/export operations can be compared meaningfully.

PDQ, SSCD, TMK and vPDQ compare visual information. They do not measure audio.
Metadata stripping, audio changes and padding alone should not be treated as
visual changes. Captions burned into the picture do affect visual measurements.

JSON comparison reports include settings, MD5, score values, sampling details,
PDQ hashes/quality, TMK descriptor checksums, and the SSCD model identity/checksum.
A TMK descriptor checksum is a checksum of the descriptor, not of the video.

## How cleanup works

Cleaner uses FFmpeg to rebuild the output container with the selected video and
audio, excluding identifying metadata and extra non-audio/video tracks. It does
not run Metadata++, HashManager or BatchPurifier; the corresponding cleanup,
byte-hash and batch features are implemented here.

### Cleanup presets

| Preset                          | Result                                                  |
| ------------------------------- | ------------------------------------------------------- |
| **Full privacy** — default      | Remove all six native metadata categories below         |
| **Keep credits**                | Retain supported native author/copyright fields         |
| **Keep credits & descriptions** | Also retain supported titles, descriptions and comments |
| **Custom selection**            | Choose which native categories to remove                |

The six native categories are **location/GPS**, **camera/device/software**,
**dates/timestamps**, **author/copyright**, **titles/descriptions/comments** and
**other native tags**. An unchecked category asks Cleaner to keep it. Retained
values are reapplied from the original where the MP4 format supports them; the
audit tells you when requested values did not survive.

All edited exports also drop embedded **XMP**, embedded **C2PA** container
credentials, chapters, cover images and additional non-audio/video tracks.
Keeping native credits does not keep an entire XMP or C2PA package. Download the
original if you need its original credentials. Cleaner does not validate C2PA
signatures or recreate a valid signature after editing.

Necessary playback structure remains: codecs, dimensions, duration, container
brands and applicable orientation information. “Clean” does not mean literally
zero fields of any kind.

### Does cleaning reduce quality?

For unadjusted MP4/MOV/M4V with compatible codecs, Cleaner stream-copies the video
and audio through the cleanup remux. This avoids recompression. Supported copied
video codecs include H.264, HEVC, AV1, MPEG-4 and VP9; copied audio includes AAC,
MP3, AC-3, E-AC-3 and ALAC.

Visual/timeline/audio adjustments, other containers and unsupported camera codecs
such as ProRes use the H.264/AAC export path. This encoding can alter image/audio
quality. A final remux removes generated encoder tags and reapplies only selected
native fields. Cleanup uses the same pipeline for download, measurement, batch
export and Caption Studio transfer.

## Deeper inspection and cleanup verification

Upload inspection lists native tags and checks supported MP4/M4V/MOV container
headers for XMP UUID boxes, QuickTime `XMP_` boxes, C2PA BMFF UUID boxes and
unknown UUID boxes. Metadata lists expand with the page, without an inner
scrollbar.

**Check cleanup** renders current settings, inspects the result and deletes the
temporary render. Full measurement includes the same audit. The audit uses these
states:

- **Removed:** found before, absent after.
- **Kept:** a category selected for retention survived.
- **Remaining:** something selected for removal is still reported.
- **Not retained:** requested preservation did not survive export.
- **Not found:** no matching inspected entry was found.
- **Unchecked:** inspection could not fully cover it.

The container scanner skips compressed media payloads and has bounded work:
30,000 boxes, 12 nested levels and 256 findings. Truncated or over-limit files
are marked partially checked. Embedded inspection of MKV/WebM is unsupported.
External sidecars, remote credentials, data hidden within compressed codec
payloads and C2PA signature validity are not inspected. The tool also does not
remove identifying faces, spoken names or text visible in the picture.

Downloaded cleanup audit reports include categories, counts, tag keys and box
locations, **not stripped GPS/device values**. Private native values can still
appear in the original's on-screen metadata details.

## Compare two uploads

Drop or choose **two videos at once** and Cleaner opens the comparison and
measures them as soon as both have uploaded: the first file is the original,
the second the comparison. Otherwise upload the second version, select both
videos and use the comparison view. The files play side by side. Measurements analyze the uploaded files as they are;
the editor's unexported settings are not silently applied to this comparison.

PDQ, SSCD and color diagnostics compare matching timestamps within the shorter
video. Independently uploaded clips are not automatically aligned by content.
TMK evaluates complete videos; vPDQ searches unordered frames across each whole
video, making it useful when durations or scene order differ.

## Caption Studio round trips

You can send a source from Caption Studio into Cleaner and send the edited clip
back, or clean first and open the result in Caption Studio afterward.

Where editable caption data is available, the timeline mapping adjusts words,
cues, text overlays and timed position/visibility segments for cuts, scene order
and speed. Removed regions are excluded; repeated scenes repeat their timed
annotations. The result is a new clip, preserving the earlier source. Review
caption layout after crop/rotation and other framing changes.

Captions already burned into the pixels cannot be recovered as editable text or
removed by this transfer. Cleaner does not use OCR to reconstruct them.
Caption Studio clips created by transfer follow Caption Studio's retention, not
the Cleaner's temporary one-hour session expiry.

## Batch cleanup and ZIP export

Expand **Batch cleanup & ZIP export**, select uploads, choose a cleanup policy
and start the batch. Each video keeps its own edit and unique-hash settings;
the batch policy overrides metadata cleanup for that batch only.

A batch supports **1–20 videos**, up to **10 GiB of source media** and **20 GiB of
output**. It processes videos sequentially, shows progress and supports cancel.
There is one outstanding job per user, two active jobs globally and a 30-minute
job deadline.

The ZIP contains numbered MP4s and `cleanup-report.json`. Batch export verifies
cleanup but does not run all perceptual measurements. Rendered intermediates are
removed after packaging. The ZIP expires after an hour; the UI deletes it after
download and defaults to deleting the selected Cleaner source sessions too.
Failed downloads can be retried while the ZIP remains available. Refresh can
recover job progress, but jobs do not resume across server restarts.

## Speed, caching and storage

Fast PDQ/color requests start after a 160 ms pause in adjustments. SSCD has its
own 500 ms debounce and cancellation lane, so it does not delay PDQ results.
New settings replace older work. One native SSCD frame already in progress may
finish before cancellation; obsolete jobs do not continue through more frames.
Inference uses a bounded queue and one warmed CPU model, with two native threads.

Small source frames and source SSCD descriptors are cached within the upload's
session, capped at 32 sampled moments per scoring lane. Adjusted frames are
removed after each request. The browser caches up to 24 successful settings per
lane. It does not store video copies in that cache.

Full measurement is slower because it renders the edit, decodes videos for TMK
at 15 fps, samples vPDQ frames and measures motion. Processing time depends on
length, resolution, codec and server load. The displayed milliseconds describe
the latest server-side fast score, not total upload/network time. Optional
**automatic full verification** is off by default.

The editor does not save a new video version after each adjustment. Downloads
and measurements use temporary files, removed after completion or cancellation.
Uploaded originals expire after one hour of inactivity. **Delete server session
after download** is on by default; disable it if you want to continue editing.
Explicit session deletion removes its caches and legacy versions too. Crash
leftovers are cleaned when their containing session expires. Local downloads
remain on your computer.

Scoring runs on this app's server. Media and fingerprints are not sent to Meta.
Runtime setup downloads public models/tools; it does not upload your videos.

## Developer setup and verification

Run these commands from `apps/captions`. The workspace uses pnpm 10.32.1.

```sh
pnpm install
bash scripts/install-fingerprint-runtime.sh
node scripts/verify-fingerprint-runtime.mjs
```

PDQ/TMK require FFmpeg, ffprobe, C++14 and make. On macOS the reference build also
needs OpenMP headers (`brew install libomp`). Production installs its pinned
FFmpeg and fingerprint runtime during deployment. `FINGERPRINT_BIN_DIR` and
`FFMPEG_PATH` can override their locations.

SSCD uses the public **sscd_disc_mixup** ResNet50 model, square 320×320 RGB input,
ImageNet channel normalization and a 512-value normalized output. ONNX Runtime
1.24.3 runs it on CPU. The model is not checked into Git.

Create a verified cache once on a machine with Python, torch 2.11.0, onnx 1.19.1
and numpy 2.3.5:

```sh
curl -fL https://dl.fbaipublicfiles.com/sscd-copy-detection/sscd_disc_mixup.torchscript.pt -o /tmp/sscd.torchscript.pt
python3 scripts/export-sscd.py /tmp/sscd.torchscript.pt /tmp/sscd-cache
node scripts/install-sscd-runtime.mjs runtime/sscd /tmp/sscd-cache
node scripts/verify-sscd-runtime.mjs
```

The exporter checks the original model SHA256 before loading it. The installer
and runtime check the ONNX checksum. The verifier compares a deterministic
synthetic tensor against the original TorchScript descriptor. If another exporter
version changes the binary, verify parity and deliberately update the pinned
artifact rather than bypassing checksum checks. Include `sscd-LICENSE.txt` with
the runtime. `SSCD_MODEL_PATH` can override the model file location.

Production's persistent cache is
`/srv/creator-toolset/.cache/captions-sscd-831a55f` and contains `sscd.onnx`,
`manifest.json` and `parity.json`. Deploy copies the verified model into the new
release and checks inference before swapping the running app. Python/PyTorch are
not needed in production. Other installations, including containers, must supply
the verified model and native tools explicitly.

```sh
pnpm check
pnpm test
node scripts/verify-sscd-runtime.mjs
```

Native integration tests use generated media and skip when runtimes are absent.
Install the runtimes before release validation. The service supports one server
process per data directory; API access enforces session ownership.

### API map

Routes are under `/api/clean/sources` unless noted:

| Route                                                     | Purpose                                                   |
| --------------------------------------------------------- | --------------------------------------------------------- |
| `POST /?name=video.mp4`                                   | Upload raw media bytes and inspect                        |
| `GET /:id`                                                | Source details, inspection and legacy history             |
| `GET /:id/media`                                          | Range-aware original preview                              |
| `POST /:id/score`                                         | Fast PDQ and color/contrast/brightness estimates          |
| `POST /:id/sscd`                                          | Independently cancellable live SSCD estimate              |
| `POST /:id/frame`                                         | Paused preview frame                                      |
| `POST /:id/cuts`                                          | Propose scene boundaries                                  |
| `POST /:id/measure`                                       | Temporary encoded edit and all measurements               |
| `POST /:id/audit`                                         | Temporary encoded edit and metadata audit only            |
| `POST /:id/compare`                                       | Measure two uploaded originals                            |
| `POST /:id/export`                                        | Stream an edited MP4                                      |
| `POST /:id/to-captions`                                   | Transfer edited media and mapped caption data             |
| `POST /:id/draft/cancel`, `/score/cancel`, `/sscd/cancel` | Cancel the appropriate lane using client/revision headers |
| `DELETE /:id`                                             | Delete upload, caches and legacy versions                 |
| `POST /batch`, `GET /batch`, `GET /batch/:jobId`          | Start/recover/check a batch                               |
| `GET /batch/:jobId/download`, `DELETE /batch/:jobId`      | Download or cancel/delete a batch                         |

Legacy version routes and one-shot `/api/clean` remain for compatibility. New
editor operations use temporary renders rather than saved video versions.

### Sources

- [Meta PDQ and TMK reference implementations](https://github.com/facebook/ThreatExchange)
- [Meta vPDQ matching method](https://github.com/facebook/ThreatExchange/tree/main/vpdq)
- [Meta SSCD model and preprocessing](https://github.com/facebookresearch/sscd-copy-detection)
- [C2PA BMFF container embedding](https://spec.c2pa.org/specifications/specifications/2.2/specs/C2PA_Specification.html)
