import { randomUUID } from "node:crypto";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { env } from "../lib/env";
import { blobs, libraryDb, libraryUpload, librarySetting } from "./db";
import { enqueueJob } from "./jobs";
import { FRAMES } from "./describe";
import { wantsProxy } from "./media/proxy";
import { looksLikeSong, type ProbeSummary } from "./media/probe";
import { organizeOnProbe } from "./organize";
import { tagSoundType } from "./sfx-type";
import { settleSoundKind } from "./sound-kind";
import { kindOf, recordVersion } from "./routes";
import { deviceOf } from "../lib/devices";
import { rootAt } from "../lib/storage";
import { confirmPlaces } from "./places";
import { readerOf } from "./reader";
import { assetRef, canSee } from "./sources";

/**
 * A file indexed where it is on the person's Mac, for a server that is not on that Mac (the Mac app's Media Library
 * drop, src/lib/onMac.ts). The video never comes here: the Mac sends what the library needs to list and search it, its
 * length and size, its card picture, its hover strip and a few stills for the AI's description. The version keeps the
 * file's path on that Mac and the Mac's device id; source_key "mac:<version id>" has no blob, so a step that needs the
 * file itself (proxy, fingerprint) is never run here (worker.ts); its transcript is cut on that Mac from the file.
 */

export interface OnMacIndex {
  name: string;
  path: string;
  size: number;
  /** size + first and last MiB, hashed on the Mac: the duplicate check without reading gigabytes */
  quick: string;
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
  return {
    name,
    path: at,
    size,
    quick: b.quick,
    ...(typeof b.device === "string" && b.device ? { device: b.device.slice(0, 100) } : {}),
    ...(num(b.duration, 864_000) ? { duration: b.duration as number } : {}),
    ...(num(b.width, 20_000) && num(b.height, 20_000) ? { width: Math.round(b.width as number), height: Math.round(b.height as number) } : {}),
    ...(typeof b.thumb === "string" ? { thumb: b.thumb } : {}),
    ...(typeof b.sprite === "string" ? { sprite: b.sprite } : {}),
    frames: frames as string[],
    ...(typeof b.collectionId === "string" && b.collectionId ? { collectionId: b.collectionId } : {}),
  };
}

/** Where the describe stills wait for the describe job (deleted once it has run). */
export const framesDir = (versionId: string) => path.join(env.dataDir, "library", "mac-frames", versionId);

/** The stills kept for `versionId`, in order; [] when there are none. */
export async function macFrames(versionId: string): Promise<string[]> {
  const dir = framesDir(versionId);
  const names = await readdir(dir).catch(() => [] as string[]);
  return names.filter((n) => n.endsWith(".jpg")).sort().map((n) => path.join(dir, n));
}
export const dropMacFrames = (versionId: string) => rm(framesDir(versionId), { recursive: true, force: true });

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
      `SELECT a.id, v.id AS version FROM asset_versions v JOIN assets a ON a.id = v.asset_id
       WHERE a.library_id = ? AND a.trashed_at IS NULL AND (v.sha256 = ? OR (v.quick = ? AND v.bytes = ?) OR (v.mac_path = ? AND v.bytes = ?)) LIMIT 1`,
    )
    .get(libraryId, `mac:${x.quick}`, x.quick, x.size, x.path, x.size) as { id: string; version: string } | undefined;
  if (dup) {
    // a clip the caller may not see is never named: no id, no place (the id alone would say it is there)
    const viewer = await readerOf(by, libraryId);
    if (!viewer || !(await canSee(viewer, assetRef(libraryId, dup.id, dup.version)))) return { duplicate: true };
    if (mine) await confirmPlaces(libraryId, viewer, mine, [{ versionId: dup.version, path: x.path, quick: x.quick }]);
    return { duplicateOf: dup.id };
  }
  const at = mine && rootAt(x.path, mine.report?.machine?.disks);
  const versionId = randomUUID();
  const kind = kindOf(x.name);
  const probe = { duration: x.duration ?? 0, width: x.width ?? 0, height: x.height ?? 0, fps: 0, rotation: 0, format: "", vcodec: kind === "audio" ? "" : "mac", pixFmt: "", acodec: "" };
  let assetId = "";
  d.exec("BEGIN IMMEDIATE");
  try {
    assetId = recordVersion(d, { libraryId, versionId, sourceKey: `mac:${versionId}`, filename: x.name, size: x.size, sha256: `mac:${x.quick}`, by, collectionId: x.collectionId });
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
  for (const [k, b64] of [["thumb", x.thumb], ["sprite", x.sprite]] as const) {
    if (!b64) continue;
    const file = path.join(scratch, `${versionId}-${k}.jpg`);
    await writeFile(file, Buffer.from(b64, "base64"));
    const { bytes } = await blobs.put(`${base}/${k}.jpg`, file);
    d.prepare("INSERT OR REPLACE INTO derivatives (version_id, kind, storage_key, bytes) VALUES (?, ?, ?, ?)").run(versionId, k, `${base}/${k}.jpg`, bytes);
  }
  d.prepare("UPDATE asset_versions SET state = 'ready' WHERE id = ?").run(versionId);
  // a sound's kind from its name, folders and length (sound-kind.ts: no listen, the file is not here); a library the AI
  // organizes files a sound or a picture now
  const sound = await settleSoundKind(d, versionId, { song: kind === "audio" && looksLikeSong(x.name, probe as ProbeSummary), seconds: probe.duration });
  if (kind === "audio") tagSoundType(d, versionId, x.name, probe.duration);
  organizeOnProbe(d, versionId, sound);
  // its transcript is made on that Mac from the file where it is (worker.ts): never uploaded for it
  // shortcut: videos only (the Mac sends no sound codec, so songs and sound effects can't be told apart); hear audio once it does
  if (kind === "video") enqueueJob(d, libraryId, versionId, "transcribe", by);
  // Upload off with Generate proxies on: the computer holding the file makes its proxy and keeps it (library-package keepProxy)
  if (kind === "video" && mine && libraryUpload(libraryId) === "none" && wantsProxy(probe as ProbeSummary, { cloud: false, on: !!librarySetting(libraryId, "proxy") }))
    enqueueJob(d, libraryId, versionId, "proxy", by);
  if (kind === "video" && x.frames.length && librarySetting(libraryId, "describe")) {
    const dir = framesDir(versionId);
    await mkdir(dir, { recursive: true });
    await Promise.all(x.frames.map((f, i) => writeFile(path.join(dir, `${i}.jpg`), Buffer.from(f, "base64"))));
    enqueueJob(d, libraryId, versionId, "describe", by);
  }
  return { assetId, versionId };
}
