import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { stat, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { GenSpec } from "../../contracts/edit-plan";
import { ffmpegCommand } from "../ffmpeg-runtime";
import { atomically, ffmpegSlot } from "../library/media/run";

/**
 * Generated clips: pictures made from nothing but a style and the sound, for an edit with footage or without. Each
 * style is one ffmpeg graph (its own sources and filters, nothing else to install). With `audio` the picture moves to
 * that sound from `audioStartS`; without it, to a made-up beat, so it still moves. `palette` sets the colours, `seed`
 * makes a clip repeatable, and words that name no style land on the nearest one.
 *
 * Two passes, each one ffmpeg in the server-wide limit (`ffmpegSlot`): the sound is read once into a level per frame
 * (how loud, and how hard the low end hits), written as a tiny video of a few grey pixels a frame; then the picture is
 * drawn with that video as one of its inputs. Both stream, so a clip takes time in step with its length and no song
 * is held in memory. A caller must not hold an ffmpeg slot while it waits here.
 */

export interface GenClip {
  path: string;
  w: number;
  h: number;
  fps: number;
  seconds: number;
}

/** What one style's graph is built from. Inputs: [0:a] the sound, [1:v] the level video (3×1 grey: L, K, G). */
interface Ctx {
  w: number;
  h: number;
  fps: number;
  /** frames to draw */
  n: number;
  seconds: number;
  rnd: () => number;
  seed: number;
  /** colour stops, from the picture's dark parts to its brightest, as [r,g,b] 0–255 */
  stops: Rgb[];
}

type Rgb = [number, number, number];

interface Style {
  id: string;
  line: string;
  /** words that point at this style */
  words: string[];
  palette: string[];
  /** the graph up to a grey picture `[g]` at w×h, which the palette colours */
  graph: (c: Ctx) => string;
  /** the level pulses the picture's brightness (styles drawn from the sound itself already move with it) */
  pulse: boolean;
}

// ——— pieces shared by the styles ———

const even = (v: number) => Math.max(2, Math.round(v / 2) * 2);
const f = (v: number) => (Math.round(v * 1e4) / 1e4).toString();

/** The level video at a working size, each third of it one value: L (loudness) at x=0, K (the hit) at the middle. */
const level = (w: number, h: number, label: string) => `[1:v]scale=${w}:${h}:flags=neighbor,format=gray[${label}]`;
/** In a geq over the level video: L and K as 0–1. */
const L = "(p(0,0)/255)";
const K = "(p(W/2,0)/255)";

/** A grey field from a geq expression drawn at a third of the size (smooth fields lose nothing), then scaled up. */
function field(c: Ctx, expr: string, div = 3): string {
  const sw = even(c.w / div);
  const sh = even(c.h / div);
  return `${level(sw, sh, "lv")};[lv]geq=lum='${expr}',scale=${c.w}:${c.h}:flags=bicubic[g]`;
}

/** Centred coordinates in a geq, in heights: x across, y down, both 0 at the middle. */
const X = "((X-W/2)/H)";
const Y = "((Y-H/2)/H)";

/** The sound as a stereo stream that never runs out (a song shorter than the clip goes quiet, not short). */
const sound = (label: string) => `[0:a]aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo,apad[${label}]`;

/** A soft glow round the bright parts: the picture plus a blurred copy of itself. */
const glow = (inp: string, out: string, sigma: number) =>
  `[${inp}]split[${out}a][${out}b];[${out}b]gblur=sigma=${f(sigma)}[${out}c];[${out}a][${out}c]blend=all_mode=screen[${out}]`;

/** Constant-Q spectrum bars (`bars` wide, `h` tall, white on black): one per few notes, so a song fills them evenly. */
const cqt = (inp: string, bars: number, h: number, fps: number) =>
  `[${inp}]showcqt=s=480x${h}:r=${fps}:sono_h=0:bar_h=${h}:axis=0:bar_g=2:bar_v=6:count=1,format=gray,scale=${bars}:${h}:flags=area,lut=y='if(gt(val,30),255,0)'`;

const pick = <T>(c: Ctx, xs: readonly T[]): T => xs[Math.floor(c.rnd() * xs.length)]!;

// Interesting places to zoom into, where the edge keeps detail deep down.
const DEEP: Array<[number, number]> = [
  [-0.743643887037151, 0.13182590420533],
  [-0.743643887037151, -0.13182590420533],
  [-0.7453, 0.1127],
  [-0.77568377, 0.13646737],
  [0.001643721971153, -0.822467633298876],
  [-0.10109636384562, 0.95628651080914],
];

const STYLES: Style[] = [
  {
    id: "spectrum",
    line: "Glowing spectrum bars, bass in the middle and treble out to the sides, jumping with the song",
    words: ["spectrum", "bars", "bar", "equalizer", "equaliser", "eq", "frequency", "frequencies", "analyzer", "analyser", "visualizer", "visualiser", "visualization", "visualisation", "audio", "music", "bass", "meter"],
    palette: ["#1b0b3a", "#6a1bd6", "#ff3d9a", "#ffd166"],
    pulse: false,
    graph: (c) => {
      // a constant-Q spectrum (one bar per few notes), mirrored so the bass sits in the middle
      const half = 16;
      const bw = Math.max(2, Math.floor(c.w / (half * 2)));
      const bh = even(c.h * 0.55);
      return [
        sound("a"),
        `${cqt("a", half, bh, c.fps)},scale=${half * bw}:${bh}:flags=neighbor,` +
          `geq=lum='if(lt(mod(X,${bw}),${Math.max(1, Math.round(bw * 0.25))}),0,p(X,Y)*(0.35+0.65*Y/H))',split[r][l];[l]hflip[lf];[lf][r]hstack,` +
          `pad=${c.w}:${c.h}:(ow-iw)/2:oh-ih-${even(c.h * 0.15)},lagfun=decay=0.86[b0]`,
        glow("b0", "g", c.w / 40),
      ].join(";");
    },
  },
  {
    id: "radial",
    line: "A ring of the song's frequencies round the middle, bursting outward on the beat",
    words: ["radial", "circle", "circular", "ring", "round", "orb", "sun", "halo", "burst"],
    palette: ["#02101f", "#0a6cff", "#3de0ff", "#f4fbff"],
    pulse: false,
    graph: (c) => {
      // spectrum bars bent round the centre (polar remap; the maps are drawn once and repeated), bass at the top
      const bars = 36;
      const sh = 256;
      const r0 = 0.2 * c.w;
      const r1 = 0.47 * c.w;
      const still = (fmt: string, e: string) =>
        `nullsrc=s=${c.w}x${c.h}:d=1:r=1,format=${fmt},geq=lum='${e}',loop=loop=-1:size=1,fps=${c.fps}`;
      const map = (e: string) => still("gray16le", e);
      const ang = `abs(atan2(X-W/2,H/2-Y))/PI`;
      const rad = `hypot(X-W/2,Y-H/2)`;
      return [
        sound("a"),
        `${cqt("a", bars, sh, c.fps)},scale=${bars * 8}:${sh}:flags=neighbor,geq=lum='if(lt(mod(X,8),3),0,p(X,Y))',format=gray16le[band]`,
        `${map(`min(${ang}*${bars * 8},${bars * 8 - 1})`)}[xm]`,
        `${map(`if(between(${rad},${f(r0)},${f(r1)}),${sh - 1}-(${rad}-${f(r0)})/${f(r1 - r0)}*${sh - 1},${sh * 4})`)}[ym]`,
        // a thin ring under the bars keeps the shape when the song is quiet
        `${still("gray", `140*exp(-pow((${rad}-${f(r0 - 4)})/${f(Math.max(1, c.w / 400))},2))`)}[ring]`,
        `[band][xm][ym]remap=fill=black,format=gray,lagfun=decay=0.85[bars];[bars][ring]blend=all_mode=lighten[r0]`,
        glow("r0", "g", c.w / 35),
      ].join(";");
    },
  },
  {
    id: "waves",
    line: "Three glowing waveform ribbons, low, mid and high, flowing across the frame",
    words: ["wave", "waves", "waveform", "ribbon", "ribbons", "line", "lines", "flowing", "sound", "voice", "podcast"],
    palette: ["#05060f", "#00b3a4", "#7cf2c8", "#fff4c2"],
    pulse: false,
    graph: (c) => {
      const bh = even(c.h * 0.2);
      // each band its own brightness, so each takes its own colour from the palette
      const one = (inp: string, out: string, af: string, lift: number) =>
        `[${inp}]${af},showwaves=s=${c.w}x${bh}:mode=p2p:rate=${c.fps}:scale=sqrt:draw=full:colors=white,format=gray,dilation,lut=y='val*${f(lift)}'[${out}]`;
      return [
        sound("a"),
        `[a]asplit=3[a1][a2][a3]`,
        one("a1", "w1", "lowpass=f=200", 1),
        one("a2", "w2", "bandpass=f=1000:width_type=o:w=2,volume=2", 0.75),
        one("a3", "w3", "highpass=f=4000,volume=1.5", 0.55),
        `color=c=black:s=${c.w}x${c.h}:r=${c.fps},format=gray[bg]`,
        `[bg][w1]overlay=y=${even(c.h * 0.17)}[o1];[o1][w2]overlay=y=${even(c.h * 0.4)}[o2];[o2][w3]overlay=y=${even(c.h * 0.63)},lagfun=decay=0.85[r0]`,
        glow("r0", "g", c.w / 45),
      ].join(";");
    },
  },
  {
    id: "scope",
    line: "A laser-like vectorscope: the left and right channels drawn against each other as glowing loops",
    words: ["scope", "vectorscope", "oscilloscope", "lissajous", "laser", "vector", "loops", "neon"],
    palette: ["#000000", "#13ff8a", "#b6ffd9", "#ffffff"],
    pulse: false,
    graph: (c) => {
      const s = even(Math.min(c.w, c.h) * 0.95);
      return [
        sound("a"),
        // a few milliseconds between the channels opens a mono song into loops
        `[a]adelay=delays=0|${(2 + Math.floor(c.rnd() * 4)).toString()},avectorscope=s=${s}x${s}:r=${c.fps}:mode=lissajous:draw=line:scale=sqrt:zoom=1.1:rc=255:gc=255:bc=255:rf=30:gf=30:bf=30,` +
          `format=gray,lagfun=decay=0.7,pad=${c.w}:${c.h}:(ow-iw)/2:(oh-ih)/2[r0]`,
        glow("r0", "g", c.w / 60),
      ].join(";");
    },
  },
  {
    id: "plasma",
    line: "Liquid plasma: soft colour bands that melt into each other and shift on the beat",
    words: ["plasma", "liquid", "lava", "psychedelic", "trippy", "abstract", "melt", "fluid", "acid", "retro", "dream"],
    palette: ["#1a0536", "#ff2e88", "#ffb000", "#2de2e6"],
    pulse: true,
    graph: (c) => {
      const [a, b, d, e] = [0, 1, 2, 3].map(() => f(c.rnd() * 6.283));
      const [k1, k2, k3, k4] = [7, 6, 5, 11].map((k) => f(k * (0.8 + 0.4 * c.rnd())));
      const v =
        `sin(${X}*${k1}+T*0.6+${a})+sin(${Y}*${k2}-T*0.45+${b})+sin((${X}*cos(T*0.1)+${Y}*sin(T*0.13))*${k3}+${d})` +
        `+sin(hypot(${X}-0.15*sin(T*0.35+${e}),${Y}-0.3*cos(T*0.27+${a}))*${k4}-T*0.9)`;
      return field(c, `127.5+127.5*sin((${v})*1.2+3*${L})`);
    },
  },
  {
    id: "tunnel",
    line: "Flying down an endless tunnel of lights that surges forward with the music",
    words: ["tunnel", "warp", "hyperspace", "vortex", "wormhole", "portal", "speed", "travel", "infinite"],
    palette: ["#000000", "#3a0ca3", "#f72585", "#fefae0"],
    pulse: true,
    graph: (c) => {
      const n = pick(c, [6, 8, 10, 12]);
      const tw = f((c.rnd() - 0.5) * 2);
      const r = `(hypot(${X},${Y})+0.002)`;
      const z = `(0.3/${r}+T*0.9+1.4*${L})`;
      const s = `sin(${z}*2*PI)*sin(atan2(${Y},${X})*${n}+${z}*${tw}+T*0.4)`;
      return field(c, `255*min(1,${r}*5)*pow(0.5+0.5*${s},1.6)`, 2);
    },
  },
  {
    id: "shapes",
    line: "Strobing geometric shapes: nested squares, hexagons or triangles turning against each other, flashing on hits",
    words: ["shapes", "geometric", "geometry", "strobe", "strobing", "square", "squares", "triangle", "hexagon", "kaleidoscope", "festival", "rave", "techno", "club", "stage", "edm"],
    palette: ["#050505", "#ff0054", "#ffbd00", "#ffffff"],
    pulse: true,
    graph: (c) => {
      const rings = f(6 + c.rnd() * 6);
      const dist = (u: string, v: string) =>
        pick(c, [
          `max(abs(${u}),abs(${v}))`,
          `max(abs(${u})*0.866+abs(${v})*0.5,abs(${v}))`,
          `max(abs(${u})*0.866+${v}*0.5,-${v})`,
        ]);
      const layer = (spin: number) => {
        const th = `(T*${f(spin)})`;
        const u = `(${X}*cos(${th})-${Y}*sin(${th}))`;
        const v = `(${X}*sin(${th})+${Y}*cos(${th}))`;
        const q = `(${dist(u, v)}*${rings}-T*0.7-1.2*${L})`;
        return `lt(${q}-floor(${q}),0.5)`;
      };
      // two layers turning against each other, each its own brightness: where they cross takes a third colour
      const bands = `(0.6*${layer(0.25 + c.rnd() * 0.2)}+0.4*${layer(-(0.15 + c.rnd() * 0.2))})`;
      // the strobe: a hard hit turns the picture inside out for a frame or two
      return field(c, `255*if(gt(${K},0.7),1-${bands},${bands})`, 2);
    },
  },
  {
    id: "fractal",
    line: "A slow dive into a Mandelbrot fractal, its edge unfolding into ever finer detail",
    words: ["fractal", "mandelbrot", "zoom", "dive", "infinite", "math", "cosmic", "space"],
    palette: ["#03071e", "#6a040f", "#e85d04", "#ffba08", "#fffbe6"],
    pulse: true,
    graph: (c) => {
      const [x, y] = pick(c, DEEP);
      // starts close on the edge and halves the view every 1.5 s, down to what double precision still draws
      const end = 0.02 * 2 ** -Math.min(c.seconds / 1.5, 32);
      const sw = even(c.w / 2);
      const sh = even(c.h / 2);
      return (
        `mandelbrot=s=${sw}x${sh}:rate=${c.fps}:start_x=${x}:start_y=${y}:start_scale=0.02:end_scale=${end}:end_pts=${c.n}:maxiter=400:` +
        `outer=normalized_iteration_count:inner=black,format=gray,scale=${c.w}:${c.h}:flags=bicubic[g]`
      );
    },
  },
  {
    id: "automata",
    line: "Cellular automata: rule-made pixel patterns of triangles and lace that keep growing down the screen",
    words: ["automata", "automaton", "cellular", "cells", "pixel", "pixels", "8bit", "8-bit", "lace", "pattern", "generative", "code"],
    palette: ["#0b0c10", "#1f6feb", "#58f5c0", "#f0f6fc"],
    pulse: true,
    graph: (c) => {
      const cell = Math.max(2, Math.round(c.w / 160));
      const cw = Math.ceil(c.w / cell);
      const rule = pick(c, [18, 22, 90, 150]); // the rules that grow lace from a few cells (an odd one flips every empty row)
      return [
        `cellauto=s=${cw}x${Math.ceil(c.h / cell)}:rate=${c.fps}:rule=${rule}:seed=${c.seed}:ratio=0.03:scroll=1:full=1:stitch=1,format=gray,` +
          `scale=${cw * cell}:${Math.ceil(c.h / cell) * cell}:flags=neighbor,crop=${c.w}:${c.h}:0:0[r0]`,
        glow("r0", "g", c.w / 120),
      ].join(";");
    },
  },
  {
    id: "life",
    line: "The Game of Life: colonies of cells that are born, spread and fade, leaving glowing trails",
    words: ["life", "conway", "colony", "colonies", "organic", "bacteria", "growth", "grow", "cells"],
    palette: ["#07020f", "#3b0f70", "#f72585", "#ffd6ff"],
    pulse: true,
    graph: (c) => {
      const cell = Math.max(2, Math.round(c.w / 135));
      const cw = Math.ceil(c.w / cell);
      const ch = Math.ceil(c.h / cell);
      const rule = pick(c, ["B3/S23", "B36/S23", "B3678/S34678", "B368/S245"]);
      return [
        `life=s=${cw}x${ch}:rate=${c.fps}:rule=${rule}:seed=${c.seed}:ratio=0.35:mold=8:stitch=1:life_color=white:death_color=black:mold_color=#404040,format=gray,` +
          `scale=${cw * cell}:${ch * cell}:flags=neighbor,crop=${c.w}:${c.h}:0:0[r0]`,
        glow("r0", "g", c.w / 90),
      ].join(";");
    },
  },
  {
    id: "aurora",
    line: "Aurora: soft curtains of light waving across a dark sky, rays hanging down, calm under any sound",
    words: ["aurora", "flow", "gradient", "gradients", "soft", "calm", "chill", "ambient", "sky", "northern", "curtain", "mood", "minimal", "dreamy", "lofi"],
    palette: ["#020617", "#0e7490", "#34d399", "#e0f2fe"],
    pulse: true,
    graph: (c) => {
      // curtains of light: a bright edge that waves across, rays hanging down from it, two layers drifting apart
      const curtain = (k: number) => {
        const [a, b, r] = [0, 1, 2].map(() => f(c.rnd() * 6.283));
        const y0 = f(0.3 + 0.25 * k);
        const edge = `(${y0}+0.1*sin(X/W*3+T*0.35+${a})+0.05*sin(X/W*8-T*0.6+${b})-0.04*${L})`;
        const d = `(Y/H-${edge})`;
        const rays = `(0.55+0.45*sin(X/W*40+T*1.5+3*sin(X/W*6+T*0.2+${r})))`;
        return `if(gt(${d},0),exp(-${d}*${f(7 - 2 * k)})*${rays},exp(-pow(${d}*25,2)))`;
      };
      return field(c, `255*min(1,(0.75*${curtain(0)}+0.6*${curtain(1)})*(0.7+0.3*${L}))`, 2);
    },
  },
];

/** Each style with one plain line the AI reads to choose. */
export function styles(): Array<{ id: string; line: string }> {
  return STYLES.map(({ id, line }) => ({ id, line }));
}

/** The style a word or a few free words name: an id, then the words each style answers to, then the first style. */
export function styleFor(words: string): Style {
  const low = words.toLowerCase();
  const exact = STYLES.find((s) => s.id === low.trim());
  if (exact) return exact;
  const tokens = low.split(/[^a-z0-9-]+/).filter((t) => t.length > 1);
  let best = STYLES[0]!;
  let score = 0;
  for (const s of STYLES) {
    let n = 0;
    for (const t of tokens) {
      if (t === s.id) n += 3;
      else if (s.words.includes(t)) n += 2;
      else if (t.length >= 4 && s.words.some((w) => w.length >= 4 && (t.startsWith(w) || w.startsWith(t)))) n += 1;
    }
    if (n > score) [best, score] = [s, n];
  }
  return best;
}

const parseHex = (s: string): Rgb | null => {
  const m = /^#?([0-9a-f]{6})$/i.exec(s.trim());
  if (!m) return null;
  const v = parseInt(m[1]!, 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
};
const mix = (a: Rgb, b: Rgb, t: number): Rgb => [0, 1, 2].map((i) => Math.round(a[i]! + (b[i]! - a[i]!) * t)) as Rgb;
const luma = (c: Rgb) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

/**
 * Stops for a grey picture, in the palette's order: the first colour for the dark parts, the last for the brightest.
 * A first colour that is not dark gets a near-black of itself before it, so the picture keeps its depth; one colour
 * runs from its near-black through it to a light tint.
 */
function stopsOf(colours: Rgb[]): Rgb[] {
  const [first] = colours;
  if (colours.length === 1) return [mix(first!, [0, 0, 0], 0.9), first!, mix(first!, [255, 255, 255], 0.7)];
  return luma(first!) < 40 ? colours : [mix(first!, [0, 0, 0], 0.85), ...colours];
}

/** lutrgb expressions mapping grey 0–255 along the stops, one per channel. */
function paletteLut(stops: Rgb[]): string {
  const step = 255 / (stops.length - 1);
  const ch = (i: number) => {
    let e = f(stops[stops.length - 1]![i]!);
    for (let k = stops.length - 2; k >= 0; k--) {
      const a = stops[k]![i]!;
      const b = stops[k + 1]![i]!;
      e = `if(lt(val,${f(step * (k + 1))}),${f(a)}+${f((b - a) / step)}*(val-${f(step * k)}),${e})`;
    }
    return `'${e}'`;
  };
  return `lutrgb=r=${ch(0)}:g=${ch(1)}:b=${ch(2)}`;
}

/** A small seeded generator (mulberry32): the same seed, the same clip. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const num = (v: unknown, lo: number, hi: number, dflt: number) => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};

/** The made-up beat a clip moves to when it has no sound: a kick, a clap, a bass line and a pad, from the seed. */
function madeUpBeat(seed: number, seconds: number): string {
  const r = rng(seed ^ 0x5eed);
  const p = 60 / (100 + Math.floor(r() * 28));
  const root = f(41 + r() * 25);
  const P = f(p);
  const expr =
    `0.9*sin(2*PI*(45+90*exp(-30*mod(t,${P})))*mod(t,${P}))*exp(-7*mod(t,${P}))` +
    `+0.25*(2*random(0)-1)*exp(-20*mod(t+${f(p / 2)},${f(p * 2)}))` +
    `+0.3*sin(2*PI*${root}*2*t)*exp(-3*mod(t+${f(p / 2)},${P}))` +
    `+0.15*sin(2*PI*${root}*4*t+2*sin(2*PI*0.25*t))*(0.5+0.5*sin(2*PI*t/${f(p * 16)}))`;
  return `aevalsrc=exprs='${expr}':s=44100:d=${f(seconds + 1)}`;
}

/** Runs ffmpeg in the server-wide limit; abort kills it. stdout goes to `onData` when given. */
function run(args: string[], signal?: AbortSignal, onData?: (b: Buffer) => void): Promise<void> {
  return ffmpegSlot(
    () =>
      new Promise<void>((resolve, reject) => {
        if (signal?.aborted) return reject(signal.reason ?? new Error("aborted"));
        const p = spawn(ffmpegCommand(), ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", ...args], {
          signal,
          stdio: ["ignore", onData ? "pipe" : "ignore", "pipe"],
        });
        let err = "";
        p.stderr!.on("data", (d) => (err = (err + d.toString()).slice(-2000)));
        if (onData) p.stdout!.on("data", onData);
        p.on("error", reject);
        p.on("close", (code) => {
          if (signal?.aborted) reject(signal.reason ?? new Error("aborted"));
          else if (code === 0) resolve();
          else reject(new Error(err.trim() || `ffmpeg exited ${code}`));
        });
      }),
  );
}

const SR = 11025;

/**
 * The sound's level for each frame, as bytes for a 3×1 grey video: L how loud (smoothed, against the clip's own loud
 * parts), K how hard the low end just hit (decays fast), G the brightness a pulsing style takes from both.
 */
async function levels(input: string[], seconds: number, n: number, fps: number, signal?: AbortSignal): Promise<Buffer> {
  const rms = new Float32Array(n);
  const low = new Float32Array(n);
  let i = 0; // sample index
  let frame = 0;
  let end = Math.floor(SR / fps);
  let sum = 0;
  let sumLo = 0;
  let count = 0;
  let rest = Buffer.alloc(0);
  const close = () => {
    if (frame < n && count) {
      rms[frame] = Math.sqrt(sum / count);
      low[frame] = Math.sqrt(sumLo / count);
    }
    frame++;
    end = Math.floor(((frame + 1) * SR) / fps);
    sum = sumLo = count = 0;
  };
  await run(
    [
      ...input,
      "-filter_complex",
      `[0:a]aformat=sample_fmts=flt:sample_rates=${SR}:channel_layouts=mono,apad,asplit[x][y];[y]lowpass=f=150,lowpass=f=150[lo];[x][lo]amerge=inputs=2[o]`,
      "-map", "[o]", "-t", f(seconds), "-f", "f32le", "pipe:1",
    ],
    signal,
    (chunk) => {
      const b = rest.length ? Buffer.concat([rest, chunk]) : chunk;
      const whole = b.length - (b.length % 8);
      for (let o = 0; o < whole; o += 8) {
        const s = b.readFloatLE(o);
        const lo = b.readFloatLE(o + 4);
        sum += s * s;
        sumLo += lo * lo;
        count++;
        if (++i >= end) close();
      }
      rest = Buffer.from(b.subarray(whole));
    },
  );
  if (count) close();

  const ref = (a: Float32Array, q: number) => {
    const s = Float32Array.from(a).sort();
    return Math.max(s[Math.min(s.length - 1, Math.floor(s.length * q))] ?? 0, 1e-4);
  };
  const flux = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    let avg = 0;
    for (let j = Math.max(0, k - 6); j < k; j++) avg += low[j]!;
    avg /= Math.max(1, Math.min(6, k));
    flux[k] = Math.max(0, low[k]! - avg);
  }
  const rRef = ref(rms, 0.95);
  const fRef = ref(flux, 0.97);
  const release = 0.85 ** (30 / fps);
  const hitDecay = 0.65 ** (30 / fps);
  const out = Buffer.alloc(n * 3);
  let l = 0;
  let h = 0;
  for (let k = 0; k < n; k++) {
    l = Math.max(Math.min(1, rms[k]! / rRef) ** 0.8, l * release);
    h = Math.max(Math.min(1, flux[k]! / fRef), h * hitDecay);
    out[k * 3] = Math.round(l * 255);
    out[k * 3 + 1] = Math.round(h * 255);
    out[k * 3 + 2] = Math.round(Math.min(1, 0.45 + 0.4 * l + 0.3 * h) * 255);
  }
  return out;
}

/**
 * Draws one clip as an H.264 file in `outDir` and says what it is. w, h and fps come from `params` (default 1080×1920
 * at 30). `audio` is a sound file on this server (the caller turns a source id into its file); anything else throws.
 * A sound that ends before the clip does goes quiet for the rest: the clip is always `seconds` long.
 */
export async function generateClip(spec: GenSpec, outDir: string, signal?: AbortSignal): Promise<GenClip> {
  const p = spec.params ?? {};
  const w = even(num(p.w ?? p.width, 64, 3840, 1080));
  const h = even(num(p.h ?? p.height, 64, 3840, 1920));
  const fps = Math.round(num(p.fps, 1, 60, 30));
  const n = Math.max(1, Math.round(num(spec.seconds, 0, 3600, 5) * fps));
  const seconds = n / fps;
  const seed = Math.floor(num(spec.seed, 0, 2 ** 31 - 1, 1));
  const style = styleFor(String(spec.style ?? ""));
  const colours = (spec.palette ?? []).map((c) => parseHex(String(c))).filter((c): c is Rgb => !!c);
  const own = style.palette.map((c) => parseHex(c)!);
  const ctx: Ctx = {
    w, h, fps, n, seconds, seed,
    rnd: rng(seed),
    stops: stopsOf(colours.length ? colours : own),
  };

  let input: string[];
  if (spec.audio) {
    const file = path.resolve(spec.audio);
    const st = await stat(file).catch(() => null);
    if (!st?.isFile()) throw new Error(`generateClip: the sound is not a file on this server: ${spec.audio}`);
    input = ["-ss", f(num(spec.audioStartS, 0, 1e6, 0)), "-t", f(seconds), "-i", file];
  } else input = ["-f", "lavfi", "-i", madeUpBeat(seed, seconds)];

  const out = path.join(outDir, `gen-${style.id}-${randomUUID().slice(0, 8)}.mp4`);
  const lvl = `${out}.lvl`;
  try {
    await writeFile(lvl, await levels(input, seconds, n, fps, signal));
    const tail = style.pulse
      ? `[1:v]crop=1:1:2:0,scale=${w}:${h}:flags=neighbor,format=gbrp[gn];[pc]format=gbrp[pg];[pg][gn]lut2=c0='x*y/255':c1='x*y/255':c2='x*y/255',format=yuv420p[v]`
      : `[pc]format=yuv420p[v]`;
    const body = style.graph(ctx);
    const colour = `;[g]format=rgb24,${paletteLut(ctx.stops)}[pc]`;
    await atomically(out, (tmp) =>
      run(
        [
          ...input,
          "-f", "rawvideo", "-pix_fmt", "gray", "-s", "3x1", "-framerate", String(fps), "-i", lvl,
          "-filter_complex", `${body}${colour};${tail}`,
          "-map", "[v]", "-frames:v", String(n), "-r", String(fps), "-an",
          "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
          tmp,
        ],
        signal,
      ),
    );
  } finally {
    await rm(lvl, { force: true });
  }
  return { path: out, w, h, fps, seconds };
}
