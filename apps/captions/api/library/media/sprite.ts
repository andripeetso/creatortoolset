import { rm } from "node:fs/promises";
import { SPRITE_FRAMES } from "../../../contracts/library";
import { ffmpegTo } from "./run";

/** One frame of the strip, cut to the card's own shape (a card shows its picture 16:9, cover). */
export const SPRITE_W = 160;
export const SPRITE_H = 90;
const CELL = `scale=${SPRITE_W}:${SPRITE_H}:force_original_aspect_ratio=increase,crop=${SPRITE_W}:${SPRITE_H},setsar=1`;
/** Seeks per ffmpeg run. */
const BATCH = 5;

/** The second frame `i` of the strip shows: the middle of its share of the clip (the card's hover and the filmstrip read it so). */
export const spriteTime = (i: number, duration: number) => ((i + 0.5) * duration) / SPRITE_FRAMES;

/**
 * A strip of SPRITE_FRAMES frames across the clip, side by side in one JPEG (SPRITE_W × SPRITE_H each): the card's
 * hover scrub and the clip window's filmstrip. Each frame is one seek; nothing decodes the whole clip.
 * Measured on a 2-minute 3840×2160 10-bit H.264 clip (a busy Linux box): decoding all of it took 10 to 12 s and
 * grows with the clip's length; 20 seeks in one run took 1.4 s at 1.5 GB (5.4 to 12.8 GB with ffmpeg's own threads),
 * and in runs of 5 at one thread each 1.9 to 3.1 s at 0.45 GB. A keyframe every 10 s makes each seek decode up to 10 s
 * of 4K (about 20 s in all), still bounded by the gap, not the clip's length. From a 720p lighter copy it is quick.
 */
export async function makeSprite(src: string, out: string, duration: number): Promise<void> {
  if (!(duration > 0)) throw new Error("No length to take frames from");
  const parts: string[] = [];
  try {
    for (let from = 0; from < SPRITE_FRAMES; from += BATCH) {
      const n = Math.min(BATCH, SPRITE_FRAMES - from);
      const args = Array.from({ length: n }, (_, j) => ["-threads", "1", "-ss", spriteTime(from + j, duration).toFixed(3), "-i", src]).flat();
      const graph = Array.from({ length: n }, (_, j) => `[${j}:v:0]${CELL}[f${j}]`).join(";") + ";" + Array.from({ length: n }, (_, j) => `[f${j}]`).join("") + `hstack=inputs=${n}`;
      const part = `${out}.${from}.png`; // beside `out` (scratch), lossless between the runs: one JPEG encode at the end
      await ffmpegTo(part, [...args, "-filter_complex", graph, "-frames:v", "1"]);
      parts.push(part);
    }
    await ffmpegTo(out, [...parts.flatMap((p) => ["-i", p]), "-filter_complex", `hstack=inputs=${parts.length}`, "-frames:v", "1", "-q:v", "5"]);
  } finally {
    await Promise.all(parts.map((p) => rm(p, { force: true })));
  }
}
