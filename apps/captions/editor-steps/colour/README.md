# Colour (AI Editor step)

Turns log footage into normal video (Rec.709), on this computer, for every recording a draft shows on V1 and V2. It
uses each camera maker's own published conversion. It is never a grade: nothing is measured to choose a look, nothing
is matched, and there is no creative look. It runs first (`order` 10), before the face steps and Voice, so a pack's
grade (`api/editor/grade.ts`, applied at preview) sits on top of the converted copy.

## What it does with a file

| The file says | Camera profile: Auto (default) | A named profile | Off |
|---|---|---|---|
| a log it knows (below) | converted with that log | converted with the file's log (the file wins) | left alone |
| not log (Sony `rec709`, Fujifilm normal or HLG, an HLG or PQ tag) | left alone | left alone | left alone |
| a log it doesn't convert (e.g. Sony S-Log3 with S-Gamut3) | left alone, named in the notes | the same | left alone |
| nothing, and it looks flat | left alone, and the notes say: "Tiny-take looks flat (log?) but its camera profile isn't in the file: pick it under Colour in Settings → AI Editor" | converted with the named profile | left alone |
| nothing, and it doesn't look flat | left alone | left alone | left alone |

Each converted file gets a note: "Tiny-take: S-Log3 from the file, converted to normal video". Photos are left alone.

**Looks flat** (`flatStats`, `isFlat`): five frames spread over the file, shrunk to 64x36 and decoded as a player shows
them. The file is flat when its 2% luma is at least 25 (lifted blacks), its 2–98% luma range is at most 170 (low
contrast), and its mean per-pixel colour (max − min of R, G, B) is at most 30 (8-bit). A real Sony S-Log3 clip measured
63 / 99 / 13, and its converted copy is not flat. The result only writes the note or lets a named profile apply; it
never converts by itself.

## The conversion

A 33-point `.cube` 3D LUT is made in code at run time (`cube`, `convert`), written next to the copy and applied with
ffmpeg's `lut3d` (tetrahedral) on 16-bit RGB:

1. **Code values.** The file's YCbCr goes to RGB with its own matrix: BT.709, or BT.2020 when the file says so. Apple
   Log with no tag uses BT.2020, as its paper says. A file tagged full range is read as it is, and one tagged limited
   range is expanded first. An untagged file is limited range if it is ProRes (the QuickTime convention, Canon FAQ Q7)
   and full range otherwise (Sony FAQ Q4, Fujifilm FAQ, Canon FAQ Q6). The papers define their curves on the 10-bit code
   value / 1023.
2. **The log curve to scene-linear reflection**, in each paper's own decoding formula (`PROFILES`).
3. **The gamut to Rec.709 primaries**: the matrix is computed from the paper's primaries and the D65 white, which all
   of them share, so no white adaptation is needed (`toXyz`, `gamutTo709`, SMPTE RP 177).
4. **The display transform** (`display`), per channel:
   - negatives are clipped;
   - above 0.6 linear, a soft highlight roll-off: `0.6 + 0.4 · (1 − e^(−(x − 0.6) / 0.4))`, smooth at 0.6 and never
     above 1 (identity below 0.6, so grey and skin are untouched);
   - then the Rec.709 OETF: `1.099 · L^0.45 − 0.099`, or `4.5 · L` under 0.018.

   18% grey comes out at 0.409 (41%).
5. The copy is ProRes 422 HQ 10-bit, tagged BT.709. It keeps every frame (`-fps_mode passthrough`), the frame rate, the
   start timecode and the sound (copied). The Mac's own ProRes encoder is used when ffmpeg has it.

No LUT file from a camera maker is shipped or downloaded. Their licences don't clearly allow it.

**Cache:** the copy's name is a hash of the file, its size and mtime, the profile, the range, the matrix, the LUT and
`VERSION`, so a draft made again reuses its copy.

## The papers

Each curve is tested against the table its paper prints (`plugin.test.ts`): every printed code value must decode to its
reflection within half a code. The gamut matrices are tested to map white to white, Rec.709 to itself, and to match the
matrices the papers print.

| Profile | Gamut | Source | sha256 of the PDF read |
|---|---|---|---|
| S-Log3 | S-Gamut3.Cine | Sony, "Technical Summary for S-Gamut3.Cine/S-Log3 and S-Gamut3/S-Log3", https://pro.sony/s3/cms-static-content/uploadfile/06/1237494271406.pdf | `d9c8a042e7e9e8ee248df97633b645681b5370099a508b6cee97d8bad880d5d3` |
| F-Log | F-Log Gamut (= BT.2020) | Fujifilm, "F-Log Data Sheet Ver.1.0", https://dl.fujifilm-x.com/support/lut/F-Log_DataSheet_E_Ver.1.0.pdf | `ab093dabeefc5ce952c429cef7739eac639bcaa1adc6e1f601255e513127f980` |
| F-Log2 | F-Log Gamut (= BT.2020) | Fujifilm, "F-Log2 Data Sheet Ver.1.0", https://dl.fujifilm-x.com/support/lut/F-Log2_DataSheet_E_Ver.1.0.pdf | `cc54dce3012f611960634da12d161b1db2a786d03796bedff53e2ae70a43b72b` |
| Apple Log | BT.2020 | Apple, "Apple Log Profile White Paper" (September 2023, part 028-00768), from Apple's developer downloads (sign-in): https://developer.apple.com/download/all/?q=Apple%20log%20profile. The copy read was from a public mirror; its PDF says Author: Apple Inc. | `39537d07abc6d1555a4c058c0353e9dc43fa2eb9a5fda90adb63b0d508517fbe` |
| V-Log | V-Gamut | Panasonic, "V-Log/V-Gamut Reference Manual" (Rev.1.0, November 28, 2014), https://pro-av.panasonic.net/en/cinema_camera_varicam_eva/support/pdf/VARICAM_V-Log_V-Gamut.pdf | `d8a1837725abcca5da348b2dc6f212446db6a598cb61b093891af7ecbc0c8dcc` |
| C-Log2, C-Log3 | Cinema Gamut | Canon, "Canon Log Gamma Curves" white paper (November 1st, 2018), https://downloads.canon.com/nw/learn/white-papers/cinema-eos/white-paper-canon-log-gamma-curves.pdf | `43354b0601eef8bc2ab12cae0309e62232fc9fba3969c2453f35ba441098a2e0` |
| (Cinema Gamut) | | Canon, "Color Gamut Conversion for DCI-P3+ and Cinema Gamut" (PUB. DIM-1102-000, 2013), http://gdlp01.c-wss.com/gds/8/0200003438/01/colorgamutinfo-dim1102.pdf | `d235284ba986e067970bcc673cc6c4f554ec731c6a93870b577cf4fff93a4601` |

- Canon's curves take scene linear, where 18% grey is 0.2 (the paper: "reflection = Scene Linear * 0.9"); the decode
  multiplies by 0.9.
- The Cinema Gamut → BT.709 matrix computed from Canon's primaries is within 3.1e-4 of the one Canon prints. The
  primaries are printed to two decimals, so this was left as computed, not tuned.
- The V-Gamut matrices match Panasonic's printed ones within 2e-4, and BT.2020 → BT.709 matches ITU-R BT.2087.
- C-Log2 and C-Log3 assume Cinema Gamut, the gamut Canon recommends with them (FAQ Q8). A Canon file shot in another
  gamut would come out with the wrong colours.

**Left out:**
- Canon Log (the first one): its curve is printed, but it was not asked for.
- Apple Log 2 (iPhone 17 Pro): it uses Apple Wide Gamut, and no paper for that gamut was read.
- Sony S-Gamut3: it is in the same Sony paper, but no file tagged with it was seen, so only S-Gamut3.Cine is
  converted.

## What the files say

Read from camera-original sample clips (a camera review site's published samples), with only the metadata boxes
fetched (`metaBoxes` reads every top-level box but the media data). `ffprobe`'s colour tags never identify log: Sony's
S-Log3 clip has no colour tags at all, and Fujifilm writes BT.709 tags on every clip.

| Camera | Where | What was seen | Auto |
|---|---|---|---|
| Sony (A7S III, ZV-E1, 22 clips) | `NonRealTimeMeta` XML in a top-level box after `moov`: `<Item name="CaptureGammaEquation">`, `<Item name="CaptureColorPrimaries">` | `s-log3-cine` + `s-gamut3-cine` (one A7S III clip, tagged full range), `rec709` + `rec709` (the rest, tagged limited) | converts `s-log3-cine` + `s-gamut3-cine`. Another `s-log…` value is named in the notes, anything else is normal |
| Fujifilm (X-H2S, X-H2, X-S20 and an older X body, 25 clips) | the maker note in `moov/udta/MVTG` ("FUJIFILM" + an IFD), tag 0x3803 VideoRecordingMode | `0` (normal) in every clip | 0x10 F-Log, 0x30 F-Log2, 0x20 HLG. **These values come from ExifTool's Fujifilm table. No F-Log clip was seen** |
| Apple (iPhone) | — | no camera-original Apple Log clip was found; an edited export carried BT.709 tags | **not detected**: Apple Log is a named profile only |
| Panasonic (GH6), Canon (R5, R6 II) | — | no log clip; Canon writes `nclx` tags (BT.709, or BT.2020 + PQ for HDR) | **not detected**: V-Log, C-Log2 and C-Log3 are named profiles only |

## Checked on a real file

A camera-original Sony A7S III S-Log3 clip, 3840x2160 HEVC 4:2:2 10-bit, 468 frames at 23.976:
- Auto found S-Log3 in its XML.
- The copy has 468 frames, the same start timecode (10:29:02:04), the PCM sound, and BT.709 tags.
- In the before/after frames, contrast and colour look normal and the white swan keeps its detail: under 1% of pixels
  are above code 936 of 940.

## Not checked yet

- the code-value range of any camera but Sony (the rule above follows the makers' FAQs)
- the curves on real F-Log, F-Log2, Apple Log, V-Log or Canon Log files: they are checked only against the papers'
  tables
- variable-frame-rate phone files: every frame is kept with its own time (`passthrough`)

## Check it

```sh
node scripts/plugin-build.mjs check editor-steps/colour
pnpm exec vitest run editor-steps/colour
```

## Disk

Each copy is the whole recording in ProRes 422 HQ, about 1.4 GB for each minute of video at 1080x1920 (the 20 s 4K
sample came to 1.7 GB). Later steps make their own copy from it, and the version keeps only the copy that plays (`prune`
in `api/editor/post.ts`).
