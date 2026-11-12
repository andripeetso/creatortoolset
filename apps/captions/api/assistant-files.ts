import { Hono } from "hono";
import { randomBytes, randomUUID } from "node:crypto";
import { readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AuthVars } from "./auth";
import { env } from "./lib/env";
import { assembleParts, MAX_UPLOAD_BYTES, PART_SIZE, partCount, partsStatus, readUploadState, receivedParts, receivePart, startUpload } from "./lib/uploads";
import { mayUse, type SessionUser } from "./users";
import { notesFromFile, probeDuration } from "./clips";
import { addVersion, notifyNewVersion, readMeta as readReview } from "./review";
import { createProjectFromFile, linkOrCopy } from "./projects";
import { captionEngine, captionInBackground } from "./captions-job";
import { ensureLibrary } from "./library/access";
import { libraryDb } from "./library/db";
import { saveToLibrary } from "./library/routes";
import { mainSource } from "./library/sources";
import { FILE_USES, type AssistantFile, type AssistantFileUse } from "../contracts/assistant";

/**
 * Videos and recordings dropped in the assistant's chat (owner, 2026-11-07: "drop in a random screen recording…
 * hey, caption this, put this up"). The dock uploads each one here in parts, and the message may go before the last one (assistant.ts waits for it);
 * the message names it by id, and the assistant's use_file tool (mcp.ts) hands it to Video Notes, Review or Caption
 * Studio as the same file under a second name (no copy). A file is kept 7 days: what used it keeps its own name for it.
 * $DATA_DIR/assistant/files/<user>/<id>/{file, meta.json} (parts/ while it uploads).
 */

export const assistantFilesApp = new Hono<{ Variables: AuthVars }>();

const KEEP_MS = 7 * 24 * 3600_000;
/** An upload that gets no part for this long is nobody's any more: the sweep removes it. */
export const ORPHAN_MS = 3600_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Footage only: a video or a recording's sound. */
export const isMedia = (mime: string, name: string) => /^(video|audio)\//.test(mime) || /\.(mp4|mov|m4v|webm|mkv|avi|mp3|m4a|wav|aac|ogg)$/i.test(name);

const rootOf = (user: string) => path.join(env.dataDir, "assistant", "files", user);
const dirOf = (user: string, id: string) => path.join(rootOf(user), id);
/** Where a dropped file is kept (a plug-in hands it on, e.g. to a Mac that fetches it). */
export const fileOf = (user: string, id: string) => path.join(dirOf(user, id), "file");

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

/** The uploads a waiting message names (assistant.ts registers it: this file can't import that one). */
let waitedFor: (user: string) => Set<string> = () => new Set();
export const setWaitedFor = (f: (user: string) => Set<string>): void => void (waitedFor = f);

/**
 * This account's files older than 7 days go, and uploads with no part for an hour, unless a waiting message names one: its
 * own clock ends that message (a phone put away mid-upload keeps it). Each new upload sweeps its own account; sweepAll every hour.
 */
export async function sweep(user: string): Promise<void> {
  const waited = waitedFor(user);
  for (const id of await readdir(rootOf(user)).catch(() => [] as string[])) {
    const st = await stat(dirOf(user, id)).catch(() => null);
    const parts = waited.has(id) ? null : await stat(path.join(dirOf(user, id), "parts")).catch(() => null);
    if ((st && Date.now() - st.mtimeMs > KEEP_MS) || (parts && Date.now() - parts.mtimeMs > ORPHAN_MS)) await rm(dirOf(user, id), { recursive: true, force: true });
  }
}

/** Every account's sweep (boot.ts runs it at start and every hour). */
export async function sweepAll(): Promise<void> {
  const root = path.join(env.dataDir, "assistant", "files");
  for (const user of await readdir(root).catch(() => [] as string[])) await sweep(user);
}

/** One of this account's dropped files, uploading or in, removed (a strict id only). false when there was none. */
export async function removeFile(user: string, id: string): Promise<boolean> {
  if (!UUID.test(id) || !(await stat(dirOf(user, id)).catch(() => null))) return false;
  // a part may still be landing in parts/ (Stop during an upload): rm retries the ENOTEMPTY that race gives
  await rm(dirOf(user, id), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  return true;
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

/** The X on a file: its upload stops being kept, parts or the finished file (own account only). */
assistantFilesApp.delete("/:id", async (c) => ((await removeFile(c.get("user").username, c.req.param("id"))) ? c.json({ ok: true }) : c.json({ error: "Not found" }, 404)));

assistantFilesApp.get("/:id/parts", (c) => {
  const id = c.req.param("id");
  if (!UUID.test(id)) return c.json({ error: "Not found" }, 404);
  return partsStatus(c, path.join(dirOf(c.get("user").username, id), "parts"), c.get("user"));
});

assistantFilesApp.post("/:id/parts/:partNumber", async (c) => {
  const id = c.req.param("id");
  if (!UUID.test(id)) return c.json({ error: "Invalid part" }, 400);
  const user = c.get("user").username;
  const r = await receivePart(c, path.join(dirOf(user, id), "parts"), c.get("user"));
  // the last part joins the file: a phone locked before it can say /complete still gets its video in
  if (r.status === 200 && (await allPartsIn(user, id))) void finishUpload(user, id);
  return r;
});

/**
 * The upload of one dropped file joined into its file, once: /complete and a turn waiting on the file (assistant.ts, after
 * its last part lands) both come here, and a second caller gets the same promise. An error carries the answer's status.
 */
/** Told once a dropped file is whole: assistant.ts marks the messages that carry it, a plug-in starts what waited for it. */
export const onFileIn: Array<(user: string, file: AssistantFile) => void> = [];

const finishing = new Map<string, Promise<AssistantFile | { error: string; status: 400 | 409 }>>();
export function finishUpload(user: string, id: string): Promise<AssistantFile | { error: string; status: 400 | 409 }> {
  const key = `${user}/${id}`;
  const running = finishing.get(key);
  if (running) return running;
  const p = (async () => {
    const done = await readFileMeta(user, id);
    if (done) return done;
    const parts = UUID.test(id) ? path.join(dirOf(user, id), "parts") : "";
    const state = parts ? await readUploadState(parts) : null;
    if (!state || state.owner !== user) return { error: "No upload in progress", status: 409 as const };
    try {
      await assembleParts(parts, fileOf(user, id), state);
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e), status: 400 as const };
    }
    const meta: AssistantFile = { id, name: state.name, mime: state.mime, size: state.total };
    await writeFile(path.join(dirOf(user, id), "meta.json"), JSON.stringify({ ...meta, at: Date.now() }), { mode: 0o600 });
    await rm(parts, { recursive: true, force: true });
    for (const f of onFileIn) {
      try {
        f(user, meta);
      } catch (e) {
        console.error("[assistant-files] a file-in hook:", e);
      }
    }
    return meta;
  })().finally(() => finishing.delete(key));
  finishing.set(key, p);
  return p;
}

/** Whether every part of this account's upload is in (a turn waits on it: the server joins it without waiting for /complete). */
export async function allPartsIn(user: string, id: string): Promise<boolean> {
  const parts = UUID.test(id) ? path.join(dirOf(user, id), "parts") : "";
  const state = parts ? await readUploadState(parts) : null;
  return !!state && state.owner === user && (await receivedParts(parts, state)).length === partCount(state.total, state.partSize);
}

/**
 * One of this account's dropped files as a message can take it: done (`file`), still uploading (its name, and when its
 * last part landed), or null (no such file of theirs).
 */
export async function uploadOf(user: string, id: string): Promise<{ file: AssistantFile } | { name: string; at: number } | null> {
  const file = await readFileMeta(user, id);
  if (file) return { file };
  const parts = UUID.test(id) ? path.join(dirOf(user, id), "parts") : "";
  const state = parts ? await readUploadState(parts) : null;
  if (!state || state.owner !== user) return null;
  return { name: state.name, at: (await stat(parts).catch(() => null))?.mtimeMs ?? 0 };
}

/* ---- an upload by link: the user's own AI on a computer the server isn't on (MCP upload_file) sends a file with curl ---- */

const LINK_MS = 3600_000;
const links = new Map<string, { user: string; id: string; expires: number }>();

/** A link for one upload of this account's, good for an hour after its last part. */
export function uploadLink(user: string, id: string): string {
  const now = Date.now();
  for (const [k, v] of links) if (v.expires <= now) links.delete(k);
  const token = `ctu_${randomBytes(24).toString("hex")}`;
  links.set(token, { user, id, expires: now + LINK_MS });
  return token;
}

/**
 * PUT /api/upload/:token/:n, before the account gate: the link is the only credential, for one upload's parts. The
 * sizes come from the upload itself; a part's length is checked before its body is read. The last part joins the file.
 */
export const uploadLinkApp = new Hono();
uploadLinkApp.put("/:token/:partNumber", async (c) => {
  const link = links.get(c.req.param("token"));
  if (!link || link.expires <= Date.now()) return c.json({ error: "This upload link has expired: ask for a new one" }, 404);
  const r = await receivePart(c, path.join(dirOf(link.user, link.id), "parts"), { username: link.user, role: "user" }, true);
  if (r.status !== 200) return r;
  link.expires = Date.now() + LINK_MS;
  if (await allPartsIn(link.user, link.id)) await finishUpload(link.user, link.id);
  return r;
});

assistantFilesApp.post("/:id/complete", async (c) => {
  const r = await finishUpload(c.get("user").username, c.req.param("id"));
  return "error" in r ? c.json({ error: r.error }, r.status) : c.json(r);
});

const TOOL_OF = { notes: "notes", review: "review", captions: "captions", library: "media" } as const;
const MIME: Record<string, string> = {
  mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime", webm: "video/webm", mkv: "video/x-matroska", avi: "video/x-msvideo",
  mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav", aac: "audio/aac", ogg: "audio/ogg",
};

/** A video or recording's type by its name's extension (video/mp4 when unknown). */
export const mimeOf = (name: string) => MIME[path.extname(name).slice(1).toLowerCase()] ?? "video/mp4";

/**
 * A file on this computer by its path, taken like a dropped one: only when the server runs on the user's own Mac
 * (CT_LOCAL=1), so the assistant can point at footage where it lies and nothing is uploaded. A hard link on the same
 * disk; a file on another drive is copied once.
 */
export async function fileFromPath(user: string, p: string): Promise<AssistantFile> {
  if (process.env.CT_LOCAL !== "1") throw new Error("This server isn't on your computer: drop the file in the chat so it uploads, or send it with upload_file.");
  if (!path.isAbsolute(p)) throw new Error("Give the file's full path, such as /Users/you/Movies/clip.mov.");
  const st = await stat(p).catch(() => null);
  if (!st?.isFile() || !st.size) throw new Error(`There's no file at ${p}.`);
  const name = path.basename(p);
  // ponytail: footage by its extension only; probe the streams if something else ever passes for a video
  if (!isMedia("", name)) throw new Error(`${name} isn't a video or a recording.`);
  const id = randomUUID();
  await linkOrCopy(p, fileOf(user, id));
  const meta: AssistantFile = { id, name, mime: mimeOf(name), size: st.size };
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

export const USE_NAMES: Record<AssistantFileUse, string> = { notes: "Video Notes", review: "Review", captions: "Caption Studio", library: "Media Library" };

/** How long use_file waits for a video still uploading before it says to call again (a test shortens it). */
export const ARRIVAL = { ms: 50_000 };

/** A dropped file still on its way: waited for a while (ARRIVAL), then said to be still uploading, or gone. */
async function arrival(user: string, id: string): Promise<AssistantFile> {
  const end = Date.now() + ARRIVAL.ms;
  for (;;) {
    const up = await uploadOf(user, id);
    if (!up) throw new Error("That file isn't here any more (dropped files are kept 7 days): ask for it again.");
    if ("file" in up) return up.file;
    if (Date.now() >= end) throw new Error(`"${up.name}" is still uploading from the phone: call use_file with it again in a minute (nothing is lost).`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/**
 * Hand a dropped file to a tool; answers what it became and its page. versionOf (Review only): the id of a Review
 * video of this account's own, which gets the file as its next version instead of a new video being made.
 */
export async function useFile(
  user: SessionUser,
  id: string,
  to: AssistantFileUse,
  name?: string,
  versionOf?: string,
): Promise<{ to: AssistantFileUse; id: string; name: string; href: string; note?: string; version?: number; versionId?: string; libraryId?: string; captioning?: boolean }> {
  const meta = (await readFileMeta(user.username, id)) ?? (await arrival(user.username, id));
  if (!mayUse(user, TOOL_OF[to])) throw new Error(`${USE_NAMES[to]} isn't switched on for this account.`);
  if (versionOf && to !== "review") throw new Error("Only a Review video takes a next version.");
  const file = fileOf(user.username, id);
  const title = (name?.trim() || meta.name).slice(0, 120);
  if (to === "notes") {
    const made = await notesFromFile(file, title, meta.mime, user);
    return { to, id: made.id, name: title, href: `/video-notes/${made.id}` };
  }
  if (to === "library") {
    // where a plug-in's source is the Media Library, the page never shows the storage library: nothing goes where nobody looks
    const main = mainSource();
    if (main) throw new Error(`On this server the Media Library is the ${main.label}, and files go in on its own page (/library): open it and add them there.`);
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
    // a fix for a video already there: its next version, and only on the owner's own video
    const of = versionOf ? await readReview(versionOf) : null;
    if (versionOf && of?.owner !== user.username) throw new Error("That Review video isn't here, or isn't this account's.");
    const added = await addVersion(of?.id, { owner: user.username, name: title, mime: meta.mime, bytes: meta.size }, (dest) => linkOrCopy(file, dest));
    if (!added) throw new Error("Review couldn't take it.");
    if (!of) return { to, id: added.meta.id, name: title, href: `/review/${added.meta.id}` };
    // the people who commented hear of the new version, as they do when it is uploaded on the page
    await notifyNewVersion(added.meta, user.username, added.n);
    return { to, id: of.id, name: added.meta.name, href: `/review/${of.id}?v=${added.n}`, version: added.n, note: `Version ${added.n} of “${added.meta.name}”` };
  }
  // Caption Studio: the project is there at once, with its id; its editing copy and its captions are made behind the
  // answer (captions-job.ts), and the chat says when they are ready. It can be opened at once: the page shows that
  // the captions are being made instead of Transcribe, and takes them when they land (src/lib/persist.ts)
  const made = await createProjectFromFile({ owner: user.username, name: title, clipName: meta.name, file, duration: await probeDuration(file), later: true });
  const project = { to, id: made.projectId, name: title, href: `/captions?project=${made.projectId}` };
  const route = captionEngine(user);
  // nothing on this server transcribes for them: said in the route's own words (on the page, their browser still can)
  if ("refused" in route) return { ...project, note: `Not transcribed: ${route.refused}. On the project's page, Transcribe runs in the browser and needs no key.` };
  captionInBackground(user, made.projectId, made.clipId, title, route.engine);
  return { ...project, captioning: true, note: "Being prepared and transcribed: the chat says when the captions are ready." };
}

assistantFilesApp.post("/:id/use", async (c) => {
  const b = (await c.req.json().catch(() => null)) as { to?: unknown; name?: unknown; version_of?: unknown } | null;
  const to = b?.to as AssistantFileUse;
  if (!FILE_USES.includes(to)) return c.json({ error: `to is one of ${FILE_USES.join(", ")}` }, 400);
  try {
    return c.json(await useFile(c.get("user"), c.req.param("id"), to, typeof b?.name === "string" ? b.name : undefined, typeof b?.version_of === "string" && b.version_of ? b.version_of : undefined));
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 409);
  }
});
