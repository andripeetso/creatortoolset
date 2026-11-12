import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { link, mkdir, rename, symlink } from "node:fs/promises";
import path from "node:path";
import type { TimelineSource } from "../../contracts/editor";
import { blobs, libraryDb } from "../library/db";
import { editDir, type EditMeta } from "./store";

/**
 * Where the user's own editor finds a draft's footage. A file a watch folder references is used where it is. Other
 * files in a library on this server's disk get a hard link in the edit's media/ folder named by the title (a symbolic
 * link across disks), so the editor's bin shows real names. A library in a bucket gets relative paths media/<name>
 * and a list of download links: the user downloads what they need and the editor relinks by name. The server never
 * downloads gigabytes on its own.
 */

const EXT: Record<string, string> = {
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
  "video/webm": ".webm",
  "video/x-matroska": ".mkv",
  "video/x-msvideo": ".avi",
  "audio/mp4": ".m4a",
  "audio/mpeg": ".mp3",
  "audio/wav": ".wav",
  "audio/ogg": ".ogg",
  "audio/flac": ".flac",
};

/** How long a download link in a bucket export works. */
export const LINK_TTL_S = 86_400;

interface Row {
  id: string;
  title: string;
  source_key: string;
  source_path: string | null;
  mime: string | null;
  storage_kind: "local" | "s3" | "bunny";
}

/** A title as a file name: no path separators or control characters, no leading dot. */
const safe = (t: string) => t.replace(/[/\\:\p{Cc}]+/gu, " ").replace(/^[\s.]+/, "").trim().slice(0, 120) || "Untitled";

/** File names for the edit's sources, in the order they were picked, made unique ("Take A.mov", "Take A 2.mov"). */
export function namesOf(rows: Pick<Row, "id" | "title" | "source_path" | "mime">[]): Record<string, string> {
  const seen = new Set<string>();
  const out: Record<string, string> = {};
  for (const r of rows) {
    const ext = (r.source_path && path.extname(r.source_path)) || EXT[r.mime ?? ""] || "";
    const base = safe(r.title);
    let name = `${base}${ext}`;
    for (let n = 2; seen.has(name.toLowerCase()); n++) name = `${base} ${n}${ext}`;
    seen.add(name.toLowerCase());
    out[r.id] = name;
  }
  return out;
}

/** Links `to` at `at`, replacing what is there in one step: a hard link, a symbolic one across disks. */
async function place(to: string, at: string): Promise<void> {
  const tmp = `${at}.${randomUUID()}.part`;
  try {
    await link(to, tmp);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
    await symlink(to, tmp);
  }
  await rename(tmp, at);
}

export interface MediaPaths {
  /** source key → the path the timeline names: absolute on this server's disk, media/<name> (relative to the timeline) from a bucket */
  files: Record<string, string>;
  /** for a bucket library: each file's name and a download link (LINK_TTL_S) */
  downloads: { name: string; url: string }[];
  /** the edit's own clips (cards) a zip carries: the name under media/ and the file on this server */
  own: { name: string; file: string }[];
}

/**
 * Paths for the sources `keys` of `edit`, making the media/ links they need: its footage, and whatever else the cut
 * plays from the library (B-roll). With `sources` (the timeline's), a clip that is the edit's own file (a card) gets its
 * place in the edit's folder, or, for a `zip`, a media/ path and a line in `own` so the zip carries the file itself.
 */
export async function mediaPaths(edit: EditMeta, keys: string[], sources?: Record<string, TimelineSource>, zip = false): Promise<MediaPaths> {
  const q = libraryDb().prepare(
    `SELECT v.id, a.title, v.source_key, v.source_path, v.mime, l.storage_kind FROM asset_versions v
     JOIN assets a ON a.id = v.asset_id JOIN libraries l ON l.id = a.library_id WHERE v.id = ?`,
  );
  // the edit's footage first, in the order picked, so its names never change; then the clips only the cut names
  const rows = [...new Set([...edit.sources, ...keys])].map((id) => q.get(id) as Row | undefined).filter((r): r is Row => !!r);
  const names = namesOf(rows);
  const out: MediaPaths = { files: {}, downloads: [], own: [] };
  for (const k of keys) {
    const file = sources?.[k]?.file;
    if (!file) continue;
    const at = path.join(editDir(edit.id), file);
    const name = `${k}${path.extname(file)}`;
    out.files[k] = zip ? `media/${name}` : at;
    if (zip && existsSync(at)) out.own.push({ name, file: at });
  }
  const dir = path.join(editDir(edit.id), "media");
  for (const r of rows.filter((x) => keys.includes(x.id))) {
    const name = names[r.id]!;
    // a bucket or Bunny zone that signs links: the worker downloads the file itself
    const at = r.storage_kind === "local" ? null : await blobs.locate(r.source_key, LINK_TTL_S, { download: name });
    if (at?.kind === "url") {
      out.files[r.id] = `media/${name}`;
      out.downloads.push({ name, url: at.url });
    } else if (r.source_path) {
      out.files[r.id] = r.source_path;
    } else {
      await mkdir(dir, { recursive: true });
      const at = path.join(dir, name);
      await place(await blobs.localCopy(r.source_key), at);
      out.files[r.id] = at;
    }
  }
  return out;
}
