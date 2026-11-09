import { randomUUID } from "node:crypto";
import type { LibraryAssetRef, LibraryViewer } from "../../contracts/library-source";
import { libraryDb } from "./db";
import { canSee, hasLibrarySource } from "./sources";

/**
 * External refs (schema migration 11): a clip or group that a library source holds, such as an integer id from a plug-in.
 * Each one gets a public id ("ext_…") that pieces and Workshop links keep, so a link made before a move still opens after
 * it. The source's own id stays in this table, never in a URL. An external ref has no version and no file here: its
 * stream, thumbnail and share go through its source, and a source with no policy refuses it (sources.ts), so nothing
 * shows until a plug-in registers the source and its policy.
 */

export interface ExternalRef {
  id: string;
  source: string;
  kind: string;
  externalId: string;
  title: string;
}

interface Row {
  id: string;
  source: string;
  kind: string;
  external_id: string;
  title: string;
}

const NAME = /^[a-z][a-z0-9_-]{0,39}$/;
const EXTERNAL_ID = /^[A-Za-z0-9_.:-]{1,120}$/;

const toRef = (r: Row): ExternalRef => ({ id: r.id, source: r.source, kind: r.kind, externalId: r.external_id, title: r.title });

/** The ref with this public id, or null. */
export function externalRefById(id: string): ExternalRef | null {
  const row = libraryDb().prepare("SELECT * FROM external_refs WHERE id = ?").get(id) as Row | undefined;
  return row ? toRef(row) : null;
}

/**
 * The ref for one item of a registered source, made on first use. An unregistered source, or a malformed name or id,
 * gives null and writes nothing. A non-empty title replaces the stored one, so a source can refresh it.
 */
export function externalRefFor(source: string, kind: string, externalId: string, title = ""): ExternalRef | null {
  if (!NAME.test(source) || !NAME.test(kind) || !EXTERNAL_ID.test(externalId) || !hasLibrarySource(source)) return null;
  const d = libraryDb();
  d.prepare("INSERT OR IGNORE INTO external_refs (id, source, kind, external_id, title, created_at) VALUES (?, ?, ?, ?, '', ?)").run(
    `ext_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
    source,
    kind,
    externalId,
    Date.now(),
  );
  if (title) d.prepare("UPDATE external_refs SET title = ? WHERE source = ? AND kind = ? AND external_id = ?").run(title.slice(0, 200), source, kind, externalId);
  const row = d.prepare("SELECT * FROM external_refs WHERE source = ? AND kind = ? AND external_id = ?").get(source, kind, externalId) as unknown as Row;
  return toRef(row);
}

/** The policy's view of an external ref in one library: assetId is the public ref id, and `external` names the source's item. */
export const externalAssetRef = (ref: ExternalRef, libraryId: string): LibraryAssetRef => ({
  sourceId: ref.source,
  libraryId,
  assetId: ref.id,
  versionId: "",
  external: { refId: ref.id, kind: ref.kind, externalId: ref.externalId },
});

/** Whether the viewer may see the external ref in this library: its source's policies decide, and no policy means no. */
export const externalCanSee = (viewer: LibraryViewer, ref: ExternalRef, libraryId: string): Promise<boolean> =>
  canSee(viewer, externalAssetRef(ref, libraryId));

/**
 * Adds an external ref to a piece as its last item. Only a source calls this (a plug-in), never a request: the item has
 * no version, so the piece holds it until the source's policy lets the viewer see it. False when the piece already holds it.
 */
export function addExternalItem(pieceId: string, ref: ExternalRef, label: string | null = null): boolean {
  const d = libraryDb();
  if (d.prepare("SELECT 1 FROM piece_items WHERE piece_id = ? AND external_ref = ?").get(pieceId, ref.id)) return false;
  const last = (d.prepare("SELECT COALESCE(MAX(position), 0) AS p FROM piece_items WHERE piece_id = ?").get(pieceId) as { p: number }).p;
  d.prepare("INSERT INTO piece_items (id, piece_id, external_ref, label, position) VALUES (?, ?, ?, ?, ?)").run(
    `pci_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
    pieceId,
    ref.id,
    label,
    last + 1,
  );
  return true;
}
