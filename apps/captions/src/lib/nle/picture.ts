// Where a clip's picture goes in the frame, and which clips play at a moment: what the editor's player draws
// (components/nle/NlePlayer.tsx). The renderer's own geometry, so the player shows what Save will make (checked against
// the renderer's cases in geometry.fixture.json): the source is scaled to cover the frame on V0, V1, V2 and V5 and to fit
// inside it, whole, on the other picture tracks; then, about the source's centre, `crop` cuts fractions off its sides
// (the rest stays where it was), `zoom` scales it, `flip` mirrors it, `rot` turns it (degrees, counter-clockwise), and
// `pan` / `tilt` move it right / up in frame px. Nothing keeps it inside the frame: what is outside is not seen.

import type { EdjTrans } from "@contracts/editor";
import { valueAt } from "./keyframes";
import { endOf, isVideo, trackNo, type NleItem, type NleTimeline } from "./model";
import { transSpan, transWeights } from "./trans";

export interface Placement {
  /** source px to frame px, as a canvas takes it: x = a*u + c*v + e, y = b*u + d*v + f */
  m: [number, number, number, number, number, number];
  /** the part of the source that shows: x, y, w, h in source px */
  crop: [number, number, number, number];
  alpha: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
/** The tracks whose pictures cover the frame (the talent, B-roll, the intro); the others fit inside it whole. */
export const covers = (track: string) => ["V0", "V1", "V2", "V5"].includes(track);

export function placement(it: NleItem, track: string, sw: number, sh: number, W: number, H: number): Placement {
  const s = covers(track) ? Math.max(W / sw, H / sh) : Math.min(W / sw, H / sh);
  const k = s * (it.zoom ?? 1);
  const fx = it.flip === "h" || it.flip === "hv" ? -1 : 1;
  const fy = it.flip === "v" || it.flip === "hv" ? -1 : 1;
  const th = (-(it.rot ?? 0) * Math.PI) / 180;
  const [cos, sin] = [Math.cos(th), Math.sin(th)];
  const a = k * fx * cos;
  const b = k * fx * sin;
  const c = -k * fy * sin;
  const d = k * fy * cos;
  const cx = W / 2 + (it.pan ?? 0);
  const cy = H / 2 - (it.tilt ?? 0);
  const [l, t, r, btm] = (it.crop ?? [0, 0, 0, 0]).map((v) => clamp(Number(v) || 0, 0, 1));
  return {
    m: [a, b, c, d, cx - (a * sw) / 2 - (c * sh) / 2, cy - (b * sw) / 2 - (d * sh) / 2],
    crop: [l * sw, t * sh, Math.max(0, 1 - l - r) * sw, Math.max(0, 1 - t - btm) * sh],
    alpha: clamp(it.opacity ?? 1, 0, 1),
  };
}

/** A clip that plays: `seen` how much of it shows at the frame (its fades, a transition's share, 0–1), `under` a dip's
 *  colour drawn over the whole frame right under it (the earlier clip of the dip). */
export type Playing = { track: string; item: NleItem; seen?: number; under?: "black" | "white" };

/** The clip with its zoom, pan, tilt, rotation and opacity at timeline frame `f` from its keys (keyframes.ts valueAt);
 *  the clip itself when it keys none. */
export function keyed(tl: NleTimeline, it: NleItem, f: number): NleItem {
  if (!it.keys) return it;
  const fps = tl.timeline.fps;
  const out = { ...it };
  for (const p of ["zoom", "pan", "tilt", "rot", "opacity"] as const) if (it.keys[p]?.length) out[p] = valueAt(it, p, f, fps, tl.sources[it.src]?.fps || fps);
  return out;
}

/** A transition at a cut: the timeline frames [start, start + len) both clips play in. */
type Cut = { start: number; len: number; type: EdjTrans["type"] };
const cutsOf = new WeakMap<NleTimeline, Map<NleItem, { into?: Cut; out?: Cut }>>();
/** Each clip's transitions: `into` the one at its own start (it is the later clip), `out` the one at its end. */
function cuts(tl: NleTimeline) {
  let m = cutsOf.get(tl);
  if (m) return m;
  cutsOf.set(tl, (m = new Map()));
  for (const t of Object.values(tl.tracks)) {
    const on = t.items.filter((i) => i.enabled !== false);
    for (const b of on) {
      const a = b.trans && b.trans.len >= 1 ? on.find((x) => x !== b && endOf(x) === b.rec) : undefined;
      if (!a) continue;
      const c = { start: b.rec - transSpan(b.trans!).pre, len: b.trans!.len, type: b.trans!.type };
      m.set(b, { ...m.get(b), into: c });
      m.set(a, { ...m.get(a), out: c });
    }
  }
  return m;
}

/** The timeline frames a clip plays: from a transition's start into it to the end of one out of it (its handles). */
export function spanOf(tl: NleTimeline, it: NleItem): [number, number] {
  const c = cuts(tl).get(it);
  return [c?.into ? c.into.start : it.rec, c?.out ? c.out.start + c.out.len : endOf(it)];
}

/**
 * How much of the clip shows (a picture) or is heard (a sound, as a gain factor) at timeline frame `f`, from its fades and
 * its transitions (contracts/edj-golden.json): a transition takes the place of the fade on its edge. A dissolve shows the
 * later clip at u over the earlier at full; a dip the earlier at its share over the colour, then the later; a sound (or a
 * crossfade) is equal power both sides. Fractional `f` is fine (a sound's gain between frames).
 */
export function seenAt(tl: NleTimeline, it: NleItem, f: number, sound: boolean): { seen: number; under?: "black" | "white" } {
  const c = cuts(tl).get(it);
  const k = f - it.rec;
  let seen = Math.max(0, Math.min(1, !c?.into && it.fade_in ? k / it.fade_in : 1, !c?.out && it.fade_out ? (it.len - k) / it.fade_out : 1));
  let under: "black" | "white" | undefined;
  const share = (t: Cut, side: "a" | "b") => {
    const u = Math.max(0, Math.min(1, (f - t.start) / t.len));
    const w = transWeights({ type: sound ? "crossfade" : t.type === "crossfade" ? "dissolve" : t.type }, u) as Record<string, number>;
    return "alpha" in w ? (side === "a" ? 1 : w.alpha) : w[side];
  };
  if (c?.into && f < c.into.start + c.into.len) seen *= share(c.into, "b");
  if (c?.out && f >= c.out.start) {
    seen *= share(c.out, "a");
    if (!sound && c.out.type.startsWith("dip") && f < c.out.start + c.out.len) under = c.out.type === "dip_white" ? "white" : "black";
  }
  return under ? { seen, under } : { seen };
}

const pictureTracks = (tl: NleTimeline) =>
  Object.entries(tl.tracks).filter(([id, t]) => isVideo(id) && !t.hidden && t.enabled !== false);

/** Bottom to top: V1, a track named SOURCE… (the intro's source) right over it, then V2, V3, … (the renderer draws no V0) */
const layer = ([id, t]: [string, { name?: string }]) => (id !== "V1" && (t.name ?? "").toUpperCase().startsWith("SOURCE") ? 1.5 : trackNo(id));

/** The pictures at frame `f`, the bottom one first: tracks that show, clips that are on (both clips of a transition,
 *  the earlier first), each with how much of it shows (seenAt). */
export function picturesAt(tl: NleTimeline, f: number): Playing[] {
  return pictureTracks(tl)
    .filter(([id]) => trackNo(id) >= 1)
    .sort((x, y) => layer(x) - layer(y))
    .flatMap(([track, t]) =>
      t.items
        .filter((i) => {
          if (i.enabled === false) return false;
          const [a, b] = spanOf(tl, i);
          return a <= f && f < b;
        })
        .sort((x, y) => x.rec - y.rec)
        .map((item) => ({ track, item, ...seenAt(tl, item, f, false) })),
    );
}

/** The next picture on each track that starts within `ahead` frames after `f` and doesn't play on from the one before it
 *  (`chain`: chains()), to have its file open and waiting on its first frame. Only the next: every clip of a run of short
 *  ones opened at once is a 4K decoder each. */
export const picturesSoon = (tl: NleTimeline, f: number, ahead: number, chain?: Map<string, string>): Playing[] =>
  pictureTracks(tl).flatMap(([track, t]) => {
    // a clip starts where a transition into it starts (its head handle)
    const from = (i: NleItem) => spanOf(tl, i)[0];
    const on = t.items.find((i) => i.enabled !== false && from(i) <= f && f < spanOf(tl, i)[1]);
    const next = t.items
      .filter((i) => i.enabled !== false && from(i) > f && from(i) <= f + ahead && !(on && chain && chain.get(keyOf(i)) === chain.get(keyOf(on))))
      .sort((a, b) => from(a) - from(b))[0];
    return next ? [{ track, item: next }] : [];
  });

export const keyOf = (i: NleItem) => i._k ?? `${i.src}:${i.rec}`;

/** Whether `b` plays on from `a` in one go: straight after it, the same file from where `a`'s source ends (give or take a
 *  frame), at the same speed, neither held nor reversed. Then one <video> plays across the cut: no new element, no seek. */
export function continues(tl: NleTimeline, a: NleItem, b: NleItem): boolean {
  if (a.src !== b.src || endOf(a) !== b.rec || (a.speed || 1) !== (b.speed || 1)) return false;
  // a transition plays both at once, each from its own element
  if (a.freeze || b.freeze || a.rev || b.rev || a.fx || b.fx || b.trans) return false;
  const fps = tl.timeline.fps;
  const sfps = tl.sources[a.src]?.fps || fps;
  return Math.abs(b.in - (a.in + a.len * (sfps / fps) * (a.speed || 1))) <= 1 + 1e-6;
}

/** Each clip's key to the clip its run starts with: a clip that continues() the one before it on its track keeps that
 *  one's, so the player and the sound play the run from one element. */
export function chains(tl: NleTimeline): Map<string, string> {
  const out = new Map<string, string>();
  for (const t of Object.values(tl.tracks)) {
    let prev: NleItem | null = null;
    for (const it of t.items.filter((i) => i.enabled !== false).sort((a, b) => a.rec - b.rec)) {
      out.set(keyOf(it), prev && continues(tl, prev, it) ? out.get(keyOf(prev))! : keyOf(it));
      prev = it;
    }
  }
  return out;
}

/** The fields that change how a picture is drawn: any of them set, the canvas draws it. */
const DRAWN = ["zoom", "pan", "tilt", "rot", "flip", "crop", "fit_x", "fit_y", "frame", "split", "under", "zoom_to", "pan_to", "tilt_to", "look", "fade_in", "fade_out", "freeze", "rev", "fx", "keys"];

/** When the one picture showing is its plain <video> (none of DRAWN, fully seen): how the element fills the frame, as
 *  placement() would ("cover" on the tracks that cover it, else "contain"). Null: the canvas draws it. */
export function plainVideo(on: Playing[]): "cover" | "contain" | null {
  if (on.length !== 1 || (on[0].seen ?? 1) < 1 || on[0].under) return null;
  const { item, track } = on[0];
  const set = (k: string) => {
    const v = (item as Record<string, unknown>)[k];
    if (Array.isArray(v)) return v.some((x) => x !== 0 && x !== "0");
    return v !== undefined && v !== null && v !== 0 && v !== false && v !== "" && !(k === "zoom" && v === 1);
  };
  if ((item.opacity ?? 1) < 1 || DRAWN.some(set)) return null;
  return covers(track) ? "cover" : "contain";
}

/** Which of a file's open elements a run (`owner`) plays from: the one it has; else, under `max`, a new one (-1); else the
 *  one used longest ago that nothing else wants now; else none (null). */
export function pickSlot(slots: { owner: string; used: number; busy: boolean }[], owner: string, max = 2): number | null {
  const own = slots.findIndex((s) => s.owner === owner);
  if (own >= 0) return own;
  if (slots.length < max) return -1;
  let best: number | null = null;
  slots.forEach((s, i) => {
    if (!s.busy && (best === null || s.used < slots[best].used)) best = i;
  });
  return best;
}

/** A sound to play: from `at` seconds on the timeline, `offset` seconds into its file, for `dur` seconds of timeline, at
 *  `gain` (its gain_db + norm_db, linear). `env`, when it keys its gain or has a transition: its whole gain through it as
 *  [seconds from `at`, linear gain] points, straight lines between (fades, keys, crossfades in), for the player to follow
 *  instead of `gain` and the fades. */
export type SoundPiece = { key: string; track?: string; src: string; at: number; offset: number; dur: number; speed: number; gain: number; fadeIn?: number; fadeOut?: number; env?: [number, number][] };

const dbOf = (v: unknown) => Number(v) || 0;

/** Every clip on the sound tracks that are heard, as pieces (a transition's two clips run on into their handles). */
export function soundPieces(tl: NleTimeline): SoundPiece[] {
  const fps = tl.timeline.fps;
  return Object.entries(tl.tracks)
    .filter(([id, t]) => !isVideo(id) && !t.mute && t.enabled !== false)
    .flatMap(([track, t]) => t.items.filter((i) => i.enabled !== false).map((i) => {
      const sfps = tl.sources[i.src]?.fps || fps;
      const [from, to] = spanOf(tl, i);
      const norm = dbOf(i.norm_db);
      const piece: SoundPiece = {
        key: keyOf(i),
        track,
        src: i.src,
        at: from / fps,
        offset: i.in / sfps + ((from - i.rec) * (i.speed || 1)) / fps,
        dur: (to - from) / fps,
        speed: i.speed || 1,
        gain: Math.pow(10, (dbOf(i.gain_db) + norm) / 20),
      };
      if (i.keys?.gain_db?.length || cuts(tl).has(i)) {
        // the gain at each frame's start, straight on to the next (the renderer steps the keys' value a frame at a time)
        const env: [number, number][] = [];
        for (let f = from; f <= to; f++) {
          const db = valueAt(i, "gain_db", f, fps, sfps) + norm;
          const v = Math.pow(10, db / 20) * seenAt(tl, i, f, true).seen;
          // a point between two of the same value says nothing
          if (env.length >= 2 && env[env.length - 1]![1] === v && env[env.length - 2]![1] === v) env[env.length - 1]![0] = (f - from) / fps;
          else env.push([(f - from) / fps, v]);
        }
        return { ...piece, env };
      }
      return {
        ...piece,
        // seconds of fade from / to silence
        ...(i.fade_in ? { fadeIn: i.fade_in / fps } : {}),
        ...(i.fade_out ? { fadeOut: i.fade_out / fps } : {}),
      };
    }));
}

/** A piece's `env` as points on the sound engine's clock (`t0`: when its start plays there), from `from` seconds into
 *  it, at `rate` × speed: the value at `from`, then each point after it. */
export function envPoints(env: [number, number][], t0: number, from: number, rate: number): [number, number][] {
  const i = env.findIndex(([x]) => x > from);
  if (i < 0) return [[t0 + from / rate, env[env.length - 1]![1]]];
  const [x0, v0] = env[Math.max(0, i - 1)]!, [x1, v1] = env[i]!;
  const v = i === 0 ? v1 : v0 + ((v1 - v0) * (from - x0)) / (x1 - x0);
  return [[t0 + from / rate, v], ...env.slice(i).map(([x, g]): [number, number] => [t0 + x / rate, g])];
}

/** Seconds into its source the clip shows at timeline second `t`. */
export const sourceTime = (tl: NleTimeline, it: NleItem, t: number) => {
  const fps = tl.timeline.fps;
  const sfps = tl.sources[it.src]?.fps || fps;
  return (it.in + (t * fps - it.rec) * (sfps / fps) * (it.speed || 1)) / sfps;
};

/** How much smaller than the timeline the viewer draws its frame: the canvas's size on screen in device px, never more
 *  than the timeline's own (a 2160 px frame shown 270 px wide draws 540 px on a 2× screen, not 2160). */
export const drawScale = (cssW: number, dpr: number, W: number) => (cssW > 0 && W > 0 ? Math.min(1, (cssW * (dpr || 1)) / W) : 1);

/** Further than this off the clock, a playing video is moved; nearer, its speed is bent until it is back. */
export const SEEK_S = 0.6;

/** What a playing video does to keep to the timeline's clock when it is `ahead` seconds ahead of it (behind: < 0):
 *  within 2 frames nothing, then its speed bent by up to a quarter, past SEEK_S a move. WebKit stands a video that has
 *  played still for about 240 ms after each move, so moving it for every small drift made playback stall. */
export function steer(ahead: number, speed: number, fps: number): { rate: number; seek: boolean } {
  if (Math.abs(ahead) > SEEK_S) return { rate: speed, seek: true };
  if (Math.abs(ahead) <= 2 / fps) return { rate: speed, seek: false };
  // in steps of 5 %: a speed set on every frame is a hitch of its own
  return { rate: speed * (1 - Math.round(clamp(ahead, -0.25, 0.25) * 20) / 20), seek: false };
}
