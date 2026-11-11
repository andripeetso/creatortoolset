import { Hono, type Context } from "hono";
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { Readable } from "node:stream";
import path from "node:path";
import type { AuthVars } from "../auth";
import type { AssetKind, Collection, Piece, PieceItem, Posting, SearchQuery } from "../../contracts/library";
import type { LibraryViewer } from "../../contracts/library-source";
import { env } from "../lib/env";
import { sendFile } from "../lib/send-file";
import { storedZip } from "../lib/workshop/deliveries";
import { notifyLibraryChanges } from "../lib/events";
import { libraryRole, mayWrite } from "./access";
import { blobs, libraryDb } from "./db";
import { ffmpegTo } from "./media/run";
import { externalCanSee, externalRefById } from "./refs";
import { KINDS } from "./query";
import { assetRef, canSee } from "./sources";
import { fileRoll, rollFolder } from "./roll";

/**
 * Folders and collections (tasks/media-library-plan.md, sections 2, 7 and 9). One table: a folder is a collection with
 * a parent. A manual collection holds asset ids; a smart one keeps a saved SearchQuery and runs it on every read.
 * Only the library's owner writes: collections, their items and pieces. A grant (grants.ts) lets an account see one
 * collection, not change it. Outsiders and granted accounts get 404.
 * Pieces (migration 6, the bottom of this file) sit beside them: a group of versions with one winner, for Finals.
 */

export const collectionApp = new Hono<{ Variables: AuthVars }>();
collectionApp.use("*", notifyLibraryChanges);
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
    ...(r.roll === "a" || r.roll === "b" ? { roll: r.roll } : {}),
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
  const roll = add ? rollFolder(db(), libraryId, row.id) : null;
  if (row.kind !== "manual" && !roll) return c.json({ error: "A smart collection takes its items from its query", code: "conflict" }, 409);
  const body = (await c.req.json().catch(() => null)) as { assetIds?: unknown } | null;
  const asked = Array.isArray(body?.assetIds) ? body.assetIds.filter((x): x is string => typeof x === "string").slice(0, 500) : [];
  if (!asked.length) return c.json({ error: "No assets given", code: "invalid" }, 400);
  // only the assets the policies let this account change; the rest are skipped, as trashed or foreign ones are
  const ids = await writableAssets(user.username, libraryId, asked);
  const d = db();
  if (roll) {
    // the A-roll folder lists the clips sorted or filed as A-roll: a clip put in it is filed so (roll.ts)
    const video = d.prepare("SELECT 1 FROM assets WHERE id = ? AND library_id = ? AND trashed_at IS NULL AND kind = 'video'");
    const filed = ids.filter((id) => video.get(id, libraryId));
    for (const id of filed) fileRoll(d, id, roll);
    return c.json({ added: filed.length });
  }
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

/*
 * Pieces (schema migration 6). A piece's items are versions of this library (a trashed one is left out of the read);
 * an item with an external ref has no version and is only written by its source. Postings and the post description
 * belong to the item. Access is the same as for folders: any account the library is its own.
 */

interface PieceRow {
  id: string;
  library_id: string;
  collection_id: string | null;
  label: string;
  created_by: string;
  cover_key: string | null;
  cover_version_id: string | null;
  cover_at: number | null;
  trashed_at?: number | null;
}
interface ItemRow {
  id: string;
  piece_id: string;
  version_id: string | null;
  external_ref: string | null;
  label: string | null;
  position: number;
  winner: number;
  post_description: string | null;
}
interface PostingRow {
  id: number;
  platform: string;
  url: string | null;
  posted_at: number;
  created_by: string;
}

const POST_LIMIT = 2200; // Instagram's caption limit: the longest post description kept
const pieceIn = (libraryId: string, pid: string) =>
  db().prepare("SELECT * FROM pieces WHERE id = ? AND library_id = ?").get(pid, libraryId) as PieceRow | undefined;
const itemIn = (pieceId: string, iid: string) =>
  db().prepare("SELECT * FROM piece_items WHERE id = ? AND piece_id = ?").get(iid, pieceId) as ItemRow | undefined;
const itemLabel = (v: unknown) => nameOf(v) || null;

/**
 * A piece the account may change: its library role, and the policies let it see every item (an item it may not see,
 * or an item with no version to check, refuses the whole piece). Every piece write goes through here.
 */
async function writablePiece(username: string, libraryId: string, pid: string): Promise<PieceRow | undefined> {
  if (!libraryRole(username, libraryId)) return undefined;
  const piece = pieceIn(libraryId, pid);
  if (!piece) return undefined;
  const items = db()
    .prepare(
      `SELECT i.version_id AS version_id, v.asset_id AS asset_id FROM piece_items i
       LEFT JOIN asset_versions v ON v.id = i.version_id WHERE i.piece_id = ?`,
    )
    .all(piece.id) as { version_id: string | null; asset_id: string | null }[];
  for (const i of items) {
    if (!i.version_id || !i.asset_id || !(await mayWrite(username, libraryId, i.asset_id, i.version_id))) return undefined;
  }
  return piece;
}

/** The ids of the library's assets the account may change: the policies see each one's current version. */
async function writableAssets(username: string, libraryId: string, ids: string[]): Promise<string[]> {
  const current = db().prepare("SELECT current_version_id AS version_id FROM assets WHERE id = ? AND library_id = ?");
  const out: string[] = [];
  for (const id of ids) {
    const cur = current.get(id, libraryId) as { version_id: string | null } | undefined;
    if (cur?.version_id && (await mayWrite(username, libraryId, id, cur.version_id))) out.push(id);
  }
  return out;
}

/** Runs `fn` as one transaction: its writes all land, or none do. */
function inTx(fn: () => void): void {
  const d = db();
  d.exec("BEGIN");
  try {
    fn();
    d.exec("COMMIT");
  } catch (e) {
    d.exec("ROLLBACK");
    throw e;
  }
}

/** Back to the automatic cover: the picked frame's row and its file go. */
async function dropCover(piece: PieceRow): Promise<PieceRow> {
  db().prepare("UPDATE pieces SET cover_key = NULL, cover_version_id = NULL, cover_at = NULL WHERE id = ?").run(piece.id);
  if (piece.cover_key) await blobs.delete(piece.cover_key).catch(() => {});
  return { ...piece, cover_key: null, cover_version_id: null, cover_at: null };
}

/** A piece as the API returns it: its live items in position order, each with its postings. */
function pieceOf(p: PieceRow): Piece {
  const items = db()
    .prepare(
      `SELECT i.* FROM piece_items i
         LEFT JOIN asset_versions v ON v.id = i.version_id
         LEFT JOIN assets a ON a.id = v.asset_id
       WHERE i.piece_id = ? AND (a.trashed_at IS NULL OR a.id IS NULL)
       ORDER BY i.position, i.id`,
    )
    .all(p.id) as unknown as ItemRow[];
  const postingsOf = db().prepare("SELECT id, platform, url, posted_at, created_by FROM postings WHERE piece_item_id = ? ORDER BY posted_at, id");
  return {
    id: p.id,
    label: p.label,
    collectionId: p.collection_id,
    createdBy: p.created_by,
    coverUrl: p.cover_at ? `/api/library/${p.library_id}/pieces/${p.id}/cover?v=${p.cover_at}` : null,
    items: items.map(
      (i): PieceItem => ({
        id: i.id,
        label: i.label,
        position: i.position,
        winner: i.winner === 1,
        versionId: i.version_id,
        externalRef: i.external_ref,
        postDescription: i.post_description,
        postings: (postingsOf.all(i.id) as unknown as PostingRow[]).map(
          (r): Posting => ({ id: r.id, platform: r.platform, url: r.url, postedAt: r.posted_at, createdBy: r.created_by }),
        ),
      }),
    ),
  };
}

/**
 * A piece with only the items the viewer may see (sources.ts). An external ref is seen through its source's policy
 * (refs.ts), so it is left out until the source is registered with one.
 */
async function visibleItems(viewer: LibraryViewer, libraryId: string, p: Piece): Promise<Piece> {
  const items: PieceItem[] = [];
  for (const i of p.items) {
    if (i.externalRef) {
      const ref = externalRefById(i.externalRef);
      if (ref && (await externalCanSee(viewer, ref, libraryId))) items.push(i);
      continue;
    }
    const asset = i.versionId
      ? (db().prepare("SELECT a.id AS id FROM asset_versions v JOIN assets a ON a.id = v.asset_id WHERE v.id = ?").get(i.versionId) as { id: string } | undefined)
      : undefined;
    if (asset && i.versionId && (await canSee(viewer, assetRef(libraryId, asset.id, i.versionId)))) items.push(i);
  }
  return { ...p, items };
}

// GET /api/library/:id/pieces[?collectionId=] → the library's pieces, or one collection's (Finals is one of these). A piece
// whose items the viewer may not see at all is left out, and so are the items they may not see.
collectionApp.get("/:id/pieces", async (c) => {
  const libraryId = c.req.param("id");
  const role = libraryRole(c.get("user").username, libraryId);
  if (!role) return notFound(c);
  const viewer: LibraryViewer = { username: c.get("user").username, role };
  const cid = c.req.query("collectionId") ?? null;
  const rows = db()
    .prepare("SELECT * FROM pieces WHERE library_id = ? AND (? IS NULL OR collection_id = ?) AND ((trashed_at IS NOT NULL) = ?) ORDER BY created_at, id")
    .all(libraryId, cid, cid, c.req.query("trash") === "1" ? 1 : 0) as unknown as PieceRow[];
  const pieces: Piece[] = [];
  for (const p of rows.map(pieceOf)) {
    const seen = await visibleItems(viewer, libraryId, p);
    if (seen.items.length || !p.items.length) pieces.push(seen);
  }
  return c.json({ pieces });
});

// POST /api/library/:id/pieces { label, collectionId? } → 201 Piece
collectionApp.post("/:id/pieces", async (c) => {
  const user = c.get("user");
  const libraryId = c.req.param("id");
  if (!libraryRole(user.username, libraryId)) return notFound(c);
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  const label = nameOf(body?.label);
  if (!label) return c.json({ error: "A label is needed", code: "invalid" }, 400);
  const collectionId = typeof body?.collectionId === "string" ? body.collectionId : null;
  if (collectionId && !rowIn(libraryId, collectionId)) return notFound(c);
  const id = `pce_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  db()
    .prepare("INSERT INTO pieces (id, library_id, collection_id, label, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(id, libraryId, collectionId, label, user.username, Date.now());
  return c.json(
    pieceOf({ id, library_id: libraryId, collection_id: collectionId, label, created_by: user.username, cover_key: null, cover_version_id: null, cover_at: null }),
    201,
  );
});

// PATCH /api/library/:id/pieces/:pid { label?, collectionId? } → the piece
collectionApp.patch("/:id/pieces/:pid", async (c) => {
  const libraryId = c.req.param("id");
  const row = await writablePiece(c.get("user").username, libraryId, c.req.param("pid"));
  if (!row) return notFound(c);
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  const label = body?.label === undefined ? row.label : nameOf(body.label);
  if (!label) return c.json({ error: "A label is needed", code: "invalid" }, 400);
  let collectionId = row.collection_id;
  if (body?.collectionId !== undefined) {
    collectionId = typeof body.collectionId === "string" ? body.collectionId : null;
    if (collectionId && !rowIn(libraryId, collectionId)) return notFound(c);
  }
  db().prepare("UPDATE pieces SET label = ?, collection_id = ? WHERE id = ?").run(label, collectionId, row.id);
  return c.json(pieceOf({ ...row, label, collection_id: collectionId }));
});

// POST /api/library/:id/pieces/:pid/trash → the piece goes to the trash (GET …/pieces?trash=1 lists it); restore takes it back.
// Its versions stay in the library either way.
collectionApp.post("/:id/pieces/:pid/trash", (c) => setPieceTrashed(c, true));
collectionApp.post("/:id/pieces/:pid/restore", (c) => setPieceTrashed(c, false));

async function setPieceTrashed(c: Ctx, trash: boolean) {
  const libraryId = c.req.param("id") ?? "";
  const row = await writablePiece(c.get("user").username, libraryId, c.req.param("pid") ?? "");
  if (!row) return notFound(c);
  db().prepare("UPDATE pieces SET trashed_at = ? WHERE id = ?").run(trash ? Date.now() : null, row.id);
  return c.json(pieceOf({ ...row, trashed_at: trash ? Date.now() : null }));
}

// POST /api/library/:id/pieces/:pid/merge { from } → Piece: the piece `from` joins this one. Its items move over (this
// piece keeps its label, winner and cover) and `from` goes. A version both pieces hold refuses the merge (409), so no
// posting is lost in the move.
collectionApp.post("/:id/pieces/:pid/merge", async (c) => {
  const libraryId = c.req.param("id");
  const user = c.get("user").username;
  const target = await writablePiece(user, libraryId, c.req.param("pid"));
  const body = (await c.req.json().catch(() => null)) as { from?: unknown } | null;
  const fromId = typeof body?.from === "string" ? body.from : "";
  const from = fromId && fromId !== c.req.param("pid") ? await writablePiece(user, libraryId, fromId) : undefined;
  if (!target || !from) return notFound(c);
  const both = db()
    .prepare("SELECT 1 FROM piece_items a JOIN piece_items b ON b.version_id = a.version_id WHERE a.piece_id = ? AND b.piece_id = ? AND a.version_id IS NOT NULL")
    .get(from.id, target.id);
  if (both) return c.json({ error: "A version is in both pieces: take it out of one first", code: "conflict" }, 409);
  inTx(() => {
    const top = (db().prepare("SELECT COALESCE(MAX(position), 0) AS p FROM piece_items WHERE piece_id = ?").get(target.id) as { p: number }).p;
    db().prepare("UPDATE piece_items SET piece_id = ?, position = position + ?, winner = 0 WHERE piece_id = ?").run(target.id, top, from.id);
    db().prepare("DELETE FROM pieces WHERE id = ?").run(from.id);
  });
  if (from.cover_key) await blobs.delete(from.cover_key).catch(() => {});
  return c.json(pieceOf(target));
});

// POST /api/library/:id/pieces/:pid/items/:iid/split → 201 Piece: the item leaves for a piece of its own (named as the item,
// in the same collection). Its postings go with it; the piece it left keeps the rest.
collectionApp.post("/:id/pieces/:pid/items/:iid/split", async (c) => {
  const libraryId = c.req.param("id");
  const user = c.get("user").username;
  const piece = await writablePiece(user, libraryId, c.req.param("pid"));
  const item = piece ? itemIn(piece.id, c.req.param("iid")) : undefined;
  if (!piece || !item) return notFound(c);
  if (piece.cover_version_id && piece.cover_version_id === item.version_id) await dropCover(piece);
  const id = `pce_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  inTx(() => {
    db()
      .prepare("INSERT INTO pieces (id, library_id, collection_id, label, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, libraryId, piece.collection_id, item.label || piece.label, user, Date.now());
    db().prepare("UPDATE piece_items SET piece_id = ?, position = 1, winner = 0 WHERE id = ?").run(id, item.id);
  });
  return c.json(pieceOf(db().prepare("SELECT * FROM pieces WHERE id = ?").get(id) as unknown as PieceRow), 201);
});

// DELETE /api/library/:id/pieces/:pid → gone with its items and postings; the versions stay in the library
collectionApp.delete("/:id/pieces/:pid", async (c) => {
  const libraryId = c.req.param("id");
  const row = await writablePiece(c.get("user").username, libraryId, c.req.param("pid"));
  if (!row) return notFound(c);
  db().prepare("DELETE FROM pieces WHERE id = ?").run(row.id);
  if (row.cover_key) await blobs.delete(row.cover_key).catch(() => {});
  return c.json({ ok: true });
});

// POST /api/library/:id/pieces/:pid/items { versionId, label? } → 201 Piece. Added last; the version must be live here.
collectionApp.post("/:id/pieces/:pid/items", async (c) => {
  const libraryId = c.req.param("id");
  const piece = await writablePiece(c.get("user").username, libraryId, c.req.param("pid"));
  if (!piece) return notFound(c);
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  const versionId = typeof body?.versionId === "string" ? body.versionId : "";
  const live = versionId
    ? (db()
        .prepare("SELECT a.id AS asset_id FROM asset_versions v JOIN assets a ON a.id = v.asset_id WHERE v.id = ? AND a.library_id = ? AND a.trashed_at IS NULL")
        .get(versionId, libraryId) as { asset_id: string } | undefined)
    : undefined;
  if (!live || !(await mayWrite(c.get("user").username, libraryId, live.asset_id, versionId))) return notFound(c);
  if (db().prepare("SELECT 1 FROM piece_items WHERE piece_id = ? AND version_id = ?").get(piece.id, versionId)) {
    return c.json({ error: "That version is already in this piece", code: "conflict" }, 409);
  }
  const last = (db().prepare("SELECT COALESCE(MAX(position), 0) AS p FROM piece_items WHERE piece_id = ?").get(piece.id) as { p: number }).p;
  db()
    .prepare("INSERT INTO piece_items (id, piece_id, version_id, label, position) VALUES (?, ?, ?, ?, ?)")
    .run(`pci_${randomUUID().replace(/-/g, "").slice(0, 16)}`, piece.id, versionId, itemLabel(body?.label), last + 1);
  return c.json(pieceOf(piece), 201);
});

// PATCH /api/library/:id/pieces/:pid/items/:iid { label?, position?, winner?, postDescription? } → the piece.
// Setting winner clears the winner the piece had: one winner at most.
collectionApp.patch("/:id/pieces/:pid/items/:iid", async (c) => {
  const libraryId = c.req.param("id");
  const piece = await writablePiece(c.get("user").username, libraryId, c.req.param("pid"));
  const item = piece ? itemIn(piece.id, c.req.param("iid")) : undefined;
  if (!piece || !item) return notFound(c);
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  const label = body?.label === undefined ? item.label : itemLabel(body.label);
  const position = typeof body?.position === "number" && Number.isFinite(body.position) ? body.position : item.position;
  const winner = typeof body?.winner === "boolean" ? body.winner : item.winner === 1;
  const post =
    body?.postDescription === undefined
      ? item.post_description
      : typeof body.postDescription === "string" && body.postDescription.trim()
        ? body.postDescription.slice(0, POST_LIMIT)
        : null;
  inTx(() => {
    if (winner) db().prepare("UPDATE piece_items SET winner = 0 WHERE piece_id = ? AND winner = 1").run(piece.id);
    db()
      .prepare("UPDATE piece_items SET label = ?, position = ?, winner = ?, post_description = ? WHERE id = ?")
      .run(label, position, winner ? 1 : 0, post, item.id);
  });
  return c.json(pieceOf(piece));
});

// DELETE /api/library/:id/pieces/:pid/items/:iid → the piece; its postings go with it
collectionApp.delete("/:id/pieces/:pid/items/:iid", async (c) => {
  const libraryId = c.req.param("id");
  const piece = await writablePiece(c.get("user").username, libraryId, c.req.param("pid"));
  const item = piece ? itemIn(piece.id, c.req.param("iid")) : undefined;
  if (!piece || !item) return notFound(c);
  // the picked cover is a frame of this version: without the version, the cover goes back to automatic
  const next = piece.cover_version_id && piece.cover_version_id === item.version_id ? await dropCover(piece) : piece;
  db().prepare("DELETE FROM piece_items WHERE id = ?").run(item.id);
  return c.json(pieceOf(next));
});

// POST /api/library/:id/pieces/:pid/items/:iid/postings { platform, url? } → 201 Piece: one more place the item went
collectionApp.post("/:id/pieces/:pid/items/:iid/postings", async (c) => {
  const user = c.get("user");
  const libraryId = c.req.param("id");
  const piece = await writablePiece(user.username, libraryId, c.req.param("pid"));
  const item = piece ? itemIn(piece.id, c.req.param("iid")) : undefined;
  if (!piece || !item) return notFound(c);
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  const platform = nameOf(body?.platform);
  if (!platform) return c.json({ error: "A platform is needed", code: "invalid" }, 400);
  const url = typeof body?.url === "string" && body.url.trim() ? body.url.trim().slice(0, 500) : null;
  if (url && !/^https?:\/\//.test(url)) return c.json({ error: "A posting link starts with http:// or https://", code: "invalid" }, 400);
  db()
    .prepare("INSERT INTO postings (piece_item_id, platform, url, posted_at, created_by) VALUES (?, ?, ?, ?, ?)")
    .run(item.id, platform, url, Date.now(), user.username);
  return c.json(pieceOf(piece), 201);
});

// DELETE /api/library/:id/pieces/:pid/items/:iid/postings/:n → the piece; takes out one posting by its id
collectionApp.delete("/:id/pieces/:pid/items/:iid/postings/:n", async (c) => {
  const libraryId = c.req.param("id");
  const piece = await writablePiece(c.get("user").username, libraryId, c.req.param("pid"));
  const item = piece ? itemIn(piece.id, c.req.param("iid")) : undefined;
  if (!piece || !item) return notFound(c);
  db().prepare("DELETE FROM postings WHERE piece_item_id = ? AND id = ?").run(item.id, Number(c.req.param("n")));
  return c.json(pieceOf(piece));
});

// GET /api/library/:id/pieces/:pid → one piece with the items the viewer may see, and `writable` (every item is theirs to
// change). A piece with items, none of them visible, is 404, as it is in the list.
collectionApp.get("/:id/pieces/:pid", async (c) => {
  const user = c.get("user");
  const libraryId = c.req.param("id");
  const role = libraryRole(user.username, libraryId);
  const row = role ? pieceIn(libraryId, c.req.param("pid")) : undefined;
  if (!role || !row) return notFound(c);
  const all = pieceOf(row);
  const seen = await visibleItems({ username: user.username, role }, libraryId, all);
  if (!seen.items.length && all.items.length) return notFound(c);
  return c.json({ ...seen, writable: !!(await writablePiece(user.username, libraryId, row.id)) });
});

const EXT_OF: Record<string, string> = {
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
  "video/webm": ".webm",
  "video/x-matroska": ".mkv",
  "video/x-msvideo": ".avi",
  "audio/mp4": ".m4a",
  "audio/mpeg": ".mp3",
  "audio/wav": ".wav",
  "audio/ogg": ".ogg",
  "audio/flac": ".flac",
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
};

// GET /api/library/:id/pieces/:pid/zip → the versions the viewer may see, in drag order, as one ZIP of their source files
// (Save all). Visibility is the piece read's: a version the viewer may not see is left out, and a piece none of whose
// versions they may see is 404. Stored, not compressed, like the Workshop's ZIP.
collectionApp.get("/:id/pieces/:pid/zip", async (c) => {
  const user = c.get("user");
  const libraryId = c.req.param("id");
  const role = libraryRole(user.username, libraryId);
  const row = role ? pieceIn(libraryId, c.req.param("pid")) : undefined;
  if (!role || !row) return notFound(c);
  const all = pieceOf(row);
  const seen = await visibleItems({ username: user.username, role }, libraryId, all);
  if (!seen.items.length && all.items.length) return notFound(c);
  try {
    const files: { path: string; name: string }[] = [];
    for (const [n, item] of seen.items.entries()) {
      if (!item.versionId) continue; // an external ref has no file in this library
      const v = db()
        .prepare("SELECT v.source_key, v.source_path, v.mime, a.title FROM asset_versions v JOIN assets a ON a.id = v.asset_id WHERE v.id = ?")
        .get(item.versionId) as { source_key: string; source_path: string | null; mime: string | null; title: string } | undefined;
      if (!v) continue;
      const base = (item.label || v.title).replace(/[^\w.-]+/g, "_").slice(0, 80) || "version";
      const ext = path.extname(v.source_path ?? "") || EXT_OF[v.mime ?? ""] || "";
      files.push({ path: await blobs.localCopy(v.source_key), name: `${String(n + 1).padStart(2, "0")}-${base}${ext}` });
    }
    if (!files.length) return c.json({ error: "No versions to save", code: "conflict" }, 409);
    const zip = await storedZip(files);
    const name = `${row.label.replace(/[^\w.-]+/g, "_").slice(0, 80) || "finals"}.zip`;
    return new Response(Readable.toWeb(zip.body) as never, {
      headers: {
        "Content-Type": "application/zip",
        "Content-Length": String(zip.size),
        "Content-Disposition": `attachment; filename="${name}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e), code: "conflict" }, 409);
  }
});

// POST /api/library/:id/pieces/:pid/cover { versionId, t? } → the piece. The frame at t seconds of one of its versions (a
// still is its own picture) becomes the cover on the Finals list, in place of the automatic one.
collectionApp.post("/:id/pieces/:pid/cover", async (c) => {
  const libraryId = c.req.param("id");
  const piece = await writablePiece(c.get("user").username, libraryId, c.req.param("pid"));
  if (!piece) return notFound(c);
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  const versionId = typeof body?.versionId === "string" ? body.versionId : "";
  const t = body?.t === undefined ? 0 : body.t;
  if (typeof t !== "number" || !Number.isFinite(t) || t < 0) return c.json({ error: "A frame time is needed", code: "invalid" }, 400);
  // the version must be an item of this piece, live in the library; the proxy (playable) when there is one
  const v = db()
    .prepare(
      `SELECT v.source_key, a.kind, d.storage_key AS proxy FROM piece_items i
         JOIN asset_versions v ON v.id = i.version_id
         JOIN assets a ON a.id = v.asset_id
         LEFT JOIN derivatives d ON d.version_id = v.id AND d.kind = 'proxy'
       WHERE i.piece_id = ? AND i.version_id = ? AND a.trashed_at IS NULL`,
    )
    .get(piece.id, versionId) as { source_key: string; kind: AssetKind; proxy: string | null } | undefined;
  if (!v) return notFound(c);
  const dir = path.join(process.env.LIBRARY_SCRATCH_DIR || path.join(env.dataDir, "library", "scratch"));
  await mkdir(dir, { recursive: true });
  const out = path.join(dir, `cover-${randomUUID()}.jpg`);
  try {
    const src = await blobs.localCopy(v.proxy ?? v.source_key);
    const framed = await ffmpegTo(out, [...(v.kind === "video" ? ["-ss", String(t)] : []), "-i", src, "-frames:v", "1", "-vf", "scale=480:-2", "-q:v", "4"]).then(
      () => true,
      () => false,
    );
    if (!framed) return c.json({ error: "There is no picture at that time", code: "invalid" }, 400);
    const stamp = Date.now();
    const key = `libraries/${libraryId}/pieces/${piece.id}/cover-${stamp}.jpg`;
    await blobs.put(key, out, { contentType: "image/jpeg" });
    const old = piece.cover_key;
    db().prepare("UPDATE pieces SET cover_key = ?, cover_version_id = ?, cover_at = ? WHERE id = ?").run(key, versionId, stamp, piece.id);
    if (old) await blobs.delete(old).catch(() => {});
    return c.json(pieceOf({ ...piece, cover_key: key, cover_version_id: versionId, cover_at: stamp }));
  } finally {
    await rm(out, { force: true });
  }
});

// DELETE /api/library/:id/pieces/:pid/cover → the piece, back to the automatic cover
collectionApp.delete("/:id/pieces/:pid/cover", async (c) => {
  const piece = await writablePiece(c.get("user").username, c.req.param("id"), c.req.param("pid"));
  if (!piece) return notFound(c);
  return c.json(pieceOf(await dropCover(piece)));
});

// GET /api/library/:id/pieces/:pid/cover → the picked frame. It is footage, so the version it came from decides who sees it
// (a trashed version has no cover); the stamp in the URL makes a new pick a new address.
collectionApp.get("/:id/pieces/:pid/cover", async (c) => {
  const user = c.get("user");
  const libraryId = c.req.param("id");
  const role = libraryRole(user.username, libraryId);
  const row = role ? pieceIn(libraryId, c.req.param("pid")) : undefined;
  if (!role || !row?.cover_key || !row.cover_version_id) return notFound(c);
  const v = db()
    .prepare("SELECT a.id AS asset_id FROM asset_versions v JOIN assets a ON a.id = v.asset_id WHERE v.id = ? AND a.trashed_at IS NULL")
    .get(row.cover_version_id) as { asset_id: string } | undefined;
  if (!v || !(await canSee({ username: user.username, role }, assetRef(libraryId, v.asset_id, row.cover_version_id)))) return notFound(c);
  try {
    const at = await blobs.locate(row.cover_key, 900, { contentType: "image/jpeg" });
    return at.kind === "url" ? c.redirect(at.url, 302) : await sendFile(c, at.path, "image/jpeg");
  } catch {
    return c.json({ error: "Not ready", code: "conflict" }, 409);
  }
});
