import type { Collection, ReorganizeWay } from "@contracts/library";
import { bodyOf } from "@/lib/body";

/** The page's own calls to api/library/collections.ts that lib/library.ts has no use for elsewhere. */

async function json<T>(r: Response): Promise<T> {
  const body = (await bodyOf(r)) as T & { error?: string };
  if (!r.ok) throw new Error(body.error ?? `Request failed (${r.status})`);
  return body;
}

/** The tabs' counts: clips sorted A-roll and B-roll, and photos. */
export type TabCounts = { a: number; b: number; image: number; video: number };
export const tabCounts = (libraryId: string) => fetch(`/api/library/${libraryId}/counts`).then((r) => json<TabCounts>(r));

/** A folder deleted moments ago, back as it was (Undo). */
export const restoreFolder = (libraryId: string, collectionId: string) =>
  fetch(`/api/library/${libraryId}/collections/${collectionId}/restore`, { method: "POST" }).then((r) => json<Collection>(r));

const send = <T,>(url: string, method: string, body: unknown) =>
  fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => json<T>(r));

/** What goes in a plain folder (a smart folder, api/library/smart.ts); null stops it sorting itself. */
export const setFolderRule = (libraryId: string, collectionId: string, rule: string | null) =>
  send<Collection>(`/api/library/${libraryId}/collections/${collectionId}`, "PATCH", { rule });

/** Reorganize: the AI's ways to sort the library (nothing is made yet). */
export const suggestWays = (libraryId: string) => send<{ ways: ReorganizeWay[]; about: boolean }>(`/api/library/${libraryId}/collections/suggest`, "POST", {});
