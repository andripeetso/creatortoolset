import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Context } from "hono";
import type { BlobStore } from "../library/storage/types";
import { env } from "./env";
import { pluginPlayCopies } from "./plugin";

/*
 * Playback copies on a plug-in's CDN (ServerPlugin.playCopies). The first time someone plays a Review version or a Final
 * from this server, the file is copied there in the background, and from then on its /play answers with a fresh signed
 * link to the copy. Until the copy is in, or whenever the store fails, the server streams the file as before.
 * A copy lives only as long as its owner wants it (wantCopies): a sweep deletes the rest, so a version that is deleted,
 * trashed or purged loses its copy too. Nothing else expires.
 */

/** A signed link lasts a day, so a paused video still resumes; every /play signs a new one. */
const LINK_SECONDS = 24 * 3600;
/** How long a copy that was checked is trusted before Storage is asked again whether it is still there. */
const CHECKED_MS = 10 * 60_000;
/** A copy that failed waits this long before the next play tries again. */
const RETRY_MS = 3600_000;
const ROOT = "play-copies";
// The pull zone serves a file with the type its name's extension says, so only these go.
const EXT: Record<string, string> = { "video/mp4": ".mp4", "video/quicktime": ".mov", "video/webm": ".webm", "video/x-m4v": ".m4v" };

type Held = Record<string, { bytes: number; at: number }>;
const recordPath = () => path.join(env.dataDir, "play-copies.json");
let held: Held | null = null;
let saving: Promise<void> = Promise.resolve();

async function record(): Promise<Held> {
  return (held ??= JSON.parse(await readFile(recordPath(), "utf-8").catch(() => "{}")) as Held);
}

/** The record as it is now, written whole (one write at a time, through a temp file). */
function save(): Promise<void> {
  const text = JSON.stringify(held ?? {});
  saving = saving
    .then(async () => {
      const tmp = `${recordPath()}.${randomUUID()}.tmp`;
      await writeFile(tmp, text);
      await rename(tmp, recordPath());
    })
    .catch((e) => console.error("[play-copies] record:", e));
  return saving;
}

const owners: { prefix: string; wanted: (parts: string[]) => boolean | Promise<boolean> }[] = [];

/** Who keeps copies under `<prefix>/…`: `wanted` gets the name's parts after the prefix and says whether its copy stays. */
export function wantCopies(prefix: string, wanted: (parts: string[]) => boolean | Promise<boolean>): void {
  owners.push({ prefix, wanted });
}

const checked = new Map<string, number>();
const copying = new Set<string>();
const failed = new Map<string, number>();
let line: Promise<void> = Promise.resolve();

/**
 * /play's answer from the copy of `file` named `name` (like `review/<asset>/<version>`): a 302 to a fresh signed link when
 * the copy is there, else null (the caller streams the file) and the copy is started. Called only after the route's checks.
 */
export async function playCopy(c: Context, name: string, file: string, type: string): Promise<Response | null> {
  const store = pluginPlayCopies();
  // a CORS load (a canvas or sound graph reading the media) stays on this origin: the pull zone may send no CORS headers
  if (!store?.caps.signedUrls || c.req.header("sec-fetch-mode") === "cors") return null;
  const ext = EXT[type.split(";")[0]!.trim().toLowerCase()];
  const st = ext ? await stat(file).catch(() => null) : null;
  if (!st) return null;
  // the size is in the key: a file made again (a new proxy) is a new object, never a stale one from the CDN's cache
  const key = `${ROOT}/${name}/${st.size}${ext}`;
  try {
    if (!(await record())[key]) return copyLater(store, key, file, type, st.size);
    if (Date.now() - (checked.get(key) ?? 0) > CHECKED_MS) {
      if (!(await store.stat(key))) {
        delete held![key]; // gone from Storage (deleted by hand): copied again, streamed meanwhile
        checked.delete(key);
        void save();
        return copyLater(store, key, file, type, st.size);
      }
      checked.set(key, Date.now());
    }
    const at = await store.locate(key, LINK_SECONDS);
    if (at.kind !== "url") return null;
    c.header("Cache-Control", "no-store");
    return c.redirect(at.url, 302);
  } catch (e) {
    console.error(`[play-copies] ${key}:`, e instanceof Error ? e.message : e);
    return null;
  }
}

/** Copies the file in the background, one at a time; null, so this play streams. */
function copyLater(store: BlobStore, key: string, file: string, type: string, bytes: number): null {
  if (copying.has(key) || Date.now() - (failed.get(key) ?? 0) < RETRY_MS) return null;
  copying.add(key);
  line = line.then(async () => {
    const tmp = path.join(env.dataDir, "play-copies-tmp", randomUUID());
    try {
      await mkdir(path.dirname(tmp), { recursive: true });
      // put() takes the file it is given: a hard link, so the server's own file stays and no bytes are copied on disk
      // shortcut: a file on another disk than DATA_DIR can't be linked, so it is never copied; copy it to tmp if that matters
      await link(file, tmp);
      await store.put(key, tmp, { contentType: type });
      (await record())[key] = { bytes, at: Date.now() };
      checked.set(key, Date.now());
      failed.delete(key);
      await save();
      await sweepPlayCopies([key]); // its version may have gone while the copy was on its way
    } catch (e) {
      failed.set(key, Date.now());
      console.error(`[play-copies] copy ${key}:`, e instanceof Error ? e.message : e);
    } finally {
      await rm(tmp, { force: true }).catch(() => {});
      copying.delete(key);
    }
  });
  return null;
}

/**
 * Deletes every copy whose owner no longer wants it, among the names starting with one of `within` (all when left out).
 * A copy whose delete fails stays in the record and goes on a later sweep; one no owner claims (its module isn't loaded) stays.
 */
export async function sweepPlayCopies(within?: string[]): Promise<void> {
  const store = pluginPlayCopies();
  const all = await record();
  const keys = Object.keys(all).filter((k) => !within || within.some((w) => k.startsWith(w.startsWith(`${ROOT}/`) ? w : `${ROOT}/${w}`)));
  if (!store || !keys.length) return;
  let changed = false;
  for (const key of keys) {
    const parts = key.split("/").slice(1, -1); // play-copies/<prefix>/<…>/<size.ext>
    const owner = owners.find((o) => o.prefix === parts[0]);
    if (!owner || (await Promise.resolve(owner.wanted(parts.slice(1))).catch(() => true))) continue;
    try {
      await store.delete(key);
      delete all[key];
      checked.delete(key);
      changed = true;
    } catch (e) {
      console.error(`[play-copies] delete ${key}:`, e instanceof Error ? e.message : e);
    }
  }
  if (changed) await save();
}

/** The copies the record holds (tests). */
export const heldCopies = async (): Promise<string[]> => Object.keys(await record());

/** Waits for the copies in flight (tests). */
export const copiesSettled = (): Promise<void> => line.then(() => saving);

setInterval(() => void sweepPlayCopies().catch((e) => console.error("[play-copies] sweep:", e)), 3600_000).unref();
