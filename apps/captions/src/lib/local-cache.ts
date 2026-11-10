import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";
import { useAuth } from "./auth";

/**
 * Last-known data for the main screens, kept on this device so a screen paints on its first frame and refreshes
 * underneath (stale-while-revalidate). Keyed by the signed-in account and a key that names the list (a URL, with its
 * query: a project's lists stay apart), so another account never sees it. Small JSON only, never media and never
 * tokens. Sign-out clears it (clearLocalCache); warmScreens (lib/warm-cache.ts) fills it right after sign-in.
 * ponytail: one localStorage entry per key, the browser's ~5 MB shared; on a full store the others go first.
 * Upgrade to Cache Storage if a list outgrows that.
 */
const PREFIX = "ct-swr:";
const mem = new Map<string, unknown>();
const versions = new Map<string, number>();
let epoch = 0;

const keyOf = (user: string, url: string) => `${PREFIX}${encodeURIComponent(user)}|${url}`;
const stamp = (k: string) => `${epoch}.${versions.get(k) ?? 0}`;
const touch = (k: string) => versions.set(k, (versions.get(k) ?? 0) + 1);
const storageKeys = (): string[] => {
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
};

function read<T>(k: string): T | null {
  if (mem.has(k)) return mem.get(k) as T | null;
  let v: T | null = null;
  try {
    const raw = localStorage.getItem(k);
    v = raw === null ? null : (JSON.parse(raw) as T);
  } catch {
    v = null;
  }
  mem.set(k, v);
  return v;
}

function write(k: string, v: unknown) {
  mem.set(k, v);
  touch(k);
  const raw = JSON.stringify(v);
  try {
    localStorage.setItem(k, raw);
  } catch {
    // full (or storage off): this copy goes first, then it is kept in memory for the session
    try {
      for (const other of storageKeys()) if (other !== k) localStorage.removeItem(other);
      localStorage.setItem(k, raw);
    } catch {
      /* too big: this session only */
    }
  }
}

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
  const k = keyOf(user, url);
  const s = stamp(k);
  const next = await load();
  if (stamp(k) === s) write(k, next);
}

/**
 * A list that shows its saved copy at once and refreshes in the background. `load` is the screen's existing loader.
 * Returns `data` (null until something is known), the last refresh's `error`, `refresh` (rejects on failure, so an
 * action can wait for it) and `set` (the page's own change: it also replaces the saved copy, so a deleted item can't
 * come back from the cache; a refresh already in flight is dropped).
 * Without a signed-in account (public share pages) nothing is saved: the list is fetched and kept for the page only.
 */
export function useCachedLoad<T>(url: string | null, load: () => Promise<T>) {
  const user = useAuth((s) => s.me?.username ?? null);
  const k = url && user ? keyOf(user, url) : null;
  const [local, setLocal] = useState<T | null>(null);
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const [error, setError] = useState("");
  const loader = useRef(load);
  useLayoutEffect(() => {
    loader.current = load;
  });

  const refresh = useCallback(async () => {
    if (!url) return;
    const s = k ? stamp(k) : "";
    try {
      const next = await loader.current();
      if (k) {
        if (stamp(k) === s) write(k, next);
        rerender();
      } else {
        setLocal(next);
      }
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      throw e;
    }
  }, [url, k]);

  useEffect(() => {
    if (url) void refresh().catch(() => {});
  }, [url, refresh]);

  const set = useCallback(
    (next: T | null | ((prev: T | null) => T | null)) => {
      const apply = (prev: T | null) => (typeof next === "function" ? (next as (p: T | null) => T | null)(prev) : next);
      if (k) {
        write(k, apply(read<T>(k)));
        rerender();
      } else {
        setLocal((prev) => apply(prev));
      }
    },
    [k],
  );

  return { data: k ? read<T>(k) : local, error, refresh, set };
}

/** useCachedLoad for a list: `items` is [] until something is known (`known` says which); `setItems` takes a list or an updater. */
export function useCachedList<T>(url: string | null, load: () => Promise<T[]>) {
  const { data, set, refresh, error } = useCachedLoad<T[]>(url, load);
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
  for (const k of base ? storageKeys() : []) {
    if (!k.startsWith(base!)) continue;
    items++;
    try {
      bytes += (localStorage.getItem(k) ?? "").length;
    } catch {
      /* storage off: nothing saved */
    }
  }
  return { bytes, items };
}

/** Drops what this account has saved under keys starting with `prefix` (a deleted item's page, say). */
export function forgetCached(prefix: string) {
  const user = useAuth.getState().me?.username;
  if (!user) return;
  const base = keyOf(user, prefix);
  for (const k of [...mem.keys(), ...storageKeys()]) {
    if (!k.startsWith(base)) continue;
    mem.delete(k);
    touch(k);
    try {
      localStorage.removeItem(k);
    } catch {
      /* storage off: nothing saved */
    }
  }
}

/**
 * Settings → General's Clear: drops only this account's saved lists; other accounts on this computer keep theirs. The epoch
 * bump stops a fetch still in flight from saving into the cleared store (any account's; it just skips that one save).
 */
export function clearAccountCache(user: string | null | undefined) {
  if (!user) return;
  epoch++;
  const base = `${PREFIX}${encodeURIComponent(user)}|`;
  for (const k of [...mem.keys(), ...storageKeys()]) {
    if (!k.startsWith(base)) continue;
    mem.delete(k);
    touch(k);
    try {
      localStorage.removeItem(k);
    } catch {
      /* storage off: nothing saved */
    }
  }
}

/** Sign-out: every account's saved lists go, and a fetch still in flight can't save into the cleared store. */
export function clearLocalCache() {
  epoch++;
  versions.clear();
  mem.clear();
  for (const k of storageKeys()) {
    try {
      localStorage.removeItem(k);
    } catch {
      /* storage off: nothing saved */
    }
  }
}
