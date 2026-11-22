// A Media Library thumb or sprite is read from this Mac's cache when the Mac app keeps one (<html data-mac-local-thumbs>,
// apps/mac TitleBar.swift; ThumbCache.swift answers ctlocal://thumb/). Only the server's own thumb and sprite paths are
// turned; anything else, an older app, a browser or an `ext_` item is returned as it is.

/** The Mac app that keeps thumbs on this Mac answers ctlocal://thumb/ (mark 1 or more). */
const localThumbsMark = () =>
  typeof document === "undefined" ? 0 : Number(document.documentElement.dataset.macLocalThumbs) || 0;

const THUMB_PATH = /^\/api\/library\/media\/(?!ext_)([A-Za-z0-9_-]+)\/(thumb|sprite)(\?[A-Za-z0-9_=&.-]*)?$/;

/** The address a thumb or sprite of the server is read by in the Mac app, else the URL as it is. */
export function localThumb(url: string | undefined): string | undefined {
  if (!url || localThumbsMark() < 1 || !THUMB_PATH.test(url)) return url;
  const b64 = btoa(url).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `ctlocal://thumb/${b64}`;
}
