import { openStore } from "@/lib/idb";
import type { NleTimeline } from "./model";

/**
 * Autosaves: the last 20 copies of each opened timeline's unsaved edits, kept in this browser (IndexedDB) so a reload,
 * a crash, the page opened again or the app restarting never loses them (owner, 11-19: a refresh while he edited threw
 * his whole edit away). Never sent anywhere. Each copy keeps a fingerprint of the timeline it was made on and is given
 * back on reopen only on that same timeline, and only when it is newer than the last save made here. Without IndexedDB
 * (a private window, storage full or blocked) they live in memory for this session only, and editing goes on as ever.
 */
/** `live`: the newest one, still rewritten a moment after each change (so a crash loses nothing) until it is sealed. */
export type Autosave = { at: number; base: string; label?: string; tl: NleTimeline; live?: true };
/** A timeline's autosaves, oldest first, and when it was last saved here (0: never). */
export type Ring = { list: Autosave[]; savedAt: number };
export type AutosaveStore = { get(key: string): Promise<Ring | undefined>; put(key: string, ring: Ring): Promise<void> };

export const KEEP = 20;
/** How often the editor seals the live autosave while there are unsaved edits that changed since the last one. */
export const AUTOSAVE_MS = 30_000;
/** How long after a change the live autosave is written. */
export const LIVE_MS = 1_000;

/** A short fingerprint of a timeline as opened (FNV-1a over its JSON). */
export function fingerprint(tl: NleTimeline): string {
  const s = JSON.stringify(tl);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return `${s.length}:${(h >>> 0).toString(36)}`;
}

const STORE = "rings";
let dbp: Promise<IDBDatabase | null> | null = null;
const idb: AutosaveStore = {
  async get(key) {
    const d = await (dbp ??= openStore("ct-nle-autosave", STORE));
    if (!d) return undefined;
    return new Promise((resolve, reject) => {
      const r = d.transaction(STORE).objectStore(STORE).get(key);
      r.onsuccess = () => resolve(r.result as Ring | undefined);
      r.onerror = () => reject(r.error);
    });
  },
  async put(key, ring) {
    const d = await (dbp ??= openStore("ct-nle-autosave", STORE));
    if (!d) throw new Error("No IndexedDB");
    await new Promise<void>((resolve, reject) => {
      const tx = d.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(ring, key);
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
  },
};

let store = idb;
/** each timeline's ring as last read or changed: every change chains on the one before, so none is lost */
const rings = new Map<string, Promise<Ring>>();

/** Tests: another store, and nothing remembered from the last one. */
export function setAutosaveStore(s: AutosaveStore = idb) {
  store = s;
  rings.clear();
}

const write = (key: string, ring: Ring) => {
  try {
    return store.put(key, ring).then(() => true, () => false);
  } catch {
    return Promise.resolve(false);
  }
};

async function load(key: string): Promise<Ring> {
  let got: Ring | undefined;
  try {
    got = await store.get(key);
  } catch {
    /* no IndexedDB: this session's autosaves only */
  }
  // a live one left by another session (a crash, a reload) is sealed: this session starts its own
  const ring: Ring = got?.list ? { ...got, list: got.list.map(unlive) } : { list: [], savedAt: 0 };
  // the one copy kept before autosaves (localStorage): moved into the ring once, and removed when the ring has it
  try {
    const old = `ct-nle-unsaved:${key}`;
    const v = JSON.parse(localStorage.getItem(old) ?? "null") as { base: string; tl: NleTimeline } | null;
    if (v?.tl?.tracks) {
      ring.list = [...ring.list, { at: Date.now(), base: v.base, tl: v.tl }].slice(-KEEP);
      if (await write(key, ring)) localStorage.removeItem(old);
    }
  } catch {
    /* localStorage blocked or the copy unreadable */
  }
  return ring;
}

/** The autosaves of timeline `key` (an edit's draft). */
export function readAutosaves(key: string): Promise<Ring> {
  let p = rings.get(key);
  if (!p) rings.set(key, (p = load(key)));
  return p;
}

const unlive = (a: Autosave): Autosave => (a.live ? { ...a, live: undefined } : a);

function change(key: string, fn: (r: Ring) => Ring): Promise<Ring> {
  const p = readAutosaves(key).then((r) => {
    const next = fn(r);
    if (next !== r) void write(key, next);
    return next;
  });
  rings.set(key, p);
  return p;
}

/** The newest autosave: in place of the live one, else one more (the oldest goes past 20). */
export const addAutosave = (key: string, a: Autosave) =>
  change(key, (r) => ({ ...r, list: [...(r.list.at(-1)?.live ? r.list.slice(0, -1) : r.list), a].slice(-KEEP) }));

/** The live autosave stays as it is: the next change starts a new one. */
export const sealAutosave = (key: string) =>
  change(key, (r) => (r.list.at(-1)?.live ? { ...r, list: r.list.map(unlive) } : r));

/** Saved: a reopen gives back only autosaves made after this. The autosaves stay, sealed, to be restored by hand. */
export const markSaved = (key: string, at = Date.now()) => change(key, (r) => ({ ...r, savedAt: at, list: r.list.map(unlive) }));

/** What a reopen gives back: the newest autosave made on this same timeline (`base`) since it was last saved here. */
export function toRestore(r: Ring, base: string): Autosave | null {
  for (let i = r.list.length - 1; i >= 0; i--) if (r.list[i].base === base && r.list[i].at > r.savedAt) return r.list[i];
  return null;
}
