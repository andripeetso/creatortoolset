// An edit's original files on this computer, for playing its timeline edits from them (components/ReviewEdits.tsx, the
// editor): the Mac app says of each path where the timeline (or a plug-in) says it is whether it is here, its drive away,
// or its Settings → Folders folder not allowed on this Mac yet (placesState; never the page's own grant list).
// When they aren't there (another drive, another computer), "Find the original files": the person picks the folder they
// are in now, and each missing file is looked for under it by the end of its path; the first one found gives the
// folder change for the rest. What was found is kept per version in this browser, so it isn't asked again.

import { applyMove, derivedMove, type PathMove } from "@contracts/places";
import type { StorageFolder, StorageView } from "@contracts/storage";
import { allGranted, askMediaFolder, commonFolder, folderGrant, listMediaFolders, localMediaUrl, pathLine, placesState, type PathState } from "@/lib/local-files";
import { thisMacDevice } from "@/lib/providers";
import { WORDS } from "@/lib/wording";

export type Exists = (path: string) => Promise<boolean>;

/** Whether the Mac app plays this file: it answers a one-byte read (403 outside a granted folder, 404 missing, 415 not media). */
export const onDisk: Exists = async (path) => {
  try {
    const r = await fetch(localMediaUrl(path), { headers: { Range: "bytes=0-0" } });
    void r.body?.cancel();
    return r.status === 206 || r.status === 200;
  } catch {
    return false;
  }
};

/** Where a file may be under `folder`: the ends of its path there, longest first (its sub-folders kept, down to its name alone). */
export function candidates(path: string, folder: string): string[] {
  const parts = path.split("/").filter(Boolean);
  const root = folder.replace(/\/+$/, "");
  return parts.map((_, i) => `${root}/${parts.slice(i).join("/")}`);
}

/** Missing files found under `folder`: { [path]: where it is }. A folder change that found one goes first for the next. */
export async function relink(missing: string[], folder: string, exists: Exists): Promise<Record<string, string>> {
  const found: Record<string, string> = {};
  const moves: PathMove[] = [];
  for (const p of missing) {
    const tries = [...moves.flatMap((m) => applyMove(p, m) ?? []), ...candidates(p, folder)];
    for (const c of new Set(tries)) {
      if (!(await exists(c))) continue;
      found[p] = c;
      const m = derivedMove(p, c);
      if (m) moves.unshift(m);
      break;
    }
  }
  return found;
}

/** An edit's files here: `paths` as the timeline says, `found` the ones the Mac app plays (where they are now). */
export interface Originals {
  paths: Record<string, string>;
  found: Record<string, string>;
  /** the folders the Mac app lets the page play from (its open panel's; Settings → Folders folders are asked by path) */
  folders: string[];
  /** what this Mac said of each source key not found: its drive away (`disk`), not allowed yet, or not there */
  away?: Record<string, { state: PathState; disk?: string }>;
  /** "Find the original files" was pressed */
  tried: boolean;
}

const storeKey = (store: string) => `ct.review.relink.${store}`;
const stored = (store: string): Record<string, string> => {
  try {
    const v = JSON.parse(localStorage.getItem(storeKey(store)) ?? "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
};

/** Each source key's file where it plays from here, among `paths` (a source key to its path): the stored finds laid on.
 *  The Mac app is asked for all of them at once; one that doesn't answer that (an older app) has each file read, and one
 *  outside its open-panel folders (`folders`) is "not allowed" there (its gate refuses those). */
async function look(paths: Record<string, string>, moved: Record<string, string>, exists: Exists, folders: string[]) {
  const at = Object.fromEntries(Object.entries(paths).map(([s, p]) => [s, typeof moved[p] === "string" ? moved[p] : p]));
  const said = await placesState([...new Set(Object.values(at))]);
  const found: Record<string, string> = {};
  const away: NonNullable<Originals["away"]> = {};
  for (const [s, p] of Object.entries(at)) {
    const state = said ? (said.states[p] ?? "not_here") : (await exists(p)) ? "here" : allGranted([p], folders) ? "not_here" : "not_granted";
    if (state === "here") found[s] = p;
    else away[s] = { state, ...(said?.disks[p] ? { disk: said.disks[p] } : {}) };
  }
  return { found, away };
}

/** The edit's files as last found in this browser (`store` = the version's own key). */
export async function openOriginals(paths: Record<string, string>, store: string, exists = onDisk): Promise<Originals> {
  const folders = await listMediaFolders();
  return { paths, ...(await look(paths, stored(store), exists, folders)), folders, tried: false };
}

/** Why some of an edit's files don't play here, when this Mac said: a drive that isn't connected first, then "Needs your OK".
 *  null: nothing said (the reach text, "Find the original files", is the line then). */
export function awayLine(o: Originals): string | null {
  const lines = Object.values(o.away ?? {}).flatMap((a) => pathLine(a) ?? []);
  return lines.find((l) => l !== WORDS.needsOk) ?? lines[0] ?? null;
}

/** One source's line when this Mac said why it doesn't play here, for the player's frame (NleFile.why). */
export const whyOf = (o: Originals | null, src: string) => pathLine(o?.away?.[src]);

/** The Settings → Folders folders on this Mac that hold a file waiting for an OK (empty: none, or outside the app). */
export async function foldersToAllow(o: Originals): Promise<StorageFolder[]> {
  const waiting = Object.entries(o.away ?? {}).filter(([, a]) => a.state === "needs_ok" || a.state === "not_granted").map(([s]) => o.found[s] ?? o.paths[s]);
  if (!waiting.length) return [];
  const r = await fetch("/api/devices/storage").catch(() => null);
  const view = r?.ok ? ((await r.json().catch(() => null)) as StorageView | null) : null;
  const me = thisMacDevice();
  return (view?.folders ?? []).filter((f) => (!me || f.origin.host === me) && waiting.some((p) => allGranted([p], [f.origin.path])));
}

/** "Allow on this Mac", pressed: each folder allowed (the Mac app's own answer), then the files looked at again. */
export async function allowFolders(o: Originals, folders: StorageFolder[], store: string, exists = onDisk): Promise<Originals> {
  for (const f of folders) await folderGrant(f.origin.path, f.id);
  return { ...o, ...(await look(o.paths, stored(store), exists, o.folders)) };
}

/**
 * "Find the original files": the Mac app's open panel at the timeline's folder; the person allows that folder or the one
 * the files are in now. What isn't where the timeline says is looked for under each newly allowed folder.
 */
export async function findOriginals(o: Originals, store: string, exists = onDisk): Promise<Originals> {
  const folders = await askMediaFolder(commonFolder(Object.values(o.paths)));
  if (!folders.length) return o; // cancelled
  const moved = stored(store);
  const { found, away } = await look(o.paths, moved, exists, folders);
  // under the folder just allowed; one allowed before when it was picked again
  const fresh = folders.filter((f) => !o.folders.includes(f));
  for (const folder of fresh.length ? fresh : folders) {
    const missing = Object.keys(o.paths).filter((s) => !found[s]);
    if (!missing.length) break;
    const got = await relink(missing.map((s) => o.paths[s]), folder, exists);
    for (const s of missing) if (got[o.paths[s]]) (found[s] = got[o.paths[s]]), delete away[s];
  }
  for (const [s, p] of Object.entries(found)) if (p !== o.paths[s]) moved[o.paths[s]] = p;
  try {
    localStorage.setItem(storeKey(store), JSON.stringify(moved));
  } catch {
    // private window: asked again next time
  }
  return { paths: o.paths, found, away, folders, tried: true };
}
