import { isOnline, isThisMachine, listDevices } from "../lib/devices";
import { libraryDb } from "../library/db";
import { wordsOf } from "../library/transcribe";
import { dropTask, startTask, taskFor, taskWaitLine } from "../work/tasks";
import { LOUDNESS_TASK, readLoud } from "./analyze";
import { fileFor, foldersOf, type FileRow } from "./reach";
import { editSources } from "./store";

/**
 * What the editor's Normalize and Lower Under Voice read of a source (POST /api/editor/sound): its measured blocks
 * (src/lib/nle/loudness.ts Measured, as base64 little-endian float32), its spoken words in source seconds, or the line
 * of its measuring while it waits (a computer of the asker measures it: work/tasks/loudness.ts), or why it can't be.
 */
export interface SourceSound {
  blocks?: string;
  words?: [number, number][];
  line?: string;
  error?: string;
}

/** The most sources one call asks about. */
export const SOUND_MAX = 50;

/** Each library version in `ids` the user may see: what is known of its sound, its measuring started when it has none. */
export async function soundOf(user: string, ids: string[]): Promise<Record<string, SourceSound>> {
  const db = libraryDb();
  const out: Record<string, SourceSound> = {};
  for (const id of [...new Set(ids)].slice(0, SOUND_MAX)) {
    const ws = await editSources(user, [id]);
    if (!ws) {
      out[id] = { error: "Not found" };
      continue;
    }
    const words = wordsOf(db, id)?.map((w): [number, number] => [w.s, w.e]);
    const got: SourceSound = words?.length ? { words } : {};
    out[id] = got;
    let blocks = await readLoud(id);
    if (!blocks) {
      const t = taskFor(LOUDNESS_TASK, id);
      if (t?.state === "failed") {
        // said once; asking again starts over
        dropTask(LOUDNESS_TASK, id);
        got.error = t.error ?? "Could not measure the sound";
        continue;
      }
      if (t?.state === "queued" || t?.state === "running") {
        got.line = taskWaitLine(t) ?? t.line ?? "Measuring the sound";
        continue;
      }
      const row = db
        .prepare(
          `SELECT v.id, v.source_key, v.source_path, v.mac_path, v.mac_device, v.probe, a.library_id,
             (SELECT storage_key FROM derivatives WHERE version_id = v.id AND kind = 'proxy') AS proxy
           FROM asset_versions v JOIN assets a ON a.id = v.asset_id WHERE v.id = ?`,
        )
        .get(id) as FileRow | undefined;
      if (!row) {
        got.error = "Not found";
        continue;
      }
      // shortcut: the asker's own storage folders, not the workspace owner's; upgrade when a teammate normalizes footage only the owner's share reaches
      const folders = foldersOf(user);
      const on = listDevices((d) => d.owner === user && isOnline(d.id) && !!d.work?.tasks?.includes(LOUDNESS_TASK))
        .map((d) => ({ d, at: fileFor(row, d.id, folders, isThisMachine) }))
        .find((x) => x.at && "path" in x.at);
      const started = await startTask<object, unknown>(LOUDNESS_TASK, id, user, ws, {
        version: id,
        sourceKey: row.source_key,
        ...(on && on.at && "path" in on.at ? { device: on.d.id, paths: { src: on.at.path } } : {}),
      }).catch((e: Error) => ({ state: "failed" as const, error: e.message }));
      if (started.state === "failed") {
        got.error = started.error;
        continue;
      }
      if (started.state === "queued") {
        got.line = started.line ?? "Measuring the sound";
        continue;
      }
      blocks = await readLoud(id);
    }
    if (blocks) got.blocks = Buffer.from(blocks.buffer, blocks.byteOffset, blocks.byteLength).toString("base64");
  }
  return out;
}
