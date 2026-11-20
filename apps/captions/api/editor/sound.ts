import { isOnline, isThisMachine, listDevices } from "../lib/devices";
import { libraryDb } from "../library/db";
import { wordsOf } from "../library/transcribe";
import { dropTask, startTask, TASK_EXPIRED, taskFor, taskWaitLine } from "../work/tasks";
import type { LoudnessInput } from "../work/tasks/loudness";
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
/** How long a source's measuring waits for a computer that has its file before it is given up. */
export const LOUD_WAIT_MS = 10 * 60_000;
export const NO_COMPUTER = "No computer with this file answered: open Creator Toolset on the computer that has it, then try again";
const MEASURING = "Measuring the sound";

/** Each library version in `ids` the user may see: what is known of its sound, its measuring started when it has none. */
export async function soundOf(user: string, ids: string[], now = Date.now()): Promise<Record<string, SourceSound>> {
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
    const blocks = await readLoud(id);
    if (blocks) {
      got.blocks = Buffer.from(blocks.buffer, blocks.byteOffset, blocks.byteLength).toString("base64");
      continue;
    }
    const t = taskFor(LOUDNESS_TASK, id);
    if (t?.state === "failed") {
      // said once; asking again starts over
      dropTask(LOUDNESS_TASK, id);
      got.error = t.error === TASK_EXPIRED ? NO_COMPUTER : (t.error ?? "Could not measure the sound");
      continue;
    }
    if (t?.state === "running") {
      got.line = t.line ?? MEASURING;
      continue;
    }
    if (t?.state === "queued" && now - t.created_at > LOUD_WAIT_MS) {
      dropTask(LOUDNESS_TASK, id);
      got.error = NO_COMPUTER;
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
      .flatMap((x) => (x.at && "path" in x.at ? [{ device: x.d.id, path: x.at.path }] : []))[0];
    // a queued one is placed again only when a computer with the file came since: one waiting for nobody keeps its clock
    if (t?.state === "queued" && (!on || on.device === (t.input as LoudnessInput | null)?.device)) {
      got.line = taskWaitLine(t) ?? t.line ?? MEASURING;
      continue;
    }
    const input: LoudnessInput = { version: id, sourceKey: row.source_key, ...(on ? { device: on.device, paths: { src: on.path } } : {}) };
    // not awaited: where the server measures itself (This Mac, its video work on) it decodes whole files, longer than a
    // request may take; the row is written before the first await, and the next ask reads it
    startTask(LOUDNESS_TASK, id, user, ws, input).catch(() => {});
    const now2 = taskFor(LOUDNESS_TASK, id);
    got.line = (now2 && taskWaitLine(now2)) ?? MEASURING;
  }
  return out;
}
