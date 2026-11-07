import { randomUUID } from "node:crypto";
import { link, mkdir, rename, symlink } from "node:fs/promises";
import path from "node:path";
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
  storage_kind: "local" | "s3";
}

/** A title as a file name: no path separators or control characters, no leading dot. */
const safe = (t: string) => t.replace(/[/\\:\p{Cc}]+/gu, " ").replace(/^\.+/, "").trim().slice(0, 120) || "Untitled";

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
}

/** Paths for the sources `keys` (library version ids) of `edit`, making the media/ links they need. */
export async function mediaPaths(edit: EditMeta, keys: string[]): Promise<MediaPaths> {
  const q = libraryDb().prepare(
    `SELECT v.id, a.title, v.source_key, v.source_path, v.mime, l.storage_kind FROM asset_versions v
     JOIN assets a ON a.id = v.asset_id JOIN libraries l ON l.id = a.library_id WHERE v.id = ?`,
  );
  const rows = edit.sources.map((id) => q.get(id) as Row | undefined).filter((r): r is Row => !!r);
  const names = namesOf(rows);
  const out: MediaPaths = { files: {}, downloads: [] };
  const dir = path.join(editDir(edit.id), "media");
  for (const r of rows.filter((x) => keys.includes(x.id))) {
    const name = names[r.id]!;
    if (r.storage_kind === "s3") {
      out.files[r.id] = `media/${name}`;
      const at = await blobs.locate(r.source_key, LINK_TTL_S, { download: name });
      if (at.kind === "url") out.downloads.push({ name, url: at.url });
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
