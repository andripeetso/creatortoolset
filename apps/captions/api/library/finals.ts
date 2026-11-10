import { randomUUID } from "node:crypto";
import { homeOf, libraryRole, mayWrite } from "./access";
import { libraryDb } from "./db";
import { addExternalItem, externalCanSee, externalRefFor } from "./refs";
import { saveToLibrary } from "./routes";
import { pluginFinalsAdded, pluginFinalsRefusal } from "../lib/plugin";
import { emitEvent } from "../lib/events";
import { announce } from "../lib/sync";

/**
 * Finals is a view over the Media Library, not a store of its own: a Finals piece is a `pieces` row in the library's
 * manual collection named Finals, and each finished version is a piece item of an existing library version. Sending
 * marks or links what the library already holds (a Review version, an export it has, a source's own item); bytes are
 * stored once, and only for a file the library does not hold yet. The plug-in's guard (ServerPlugin.finals) can refuse
 * a piece with a reason; a guard that throws refuses too.
 */

/** Finals and Content are what gets posted: never below 1080p (2026-10-02: an AI Editor 540×960 preview got captioned and sent). The refusal, or null. */
export const belowHd = (w?: number, h?: number) =>
  Math.min(w ?? 0, h ?? 0) < 1080
    ? `This video is ${w}×${h}, below 1080p: not sent. Caption a full-size file.`
    : null;

/** What a plug-in's guard is asked: the account, the library, the piece, the version and its size. */
export interface FinalsAdd {
  owner: string;
  libraryId: string;
  /** The piece's name in Finals (a Review project, an export's clip). */
  label: string;
  /** The version's name inside the piece (e.g. "V1A"). */
  item: string | null;
  kind: "export" | "review";
  width: number;
  height: number;
}

/** Where the version comes from: a library version already (linked), a file to store once, or a source's own item (a ref). */
export type FinalsSource =
  | { versionId: string }
  | { file: string; filename: string }
  | { external: { source: string; kind: string; externalId: string; title: string } };

export type FinalsOutcome =
  | { ok: true; pieceId: string; assetId: string | null; versionId: string | null }
  | { ok: false; code: "below_hd" | "refused" | "no_access" | "not_found" | "failed"; error: string };

/** The Media Library the account's Finals live in: its first library, made when there is none. */
export function libraryOf(owner: string): string {
  const home = homeOf(owner);
  const d = libraryDb();
  const found = d.prepare("SELECT id FROM libraries WHERE workspace_id = ? ORDER BY created_at, id LIMIT 1").get(home) as { id: string } | undefined;
  if (found) return found.id;
  const id = `lib_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  d.prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, created_at) VALUES (?, ?, 'Library', 'local', ?)").run(id, home, Date.now());
  return id;
}

/** The library's Finals collection (a plain manual top-level one named Finals), made on first use. Oldest wins if two were made. */
export function finalsCollectionId(libraryId: string): string {
  const d = libraryDb();
  const found = d
    .prepare("SELECT id FROM collections WHERE library_id = ? AND parent_id IS NULL AND kind = 'manual' AND name = 'Finals' ORDER BY created_at, id LIMIT 1")
    .get(libraryId) as { id: string } | undefined;
  if (found) return found.id;
  const id = `col_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  d.prepare("INSERT INTO collections (id, library_id, parent_id, name, kind, created_at) VALUES (?, ?, NULL, 'Finals', 'manual', ?)").run(id, libraryId, Date.now());
  return id;
}

/** Adds one finished file (or a version the library holds, or a source's item) to Finals: into the piece with this name, made when none is there. */
export async function addToFinals(input: FinalsAdd, source: FinalsSource): Promise<FinalsOutcome> {
  const small = belowHd(input.width, input.height);
  if (small) return { ok: false, code: "below_hd", error: small };
  const role = libraryRole(input.owner, input.libraryId);
  if (!role) return { ok: false, code: "not_found", error: "The Media Library isn't on for this account" };
  try {
    const refusal = await pluginFinalsRefusal(input);
    if (refusal) return { ok: false, code: "refused", error: refusal };

    const d = libraryDb();
    let assetId: string | null = null;
    let versionId: string | null = null;
    let ref: ReturnType<typeof externalRefFor> = null;
    if ("external" in source) {
      ref = externalRefFor(source.external.source, source.external.kind, source.external.externalId, source.external.title);
      if (!ref) return { ok: false, code: "failed", error: "That source isn't connected" };
      if (!(await externalCanSee({ username: input.owner, role }, ref, input.libraryId))) return { ok: false, code: "no_access", error: "Not allowed" };
    } else if ("versionId" in source) {
      const row = d
        .prepare("SELECT a.id AS asset_id FROM asset_versions v JOIN assets a ON a.id = v.asset_id WHERE v.id = ? AND a.library_id = ? AND a.trashed_at IS NULL")
        .get(source.versionId, input.libraryId) as { asset_id: string } | undefined;
      if (!row) return { ok: false, code: "not_found", error: "That video is not in the library" };
      if (!(await mayWrite(input.owner, input.libraryId, row.asset_id, source.versionId))) return { ok: false, code: "no_access", error: "Not allowed" };
      assetId = row.asset_id;
      versionId = source.versionId;
    } else {
      const saved = await saveToLibrary(input.owner, source.file, source.filename, [], input.libraryId);
      if (!saved) return { ok: false, code: "no_access", error: "Not allowed" };
      if ("error" in saved) return { ok: false, code: "failed", error: saved.error };
      if ("duplicateOf" in saved) {
        // the library already holds these bytes: link its current version, never a second copy
        const cur = d.prepare("SELECT current_version_id AS v FROM assets WHERE id = ?").get(saved.duplicateOf) as { v: string | null } | undefined;
        assetId = saved.duplicateOf;
        versionId = cur?.v ?? null;
      } else {
        assetId = saved.assetId;
        versionId = saved.versionId;
      }
    }

    const collectionId = finalsCollectionId(input.libraryId);
    let piece = d
      .prepare("SELECT id FROM pieces WHERE library_id = ? AND collection_id = ? AND label = ? ORDER BY created_at, id LIMIT 1")
      .get(input.libraryId, collectionId, input.label) as { id: string } | undefined;
    if (!piece) {
      const id = `pce_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
      d.prepare("INSERT INTO pieces (id, library_id, collection_id, label, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
        id,
        input.libraryId,
        collectionId,
        input.label,
        input.owner,
        Date.now(),
      );
      piece = { id };
    }
    if (ref) {
      addExternalItem(piece.id, ref, input.item);
    } else if (versionId && !d.prepare("SELECT 1 FROM piece_items WHERE piece_id = ? AND version_id = ?").get(piece.id, versionId)) {
      const last = (d.prepare("SELECT COALESCE(MAX(position), 0) AS p FROM piece_items WHERE piece_id = ?").get(piece.id) as { p: number }).p;
      d.prepare("INSERT INTO piece_items (id, piece_id, version_id, label, position) VALUES (?, ?, ?, ?, ?)").run(
        `pci_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
        piece.id,
        versionId,
        input.item,
        last + 1,
      );
    }
    // the library's item is marked Finals too, so the Media Library's Finals collection lists it
    if (assetId) {
      d.prepare(
        `INSERT OR IGNORE INTO collection_items (collection_id, asset_id, position, added_by)
         SELECT ?, ?, COALESCE(MAX(position), 0) + 1, ? FROM collection_items WHERE collection_id = ?`,
      ).run(collectionId, assetId, input.owner, collectionId);
    }
    emitEvent("library.changed", {});
    announce(input.owner, "library"); // sent from the Workshop or the AI Editor: the open Finals pages refetch
    const outcome: FinalsOutcome = { ok: true, pieceId: piece.id, assetId, versionId };
    await pluginFinalsAdded(input, source, outcome); // a plug-in's own reaction (a change note, say); its failure does not undo this
    return outcome;
  } catch (e) {
    return { ok: false, code: "failed", error: e instanceof Error ? e.message : String(e) };
  }
}

/** Links a Finals piece to a session of the same account: its versions get post descriptions there (the piece `docId`,
 *  else the session's main one). False when the piece is not in a library the account owns. */
export function linkFinalsPiece(pieceId: string, sessionId: string, docId: string | undefined, owner: string): boolean {
  const d = libraryDb();
  const row = d.prepare("SELECT library_id FROM pieces WHERE id = ?").get(pieceId) as { library_id: string } | undefined;
  if (!row || libraryRole(owner, row.library_id) !== "owner") return false;
  d.prepare("UPDATE pieces SET workshop_session = ?, workshop_doc = ? WHERE id = ?").run(sessionId, docId ?? null, pieceId);
  emitEvent("library.changed", {});
  announce(owner, "library");
  return true;
}

/** The versions of the live Finals pieces linked to a session, for one of its pieces (docId, or the main one when a piece
 *  has none). The key is the piece item's id; the label names the piece and the version. */
export function finalsLinkedTo(sessionId: string, docId: string, mainDocId: string | undefined): Array<{ key: string; label: string; facts: string }> {
  const d = libraryDb();
  const pieces = d
    .prepare("SELECT id, label, workshop_doc FROM pieces WHERE workshop_session = ? AND trashed_at IS NULL ORDER BY created_at, id")
    .all(sessionId) as { id: string; label: string; workshop_doc: string | null }[];
  const out: Array<{ key: string; label: string; facts: string }> = [];
  for (const p of pieces) {
    if ((p.workshop_doc ?? mainDocId) !== docId) continue;
    const items = d
      .prepare(
        `SELECT i.id, i.label, a.title, a.kind, v.n FROM piece_items i
           LEFT JOIN asset_versions v ON v.id = i.version_id
           LEFT JOIN assets a ON a.id = v.asset_id
         WHERE i.piece_id = ? AND (a.trashed_at IS NULL OR a.id IS NULL) ORDER BY i.position, i.id`,
      )
      .all(p.id) as { id: string; label: string | null; title: string | null; kind: string | null; n: number | null }[];
    // the mechanical facts the writer is given: file name, kind, which version (no content of the file)
    for (const it of items)
      out.push({
        key: it.id,
        label: [p.label, it.label].filter(Boolean).join(" · "),
        facts: [it.title ? `file ${it.title}` : "", it.kind ?? "", it.n ? `version ${it.n}` : ""].filter(Boolean).join(", "),
      });
  }
  return out;
}
