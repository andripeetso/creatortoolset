# Story Splitter

### Story Splitter (`/stories`, everyone)

One video → stories of about 20 s (slider 8–45; Instagram's 60 s cap is flagged), downloaded as one ZIP. All of it runs in the browser with mediabunny (`src/lib/story-split.ts`); nothing is uploaded.

- Frame differences find the edit's hard cuts. Loudness finds pauses and a steady beat. Each becomes a scored spot.
- `planCuts` picks the spots nearest the target length (shortest path over spots and a 0.25 s grid), through any cuts the user added (double-click or C = "about here", snapped within 2.5 s).
- Stories are re-encoded H.264/AAC (frame-exact) and zipped without compression (`zipStored`).
- The encoder asks for a bitrate (`Quality` very-high, `preferBitrate`). WebKit (Safari) throws on mediabunny's first choice, so the fallback is bitrateMode "quantizer".

**Saved splits.** Downloading the ZIP keeps the split (`api/stories.ts`, `$DATA_DIR/stories/<id>.json`: owner, file name, cuts in seconds, story length, duration). Downloading again updates it. With no video open, the page lists "Previous splits" (newest first, own only; × deletes). A saved split asks for its file again by name, and its saved cuts apply instead of a new plan, unless the video's length differs by 0.5 s or more.
