import type { AssetPage } from "@contracts/library";
import { listAssets } from "./library";
import { localThumb } from "./local-thumbs";

/**
 * The Mac app keeps the Media Library's pictures on this Mac (apps/mac ThumbCache.swift), but only once one has been
 * drawn. This fills it ahead: every clip's thumbnail, a few at a time while the window is idle, once per library per
 * window, so a view opened later paints its pictures from this Mac even while the server is slow. A picture already
 * kept is read from this Mac's disk, so a second pass asks the server for nothing. Outside the Mac app it does nothing.
 */

const PAGE = 200;
const AT_ONCE = 3;
const warmed = new Set<string>();

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

/** Warms this Mac's copy of every thumbnail in a library. Returns how many pictures it asked for. */
export async function warmThumbs(
  libraryId: string,
  o: { list?: (cursor?: string) => Promise<AssetPage>; load?: (src: string) => Promise<void> } = {},
): Promise<number> {
  if (warmed.has(libraryId) || localThumb("/api/library/media/x/thumb") === "/api/library/media/x/thumb") return 0;
  warmed.add(libraryId);
  const list = o.list ?? ((cursor?: string) => listAssets(libraryId, { limit: PAGE, sort: "new", ...(cursor ? { cursor } : {}) }));
  const load = o.load ?? loadPicture;
  let asked = 0;
  try {
    let cursor: string | undefined;
    do {
      await idle();
      const page = await list(cursor);
      const srcs = page.items.flatMap((a) => (a.thumbUrl ? [localThumb(a.thumbUrl)!] : []));
      for (let i = 0; i < srcs.length; i += AT_ONCE) {
        await Promise.all(srcs.slice(i, i + AT_ONCE).map(load));
        asked += Math.min(AT_ONCE, srcs.length - i);
      }
      cursor = page.next;
    } while (cursor);
  } catch {
    warmed.delete(libraryId); // the next window or visit tries again
  }
  return asked;
}
