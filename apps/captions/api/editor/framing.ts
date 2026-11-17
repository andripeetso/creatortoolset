import type { Timeline, TimelineSource } from "../../contracts/editor";

/**
 * Punch-ins: every cut on the speaker track changes scale (1.0 ↔ punch), pan stays 0, and the tilt keeps each
 * source's eye line (the user's, else the one found at analyze, eyeline.ts) at the same screen height, clamped so no
 * edge shows.
 */

/** The most a source may be punched in: 2.0 from 4K (a short side of 2160 px), else 1.5. */
export const maxPunch = (src: Pick<TimelineSource, "w" | "h">) => (Math.min(src.w, src.h) >= 2160 ? 2 : 1.5);

/** The source's size inside a W×H frame at zoom 1: scaled to fit, the whole picture showing. */
export function fitted(src: Pick<TimelineSource, "w" | "h">, W: number, H: number): { w: number; h: number } {
  if (!src.w || !src.h) return { w: W, h: H };
  const s = Math.min(W / src.w, H / src.h);
  return { w: src.w * s, h: src.h * s };
}

/**
 * How far (timeline px) the picture may move up or down at `zoom`: while it is taller than the frame, until an edge
 * would show; while it is shorter (a wide shot in a tall frame), until it would leave the frame.
 */
export const tiltLimit = (fittedH: number, H: number, zoom: number) => Math.abs(zoom * fittedH - H) / 2;

/**
 * The tilt (timeline px, positive = the picture moves up) that keeps an eye line at `eyeline` (a fraction of the
 * source's height from the top) at the same screen height at `zoom`, clamped by tiltLimit.
 */
export function tiltFor(src: Pick<TimelineSource, "w" | "h">, W: number, H: number, zoom: number, eyeline: number): number {
  const { h } = fitted(src, W, H);
  const above = (0.5 - eyeline) * h; // the eye line's height above the centre at zoom 1
  const t = -(zoom - 1) * above; // zooming moves it to zoom × above; move the picture back by the difference
  const lim = tiltLimit(h, H, zoom);
  return Math.round(Math.max(-lim, Math.min(lim, t)) * 100) / 100;
}

/** Zoom and tilt for the n-th speaker shot: even shots wide (no transform), odd shots punched in. */
export function framingOf(n: number, src: TimelineSource, W: number, H: number, punch: number, eyeline: number): { zoom?: number; tilt?: number } {
  if (n % 2 === 0) return {};
  const zoom = Math.min(punch, maxPunch(src));
  if (zoom <= 1) return {};
  const tilt = tiltFor(src, W, H, zoom, eyeline);
  return tilt ? { zoom, tilt } : { zoom };
}

/*
 * Reframing: a frame of another shape (9:16, 1:1, 4:5) cut from the picture, filled (fillZoom), its window following
 * the subject the way an editor moves it: held still while the subject stays near its middle (DEAD), moved once it has
 * been off for HOLD seconds, eased over a time that grows with the distance; cut at once to a new speaker or a new shot
 * (a jump). The path is the window's x over time (Focus.x: 0 = the picture's left edge, 1 = its right), eased from key
 * to key; a key at the same time as the one before is a cut. Only x moves: a wider picture fills the frame's height.
 */

/** A crop window's x (Focus.x) from `t` seconds; eased to the next key; two keys at one time are a cut. */
export interface PathKey {
  t: number;
  x: number;
}

/** How far the subject's middle may stray from the window's middle before it moves, as a share of the window's width. */
export const DEAD = 0.15;
/** How long the subject is off the middle before the window moves to it (s). */
export const HOLD = 0.5;

/** The shortest turn the window cuts to (s): a shorter one (a "yes", a laugh) stays on the one talking before. */
export const MIN_SHOT = 1.2;

/** The zoom that fills the W×H frame with the source (no bars). */
export function fillZoom(src: Pick<TimelineSource, "w" | "h">, W: number, H: number): number {
  const f = fitted(src, W, H);
  return Math.max(W / f.w, H / f.h);
}

/** The window's width as a share of the picture's at `zoom` (1 = it shows the whole width). */
export const windowOf = (src: Pick<TimelineSource, "w" | "h">, W: number, H: number, zoom: number) => Math.min(1, W / (fitted(src, W, H).w * zoom));

/** The path's x at `t`: eased (smoothstep) between keys, held before the first and after the last. */
export function pathAt(keys: PathKey[], t: number): number {
  if (!keys.length) return 0.5;
  let i = 0;
  while (i + 1 < keys.length && keys[i + 1]!.t <= t) i++;
  const [a, b] = [keys[i]!, keys[i + 1]];
  if (!b || t <= a.t) return a.x;
  const u = (t - a.t) / (b.t - a.t);
  return a.x + (b.x - a.x) * u * u * (3 - 2 * u);
}

const r4 = (x: number) => Math.round(x * 1e4) / 1e4;
const r3 = (x: number) => Math.round(x * 1e3) / 1e3;

/**
 * The window's path over the subject's middle `c` (a share of the picture's width) sampled in time; `jump` marks a
 * sample where the subject is someone else (a new speaker, a new shot): the window cuts there when it has to move.
 * `win`: the window's width as a share of the picture's.
 */
export function followPath(targets: { t: number; c: number; jump?: boolean }[], win: number): PathKey[] {
  if (!targets.length || win >= 0.999) return [];
  const lo = win / 2;
  const hi = 1 - win / 2;
  const inside = (c: number) => Math.min(hi, Math.max(lo, c));
  const focus = (c: number) => r4((inside(c) - lo) / (hi - lo));
  const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1]!;
  const t0 = targets[0]!.t;
  let cur = inside(median(targets.filter((s) => s.t <= t0 + HOLD && (s.t === t0 || !s.jump)).map((s) => s.c)));
  const keys: PathKey[] = [{ t: r3(t0), x: focus(cur) }];
  let off: number | null = null; // since when the subject has been off the middle
  let busy = -Infinity; // the end of a move under way
  let lastCut: { t: number; at: number } | null = null;
  for (let i = 0; i < targets.length; i++) {
    const s = targets[i]!;
    if (s.t < busy) continue;
    const c = inside(s.c);
    const far = Math.abs(c - cur) > DEAD * win;
    if (s.jump) {
      off = null;
      if (far) {
        // where the new subject stays, not where it was caught mid-move
        const next = inside(median(targets.slice(i).filter((x) => x.t <= s.t + HOLD).map((x) => x.c)));
        // a cut right after a cut (a shot change, then the turn that starts in it) is one cut, to where it ends up
        if (lastCut && s.t - lastCut.t < MIN_SHOT) keys[lastCut.at]!.x = focus(next);
        else {
          keys.push({ t: r3(s.t), x: focus(cur) }, { t: r3(s.t), x: focus(next) });
          lastCut = { t: s.t, at: keys.length - 1 };
        }
        cur = next;
      }
      continue;
    }
    if (!far) {
      off = null;
      continue;
    }
    off ??= s.t;
    if (s.t - off < HOLD) continue;
    const next = inside(median(targets.filter((x) => x.t >= off! && x.t <= s.t).map((x) => x.c)));
    const dur = Math.min(1.5, Math.max(0.5, 0.4 + (1.5 * Math.abs(next - cur)) / win));
    keys.push({ t: r3(s.t), x: focus(cur) }, { t: r3(s.t + dur), x: focus(next) });
    cur = next;
    busy = s.t + dur;
    off = null;
  }
  // a hold needs only its first key: drop a key between two of the same x
  return keys.filter((k, i) => !(i > 0 && i < keys.length - 1 && keys[i - 1]!.x === k.x && keys[i + 1]!.x === k.x && keys[i - 1]!.t !== k.t));
}

/** The part of a source's path an item shows: from `inS` for `lenS` seconds, timed from the item's start. */
export function pathIn(keys: PathKey[], inS: number, lenS: number): PathKey[] {
  if (!keys.length) return [];
  const out: PathKey[] = [{ t: 0, x: r4(pathAt(keys, inS)) }];
  for (const k of keys) if (k.t > inS && k.t < inS + lenS) out.push({ t: r3(k.t - inS), x: k.x });
  const end = r4(pathAt(keys, inS + lenS));
  if (out.some((k) => k.x !== out[0]!.x) || end !== out[0]!.x) out.push({ t: r3(lenS), x: end });
  return out;
}

/**
 * Who to keep in the window at each looked-at frame: the face of the speaker whose turn it is (the last turn before,
 * between turns; the first, before any; a turn shorter than MIN_SHOT is not cut to); two or more speakers who fit in
 * the window together are framed together, so a conversation side by side holds still. With the speaker not in the picture (a cut to the other camera, someone
 * off screen talking), the biggest face. `jump` where the face kept changes.
 */
export function speakerTargets(
  frames: { t: number; faces: { x: number; w: number; id: number }[] }[],
  turns: { s: number; e: number; speaker: number }[],
  tracks: Record<number, number[]>,
  win: number,
): { t: number; c: number; jump?: boolean }[] {
  const talkers = new Set(Object.values(tracks).flat());
  const held = turns.filter((x) => x.e - x.s >= MIN_SHOT);
  if (!held.length && turns.length) held.push(turns.reduce((a, b) => (b.e - b.s > a.e - a.s ? b : a)));
  const out: { t: number; c: number; jump?: boolean }[] = [];
  let was: string | null = null;
  const seen = new Map<number, { t: number; c: number }>();
  for (const fr of frames) {
    if (!fr.faces.length) continue;
    const turn = [...held].reverse().find((x) => x.s <= fr.t + 1e-6) ?? held[0];
    const mine = new Set(turn?.speaker ? tracks[turn.speaker] : []);
    const together = fr.faces.filter((f) => talkers.has(f.id));
    const left = Math.min(...together.map((f) => f.x));
    const right = Math.max(...together.map((f) => f.x + f.w));
    let pick: { key: string; c: number };
    if (together.length > 1 && right - left <= 0.85 * win) pick = { key: together.map((f) => f.id).sort().join("+"), c: (left + right) / 2 };
    else {
      const f = fr.faces.find((x) => mine.has(x.id));
      // a face missed for a moment is held where it was, not swapped for another one
      const missed = !f && was && mine.has(Number(was)) && fr.t - (seen.get(Number(was))?.t ?? -9) <= 1 ? seen.get(Number(was)) : undefined;
      const g = f ?? (missed ? null : [...fr.faces].sort((a, b) => b.w - a.w)[0]!);
      pick = g ? { key: String(g.id), c: g.x + g.w / 2 } : { key: was!, c: missed!.c };
    }
    for (const f of fr.faces) seen.set(f.id, { t: fr.t, c: f.x + f.w / 2 });
    out.push({ t: fr.t, c: pick.c, ...(was !== null && pick.key !== was ? { jump: true } : {}) });
    was = pick.key;
  }
  return out;
}

/**
 * A cut reframed to its own frame: every speaker shot (V1) of a source that has a picture fills the frame, its window
 * following `follow[src]` (the source's path, in its seconds); who talks (`turns`, source seconds) goes on the
 * timeline's frames. A shot of a source with no path keeps the middle.
 */
export function reframeTimeline(
  tl: Timeline,
  follow: Record<string, { keys: PathKey[]; turns?: { s: number; e: number; speaker: number }[] }>,
): Timeline {
  const speakers: NonNullable<Timeline["speakers"]> = [];
  const items = tl.tracks.V1.items.map((it) => {
    const src = tl.sources[it.src];
    if (!src?.w) return it;
    const inS = it.in / src.fps;
    const lenS = it.len / tl.fps;
    const f = follow[it.src];
    for (const t of f?.turns ?? []) {
      const [s, e] = [Math.max(t.s, inS), Math.min(t.e, inS + lenS)];
      if (e > s) speakers.push({ rec: it.rec + Math.round((s - inS) * tl.fps), len: Math.max(1, Math.round((e - s) * tl.fps)), speaker: t.speaker });
    }
    const { tilt: _tilt, focus: _focus, ...rest } = it;
    const path = f ? pathIn(f.keys, inS, lenS) : [];
    return { ...rest, zoom: Math.round(fillZoom(src, tl.width, tl.height) * 1e4) / 1e4, ...(path.length ? { path } : {}) };
  });
  // turns that run on across a cut are one stretch on the timeline
  const joined = speakers.sort((a, b) => a.rec - b.rec).reduce<typeof speakers>((out, x) => {
    const last = out.at(-1);
    if (last && last.speaker === x.speaker && x.rec <= last.rec + last.len + 1) last.len = Math.max(last.len, x.rec + x.len - last.rec);
    else out.push({ ...x });
    return out;
  }, []);
  return { ...tl, tracks: { ...tl.tracks, V1: { ...tl.tracks.V1, items } }, ...(joined.length ? { speakers: joined } : {}) };
}
