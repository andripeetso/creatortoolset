import type { DatabaseSync } from "node:sqlite";
import { libraryChanged } from "./access";
import { enqueueJob } from "./jobs";
import { mayLeave } from "./upload-gate";

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
/** The video filter that turns a picture `t` degrees clockwise ("" for none). */
export const turnFilter = (t: number | undefined) => FILTERS[asTurn(t)] ?? "";
/** `chain` with the turn in front of it. */
export const turned = (t: number | undefined, chain: string) => [turnFilter(t), chain].filter(Boolean).join(",");

/**
 * Sets a version's turn. Its thumbnail is made again from the clip, upright; its strip goes and is made again too (none
 * for a file on a Mac: its card shows the thumbnail).
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
  db.prepare("DELETE FROM derivatives WHERE version_id = ? AND kind = 'sprite'").run(versionId);
  // the picture and the strip are made again, upright, from the clip: a library job (DECODES), so on a computer unless
  // the server's video work is on; the old picture shows until then
  // Blur faces: a clip not blurred has no picture here to make again (upload-gate.ts mayLeave)
  if (mayLeave(v.library_id, { versionId }).ok) {
    enqueueJob(db, v.library_id, versionId, "thumb", v.created_by, true);
    if (!v.source_key.startsWith("mac:")) enqueueJob(db, v.library_id, versionId, "sprite", v.created_by, true);
  }
  libraryChanged(v.library_id);
}
