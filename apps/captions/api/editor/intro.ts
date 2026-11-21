import type { EditIntro, PipCorner, Timeline, TimelineSource } from "../../contracts/editor";
import { fitted } from "./framing";

/**
 * An intro (contracts/editor.ts EditIntro): someone else's video opens each version, its own sound with it, and the
 * person's reaction sits small in a corner over its last seconds. The cut itself starts after it, every clip and marker
 * moved on by the intro's length. Each version opens on a different stretch of the video: whole sentences, none shared.
 */

/** About how long each version's intro is when the edit names no length, by version. */
export const INTRO_SECONDS = [12, 32, 60, 20, 45];
/** The reaction's size: a third of the frame or so (its zoom on V2). */
export const PIP_SIZE = 0.3;
/** Its distance from the frame's edges: 50 px on a 2160-wide frame. */
const PIP_MARGIN = 50 / 2160;
const CORNERS: Record<PipCorner, [number, number]> = { "bottom-left": [-1, 1], "bottom-right": [1, 1], "top-left": [-1, -1], "top-right": [1, -1] };

export interface IntroPart { a: number; b: number; text: string }

/**
 * The intro's sentences (seconds in it) → one stretch per entry of `seconds`, in order. Each starts at the first sentence
 * no earlier stretch covers and runs on sentence by sentence to the end that lands nearest its length, so no two
 * versions share a second. A version with nothing left gets null.
 */
export function introParts(sents: { s: number; e: number; text: string }[], seconds: number[]): (IntroPart | null)[] {
  const taken: [number, number][] = [];
  const free = (x: { s: number; e: number }) => !taken.some(([a, b]) => x.s < b && a < x.e);
  return seconds.map((want) => {
    const i = sents.findIndex(free);
    if (i < 0) return null;
    let best = i;
    for (let j = i; j < sents.length && free(sents[j]!); j++) {
      const len = sents[j]!.e - sents[i]!.s;
      if (Math.abs(len - want) < Math.abs(sents[best]!.e - sents[i]!.s - want)) best = j;
      if (len >= want) break;
    }
    const part = { a: sents[i]!.s, b: sents[best]!.e, text: sents.slice(i, best + 1).map((x) => x.text).filter(Boolean).join(" ") };
    taken.push([part.a, part.b]);
    return part;
  });
}

/** An intro with no transcript: one-second pieces of it, so the versions still take turns through it. */
export const secondsOf = (dur: number) => Array.from({ length: Math.floor(dur) }, (_, k) => ({ s: k, e: k + 1, text: "" }));

/** The reaction's pan and tilt (timeline px) that put its picture, at PIP_SIZE, in `corner` of a W × H frame. */
export function pipPlace(corner: PipCorner, src: Pick<TimelineSource, "w" | "h">, W: number, H: number): { pan: number; tilt: number } {
  const [sx, sy] = CORNERS[corner];
  const f = fitted(src, W, H);
  const m = PIP_MARGIN * W;
  const r = (n: number) => Math.round(n * 10) / 10;
  return { pan: r(sx * (W / 2 - m - (PIP_SIZE * f.w) / 2)), tilt: r(-sy * (H / 2 - m - (PIP_SIZE * f.h) / 2)) };
}

/** The cut with the intro's `part` before it (and the reaction over the part's end): a new timeline, `tl` unchanged. */
export function withIntro(tl: Timeline, intro: EditIntro, part: IntroPart, src: TimelineSource, reaction?: TimelineSource): Timeline {
  const lead = Math.round((part.b - part.a) * tl.fps);
  if (lead <= 0) return tl;
  const shift = <T extends { rec: number }>(x: T): T => ({ ...x, rec: x.rec + lead });
  const tracks = Object.fromEntries(Object.entries(tl.tracks).map(([k, t]) => [k, { ...t, items: t.items.map(shift) }])) as Timeline["tracks"];
  const at = { src: intro.source, in: Math.round(part.a * src.fps), len: lead, rec: 0, link: "intro" };
  tracks.V1.items.unshift(at);
  tracks.A1.items.unshift({ ...at });
  const sources = { ...tl.sources, [intro.source]: src };
  if (intro.reaction && reaction?.w) {
    // its own last seconds, ending where the intro does
    const n = Math.min(lead, Math.floor((reaction.dur * tl.fps) / reaction.fps));
    tracks.V2.items.unshift({
      src: intro.reaction, in: Math.max(0, reaction.dur - Math.round((n * reaction.fps) / tl.fps)), len: n, rec: lead - n,
      zoom: PIP_SIZE, ...pipPlace(intro.corner ?? "bottom-left", reaction, tl.width, tl.height),
    });
    sources[intro.reaction] = reaction;
  }
  return {
    ...tl,
    sources,
    tracks,
    markers: [{ rec: 0, name: "Intro", color: "YELLOW", note: part.text }, ...tl.markers.map(shift)],
    ...(tl.speakers ? { speakers: tl.speakers.map(shift) } : {}),
  };
}
