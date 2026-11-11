import { readFile, realpath, statfs } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { LIBRARY_NAME, okFolderPath, sourcesOf, THIS_COMPUTER, UPLOAD_RELAY_IDS, type Disk, type StorageFolder, type StorageReport, type StorageState, type UploadRelayId, type UploadRelayView } from "../../contracts/storage";

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
    return { folders: Array.isArray(v?.folders) ? v.folders : [] };
  } catch (e) {
    console.warn(`[devices-storage] storage file unreadable, treated as empty: ${e instanceof Error ? e.message : e}`);
    return { folders: [] };
  }
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

/** p is dir or inside it, on a "/" boundary: "/Volumes/TEAM2" is not inside "/Volumes/TEAM". */
function within(p: string, dir: string): boolean {
  const d = norm(dir);
  return p === d || p.startsWith(d.endsWith("/") ? d : `${d}/`);
}

export interface FolderMatch { folder: StorageFolder; prefix: string }

/** The footage folder a path is inside: the longest of its origin and reach paths that holds it. "~/…" never holds an
 *  absolute path (they are different computers' paths). */
export function folderFor(p: string, folders: StorageFolder[]): FolderMatch | null {
  let best: FolderMatch | null = null;
  for (const folder of sourcesOf(folders)) {
    if (folder.role !== "footage") continue;
    for (const prefix of [folder.origin.path, ...Object.values(folder.reach).map((r) => r.path)]) {
      if (within(p, prefix) && (!best || norm(prefix).length > best.prefix.length)) best = { folder, prefix: norm(prefix) };
    }
  }
  return best;
}

/** The v1 reach rule (paths are not rewritten between computers yet): a footage path inside a known folder may be taken
 *  by a computer only where it found that folder at the same path. The origin computer always reaches the folder it
 *  made, at its own path. A path outside every footage folder: no restriction. */
export function canReach(paths: string[], folders: StorageFolder[], host: string): boolean {
  return paths.every((p) => {
    const m = folderFor(p, folders);
    if (!m) return true;
    if (m.folder.origin.host === host && m.prefix === norm(m.folder.origin.path)) return true;
    const found = m.folder.reach[host]?.path;
    return found !== undefined && norm(found) === m.prefix;
  });
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

/**
 * The account's music folders on this computer (setup's and Settings' Music rows and the Library's own Music/), as real paths: the
 * Media Library takes their files in like any other (thumbnail, waveform), but spends nobody's AI or keys on them.
 */
export async function musicFolders(dataDir: string, user: string | null, here: (host: string) => boolean = () => false): Promise<string[]> {
  if (!user) return [];
  const st = parseStorageFile(await readFile(storageFilePath(dataDir, user), "utf-8").catch(() => "{}"));
  // `here`: a paired computer that is this machine (Settings → Storage records a folder against it, lib/devices.ts isThisMachine)
  const dirs = sourcesOf(st.folders).filter((f) => f.role === "music" && (f.origin.host === THIS_COMPUTER || here(f.origin.host))).map((f) => f.origin.path);
  return Promise.all(dirs.map((d) => realpath(d).catch(() => d)));
}

/** Whether `file` is inside one of `dirs`. */
export const isInside = (file: string, dirs: string[]) =>
  dirs.some((d) => {
    const r = path.relative(d, file);
    return r !== "" && !r.startsWith("..") && !path.isAbsolute(r);
  });
