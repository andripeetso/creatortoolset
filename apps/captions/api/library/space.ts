import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Hono } from "hono";
import type { LibrarySpace } from "../../contracts/library";
import type { AuthVars } from "../auth";
import { env } from "../lib/env";
import { searchModelInUse } from "../lib/device-embed";
import { deviceTranscribes, speechModelInUse } from "../lib/device-transcribe";
import { libraryChanged, libraryRole } from "./access";
import { blobs, libraryDb } from "./db";

/**
 * The space the library's own made files take, and clearing the ones it makes again (Library settings → Storage): its
 * proxies, made again when a clip that needs one is opened (routes.ts libraryMedia), and the speech and search models,
 * downloaded again the next time they are needed. The person's own files (originals, a folder's footage) are never
 * touched, and neither is a clip being prepared right now.
 */

export const spaceApp = new Hono<{ Variables: AuthVars }>();

const modelsDir = () => path.join(env.dataDir, "models");

async function folderBytes(dir: string): Promise<number> {
  const all = await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => []);
  let n = 0;
  for (const e of all) if (e.isFile()) n += (await stat(path.join(e.parentPath, e.name)).catch(() => null))?.size ?? 0;
  return n;
}

const OPEN = "EXISTS (SELECT 1 FROM jobs j WHERE j.version_id = d.version_id AND j.state IN ('queued', 'running'))";

/** The library's derivatives of `kinds`: their bytes and how many files. */
function made(libraryId: string, kinds: string[]): { bytes: number; files: number } {
  return libraryDb()
    .prepare(
      `SELECT COALESCE(SUM(d.bytes), 0) AS bytes, COUNT(*) AS files FROM derivatives d JOIN asset_versions v ON v.id = d.version_id
       JOIN assets a ON a.id = v.asset_id WHERE a.library_id = ? AND d.storage_key IS NOT NULL AND d.kind IN (${kinds.map(() => "?").join(",")})`,
    )
    .get(libraryId, ...kinds) as { bytes: number; files: number };
}

/**
 * Where the library's videos are, one row each (its current version, trashed ones left out): indexed on a Mac
 * (on-mac.ts), read in place from a folder on this server's computer, or stored by this server (its disk or bucket).
 */
function videosOf(libraryId: string): LibrarySpace["videos"] {
  const r = libraryDb()
    .prepare(
      `SELECT COALESCE(SUM(v.mac_path IS NOT NULL), 0) AS on_mac, COALESCE(SUM(v.mac_path IS NULL AND v.source_path IS NOT NULL), 0) AS in_place,
         COALESCE(SUM(v.mac_path IS NULL AND v.source_path IS NULL), 0) AS stored, COALESCE(SUM(CASE WHEN v.mac_path IS NULL AND v.source_path IS NULL THEN v.bytes END), 0) AS bytes
       FROM assets a JOIN asset_versions v ON v.id = a.current_version_id WHERE a.library_id = ? AND a.kind = 'video' AND a.trashed_at IS NULL`,
    )
    .get(libraryId) as { on_mac: number; in_place: number; stored: number; bytes: number };
  return { onMac: r.on_mac, inPlace: r.in_place, stored: { files: r.stored, bytes: r.bytes } };
}

/**
 * Deletes the library's proxies and forgets them, so each is made again when it is wanted. A clip being prepared keeps
 * its proxy (a step may be reading it right now), unless `all`: the proxies move to another place, and one left behind
 * would point where the routing no longer looks (db.ts storeOf).
 */
export async function clearProxies(libraryId: string, all = false): Promise<{ cleared: number; kept: number }> {
  const db = libraryDb();
  const rows = db
    .prepare(
      `SELECT d.version_id, d.storage_key, d.bytes, ${OPEN} AS busy FROM derivatives d JOIN asset_versions v ON v.id = d.version_id
       JOIN assets a ON a.id = v.asset_id WHERE a.library_id = ? AND d.kind = 'proxy' AND d.storage_key IS NOT NULL`,
    )
    .all(libraryId) as { version_id: string; storage_key: string; bytes: number; busy: number }[];
  const going = rows.filter((x) => all || !x.busy);
  let cleared = 0;
  for (const r of going) {
    db.prepare("DELETE FROM derivatives WHERE version_id = ? AND kind = 'proxy'").run(r.version_id);
    // its done job goes too, so the next one that is needed is a new step on the page, not "done" already
    db.prepare("DELETE FROM jobs WHERE version_id = ? AND kind = 'proxy' AND state IN ('done', 'failed')").run(r.version_id);
    await blobs.delete(r.storage_key).catch(() => {});
    cleared += r.bytes;
  }
  libraryChanged(libraryId);
  return { cleared, kept: rows.length - going.length };
}

/** The models are this computer's, not a library's: only on a server on the person's own computer. */
const mayClearModels = () => deviceTranscribes();

// GET /api/library/:id/space → LibrarySpace; the owner only
spaceApp.get("/:id/space", async (c) => {
  const libraryId = c.req.param("id");
  if (!libraryRole(c.get("user").username, libraryId)) return c.json({ error: "Not found", code: "not_found" }, 404);
  const space: LibrarySpace = {
    videos: videosOf(libraryId),
    proxies: made(libraryId, ["proxy"]),
    pictures: made(libraryId, ["thumb", "wave", "sprite"]),
    models: mayClearModels() ? { bytes: await folderBytes(modelsDir()) } : null,
  };
  return c.json(space);
});

// POST /api/library/:id/space/clear { what: "proxies" | "models" } → { cleared: bytes, kept: clips being prepared }
spaceApp.post("/:id/space/clear", async (c) => {
  const libraryId = c.req.param("id");
  if (!libraryRole(c.get("user").username, libraryId)) return c.json({ error: "Not found", code: "not_found" }, 404);
  const what = ((await c.req.json().catch(() => null)) as { what?: unknown } | null)?.what;
  if (what === "proxies") return c.json(await clearProxies(libraryId));
  if (what === "models") {
    if (!mayClearModels()) return c.json({ error: "Not on this server", code: "forbidden" }, 403);
    const cleared = await folderBytes(modelsDir());
    // a model that is open is left alone, whoever opened it (the library, Caption Studio, Video Notes, the AI Editor, a
    // search): deleting the folder while the model library writes a download into it ends the server
    // (device-transcribe.ts). Nothing is awaited between this check and the delete.
    const open = speechModelInUse() || searchModelInUse() || libraryDb().prepare("SELECT 1 FROM jobs WHERE kind IN ('transcribe', 'embed') AND state = 'running'").get();
    if (open) return c.json({ error: "A model is in use right now: clear the models when that work is done", code: "conflict" }, 409);
    await rm(modelsDir(), { recursive: true, force: true });
    return c.json({ cleared, kept: 0 });
  }
  return c.json({ error: "what is proxies or models", code: "invalid" }, 400);
});
