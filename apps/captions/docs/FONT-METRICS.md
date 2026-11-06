# Font metrics: why the export needs a correction table

The preview lays captions out in the DOM; the export hands an ASS file to
ffmpeg/libass. Those two size and place text by **different rules**, so
"what you see" and "what renders" only agree if the ASS compensates.
`src/lib/types.ts` carries two measured tables for that, and this is how
to regenerate them when a font is added or replaced.

## 1. `FONT_ASS_SCALE` — CSS px → ASS Fontsize

libass scales a face by `hhea(ascender − descender) / OS2(winAscent +
winDescent)` before rendering, so `Fontsize: 48` is **not** 48 CSS px.
The shortfall is per-font and large:

| family | libass cap @100 | CSS cap @100 | scale |
| --- | --- | --- | --- |
| Montserrat SemiBold | 45 | 70 | 1.556 |
| Poppins | 39 | 71 | 1.821 |

Left uncorrected a Montserrat caption exports 36% smaller than the
preview — which reads as a different font in a box with far too much
padding, not as "slightly small".

**Measure it:** render `HHHH` through libass at `Fontsize: 100`, on a
frame whose `PlayResX/Y` equals the output size (so the scale is 1:1),
and measure the cap height in pixels:

```
ffmpeg -f lavfi -i "color=c=black:size=1000x400:rate=1:duration=1" \
  -vf "subtitles='cal.ass':fontsdir='public/fonts'" -frames:v 1 cal.png
```

Compare against the same face rasterized at `em = 100` (PIL
`ImageFont.truetype(file, 100)`, which matches the browser). The table
value is `css_cap / libass_cap`.

Verified identical on macOS (libass 0.17.x) and the server's ffmpeg
4.4.x — the ratio comes from the font's own metrics, not the build.

## 2. `FONT_ASS_BASELINE` — vertical nudge, in em

With the size fixed, lines still land a little low: libass centers an
`\an5` line on its font metrics, while CSS centers the *line box* and
drops the baseline by half-leading. ~13px at a 100px Anton caption.

**Measure it:** render `H` (its ink bottom *is* the baseline) at
`\an5\pos(x, y)` and take `libass_offset = ink_bottom − y`. Get the CSS
side from canvas — `measureText("H").fontBoundingBoxAscent/Descent` uses
the same metrics Chrome lays out with — as `(A − D) / 2`. The table value
is `(css_offset − libass_offset) / em`.

## Everything else is drawn explicitly

Beyond the two tables, `buildAss` doesn't let libass make layout
decisions: it measures each line with a canvas using the preview's own
font, positions every line itself at a 1.18em pitch, and draws the
caption box as a `\p4` rounded-rect path (libass's `BorderStyle: 3` box
is square-cornered, per-line, and uniformly padded — none of which
matches the preview). Keep the `em` constants at the top of
`src/lib/ass.ts` in sync with `blockStyle` in `src/components/Player.tsx`.

## Regression check

`scripts/check-font-parity.md` describes the browser-vs-libass harness:
drive the app with Playwright, screenshot the caption on black, render
the same ASS through ffmpeg, and compare ink bounding boxes. Current
agreement is ≤5px width and ≤1px position on a 1080×1920 frame.
