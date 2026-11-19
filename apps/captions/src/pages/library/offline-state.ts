import { useEffect, useSyncExternalStore } from "react";

/**
 * The person's Available offline list and Downloads (api/work/offline.ts), read once and kept in step with each change.
 * Every menu and the Downloads card read the same copy; a change is sent, then the server's answer replaces it.
 */
export interface Downloads {
  mode: "none" | "needed" | "all";
  proxies?: boolean;
  originals?: boolean;
}
export interface OfflineState {
  versions: string[];
  collections: string[];
  libraries: string[];
  downloads: Record<string, Downloads>;
}

const EMPTY: OfflineState = { versions: [], collections: [], libraries: [], downloads: {} };
let state: OfflineState | null = null;
const listeners = new Set<() => void>();
const subscribe = (l: () => void) => (listeners.add(l), () => void listeners.delete(l));
const put = (s: OfflineState) => {
  state = s;
  listeners.forEach((l) => l());
};
const norm = (v: Partial<OfflineState>): OfflineState => ({
  versions: v.versions ?? [],
  collections: v.collections ?? [],
  libraries: v.libraries ?? [],
  downloads: v.downloads ?? {},
});
const message = async (r: Response) => ((await r.json().catch(() => ({}))) as { error?: string }).error ?? `Request failed (${r.status})`;

export function loadOffline(): Promise<OfflineState> {
  return fetch("/api/library/offline").then(async (r) => {
    if (!r.ok) throw new Error(await message(r));
    const s = norm((await r.json()) as Partial<OfflineState>);
    put(s);
    return s;
  });
}

/** The current copy; read again on each mount, so a page never starts from an older list. */
export function useOffline(): OfflineState {
  useEffect(() => void loadOffline().catch(() => {}), []);
  return useSyncExternalStore(subscribe, () => state) ?? EMPTY;
}

/** Make a clip (version) or a folder (collection) available offline, or let it go. */
export async function setOffline(target: { version: string } | { collection: string }, on: boolean): Promise<void> {
  const r = await fetch("/api/library/offline", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...target, on }),
  });
  if (!r.ok) throw new Error(await message(r));
  put(norm((await r.json()) as Partial<OfflineState>));
}

/** A library's Downloads (M13): Automatic off = none; Automatic on = needed; offline on = all with the kinds picked. */
export async function setDownloads(library: string, body: Downloads): Promise<void> {
  const r = await fetch("/api/library/offline/downloads", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ library, ...body }),
  });
  if (!r.ok) throw new Error(await message(r));
  put(norm((await r.json()) as Partial<OfflineState>));
}

/** The same rule as the server's downloadsOf: an old "Keep on this computer" library reads as all with proxies. */
export function downloadsOf(s: OfflineState, library: string): Downloads {
  const d = s.downloads[library];
  if (d) return d;
  return s.libraries.includes(library) ? { mode: "all", proxies: true } : { mode: "needed" };
}
