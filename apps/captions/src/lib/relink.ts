// An edit's original files on this computer, for playing its timeline edits from them (components/ReviewEdits.tsx):
// each file looked for where the timeline (or a plug-in) says, in the folders the Mac app lets the page play from.
// When they aren't there (another drive, another computer), "Find the original files": the person picks the folder they
// are in now, and each missing file is looked for under it by the end of its path; the first one found gives the
// folder change for the rest. What was found is kept per version in this browser, so it isn't asked again.

import { allGranted, askMediaFolder, commonFolder, listMediaFolders, localMediaUrl } from "@/lib/local-files";

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
  const moves: [string, string][] = [];
  for (const p of missing) {
    const tries = [...moves.filter(([from]) => p.startsWith(from)).map(([from, to]) => to + p.slice(from.length)), ...candidates(p, folder)];
    for (const c of new Set(tries)) {
      if (!(await exists(c))) continue;
      found[p] = c;
      // the part both end with, from a "/": the rest of each is the folder change
      let k = 0;
      while (k < Math.min(p.length, c.length) && p[p.length - 1 - k] === c[c.length - 1 - k]) k++;
      const cut = p.slice(p.length - k).indexOf("/");
      if (cut >= 0) moves.unshift([p.slice(0, p.length - k + cut), c.slice(0, c.length - k + cut)]);
      break;
    }
  }
  return found;
}

/** An edit's files here: `paths` as the timeline says, `found` the ones the Mac app plays (where they are now). */
export interface Originals {
  paths: Record<string, string>;
  found: Record<string, string>;
  /** the folders the Mac app lets the page play from */
  folders: string[];
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

/** Each source key's file where it plays from here, among `paths` (a source key to its path): the stored finds laid on. */
async function look(paths: Record<string, string>, folders: string[], moved: Record<string, string>, exists: Exists) {
  const found: Record<string, string> = {};
  for (const [src, p] of Object.entries(paths)) {
    const at = typeof moved[p] === "string" ? moved[p] : p;
    if (allGranted([at], folders) && (await exists(at))) found[src] = at;
  }
  return found;
}

/** The edit's files as last found in this browser (`store` = the version's own key). */
export async function openOriginals(paths: Record<string, string>, store: string, exists = onDisk): Promise<Originals> {
  const folders = await listMediaFolders();
  return { paths, found: await look(paths, folders, stored(store), exists), folders, tried: false };
}

/**
 * "Find the original files": the Mac app's open panel at the timeline's folder; the person allows that folder or the one
 * the files are in now. What isn't where the timeline says is looked for under each newly allowed folder.
 */
export async function findOriginals(o: Originals, store: string, exists = onDisk): Promise<Originals> {
  const folders = await askMediaFolder(commonFolder(Object.values(o.paths)));
  if (!folders.length) return o; // cancelled
  const moved = stored(store);
  const found = await look(o.paths, folders, moved, exists);
  for (const folder of folders.filter((f) => !o.folders.includes(f))) {
    const missing = Object.keys(o.paths).filter((s) => !found[s]);
    if (!missing.length) break;
    const got = await relink(missing.map((s) => o.paths[s]), folder, exists);
    for (const s of missing) if (got[o.paths[s]]) found[s] = got[o.paths[s]];
  }
  for (const [s, p] of Object.entries(found)) if (p !== o.paths[s]) moved[o.paths[s]] = p;
  try {
    localStorage.setItem(storeKey(store), JSON.stringify(moved));
  } catch {
    // private window: asked again next time
  }
  return { paths: o.paths, found, folders, tried: true };
}
