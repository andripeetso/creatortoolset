import type { NleTimeline } from "./model";

/**
 * Edits not saved yet, kept in this browser for each opened timeline so a reload, a page opened again or the app
 * restarting never loses them (owner, 11-19: a refresh while he edited threw his whole edit away). Each is kept with
 * a fingerprint of the timeline it was made on, and is given back only on that same timeline.
 */
const KEY = (at: string) => `ct-nle-unsaved:${at}`;

/** A short fingerprint of a timeline as opened (FNV-1a over its JSON). */
export function fingerprint(tl: NleTimeline): string {
  const s = JSON.stringify(tl);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return `${s.length}:${(h >>> 0).toString(36)}`;
}

/** The edits kept for `at` when they were made on this `base` (fingerprint), else null. */
export function readUnsaved(at: string, base: string): NleTimeline | null {
  try {
    const v = JSON.parse(localStorage.getItem(KEY(at)) ?? "null") as { base: string; tl: NleTimeline } | null;
    return v && v.base === base && v.tl?.tracks ? v.tl : null;
  } catch {
    return null;
  }
}

/** Keeps the edits (null: there are none, the copy goes). */
export function keepUnsaved(at: string, base: string, tl: NleTimeline | null) {
  try {
    if (tl) localStorage.setItem(KEY(at), JSON.stringify({ base, tl }));
    else localStorage.removeItem(KEY(at));
  } catch {
    // shortcut: browser storage full or blocked, the edits are then only on screen; IndexedDB if timelines outgrow it
  }
}
