import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { env } from "../lib/env";
import { libraryChanged } from "./access";
import { blobs } from "./db";
import { enqueueJob } from "./jobs";
import { ffmpegTo } from "./media/run";

/**
 * A clip's own turn: the clockwise degrees (0, 90, 180, 270) the library turns its picture to show it upright, on top
 * of the file's own rotation (a screen recording filmed sideways has none to read). The AI sets it with its
 * description (describe.ts), the person with Rotate in the clip window. Kept in the version's probe as `turn`; the
 * file is never changed. The thumbnail and the strip are made upright; the player turns the video (ClipPlayer.tsx).
 */

export const asTurn = (t: unknown): 0 | 90 | 180 | 270 => {
  const n = ((Math.round(Number(t) / 90) * 90) % 360 + 360) % 360;
  return (Number.isFinite(n) ? n : 0) as 0 | 90 | 180 | 270;
};

const FILTERS: Record<number, string> = { 90: "transpose=1", 180: "hflip,vflip", 270: "transpose=2" };
/** The ffmpeg filter that turns a picture `t` degrees clockwise ("" for none). */
export const turnFilter = (t: number | undefined) => FILTERS[asTurn(t)] ?? "";
/** `chain` with the turn in front of it. */
export const turned = (t: number | undefined, chain: string) => [turnFilter(t), chain].filter(Boolean).join(",");

const scratch = () => process.env.LIBRARY_SCRATCH_DIR || path.join(env.dataDir, "library", "scratch");

/**
 * Sets a version's turn. Its thumbnail is turned where it is (a file kept on a Mac has no other); its strip goes and is
 * made again from the clip, upright (none for a file on a Mac: its card shows the thumbnail).
 */
export async function turnVersion(db: DatabaseSync, versionId: string, turn: number): Promise<void> {
  const v = db
    .prepare("SELECT a.library_id, v.source_key, v.probe, v.created_by FROM asset_versions v JOIN assets a ON a.id = v.asset_id WHERE v.id = ?")
    .get(versionId) as { library_id: string; source_key: string; probe: string | null; created_by: string } | undefined;
  if (!v?.probe) return;
  const was = asTurn((JSON.parse(v.probe) as { turn?: number }).turn);
  const to = asTurn(turn);
  if (to === was) return;
  db.prepare("UPDATE asset_versions SET probe = json_set(probe, '$.turn', ?) WHERE id = ?").run(to, versionId);
  const thumb = (db.prepare("SELECT storage_key FROM derivatives WHERE version_id = ? AND kind = 'thumb'").get(versionId) as { storage_key: string | null } | undefined)?.storage_key;
  if (thumb) {
    await mkdir(scratch(), { recursive: true });
    const out = path.join(scratch(), `turn-${randomUUID()}.jpg`);
    try {
      await ffmpegTo(out, ["-i", await blobs.localCopy(thumb), "-vf", turnFilter(to - was), "-q:v", "4"], true);
      const { bytes } = await blobs.put(thumb, out);
      db.prepare("UPDATE derivatives SET bytes = ? WHERE version_id = ? AND kind = 'thumb'").run(bytes, versionId);
    } finally {
      await rm(out, { force: true });
    }
  }
  db.prepare("DELETE FROM derivatives WHERE version_id = ? AND kind = 'sprite'").run(versionId);
  if (!v.source_key.startsWith("mac:")) enqueueJob(db, v.library_id, versionId, "sprite", v.created_by, true);
  libraryChanged(v.library_id);
}
