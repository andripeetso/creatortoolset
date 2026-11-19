/**
 * Library clips carried by a drag, as the chat shows them: the Media Library's cards (LibraryPage) set this beside their
 * move type (pages/library/moves.ts DRAG), so a drop on the chat makes a chip each without asking the server. Only the
 * type list is readable while dragging; the cards themselves on the drop.
 */
export const CLIP_CARDS = "application/x-ct-clip-cards";

/** A library clip in a chat's box: the asset, the version the tools take (editor_create sources), its title and picture. */
export type DraggedClip = { id: string; versionId: string; title: string; thumbUrl?: string };

/** How many clips one message carries (editor_create takes up to 50 sources). */
export const MAX_CLIPS = 50;

/** The clips a drop carries, or none when it isn't the library's (a broken or foreign payload is none too). */
export function readClips(dt: Pick<DataTransfer, "getData">): DraggedClip[] {
  try {
    const all = JSON.parse(dt.getData(CLIP_CARDS) || "[]") as unknown;
    if (!Array.isArray(all)) return [];
    return all.flatMap((c) => {
      const x = (c ?? {}) as Record<string, unknown>;
      if (typeof x.id !== "string" || typeof x.versionId !== "string" || !x.versionId) return [];
      return [{ id: x.id, versionId: x.versionId, title: typeof x.title === "string" && x.title ? x.title : "Clip", ...(typeof x.thumbUrl === "string" ? { thumbUrl: x.thumbUrl } : {}) }];
    });
  } catch {
    return [];
  }
}

/** `more` added after `have`: one already there (same version) is left out, and no more than MAX_CLIPS in all. */
export const withClips = (have: DraggedClip[], more: DraggedClip[]): DraggedClip[] =>
  [...have, ...more.filter((c, i) => !have.some((h) => h.versionId === c.versionId) && more.findIndex((m) => m.versionId === c.versionId) === i)].slice(0, MAX_CLIPS);
