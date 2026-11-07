import { Hono, type Context } from "hono";
import { randomUUID } from "node:crypto";
import type { AuthVars } from "../auth";
import type { AssetKind, Collection, SearchQuery } from "../../contracts/library";
import { libraryRole } from "./access";
import { libraryDb } from "./db";
import { KINDS } from "./query";

/**
 * Folders and collections (tasks/media-library-plan.md, sections 2, 7 and 9). One table: a folder is a collection with
 * a parent. A manual collection holds asset ids; a smart one keeps a saved SearchQuery and runs it on every read.
 * Members make and edit their own; the owner edits any; every member may add and remove items. Outsiders get 404.
 */

export const collectionApp = new Hono<{ Variables: AuthVars }>();
type Ctx = Context<{ Variables: AuthVars }>;

interface Row {
  id: string;
  library_id: string;
  parent_id: string | null;
  name: string;
  kind: "manual" | "smart";
  query: string | null;
  created_by: string;
}

const db = () => libraryDb();
const notFound = (c: Ctx) => c.json({ error: "Not found", code: "not_found" }, 404);
const rowIn = (libraryId: string, cid: string) =>
  db().prepare("SELECT * FROM collections WHERE id = ? AND library_id = ?").get(cid, libraryId) as Row | undefined;
const nameOf = (v: unknown) => (typeof v === "string" ? v.trim().slice(0, 80) : "");

/** A smart collection's saved query: the search fields only, so no paging, trash or collection inside it. */
export function savedQuery(raw: unknown): SearchQuery {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const kind = Array.isArray(r.kind) ? r.kind.filter((k): k is AssetKind => KINDS.includes(k as AssetKind)) : [];
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const q = typeof r.q === "string" ? r.q.trim().slice(0, 200) : "";
  const tag = typeof r.tag === "string" ? r.tag.slice(0, 80) : "";
  const from = num(r.from);
  const to = num(r.to);
  return {
    ...(q ? { q } : {}),
    ...(kind.length ? { kind } : {}),
    ...(tag ? { tag } : {}),
    ...(from !== undefined ? { from } : {}),
    ...(to !== undefined ? { to } : {}),
  };
}

/**
 * A listing narrowed to a collection. A manual one filters by membership (buildAssetQuery); a smart one runs its saved
 * query, and filters on the request narrow it. Null: the collection is not in this library.
 */
export function expandCollection(libraryId: string, query: SearchQuery): SearchQuery | null {
  if (!query.collectionId) return query;
  const col = rowIn(libraryId, query.collectionId);
  if (!col) return null;
  return col.kind === "smart" ? { ...savedQuery(JSON.parse(col.query ?? "{}")), ...query, collectionId: undefined } : query;
}

const toCollection = (r: Row, count?: number): Collection => ({
  id: r.id,
  name: r.name,
  parentId: r.parent_id,
  kind: r.kind,
  createdBy: r.created_by,
  ...(r.kind === "smart" ? { query: savedQuery(JSON.parse(r.query ?? "{}")) } : count !== undefined ? { count } : {}),
});

// GET /api/library/:id/collections → every folder and collection, flat; the client nests them by parentId
collectionApp.get("/:id/collections", (c) => {
  const libraryId = c.req.param("id");
  if (!libraryRole(c.get("user").username, libraryId)) return notFound(c);
  const rows = db()
    .prepare(
      `SELECT c.*, (SELECT COUNT(*) FROM collection_items i JOIN assets a ON a.id = i.asset_id
          WHERE i.collection_id = c.id AND a.trashed_at IS NULL) AS n
       FROM collections c WHERE c.library_id = ? ORDER BY c.created_at, c.id`,
    )
    .all(libraryId) as unknown as (Row & { n: number })[];
  return c.json({ collections: rows.map((r) => toCollection(r, r.n)) });
});

// is `cid` the same as `parent` or somewhere above it? (a folder can't move inside itself)
function isAbove(parent: string | null, cid: string): boolean {
  for (let p = parent; p !== null; ) {
    if (p === cid) return true;
    p = (db().prepare("SELECT parent_id FROM collections WHERE id = ?").get(p) as { parent_id: string | null } | undefined)?.parent_id ?? null;
  }
  return false;
}

// POST /api/library/:id/collections { name, parentId?, kind?: manual | smart, query? } → 201 Collection (any member)
collectionApp.post("/:id/collections", async (c) => {
  const user = c.get("user");
  const libraryId = c.req.param("id");
  if (!libraryRole(user.username, libraryId)) return notFound(c);
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  const name = nameOf(body?.name);
  if (!name) return c.json({ error: "A name is needed", code: "invalid" }, 400);
  const parent = typeof body?.parentId === "string" ? body.parentId : null;
  if (parent && !rowIn(libraryId, parent)) return notFound(c);
  const kind = body?.kind === "smart" ? "smart" : "manual";
  const query = kind === "smart" ? JSON.stringify(savedQuery(body?.query)) : null;
  const id = `col_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  db()
    .prepare("INSERT INTO collections (id, library_id, parent_id, name, kind, query, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(id, libraryId, parent, name, kind, query, Date.now(), user.username);
  return c.json(toCollection({ id, library_id: libraryId, parent_id: parent, name, kind, query, created_by: user.username }, 0), 201);
});

// PATCH /api/library/:id/collections/:cid { name?, parentId? } → rename or move (creator or owner)
collectionApp.patch("/:id/collections/:cid", async (c) => {
  const user = c.get("user");
  const libraryId = c.req.param("id");
  const role = libraryRole(user.username, libraryId);
  const row = role ? rowIn(libraryId, c.req.param("cid")) : undefined;
  if (!role || !row) return notFound(c);
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  const name = body?.name === undefined ? row.name : nameOf(body.name);
  if (!name) return c.json({ error: "A name is needed", code: "invalid" }, 400);
  let parent = row.parent_id;
  if (body?.parentId !== undefined) {
    parent = typeof body.parentId === "string" ? body.parentId : null;
    if (parent && !rowIn(libraryId, parent)) return notFound(c);
    if (isAbove(parent, row.id)) return c.json({ error: "A folder can't go inside itself", code: "conflict" }, 409);
  }
  db().prepare("UPDATE collections SET name = ?, parent_id = ? WHERE id = ?").run(name, parent, row.id);
  return c.json(toCollection({ ...row, name, parent_id: parent }));
});

// DELETE /api/library/:id/collections/:cid → gone, its items kept in the library, its folders move up one level
collectionApp.delete("/:id/collections/:cid", (c) => {
  const user = c.get("user");
  const libraryId = c.req.param("id");
  const role = libraryRole(user.username, libraryId);
  const row = role ? rowIn(libraryId, c.req.param("cid")) : undefined;
  if (!role || !row) return notFound(c);
  const d = db();
  d.exec("BEGIN");
  try {
    d.prepare("UPDATE collections SET parent_id = ? WHERE parent_id = ?").run(row.parent_id, row.id);
    d.prepare("DELETE FROM collection_items WHERE collection_id = ?").run(row.id);
    d.prepare("DELETE FROM collections WHERE id = ?").run(row.id);
    d.exec("COMMIT");
  } catch (e) {
    d.exec("ROLLBACK");
    throw e;
  }
  return c.json({ ok: true });
});

// POST / DELETE /api/library/:id/collections/:cid/items { assetIds } → add or remove (manual collections only)
collectionApp.post("/:id/collections/:cid/items", (c) => changeItems(c, true));
collectionApp.delete("/:id/collections/:cid/items", (c) => changeItems(c, false));

async function changeItems(c: Ctx, add: boolean) {
  const user = c.get("user");
  const libraryId = c.req.param("id") ?? "";
  if (!libraryRole(user.username, libraryId)) return notFound(c);
  const row = rowIn(libraryId, c.req.param("cid") ?? "");
  if (!row) return notFound(c);
  if (row.kind !== "manual") return c.json({ error: "A smart collection takes its items from its query", code: "conflict" }, 409);
  const body = (await c.req.json().catch(() => null)) as { assetIds?: unknown } | null;
  const ids = Array.isArray(body?.assetIds) ? body.assetIds.filter((x): x is string => typeof x === "string").slice(0, 500) : [];
  if (!ids.length) return c.json({ error: "No assets given", code: "invalid" }, 400);
  const d = db();
  if (!add) {
    const del = d.prepare("DELETE FROM collection_items WHERE collection_id = ? AND asset_id = ?");
    let removed = 0;
    for (const id of ids) removed += del.run(row.id, id).changes as number;
    return c.json({ removed });
  }
  // added at the end, in the order given; trashed or foreign assets are skipped
  const ok = d.prepare("SELECT 1 FROM assets WHERE id = ? AND library_id = ? AND trashed_at IS NULL");
  const ins = d.prepare("INSERT OR IGNORE INTO collection_items (collection_id, asset_id, position, added_by) VALUES (?, ?, ?, ?)");
  let pos = (d.prepare("SELECT COALESCE(MAX(position), 0) AS p FROM collection_items WHERE collection_id = ?").get(row.id) as { p: number }).p;
  let added = 0;
  for (const id of ids) {
    if (!ok.get(id, libraryId)) continue;
    pos += 1;
    added += ins.run(row.id, id, pos, user.username).changes as number;
  }
  return c.json({ added });
}
