// A recording's files reach the page as ctlocal://<recording>/<file>, served by the Mac app. Up to 0.14.0 the app's
// scheme stood still for good, and the whole app with it, when two of its requests overlapped: the editor played the
// video while it read the pointer log, and the app froze within a second. The app that takes requests at once says so
// (<html data-mac-local-files="2">, apps/mac TitleBar.swift), and there the files are used as they are. In an older
// app the page reads one file at a time, whole, and works from that copy, so no two requests ever overlap.
// From mark "3" the app also serves an edit's original video and sound files as ctlocal://media/<base64url of the
// path>, only from folders the user granted in the app's own open panel (askMediaFolder; apps/mac MediaFiles.swift).

const localFilesMark = () =>
  typeof document === "undefined" ? 0 : Number(document.documentElement.dataset.macLocalFiles) || 0;

/** This app's ctlocal:// takes several requests at once. */
export const localFilesOverlap = () => localFilesMark() >= 2;

/** This app serves original media files from granted folders (localMediaUrl). */
export const localMediaFiles = () => localFilesMark() >= 3;

/** The ctlocal:// URL of an original media file at an absolute path on this Mac. */
export function localMediaUrl(path: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(path)) binary += String.fromCharCode(byte);
  const b64 = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `ctlocal://media/${b64}`;
}

type MediaAccess = { postMessage: (body: unknown) => Promise<unknown> };

/**
 * Asks the Mac app to let the page play original files from `folder`: it shows its own open panel there, and the user
 * may pick that folder or a higher one. The granted folders, or [] when cancelled or outside the app.
 */
export const askMediaFolder = (folder: string): Promise<string[]> => mediaAccess({ ask: folder });

/** The folders the Mac app lets the page play original files from ([] outside the app). */
export const listMediaFolders = (): Promise<string[]> => mediaAccess({ list: true });

/** Whether the Mac app's granted folders hold every one of these paths. */
export const allGranted = (paths: string[], folders: string[]) =>
  paths.every((p) => folders.some((f) => p.startsWith(f.endsWith("/") ? f : `${f}/`)));

/** The deepest folder that holds every one of these paths ("/" at worst). */
export function commonFolder(paths: string[]): string {
  const parts = paths.map((p) => p.split("/").slice(0, -1));
  const out: string[] = [];
  for (let i = 0; parts.length && parts.every((q) => q[i] !== undefined && q[i] === parts[0][i]); i++) out.push(parts[0][i]);
  return out.join("/") || "/";
}

async function mediaAccess(body: unknown): Promise<string[]> {
  const handler =
    typeof window === "undefined"
      ? undefined
      : (window as unknown as { webkit?: { messageHandlers?: { mediaAccess?: MediaAccess } } }).webkit?.messageHandlers
          ?.mediaAccess;
  if (!handler) return [];
  try {
    const answer = (await handler.postMessage(body)) as { granted?: unknown } | null;
    return Array.isArray(answer?.granted) ? answer.granted.filter((f): f is string => typeof f === "string") : [];
  } catch {
    return [];
  }
}

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
