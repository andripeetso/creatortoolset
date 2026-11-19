import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import type { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { SPRITE_FRAMES, SPRITE_SIDE } from "../../../contracts/library";
import type { ProbeSummary } from "./probe";
import { jpegSize } from "../pictures";
import { asTurn, turned } from "../turn";
import { ffmpegTo } from "./run";

/** One frame of the strip, in the clip's own shape at most SPRITE_SIDE on its longer side: each card cuts it to its own box. */
const CELL = `scale=${SPRITE_SIDE}:${SPRITE_SIDE}:force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1`;
/** A strip with no frame size noted (cell_w NULL) is from before 2026-11-19, or a Mac app's own index: 160 × 90 cuts. */
export const OLD_CELL = { w: 160, h: 90 } as const;

/** A version's strip as the card's scrub and the player's thumbnails read it: one frame's size and the count. Null: none. */
export function stripOf(db: DatabaseSync, versionId: string): { w: number; h: number; frames: number } | null {
  const r = db.prepare("SELECT cell_w, cell_h FROM derivatives WHERE version_id = ? AND kind = 'sprite'").get(versionId) as { cell_w: number | null; cell_h: number | null } | undefined;
  return r ? { w: r.cell_w ?? OLD_CELL.w, h: r.cell_h ?? OLD_CELL.h, frames: SPRITE_FRAMES } : null;
}

/**
 * After a strip is kept for `versionId` (a replace clears it): its frame size, read from the JPEG itself. A 160 × 90 one
 * (the Mac app's own index still cuts them so) is left unnoted, as an old strip: made again when it isn't the clip's shape.
 */
export function noteStrip(db: DatabaseSync, versionId: string, jpeg: Buffer): void {
  const s = jpegSize(jpeg);
  if (s && !(s.w === OLD_CELL.w * SPRITE_FRAMES && s.h === OLD_CELL.h)) db.prepare("UPDATE derivatives SET cell_w = ?, cell_h = ? WHERE version_id = ? AND kind = 'sprite'").run(Math.round(s.w / SPRITE_FRAMES), s.h, versionId);
}

/** A clip's width / height as it is watched (its rotation tag, then its turn), as the card shows it (query.ts toCard). Null: unknown. */
export function watchedAspect(probe: string | null): number | null {
  const p = JSON.parse(probe ?? "null") as Partial<ProbeSummary> | null;
  if (!p?.width || !p.height) return null;
  const side = (((p.rotation ?? 0) + asTurn(p.turn)) / 90) % 2 === 1;
  return side ? p.height / p.width : p.width / p.height;
}

/** An old strip (no frame size noted) whose 16:9 cuts are not the clip's shape: an upright or square clip's, made again once. */
export const strayStrip = (aspect: number | null) => aspect !== null && Math.abs(Math.log(aspect / (OLD_CELL.w / OLD_CELL.h))) > Math.log(1.15);

/** Seeks per ffmpeg run. */
const BATCH = 5;

/** The second frame `i` of the strip shows: the middle of its share of the clip (the card's hover and the filmstrip read it so). */
export const spriteTime = (i: number, duration: number) => ((i + 0.5) * duration) / SPRITE_FRAMES;

/**
 * The last moment a seek still finds a picture: just before the start of the picture's last frame. Its sound may run on after it
 * (the file's length is the longer of the two), and a seek past the last frame reads nothing.
 * ponytail: a container that gives the picture no length of its own (some MKV) falls back to the file's
 */
async function lastFrame(src: string, duration: number): Promise<number> {
  const { stdout } = await promisify(execFile)("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=duration,r_frame_rate", "-of", "json", src]);
  const v = (JSON.parse(stdout) as { streams?: { duration?: string; r_frame_rate?: string }[] }).streams?.[0];
  const [a, b] = String(v?.r_frame_rate ?? "").split("/").map(Number);
  const frame = a && b ? b / a : 1 / 25;
  // half a frame more, so no rounding of the time lands it after that frame's start
  return Math.max(0, Math.min(Number(v?.duration) || duration, duration) - 1.5 * frame);
}

/**
 * A strip of SPRITE_FRAMES frames across the clip, side by side in one JPEG (CELL each): the card's
 * hover scrub and the clip window's filmstrip. Each frame is one seek; nothing decodes the whole clip.
 * Measured on a 2-minute 3840×2160 10-bit H.264 clip (a busy Linux box): decoding all of it took 10 to 12 s and
 * grows with the clip's length; 20 seeks in one run took 1.4 s at 1.5 GB (5.4 to 12.8 GB with ffmpeg's own threads),
 * and in runs of 5 at one thread each 1.9 to 3.1 s at 0.45 GB. A keyframe every 10 s makes each seek decode up to 10 s
 * of 4K (about 20 s in all), still bounded by the gap, not the clip's length. From a 720p lighter copy it is quick.
 */
export async function makeSprite(src: string, out: string, duration: number, turn = 0): Promise<void> {
  const cell = turned(turn, CELL); // upright first, then made small
  if (!(duration > 0)) throw new Error("No length to take frames from");
  const last = await lastFrame(src, duration);
  const parts: string[] = [];
  try {
    for (let from = 0; from < SPRITE_FRAMES; from += BATCH) {
      const n = Math.min(BATCH, SPRITE_FRAMES - from);
      const args = Array.from({ length: n }, (_, j) => ["-threads", "1", "-ss", (Math.floor(Math.min(spriteTime(from + j, duration), last) * 1000) / 1000).toFixed(3), "-i", src]).flat();
      const graph = Array.from({ length: n }, (_, j) => `[${j}:v:0]${cell}[f${j}]`).join(";") + ";" + Array.from({ length: n }, (_, j) => `[f${j}]`).join("") + `hstack=inputs=${n}`;
      const part = `${out}.${from}.png`; // beside `out` (scratch), lossless between the runs: one JPEG encode at the end
      await ffmpegTo(part, [...args, "-filter_complex", graph, "-frames:v", "1"]);
      parts.push(part);
    }
    await ffmpegTo(out, [...parts.flatMap((p) => ["-i", p]), "-filter_complex", `hstack=inputs=${parts.length}`, "-frames:v", "1", "-q:v", "5"]);
  } finally {
    await Promise.all(parts.map((p) => rm(p, { force: true })));
  }
}

/** Seconds as WebVTT reads them: 00:01:02.500. */
const vttTime = (t: number) => new Date(Math.max(0, t) * 1000).toISOString().slice(11, 23);

/**
 * The clip's strip as preview frames for the player's bar (a WebVTT thumbnails track): frame i covers the i-th share of
 * the clip and points at its cut of the strip (#xywh), in the strip's own frame size (stripOf). Its address carries that
 * size (?s=), so a strip made again is never answered from what the window kept.
 */
export function thumbsVtt(versionId: string, duration: number, strip: { w: number; h: number; frames: number }): string {
  const url = `/api/library/media/${versionId}/sprite?s=${strip.w}x${strip.h}`;
  const cues = Array.from({ length: strip.frames }, (_, i) => {
    const from = (i * duration) / strip.frames;
    const to = ((i + 1) * duration) / strip.frames;
    return `${vttTime(from)} --> ${vttTime(to)}\n${url}#xywh=${i * strip.w},0,${strip.w},${strip.h}`;
  });
  return `WEBVTT\n\n${cues.join("\n\n")}\n`;
}
