import { Hono } from "hono";
import { stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { ZipFile } from "yazl";
import type { AuthVars } from "../auth";
import { notifyLibraryChanges } from "../lib/events";
import { libraryRole, mayWrite } from "./access";
import { blobs, libraryDb } from "./db";
import { enqueueJob } from "./jobs";
import { downloadName, readerOf } from "./routes";
import { mayServe } from "./upload-gate";
import { assetRef, canSee } from "./sources";
import { learnAll } from "./learn";
import { lookable } from "./shots";

/**
 * The Media Library's moves on many clips at once (the page's selection bar, Library settings → Redo for every clip).
 * Mounted at /api/library. Each clip is checked on its own, as it would be alone: what the caller may not see is left out.
 */

export const bulkApp = new Hono<{ Variables: AuthVars }>();
bulkApp.use("*", notifyLibraryChanges);

const db = () => libraryDb();
const notFound = (c: { json: (b: unknown, s: 404) => Response }) => c.json({ error: "Not found", code: "not_found" }, 404);
const MAX_IDS = 500;

/** "clip.mp4", then "clip (2).mp4": two originals with the same name both go in the zip. */
export function uniqueName(name: string, taken: Set<string>): string {
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  let out = name;
  for (let n = 2; taken.has(out.toLowerCase()); n++) out = `${base} (${n})${ext}`;
  taken.add(out.toLowerCase());
  return out;
}

// GET /api/library/:id/zip?ids=a,b → the originals of those clips as one zip, streamed as it is written (never held whole),
// each named as it downloads alone. A clip the caller may not see (the same check as its media route), one not in this
// library or one whose file is gone is left out; none left: 404.
bulkApp.get("/:id/zip", async (c) => {
  const user = c.get("user");
  const libraryId = c.req.param("id");
  const viewer = await readerOf(user.username, libraryId);
  if (!viewer) return notFound(c);
  const ids = [...new Set((c.req.query("ids") ?? "").split(",").filter(Boolean))].slice(0, MAX_IDS);
  const files: { path: string; name: string }[] = [];
  const taken = new Set<string>();
  for (const id of ids) {
    const a = db()
      .prepare("SELECT a.current_version_id AS v, s.source_key AS key, s.mac_path FROM assets a JOIN asset_versions s ON s.id = a.current_version_id WHERE a.id = ? AND a.library_id = ? AND a.left_hidden_at IS NULL")
      .get(id, libraryId) as { v: string; key: string; mac_path: string | null } | undefined;
    // an original kept on a Mac is not here (its source may be its proxy): the zip holds originals only
    if (!a || a.mac_path || !(await canSee(viewer, assetRef(libraryId, id, a.v)))) continue;
    // under Upload none the server gives no original (decision 6): the zip skips it
    if (!(await mayServe({ id: libraryId, versionId: a.v }, "original")).ok) continue;
    // a file read where it is may be on a drive that is away: stat first, so one gone file never breaks the zip midway
    const file = await blobs.localCopy(a.key).catch(() => null);
    if (!file || !(await stat(file).catch(() => null))?.isFile()) continue;
    files.push({ path: file, name: uniqueName(downloadName(a.v), taken) });
  }
  if (!files.length) return notFound(c);
  const zip = new ZipFile();
  // stored, not compressed: video does not shrink, and the zip starts at once
  for (const f of files) zip.addFile(f.path, f.name, { compress: false });
  zip.end();
  return new Response(Readable.toWeb(zip.outputStream as Readable) as never, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="Media Library ${files.length} clips.zip"`,
      "Cache-Control": "no-store",
    },
  });
});

/**
 * What can be asked for again on many clips: a fresh transcript, description, search data (vectors), or shot
 * descriptions (the videos that get them: shots.ts lookable; written again only where the context or the level changed).
 */
const REDO = new Set(["transcribe", "describe", "embed", "look"]);

// POST /api/library/:id/jobs { kinds, assetIds?, count? } → { clips }: those jobs queued again on the clips the caller may
// change (every clip in the library when assetIds is left out), with the caller as the actor (their AI and keys). A
// description only for videos; a transcript and search data for videos and sound. `count`: only says how many it would be.
bulkApp.post("/:id/jobs", async (c) => {
  const user = c.get("user");
  const libraryId = c.req.param("id");
  if (!libraryRole(user.username, libraryId)) return notFound(c);
  const b = (await c.req.json().catch(() => null)) as { kinds?: unknown; assetIds?: unknown; count?: unknown } | null;
  const kinds = Array.isArray(b?.kinds) ? b.kinds.filter((k): k is string => typeof k === "string" && REDO.has(k)) : [];
  if (!kinds.length) return c.json({ error: `Nothing to run: kinds may be ${[...REDO].join(", ")}`, code: "invalid" }, 400);
  const asked = Array.isArray(b?.assetIds) ? b.assetIds.filter((x): x is string => typeof x === "string").slice(0, MAX_IDS) : null;
  const rows = (
    asked
      ? asked.map((id) => db().prepare("SELECT id, kind, current_version_id AS v FROM assets WHERE id = ? AND library_id = ? AND trashed_at IS NULL AND left_hidden_at IS NULL").get(id, libraryId))
      : db().prepare("SELECT id, kind, current_version_id AS v FROM assets WHERE library_id = ? AND trashed_at IS NULL AND left_hidden_at IS NULL").all(libraryId)
  ).filter(Boolean) as { id: string; kind: string; v: string | null }[];
  // described again: what the person's own tags mean is learned first, so this pass already knows (learn.ts)
  if (b?.count !== true && kinds.includes("describe")) await learnAll(db(), libraryId, user.username).catch(() => 0);
  let clips = 0;
  for (const r of rows) {
    const v = r.v;
    const these = kinds.filter((k) => (k === "look" ? !!v && !!lookable(db(), v) : k === "describe" ? r.kind === "video" : r.kind === "video" || r.kind === "audio"));
    if (!v || !these.length || !(await mayWrite(user.username, libraryId, r.id, v))) continue;
    clips++;
    if (b?.count !== true) for (const k of these) enqueueJob(db(), libraryId, v, k, user.username, true);
  }
  return c.json({ clips });
});
