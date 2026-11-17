import type { ExportEditor, ExportGaps, Item, Timeline } from "../../contracts/editor";
import { sourceSpan } from "./plan";

/**
 * What the timeline files (otio.ts, fcpxml.ts) carry of a planned shot's preview (plan-render.ts), and what they
 * leave out: `exportGaps` lists the rest per editor, for the notice beside "Open in …".
 */

/** The shot's picture at frame `f` of its own: scale (1 = fitted), and timeline px it moves right (`x`) and up (`y`). */
export interface Key {
  f: number;
  zoom: number;
  x: number;
  y: number;
}

/** A whip comes in as a fast slide from the right: a quarter of the frame over 0.12 s (the preview blurs it instead). */
const WHIP_S = 0.12;
const MOVES = new Set(["punch", "zoom", "shake"]);

/**
 * The shot's framing over its own frames, as the preview draws punch, zoom, shake and a whip: one key when it stands
 * still (its zoom and tilt), else a key at every corner of the moves and every frame of a shake, for linear keyframes.
 */
export function motion(tl: Timeline, i: Item): Key[] {
  const fx = (i.fx ?? []).filter((f) => MOVES.has(f.type));
  const whip = i.enter === "whip";
  const at = (t: number) => {
    let z = 1;
    let dx = 0;
    let dy = 0;
    for (const f of fx) {
      const a = "at" in f ? (f.at ?? 0) : 0;
      if (f.type === "punch") {
        const k = f.amount ?? 1.2;
        if (t >= a && t <= a + 0.3) z *= k - ((k - 1) * (t - a)) / 0.3;
      } else if (f.type === "zoom") {
        const [z0, z1, d] = [f.from ?? 1, f.to ?? 1.2, Math.max(0.01, f.dur ?? 1)];
        z *= t < a ? z0 : t < a + d ? z0 + ((z1 - z0) * (t - a)) / d : z1;
      } else if (f.type === "shake") {
        // the preview scales the whole shot up for room to shake in, and moves its crop (the picture goes the other way)
        const m = 0.02 + 0.06 * (f.amount ?? 0.5);
        z *= 1 + 2 * m;
        if (t >= a && t <= a + (f.dur ?? 0.3)) {
          dx += m * tl.width * Math.sin(t * 83);
          dy += m * tl.height * Math.cos(t * 71);
        }
      }
    }
    const slide = whip && t < WHIP_S ? (tl.width / 4) * (1 - t / WHIP_S) : 0;
    return { zoom: r4((i.zoom ?? 1) * z), x: r4(slide - dx), y: r4((i.tilt ?? 0) * z + dy) };
  };
  if (!fx.length && !whip) return [{ f: 0, ...at(0) }];
  const fps = tl.fps;
  const frames = new Set([0, i.len]);
  const add = (s: number) => frames.add(Math.round(s * fps));
  if (whip) add(WHIP_S);
  for (const f of fx) {
    const a = "at" in f ? (f.at ?? 0) : 0;
    if (f.type === "punch") [a - 1 / fps, a, a + 0.3].forEach(add);
    else if (f.type === "zoom") [a, a + Math.max(0.01, f.dur ?? 1)].forEach(add);
    else if (f.type === "shake") for (let k = Math.round(a * fps) - 1; k <= Math.round((a + (f.dur ?? 0.3)) * fps) + 1; k++) frames.add(k);
  }
  const keys = [...frames].filter((f) => f >= 0 && f <= i.len).sort((a, b) => a - b).map((f) => ({ f, ...at(f / fps) }));
  // a key between two alike is not needed
  const out = keys.filter((k, n) => n === 0 || n === keys.length - 1 || !same(k, keys[n - 1]!) || !same(k, keys[n + 1]!));
  return out.every((k) => same(k, out[0]!)) ? [out[0]!] : out;
}

const r4 = (x: number) => Math.round(x * 10000) / 10000;
const same = (a: Key, b: Key) => a.zoom === b.zoom && a.x === b.x && a.y === b.y;

/**
 * Source seconds (from the shot's in-point) against the shot's own seconds, as the preview plays it: its speed or
 * ramp, its freezes held, backwards when reversed. Linear between the points; null when it plays at one steady speed
 * forwards with no freeze (a plain speed, which every format writes on its own).
 */
export function retime(tl: Timeline, i: Item): Array<{ t: number; v: number }> | null {
  const freezes = (i.fx ?? []).flatMap((f) => (f.type === "freeze" ? [{ a: f.at ?? 0, d: f.dur ?? 0.4 }] : [])).sort((x, y) => x.a - y.a);
  const reverse = i.fx?.some((f) => f.type === "reverse");
  if (!freezes.length && !reverse && !i.ramp?.length) return null;
  const D = i.len / tl.fps;
  const S = (t: number) => sourceSpan(t, i.speed, i.ramp);
  // shot time to the time the source has run: a freeze stops it, and the shot's end is cut by as much
  const run = (t: number) => {
    let held = 0;
    for (const z of freezes) if (t > z.a) held += Math.min(t, z.a + z.d) - z.a;
    return Math.max(0, t - held);
  };
  const ts = new Set([0, D, ...(i.ramp ?? []).map((p) => p.t), ...freezes.flatMap((z) => [z.a, z.a + z.d])]);
  const end = S(run(D));
  return [...ts]
    .filter((t) => t >= 0 && t <= D)
    .sort((a, b) => a - b)
    .map((t) => ({ t: r4(t), v: r4(reverse ? end - S(run(t)) : S(run(t))) }));
}

type Feature =
  | "punch" | "zoom" | "shake" | "whip" | "dissolve" | "reverse" | "freeze" | "ramp"
  | "flash" | "glitch" | "rgb" | "blur" | "invert" | "strobe" | "stutter" | "zoomblur"
  | "frame-blur" | "letterbox" | "inset" | "split" | "texts" | "broll" | "music" | "sfx" | "grade";

/** What each editor's file carries (otio.ts: Resolve, toFcpxml: Final Cut, toFcp7Xml: Premiere). */
export const CARRIES: Record<ExportEditor, Set<Feature>> = {
  resolve: new Set(["broll", "music", "sfx", "grade", "dissolve"]),
  "final-cut": new Set(["punch", "zoom", "shake", "whip", "dissolve", "reverse", "freeze", "ramp"]),
  premiere: new Set(["punch", "zoom", "shake", "whip", "reverse"]),
};

/** The words for each, as the notice reads ("shake on 54 shots"). */
const WORDS: Record<Feature, string> = {
  punch: "punch-ins", zoom: "zooms", shake: "shake", whip: "whip pans", dissolve: "dissolves", reverse: "reversed shots",
  freeze: "freeze frames", ramp: "speed ramps", flash: "flashes", glitch: "glitch", rgb: "colour split", blur: "blur",
  invert: "negative", strobe: "strobe", stutter: "stutter", zoomblur: "zoom blur", "frame-blur": "blurred backgrounds",
  letterbox: "letterbox bars", inset: "picture in picture", split: "split screens", texts: "words on screen",
  broll: "B-roll", music: "music", sfx: "sound effects", grade: "colour grade",
};

/**
 * Per editor, what of the preview its file leaves out, each with how many shots it is on; an editor whose file
 * carries it all has no key. `graded`: the preview is graded (the edit's grade has a look).
 */
export function exportGaps(tl: Timeline, graded = false): ExportGaps {
  const count = new Map<Feature, number>();
  const on = (f: Feature, n = 1) => count.set(f, (count.get(f) ?? 0) + n);
  for (const i of tl.tracks.V1.items) {
    const fs = new Set<Feature>();
    for (const f of i.fx ?? []) fs.add(f.type as Feature);
    if (i.enter && i.enter !== "cut") fs.add(i.enter);
    if (i.ramp?.length) fs.add("ramp");
    if (i.split?.length) fs.add("split");
    else if (i.frame === "blur") fs.add("frame-blur");
    else if (i.frame === "letterbox" || i.frame === "inset") fs.add(i.frame);
    fs.forEach((f) => on(f));
  }
  if (tl.plan?.texts?.length) on("texts", 0);
  if (tl.tracks.V2.items.length) on("broll", 0);
  if (tl.tracks.A2.items.length) on("music", 0);
  if (tl.tracks.A3.items.length) on("sfx", 0);
  if (graded) on("grade", 0);
  const out: ExportGaps = {};
  for (const ed of Object.keys(CARRIES) as ExportEditor[]) {
    const left = [...count].filter(([f]) => !CARRIES[ed].has(f));
    if (left.length) out[ed] = left.map(([f, n]) => (n ? `${WORDS[f]} on ${n} ${n === 1 ? "shot" : "shots"}` : WORDS[f]));
  }
  return out;
}
