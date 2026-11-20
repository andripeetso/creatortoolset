// Transitions (contracts/editor.ts `EdjTrans`): one sits on the LATER clip of a cut on its track, `len` timeline frames
// starting at the cut, ending at it, or centred on it (an odd one has its extra frame after the cut). The earlier clip
// plays past the cut on its tail and the later one before it on its head, so each needs those frames in its source.
// The maths is the golden's (contracts/edj-golden.json `about`), which the studio engine computes the same way.
import type { EdjTrans } from "@contracts/editor";
import { find, fixTrans, handlesAt, isVideo, maxLen, setItems, withLinked, type NleItem, type NleTimeline } from "./model";

// the room at a cut and the clamp live in model.ts, which every edit runs through
export { fixTrans, handlesAt, maxLen };

/** frames of the transition before / after the cut */
export const transSpan = (t: Pick<EdjTrans, "len" | "at">) => {
  const pre = t.at === "start" ? 0 : t.at === "end" ? t.len : Math.floor(t.len / 2);
  return { pre, post: t.len - pre };
};

/** How each side shows `u` (0–1) through it: dissolve the later clip's alpha over the earlier at full; a dip the earlier
 *  clip, the colour and the later clip; a sound crossfade equal-power gains. */
export function transWeights(t: Pick<EdjTrans, "type">, u: number): { alpha: number } | { a: number; color: number; b: number } | { a: number; b: number } {
  if (t.type === "dissolve") return { alpha: u };
  if (t.type === "crossfade") return { a: Math.cos((u * Math.PI) / 2), b: Math.sin((u * Math.PI) / 2) };
  return u < 0.5 ? { a: 1 - 2 * u, color: 2 * u, b: 0 } : { a: 0, color: 2 - 2 * u, b: 2 * u - 1 };
}

/** The timeline with its transitions made right (fixTrans), the same timeline when nothing changed. */
export function normalizeTrans(tl: NleTimeline): NleTimeline {
  const out = fixTrans(structuredClone(tl));
  return JSON.stringify(out.tracks) === JSON.stringify(tl.tracks) ? tl : out;
}

/** The clip and the clips linked to it that start at the same cut, on unlocked tracks. */
function atCut(tl: NleTimeline, key: string): { track: string; item: NleItem }[] {
  const hit = find(tl, key);
  if (!hit || tl.tracks[hit.track].locked) return [];
  return withLinked(tl, [key]).map((k) => find(tl, k)!).filter((h) => h.item.rec === hit.item.rec && !tl.tracks[h.track].locked);
}

/**
 * A transition at the cut before clip `key` (Resolve's 1 s centred cross dissolve when unsaid; a sound clip a crossfade),
 * as long as its handles allow. The linked clips at the same cut get one too: a sound one a crossfade (unless `sound`
 * is false), a picture one the same.
 */
export function addTransition(tl: NleTimeline, key: string, t: Partial<EdjTrans> = {}, sound = true): NleTimeline {
  const group = atCut(tl, key);
  const h = handlesAt(tl, key);
  if (!group.length || !h || maxLen(h, t.at ?? "center") < 1) return tl;
  const video = isVideo(group[0]!.track);
  const base = { len: t.len ?? tl.timeline.fps, at: t.at ?? "center" } as const;
  const keys = group.filter((h) => isVideo(h.track) === video || sound).map((h) => h.item._k!);
  let out = tl;
  for (const k of keys) {
    const v = isVideo(find(out, k)!.track);
    const type = v === video ? (t.type ?? (v ? "dissolve" : "crossfade")) : v ? "dissolve" : "crossfade";
    out = setItems(out, [k], { trans: { type, ...base } });
  }
  return out;
}

/** The transition at the cut before clip `key` changed; length and alignment go to the linked clips' ones at that cut too. */
export function setTransition(tl: NleTimeline, key: string, patch: Partial<EdjTrans>): NleTimeline {
  const group = atCut(tl, key).filter((h) => h.item.trans);
  if (!group.some((h) => h.item._k === key)) return tl;
  const { type, ...shared } = patch;
  let out = tl;
  for (const h of group) out = setItems(out, [h.item._k!], { trans: { ...h.item.trans!, ...shared, ...(h.item._k === key && type ? { type } : {}) } });
  return out;
}

/** The transition at the cut before clip `key` taken off, with the linked clips' ones at that cut. */
export function removeTransition(tl: NleTimeline, key: string): NleTimeline {
  const keys = atCut(tl, key).filter((h) => h.item.trans).map((h) => h.item._k!);
  return keys.length ? setItems(tl, keys, { trans: undefined }) : tl;
}
