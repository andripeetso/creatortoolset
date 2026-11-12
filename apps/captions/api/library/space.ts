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

/** The models are this computer's, not a library's: only on a server on the person's own computer. */
const mayClearModels = () => deviceTranscribes();

// GET /api/library/:id/space → LibrarySpace; the owner only
spaceApp.get("/:id/space", async (c) => {
  const libraryId = c.req.param("id");
  if (!libraryRole(c.get("user").username, libraryId)) return c.json({ error: "Not found", code: "not_found" }, 404);
  const space: LibrarySpace = {
    proxies: made(libraryId, ["proxy"]),
    pictures: made(libraryId, ["thumb", "wave"]),
    models: mayClearModels() ? { bytes: await folderBytes(modelsDir()) } : null,
  };
  return c.json(space);
});

// POST /api/library/:id/space/clear { what: "proxies" | "models" } → { cleared: bytes, kept: clips being prepared }
spaceApp.post("/:id/space/clear", async (c) => {
  const libraryId = c.req.param("id");
  if (!libraryRole(c.get("user").username, libraryId)) return c.json({ error: "Not found", code: "not_found" }, 404);
  const what = ((await c.req.json().catch(() => null)) as { what?: unknown } | null)?.what;
  const db = libraryDb();
  if (what === "proxies") {
    // a clip being prepared keeps its proxy: a step may be reading it right now
    const rows = db
      .prepare(
        `SELECT d.version_id, d.storage_key, d.bytes, ${OPEN} AS busy FROM derivatives d JOIN asset_versions v ON v.id = d.version_id
         JOIN assets a ON a.id = v.asset_id WHERE a.library_id = ? AND d.kind = 'proxy' AND d.storage_key IS NOT NULL`,
      )
      .all(libraryId) as { version_id: string; storage_key: string; bytes: number; busy: number }[];
    let cleared = 0;
    for (const r of rows.filter((x) => !x.busy)) {
      db.prepare("DELETE FROM derivatives WHERE version_id = ? AND kind = 'proxy'").run(r.version_id);
      // its done job goes too, so the next one that is needed is a new step on the page, not "done" already
      db.prepare("DELETE FROM jobs WHERE version_id = ? AND kind = 'proxy' AND state IN ('done', 'failed')").run(r.version_id);
      await blobs.delete(r.storage_key).catch(() => {});
      cleared += r.bytes;
    }
    libraryChanged(libraryId);
    return c.json({ cleared, kept: rows.length - rows.filter((x) => !x.busy).length });
  }
  if (what === "models") {
    if (!mayClearModels()) return c.json({ error: "Not on this server", code: "forbidden" }, 403);
    const cleared = await folderBytes(modelsDir());
    // a model that is open is left alone, whoever opened it (the library, Caption Studio, Video Notes, the AI Editor, a
    // search): deleting the folder while the model library writes a download into it ends the server
    // (device-transcribe.ts). Nothing is awaited between this check and the delete.
    const open = speechModelInUse() || searchModelInUse() || db.prepare("SELECT 1 FROM jobs WHERE kind IN ('transcribe', 'embed') AND state = 'running'").get();
    if (open) return c.json({ error: "A model is in use right now: clear the models when that work is done", code: "conflict" }, 409);
    await rm(modelsDir(), { recursive: true, force: true });
    return c.json({ cleared, kept: 0 });
  }
  return c.json({ error: "what is proxies or models", code: "invalid" }, 400);
});
