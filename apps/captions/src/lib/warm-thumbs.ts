import type { AssetPage } from "@contracts/library";
import { listAssets } from "./library";
import { localThumb, localThumbsMark } from "./local-thumbs";

/**
 * The Mac app keeps the Media Library's pictures on this Mac (apps/mac ThumbCache.swift), but only once one has been
 * drawn. This fills it ahead: the newest clips' thumbnails, a few at a time while the window is idle, once per library
 * per window, so a view opened later paints its pictures from this Mac even while the server is slow. A picture already
 * kept is read from this Mac's disk, so a second pass asks the server for nothing. Outside the Mac app it does nothing.
 */

const PAGE = 200;
const AT_ONCE = 3;
/** About half of ThumbCache's 1 GB at ~90 KB a picture: more would push out the newest clips' pictures (it drops the least recently used) */
const MAX = 5000;
/** After a whole pass, only the newest page for this long: new clips are the ones a person opens next */
const FULL_EVERY_MS = 24 * 3600_000;
const warmed = new Set<string>();

const fullKey = (libraryId: string) => `ct-warm-thumbs:${libraryId}`;
function lastFull(libraryId: string): number {
  try {
    return Number(localStorage.getItem(fullKey(libraryId))) || 0;
  } catch {
    return 0;
  }
}
function markFull(libraryId: string, at: number) {
  try {
    localStorage.setItem(fullKey(libraryId), String(at));
  } catch {
    /* a locked-down window: the next one does the whole pass again */
  }
}

/** Loads one picture address and resolves when it has loaded or failed (the Mac app keeps it on the way). */
function loadPicture(src: string): Promise<void> {
  return new Promise((resolve) => {
    const img = new Image();
    img.decoding = "async";
    img.onload = img.onerror = () => resolve();
    img.src = src;
  });
}

const idle = () =>
  new Promise<void>((resolve) => (typeof requestIdleCallback === "function" ? requestIdleCallback(() => resolve(), { timeout: 2000 }) : setTimeout(resolve, 200)));

/** Warms this Mac's copy of a library's thumbnails, newest first. Returns how many pictures it asked for. */
export async function warmThumbs(
  libraryId: string,
  o: { list?: (cursor?: string) => Promise<AssetPage>; load?: (src: string) => Promise<void>; now?: number } = {},
): Promise<number> {
  if (warmed.has(libraryId) || localThumbsMark() < 1) return 0;
  warmed.add(libraryId);
  const list = o.list ?? ((cursor?: string) => listAssets(libraryId, { limit: PAGE, sort: "new", ...(cursor ? { cursor } : {}) }));
  const load = o.load ?? loadPicture;
  const now = o.now ?? Date.now();
  const whole = now - lastFull(libraryId) > FULL_EVERY_MS;
  let asked = 0;
  try {
    let cursor: string | undefined;
    do {
      await idle();
      const page = await list(cursor);
      const srcs = page.items.flatMap((a) => (a.thumbUrl ? [localThumb(a.thumbUrl)!] : [])).slice(0, MAX - asked);
      for (let i = 0; i < srcs.length; i += AT_ONCE) {
        const batch = srcs.slice(i, i + AT_ONCE);
        await Promise.all(batch.map(load));
        asked += batch.length;
      }
      cursor = whole && asked < MAX ? page.next : undefined;
    } while (cursor);
    if (whole) markFull(libraryId, now);
  } catch {
    warmed.delete(libraryId); // the next window or visit tries again
  }
  return asked;
}
