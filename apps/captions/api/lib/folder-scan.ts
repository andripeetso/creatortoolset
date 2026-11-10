import { readdirSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ScannedFolder } from "../../contracts/storage";

/**
 * Setup's "Where are your videos?" step: looks through the common places on this computer for folders that hold video
 * or audio files, so the person can pick them instead of typing paths. Read only: nothing is moved, listed or sent
 * anywhere. Owner-only (api/setup.ts), and only ever on the computer the server runs on.
 *
 * The walk is capped three ways (depth, folders visited, time), so a huge drive costs a few seconds and says so.
 */

export const VIDEO_EXT = new Set([".mp4", ".mov", ".m4v", ".mts", ".m2ts", ".mxf", ".avi", ".mkv", ".webm", ".mpg", ".mpeg", ".3gp"]);
export const AUDIO_EXT = new Set([".mp3", ".wav", ".m4a", ".aac", ".flac", ".aif", ".aiff", ".ogg", ".opus"]);

/** Folders a walk never enters: hidden ones, and the packages and system folders that hold media in a private layout. */
const SKIP = (name: string): boolean =>
  name.startsWith(".") || name === "node_modules" || name === "Library" || /\.(app|photoslibrary|fcpbundle|imovielibrary|band)$/i.test(name);

export interface ScanResult {
  folders: ScannedFolder[];
  /** a cap stopped the walk early: the list may be missing folders */
  truncated: boolean;
}

export interface ScanOptions {
  /** how many levels below each root to look (a root is level 0) */
  maxDepth?: number;
  /** folders read before the walk stops */
  maxDirs?: number;
  /** folders listed before the walk stops */
  maxFound?: number;
  /** milliseconds before the walk stops */
  maxMs?: number;
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

/** The common places a person keeps footage and music, on this computer. On a Mac, every mounted volume too. */
export function defaultRoots(home = os.homedir(), volumes: string[] = darwinVolumes()): string[] {
  const under = ["Movies", "Desktop", "Documents", "Downloads", "Pictures", "Music"].map((d) => path.join(home, d));
  return [...under, ...volumes];
}

/** The mounted drives under /Volumes (the boot disk is a link there, and is left out). */
function darwinVolumes(): string[] {
  if (process.platform !== "darwin") return [];
  try {
    return readdirSync("/Volumes", { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => path.join("/Volumes", e.name));
  } catch {
    return [];
  }
}

/**
 * Walks each root, breadth first, and lists the folders that hold media files directly. Newest first.
 * Unreadable folders are skipped; a cap ends the walk and sets `truncated`.
 */
export async function scanFolders(roots: string[], opts: ScanOptions = {}): Promise<ScanResult> {
  const maxDepth = opts.maxDepth ?? 3;
  const maxDirs = opts.maxDirs ?? 2000;
  const maxFound = opts.maxFound ?? 60;
  const maxMs = opts.maxMs ?? 4000;
  const now = opts.now ?? Date.now;
  const deadline = now() + maxMs;
  const found: ScannedFolder[] = [];
  let read = 0;
  let truncated = false;
  let queue: Array<{ dir: string; depth: number }> = roots.map((dir) => ({ dir, depth: 0 }));

  while (queue.length) {
    const next: typeof queue = [];
    for (const { dir, depth } of queue) {
      if (read >= maxDirs || now() > deadline || found.length >= maxFound) {
        truncated = true;
        break;
      }
      read++;
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        continue; // no access, or gone: skip it
      }
      const files = entries.filter((e) => e.isFile()).map((e) => e.name);
      const media = mediaKind(files);
      if (media) {
        const st = await stat(dir).catch(() => null);
        found.push({ path: dir, name: path.basename(dir), kind: media.kind, files: media.files, lastChanged: st?.mtimeMs ?? 0 });
      }
      if (depth >= maxDepth) continue;
      for (const e of entries) {
        if (e.isDirectory() && !SKIP(e.name)) next.push({ dir: path.join(dir, e.name), depth: depth + 1 });
      }
    }
    if (truncated) break;
    queue = next;
  }
  found.sort((a, b) => b.lastChanged - a.lastChanged);
  return { folders: found, truncated };
}
