import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";
import { useAuth } from "./auth";
import { boot, onTopic, seqNow, syncReady, topicOf, whenVisible } from "./sync";

/**
 * Last-known data for every screen, kept on this device so a screen paints on its first frame and never waits on the
 * network (stale-while-revalidate, kept live by the server's change notices: lib/sync.ts). Keyed by the signed-in
 * account and a key that names the list (a URL, with its query: a project's lists stay apart), so another account
 * never sees it. JSON only, never media and never tokens.
 *
 * Memory is the truth: every read is synchronous. IndexedDB keeps it across launches: hydrateLocalCache() reads it all
 * back before the first render (main.tsx), and writes go to disk a moment later, batched. Without IndexedDB (tests, a
 * locked-down window) it lives for the session only. Sign-out clears it (clearLocalCache); warmScreens
 * (lib/warm-cache.ts) fills it right after sign-in.
 *
 * Each list remembers the change it was read at (`seq`, `boot`): a notice for its topic with a newer seq refetches
 * it, once, however many screens show it.
 */
const PREFIX = "ct-swr:";
/** AuthGate's own snapshot of the last sign-in check: read synchronously before boot, so it stays in localStorage. */
const AUTH_KEY = "ct-swr:auth";
const DB = "ct-local";
const STORE = "lists";

type Meta = { seq: number; boot: string };
const mem = new Map<string, unknown>();
const meta = new Map<string, Meta>();
const versions = new Map<string, number>();
let epoch = 0;

const keyOf = (user: string, url: string) => `${PREFIX}${encodeURIComponent(user)}|${url}`;
const urlOf = (k: string) => k.slice(k.indexOf("|") + 1);
const stamp = (k: string) => `${epoch}.${versions.get(k) ?? 0}`;
const touch = (k: string) => versions.set(k, (versions.get(k) ?? 0) + 1);

// ---- disk (IndexedDB), write-behind
let dbp: Promise<IDBDatabase | null> | null = null;
function db(): Promise<IDBDatabase | null> {
  if (dbp) return dbp;
  dbp = new Promise((resolve) => {
    try {
      if (typeof indexedDB === "undefined") return resolve(null);
      const open = indexedDB.open(DB, 1);
      open.onupgradeneeded = () => open.result.createObjectStore(STORE);
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => resolve(null);
      open.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbp;
}

const dirty = new Set<string>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
function persist(k: string) {
  dirty.add(k);
  flushTimer ??= setTimeout(() => void flush(), 250);
}
async function flush() {
  flushTimer = null;
  const keys = [...dirty];
  dirty.clear();
  const d = await db();
  if (!d || !keys.length) return;
  try {
    const tx = d.transaction(STORE, "readwrite");
    const st = tx.objectStore(STORE);
    for (const k of keys) {
      if (mem.has(k) && mem.get(k) !== null) st.put({ v: mem.get(k), m: meta.get(k) ?? null }, k);
      else st.delete(k);
    }
  } catch {
    /* disk full or closed: this session keeps it in memory */
  }
}
// a reload or quit flushes what is still waiting
if (typeof window !== "undefined") window.addEventListener("pagehide", () => void flush());

/** Before the first render: everything saved on this device into memory, and older localStorage copies moved over. */
export async function hydrateLocalCache(): Promise<void> {
  const d = await db();
  if (d) {
    await new Promise<void>((resolve) => {
      try {
        const req = d.transaction(STORE, "readonly").objectStore(STORE).openCursor();
        req.onsuccess = () => {
          const cur = req.result;
          if (!cur) return resolve();
          const rec = cur.value as { v: unknown; m: Meta | null };
          const k = String(cur.key);
          if (!mem.has(k)) {
            mem.set(k, rec.v);
            if (rec.m) meta.set(k, rec.m);
          }
          cur.continue();
        };
        req.onerror = () => resolve();
      } catch {
        resolve();
      }
    });
  }
  // the old localStorage copies (before IndexedDB): read once, kept in memory, written to disk, removed
  for (const k of localKeys()) {
    if (k === AUTH_KEY) continue;
    try {
      const raw = localStorage.getItem(k);
      if (raw !== null && !mem.has(k)) {
        mem.set(k, JSON.parse(raw));
        if (d) persist(k);
      }
      if (d) localStorage.removeItem(k);
    } catch {
      /* unreadable: skipped */
    }
  }
}

function localKeys(): string[] {
  try {
    const out: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith(PREFIX)) out.push(k);
    }
    return out;
  } catch {
    return [];
  }
}

function read<T>(k: string): T | null {
  return (mem.get(k) as T | undefined) ?? null;
}

function write(k: string, v: unknown, at?: Meta) {
  mem.set(k, v);
  if (at) meta.set(k, at);
  touch(k);
  persist(k);
  for (const l of watchers.get(k) ?? []) l();
}

function drop(k: string) {
  mem.delete(k);
  meta.delete(k);
  touch(k);
  persist(k);
  for (const l of watchers.get(k) ?? []) l();
}

// ---- one fetch per list, however many screens show it
const watchers = new Map<string, Set<() => void>>();
const inflight = new Map<string, Promise<unknown>>();
/** the seq a running fetch started at: a change at or before it is already in what it brings back */
const inflightAt = new Map<string, Meta>();
const again = new Set<string>();

/**
 * Fetches a key now, or joins the fetch already running. `changedAt` is the seq of a change that must be in the
 * answer: a running fetch that started before it runs once more after (a plain join never does).
 */
function fetchInto<T>(k: string, load: () => Promise<T>, changedAt?: number): Promise<T> {
  const running = inflight.get(k) as Promise<T> | undefined;
  if (running) {
    const at = inflightAt.get(k);
    if (changedAt !== undefined && (!at || at.boot !== boot() || at.seq < changedAt)) again.add(k);
    return running;
  }
  const s = stamp(k); // taken now: a Clear while this waits for the stream must still win
  const p = (async () => {
    await syncReady();
    const at = { seq: seqNow(), boot: boot() };
    inflightAt.set(k, at);
    const next = await load();
    if (stamp(k) === s) write(k, next, at);
    return next;
  })().finally(() => {
    inflight.delete(k);
    inflightAt.delete(k);
    if (again.delete(k)) void fetchInto(k, load).catch(() => {});
  });
  inflight.set(k, p);
  return p;
}

/** Is the saved copy (or the fetch already running for it) older than the newest change to its topic? */
function behind(k: string, latest: number): boolean {
  const m = inflightAt.get(k) ?? meta.get(k);
  return !m || m.boot !== boot() || m.seq < latest;
}

/**
 * `topic`: the topic or topics whose changes refetch it (default: the one its key names). `own`: also this window's
 * own writes (by default a window skips them: it already shows what it saved, and a refetch could undo typing).
 */
export type CacheOpts = { topic?: string | string[]; own?: boolean };

/** The saved value of a list for this account, or null. Synchronous, so a screen can paint on its first frame. */
export function readCached<T>(user: string | null | undefined, url: string): T | null {
  return user ? read<T>(keyOf(user, url)) : null;
}

/** Saves a value for this account (the page's own writes, e.g. a list it just changed). */
export function putCached(user: string | null | undefined, url: string, value: unknown) {
  if (user) write(keyOf(user, url), value);
}

/** Fetches a list now and keeps it for the signed-in account (warm-up). Throws when the request fails. */
export async function warmCached<T>(url: string, load: () => Promise<T>): Promise<void> {
  const user = useAuth.getState().me?.username;
  if (!user) return;
  await fetchInto(keyOf(user, url), load);
}

/**
 * A list that shows its saved copy at once and stays current: it refreshes when shown, and again whenever the server
 * says its topic changed (lib/sync.ts; a hidden window waits until it is shown). `load` is the screen's existing
 * loader; `topic` defaults to the one its key names (topicOf). Returns `data` (null until something is known), the last
 * refresh's `error`, `refresh` (rejects on failure, so an action can wait for it) and `set` (the page's own change: it
 * also replaces the saved copy, so a deleted item can't come back from the cache; a refresh already in flight is
 * dropped). Without a signed-in account (public share pages) nothing is saved: the list is fetched for the page only.
 */
export function useCachedLoad<T>(url: string | null, load: () => Promise<T>, opts?: CacheOpts) {
  const user = useAuth((s) => s.me?.username ?? null);
  const k = url && user ? keyOf(user, url) : null;
  const topics = [opts?.topic ?? (url ? topicOf(url) : null)].flat().filter((t): t is string => !!t);
  const topicKey = topics.join(" ");
  const own = !!opts?.own;
  const [local, setLocal] = useState<T | null>(null);
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const [error, setError] = useState("");
  const loader = useRef(load);
  useLayoutEffect(() => {
    loader.current = load;
  });

  const refresh = useCallback(async () => {
    if (!url) return;
    try {
      if (k) await fetchInto(k, () => loader.current());
      else setLocal(await loader.current());
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      throw e;
    }
  }, [url, k]);

  // repaint when this key changes from anywhere (another screen's fetch, a warm-up, a page's own set)
  useEffect(() => {
    if (!k) return;
    let set = watchers.get(k);
    if (!set) watchers.set(k, (set = new Set()));
    set.add(rerender);
    return () => void set.delete(rerender);
  }, [k]);

  useEffect(() => {
    if (url) void refresh().catch(() => {});
  }, [url, refresh]);

  // live: a change to its topics (from another tab, device or a background job) refetches it once
  useEffect(() => {
    if (!k || !topicKey) return;
    const refetch = (latest: number) =>
      void fetchInto(k, () => loader.current(), latest).then(() => setError(""), (e: unknown) => setError(e instanceof Error ? e.message : String(e)));
    const offs = topicKey.split(" ").map((t) =>
      onTopic(
        t,
        (latest) => {
          // checked again when it runs: the fetch that was already going may have caught up meanwhile
          if (behind(k, latest)) whenVisible(k, () => behind(k, latest) && refetch(latest));
        },
        { own },
      ),
    );
    return () => offs.forEach((off) => off());
  }, [k, topicKey, own]);

  const set = useCallback(
    (next: T | null | ((prev: T | null) => T | null)) => {
      const apply = (prev: T | null) => (typeof next === "function" ? (next as (p: T | null) => T | null)(prev) : next);
      if (k) write(k, apply(read<T>(k)));
      else setLocal((prev) => apply(prev));
    },
    [k],
  );

  return { data: k ? read<T>(k) : local, error, refresh, set };
}

/** useCachedLoad for a list: `items` is [] until something is known (`known` says which); `setItems` takes a list or an updater. */
export function useCachedList<T>(url: string | null, load: () => Promise<T[]>, opts?: CacheOpts) {
  const { data, set, refresh, error } = useCachedLoad<T[]>(url, load, opts);
  const setItems = useCallback(
    (next: T[] | ((prev: T[]) => T[])) => set((prev) => (typeof next === "function" ? next(prev ?? []) : next)),
    [set],
  );
  return { items: data ?? [], known: data !== null, setItems, refresh, error };
}

/** How much this account keeps here: its saved lists and their size (characters, about bytes). For Settings → General → This computer. */
export function cachedUsage(user: string | null | undefined): { bytes: number; items: number } {
  const base = user ? `${PREFIX}${encodeURIComponent(user)}|` : null;
  let bytes = 0;
  let items = 0;
  for (const [k, v] of base ? mem : []) {
    if (!k.startsWith(base!) || v === null) continue;
    items++;
    try {
      bytes += JSON.stringify(v).length;
    } catch {
      /* not JSON: not counted */
    }
  }
  return { bytes, items };
}

/** The saved keys of this account (their URLs). */
export function cachedUrls(user: string | null | undefined): string[] {
  const base = user ? `${PREFIX}${encodeURIComponent(user)}|` : null;
  return base ? [...mem.keys()].filter((k) => k.startsWith(base)).map(urlOf) : [];
}

/** Drops what this account has saved under keys starting with `prefix` (a deleted item's page, say). */
export function forgetCached(prefix: string) {
  const user = useAuth.getState().me?.username;
  if (!user) return;
  const base = keyOf(user, prefix);
  for (const k of [...mem.keys()]) if (k.startsWith(base)) drop(k);
}

/**
 * Settings → General's Clear: drops only this account's saved lists; other accounts on this computer keep theirs. The epoch
 * bump stops a fetch still in flight from saving into the cleared store (any account's; it just skips that one save).
 */
export function clearAccountCache(user: string | null | undefined) {
  if (!user) return;
  epoch++;
  const base = `${PREFIX}${encodeURIComponent(user)}|`;
  for (const k of [...mem.keys()]) if (k.startsWith(base)) drop(k);
}

/** Sign-out: every account's saved lists go, and a fetch still in flight can't save into the cleared store. */
export function clearLocalCache() {
  epoch++;
  versions.clear();
  for (const k of [...mem.keys()]) drop(k);
  mem.clear();
  meta.clear();
  for (const k of localKeys()) {
    try {
      localStorage.removeItem(k);
    } catch {
      /* storage off: nothing saved */
    }
  }
  void db().then((d) => {
    try {
      d?.transaction(STORE, "readwrite").objectStore(STORE).clear();
    } catch {
      /* closed: nothing to clear */
    }
  });
}
