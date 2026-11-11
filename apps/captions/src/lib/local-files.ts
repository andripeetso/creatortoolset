// A recording's files reach the page as ctlocal://<recording>/<file>, served by the Mac app. Up to 0.14.0 the app's
// scheme stood still for good, and the whole app with it, when two of its requests overlapped: the editor played the
// video while it read the pointer log, and the app froze within a second. The app that takes requests at once says so
// (<html data-mac-local-files="2">, apps/mac TitleBar.swift), and there the files are used as they are. In an older
// app the page reads one file at a time, whole, and works from that copy, so no two requests ever overlap.

/** This app's ctlocal:// takes several requests at once. */
export const localFilesOverlap = () =>
  typeof document !== "undefined" && document.documentElement.dataset.macLocalFiles === "2";

let line: Promise<unknown> = Promise.resolve();

/** One ctlocal file read whole. It starts only when every read asked for before it has ended. */
export function readLocalFile(url: string): Promise<Blob> {
  const read = line.then(async () => {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${url}: ${r.status}`);
    return r.blob();
  });
  line = read.catch(() => undefined);
  return read;
}

/**
 * What an <img> or a <video> can take for a ctlocal file: the file's own URL in an app whose scheme takes it, else a
 * copy read in its turn (`blob` is that copy). `release` lets the copy go.
 */
export async function localFileUrl(url: string): Promise<{ url: string; blob: Blob | null; release: () => void }> {
  if (localFilesOverlap()) return { url, blob: null, release: () => {} };
  const blob = await readLocalFile(url);
  const copy = URL.createObjectURL(blob);
  return { url: copy, blob, release: () => URL.revokeObjectURL(copy) };
}
