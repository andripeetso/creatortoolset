/**
 * A file to blur that came from a phone or a browser (docs/media-library-proxies-prd.md R13). The server takes it and
 * holds it: its version is recorded as on a computer (source "mac:<id>", so nothing here plays, serves or cuts it) and the
 * bytes wait in library/held/<version id>, outside the library's store. The main computer (one of the library's own
 * account with a Source media folder for it: the import rule) copies the file into Imports and indexes it in place; that
 * copy is the master, and only then is the file processed, as any file there. Blurred: the held file is deleted. No
 * faces, or kept as filmed: it becomes the clip's uploaded original where Upload's Originals part (the Blurred row) is
 * on, and is deleted where it is off. Nothing here goes for its age: with the main computer away the file waits.
 */
import { existsSync } from "node:fs";
import { mkdir, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { hostsOriginals, type Intake } from "../../contracts/library";
import { finalsDirName } from "../../contracts/storage";
import { deviceOf } from "../lib/devices";
import { env } from "../lib/env";
import { emitEvent } from "../lib/events";
import { pluginDeviceJobs } from "../lib/plugin";
import { rootAt } from "../lib/storage";
import { accountOf, libraryChanged } from "./access";
import { blobs, fileBlur, libraryDb, libraryUploadStored } from "./db";
import { enqueueJob } from "./jobs";

const dir = () => path.join(env.dataDir, "library", "held");
/** Where the server holds version `versionId`'s file. */
export const heldFile = (versionId: string): string => path.join(dir(), versionId);
/** The library save that copies it to the main computer (work/tasks/library-save.ts), by its ref. */
const SAVE = "library-save";
const refOf = (versionId: string) => `held:${versionId}`;
const db = () => libraryDb();

/** A finished upload's bytes become version `versionId`'s held file (the same disk: a rename). */
export async function holdFile(versionId: string, staged: string): Promise<void> {
  await mkdir(dir(), { recursive: true });
  await rename(staged, heldFile(versionId));
}

/**
 * Asks the main computer for held version `versionId`: a library save for the computers of the library's own account
 * that have its Source media folder, whoever sent the file (a member's goes to the owner's, never the member's). With
 * none online it waits, for as long as it takes.
 * shortcut: the folders are read when it is asked for, so a folder added later is seen at the next start or Retry
 */
export async function pullHeld(versionId: string): Promise<void> {
  const v = db()
    .prepare(
      `SELECT a.library_id AS lib, l.workspace_id AS home FROM asset_versions v JOIN assets a ON a.id = v.asset_id JOIN libraries l ON l.id = a.library_id
       WHERE v.id = ? AND v.held = 1 AND v.mac_path IS NULL`,
    )
    .get(versionId) as { lib: string; home: string } | undefined;
  const owner = v && accountOf(v.home);
  if (!v || !owner) return;
  const { downloadName, foldersFor } = await import("./routes");
  const folders = await foldersFor(owner, v.lib, "media");
  if (!Object.keys(folders).length) return;
  const { startTask } = await import("../work/tasks");
  const { libraryWorkspace } = await import("../work/server-work");
  await startTask(SAVE, refOf(versionId), owner, libraryWorkspace(v.lib), { lib: v.lib, filename: finalsDirName(downloadName(versionId)), staged: heldFile(versionId), folders, footage: true, sources: [], held: versionId });
}

/**
 * The main computer has the held file (its library save came back): `x` is where it is there, as that computer read it.
 * That copy is the master from here on: the version takes its place, and only now is the file processed, as any file
 * indexed there (Face Blur is asked; one with nothing to blur is settled at once). A hold that ended meanwhile takes nothing.
 */
export async function heldLanded(
  versionId: string,
  device: string,
  folder: string,
  x: { path: string; size: number; quick: string; duration?: number; width?: number; height?: number; thumb?: string },
): Promise<void> {
  const d = db();
  const v = d
    .prepare("SELECT v.bytes, v.quick, a.library_id AS lib, a.kind, a.created_by AS by FROM asset_versions v JOIN assets a ON a.id = v.asset_id WHERE v.id = ? AND v.held = 1")
    .get(versionId) as { bytes: number; quick: string | null; lib: string; kind: string; by: string } | undefined;
  if (!v) return;
  if (x.size !== v.bytes || (v.quick && x.quick !== v.quick)) throw new Error("Not the file this save was given");
  const at = rootAt(x.path, deviceOf(device)?.report?.machine?.disks);
  // as that computer read it (on-mac.ts): no probe here, the file is not this server's to read
  const probe = { duration: x.duration ?? 0, width: x.width ?? 0, height: x.height ?? 0, fps: 0, rotation: 0, format: "", vcodec: v.kind === "audio" ? "" : "mac", pixFmt: "", acodec: "" };
  const now = Date.now();
  d.prepare("UPDATE asset_versions SET mac_path = ?, mac_device = ?, quick = ?, root = ?, root_rel = ?, probe = COALESCE(probe, ?) WHERE id = ? AND held = 1")
    .run(x.path, device, x.quick, at?.key ?? null, at?.rel ?? null, JSON.stringify(probe), versionId);
  d.prepare(
    `INSERT OR REPLACE INTO version_places (version_id, device, folder_id, path, bytes, quick, confirmed_at, checked_at, verified_at, state, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'verified', 'scan')`,
  ).run(versionId, device, folder, x.path, x.size, x.quick, now, now, now);
  if (x.thumb) await (await import("./on-mac")).putThumb(v.lib, versionId, x.thumb);
  const f = fileBlur(versionId);
  if (f?.blur === "yes" && !f.blurredVersionId) emitEvent("library.version.blur", { libraryId: v.lib, versionId, owner: v.by });
  else await settleHeld(versionId);
  libraryChanged(v.lib);
}

/**
 * Ends the hold of `versionId`, once its master is on the main computer and the clip is blurred or decided. Blurred: the
 * held file is deleted. No faces, or kept as filmed: it is the clip's uploaded original where Upload's Originals part is
 * on, and deleted where it is off. Still to blur, or not on the main computer yet: it waits (null). The write names the
 * hold it expects, so a late or a second answer never touches a clip settled meanwhile.
 */
export async function settleHeld(versionId: string): Promise<"deleted" | "kept" | null> {
  const d = db();
  const v = d
    .prepare("SELECT a.library_id AS lib, a.created_by AS by FROM asset_versions v JOIN assets a ON a.id = v.asset_id WHERE v.id = ? AND v.held = 1 AND v.mac_path IS NOT NULL")
    .get(versionId) as { lib: string; by: string } | undefined;
  const f = v && fileBlur(versionId);
  if (!v || !f || (f.blur === "yes" && !f.blurredVersionId)) return null;
  const keep = f.blur === "no" && hostsOriginals(libraryUploadStored(v.lib)) && existsSync(heldFile(versionId));
  // nothing is awaited between the read above and this write: the hold is ended by the one answer that finds it
  if (!d.prepare("UPDATE asset_versions SET held = NULL WHERE id = ? AND held = 1 AND mac_path IS NOT NULL").run(versionId).changes) return null;
  if (keep) {
    const key = `libraries/${v.lib}/v/${versionId}/source`;
    await blobs.put(key, heldFile(versionId)); // the same disk: a rename, the file moves into the library
    // from here an original a computer sent (derived.ts): the server's copy is its source, the master its place there
    d.prepare("UPDATE asset_versions SET source_key = ?, from_path = mac_path, from_device = mac_device, mac_path = NULL, mac_device = NULL WHERE id = ?").run(key, versionId);
    enqueueJob(d, v.lib, versionId, "probe", v.by);
  } else await rm(heldFile(versionId), { force: true });
  libraryChanged(v.lib);
  return keep ? "kept" : "deleted";
}

const heldWhere = (where: string, id: string) =>
  (db().prepare(`SELECT v.id FROM asset_versions v JOIN assets a ON a.id = v.asset_id WHERE v.held = 1 AND ${where} = ?`).all(id) as { id: string }[]).map((r) => r.id);
/** Every hold of a clip that can end now: a blurred copy joined it, or it was kept as filmed. */
export async function settleHeldOf(assetId: string): Promise<void> {
  for (const id of heldWhere("a.id", assetId)) await settleHeld(id);
}
/** Every hold of a library that can end now: its Blur faces went off. */
export async function settleHeldIn(libraryId: string): Promise<void> {
  for (const id of heldWhere("a.library_id", libraryId)) await settleHeld(id);
}

/** A held file whose copy to the main computer failed is asked for again (the clip's Retry). */
export async function retryHeld(assetId: string): Promise<void> {
  for (const id of heldWhere("a.id", assetId)) await pullHeld(id);
}

/** Versions deleted for good (their clip's trash emptied): each one's held file and its pull go with it. */
export async function dropHeld(versions: string[]): Promise<void> {
  const held = versions.filter((v) => existsSync(heldFile(v)));
  if (!held.length) return;
  const { dropTask } = await import("../work/tasks");
  for (const v of held) {
    dropTask(SAVE, refOf(v));
    await rm(heldFile(v), { force: true });
  }
}

/**
 * At start: a held file whose version is gone is deleted (its clip was removed while the server was off), every hold that
 * can end ends (a stop between an answer and its file), and each file not on the main computer yet is asked for again.
 */
export async function resumeHeld(): Promise<void> {
  const held = new Map((db().prepare("SELECT id, mac_path FROM asset_versions WHERE held = 1").all() as { id: string; mac_path: string | null }[]).map((r) => [r.id, r.mac_path]));
  for (const name of await readdir(dir()).catch(() => [] as string[])) if (!held.has(name)) await rm(path.join(dir(), name), { force: true });
  for (const [id, placed] of held) await (placed ? settleHeld(id) : pullHeld(id));
}

/**
 * How far each file to blur of `libraryId` is (contracts Intake): with `assets`, those clips, the done ones too; without,
 * the clips the server holds a file of now. Read from what is there each time; nothing is stored for it.
 */
export async function intakeOf(libraryId: string, assets?: string[]): Promise<Intake[]> {
  const HELD = "SELECT h.id FROM asset_versions h WHERE h.asset_id = a.id AND h.held = 1 ORDER BY h.n DESC LIMIT 1";
  const rows = db()
    .prepare(
      `SELECT a.id AS assetId, v.id AS versionId, v.held, v.mac_path AS placed, a.current_version_id AS current, a.blur_note AS note
       FROM assets a JOIN asset_versions v ON v.id = COALESCE((${HELD}), a.current_version_id)
       WHERE a.library_id = ? AND a.trashed_at IS NULL AND ${assets ? `a.id IN (${assets.map(() => "?").join(", ") || "NULL"})` : `EXISTS (${HELD})`}
       ORDER BY a.created_at, a.id`,
    )
    .all(libraryId, ...(assets ?? [])) as { assetId: string; versionId: string; held: number | null; placed: string | null; current: string; note: string | null }[];
  // Face Blur's own queue (lib/plugin.ts preparing): what it says of each version
  const blurs = new Map(pluginDeviceJobs().flatMap((j) => j.preparing?.(libraryId) ?? []).map((p) => [p.versionId, p]));
  const { taskFor } = await import("../work/tasks");
  return rows.map((r): Intake => {
    const of = { assetId: r.assetId, versionId: r.versionId };
    if (r.held && !r.placed) {
      const t = taskFor(SAVE, refOf(r.versionId));
      if (t?.state === "failed") return { ...of, step: "failed", failed: "copy", error: t.error ?? "" };
      return { ...of, step: "held", ...(t?.state === "running" ? {} : { waiting: true as const }) };
    }
    const f = fileBlur(r.versionId);
    if (f?.blur === "yes" && !f.blurredVersionId) {
      const b = blurs.get(r.versionId);
      if (b?.failed) return { ...of, step: "failed", failed: "blur", error: b.error ?? "" };
      if (b?.running) return { ...of, step: "blurring" };
      return { ...of, step: "computer", ...(b && !b.waiting ? {} : { waiting: true as const }) };
    }
    return { assetId: r.assetId, versionId: r.current, step: "done", result: f?.blur === "yes" ? "blurred" : r.note === "none" ? "noFaces" : "asFilmed" };
  });
}
