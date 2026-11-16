import { randomUUID } from "node:crypto";
import { libraryChanged } from "./access";
import { blobs, libraryDb, libraryUpload } from "./db";
import { enqueueJob } from "./jobs";
import type { ProbeSummary } from "./media/probe";
import { kindOf, recordVersion } from "./routes";
import { afterProbe, dropOriginal, markReady } from "./worker";

/**
 * What a computer made of a file it has, before anything uploaded (phase 6: "no point wasting bandwidth"). The computer
 * that has the original makes its probe, card picture, waveform, strip, proxy and fingerprint with the library's own
 * media code (api/work/library.ts) and sends them; a library that keeps only proxies gets the proxy and the small files,
 * the original never leaves that computer; one that keeps originals ("all") gets the original too. Nothing that came
 * with it is made again here (worker.ts afterProbe queues only what is missing).
 */

export type DerivedFile = "original" | "proxy" | "thumb" | "wave" | "sprite";

export interface Derived {
  probe?: ProbeSummary;
  /** the original's SHA-256, read on the computer */
  sha256?: string;
  /** the original's quick fingerprint (asset_versions.quick) */
  quick?: string;
  /** the fingerprint job's JSON */
  fingerprint?: string;
  /** files on this server's disk, moved into the library's store */
  files: Partial<Record<DerivedFile, string>>;
}

const NAMES: Record<Exclude<DerivedFile, "original">, string> = { proxy: "proxy.mp4", thumb: "thumb.jpg", wave: "wave.json", sprite: "sprite.jpg" };

/**
 * Records what came for `versionId`: each file into the store and its row, the fingerprint, the original's checksum, and
 * the probe, after which only what is still missing is queued. A version waiting for its computer (source "mac:") takes
 * the original as its source when it came, else the proxy (a library that keeps only proxies: the original stays where it
 * is on that computer, mac_path).
 */
export async function recordDerived(versionId: string, x: Derived, actor: string | null): Promise<void> {
  const db = libraryDb();
  const v = db
    .prepare(
      `SELECT v.id, a.library_id, a.kind, a.title, v.source_key, v.source_path, v.from_path, v.probe FROM asset_versions v
       JOIN assets a ON a.id = v.asset_id WHERE v.id = ?`,
    )
    .get(versionId) as { id: string; library_id: string; kind: string; title: string; source_key: string; source_path: string | null; from_path: string | null; probe: string | null } | undefined;
  if (!v) throw new Error("The version is gone");
  const base = `libraries/${v.library_id}/v/${v.id}`;
  for (const [name, file] of Object.entries(x.files) as [DerivedFile, string][]) {
    if (name === "original") {
      if (!v.source_key.startsWith("mac:")) continue; // the server has its original already
      const key = `${base}/source`;
      await blobs.put(key, file);
      db.prepare("UPDATE asset_versions SET source_key = ?, mac_path = NULL, mac_device = NULL WHERE id = ?").run(key, v.id);
      v.source_key = key;
      continue;
    }
    const key = `${base}/${NAMES[name]}`;
    const { bytes } = await blobs.put(key, file);
    db.prepare("INSERT OR REPLACE INTO derivatives (version_id, kind, storage_key, bytes) VALUES (?, ?, ?, ?)").run(v.id, name, key, bytes);
  }
  // only the proxy came: it is all this server keeps of the file (as once dropOriginal let an uploaded original go)
  if (v.source_key.startsWith("mac:") && x.files.proxy) {
    db.prepare("UPDATE asset_versions SET source_key = ? WHERE id = ?").run(`${base}/${NAMES.proxy}`, v.id);
  }
  if (x.fingerprint) db.prepare("INSERT OR REPLACE INTO derivatives (version_id, kind, inline, bytes) VALUES (?, 'fingerprint', ?, ?)").run(v.id, x.fingerprint, Buffer.byteLength(x.fingerprint));
  if (x.sha256) db.prepare("UPDATE asset_versions SET sha256 = ? WHERE id = ?").run(x.sha256, v.id);
  if (x.quick) db.prepare("UPDATE asset_versions SET quick = ? WHERE id = ?").run(x.quick, v.id);
  let p = JSON.parse(v.probe ?? "null") as ProbeSummary | null;
  if (x.probe) {
    p = { ...x.probe, ...(p?.turn ? { turn: p.turn } : {}) };
    db.prepare("UPDATE asset_versions SET probe = ? WHERE id = ?").run(JSON.stringify(p), v.id);
    await afterProbe(db, v, p, actor);
  }
  if (p) markReady(db, v.id, p);
  await dropOriginal(v.id).catch((e: unknown) => console.error("[library] dropping an original:", e));
  libraryChanged(v.library_id);
}

/**
 * A video the Mac app's page would upload from `fromPath` on computer `device`, to a library that uploads ("proxies" or
 * "all"): recorded now, waiting for that computer, which makes everything from the file where it is and sends it (job
 * "send", api/work/library-package.ts). { duplicateOf } when the library has it already (same quick fingerprint, or same
 * place and size).
 */
export function sendLater(
  libraryId: string,
  by: string,
  x: { filename: string; size: number; fromPath: string; device: string; quick: string; collectionId?: string | null },
): { assetId: string; versionId: string } | { duplicateOf: string } {
  const d = libraryDb();
  const dup = d
    .prepare(
      `SELECT a.id FROM asset_versions v JOIN assets a ON a.id = v.asset_id
       WHERE a.library_id = ? AND a.trashed_at IS NULL AND (v.sha256 = ? OR (v.quick = ? AND v.bytes = ?) OR (? IN (v.mac_path, v.from_path) AND v.bytes = ?)) LIMIT 1`,
    )
    .get(libraryId, `mac:${x.quick}`, x.quick, x.size, x.fromPath, x.size) as { id: string } | undefined;
  if (dup) return { duplicateOf: dup.id };
  const versionId = randomUUID();
  let assetId = "";
  d.exec("BEGIN IMMEDIATE");
  try {
    assetId = recordVersion(d, {
      libraryId,
      versionId,
      sourceKey: `mac:${versionId}`,
      filename: x.filename,
      size: x.size,
      sha256: `mac:${x.quick}`,
      by,
      collectionId: x.collectionId,
      fromPath: x.fromPath,
      fromDevice: x.device,
    });
    // the computer probes it: nothing here reads a file this server does not have yet
    d.prepare("DELETE FROM jobs WHERE version_id = ?").run(versionId);
    d.prepare("UPDATE asset_versions SET mac_path = ?, mac_device = ?, quick = ? WHERE id = ?").run(x.fromPath, x.device, x.quick, versionId);
    enqueueJob(d, libraryId, versionId, "send", by);
    d.exec("COMMIT");
  } catch (e) {
    d.exec("ROLLBACK");
    throw e;
  }
  libraryChanged(libraryId);
  return { assetId, versionId };
}

/** Whether a file of this name, sent to `libraryId`, goes the computer's way (sendLater) rather than as its original. */
export const sendsFromComputer = (libraryId: string, filename: string): boolean => kindOf(filename) === "video" && libraryUpload(libraryId) !== "none";
