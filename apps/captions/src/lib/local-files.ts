// A recording's files reach the page as ctlocal://<recording>/<file>, served by the Mac app. Up to 0.14.0 the app's
// scheme stood still for good, and the whole app with it, when two of its requests overlapped: the editor played the
// video while it read the pointer log, and the app froze within a second. The app that takes requests at once says so
// (<html data-mac-local-files="2">, apps/mac TitleBar.swift), and there the files are used as they are. In an older
// app the page reads one file at a time, whole, and works from that copy, so no two requests ever overlap.
// From mark "3" the app also serves an edit's original video and sound files as ctlocal://media/<base64url of the
// path>, only from folders the user allowed: Settings → Folders folders allowed on this Mac (folderGrant) and the app's
// own open panel (askMediaFolder; apps/mac MediaFiles.swift).

import { WORDS, diskAway } from "@/lib/wording";

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

/** Whether the Mac app's granted folders hold every one of these paths (in one Unicode form: a name may be stored decomposed). */
export const allGranted = (paths: string[], folders: string[]) =>
  paths.every((p) => folders.some((f) => p.normalize("NFC").startsWith((f.endsWith("/") ? f : `${f}/`).normalize("NFC"))));

/** The deepest folder that holds every one of these paths ("/" at worst). */
export function commonFolder(paths: string[]): string {
  const parts = paths.map((p) => p.split("/").slice(0, -1));
  const out: string[] = [];
  for (let i = 0; parts.length && parts.every((q) => q[i] !== undefined && q[i] === parts[0][i]); i++) out.push(parts[0][i]);
  return out.join("/") || "/";
}

/** The Mac app's answer to one mediaAccess message (null outside the app, or when it fails). */
async function askMac(body: unknown): Promise<Record<string, unknown> | null> {
  const handler =
    typeof window === "undefined"
      ? undefined
      : (window as unknown as { webkit?: { messageHandlers?: { mediaAccess?: MediaAccess } } }).webkit?.messageHandlers
          ?.mediaAccess;
  if (!handler) return null;
  try {
    const answer = await handler.postMessage(body);
    return answer && typeof answer === "object" ? (answer as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function mediaAccess(body: unknown): Promise<string[]> {
  const granted = (await askMac(body))?.granted;
  return Array.isArray(granted) ? granted.filter((f): f is string => typeof f === "string") : [];
}

/** Where a path is for this Mac (apps/mac placesState): here, not there, its drive away, or not allowed yet. */
export type PathState = "here" | "not_here" | "disk_away" | "not_granted" | "needs_ok";
export type PathStates = { states: Record<string, PathState>; disks: Record<string, string> };

/**
 * The Mac app's word on each path, read in its Settings → Folders folders (never the page's own grant list). null outside
 * the app or from an app that doesn't answer it (before the location agent): the caller reads each file then (onDisk).
 */
export async function placesState(paths: string[]): Promise<PathStates | null> {
  const ask = async () => {
    const a = await askMac({ placesState: { paths } });
    if (!a || !a.states || typeof a.states !== "object") return null;
    return { states: a.states as PathStates["states"], disks: (a.disks && typeof a.disks === "object" ? a.disks : {}) as PathStates["disks"] };
  };
  const said = await ask();
  return said && Object.values(said.states).includes("needs_ok") && (await allowOwnFolders()) ? ask() : said;
}

let own: { at: number; p: Promise<boolean> } | null = null;
/**
 * The Settings → Folders folders his account set for this Mac are his own: they play here with no second OK (owner,
 * 2026-11-21: "local files on my Mac should always be played locally"). Calls at once share one ask; one that allowed
 * nothing (the Mac hasn't read the folder list yet) is asked again on the next call, one that allowed some not for 30 s.
 */
function allowOwnFolders(): Promise<boolean> {
  const me = typeof document === "undefined" ? undefined : document.documentElement.dataset.macDevice;
  if (!me) return Promise.resolve(false);
  if (own && Date.now() - own.at < 30_000) return own.p;
  const p = (async () => {
    const r = await fetch("/api/devices/storage").catch(() => null);
    const view = r?.ok ? ((await r.json().catch(() => null)) as { folders?: { id: string; origin: { host: string; path: string } }[] } | null) : null;
    let any = false;
    for (const f of view?.folders ?? []) if (f.origin?.host === me && (await folderGrant(f.origin.path, f.id))) any = true;
    return any;
  })();
  const mine = (own = { at: Date.now(), p });
  void p.then((any) => { if (!any && own === mine) own = null; });
  return p;
}

/** "Allow on this Mac", pressed for a Settings → Folders folder (`folder` its id, `path` its path on this Mac). */
export async function folderGrant(path: string, folder: string): Promise<boolean> {
  return (await askMac({ folderGrant: { path, folder } }))?.granted === true;
}

/** A Settings → Folders folder was added: the Mac app's location agent reads the folder list again now (nothing outside the app). */
export const foldersChanged = () => void askMac({ look: true });

/** The line for a file this Mac said doesn't play here: "<drive> isn't connected", "Needs your OK"; none for not there. */
export function pathLine(a: { state: PathState; disk?: string } | null | undefined): string | undefined {
  if (a?.state === "disk_away") return diskAway(a.disk ?? "The drive");
  if (a?.state === "needs_ok" || a?.state === "not_granted") return WORDS.needsOk;
  return undefined;
}

/**
 * Why a ctlocal://media file didn't play, from the Mac app's answer to a one-byte read: 409 {state:"disk_away", disk}
 * for a drive that isn't connected, 403 for a folder not allowed, else not there (a network failure says nothing).
 */
export async function localFileState(url: string): Promise<{ state: PathState; disk?: string } | null> {
  try {
    const r = await fetch(url, { headers: { Range: "bytes=0-0" } });
    if (r.status === 200 || r.status === 206) return void r.body?.cancel(), { state: "here" };
    if (r.status === 409) {
      const b = (await r.json().catch(() => null)) as { state?: string; disk?: string } | null;
      if (b?.state === "disk_away" && b.disk) return { state: "disk_away", disk: b.disk };
    }
    return { state: r.status === 403 ? "not_granted" : "not_here" };
  } catch {
    return null;
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
