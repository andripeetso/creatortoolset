// A clip's keyframes (contracts/editor.ts `Key`): [source frame, value, ease] per prop, so trims, slips, splits and
// pastes never move them; a rate stretch keeps the content and so its keys. The maths is the golden's
// (contracts/edj-golden.json `about`), which the studio engine computes the same way.
import type { EdjItem, Key, KeyEase, KeyProp } from "@contracts/editor";
import { ease } from "./shot";
import { find, rateOf, setItems, type NleItem, type NleTimeline } from "./model";

/** a prop's value when a clip neither keys nor sets it */
export const KEY_STATIC: Record<KeyProp, number> = { zoom: 1, pan: 0, tilt: 0, rot: 0, opacity: 1, gain_db: 0 };

type Keyed = Pick<EdjItem, "rec" | "in" | "speed" | "keys" | KeyProp>;

/** timeline frame f (the player's floor(t·fps)) → the clip's source frame, fractional under speed or sfps ≠ fps */
export const srcFrame = (it: Keyed, f: number, fps: number, sfps: number) => it.in + ((f - it.rec) * (it.speed ?? 1) * sfps) / fps;

/** The prop's value at timeline frame `f`: its keys eased between, held past the first and last; its own value without keys. */
export function valueAt(it: Keyed, prop: KeyProp, f: number, fps: number, sfps: number): number {
  const keys = it.keys?.[prop];
  if (!keys?.length) return it[prop] ?? KEY_STATIC[prop];
  const s = srcFrame(it, f, fps, sfps);
  if (s <= keys[0]![0]) return keys[0]![1];
  const last = keys[keys.length - 1]!;
  if (s >= last[0]) return last[1];
  const i = keys.findIndex((k) => k[0] > s) - 1;
  const [f0, v0, how] = keys[i]!, [f1, v1] = keys[i + 1]!;
  const u = (s - f0) / (f1 - f0);
  return v0 + (v1 - v0) * (how === "hold" ? 0 : how === "linear" ? u : ease(u));
}

const fpsOf = (tl: NleTimeline, it: NleItem) => [tl.timeline.fps, tl.sources[it.src]?.fps || tl.timeline.fps] as const;
const r3 = (n: number) => Math.round(n * 1000) / 1000;
/** the clip's source frame at timeline frame f, as a key stores it */
const keyFrame = (tl: NleTimeline, it: NleItem, f: number) => r3(it.in + (f - it.rec) * rateOf(tl, it));
const same = (a: number, b: number) => Math.abs(a - b) < 1e-3;

/** The clip's value of `prop` at timeline frame `f`. */
export function valueOn(tl: NleTimeline, key: string, prop: KeyProp, f: number): number {
  const it = find(tl, key)?.item;
  return it ? valueAt(it, prop, f, ...fpsOf(tl, it)) : KEY_STATIC[prop];
}

/**
 * A key on the clip at timeline frame `f`: `value` (the value there now when left out) and `ease` (the key there keeps
 * its own when left out; a new one is linear). A shot-list framing becomes keys first (shotToKeys). Not on a locked track.
 */
export function setKey(tl: NleTimeline, key: string, prop: KeyProp, f: number, value?: number, how?: KeyEase): NleTimeline {
  const hit = find(tl, key);
  if (!hit || tl.tracks[hit.track].locked) return tl;
  const shot = shotToKeys(hit.item, rateOf(tl, hit.item));
  const it = { ...hit.item, ...shot };
  const s = keyFrame(tl, it, f);
  const v = value ?? valueAt(it, prop, f, ...fpsOf(tl, it));
  const keys = (it.keys?.[prop] ?? []).filter((k) => !same(k[0], s));
  const had = it.keys?.[prop]?.find((k) => same(k[0], s));
  keys.push([s, v, how ?? had?.[2] ?? "linear"]);
  keys.sort((a, b) => a[0] - b[0]);
  return setItems(tl, [key], { ...shot, keys: { ...it.keys, [prop]: keys } });
}

/** The clip's key of `prop` at timeline frame `f` taken off; the last one leaves its value as the clip's own. */
export function delKey(tl: NleTimeline, key: string, prop: KeyProp, f: number): NleTimeline {
  const hit = find(tl, key);
  const keys = hit?.item.keys?.[prop];
  if (!hit || !keys || tl.tracks[hit.track].locked) return tl;
  const s = keyFrame(tl, hit.item, f);
  const gone = keys.find((k) => same(k[0], s));
  if (!gone) return tl;
  const left = keys.filter((k) => k !== gone);
  const { [prop]: _, ...others } = hit.item.keys!;
  const all = left.length ? { ...others, [prop]: left } : others;
  return setItems(tl, [key], { keys: Object.keys(all).length ? all : undefined, ...(left.length ? {} : { [prop]: gone[1] }) });
}

/** The clip's keys of `prop` that fall on it, each at its timeline frame (fractional under speed or another frame rate). */
export function keysIn(tl: NleTimeline, key: string, prop: KeyProp): { f: number; key: Key }[] {
  const it = find(tl, key)?.item;
  if (!it) return [];
  const r = rateOf(tl, it);
  return (it.keys?.[prop] ?? []).map((k) => ({ f: it.rec + (k[0] - it.in) / r, key: k })).filter((k) => k.f >= it.rec - 1e-6 && k.f < it.rec + it.len - 1e-6);
}

/**
 * A shot-list shot's eased framing (zoom → zoom_to, pan → pan_to, tilt → tilt_to over its part `move` of the curve,
 * shot.ts framingAt) as two keys a prop, exactly the same curve: u = 0 at k0 = -u0·len/(u1-u0) and u = 1 at
 * k1 = (1-u0)·len/(u1-u0) timeline frames into the clip, in source frames at `rate` source frames a timeline frame.
 * The fields that change, the shot-list ones taken off; {} for a clip that is not such a shot.
 */
export function shotToKeys(it: NleItem, rate: number): Partial<NleItem> {
  if (!("zoom_to" in it)) return {};
  const [u0, u1] = Array.isArray(it.move) ? (it.move as number[]) : [0, 1];
  const out: Partial<NleItem> = { zoom_to: undefined, pan_to: undefined, tilt_to: undefined, move: undefined, ease: undefined };
  const len = Math.max(it.len, 1);
  const how: KeyEase = it.ease === "linear" ? "linear" : "ease";
  const keys: Partial<Record<KeyProp, Key[]>> = { ...it.keys };
  for (const p of ["zoom", "pan", "tilt"] as const) {
    const a = typeof it[p] === "number" ? it[p] : KEY_STATIC[p];
    const b = it[`${p}_to`];
    if (typeof b !== "number" || b === a) continue;
    if (u1 === u0) {
      // shortcut: a zero-length move is held at its point on the curve as the clip's own value, not keyed
      out[p] = a + (b - a) * (how === "linear" ? Math.min(1, Math.max(0, u0)) : ease(u0));
      continue;
    }
    const k0 = (-u0 * len) / (u1 - u0);
    const k1 = ((1 - u0) * len) / (u1 - u0);
    keys[p] = [[it.in + k0 * rate, a, how], [it.in + k1 * rate, b, how]];
  }
  return { ...out, keys: Object.keys(keys).length ? keys : undefined };
}
