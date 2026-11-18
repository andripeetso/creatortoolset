import { readFile, realpath, statfs } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { EVERY_WORKSPACE, LIBRARY_NAME, okFolderPath, sourcesOf, STORAGE_SCHEMA, THIS_COMPUTER, UPLOAD_RELAY_IDS, type Disk, type FolderMount, type StorageFolder, type StorageReport, type StorageState, type UploadRelayId, type UploadRelayView } from "../../contracts/storage";
import { isWindowsPath, joinRoot, rootKey } from "../../contracts/places";

/** The Library's folder for a chosen disk folder: "/" or "~" is the home folder, trailing slashes do not count. */
export function libraryPath(disk: string): string {
  return `${disk.replace(/\/+$/, "") || "~"}/${LIBRARY_NAME}`;
}

/** An account's storage list on the server: $DATA_DIR/storage/<user>.json (usernames are [a-z0-9_-] only). */
export function storageFilePath(dataDir: string, user: string): string {
  return path.join(dataDir, "storage", `${user}.json`);
}

/** The stored list, read tolerantly: a file that is not JSON (or has no folder list) counts as empty, and is logged. */
export function parseStorageFile(raw: string): StorageState {
  try {
    const v = JSON.parse(raw) as Partial<StorageState> | null;
    return { ...(typeof v?.schemaVersion === "number" ? { schemaVersion: v.schemaVersion } : {}), folders: Array.isArray(v?.folders) ? mediaFolders(v.folders) : [] };
  } catch (e) {
    console.warn(`[devices-storage] storage file unreadable, treated as empty: ${e instanceof Error ? e.message : e}`);
    return { folders: [] };
  }
}

/** A folder's workspaces, or null for every workspace (EVERY_WORKSPACE). One from before (no stamp) is its own "". */
const placesOf = (f: StorageFolder): string[] | null => (f.workspace === EVERY_WORKSPACE ? null : (f.workspaces ?? [f.workspace ?? ""]));

/**
 * The one Media list (owner, 2026-11-17: no Music folder in Settings → Folders): a "music" folder from before is a Media
 * folder, and a Media folder inside another one of the same computer that is in all of its workspaces is left out, the
 * outer one already brings its files into the Media Library. `places`: a folder's workspaces, null for every workspace.
 */
export function mediaFolders(folders: StorageFolder[], places = placesOf): StorageFolder[] {
  const all = folders.map((f) => ((f?.role as string) === "music" ? { ...f, role: "footage" as const } : f));
  const covers = (o: StorageFolder, f: StorageFolder) => {
    const outer = places(o);
    const inner = places(f);
    return !outer || (!!inner && inner.every((w) => outer.includes(w)));
  };
  return all.filter((f) => f?.role !== "footage" || !all.some((o) => o !== f && o.role === "footage" && o.origin?.host === f.origin?.host && !!inside(f.origin.path, o.origin.path) && covers(o, f)));
}

/**
 * A storage list moved to schema 2 (contracts/storage.ts STORAGE_SCHEMA): every computer is a device id now, the
 * "this-computer" folders the computer the server runs on (`thisDevice`; kept as they were when it has none: a server with
 * no paired computer of its own reads them itself) and ids of computers paired again resolved
 * (`resolve`, whereis.ts resolveDevice). Two entries for one path in two workspaces stay two (a folder in several
 * workspaces is one entry with `workspaces` from Settings on). `changed` says whether the file needs writing.
 */
export function migrateStorage(st: StorageState, thisDevice: string | undefined, resolve: (id: string) => string = (id) => id): { st: StorageState; changed: boolean } {
  const host = (h: string) => (h === THIS_COMPUTER ? (thisDevice ?? h) : resolve(h));
  const out: StorageFolder[] = [];
  let changed = st.schemaVersion !== STORAGE_SCHEMA;
  for (const f of st.folders) {
    const h = host(f.origin.host);
    const reach = Object.fromEntries(Object.entries(f.reach ?? {}).map(([k, v]) => [resolve(k), v]));
    const g: StorageFolder = h === f.origin.host && Object.keys(reach).every((k) => k in (f.reach ?? {})) ? f : { ...f, origin: { ...f.origin, host: h }, reach };
    if (g !== f) changed = true;
    out.push(g);
  }
  return { st: { ...st, schemaVersion: STORAGE_SCHEMA, folders: out }, changed };
}

/** The disk a path is on, read by the server (statfs). A path that does not exist yet (a Library not made) is read at its
 *  nearest parent that does, so `path` is a folder on that drive. "~" is the server's home folder. */
async function diskAt(p: string): Promise<Disk | null> {
  let at = p === "~" || p.startsWith("~/") ? path.join(homedir(), p.slice(1)) : p;
  for (;;) {
    try {
      const s = await statfs(at);
      return { name: at === "/" ? "System disk" : path.basename(at), path: at, freeGb: (s.bavail * s.bsize) / 1e9, totalGb: (s.blocks * s.bsize) / 1e9 };
    } catch {
      const up = path.dirname(at);
      if (up === at) return null;
      at = up;
    }
  }
}

/** The disks of the machine the server runs on: the system disk ("/", the one "~" folders sit on), and the disk
 *  `libraryPath` sits on when that is another one. Empty if unreadable. */
export async function localDisks(libraryPath?: string): Promise<Disk[]> {
  const system = await diskAt("/");
  if (!system) return [];
  const lib = libraryPath ? await diskAt(libraryPath) : null;
  // the same volume as the system disk (a Library on "/" or in "~" on the same container) is one row
  const other = lib && (lib.freeGb !== system.freeGb || lib.totalGb !== system.totalGb) ? [lib] : [];
  return [system, ...other];
}

/** A folder path without trailing slashes ("/" stays "/"). */
const norm = (p: string) => p.replace(/(.)\/+$/, "$1");

/** What of `p` is inside folder `dir`, "/"-separated ("" for the folder itself); null when p is not in it. On a "/"
 *  boundary: "/Volumes/TEAM2" is not inside "/Volumes/TEAM". */
export function inside(p: string, dir: string): string | null {
  const win = isWindowsPath(dir);
  const fold = (x: string) => (win ? x.replace(/\\/g, "/").toLowerCase() : x);
  const d = fold(win ? dir.replace(/[\\/]+$/, "") : norm(dir));
  const a = fold(p);
  if (a === d) return "";
  const pre = d.endsWith("/") ? d : `${d}/`;
  return a.startsWith(pre) ? (win ? p.replace(/\\/g, "/") : p).slice(pre.length) : null;
}


/** Where `host` has `folder`: on its own computer the path it reads it at (inside the container a helper runs in, mountPath;
 *  else the path it was made at), else where that computer found its marker. */
export const pathOn = (folder: StorageFolder, host: string): string | undefined =>
  folder.origin.host === host ? (folder.mountPath ?? folder.origin.path) : folder.reach[host]?.path;

/** The paths a folder has on its own computer: the one it was made at and, for a helper in a container, the one inside it. */
const ownPaths = (folder: StorageFolder): string[] => [folder.origin.path, ...(folder.mountPath && folder.mountPath !== folder.origin.path ? [folder.mountPath] : [])];

export interface FolderMatch { folder: StorageFolder; prefix: string; rest: string }

/** The footage folder a path is inside: the longest of its paths that holds it (only `from`'s, when given: the computer
 *  the path is on). "~/…" never holds an absolute path (they are different computers' paths). */
export function folderFor(p: string, folders: StorageFolder[], from?: string): FolderMatch | null {
  let best: FolderMatch | null = null;
  for (const folder of sourcesOf(folders)) {
    if (folder.role !== "footage") continue;
    const prefixes = from ? (from === folder.origin.host ? ownPaths(folder) : [folder.reach[from]?.path]) : [...ownPaths(folder), ...Object.values(folder.reach).map((r) => r.path)];
    for (const prefix of prefixes) {
      const rest = prefix === undefined ? null : inside(p, prefix);
      if (rest !== null && (!best || prefix!.length > best.prefix.length)) best = { folder, prefix: norm(prefix!), rest };
    }
  }
  return best;
}

/**
 * The one rewrite of a path for another computer: `p` (on computer `from`, or on any that has the folder) as computer
 * `to` reaches it, by the folder it is in: "/Volumes/Footage/a.mp4" on a Mac is "/mnt/footage/a.mp4" on a Linux computer
 * that found the same folder at /mnt/footage, or "Z:\a.mp4" on Windows. Null when `p` is in no footage folder or `to` has
 * not found that folder. Every path that goes to a device goes through here.
 */
export function hostPath(p: string, folders: StorageFolder[], to: string, from?: string): string | null {
  const m = folderFor(p, folders, from);
  const dir = m ? pathOn(m.folder, to) : undefined;
  return m && dir !== undefined ? joinRoot(dir, m.rest) : null;
}

/** The share a path is on, from its computer's reported disks (the deepest network disk that holds it); undefined for a
 *  disk of that computer's own, or a share it did not say the name of. */
export function mountOf(p: string, disks: Disk[] = []): FolderMount | undefined {
  let best: { d: Disk; sub: string } | undefined;
  for (const d of disks) {
    const sub = d.network ? inside(p, d.path) : null;
    if (sub !== null && (!best || d.path.length > best.d.path.length)) best = { d, sub };
  }
  const d = best?.d;
  return d?.fs && d.server && d.share ? { fs: d.fs, server: d.server, share: d.share, sub: best!.sub } : undefined;
}

/** The root a path is on (places.ts rootKey: a share, or a volume by its id), from its computer's disks: the deepest disk
 *  that holds it, and the path inside it ("/"-separated, NFC). Undefined when that disk names no root. */
export function rootAt(p: string, disks: Disk[] = []): { key: string; rel: string; disk: Disk } | undefined {
  let best: { d: Disk; rel: string } | undefined;
  for (const d of disks) {
    const rel = inside(p, d.path);
    if (rel !== null && (!best || d.path.length > best.d.path.length)) best = { d, rel };
  }
  const key = best && rootKey(best.d);
  return key ? { key, rel: best!.rel.normalize("NFC"), disk: best!.d } : undefined;
}

/** "nas", "NAS.local" and "nas._smb._tcp.local" are one server; an SMB share's name has no case (rootKey). */
const sameShare = (m: FolderMount, d: Disk) => !!d.network && rootKey(d) === rootKey(m);

/**
 * The folders with what each computer's disks say: the share a folder is on (from the computer that added it, when it was
 * not stored), and every other computer that has the same share connected reaches the folder inside it, at its own path.
 * So a second computer needs nothing typed: connecting the share is enough.
 */
export function withMounts(folders: StorageFolder[], computers: Array<{ id: string; disks?: Disk[] }>): StorageFolder[] {
  const disks = new Map(computers.map((c) => [c.id, c.disks ?? []]));
  return folders.map((f) => {
    const mount = f.mount ?? mountOf(f.origin.path, disks.get(f.origin.host));
    if (!mount) return f;
    const reach = { ...f.reach };
    for (const [id, list] of disks) {
      if (id === f.origin.host || reach[id]) continue;
      const d = list.find((x) => sameShare(mount, x));
      if (d) reach[id] = { path: joinRoot(d.path, mount.sub), at: 0 };
    }
    return { ...f, mount, reach };
  });
}

/** May computer `host` take footage at these paths? A path inside a footage folder: only where that computer has the folder
 *  (the one that made it, or one that found its marker, at any path). A path outside every footage folder: no restriction. */
export function canReach(paths: string[], folders: StorageFolder[], host: string): boolean {
  return paths.every((p) => !folderFor(p, folders) || hostPath(p, folders, host) !== null);
}

/** A worker's storage report, checked: good paths and ids only, at most 100 of each. Not an object -> null. */
export function parseStorageReport(v: unknown): StorageReport | null {
  if (!v || typeof v !== "object") return null;
  const o = v as { found?: unknown; errors?: unknown };
  const list = (x: unknown): unknown[] => (Array.isArray(x) ? x.slice(0, 100) : []);
  const id = (x: unknown) => (typeof x === "string" && x.length <= 64 ? x : undefined);
  const found = list(o.found).flatMap((x) => {
    const f = x as { id?: unknown; path?: unknown };
    const i = id(f?.id);
    return i && okFolderPath(f.path) ? [{ id: i, path: f.path }] : [];
  });
  const errors = list(o.errors).flatMap((x) => {
    const e = x as { id?: unknown; error?: unknown };
    const i = id(e?.id);
    return i && typeof e.error === "string" ? [{ id: i, error: e.error.slice(0, 300) }] : [];
  });
  return { found, errors };
}

/** The upload relay the server runs: CT_UPLOAD_RELAY when it names one, else "direct" when the server has a bucket, else
 *  "chunked". Asking for "direct" with no bucket gives "chunked" (the view says direct is not available). */
export function uploadRelayView(
  setting: string | undefined,
  bucketReady: boolean,
  plugged: Array<{ id: string; label: string; available: boolean }> = [],
): UploadRelayView {
  const name = setting?.trim();
  const one = plugged.find((r) => r.id === name);
  const named = UPLOAD_RELAY_IDS.find((id) => id === name);
  const wanted: UploadRelayId = one ? (one.available ? one.id : "chunked") : (named ?? (bucketReady ? "direct" : "chunked"));
  return {
    active: wanted === "direct" && !bucketReady ? "chunked" : wanted,
    relays: [
      { id: "chunked", label: "Through this server, in 16 MB parts", available: true },
      { id: "direct", label: "Straight to the server's bucket (S3-compatible)", available: bucketReady },
      ...plugged,
    ],
  };
}

/** Whether `file` is inside one of `dirs`. */
export const isInside = (file: string, dirs: string[]) =>
  dirs.some((d) => {
    const r = path.relative(d, file);
    return r !== "" && !r.startsWith("..") && !path.isAbsolute(r);
  });
