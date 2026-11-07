import { readFile } from "node:fs/promises";
import type { LibraryRef } from "../lib/workshop/types";
import { libraryRole } from "./access";
import { blobs, libraryDb } from "./db";
import { segmentsOf } from "./transcribe";

/**
 * Media Library clips in the Content Workshop (tasks/media-library-plan.md, section 10): a chat message carries
 * `{ kind: 'library', assetId, versionId }`. The AI gets the clip's thumbnail, its description and a transcript
 * excerpt, never the file. Every read checks that the author may still read the clip's library.
 */

const EXCERPT_CHARS = 4000;

interface Row {
  library_id: string;
  title: string;
}

/** The version of an asset out of the trash, if `username` may read its library. */
function readable(username: string, assetId: string, versionId: string): Row | null {
  const row = libraryDb()
    .prepare(
      `SELECT a.library_id, a.title FROM asset_versions v JOIN assets a ON a.id = v.asset_id
       WHERE v.id = ? AND a.id = ? AND a.trashed_at IS NULL`,
    )
    .get(versionId, assetId) as Row | undefined;
  return row && libraryRole(username, row.library_id) ? row : null;
}

/** The ref a message keeps, or null when the clip is gone or not the author's to read. */
export function libraryRef(username: string, assetId: string, versionId: string): LibraryRef | null {
  const row = readable(username, assetId, versionId);
  return row ? { kind: "library", assetId, versionId, title: row.title } : null;
}

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/** The transcript as timed lines, cut at about EXCERPT_CHARS. */
export function transcriptExcerpt(segments: { start: number; text: string }[], max = EXCERPT_CHARS): string {
  let out = "";
  for (const s of segments) {
    const line = `[${clock(s.start)}] ${s.text}\n`;
    if (out.length + line.length > max) return `${out}[… the transcript goes on]`;
    out += line;
  }
  return out.trimEnd();
}

export interface ClipContext {
  title: string;
  description?: { text: string; source: "user" | "ai" };
  transcript?: string;
  /** the thumbnail, base64 JPEG */
  thumb?: string;
}

/** What the AI reads about one clip this turn, or null when the author can no longer read it. */
export async function clipContext(username: string, ref: Pick<LibraryRef, "assetId" | "versionId">): Promise<ClipContext | null> {
  const row = readable(username, ref.assetId, ref.versionId);
  if (!row) return null;
  const db = libraryDb();
  // the author's own description wins over the AI's
  const description = db
    .prepare("SELECT text, source FROM descriptions WHERE version_id = ? ORDER BY source = 'user' DESC LIMIT 1")
    .get(ref.versionId) as ClipContext["description"] | undefined;
  const segments = segmentsOf(db, ref.versionId);
  const key = (db.prepare("SELECT storage_key FROM derivatives WHERE version_id = ? AND kind = 'thumb'").get(ref.versionId) as
    | { storage_key: string | null }
    | undefined)?.storage_key;
  const thumb = key ? await blobs.localCopy(key).then((f) => readFile(f), () => null) : null;
  return {
    title: row.title,
    ...(description ? { description: { text: description.text, source: description.source } } : {}),
    ...(segments.length ? { transcript: transcriptExcerpt(segments) } : {}),
    ...(thumb ? { thumb: thumb.toString("base64") } : {}),
  };
}
