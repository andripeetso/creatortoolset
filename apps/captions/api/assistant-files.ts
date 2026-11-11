import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AuthVars } from "./auth";
import { env } from "./lib/env";
import { assembleParts, MAX_UPLOAD_BYTES, PART_SIZE, partsStatus, readUploadState, receivePart, startUpload } from "./lib/uploads";
import { mayUse, type SessionUser } from "./users";
import { notesFromFile, probeDuration } from "./clips";
import { addVersion } from "./review";
import { createProjectFromFile, linkOrCopy } from "./projects";
import { ensureLibrary } from "./library/access";
import { libraryDb } from "./library/db";
import { saveToLibrary } from "./library/routes";
import { FILE_USES, type AssistantFile, type AssistantFileUse } from "../contracts/assistant";

/**
 * Videos and recordings dropped in the assistant's chat (owner, 2026-11-07: "drop in a random screen recording…
 * hey, caption this, put this up"). The dock uploads each one here in parts before the message goes;
 * the message names it by id, and the assistant's use_file tool (mcp.ts) hands it to Video Notes, Review or Caption
 * Studio as the same file under a second name (no copy). A file is kept 7 days: what used it keeps its own name for it.
 * $DATA_DIR/assistant/files/<user>/<id>/{file, meta.json} (parts/ while it uploads).
 */

export const assistantFilesApp = new Hono<{ Variables: AuthVars }>();

const KEEP_MS = 7 * 24 * 3600_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Footage only: a video or a recording's sound. */
export const isMedia = (mime: string, name: string) => /^(video|audio)\//.test(mime) || /\.(mp4|mov|m4v|webm|mkv|avi|mp3|m4a|wav|aac|ogg)$/i.test(name);

const rootOf = (user: string) => path.join(env.dataDir, "assistant", "files", user);
const dirOf = (user: string, id: string) => path.join(rootOf(user), id);
const fileOf = (user: string, id: string) => path.join(dirOf(user, id), "file");

/** One of this account's dropped files, or null (a strict id only, never a path; gone after 7 days). */
export async function readFileMeta(user: string, id: string): Promise<AssistantFile | null> {
  if (!UUID.test(id)) return null;
  try {
    const m = JSON.parse(await readFile(path.join(dirOf(user, id), "meta.json"), "utf-8")) as AssistantFile & { at: number };
    return Date.now() - m.at < KEEP_MS ? m : null;
  } catch {
    return null;
  }
}

/** This account's files older than 7 days go (each new upload sweeps its own account). */
async function sweep(user: string): Promise<void> {
  for (const id of await readdir(rootOf(user)).catch(() => [] as string[])) {
    const st = await stat(dirOf(user, id)).catch(() => null);
    if (st && Date.now() - st.mtimeMs > KEEP_MS) await rm(dirOf(user, id), { recursive: true, force: true });
  }
}

assistantFilesApp.post("/", async (c) => {
  const user = c.get("user");
  const b = (await c.req.json().catch(() => null)) as { name?: unknown; mime?: unknown; size?: unknown } | null;
  const size = Number(b?.size);
  const name = (typeof b?.name === "string" && b.name.trim() ? b.name.trim() : "Recording").slice(0, 160);
  const mime = (typeof b?.mime === "string" ? b.mime : "").slice(0, 80);
  if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_UPLOAD_BYTES) return c.json({ error: "Invalid size" }, 400);
  if (!isMedia(mime, name)) return c.json({ error: `${name} isn't a video or a recording` }, 400);
  await sweep(user.username);
  const id = randomUUID();
  await startUpload(path.join(dirOf(user.username, id), "parts"), { total: size, partSize: PART_SIZE, name, mime: mime || "video/mp4", owner: user.username });
  return c.json({ id, partSize: PART_SIZE });
});

assistantFilesApp.get("/:id/parts", (c) => {
  const id = c.req.param("id");
  if (!UUID.test(id)) return c.json({ error: "Not found" }, 404);
  return partsStatus(c, path.join(dirOf(c.get("user").username, id), "parts"), c.get("user"));
});

assistantFilesApp.post("/:id/parts/:partNumber", (c) => {
  const id = c.req.param("id");
  if (!UUID.test(id)) return c.json({ error: "Invalid part" }, 400);
  return receivePart(c, path.join(dirOf(c.get("user").username, id), "parts"), c.get("user"));
});

assistantFilesApp.post("/:id/complete", async (c) => {
  const user = c.get("user").username;
  const id = c.req.param("id");
  const done = await readFileMeta(user, id);
  if (done) return c.json(done);
  const parts = UUID.test(id) ? path.join(dirOf(user, id), "parts") : "";
  const state = parts ? await readUploadState(parts) : null;
  if (!state || state.owner !== user) return c.json({ error: "No upload in progress" }, 409);
  try {
    await assembleParts(parts, fileOf(user, id), state);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
  const meta: AssistantFile = { id, name: state.name, mime: state.mime, size: state.total };
  await writeFile(path.join(dirOf(user, id), "meta.json"), JSON.stringify({ ...meta, at: Date.now() }), { mode: 0o600 });
  await rm(parts, { recursive: true, force: true });
  return c.json(meta);
});

const TOOL_OF = { notes: "notes", review: "review", captions: "captions", library: "media" } as const;
const MIME: Record<string, string> = {
  mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime", webm: "video/webm", mkv: "video/x-matroska", avi: "video/x-msvideo",
  mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav", aac: "audio/aac", ogg: "audio/ogg",
};

/**
 * A file on this computer by its path, taken like a dropped one: only when the server runs on the user's own Mac
 * (CT_LOCAL=1), so the assistant can point at footage where it lies and nothing is uploaded. A hard link on the same
 * disk; a file on another drive is copied once.
 */
export async function fileFromPath(user: string, p: string): Promise<AssistantFile> {
  if (process.env.CT_LOCAL !== "1") throw new Error("This server isn't on your computer: drop the file in the chat so it uploads.");
  if (!path.isAbsolute(p)) throw new Error("Give the file's full path, such as /Users/you/Movies/clip.mov.");
  const st = await stat(p).catch(() => null);
  if (!st?.isFile() || !st.size) throw new Error(`There's no file at ${p}.`);
  const name = path.basename(p);
  // ponytail: footage by its extension only; probe the streams if something else ever passes for a video
  if (!isMedia("", name)) throw new Error(`${name} isn't a video or a recording.`);
  const id = randomUUID();
  await linkOrCopy(p, fileOf(user, id));
  const meta: AssistantFile = { id, name, mime: MIME[path.extname(name).slice(1).toLowerCase()] ?? "video/mp4", size: st.size };
  await writeFile(path.join(dirOf(user, id), "meta.json"), JSON.stringify({ ...meta, at: Date.now() }), { mode: 0o600 });
  return meta;
}

assistantFilesApp.post("/path", async (c) => {
  const b = (await c.req.json().catch(() => null)) as { path?: unknown } | null;
  try {
    return c.json(await fileFromPath(c.get("user").username, typeof b?.path === "string" ? b.path : ""));
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 409);
  }
});

const NAMES: Record<AssistantFileUse, string> = { notes: "Video Notes", review: "Review", captions: "Caption Studio", library: "Media Library" };

/** Hand a dropped file to a tool; answers what it became and its page. */
export async function useFile(
  user: SessionUser,
  id: string,
  to: AssistantFileUse,
  name?: string,
): Promise<{ to: AssistantFileUse; id: string; name: string; href: string; note?: string; versionId?: string; libraryId?: string }> {
  const meta = await readFileMeta(user.username, id);
  if (!meta) throw new Error("That file isn't here any more (dropped files are kept 7 days): ask for it again.");
  if (!mayUse(user, TOOL_OF[to])) throw new Error(`${NAMES[to]} isn't switched on for this account.`);
  const file = fileOf(user.username, id);
  const title = (name?.trim() || meta.name).slice(0, 120);
  if (to === "notes") {
    const made = await notesFromFile(file, title, meta.mime, user);
    return { to, id: made.id, name: title, href: `/video-notes/${made.id}` };
  }
  if (to === "library") {
    // the library keeps its own copy (a dropped file goes after 7 days); it is prepared and sorted A-roll or B-roll there
    ensureLibrary(user.username);
    const saved = await saveToLibrary(user.username, file, path.extname(title) ? title : `${title}${path.extname(meta.name)}`, [], undefined, true);
    if (!saved) throw new Error("This account has no Media Library it may add to.");
    if ("error" in saved) throw new Error(saved.error);
    const assetId = "duplicateOf" in saved ? saved.duplicateOf : saved.assetId;
    const a = libraryDb().prepare("SELECT library_id, current_version_id FROM assets WHERE id = ?").get(assetId) as { library_id: string; current_version_id: string };
    const href = `/library?library=${a.library_id}&asset=${assetId}`;
    return { to, id: assetId, versionId: a.current_version_id, libraryId: a.library_id, name: title, href, ...("duplicateOf" in saved ? { note: "Already in the Media Library" } : {}) };
  }
  if (to === "review") {
    const added = await addVersion(undefined, { owner: user.username, name: title, mime: meta.mime, bytes: meta.size }, (dest) => linkOrCopy(file, dest));
    if (!added) throw new Error("Review couldn't take it.");
    return { to, id: added.meta.id, name: title, href: `/review/${added.meta.id}` };
  }
  // Caption Studio builds its editing copy first: a long file can take minutes, so the answer doesn't wait past 40 s
  const job = createProjectFromFile({ owner: user.username, name: title, clipName: meta.name, file, duration: await probeDuration(file) });
  const made = await Promise.race([job, new Promise<null>((r) => setTimeout(() => r(null), 40_000))]);
  // ponytail: no id until the copy is built; the project list shows it then
  if (!made) return { to, id: "", name: title, href: "/captions?view=projects", note: "Still preparing: it shows in Caption Studio's projects in a few minutes." };
  return { to, id: made.projectId, name: title, href: `/captions?project=${made.projectId}` };
}

assistantFilesApp.post("/:id/use", async (c) => {
  const b = (await c.req.json().catch(() => null)) as { to?: unknown; name?: unknown } | null;
  const to = b?.to as AssistantFileUse;
  if (!FILE_USES.includes(to)) return c.json({ error: `to is one of ${FILE_USES.join(", ")}` }, 400);
  try {
    return c.json(await useFile(c.get("user"), c.req.param("id"), to, typeof b?.name === "string" ? b.name : undefined));
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 409);
  }
});
