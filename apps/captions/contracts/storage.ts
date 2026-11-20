import type { FolderState } from "./places";

/**
 * Where the files are (Settings → Storage). The app enforces one thing: where it saves. That is Exports (role "library"),
 * the exact folder the person picked (finished videos, edit files, downloads), one per workspace, with Finished/ inside it.
 * Media is one list of sources: folders read in place, any number, never moved, only the ones someone added (an older
 * Library's own Footage/ became one of them once: api/lib/storage.ts parseStorageFile). There is no music folder: the
 * Media Library tells songs and sound effects apart itself (owner, 2026-11-17).
 *
 * Every folder has a small marker file (MARKER_FILE, JSON `{ "id", "role", "name" }`), so every computer finds it by the
 * marker on whatever drive it is connected, at whatever path. Kept per account on the server (storage.json in the
 * account's folder under $DATA_DIR/storage/); each computer that reports its folders says where it found each one.
 */

export const STORAGE_ROLES = [{ value: "footage", label: "Source media" }] as const;
/** The Projects folder's name: setup's and the card's default (libraryBase/<name>). */
export const PROJECTS_NAME = "Project files";
/** The Exports folder's name: setup's and the card's default (libraryBase/<name>). */
export const EXPORTS_NAME = "Final exports";
/** The three uses (owner, 2026-11-18): "footage" is Media (many per workspace), "projects" is the workspace's Projects folder
 *  (AI Editor working files, one), "library" is its Exports folder (finals and deliverables, one; Finals reads it). "finals"
 *  is a legacy role, read as Exports (api/library/report.ts useOf). A "music" folder from before is read as footage. */
export type StorageRole = "footage" | "finals" | "library" | "projects";
export type SourceRole = (typeof STORAGE_ROLES)[number]["value"];
/** The one label of each folder use, on every surface (Settings → Folders, Library settings, setup, the AI's words). */
export const FOLDER_LABELS: Record<StorageRole, string> = { footage: "Source media", projects: PROJECTS_NAME, library: EXPORTS_NAME, finals: EXPORTS_NAME };

export const MARKER_FILE = ".creatortoolset-folder";
/** The host of a folder on the computer the server runs on, when no paired Mac stands for it (setup's Folders step, owner only). */
export const THIS_COMPUTER = "this-computer";
/** The Exports folder setup suggests (~/Movies/Creator Toolset), and the subfolder for each role inside it. */
export const LIBRARY_NAME = "Creator Toolset";
/** A workspace's default Library folder on a computer: ~/Movies/Creator Toolset/<workspace> (setup; the Project files ask). */
export const libraryBase = (workspace: string) => `~/Movies/${LIBRARY_NAME}/${workspace.replace(/\//g, "-")}`;
/** New disk folders' names (existing folders are never renamed); apps/editor/editor/storage.py mirrors them. */
export const LIBRARY_SUBFOLDERS: Record<"footage" | "finished", string> = { footage: "Source media", finished: "Final exports" };

/** The names a Library folder's subfolder of each use may already have, in this order (setup's Found; any case). */
export const FOLDER_ALIASES: Record<"footage" | "projects" | "library", readonly string[]> = {
  footage: ["Source media", "Footage", "Media"],
  projects: ["Project files", "Projects"],
  library: ["Final exports", "Exports", "Finals"],
};
/** The subfolder among `names` that already holds `use`, as it is named on disk (never renamed); undefined when none does. */
export function foundFolder(names: readonly string[] | undefined, use: keyof typeof FOLDER_ALIASES): string | undefined {
  for (const alias of FOLDER_ALIASES[use]) {
    const hit = names?.find((n) => n.toLowerCase() === alias.toLowerCase());
    if (hit) return hit;
  }
  return undefined;
}

/** A drive or volume a computer reported: its name, where it is mounted, and its space (GB). A network share
 *  also says it is one (`network`) and which machine it lives on (`server`, e.g. the NAS's name). */
export interface Disk {
  name: string;
  path: string;
  freeGb: number;
  totalGb?: number;
  network?: true;
  server?: string;
  /** a network share: how it is shared and its name on the server ("footage"; NFS: the exported path). Never a password or user name */
  fs?: ShareFs;
  share?: string;
  /** a volume's own id (the Mac's volume UUID, the boot volume's too): the same wherever it is mounted (places.ts rootKey) */
  uuid?: string;
  /** a network share whose server did not answer the last check: mounted, but nothing on it can be read now */
  away?: true;
}

export const SHARE_FS = ["smb", "nfs", "afp"] as const;
export type ShareFs = (typeof SHARE_FS)[number];

/** How a folder's drive is connected on the computer that added it, when it is a network share: the share, and where the
 *  folder is inside it ("/"-separated, "" for the share itself). Another computer that connects the same share has it. */
export interface FolderMount {
  fs: ShareFs;
  server: string;
  share: string;
  sub: string;
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
  /** the workspace it belongs to (stamped when added), or EVERY_WORKSPACE; none = from before workspaces kept their
   *  own: the first brand's. A list sent to a page names the workspace each folder is in (api/devices-storage.ts) */
  workspace?: string;
  /** the workspaces it is in when that is two or more (Settings → Folders, a Media folder's Workspaces);
   *  `workspace` is then the first of them, so a reader that knows only `workspace` keeps it to that one */
  workspaces?: string[];
  /** the share its drive is, on the computer that added it (api/lib/storage.ts mountOf); none: a disk of that computer's own */
  mount?: FolderMount;
  /** the same folder's path inside the container a helper runs in (a NAS's Docker helper); none: origin.path, a native
   *  computer. whereIs translates through both (api/library/whereis.ts) */
  mountPath?: string;
  /** the origin computer's last word on the folder (its location agent's report, contracts/places.ts FolderState), and
   *  when it said it ("Last checked"). None: not checked yet */
  folderState?: FolderState;
  checkedAt?: number;
  /** a Media folder that is also a destination for the library's copies */
  copyTo?: true;
  /** a Media folder: the names of folders inside it, at any depth, whose files are left out of the Media Library (Settings →
   *  Folders, Folders left out; notFootage). None: only what notFootage always leaves out. Nothing on disk is moved */
  leaveOut?: string[];
  /** set by the page's view only, never stored: this folder's computer is not one of the account's ("Computer not found") */
  missing?: true;
}

/** A Media folder's `workspace` when every workspace uses it (Settings → Folders, a folder's Workspaces: All workspaces). */
export const EVERY_WORKSPACE = "*";

/**
 * Whether a folder is one workspace's: `inWs` is that workspace's own test (api/lib/project-of.ts inProjectOf; null =
 * nothing is kept apart). Every reader of a workspace's folders asks here, so a folder for every workspace is in each.
 */
export const folderIn = (f: Pick<StorageFolder, "workspace" | "workspaces">, inWs: ((own?: string) => boolean) | null): boolean =>
  !inWs || f.workspace === EVERY_WORKSPACE || (f.workspaces ?? [f.workspace]).some((w) => inWs(w));

/** A share's server and name as they may be reported (contracts/providers.ts parseMachine) and put into a command. */
export const SAFE_SERVER = /^[\w.-]{1,253}$/;
export const SAFE_SHARE = /^[\w .$\/-]{1,200}$/;

/** A share's server as a computer can find it on the network: a bare name ("nas") gets ".local" for a Mac or Linux. */
const reachable = (server: string, os: "mac" | "linux" | "windows") => (os !== "windows" && /^[a-z0-9-]+$/i.test(server) ? `${server}.local` : server);

/**
 * How to connect a folder's share on another computer (Settings → Storage, Connect): a link a Mac opens in the Finder,
 * or the one line to run on Linux or Windows. The computer asks for the share's password itself; none is ever kept here.
 * Null: that kind of computer can't connect that kind of share.
 */
export function connectFor(m: FolderMount, os: "mac" | "linux" | "windows"): { url: string } | { line: string } | null {
  // what goes into a command is only a plain host name and share name: anything else is not offered
  if (!SAFE_SERVER.test(m.server) || !SAFE_SHARE.test(m.share)) return null;
  const host = reachable(m.server, os);
  const share = m.share.replace(/^\/+/, "");
  const at = `/mnt/${share.split("/").pop()!.replace(/[^\w.-]+/g, "-") || "share"}`;
  if (os === "mac") return { url: `${m.fs}://${host}/${share.split("/").map(encodeURIComponent).join("/")}` };
  if (os === "linux") {
    if (m.fs === "smb") return { line: `sudo mkdir -p ${at} && sudo mount -t cifs '//${host}/${share}' ${at} -o username=$USER,uid=$(id -u),gid=$(id -g)` };
    if (m.fs === "nfs") return { line: `sudo mkdir -p ${at} && sudo mount -t nfs '${host}:/${share}' ${at}` };
    return null;
  }
  return m.fs === "smb" ? { line: `net use * "\\\\${host}\\${share.replace(/\//g, "\\")}" /persistent:yes` } : null;
}

/**
 * The shares computer `device` doesn't reach: the footage folders on a share that another computer added and that its
 * connected drives do not give it (withMounts, from its last report). Each share once, by name ("MONOLITH DIGITAL").
 */
export function unreachedShares(folders: StorageFolder[], device: string): string[] {
  return [...new Set(folders.filter((f) => f.role === "footage" && f.mount && f.origin.host !== device && !f.reach[device]).map((f) => f.mount!.share))];
}

/** The storage file's shape: 2 = every folder's computer is a device id (no THIS_COMPUTER), duplicates merged
 *  (api/lib/storage.ts migrateStorage); 3 = an older Library's own Footage/ is a listed Media folder (parseStorageFile).
 *  A file from before is moved on read. */
export const STORAGE_SCHEMA = 3;

export interface StorageState {
  schemaVersion?: number;
  folders: StorageFolder[];
}

/** Whether a Library's own Footage/ was a Media folder: only for one made before 2026-11-17, where setup and card copies
 *  may have put clips. It is a listed one since (api/lib/storage.ts parseStorageFile); no other folder is added for an
 *  Exports folder (owner, 2026-11-18). */
export const ownFootage = (lib: Pick<StorageFolder, "createdAt">): boolean => lib.createdAt < Date.UTC(2026, 10, 17);

/** The folders the Media Library takes in: the listed ones, never a folder no one added (owner, 2026-11-18). */
export const sourcesOf = (folders: StorageFolder[]): StorageFolder[] => folders.filter((f) => f.role !== "library");

/** A workspace's Exports folder (`folders`: that workspace's, folderIn): the one given to it by name before the one for
 *  every workspace, so giving a workspace its own never needs the other one changed. */
export const exportsOf = (folders: StorageFolder[]): StorageFolder | undefined =>
  folders.find((f) => f.role === "library" && f.workspace !== EVERY_WORKSPACE) ?? folders.find((f) => f.role === "library");

/** An Exports folder's own subfolder for `role` as a folder of its own: the same host and reach, one level down. `sub` is
 *  the name on disk when it is not the current one: an older Library's Footage/ keeps its name (existing folders are never renamed). */
export function inLibrary(lib: StorageFolder, role: "footage" | "finals", sub = LIBRARY_SUBFOLDERS[role === "finals" ? "finished" : role]): StorageFolder {
  return {
    ...lib,
    id: `${lib.id}:${role}`,
    role,
    name: sub,
    origin: { host: lib.origin.host, path: `${lib.origin.path}/${sub}` },
    ...(lib.mountPath ? { mountPath: `${lib.mountPath}/${sub}` } : {}),
    reach: Object.fromEntries(Object.entries(lib.reach).map(([h, r]) => [h, { ...r, path: `${r.path}/${sub}` }])),
    ...(lib.mount ? { mount: { ...lib.mount, sub: lib.mount.sub ? `${lib.mount.sub}/${sub}` : sub } } : {}),
  };
}

/** A workspace's Finals folder (`folders`: that workspace's): the one chosen in Settings → Folders, else its Exports folder. */
export function finalsFolderOf(folders: StorageFolder[]): StorageFolder | undefined {
  const lib = exportsOf(folders);
  return folders.find((f) => f.role === "finals") ?? (lib && { ...lib, id: `${lib.id}:finals`, role: "finals" });
}

/** A Workshop project's folder inside the Finals folder: its title, made safe as a file name on a Mac, Linux or Windows. */
export const finalsDirName = (title: string): string =>
  title.replace(/[\/\\:*?"<>|\p{Cc}]+/gu, " ").replace(/\s+/g, " ").trim().replace(/^\.+|[. ]+$/g, "").slice(0, 100).trim() || "Untitled";

/** A plug-in's own Exports route: a computer and the folder (`disk`) the plug-in makes its folder in. The app's own
 *  Exports folder is added like any other, AddFolderBody with role "library". */
export interface MakeLibraryBody {
  host: string;
  disk: string;
}

/** POST /api/devices/storage/folders: use a folder for a role ("projects" takes the place of the workspace's one; "library":
 *  the workspace's Exports folder, exactly that folder, made when missing, taken off the Exports folder that had it). */
export interface AddFolderBody {
  role: SourceRole | "projects" | "library";
  host: string;
  path: string;
  /** Setup's scratch default: a footage folder under ~/Movies/Creator Toolset on this computer is made when missing */
  make?: boolean;
}

/** `workspaces`: the ones it is in (one or more), null = every workspace. `workspace`: one id or null, from before.
 *  An Exports folder takes the workspaces it is given off the Exports folder that had them (api/devices-storage.ts). */
export type MoveFolderBody = { workspaces: string[] | null } | { workspace: string | null };

/** GET /api/devices/storage: the account's folders, plus the disks of the server's own computer when the server runs on
 *  one (CT_LOCAL=1, the owner's Mac). On a hosted server it is empty, so no one sees another machine's disks. */
export interface StorageView extends StorageState {
  serverDisks: Disk[];
  /** The account's computers (device ids) that are the machine this server runs on, where the server may read the
   *  person's folders: a folder added on one joins the Media Library, so the page shows what a big one takes first. */
  here?: string[];
  /** the workspace's Media Library keeps copies of the files on the server (it uploads them, or their proxies): a computer
   *  without a folder still works on its files through those */
  copies?: boolean;
  /** with ?all=1 (every workspace's folders): the folders whose workspace keeps those copies, by id */
  copied?: string[];
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
 * The folders (by their path below a Media folder) that an AI Editor made: a "<name>_edit" folder that holds a drafts/
 * folder in the same scan. A user's own "_edit" folder without one is footage (decision 4, 2026-11-18).
 */
export function editorDirsOf(rels: string[]): Set<string> {
  const dirs = new Set<string>();
  for (const rel of rels) {
    const parts = rel.split(/[\\/]/);
    for (let i = 0; i + 2 < parts.length; i++) if (/_edit$/i.test(parts[i]!) && parts[i + 1] === "drafts") dirs.add(parts.slice(0, i + 1).join("/"));
  }
  return dirs;
}

/** The folder an AI Editor worker downloads another computer's clips into, under a Media folder (never footage). */
export const PHONE_UPLOADS_DIR = "Phone uploads";

/**
 * A file under a Media folder that is not footage, by its path below the folder: inside one of `editorDirs` (see
 * editorDirsOf; apps/editor skips the same folders), inside a PHONE_UPLOADS_DIR folder or a folder named in the Media
 * folder's `leaveOut` (StorageFolder), at any depth, or a half-written file (".tmp", ".part": "clip.part.mp4" and
 * "clip.tmp" are; "party.mp4" and "clip.partial.mov" are not). Every scan leaves these out of the Media Library.
 */
export function notFootage(rel: string, editorDirs: ReadonlySet<string> = new Set(), leaveOut: readonly string[] = []): boolean {
  const parts = rel.split(/[\\/]/);
  const dirs = parts.slice(0, -1);
  // a privacy list fails safe: any case, either Unicode form (a Mac disk ignores case and may hand back decomposed names)
  const out = new Set(leaveOut.map(nameKey));
  return dirs.some((d) => d === PHONE_UPLOADS_DIR || out.has(nameKey(d))) || dirs.some((_, i) => editorDirs.has(dirs.slice(0, i + 1).join("/"))) || /\.(tmp|part)(\.\w+)?$/i.test(parts[parts.length - 1] ?? "");
}
const nameKey = (n: string) => n.normalize("NFC").toLowerCase();

/**
 * Whether `file` (a full path) is inside a folder that one of `folders` (Media folders) leaves out: each that holds it,
 * at its path on any computer that found it, counts (notFootage with its leaveOut). A Media folder inside another, kept
 * apart for another workspace, so leaves out what either list names: the safer of the two, and one rule for every reader.
 */
export function leftOutBy(folders: ReadonlyArray<Pick<StorageFolder, "origin" | "reach" | "mountPath" | "leaveOut">>, file: string): boolean {
  const at = file.normalize("NFC");
  return folders.some((f) => {
    if (!f.leaveOut?.length) return false;
    const roots = new Set([f.origin.path, f.mountPath, ...Object.values(f.reach ?? {}).map((r) => r.path)].filter((r): r is string => !!r));
    return [...roots].some((root) => {
      const r = root.normalize("NFC").replace(/\/+$/, "");
      return at.startsWith(`${r}/`) && notFootage(at.slice(r.length + 1), undefined, f.leaveOut);
    });
  });
}

/** At most this many names in a Media folder's leaveOut. */
export const LEAVE_OUT_MAX = 50;

/** A leaveOut list as sent (one folder name each, trimmed, no path), or null when it is not one; [] leaves nothing out. */
export function parseLeaveOut(v: unknown): string[] | null {
  if (!Array.isArray(v) || v.length > LEAVE_OUT_MAX) return null;
  const names = v.map((n) => (typeof n === "string" ? n.trim().normalize("NFC") : ""));
  if (names.some((n) => !n || n.length > 255 || n === "." || n === ".." || /[\\/\0]/.test(n))) return null;
  return [...new Set(names)];
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

/**
 * Settings → Storage, "Your files": what one account keeps in the server's data folder, in every workspace, by kind (api/kept.ts).
 * Each account clears its own: nothing here is deleted for its age (api/retention.ts) except the short-lived kinds, which
 * say so with `keepDays`. The order is the order they are counted in: a file two kinds share (a Review video is the
 * same file in the Media Library) counts once, in the first.
 */
export const KEPT_KINDS = [
  "captions", "review", "notes", "guides", "enhance", "editor", "analyzer", "workshop", "designs",
  "captions-trash", "review-trash", "library", "chat-pictures", "exports", "chat-videos", "look-sheets", "proxies",
] as const;
export type KeptKind = (typeof KEPT_KINDS)[number];
/** The kinds Empty clears: the trash, and copies no work needs. The rest is the account's work, deleted one by one in its own tool. */
export const EMPTIED: readonly KeptKind[] = ["captions-trash", "review-trash", "chat-pictures", "exports", "chat-videos", "look-sheets", "proxies"];
export interface KeptRow {
  kind: KeptKind;
  bytes: number;
  items: number;
  keepDays?: number;
  /** `proxies`: one row per computer, its proxy cache as its last claim said (POST …/proxies/empty?device=<id>) */
  device?: { id: string; name: string };
  /** `proxies`: the computer's download cache limit in bytes (work/cache.ts cacheLimit); absent = no limit */
  limit?: number;
}
/** Storage › Workspaces (admin): the Media Library's bytes on this server for one workspace. */
export interface WorkspaceStorage {
  id: string;
  name: string;
  bytes: number;
}
export interface KeptView {
  rows: KeptRow[];
  /** The server runs on the person's own computer (CT_LOCAL=1): the page says "this computer". */
  here: boolean;
}
