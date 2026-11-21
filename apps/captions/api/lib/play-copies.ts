import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Context } from "hono";
import type { BlobStore } from "../library/storage/types";
import { env } from "./env";
import { pluginPlayCopies } from "./plugin";

/*
 * Playback copies on a plug-in's CDN (ServerPlugin.playCopies). As soon as this server has a new Review version's file, or a
 * version becomes a Final, the file is pushed there in the background, and from then on its /play answers with a fresh
 * signed link to the copy. Until the push lands, or whenever the store fails, the server streams the file as before; a
 * play that finds no copy pushes one again. The server's own file always stays: the copy is only for speed.
 * A copy lives while its owner wants it (wantCopies): a deleted, trashed or rejected version's copy goes at once, and a
 * sweep deletes the rest that are no longer wanted, among them copies older than COPY_DAYS that aren't kept for good.
 * Without a plug-in's store nothing here runs: no push, no sweep, /play as before.
 */

/** Days a copy stays after its push, unless its owner keeps it for good (an approved version, a Final). */
export const COPY_DAYS = 14;
/** A signed link lasts about a day (23–24 h), so a paused video still resumes; every /play signs one. A copy deleted from
 *  Storage can still play from the CDN's cache through a link already given out, until that link expires. */
const LINK_SECONDS = 24 * 3600;
/** How long a copy that was checked is trusted before Storage is asked again whether it is still there. */
const CHECKED_MS = 10 * 60_000;
/** A push that failed waits this long before the next try. */
const RETRY_MS = 3600_000;
/** Storage has this long to say whether a copy is there before /play streams instead. */
const STAT_MS = 3000;
/** A copy this new may have landed while a player was already reading the file from this server (see playCopy). */
const LANDING_MS = 10 * 60_000;
/** A push still going after this is given up, so one stalled upload never holds up the others. */
const PUT_MS = 30 * 60_000;
const DAY_MS = 86_400_000;
const ROOT = "play-copies";
// The pull zone serves a file with the type its name's extension says, so only these go.
const EXT: Record<string, string> = { "video/mp4": ".mp4", "video/quicktime": ".mov", "video/webm": ".webm", "video/x-m4v": ".m4v" };

/** Whether a copy pushed at `at` is still inside its COPY_DAYS. */
export const copyIsFresh = (at: number): boolean => Date.now() - at < COPY_DAYS * DAY_MS;

type Held = Record<string, { bytes: number; at: number }>;
const recordPath = () => path.join(env.dataDir, "play-copies.json");
let held: Held | null = null;
let loading: Promise<Held> | null = null;
let saving: Promise<void> = Promise.resolve();

/** The record, read from disk once (every caller shares that one read). */
function record(): Promise<Held> {
  return (loading ??= readFile(recordPath(), "utf-8")
    .catch(() => "{}")
    .then((text) => (held = JSON.parse(text) as Held)));
}

/** `p`, or a rejection after `ms`. */
const within = <T>(p: Promise<T>, ms: number): Promise<T> =>
  Promise.race([p, new Promise<never>((_, no) => setTimeout(() => no(new Error(`no answer in ${ms / 1000} s`)), ms).unref())]);

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

type Wanted = (parts: string[], pushedAt: number) => boolean | Promise<boolean>;
const owners: { prefix: string; wanted: Wanted }[] = [];

/** Who keeps copies under `<prefix>/…`: `wanted` gets the name's parts after the prefix and when the copy was pushed (now,
 *  for one not pushed yet) and says whether it stays. */
export function wantCopies(prefix: string, wanted: Wanted): void {
  owners.push({ prefix, wanted });
}

/** Whether the owner of `key` wants it; a key no owner claims (its module isn't loaded) is kept and never pushed. */
async function wants(key: string, pushedAt: number): Promise<boolean | null> {
  const parts = key.split("/").slice(1, -1); // play-copies/<prefix>/<…>/<size.ext>
  const owner = owners.find((o) => o.prefix === parts[0]);
  return owner ? await Promise.resolve(owner.wanted(parts.slice(1), pushedAt)).catch(() => true) : null;
}

const checked = new Map<string, number>();
const pushing = new Set<string>();
const failed = new Map<string, number>();
let line: Promise<void> = Promise.resolve();

/** The copy's key: the size is in it, so a file made again (a new proxy) is a new object, never a stale one from the CDN's cache. */
async function keyOf(name: string, file: string, type: string): Promise<{ key: string; bytes: number } | null> {
  const ext = EXT[type.split(";")[0]!.trim().toLowerCase()];
  const st = ext ? await stat(file).catch(() => null) : null;
  return st ? { key: `${ROOT}/${name}/${st.size}${ext}`, bytes: st.size } : null;
}

/**
 * Pushes `file` (what `name`'s /play sends) to the store in the background, one at a time, unless it is there already,
 * on its way, or not wanted. Does nothing without a store.
 */
export async function pushPlayCopy(name: string, file: string, type: string): Promise<void> {
  const store = pluginPlayCopies();
  const k = store?.caps.signedUrls ? await keyOf(name, file, type) : null;
  if (!store || !k || (await record())[k.key]) return;
  pushLater(store, k.key, file, type, k.bytes);
}

function pushLater(store: BlobStore, key: string, file: string, type: string, bytes: number): void {
  if (pushing.has(key) || Date.now() - (failed.get(key) ?? 0) < RETRY_MS) return;
  pushing.add(key);
  line = line.then(async () => {
    const tmp = path.join(env.dataDir, "play-copies-tmp", randomUUID());
    try {
      if (!(await wants(key, Date.now()))) return; // rejected, gone or not a Final by now
      await mkdir(path.dirname(tmp), { recursive: true });
      // put() takes the file it is given: a hard link, so the server's own file stays and no bytes are copied on disk
      // shortcut: a file on another disk than DATA_DIR can't be linked, so it is never pushed; copy it to tmp if that matters
      await link(file, tmp);
      const put = store.put(key, tmp, { contentType: type });
      await within(put, PUT_MS).catch((e) => {
        put.then(() => store.delete(key)).catch(() => {}); // a push given up leaves nothing behind once it ends
        throw e;
      });
      const all = await record();
      all[key] = { bytes, at: Date.now() };
      checked.set(key, Date.now());
      failed.delete(key);
      await save();
      // the same version's older copy (its play file was made again: a new size) goes, so nothing kept for good piles up
      const name = key.slice(0, key.lastIndexOf("/") + 1);
      for (const old of Object.keys(all).filter((k) => k !== key && k.startsWith(name))) {
        await store.delete(old).then(() => void delete all[old], (e) => console.error(`[play-copies] delete ${old}:`, e instanceof Error ? e.message : e));
      }
      await save();
      await sweepPlayCopies([key]); // its version may have gone while the push was on its way
    } catch (e) {
      failed.set(key, Date.now());
      console.error(`[play-copies] push ${key}:`, e instanceof Error ? e.message : e);
    } finally {
      await rm(tmp, { force: true }).catch(() => {});
      pushing.delete(key);
    }
  });
}

/**
 * /play's answer from the copy of `file` named `name` (like `review/<asset>/<version>`): a 302 to a fresh signed link when
 * the copy is there, else null (the caller streams the file) and a push is started. Called only after the route's checks.
 */
export async function playCopy(c: Context, name: string, file: string, type: string): Promise<Response | null> {
  const store = pluginPlayCopies();
  // a CORS load (a canvas or sound graph reading the media) stays on this origin: the pull zone may send no CORS headers
  if (!store?.caps.signedUrls || c.req.header("sec-fetch-mode") === "cors") return null;
  const k = await keyOf(name, file, type);
  if (!k) return null;
  const { key } = k;
  try {
    const got = (await record())[key];
    if (!got) {
      pushLater(store, key, file, type, k.bytes);
      return null;
    }
    // a copy that just landed takes only a load from the start: a player already reading this file from the server keeps
    // reading here, since a media load may refuse bytes from a second origin midway (not seen in a browser yet)
    if (Date.now() - got.at < LANDING_MS && !/^bytes=0-/.test(c.req.header("range")?.trim() ?? "bytes=0-")) return null;
    if (Date.now() - (checked.get(key) ?? 0) > CHECKED_MS) {
      if (!(await within(store.stat(key), STAT_MS))) {
        delete held![key]; // gone from Storage (deleted by hand): pushed again, streamed meanwhile
        checked.delete(key);
        void save();
        pushLater(store, key, file, type, k.bytes);
        return null;
      }
      checked.set(key, Date.now());
    }
    // the expiry is rounded down to the hour, so the same link comes back within an hour and the browser reuses its bytes
    const now = Math.floor(Date.now() / 1000);
    const at = await store.locate(key, Math.floor((now + LINK_SECONDS) / 3600) * 3600 - now);
    if (at.kind !== "url") return null;
    c.header("Cache-Control", "no-store");
    return c.redirect(at.url, 302);
  } catch (e) {
    console.error(`[play-copies] ${key}:`, e instanceof Error ? e.message : e);
    return null;
  }
}

/**
 * Deletes every copy whose owner no longer wants it, among the names starting with one of `within` (all when left out).
 * Only copies the record holds are ever deleted. One whose delete fails stays in the record and goes on a later sweep.
 */
export async function sweepPlayCopies(within?: string[]): Promise<void> {
  const store = pluginPlayCopies();
  if (!store) return;
  const all = await record();
  const keys = Object.keys(all).filter((k) => !within || within.some((w) => k.startsWith(w.startsWith(`${ROOT}/`) ? w : `${ROOT}/${w}`)));
  let changed = false;
  for (const key of keys) {
    if ((await wants(key, all[key]!.at)) !== false) continue;
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

/** Waits for the pushes in flight (tests). */
export const copiesSettled = async (): Promise<void> => {
  await line;
  await saving;
};

// The daily sweep that ends copies past COPY_DAYS. Deploys restart this server many times a day, so the first one runs
// ten minutes after a start, not a day later. Without a store it returns at once.
const sweepAll = () => void sweepPlayCopies().catch((e) => console.error("[play-copies] sweep:", e));
setTimeout(sweepAll, 10 * 60_000).unref();
setInterval(sweepAll, DAY_MS).unref();
