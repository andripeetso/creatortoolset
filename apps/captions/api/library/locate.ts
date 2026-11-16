import { stat } from "node:fs/promises";
import path from "node:path";
import { Hono } from "hono";
import type { AuthVars } from "../auth";
import { quickPrint } from "../work/files";
import { libraryChanged, mayAdd } from "./access";
import { blobs, libraryDb } from "./db";

/**
 * Each version's quick fingerprint (asset_versions.quick: size + first and last MiB, work/files.ts quickPrint), and
 * Locate…: an original that moved is found again by it. The person picks the folder it is in now on their Mac
 * (src/pages/library/Locate.tsx, apps/mac Locate.swift); the Mac says which of their files are gone from where the
 * library has them and fingerprints the folder's files of the same sizes; every one of those files that matches a gone
 * version of theirs in this library reconnects in one go. Only the caller's own versions (created_by) are ever read or
 * changed here.
 */

export const locateApp = new Hono<{ Variables: AuthVars }>();

/** A file in the picked folder, as the Mac read it. */
export interface Found {
  path: string;
  size: number;
  quick: string;
}

/** Keeps `file`'s fingerprint as the version's, once: never over one it has, never a proxy's (a proxies-only library's source is its proxy). */
export async function fillQuick(versionId: string, file: string): Promise<void> {
  libraryDb()
    .prepare(
      `UPDATE asset_versions SET quick = ? WHERE id = ? AND quick IS NULL AND source_key NOT LIKE 'mac:%'
         AND NOT EXISTS (SELECT 1 FROM derivatives d WHERE d.version_id = asset_versions.id AND d.kind = 'proxy' AND d.storage_key = asset_versions.source_key)`,
    )
    // '' = could not be read: not tried again
    .run((await quickPrint(file)) ?? "", versionId);
}

/**
 * One version from before the column gets its fingerprint, while the library's files lane is idle (worker.ts): only
 * where its original is readable here (in place, or this disk's store), never a download from a bucket. True when it
 * took one. ponytail: one 2 MiB read per idle turn
 */
export async function backfillQuick(): Promise<boolean> {
  const v = libraryDb()
    .prepare(
      `SELECT v.id, v.source_key, v.source_path FROM asset_versions v JOIN assets a ON a.id = v.asset_id JOIN libraries l ON l.id = a.library_id
       WHERE v.quick IS NULL AND v.source_key NOT LIKE 'mac:%' AND v.state IN ('ready', 'failed')
         AND (v.source_path IS NOT NULL OR l.storage_kind = 'local')
         AND NOT EXISTS (SELECT 1 FROM derivatives d WHERE d.version_id = v.id AND d.kind = 'proxy' AND d.storage_key = v.source_key)
       LIMIT 1`,
    )
    .get() as { id: string; source_key: string; source_path: string | null } | undefined;
  if (!v) return false;
  const file = v.source_path ?? (await blobs.localCopy(v.source_key).catch(() => ""));
  await fillQuick(v.id, file);
  return true;
}

/**
 * The caller's versions in `libraryId` that Locate may reconnect: the asked one, gone ones on this server's disk
 * (state missing), and ones indexed on this Mac or on no known Mac (a Mac's file elsewhere is that Mac's). Each with a
 * fingerprint, its path where the library has it, and its size.
 */
export function locatable(libraryId: string, by: string, o: { versionId?: string; device?: string; only?: boolean }) {
  return libraryDb()
    .prepare(
      `SELECT v.id, COALESCE(v.mac_path, v.source_path) AS path, v.bytes FROM asset_versions v JOIN assets a ON a.id = v.asset_id
       WHERE a.library_id = ? AND v.created_by = ? AND a.trashed_at IS NULL AND v.quick != '' AND COALESCE(v.mac_path, v.source_path) IS NOT NULL
         AND (v.id = ? OR (? = 0 AND (v.state = 'missing' OR (v.mac_path IS NOT NULL AND (v.mac_device IS NULL OR v.mac_device = ?)))))`,
    )
    .all(libraryId, by, o.versionId ?? "", o.only ? 1 : 0, o.device ?? "") as { id: string; path: string; bytes: number }[];
}

/**
 * Reconnects the caller's gone versions to files found in the picked folder, by size and fingerprint: `asked` (the
 * clip Locate was pressed on) and `gone` (the ones the Mac did not find where the library has them), plus any missing
 * from this server's disk. A file on a Mac takes the new path and that Mac; one on this server's disk only when this
 * server reads the same file there itself. How many reconnected.
 */
export async function reconnect(libraryId: string, by: string, o: { asked: string; gone: string[]; files: Found[]; device?: string }): Promise<number> {
  const d = libraryDb();
  const rows = d
    .prepare(
      `SELECT v.id, v.bytes, v.quick, v.mac_path, v.source_path FROM asset_versions v JOIN assets a ON a.id = v.asset_id
       WHERE a.library_id = ? AND v.created_by = ? AND a.trashed_at IS NULL AND v.quick != ''
         AND (v.id = ? OR v.state = 'missing' OR v.id IN (SELECT value FROM json_each(?)))`,
    )
    .all(libraryId, by, o.asked, JSON.stringify(o.gone)) as { id: string; bytes: number; quick: string; mac_path: string | null; source_path: string | null }[];
  const byPrint = new Map(o.files.map((f) => [`${f.size}:${f.quick}`, f.path]));
  let n = 0;
  for (const r of rows) {
    const at = byPrint.get(`${r.bytes}:${r.quick}`);
    if (!at) continue;
    if (r.mac_path) {
      d.prepare("UPDATE asset_versions SET mac_path = ?, mac_device = ? WHERE id = ?").run(at, o.device ?? null, r.id);
      n++;
    } else if (r.source_path && (await stat(at).catch(() => null))?.size === r.bytes && (await quickPrint(at)) === r.quick) {
      // back in place: watch.ts refreshMissing finds it there on its next scan and brings the clip back
      d.prepare("UPDATE asset_versions SET source_path = ? WHERE id = ?").run(at, r.id);
      n++;
    }
  }
  if (n) libraryChanged(libraryId);
  return n;
}

const isPath = (p: unknown): p is string => typeof p === "string" && p.startsWith("/") && p.length <= 2048 && !p.split("/").includes("..");
const isId = (s: unknown): s is string => typeof s === "string" && s.length > 0 && s.length <= 100;

/** The body of POST …/locate checked, or what is wrong with it. */
export function parseLocate(body: unknown): { asked: string; gone: string[]; files: Found[]; device?: string } | string {
  const b = (body ?? {}) as Record<string, unknown>;
  if (!isId(b.versionId)) return "Which clip";
  const gone = Array.isArray(b.gone) ? b.gone.slice(0, 100_000) : [];
  const files = Array.isArray(b.files) ? (b.files.slice(0, 20_000) as Record<string, unknown>[]) : [];
  if (!gone.every(isId)) return "Invalid clip id";
  if (!files.every((f) => f && isPath(f.path) && Number.isSafeInteger(f.size) && (f.size as number) > 0 && typeof f.quick === "string" && /^[0-9a-f]{64}$/.test(f.quick)))
    return "Invalid file";
  return {
    asked: b.versionId,
    gone,
    files: files.map((f) => ({ path: path.normalize(f.path as string), size: f.size as number, quick: f.quick as string })),
    ...(isId(b.device) ? { device: b.device } : {}),
  };
}

/**
 * GET /api/library/:id/locate?versionId&device[&only=1] → { files: [{ id, path, bytes }] }: what the Mac checks
 * (locatable; only=1: the asked clip alone, to tell whether its file is gone).
 */
locateApp.get("/:id/locate", async (c) => {
  const user = c.get("user");
  const libraryId = c.req.param("id");
  if (!(await mayAdd(user, libraryId))) return c.json({ error: "Not found", code: "not_found" }, 404);
  const q = c.req.query();
  return c.json({ files: locatable(libraryId, user.username, { versionId: q.versionId, device: q.device, only: q.only === "1" }) });
});

/** POST /api/library/:id/locate { versionId, gone, files, device } → { reconnected }. */
locateApp.post("/:id/locate", async (c) => {
  const user = c.get("user");
  const libraryId = c.req.param("id");
  if (!(await mayAdd(user, libraryId))) return c.json({ error: "Not found", code: "not_found" }, 404);
  const x = parseLocate(await c.req.json().catch(() => null));
  if (typeof x === "string") return c.json({ error: x, code: "invalid" }, 400);
  return c.json({ reconnected: await reconnect(libraryId, user.username, x) });
});
