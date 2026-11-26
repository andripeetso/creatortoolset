import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { libraryChanged } from "./access";
import { blobs, fileBlur, fileProxy, keepsOnlyOriginals, libraryDb, makesProxyOf, versionUpload, type ProxyAnswer } from "./db";
import { hostsNone, hostsOriginals, hostsProxies, type Blur } from "../../contracts/library";
import { wantsProxy } from "./media/proxy";
import { uploadFor } from "./upload-gate";
import { enqueueJob } from "./jobs";
import { countryOf, type ProbeSummary } from "./media/probe";
import { noteStrip } from "./media/sprite";
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
  if (!v) throw new Error("Version not found");
  const base = `libraries/${v.library_id}/v/${v.id}`;
  // an Originals only library keeps no proxy, whatever a computer sent (UNIFIED-PRD §4.2)
  const noProxy = keepsOnlyOriginals(v.library_id);
  for (const [name, file] of Object.entries(x.files) as [DerivedFile, string][]) {
    if (name === "proxy" && noProxy) continue;
    if (name === "original") {
      if (!v.source_key.startsWith("mac:")) continue; // the server has its original already
      const key = `${base}/source`;
      await blobs.put(key, file);
      db.prepare("UPDATE asset_versions SET source_key = ?, mac_path = NULL, mac_device = NULL WHERE id = ?").run(key, v.id);
      v.source_key = key;
      continue;
    }
    const key = `${base}/${NAMES[name]}`;
    const strip = name === "sprite" ? await readFile(file) : null; // read before the put, which may move the file
    const { bytes } = await blobs.put(key, file);
    db.prepare("INSERT OR REPLACE INTO derivatives (version_id, kind, storage_key, bytes) VALUES (?, ?, ?, ?)").run(v.id, name, key, bytes);
    if (strip) noteStrip(db, v.id, strip);
  }
  // only the proxy came: it is all this server keeps of the file (as once dropOriginal let an uploaded original go)
  if (v.source_key.startsWith("mac:") && x.files.proxy && !noProxy) {
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
 * A file on a computer whose blur answer became no after it came in (Face Blur found no face in it, or a person kept it as
 * filmed): from here it follows Upload and Generate proxies as a file added now does (docs/media-library-proxies-prd.md
 * D3). Its computer sends what Upload asks for (job "send", which makes the proxy Upload sends too); where the server
 * keeps no proxy of it and one is wanted, that computer makes it and keeps it (on-mac.ts). When it came in it waited for
 * its blur, so neither was asked for then. A file that has either job already keeps it: nothing is asked for twice.
 */
export function followUpload(versionId: string): void {
  const d = libraryDb();
  const v = d
    .prepare(
      `SELECT a.library_id AS lib, a.kind, v.probe, v.created_by AS by FROM asset_versions v JOIN assets a ON a.id = v.asset_id
       WHERE v.id = ? AND v.source_key LIKE 'mac:%' AND v.mac_path IS NOT NULL AND v.blurred_of IS NULL AND a.trashed_at IS NULL`,
    )
    .get(versionId) as { lib: string; kind: string; probe: string | null; by: string | null } | undefined;
  if (!v || fileBlur(versionId)?.blur !== "no") return;
  const has = (kind: string) => !!d.prepare("SELECT 1 FROM jobs WHERE version_id = ? AND kind = ?").get(versionId, kind);
  const upload = versionUpload(versionId);
  if (!hostsNone(upload) && !has("send")) {
    d.prepare("UPDATE asset_versions SET from_path = mac_path, from_device = mac_device WHERE id = ?").run(versionId);
    enqueueJob(d, v.lib, versionId, "send", v.by);
  }
  const asked = fileProxy(versionId);
  const on = asked === "yes" || makesProxyOf(v.lib, versionId);
  if (v.kind === "video" && v.probe && !hostsProxies(upload) && asked !== "no" && !has("proxy") && wantsProxy(JSON.parse(v.probe) as ProbeSummary, { cloud: false, on }))
    enqueueJob(d, v.lib, versionId, "proxy", v.by);
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
  x: { filename: string; size: number; fromPath: string; device: string; quick: string; collectionId?: string | null; blur?: Blur | null; proxy?: ProxyAnswer | null },
): { assetId: string; versionId: string } | { duplicateOf: string } {
  const d = libraryDb();
  const dup = d
    .prepare(
      `SELECT a.id FROM asset_versions v JOIN assets a ON a.id = v.asset_id
       WHERE a.library_id = ? AND a.trashed_at IS NULL AND a.left_hidden_at IS NULL AND (v.sha256 = ? OR (v.quick = ? AND v.bytes = ?) OR (? IN (v.mac_path, v.from_path) AND v.bytes = ?)) LIMIT 1`,
    )
    // a clip hidden while it waits on Folders left out (report.ts) is no duplicate: the file is really added
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
      blur: x.blur ?? null,
      proxy: x.proxy ?? null,
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

/** Whether a file of this name, sent to `libraryId` (into `collectionId`), goes the computer's way (sendLater) rather than as its original. */
export const sendsFromComputer = (libraryId: string, filename: string, collectionId?: string | null): boolean => {
  const upload = uploadFor({ id: libraryId, collectionId });
  return kindOf(filename) === "video" && (hostsOriginals(upload) || hostsProxies(upload));
};

/**
 * What a phone made of a video itself and sends with the upload start (phase 6, 6D; the iPhone's PhoneMade.swift), so this
 * server reads none of it again: the original's quick fingerprint, its card picture, and, to a library that keeps only
 * proxies, `proxy`: the bytes that follow are a 720p copy, and the original (this size, this probe) stayed on the phone.
 * The server says it takes these in GET /api/library (`uploadTakes`), so an older server never gets a copy as an original.
 */
export interface Made {
  quick: string;
  /** the card picture, JPEG, base64 */
  thumb?: string;
  /** sha256: the copy's own SHA-256, declared before its bytes (upload-gate.ts proxy proof); older phones send none */
  proxy?: { size: number; probe: ProbeSummary; sha256?: string };
}

/** Which version of `Made` an upload start takes (GET /api/library `uploadTakes`). */
export const UPLOAD_TAKES = 1;

const MAX_THUMB_B64 = 700_000; // ~512 KB of JPEG; a 480-wide card picture is ~40 KB

/** The probe a phone read (AVFoundation), as the server's own ProbeSummary; null when any field is off. The country from its location, never the coordinates. */
async function probeFrom(x: unknown): Promise<ProbeSummary | null> {
  const p = (x ?? {}) as Record<string, unknown>;
  const num = (k: string, max: number) => (typeof p[k] === "number" && Number.isFinite(p[k]) && (p[k] as number) >= 0 && (p[k] as number) <= max ? (p[k] as number) : null);
  const str = (k: string) => (typeof p[k] === "string" && (p[k] as string).length <= 64 ? (p[k] as string) : null);
  const [duration, width, height, fps, rotation] = [num("duration", 1e6), num("width", 16384), num("height", 16384), num("fps", 1000), num("rotation", 270)];
  const [format, vcodec, pixFmt, acodec] = [str("format"), str("vcodec"), str("pixFmt"), str("acodec")];
  if (duration === null || width === null || height === null || fps === null || rotation === null || rotation % 90) return null;
  if (format === null || vcodec === null || pixFmt === null || acodec === null) return null;
  const capturedAt = num("capturedAt", 1e14);
  const country = typeof p.location === "string" && p.location.length <= 64 ? await countryOf({ format: { tags: { location: p.location } } }) : "";
  return { duration, width, height, fps, rotation, format, vcodec, pixFmt, acodec, ...(capturedAt ? { capturedAt } : {}), country };
}

/** `Made` from an upload start's body; null when it sends none, a string when what it sends is malformed (400). */
export async function parseMade(body: Record<string, unknown> | null): Promise<Made | null | string> {
  if (body?.quick === undefined) return null;
  if (typeof body.quick !== "string" || !/^[0-9a-f]{64}$/.test(body.quick)) return "quick: the SHA-256 in hex";
  const made: Made = { quick: body.quick };
  if (body.thumb !== undefined) {
    if (typeof body.thumb !== "string" || body.thumb.length > MAX_THUMB_B64) return "thumb: a JPEG in base64, under 512 KB";
    const head = Buffer.from(body.thumb.slice(0, 8), "base64");
    if (head[0] !== 0xff || head[1] !== 0xd8) return "thumb: a JPEG in base64, under 512 KB";
    made.thumb = body.thumb;
  }
  if (body.proxy !== undefined) {
    const x = body.proxy as { size?: unknown; probe?: unknown; sha256?: unknown } | null;
    const probe = await probeFrom(x?.probe);
    if (!Number.isSafeInteger(x?.size) || (x?.size as number) <= 0 || !probe?.vcodec) return "proxy: the original's size and probe";
    if (x!.sha256 !== undefined && (typeof x!.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(x!.sha256))) return "proxy.sha256: the copy's SHA-256 in hex";
    made.proxy = { size: x!.size as number, probe, ...(typeof x!.sha256 === "string" ? { sha256: x!.sha256 } : {}) };
  }
  return made;
}

/**
 * Files what the phone made for `versionId`, just recorded from its upload (`sent` bytes; the probe job was held back
 * in the same transaction). A 720p copy is the version's source and its proxy at once (as after dropOriginal), recorded
 * with the original's probe, so it is never probed or made again here; an original is probed here as always (a header
 * read, exact), after the card picture is filed, so its thumbnail job is never queued. `thumbFile`: the picture on disk.
 */
export async function recordMade(versionId: string, made: Made, sent: number, thumbFile: string | null, actor: string): Promise<void> {
  const db = libraryDb();
  if (made.proxy) {
    db.prepare("INSERT OR REPLACE INTO derivatives (version_id, kind, storage_key, bytes) SELECT id, 'proxy', source_key, ? FROM asset_versions WHERE id = ?").run(sent, versionId);
  }
  await recordDerived(versionId, { quick: made.quick, probe: made.proxy?.probe, files: thumbFile ? { thumb: thumbFile } : {} }, actor);
  if (!made.proxy) {
    // not a file held for its blur (held.ts): that one is read on the main computer, never here
    const v = db.prepare("SELECT a.library_id FROM asset_versions v JOIN assets a ON a.id = v.asset_id WHERE v.id = ? AND v.held IS NULL").get(versionId) as { library_id: string } | undefined;
    if (v) enqueueJob(db, v.library_id, versionId, "probe", actor);
  }
}
