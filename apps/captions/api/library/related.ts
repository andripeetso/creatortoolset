import { Hono } from "hono";
import type { AuthVars } from "../auth";
import type { AssetCard } from "../../contracts/library";
import { libraryDb, librarySetting } from "./db";
import { cosine, floorOf } from "./embed";
import { CARD, toCard, type CardRow } from "./query";
import { readerOf, visibleCards } from "./routes";
import { assetRef, canSee } from "./sources";

/**
 * Clips close in meaning to one clip, from the vectors search by meaning already keeps (embed.ts): no new AI call. A
 * clip's vectors are its title and description (chunk 0) and its transcript in windows; two clips are as close as their
 * closest pair of chunks, compared only within the model this clip's vectors were made with, and listed when at least
 * that model's floor close (a version keeps one model's vectors: embed.ts deletes the old ones first). Out of the trash,
 * and only what the viewer may see. Search by meaning off for the library, or no vectors: an empty list.
 */

export const relatedApp = new Hono<{ Variables: AuthVars }>();

const SHOWN = 8;
/** the closest read as cards and checked against the viewer's policies; the eight shown come from these */
const LOOKED_AT = 40;
type Row = { version_id: string; model: string; vec: Uint8Array };
const vecOf = (b: Uint8Array) => new Float32Array(Uint8Array.from(b).buffer);

/** The library's current versions closest to `versionId`, best first, each with its score (no visibility applied). */
export function closestVersions(libraryId: string, versionId: string): { versionId: string; score: number }[] {
  const db = libraryDb();
  const mine = db.prepare("SELECT version_id, model, vec FROM embeddings WHERE version_id = ? AND dims > 0 ORDER BY chunk").all(versionId) as Row[];
  if (!mine.length || !librarySetting(libraryId, "embed")) return [];
  const model = mine[0]!.model;
  const own = mine.filter((r) => r.model === model).map((r) => vecOf(r.vec));
  // ponytail: every chunk of the library read and compared with each of this clip's chunks; fine to about 100k chunks, then sqlite-vec
  const rows = db
    .prepare(
      `SELECT e.version_id, e.model, e.vec FROM embeddings e JOIN assets a ON a.current_version_id = e.version_id
       WHERE a.library_id = ? AND a.trashed_at IS NULL AND e.model = ? AND e.dims > 0 AND e.version_id != ?`,
    )
    .all(libraryId, model, versionId) as Row[];
  const best = new Map<string, number>();
  for (const r of rows) {
    const v = vecOf(r.vec);
    if (v.length !== own[0]!.length) continue;
    const s = Math.max(...own.map((o) => cosine(o, v)));
    if (s > (best.get(r.version_id) ?? -1)) best.set(r.version_id, s);
  }
  const floor = floorOf(model);
  return [...best]
    .filter(([, s]) => s >= floor)
    .sort((a, b) => b[1] - a[1])
    .map(([id, score]) => ({ versionId: id, score }));
}

// GET /api/library/:id/assets/:assetId/related → { related: AssetCard[] }: up to 8 clips closest in meaning
relatedApp.get("/:id/assets/:assetId/related", async (c) => {
  const libraryId = c.req.param("id");
  const viewer = await readerOf(c.get("user").username, libraryId);
  const a = viewer
    ? (libraryDb().prepare("SELECT id, current_version_id FROM assets WHERE id = ? AND library_id = ? AND trashed_at IS NULL").get(c.req.param("assetId"), libraryId) as
        | { id: string; current_version_id: string | null }
        | undefined)
    : undefined;
  if (!viewer || !a?.current_version_id || !(await canSee(viewer, assetRef(libraryId, a.id, a.current_version_id))))
    return c.json({ error: "Not found", code: "not_found" }, 404);
  const near = closestVersions(libraryId, a.current_version_id).slice(0, LOOKED_AT);
  if (!near.length) return c.json({ related: [] as AssetCard[] });
  const ids = near.map((n) => n.versionId);
  const cards = new Map(
    (
      libraryDb()
        .prepare(`SELECT ${CARD} FROM assets a JOIN asset_versions v ON v.id = a.current_version_id WHERE v.id IN (${ids.map(() => "?").join(",")})`)
        .all(...ids) as unknown as CardRow[]
    ).map((r) => [r.version_id, toCard(r)]),
  );
  const ordered = ids.flatMap((id) => cards.get(id) ?? []).filter((card) => card.id !== a.id);
  // the viewer's policies first, then the eight: a clip they may not see never takes a place
  return c.json({ related: (await visibleCards(viewer, libraryId, ordered)).slice(0, SHOWN) });
});
