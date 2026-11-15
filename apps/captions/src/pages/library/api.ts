import type { Collection } from "@contracts/library";

/** The page's own calls to api/library/collections.ts that lib/library.ts has no use for elsewhere. */

async function json<T>(r: Response): Promise<T> {
  const body = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw new Error(body.error ?? `Request failed (${r.status})`);
  return body;
}

/** The tabs' counts: clips sorted A-roll and B-roll, and photos. */
export type TabCounts = { a: number; b: number; image: number };
export const tabCounts = (libraryId: string) => fetch(`/api/library/${libraryId}/counts`).then((r) => json<TabCounts>(r));

/** A folder deleted moments ago, back as it was (Undo). */
export const restoreFolder = (libraryId: string, collectionId: string) =>
  fetch(`/api/library/${libraryId}/collections/${collectionId}/restore`, { method: "POST" }).then((r) => json<Collection>(r));
