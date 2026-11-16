// The server's reading of look-clip.mp4, for LibraryLookTests.swift: what the Mac's reader must match. Made with the
// server's own code (apps/captions/api/library/look.ts and shots.ts) and the ffmpeg on PATH; run again when they change:
//   DATA_DIR=$(mktemp -d) apps/captions/node_modules/.bin/tsx apps/mac/Tests/CreatorToolsetMacTests/Fixtures/look-goldens.mts
// look-clip.mp4: 6 s of 400×224 at 60 frames a second, BT.709, four shots (ffmpeg's testsrc2, mandelbrot, smptehdbars, life).
import { writeFileSync } from "node:fs";
import path from "node:path";
import { cutsOf, readPicture, shotsOf, stretchSheet } from "../../../../captions/api/library/look";
import { sheetHashes } from "../../../../captions/api/library/shots";

const here = path.dirname(new URL(import.meta.url).pathname);
const clip = path.join(here, "look-clip.mp4");
const read = await readPicture(clip, 60);
const stretches = shotsOf(read, 6).map(({ a, b }) => [a, b] as [number, number]);
const sheet = path.join(here, "look-sheet.jpg");
await stretchSheet(clip, stretches.map(([a, b]) => ({ a, b })), 6, true, sheet);
const r6 = (x: number) => Math.round(x * 1e6) / 1e6;
writeFileSync(
  path.join(here, "look-goldens.json"),
  JSON.stringify({
    fps: read.fps,
    step: Array.from(read.step, r6),
    cut: Array.from(read.cut, r6),
    lag: Array.from(read.lag, r6),
    cuts: cutsOf(read),
    stretches,
    hashes: await sheetHashes(sheet, stretches.length, true),
  }) + "\n",
);
