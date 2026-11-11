import type { Collection } from "@contracts/library";
import { folderOptions, folderPath } from "@/components/browse/browse";
import { byName, matches } from "@/components/browse/views";

/**
 * The Media Library's folders are its collections (api/library/collections.ts): a plain one holds clips, a saved
 * search (kind "smart") runs its query when opened. Finals is its own tool and is left out before these run.
 */

/** A folder clips go in: a plain collection. A saved search takes none (dropping on it would change the clip itself). */
export const holdsClips = (c: Collection) => c.kind === "manual";

/** The page's address for a folder (null: the top). */
export const folderTo = (id: string | null) => (id ? `/library?f=${encodeURIComponent(id)}` : "/library");

/**
 * The folders on screen in the folder `open` (null: the top): the ones in it, or while searching every one below it whose
 * name matches. Folders first, then saved searches, each A to Z. A folder whose parent is gone shows at the top.
 */
export function foldersAt(all: Collection[], open: string | null, q: string): Collection[] {
  const ids = new Set(all.map((f) => f.id));
  const parentOf = (f: Collection) => (f.parentId && ids.has(f.parentId) ? f.parentId : null);
  const here = q.trim()
    ? all.filter((f) => f.id !== open && matches(q, f.name) && (!open || folderPath(all, f.id).some((p) => p.id === open)))
    : all.filter((f) => parentOf(f) === open);
  return here.sort((a, b) => Number(a.kind === "smart") - Number(b.kind === "smart") || byName(a, b));
}

/** Clips moved from the folder `from` (null: the top) to `to`: put in `to`, then taken out of `from`. Nothing for the same place. */
export function moveSteps(from: string | null, to: string | null): { add?: string; remove?: string } {
  if (from === to) return {};
  return { ...(to ? { add: to } : {}), ...(from ? { remove: from } : {}) };
}

/** "Move to": the top (from inside a folder), then every folder clips go in, each under its parent; not the one they are in. */
export function moveOptions(all: Collection[], from: string | null): { id: string | null; name: string; depth: number }[] {
  return [
    ...(from ? [{ id: null, name: "Top level", depth: 0 }] : []),
    ...folderOptions(all.filter(holdsClips))
      .filter((f) => f.id !== from)
      .map((f) => ({ id: f.id, name: f.name, depth: f.depth })),
  ];
}

/** The way back up above the clips: the open folder and the ones above it, or the Trash. */
export const trailOf = (all: Collection[], open: string | null, trash: boolean): { id: string; name: string }[] =>
  trash ? [{ id: "trash", name: "Trash" }] : folderPath(all, open);
