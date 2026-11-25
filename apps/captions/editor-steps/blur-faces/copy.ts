import path from "node:path";
import { hostsNone } from "../../contracts/library";
import { libraryDb, libraryUploadStored } from "../../api/library/db";
import { enqueueJob } from "../../api/library/jobs";
import { indexOnMac } from "../../api/library/on-mac";

/** A blurred copy on a Mac, as its Mac read it: where it is, its size and prints (the copy's own), and what the library lists. */
export type Made = { path: string; size: number; quick: string; sha256?: string; duration?: number; width?: number; height?: number; thumb?: string };

export const HEX64 = /^[0-9a-f]{64}$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);

/** The copy's record a Mac sends (§3a step 6, or a copy made before), or what is wrong with it. */
export function checkMade(b: unknown): Made | string {
  const m = b as Partial<Made> | null;
  if (!m || typeof m !== "object") return "Send the copy's record.";
  if (typeof m.path !== "string" || !m.path.startsWith("/") || m.path.length > 4096) return "Send the copy's path on this Mac.";
  if (num(m.size) === undefined || !m.size) return "Send the copy's size.";
  if (typeof m.quick !== "string" || !m.quick || m.quick.length > 200) return "Send the copy's quick fingerprint.";
  if (m.sha256 !== undefined && (typeof m.sha256 !== "string" || !HEX64.test(m.sha256))) return "sha256 is 64 hex characters.";
  if (m.thumb !== undefined && (typeof m.thumb !== "string" || !BASE64.test(m.thumb) || m.thumb.length > 2_000_000)) return "thumb is a JPEG as base64.";
  return { path: m.path, size: m.size, quick: m.quick, ...(m.sha256 ? { sha256: m.sha256 } : {}), duration: num(m.duration), width: num(m.width), height: num(m.height), ...(m.thumb ? { thumb: m.thumb } : {}) };
}

/**
 * Records a copy on `device` (a Mac of `owner`'s) in the library: with `blurredOf` (its original's full SHA-256) it becomes
 * that clip's current, blurred version (routes.ts originalClipOf). Its Mac then sends what Upload asks for (job "send",
 * derived.ts sendLater): the copy itself under Blurred, the proxy it makes from the copy under Proxies (db.ts libraryUploadStored).
 */
export async function recordCopy(libraryId: string, owner: string, device: string, m: Made, blurredOf?: string) {
  const r = await indexOnMac(libraryId, owner, {
    name: path.basename(m.path), path: m.path, size: m.size, quick: m.quick, device, frames: [],
    ...(m.sha256 ? { sha256: m.sha256 } : {}), ...(m.duration !== undefined ? { duration: m.duration } : {}),
    ...(m.width !== undefined ? { width: m.width } : {}), ...(m.height !== undefined ? { height: m.height } : {}),
    ...(m.thumb ? { thumb: m.thumb } : {}), ...(blurredOf ? { blurredOf } : {}),
  });
  if ("versionId" in r && !hostsNone(libraryUploadStored(libraryId))) {
    const db = libraryDb();
    db.prepare("UPDATE asset_versions SET from_path = ?, from_device = ? WHERE id = ?").run(m.path, device, r.versionId);
    enqueueJob(db, libraryId, r.versionId, "send", owner);
  }
  return r;
}
