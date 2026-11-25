import { randomUUID } from "node:crypto";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { env } from "../lib/env";
import { blobs, fileBlur, fileProxy, libraryDb, librarySetting, makesProxyOf, versionUpload, type ProxyAnswer } from "./db";
import { emitEvent } from "../lib/events";
import { enqueueJob } from "./jobs";
import { FRAMES } from "./describe";
import { wantsProxy } from "./media/proxy";
import { countryOf, looksLikeSong, type ProbeSummary } from "./media/probe";
import { readHere } from "./shoots";
import { organizeOnProbe } from "./organize";
import { tagSoundType } from "./sfx-type";
import { settleSoundKind } from "./sound-kind";
import { kindOf, mimeOf, modifiedOf, recordVersion } from "./routes";
import { deviceOf } from "../lib/devices";
import { rootAt } from "../lib/storage";
import { confirmPlaces, OWN } from "./places";
import { noteStrip, strayStrip, watchedAspect, OLD_CELL } from "./media/sprite";
import { readerOf } from "./reader";
import { assetRef, canSee } from "./sources";
import { hostsProxies, type Blur } from "../../contracts/library";
import { mayLeave } from "./upload-gate";
import { showHidden } from "./trash";

/**
 * A file indexed where it is on the person's Mac, for a server that is not on that Mac (the Mac app's Media Library
 * drop, src/lib/onMac.ts). The video never comes here: the Mac sends what the library needs to list and search it, its
 * length and size, its card picture, its hover strip and a few stills for the AI's description. The version keeps the
 * file's path on that Mac and the Mac's device id; source_key "mac:<version id>" has no blob, so a step that needs the
 * file itself (proxy, fingerprint) is never run here (worker.ts); its transcript is cut on that Mac from the file.
 */

export interface OnMacIndex {
  /** the new clip's blur answer (upload-gate.ts blurAtIntake), set by the caller, never parsed from the body; none: the library's Blur faces */
  blur?: Blur | null;
  /** the new clip's proxy answer from its add (db.ts fileProxy), set by the caller; none: the library's Generate proxies */
  proxy?: ProxyAnswer | null;
  /** a blurred render of the original with this full SHA-256, set by the server's own save (library-save task), never parsed */
  blurredOf?: string;
  name: string;
  path: string;
  size: number;
  /** size + first and last MiB, hashed on the Mac: the duplicate check without reading gigabytes */
  quick: string;
  /** the whole file's SHA-256, read on the Mac where Blur faces is on: the key its blurred render links on */
  sha256?: string;
  device?: string;
  duration?: number;
  width?: number;
  height?: number;
  /** base64 JPEGs */
  thumb?: string;
  sprite?: string;
  frames: string[];
  collectionId?: string;
  /** the Settings → Folders folder it was found in (a location agent's scan, POST /api/devices/relay/index); none: a drop */
  folder?: string;
  /** when it was filmed (ms), and the minutes east of UTC it was filmed in, when the file says (Mac app 11-19 on) */
  capturedAt?: number;
  tz?: number;
  /** the file's modified time (File.lastModified) the drop came with: Date filmed's fallback (shoots.ts FILE_DATE) */
  modified?: number;
  /** where it was filmed, as the file has it (ISO 6709): only its country is kept */
  location?: string;
  /** a picture: whether its EXIF names a camera, and whether it has an alpha channel (shoots.ts isGraphic) */
  camera?: boolean;
  alpha?: boolean;
}

const MB = 1024 * 1024;
const jpeg = (b64: unknown, max: number): Buffer | null => {
  if (typeof b64 !== "string" || b64.length > (max * 4) / 3 + 4) return null;
  const b = Buffer.from(b64, "base64");
  return b.length > 2 && b[0] === 0xff && b[1] === 0xd8 && b.length <= max ? b : null;
};
const num = (v: unknown, max: number) => (typeof v === "number" && Number.isFinite(v) && v > 0 && v <= max ? v : undefined);

/** The body checked: the index, or what is wrong with it. Pictures must be JPEGs under their caps; nothing else is taken. */
export function parseOnMac(body: unknown): OnMacIndex | string {
  const b = (body ?? {}) as Record<string, unknown>;
  const name = typeof b.name === "string" ? b.name.trim().slice(0, 255) : "";
  const at = typeof b.path === "string" ? b.path : "";
  if (!name || kindOf(name) === "doc") return "Only videos, sound and pictures are indexed";
  if (!at.startsWith("/") || at.length > 2048 || at.split("/").includes("..")) return "Not a full path";
  const size = Number(b.size);
  if (!Number.isSafeInteger(size) || size <= 0) return "Invalid size";
  if (typeof b.quick !== "string" || !/^[0-9a-f]{64}$/.test(b.quick)) return "Invalid fingerprint";
  for (const [k, max] of [["thumb", MB], ["sprite", 2 * MB]] as const) if (b[k] !== undefined && !jpeg(b[k], max)) return `The ${k} is not a JPEG under ${max / MB} MB`;
  const frames = Array.isArray(b.frames) ? b.frames.slice(0, FRAMES) : [];
  if (frames.some((f) => !jpeg(f, MB))) return "A still is not a JPEG under 1 MB";
  const modified = modifiedOf(b.modified);
  return {
    ...parseFilmed(b),
    ...(modified ? { modified } : {}),
    name,
    path: at,
    size,
    quick: b.quick,
    ...(typeof b.sha256 === "string" && /^[0-9a-f]{64}$/.test(b.sha256) ? { sha256: b.sha256 } : {}),
    ...(typeof b.device === "string" && b.device ? { device: b.device.slice(0, 100) } : {}),
    ...(num(b.duration, 864_000) ? { duration: b.duration as number } : {}),
    ...(num(b.width, 20_000) && num(b.height, 20_000) ? { width: Math.round(b.width as number), height: Math.round(b.height as number) } : {}),
    ...(typeof b.thumb === "string" ? { thumb: b.thumb } : {}),
    ...(typeof b.sprite === "string" ? { sprite: b.sprite } : {}),
    frames: frames as string[],
    ...(typeof b.collectionId === "string" && b.collectionId ? { collectionId: b.collectionId } : {}),
  };
}

/** When, where and by what a file was filmed, as a computer read it from the file (the index, POST /relay/filmed). */
export type Filmed = Pick<OnMacIndex, "capturedAt" | "tz" | "location" | "camera" | "alpha">;

export function parseFilmed(b: Record<string, unknown>): Filmed {
  return {
    ...(num(b.capturedAt, 1e14) ? { capturedAt: Math.round(b.capturedAt as number) } : {}),
    ...(Number.isInteger(b.tz) && Math.abs(b.tz as number) <= 14 * 60 ? { tz: b.tz as number } : {}),
    ...(typeof b.location === "string" && b.location.length <= 64 ? { location: b.location } : {}),
    ...(typeof b.camera === "boolean" ? { camera: b.camera } : {}),
    ...(typeof b.alpha === "boolean" ? { alpha: b.alpha } : {}),
  };
}

/**
 * What a computer read later of when, where and by what a known version was filmed, into its probe: its date always (a
 * server probe before 11-23 kept an edited or sent file's write time), the rest only where the probe lacks it, and
 * `camera` always, so it is never asked again. True when its date or place is new.
 */
export async function patchFilmed(d: ReturnType<typeof libraryDb>, versionId: string, f: Filmed): Promise<boolean> {
  const row = d.prepare("SELECT probe FROM asset_versions WHERE id = ?").get(versionId) as { probe: string | null } | undefined;
  if (!row) return false;
  const p = JSON.parse(row.probe ?? "{}") as Partial<ProbeSummary>;
  // `camera` marks it read: what the server read itself stays
  const add: Record<string, unknown> = p.camera === undefined ? { camera: f.camera ?? false } : {};
  // the file's own offset, when the server read one, beats the computer's guess from its clock
  if (f.capturedAt && f.capturedAt !== p.capturedAt) Object.assign(add, { capturedAt: f.capturedAt }, p.tz === undefined && f.tz !== undefined ? { tz: f.tz } : {});
  const country = !p.country && f.location ? await countryOf({ format: { tags: { location: f.location } } }) : "";
  if (country) add.country = country;
  if (f.alpha && !p.pixFmt) add.pixFmt = "rgba";
  d.prepare("UPDATE asset_versions SET probe = json_patch(COALESCE(probe, '{}'), ?) WHERE id = ?").run(JSON.stringify(add), versionId);
  return "capturedAt" in add || "country" in add;
}

/** Where the describe stills wait for the describe job (deleted once it has run). */
export const framesDir = (versionId: string) => path.join(env.dataDir, "library", "mac-frames", versionId);

/**
 * Blur faces: the stills of a clip not blurred yet, held in memory until its description and never kept here (P2.4). A
 * restart loses them; the clip is then described from its words. For the call they are written out (heldDir) and gone after.
 */
const heldStills = new Map<string, { at: number; stills: Buffer[]; bytes: number }>();
const HELD_DIR = path.join(tmpdir(), "ct-held-stills");
const heldDir = (versionId: string) => path.join(HELD_DIR, versionId);
/** At start: what a stopped server left there (its memory is gone with it). */
export const clearHeldStills = () => rm(HELD_DIR, { recursive: true, force: true });
/** At most this much held, and for this long: past either the oldest go first (described from its words then). */
export const HELD_STILLS_BYTES = 256 * MB;
export const HELD_STILLS_MS = 6 * 3600_000;

/** Holds `stills` for `versionId`, dropping the expired and then the oldest past HELD_STILLS_BYTES. */
export function holdStills(versionId: string, stills: Buffer[], now = Date.now()): void {
  heldStills.delete(versionId);
  heldStills.set(versionId, { at: now, stills, bytes: stills.reduce((n, b) => n + b.length, 0) });
  let total = [...heldStills.values()].reduce((n, h) => n + h.bytes, 0);
  for (const [id, h] of heldStills) {
    if (now - h.at <= HELD_STILLS_MS && total <= HELD_STILLS_BYTES) break; // the rest are newer (Map keeps the order they came in)
    heldStills.delete(id);
    total -= h.bytes;
  }
}

/** The stills kept for `versionId`, in order; [] when there are none. */
export async function macFrames(versionId: string): Promise<string[]> {
  const h = heldStills.get(versionId);
  if (h && Date.now() - h.at > HELD_STILLS_MS) heldStills.delete(versionId);
  const held = heldStills.get(versionId)?.stills;
  const dir = held ? heldDir(versionId) : framesDir(versionId);
  if (held) {
    await mkdir(dir, { recursive: true });
    await Promise.all(held.map((b, i) => writeFile(path.join(dir, `${i}.jpg`), b)));
  }
  const names = await readdir(dir).catch(() => [] as string[]);
  return names.filter((n) => n.endsWith(".jpg")).sort().map((n) => path.join(dir, n));
}
/** After a description's call, whatever it did: held stills written out for it are gone again (they stay in memory for a retry). */
export const dropHeldCopy = (versionId: string) => rm(heldDir(versionId), { recursive: true, force: true });
export const dropMacFrames = async (versionId: string) => {
  heldStills.delete(versionId);
  await Promise.all([rm(framesDir(versionId), { recursive: true, force: true }), dropHeldCopy(versionId)]);
};

/**
 * Records `x` in `libraryId` as `by`: { duplicateOf } when the library has it already ({ duplicate } with no id when `by`
 * may not see that clip) (the same fingerprint and size, an
 * upload's too, or the same path and size; the caller's computer then has it here: a place, places.ts), else the new
 * asset, ready at once with its pictures, its description queued when the library has that on.
 */
export async function indexOnMac(libraryId: string, by: string, x: OnMacIndex): Promise<{ assetId: string; versionId: string } | { duplicateOf: string } | { duplicate: true }> {
  const d = libraryDb();
  // the computer the file is on, when it is the caller's: the file's root from its disks, and its place
  const device = x.device ? deviceOf(x.device) : undefined;
  const mine = device?.owner === by ? device : undefined;
  const dup = d
    .prepare(
      `SELECT a.id, v.id AS version, a.trashed_at FROM asset_versions v JOIN assets a ON a.id = v.asset_id
       WHERE a.library_id = ? AND (v.sha256 = ? OR v.sha256 = ? OR v.full_sha256 = ? OR (v.quick = ? AND v.bytes = ?) OR (v.mac_path = ? AND v.bytes = ?))
       ORDER BY a.trashed_at IS NOT NULL LIMIT 1`,
    )
    .get(libraryId, `mac:${x.quick}`, x.sha256 ?? "-", x.sha256 ?? "-", x.quick, x.size, x.path, x.size) as { id: string; version: string; trashed_at: number | null } | undefined;
  // in the trash: it stays there (Restore brings it back), never a new clip, and its id is not shown
  if (dup?.trashed_at) return { duplicate: true };
  if (dup) {
    // a clip the caller may not see is never named: no id, no place (the id alone would say it is there)
    const viewer = await readerOf(by, libraryId);
    if (!viewer || !(await canSee(viewer, assetRef(libraryId, dup.id, dup.version)))) return { duplicate: true };
    if (mine) await confirmPlaces(libraryId, viewer, mine, [{ versionId: dup.version, path: x.path, quick: x.quick }]);
    // a file outside the folders left out (route and indexForDevice refuse those): one hidden while it waited is here after all
    showHidden(dup.id);
    return { duplicateOf: dup.id };
  }
  const at = mine && rootAt(x.path, mine.report?.machine?.disks);
  const versionId = randomUUID();
  const kind = kindOf(x.name);
  // when and where it was filmed, as the Mac read it (an older Mac sends none: read here below when the file is on this machine)
  const country = x.location ? await countryOf({ format: { tags: { location: x.location } } }) : "";
  const probe = {
    duration: x.duration ?? 0, width: x.width ?? 0, height: x.height ?? 0, fps: 0, rotation: 0, format: "", vcodec: kind === "audio" ? "" : "mac", pixFmt: x.alpha ? "rgba" : "", acodec: "",
    ...(x.capturedAt ? { capturedAt: x.capturedAt, ...(x.tz !== undefined ? { tz: x.tz } : {}) } : {}),
    ...(country ? { country } : {}),
    ...(x.camera !== undefined ? { camera: x.camera } : {}),
  };
  let assetId = "";
  // the original of a blurred render the library has (the same full SHA-256): an older version of that clip, which stays current
  const blurred = x.sha256
    ? (d.prepare("SELECT v.id, v.asset_id FROM asset_versions v JOIN assets a ON a.id = v.asset_id WHERE a.library_id = ? AND v.blurred_of = ? AND a.trashed_at IS NULL LIMIT 1").get(libraryId, x.sha256) as
        | { id: string; asset_id: string }
        | undefined)
    : undefined;
  d.exec("BEGIN IMMEDIATE");
  try {
    assetId = recordVersion(d, { libraryId, versionId, sourceKey: `mac:${versionId}`, filename: x.name, size: x.size, sha256: `mac:${x.quick}`, by, collectionId: x.collectionId, blur: x.blur ?? null, proxy: x.proxy ?? null, blurredOf: x.blurredOf ?? null, modifiedAt: x.modified ?? null, ...(blurred ? { assetId: blurred.asset_id } : {}) });
    if (blurred) d.prepare("UPDATE assets SET current_version_id = ? WHERE id = ?").run(blurred.id, assetId);
    if (x.sha256) d.prepare("UPDATE asset_versions SET full_sha256 = ? WHERE id = ?").run(x.sha256, versionId);
    // the Mac probed it: no probe here (it would read a file this server does not have)
    d.prepare("DELETE FROM jobs WHERE version_id = ?").run(versionId);
    d.prepare("UPDATE asset_versions SET mac_path = ?, mac_device = ?, probe = ?, quick = ?, root = ?, root_rel = ? WHERE id = ?")
      .run(x.path, x.device ?? null, JSON.stringify(probe), x.quick, at?.key ?? null, at?.rel ?? null, versionId);
    if (mine) {
      // the Mac read this very file for its fingerprint: verified there (contracts/places.ts PlaceState)
      const now = Date.now();
      d.prepare("INSERT INTO version_places (version_id, device, folder_id, path, bytes, quick, confirmed_at, checked_at, verified_at, state, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'verified', ?)")
        .run(versionId, mine.id, x.folder ?? "", x.path, x.size, x.quick, now, now, now, x.folder ? "scan" : "drop");
    }
    d.exec("COMMIT");
  } catch (e) {
    d.exec("ROLLBACK");
    throw e;
  }
  const base = `libraries/${libraryId}/v/${versionId}`;
  const scratch = path.join(env.dataDir, "library", "staging");
  await mkdir(scratch, { recursive: true });
  // Blur faces: a clip not blurred keeps its card picture and strip (owner, 2026-11-24); its proxy and stills wait for the blur
  const pictures = mayLeave(libraryId, { versionId }).ok;
  for (const [k, b64] of [["thumb", x.thumb], ["sprite", x.sprite]] as const) {
    if (!b64) continue;
    const file = path.join(scratch, `${versionId}-${k}.jpg`);
    await writeFile(file, Buffer.from(b64, "base64"));
    const { bytes } = await blobs.put(`${base}/${k}.jpg`, file);
    d.prepare("INSERT OR REPLACE INTO derivatives (version_id, kind, storage_key, bytes) VALUES (?, ?, ?, ?)").run(versionId, k, `${base}/${k}.jpg`, bytes);
    if (k === "sprite") noteStrip(d, versionId, Buffer.from(b64, "base64"));
  }
  d.prepare("UPDATE asset_versions SET state = 'ready' WHERE id = ?").run(versionId);
  // a sound's kind from its name, folders and length (sound-kind.ts: no listen, the file is not here); a library the AI
  // organizes files a sound or a picture now
  const sound = await settleSoundKind(d, versionId, { song: kind === "audio" && looksLikeSong(x.name, probe as ProbeSummary), seconds: probe.duration });
  if (kind === "audio") tagSoundType(d, versionId, x.name, probe.duration);
  // the Mac said nothing of when it was filmed and the file is on this very machine (the Mac app's own server): read here
  if (!x.capturedAt && x.camera === undefined && kind !== "audio") await readHere(d, versionId, x.path, kind);
  organizeOnProbe(d, versionId, sound);
  // marked Blur faces with no blurred render yet: Face Blur covers it on this Mac (editor-steps/blur-faces queueVersion)
  if (!pictures && !x.blurredOf && fileBlur(versionId)?.blur === "yes") emitEvent("library.version.blur", { libraryId, versionId, owner: by });
  // its transcript is made on that Mac from the file where it is (worker.ts): never uploaded for it
  // shortcut: videos only (the Mac sends no sound codec, so songs and sound effects can't be told apart); hear audio once it does
  // Analysis effort: Off makes no transcript on import (UNIFIED-PRD §4.4)
  if (kind === "video" && librarySetting(libraryId, "transcribe")) enqueueJob(d, libraryId, versionId, "transcribe", by);
  // Generate proxies on and the server keeping no proxy of this file (Upload off, Originals alone, Blurred alone): the
  // computer holding the file makes its proxy and keeps it (library-package keepProxy). Where Upload sends proxies its
  // send makes it. Never of a file waiting for its blur (`pictures`); a blurred copy gets its own, as any file: the
  // proxy is made from it (docs/media-library-proxies-prd.md §1)
  if (kind === "video" && mine && pictures && !hostsProxies(versionUpload(versionId)) && fileProxy(versionId) !== "no" && wantsProxy(probe as ProbeSummary, { cloud: false, on: fileProxy(versionId) === "yes" || makesProxyOf(libraryId, versionId) }))
    enqueueJob(d, libraryId, versionId, "proxy", by);
  if (kind === "video" && x.frames.length && librarySetting(libraryId, "describe")) {
    if (!pictures) {
      holdStills(versionId, x.frames.map((f) => Buffer.from(f, "base64")));
      enqueueJob(d, libraryId, versionId, "describe", by);
      return { assetId, versionId };
    }
    const dir = framesDir(versionId);
    await mkdir(dir, { recursive: true });
    await Promise.all(x.frames.map((f, i) => writeFile(path.join(dir, `${i}.jpg`), Buffer.from(f, "base64"))));
    enqueueJob(d, libraryId, versionId, "describe", by);
  }
  return { assetId, versionId };
}

/**
 * The pictures (photos) of `libraryId` with no thumbnail whose file computer `device` has: its path there, from where the
 * Mac indexed it or a place it reported (11-19: photos indexed in place came in grey when the page couldn't decode them).
 * The Mac app makes each one's thumbnail and hands it in (putThumb), with no re-import.
 */
export function noPicture(libraryId: string, device: string, limit = 500, after?: string): { versionId: string; path: string }[] {
  return libraryDb()
    .prepare(
      `SELECT versionId, path FROM (SELECT v.id AS versionId, a.created_at AS at, COALESCE(CASE WHEN v.mac_device = ? THEN v.mac_path END, ${OWN}) AS path
         FROM assets a JOIN asset_versions v ON v.id = a.current_version_id
        WHERE a.library_id = ? AND a.kind = 'image' AND a.trashed_at IS NULL AND a.left_hidden_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM derivatives d WHERE d.version_id = v.id AND d.kind = 'thumb') ${after ? AFTER : ""})
        WHERE path IS NOT NULL ORDER BY at DESC, versionId DESC LIMIT ?`,
    )
    .all(device, device, libraryId, ...(after ? [after] : []), limit) as { versionId: string; path: string }[];
}

/**
 * A sweep's next page: the versions after version `?` in its order (newest first), so a file that can't be read here (its
 * disk not connected) is passed over, never listed again at the top of each page until a page of them stops the sweep.
 */
const AFTER = `AND (a.created_at, v.id) < (SELECT ca.created_at, cv.id FROM asset_versions cv JOIN assets ca ON ca.id = cv.asset_id WHERE cv.id = ?)`;

/** A picture's thumbnail handed in for a version of `libraryId` (a JPEG under 1 MB): false when it isn't one or the version isn't the library's. */
export async function putThumb(libraryId: string, versionId: string, b64: unknown): Promise<boolean> {
  if (!jpeg(b64, MB)) return false;
  const d = libraryDb();
  const own = d.prepare("SELECT v.mime, v.mac_path, v.source_path FROM asset_versions v JOIN assets a ON a.id = v.asset_id WHERE v.id = ? AND a.library_id = ?").get(versionId, libraryId) as
    | { mime: string | null; mac_path: string | null; source_path: string | null }
    | undefined;
  if (!own) return false;
  // a photo indexed before its type was known (HEIC, RAW) was stored as application/octet-stream: the repair sets its type
  const named = own.mac_path ?? own.source_path;
  const mime = named ? mimeOf(path.basename(named)) : null;
  if (mime && mime !== "application/octet-stream" && mime !== own.mime) d.prepare("UPDATE asset_versions SET mime = ? WHERE id = ?").run(mime, versionId);
  await keepJpeg(libraryId, versionId, "thumb", b64 as string);
  return true;
}

/** A JPEG made on a computer kept as a version's `kind` derivative (a replace: the one before is served until this lands). */
async function keepJpeg(libraryId: string, versionId: string, kind: "thumb" | "sprite", b64: string): Promise<void> {
  const base = `libraries/${libraryId}/v/${versionId}`;
  const scratch = path.join(env.dataDir, "library", "staging");
  await mkdir(scratch, { recursive: true });
  const file = path.join(scratch, `${versionId}-${kind}.jpg`);
  await writeFile(file, Buffer.from(b64, "base64"));
  const { bytes } = await blobs.put(`${base}/${kind}.jpg`, file);
  const d = libraryDb();
  d.prepare("INSERT OR REPLACE INTO derivatives (version_id, kind, storage_key, bytes) VALUES (?, ?, ?, ?)").run(versionId, kind, `${base}/${kind}.jpg`, bytes);
  if (kind === "sprite") noteStrip(d, versionId, Buffer.from(b64, "base64"));
}

/**
 * This library's videos with an old strip (16:9 cuts, no frame size noted) that isn't their shape, whose file `device`
 * has: the computer makes each strip again from the file (repairStrips) and PUTs it. An old strip that is the clip's
 * shape is noted as it is, so it is never looked at again. A video with no strip or no card picture at all (a blurred copy
 * that became the clip's version on a Mac) is listed too, `thumb` when its card picture is missing.
 * shortcut: looks at the newest 500 a pass; a library with more settles them over later passes
 */
export function strayStrips(libraryId: string, device: string, limit = 50, after?: string): { versionId: string; path: string; thumb?: true }[] {
  const d = libraryDb();
  const rows = d
    .prepare(
      `SELECT * FROM (SELECT v.id AS versionId, a.created_at AS at, v.probe, COALESCE(CASE WHEN v.mac_device = ? THEN v.mac_path END, ${OWN}) AS path,
              s.version_id IS NOT NULL AS strip, s.cell_w IS NOT NULL AS sized,
              EXISTS (SELECT 1 FROM derivatives t WHERE t.version_id = v.id AND t.kind = 'thumb') AS pictured
         FROM assets a JOIN asset_versions v ON v.id = a.current_version_id
         LEFT JOIN derivatives s ON s.version_id = v.id AND s.kind = 'sprite'
        WHERE a.library_id = ? AND a.kind = 'video' AND a.trashed_at IS NULL AND a.left_hidden_at IS NULL
          AND (s.version_id IS NULL OR s.cell_w IS NULL OR NOT EXISTS (SELECT 1 FROM derivatives t WHERE t.version_id = v.id AND t.kind = 'thumb')) ${after ? AFTER : ""})
        WHERE path IS NOT NULL ORDER BY at DESC, versionId DESC LIMIT 500`,
    )
    .all(device, device, libraryId, ...(after ? [after] : [])) as { versionId: string; probe: string | null; path: string; strip: number; sized: number; pictured: number }[];
  const out: { versionId: string; path: string; thumb?: true }[] = [];
  for (const r of rows) {
    const oldStrip = r.strip && !r.sized;
    // an old strip that is the clip's shape is kept as it is; the clip is listed only when its card picture is missing
    if (oldStrip && !strayStrip(watchedAspect(r.probe))) {
      d.prepare("UPDATE derivatives SET cell_w = ?, cell_h = ? WHERE version_id = ? AND kind = 'sprite'").run(OLD_CELL.w, OLD_CELL.h, r.versionId);
      if (r.pictured) continue;
    }
    if (out.length < limit) out.push({ versionId: r.versionId, path: r.path, ...(r.pictured ? {} : { thumb: true as const }) });
  }
  return out;
}

/** A video's strip made on the computer that has it (a JPEG under 2 MB), for a version of `libraryId`: false when it isn't one. */
export async function putSprite(libraryId: string, versionId: string, b64: unknown): Promise<boolean> {
  if (!jpeg(b64, 2 * MB)) return false;
  const own = libraryDb().prepare("SELECT 1 FROM asset_versions v JOIN assets a ON a.id = v.asset_id WHERE v.id = ? AND a.library_id = ? AND a.kind = 'video'").get(versionId, libraryId);
  if (!own) return false;
  await keepJpeg(libraryId, versionId, "sprite", b64 as string);
  return true;
}
