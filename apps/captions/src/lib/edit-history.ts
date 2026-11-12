import {
  cleanEdits,
  describeEdit,
  mergeEdit,
  PLACEHOLDER_LOOKS,
  stackEdits,
  type ItemEdit,
} from "@contracts/edit-timeline";
import type { Placeholder } from "@/components/EditTimeline";
import type { ReviewSentEntry } from "@/lib/plugin";

// The Review panel's own undo history and what it sends. Pure, so the rules (a no-op is not a step, a new edit drops
// the redo steps, a sent comment starts clean, the sent edits stay on the timeline) are checked by a plain test.

/** Unsent work: the timeline edits and, when one is drawn, the placeholder the comment will say what goes in. */
export type Pending = { edits: ItemEdit[]; hole: Placeholder | null };
export const EMPTY_PENDING: Pending = { edits: [], hole: null };

export type Hist<T> = { past: T[]; now: T; future: T[] };
export const freshHist = <T>(now: T): Hist<T> => ({ past: [], now, future: [] });

/** One step: `fn` gives the new value; the same value back (nothing changed) makes no step. */
export function histChange<T>(h: Hist<T>, fn: (t: T) => T): Hist<T> {
  const now = fn(h.now);
  return now === h.now ? h : { past: [...h.past.slice(-99), h.now], now, future: [] };
}

export function histUndo<T>(h: Hist<T>): Hist<T> {
  return h.past.length ? { past: h.past.slice(0, -1), now: h.past.at(-1)!, future: [h.now, ...h.future] } : h;
}

export function histRedo<T>(h: Hist<T>): Hist<T> {
  return h.future.length ? { past: [...h.past, h.now], now: h.future[0], future: h.future.slice(1) } : h;
}

/** A placeholder as a comment carries it (no id: the panel gives one). Null when the data is not one. */
export function holeOf(v: unknown): Omit<Placeholder, "id"> | null {
  const h = v as Record<string, unknown> | null;
  if (!h || typeof h.track !== "string" || !/^[VA][1-9]$/.test(h.track)) return null;
  const rec = Number(h.rec);
  const len = Number(h.len);
  if (!Number.isInteger(rec) || rec < 0 || !Number.isInteger(len) || len <= 0) return null;
  const look = PLACEHOLDER_LOOKS.find((l) => l === h.look);
  const color = typeof h.color === "string" && /^#[0-9a-f]{6}$/i.test(h.color) ? h.color : undefined;
  return { track: h.track, rec, len, ...(look ? { look } : {}), ...(color ? { color } : {}) };
}

/** The edits and placeholders the open comments already sent, read from their plug-in data. */
export function sentOf(sent: ReviewSentEntry[]): { edits: ItemEdit[]; holes: Placeholder[] } {
  const edits = stackEdits(sent.map((s) => cleanEdits((s.data as { edits?: unknown } | null)?.edits)));
  const holes = sent.flatMap((s) => {
    const h = holeOf((s.data as { hole?: unknown } | null)?.hole);
    return h ? [{ id: s.id, ...h }] : [];
  });
  return { edits, holes };
}

/** `patch` on the unsent edits; an item a sent comment already edited starts from where that left it (its cuts and copy stay on the sent one). */
export function layOn(sent: ItemEdit[], list: ItemEdit[], key: string, label: string, patch: Partial<ItemEdit>): ItemEdit[] {
  const was = !list.some((e) => e.key === key) && sent.find((e) => e.key === key);
  return mergeEdit(was ? [...list, { ...was, split: undefined, copyOf: undefined }] : list, key, label, patch);
}

/** What the comment box shows for the unsent work: one chip per edit and the placeholder, and the payload the next comment carries. */
export function sentForm(
  chipEdits: ItemEdit[],
  outgoing: ItemEdit[],
  hole: Placeholder | null,
  fps: number,
): { chips: string[]; payload: { edits: ItemEdit[]; hole?: Placeholder } | null } {
  const chips = [...chipEdits.map((e) => describeEdit(e, fps)), ...(hole ? [`Placeholder on ${hole.track}`] : [])];
  const payload = outgoing.length || hole ? { edits: outgoing, ...(hole ? { hole } : {}) } : null;
  return { chips, payload };
}
