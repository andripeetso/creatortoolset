import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LIBRARY_NAME, type FolderScanView, type ScannedFolder } from "../../contracts/storage";
import { env } from "./env";

/**
 * Setup's "Where are your videos?" step: looks through the common places on this computer for folders that hold video
 * or audio files, so the person can pick them instead of typing paths. Read only: nothing is moved, listed or sent
 * anywhere. Owner-only (api/setup.ts), and only ever on the computer the server runs on.
 *
 * Not searched by default: Downloads (the person adds it by path if footage lives there), network shares and backup
 * disks, the app's own data and Library folders, and sound-effect, game and sample-pack audio (never offered as Music).
 * The walk is capped three ways (depth, folders visited, time); each cap that cuts it short sets `truncated`.
 */

// the video RAW formats of cinema cameras (Blackmagic, RED, ARRI, Canon) count as footage; still-photo RAW does not
export const VIDEO_EXT = new Set([
  ".mp4", ".mov", ".m4v", ".mts", ".m2ts", ".mxf", ".avi", ".mkv", ".webm", ".mpg", ".mpeg", ".3gp", ".braw", ".r3d", ".ari", ".crm",
]);
export const AUDIO_EXT = new Set([".mp3", ".wav", ".m4a", ".aac", ".flac", ".aif", ".aiff", ".ogg", ".opus"]);

/** Folders a walk never enters: hidden ones, the packages and system folders that hold media in a private layout, and
 *  the Library folder (the app's own output and its own Footage/Music, which the Library already reads). */
const SKIP = (name: string): boolean =>
  name.startsWith(".") || name === "node_modules" || name === "Library" || name === LIBRARY_NAME || /\.(app|photoslibrary|fcpbundle|imovielibrary|band)$/i.test(name);

/** Audio that is not music a person made: sound-effect libraries, game assets, sample packs. Matched on the folder's path
 *  under its root, so a drive named "Game" does not hide everything on it. */
const SOUND_LIBRARY = /sound ?effects?|sound ?fx|sfx|game|steam|sample|loop|royalty|soundbank|preset/i;

/** Mounted network shares (their mount type) and backup disks: not offered by default. */
const NETWORK_FS = /\((smbfs|afpfs|nfs|webdav|cifs|ftp|afp)\b/;

export interface ScanOptions {
  /** how many levels below each root to look (a root is level 0) */
  maxDepth?: number;
  /** folders read before the walk stops */
  maxDirs?: number;
  /** folders listed before the walk stops */
  maxFound?: number;
  /** milliseconds before the walk stops */
  maxMs?: number;
  /** folders the walk never enters: the app's own data (default: the server's data folder) */
  exclude?: string[];
  home?: string;
  now?: () => number;
}

/** The media kind of a folder's own file names, or null when it holds no video or audio. */
export function mediaKind(names: string[]): { kind: "footage" | "music"; files: number } | null {
  let video = 0;
  let audio = 0;
  for (const n of names) {
    const ext = path.extname(n).toLowerCase();
    if (VIDEO_EXT.has(ext)) video++;
    else if (AUDIO_EXT.has(ext)) audio++;
  }
  if (video > 0) return { kind: "footage", files: video + audio };
  if (audio > 0) return { kind: "music", files: audio };
  return null;
}

/** The common places a person keeps footage and music, on this computer. On a Mac, every drive that is not a network
 *  share or a backup disk. Downloads is not here: it is where everything lands, so it is added by path only. */
export function defaultRoots(home = os.homedir(), volumes: string[] = darwinVolumes()): string[] {
  const under = ["Movies", "Desktop", "Documents", "Pictures", "Music"].map((d) => path.join(home, d));
  return [...under, ...volumes];
}

/** The mounted drives under /Volumes, without network shares and backup disks (the boot disk is a link there, and is left out). */
function darwinVolumes(): string[] {
  if (process.platform !== "darwin") return [];
  let network = new Set<string>();
  try {
    const mounts = execFileSync("/sbin/mount", { encoding: "utf8", timeout: 2000 });
    network = new Set(
      mounts
        .split("\n")
        .filter((l) => NETWORK_FS.test(l))
        .map((l) => /\son (\/Volumes\/.+?) \(/.exec(l)?.[1])
        .filter((p): p is string => !!p),
    );
  } catch {
    // no mount table: nothing is known to be a share, and a share is still offered only if it is a folder the person picks
  }
  try {
    return readdirSync("/Volumes", { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => path.join("/Volumes", e.name))
      .filter((v) => !network.has(v) && !/time ?machine|backup/i.test(path.basename(v)) && !existsSync(path.join(v, "Backups.backupdb")));
  } catch {
    return [];
  }
}

const within = (p: string, dir: string) => p === dir || p.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep);

/**
 * Walks each root, breadth first, and lists the folders that hold media files directly. Newest first. Symbolic links are
 * followed once (a folder reached twice is listed once). Unreadable folders are skipped; roots the system did not let it
 * read are returned as `blocked`, and a missing root is simply not looked in. A cap that stops the walk, or a folder
 * deeper than the depth cap that has folders in it, sets `truncated`.
 */
export async function scanFolders(roots: string[], opts: ScanOptions = {}): Promise<FolderScanView> {
  const maxDepth = opts.maxDepth ?? 3;
  const maxDirs = opts.maxDirs ?? 2000;
  const maxFound = opts.maxFound ?? 60;
  const maxMs = opts.maxMs ?? 4000;
  const now = opts.now ?? Date.now;
  const home = opts.home ?? os.homedir();
  const exclude = (opts.exclude ?? [env.dataDir]).map((p) => path.resolve(p));
  const deadline = now() + maxMs;
  const found: ScannedFolder[] = [];
  const looked: string[] = [];
  const blocked: string[] = [];
  const walked = new Set<string>(); // real paths already read: a link to a folder already listed is not listed again
  let read = 0;
  let truncated = false;
  let stopped = false;
  let queue: Array<{ dir: string; depth: number; root: string }> = roots.map((dir) => ({ dir, depth: 0, root: dir }));

  while (queue.length && !stopped) {
    const next: typeof queue = [];
    for (const { dir, depth, root } of queue) {
      if (read >= maxDirs || now() > deadline || found.length >= maxFound) {
        truncated = stopped = true;
        break;
      }
      const real = await realpath(dir).catch(() => dir);
      if (walked.has(real) || exclude.some((x) => within(real, x))) continue;
      walked.add(real);
      read++;
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (depth === 0 && (code === "EACCES" || code === "EPERM")) blocked.push(dir);
        continue; // gone, or no access: nothing in it
      }
      if (depth === 0) looked.push(dir);

      const files: string[] = [];
      const subfolders: string[] = [];
      for (const e of entries) {
        if (e.isSymbolicLink()) {
          const st = await stat(path.join(dir, e.name)).catch(() => null);
          if (st?.isDirectory()) subfolders.push(e.name);
          else if (st?.isFile()) files.push(e.name);
        } else if (e.isDirectory()) subfolders.push(e.name);
        else if (e.isFile()) files.push(e.name);
      }

      const media = mediaKind(files);
      if (media && !(media.kind === "music" && SOUND_LIBRARY.test(path.relative(root, dir)))) {
        const st = await stat(dir).catch(() => null);
        found.push({ path: dir, name: path.basename(dir), kind: media.kind, files: media.files, lastChanged: st?.mtimeMs ?? 0 });
      }

      const inside = subfolders.filter((n) => !SKIP(n));
      if (depth >= maxDepth) {
        if (inside.length) truncated = true; // folders below the depth cap: the list may be missing some
        continue;
      }
      for (const n of inside) next.push({ dir: path.join(dir, n), depth: depth + 1, root });
    }
    if (stopped) break;
    queue = next;
  }
  found.sort((a, b) => b.lastChanged - a.lastChanged);
  return { folders: found, truncated, looked, blocked, home };
}
