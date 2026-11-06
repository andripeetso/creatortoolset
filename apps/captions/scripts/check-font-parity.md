# Caption parity harness (preview vs export)

Proves the ASS export renders what the editor shows. Compares ink
bounding boxes, so it catches size, position, line-pitch and box
regressions that eyeballing misses. See `docs/FONT-METRICS.md` for why
the correction tables exist.

```bash
# 1. dev server with auth off, so the harness can drive a project
APP_SECRET= npx vite --port 3100 --strictPort

# 2. playwright-core + local Chrome (installed outside the repo)
npm i playwright-core   # in a scratch dir

# 3. drive the app: sets a project into the store, pins currentTime,
#    hides the <video>, screenshots the caption on black, and builds the
#    ASS in-page so canvas line measurement is the real thing
T=0.5 OUT=/tmp/cmp node scripts/font-parity-harness.cjs

# 4. render the same ASS and diff the ink boxes
ffmpeg -f lavfi -i "color=c=black:size=1080x1920:rate=10:duration=2" \
  -vf "subtitles=/tmp/cmp.ass:fontsdir=public/fonts" -ss 0.5 -frames:v 1 /tmp/cmp_export.png
```

Set `FORCE_STYLE` to exercise a style the project doesn't currently use,
e.g. `FORCE_STYLE='{"boxEnabled":true,"boxColor":"#7C3AED"}'` for the
rounded caption box.

Expected: width within ~5px, height within ~1px, centre within ~1px on a
1080×1920 frame. Ink pixel counts differ a few percent — Chrome and
libass antialias differently; that is not a regression.

The harness deliberately leaves `projectId` unset so autosave can never
write to the project it is reading.
