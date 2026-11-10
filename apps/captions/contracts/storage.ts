/**
 * Where the files are (Settings → Devices → Storage). The app enforces one thing: where it saves. That is the Library,
 * one "Creator Toolset" folder (finished videos, edit files, downloads) with Footage/, Music/ and Finished/ inside it.
 * Footage and Music are lists of sources: folders read in place, any number, never moved. The Library's own Footage/
 * and Music/ count as sources too, so a user with no system of their own just drops files there.
 *
 * Every folder has a small marker file (MARKER_FILE, JSON `{ "id", "role", "name" }`), so every computer finds it by the
 * marker on whatever drive it is connected, at whatever path. Kept per account on the server (storage.json in the
 * account's folder under $DATA_DIR/storage/); each computer that reports its folders says where it found each one.
 */

export const STORAGE_ROLES = [
  { value: "footage", label: "Footage" },
  { value: "music", label: "Music" },
] as const;
/** "library" is the one Library folder; footage and music are the source lists. */
export type StorageRole = "footage" | "music" | "library";
export type SourceRole = (typeof STORAGE_ROLES)[number]["value"];

export const MARKER_FILE = ".creatortoolset-folder";
/** The host of a folder on the computer the server runs on, when no paired Mac stands for it (setup's Folders step, owner only). */
export const THIS_COMPUTER = "this-computer";
/** The library folder's name and the subfolder for each role inside it. */
export const LIBRARY_NAME = "Creator Toolset";
export const LIBRARY_SUBFOLDERS: Record<SourceRole | "finished", string> = { footage: "Footage", music: "Music", finished: "Finished" };

/** A drive or volume a computer reported: its name, where it is mounted, and its space (GB). A network share
 *  also says it is one (`network`) and which machine it lives on (`server`, e.g. the NAS's name). */
export interface Disk {
  name: string;
  path: string;
  freeGb: number;
  totalGb?: number;
  network?: true;
  server?: string;
}

export interface StorageFolder {
  /** random id, also written into the marker */
  id: string;
  role: StorageRole;
  /** shown name: the folder's own name */
  name: string;
  /** the computer (device id) that was asked to mark or make it, and the path there. A path may start with
   *  "~/" (that computer's home folder). */
  origin: { host: string; path: string };
  /** true: the computer makes the folder (and its parents) if missing; false: it must already exist */
  make: boolean;
  createdAt: number;
  /** each computer that found the marker: where, and when it last looked */
  reach: Record<string, { path: string; at: number }>;
  /** the origin computer could not mark it (no such folder, not writable…) */
  error?: string;
}

export interface StorageState {
  folders: StorageFolder[];
}

/** The footage and music sources: the listed folders, plus the Library's own Footage/ and Music/ (same host, same
 *  reach, one level down). Derived entries carry the Library's id with the role appended. */
export function sourcesOf(folders: StorageFolder[]): StorageFolder[] {
  const derived = folders
    .filter((f) => f.role === "library")
    .flatMap((lib) => (["footage", "music"] as const).map((role) => {
      const sub = LIBRARY_SUBFOLDERS[role];
      return {
        ...lib,
        id: `${lib.id}:${role}`,
        role,
        name: sub,
        origin: { host: lib.origin.host, path: `${lib.origin.path}/${sub}` },
        reach: Object.fromEntries(Object.entries(lib.reach).map(([h, r]) => [h, { ...r, path: `${r.path}/${sub}` }])),
      };
    }));
  return [...folders.filter((f) => f.role !== "library"), ...derived];
}

/** POST /api/devices/storage/library: make the library folder on one computer. `disk` is the folder it goes in;
 *  "/" or "~" means its home folder. */
export interface MakeLibraryBody {
  host: string;
  disk: string;
}

/** POST /api/devices/storage/folders: use a folder you already have for a role. */
export interface AddFolderBody {
  role: SourceRole;
  host: string;
  path: string;
}

/** GET /api/devices/storage: the account's folders, plus the disks of the server's own computer when the server runs on
 *  one (CT_LOCAL=1, the owner's Mac). On a hosted server it is empty, so no one sees another machine's disks. */
export interface StorageView extends StorageState {
  serverDisks: Disk[];
}

/** A computer's report of the folders it found: good paths and ids only (see parseStorageReport). */
export interface StorageReport {
  found: Array<{ id: string; path: string }>;
  errors: Array<{ id: string; error: string }>;
}

/** A path the API accepts: absolute or "~/…", no "..", no NUL, at most 1000 characters. */
export function okFolderPath(p: unknown): p is string {
  return typeof p === "string" && p.length <= 1000 && (p.startsWith("/") || p.startsWith("~/") || p === "~")
    && !p.includes("\0") && !p.split("/").includes("..");
}

/**
 * Upload relays (api/uploads/relay): how a big video gets from the browser to the server. Both kinds are built in, and
 * the server picks the active one (api/lib/storage.ts uploadRelayView), so a client asks the server and never chooses.
 * "chunked": 16 MB parts through this server (works everywhere, the default). "direct": the browser PUTs the parts
 * straight to the server's S3-compatible bucket with presigned URLs, and the server copies the object in when it is done.
 */
export const UPLOAD_RELAY_IDS = ["chunked", "direct"] as const;
/** A built-in id, or a plug-in relay's id (plugin.ts uploadRelays). */
export type UploadRelayId = string;

/** A plug-in relay's TUS settings for the browser: POST `createUrl` (with `metadata` and Upload-Length) gives the PATCH target. */
export interface UploadRelayTus {
  createUrl: string;
  headers: Record<string, string>;
  metadata: string;
  partSize: number;
}

/** GET /api/uploads/relay: the active relay, and every relay with whether this server can run it now. */
export interface UploadRelayView {
  active: UploadRelayId;
  relays: Array<{ id: UploadRelayId; label: string; available: boolean }>;
}
