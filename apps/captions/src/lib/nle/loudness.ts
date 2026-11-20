// Loudness as ITU-R BS.1770-4 / EBU R128 measure it: K-weighting, 400 ms blocks every 100 ms, Momentary (400 ms),
// Short-term (3 s), Integrated (−70 LUFS absolute and −10 LU relative gate) and True Peak (polyphase oversampling to at
// least 176.4 kHz: 4× at 44.1 and 48 kHz). The maths is ported from FilmCraft's crates/audio-dsp (loudness.rs,
// oversample.rs), Copyright (c) 2026 ArtCraft Team and the FilmCraft contributors, MIT (THIRD_PARTY_NOTICES.md).
// One copy runs everywhere: the meter's AudioWorklet on the player's master bus (meter-worklet.ts), and a source's
// measuring for Normalize on whichever machine has the file (api/work/tasks/loudness.ts). No DOM here: the server builds it.
//
// Below the meter: what Normalize Audio Levels and Lower Under Voice write on the timeline (norm_db; gain_db keys).

import { setKey } from "./keyframes";
import { endOf, find, rateOf, setItems, type NleItem, type NleTimeline } from "./model";

export const energyToLufs = (e: number) => (e > 0 ? -0.691 + 10 * Math.log10(e) : -Infinity);
export const lufsToEnergy = (l: number) => 10 ** ((l + 0.691) / 10);

type Coeffs = [b0: number, b1: number, b2: number, a1: number, a2: number];

/** The K-weighting's first stage (a high shelf), from its analog prototype through the bilinear transform at `sr`. */
export function kPre(sr: number): Coeffs {
  const f0 = 1681.974450955533, gainDb = 3.999843853973347, q = 0.7071752369554196;
  const k = Math.tan((Math.PI * f0) / sr);
  const vh = 10 ** (gainDb / 20);
  const vb = vh ** 0.4996667741545416;
  const a0 = 1 + k / q + k * k;
  return [(vh + (vb * k) / q + k * k) / a0, (2 * (k * k - vh)) / a0, (vh - (vb * k) / q + k * k) / a0, (2 * (k * k - 1)) / a0, (1 - k / q + k * k) / a0];
}

/** The K-weighting's second stage (the RLB high-pass). */
export function kRlb(sr: number): Coeffs {
  const f0 = 38.13547087602444, q = 0.5003270373238773;
  const k = Math.tan((Math.PI * f0) / sr);
  const a0 = 1 + k / q + k * k;
  return [1, -2, 1, (2 * (k * k - 1)) / a0, (1 - k / q + k * k) / a0];
}

const TAPS = 16;
/** Oversampling to at least 176.4 kHz, as BS.1770-4 asks for true peak. */
export const truePeakFactor = (sr: number) => (sr < 88200 ? 4 : sr < 176400 ? 2 : 1);

function besselI0(x: number) {
  let sum = 1, term = 1;
  const q = (x * x) / 4;
  for (let k = 1; k < 50; k++) {
    term *= q / (k * k);
    sum += term;
    if (term < sum * 1e-17) break;
  }
  return sum;
}

/** The polyphase bank: a Kaiser-windowed sinc (β 8), each phase scaled to unity at DC. `[p * TAPS + j]` takes x[n − j]. */
function polyphase(factor: number): Float32Array {
  const len = factor * TAPS;
  const centre = (len - 1) / 2;
  const i0b = besselI0(8);
  const proto = Array.from({ length: len }, (_, m) => {
    const t = (m - centre) / factor;
    const r = (m - centre) / (centre + 1);
    return (Math.abs(t) < 1e-12 ? 1 : Math.sin(Math.PI * t) / (Math.PI * t)) * (besselI0(8 * Math.sqrt(Math.max(0, 1 - r * r))) / i0b);
  });
  const out = new Float32Array(len);
  for (let p = 0; p < factor; p++) {
    let sum = 0;
    for (let j = 0; j < TAPS; j++) sum += proto[p + factor * j]!;
    for (let j = 0; j < TAPS; j++) out[p * TAPS + j] = proto[p + factor * j]! / sum;
  }
  return out;
}

const HIST_MIN = -70, HIST_STEP = 0.01, HIST_BINS = 9000;
const binOf = (l: number) => Math.min(HIST_BINS - 1, Math.max(0, Math.floor((l - HIST_MIN) / HIST_STEP)));
const ST = 30, MO = 4;

/**
 * One meter, fed planar channels (`process`) as they play. Each 100 ms sub-block it updates `momentary` and
 * `shortTerm` (LUFS, −Infinity in silence) and adds the momentary block to the integrated gate; `onBlock` hears each
 * 400 ms block's energy (from the fourth sub-block on), which is what a measured source keeps. Channel weights are 1
 * (mono and stereo; the player's master bus is stereo).
 */
export class LoudnessMeter {
  momentary = -Infinity;
  shortTerm = -Infinity;
  /** the highest sample after oversampling, linear (dBTP: truePeakDb) */
  truePeak = 0;
  onBlock?: (energy: number) => void;
  private pre: Coeffs;
  private rlb: Coeffs;
  /** per channel: two biquads' state (transposed direct form II), then the sub-block's sum of squares */
  private z: Float64Array;
  private acc: Float64Array;
  private subLen: number;
  private subPos = 0;
  private ring = new Float64Array(ST);
  private ringPos = 0;
  private seen = 0;
  private count = new Uint32Array(HIST_BINS);
  private energy = new Float64Array(HIST_BINS);
  private bank: Float32Array;
  private factor: number;
  /** per channel, a ring written twice so TAPS samples always lie in a row */
  private hist: Float32Array;
  private histPos: Int32Array;

  constructor(readonly sampleRate: number, readonly channels: number, o: { truePeak?: boolean } = {}) {
    this.pre = kPre(sampleRate);
    this.rlb = kRlb(sampleRate);
    this.z = new Float64Array(channels * 4);
    this.acc = new Float64Array(channels);
    this.subLen = Math.max(1, Math.round(sampleRate * 0.1));
    this.factor = o.truePeak === false ? 0 : truePeakFactor(sampleRate);
    this.bank = polyphase(Math.max(1, this.factor));
    this.hist = new Float32Array(channels * 2 * TAPS);
    this.histPos = new Int32Array(channels);
  }

  get truePeakDb() {
    return 20 * Math.log10(this.truePeak);
  }

  /** Integrated loudness so far, gated; −Infinity before a block passes the absolute gate. */
  get integrated(): number {
    let e = 0, n = 0;
    for (let i = 0; i < HIST_BINS; i++) (e += this.energy[i]!), (n += this.count[i]!);
    if (!n) return -Infinity;
    const thr = energyToLufs(e / n) - 10;
    e = 0;
    n = 0;
    for (let i = thr < HIST_MIN ? 0 : binOf(thr); i < HIST_BINS; i++) (e += this.energy[i]!), (n += this.count[i]!);
    return n ? energyToLufs(e / n) : -Infinity;
  }

  /** Starts over (a seek: the integrated value is for what played from one place on). */
  reset() {
    this.z.fill(0);
    this.acc.fill(0);
    this.ring.fill(0);
    this.count.fill(0);
    this.energy.fill(0);
    this.hist.fill(0);
    this.histPos.fill(0);
    this.subPos = this.ringPos = this.seen = 0;
    this.momentary = this.shortTerm = -Infinity;
    this.truePeak = 0;
  }

  /** Planar samples, one array a channel, all the same length; a missing channel counts as silence. */
  process(chs: ArrayLike<number>[]) {
    const n = chs[0]?.length ?? 0;
    const [pb0, pb1, pb2, pa1, pa2] = this.pre;
    const [rb0, rb1, rb2, ra1, ra2] = this.rlb;
    for (let pos = 0; pos < n; ) {
      const take = Math.min(n - pos, this.subLen - this.subPos);
      for (let c = 0; c < this.channels; c++) {
        const x = chs[c];
        if (!x) continue;
        const z = this.z, o = c * 4;
        let z0 = z[o]!, z1 = z[o + 1]!, z2 = z[o + 2]!, z3 = z[o + 3]!, acc = this.acc[c]!;
        for (let i = pos; i < pos + take; i++) {
          const s = x[i]!;
          const y = pb0 * s + z0;
          z0 = pb1 * s - pa1 * y + z1;
          z1 = pb2 * s - pa2 * y;
          const w = rb0 * y + z2;
          z2 = rb1 * y - ra1 * w + z3;
          z3 = rb2 * y - ra2 * w;
          acc += w * w;
          if (this.factor) this.peak(c, s);
        }
        z[o] = z0, z[o + 1] = z1, z[o + 2] = z2, z[o + 3] = z3;
        this.acc[c] = acc;
      }
      pos += take;
      this.subPos += take;
      if (this.subPos === this.subLen) this.subBlock();
    }
  }

  private peak(c: number, s: number) {
    const a = Math.abs(s);
    if (a > this.truePeak) this.truePeak = a;
    if (this.factor === 1) return;
    const h = this.hist, base = c * 2 * TAPS;
    const p = (this.histPos[c] = this.histPos[c] === 0 ? TAPS - 1 : this.histPos[c]! - 1);
    h[base + p] = s;
    h[base + p + TAPS] = s;
    for (let ph = 0; ph < this.factor; ph++) {
      let y = 0;
      for (let j = 0; j < TAPS; j++) y += this.bank[ph * TAPS + j]! * h[base + p + j]!;
      const v = Math.abs(y);
      if (v > this.truePeak) this.truePeak = v;
    }
  }

  private subBlock() {
    let e = 0;
    for (let c = 0; c < this.channels; c++) (e += this.acc[c]!), (this.acc[c] = 0);
    this.ring[this.ringPos] = e;
    this.ringPos = (this.ringPos + 1) % ST;
    this.subPos = 0;
    this.seen++;
    const mean = (k: number) => {
      let s = 0;
      for (let i = 0; i < k; i++) s += this.ring[(this.ringPos + ST - 1 - i) % ST]!;
      return s / (k * this.subLen);
    };
    const em = mean(MO);
    this.momentary = energyToLufs(em);
    this.shortTerm = energyToLufs(mean(ST));
    if (this.seen >= MO) {
      const l = this.momentary;
      if (l >= HIST_MIN) {
        const b = binOf(l);
        this.count[b]!++;
        this.energy[b] += em;
      }
      this.onBlock?.(em);
    }
  }
}

/** Integrated loudness of 400 ms block energies (exact gating, no histogram); −Infinity when none pass the absolute gate. */
export function gated(blocks: ArrayLike<number>): number {
  const abs = lufsToEnergy(-70);
  let e = 0, n = 0;
  for (let i = 0; i < blocks.length; i++) if (blocks[i]! >= abs) (e += blocks[i]!), n++;
  if (!n) return -Infinity;
  const rel = lufsToEnergy(energyToLufs(e / n) - 10);
  let e2 = 0, n2 = 0;
  for (let i = 0; i < blocks.length; i++) if (blocks[i]! >= abs && blocks[i]! >= rel) (e2 += blocks[i]!), n2++;
  return n2 ? energyToLufs(e2 / n2) : -Infinity;
}

// ---- What a source's measuring keeps, and what Normalize and Lower Under Voice write ----

/** Blocks a second in a measured source: block i covers source seconds [i / 10, i / 10 + 0.4]. */
export const BLOCKS_PER_S = 10;

/** A source measured whole, played from its start: each 400 ms block's energy (dual mono for a mono file, as it plays). */
export interface Measured {
  blocks: ArrayLike<number>;
}

/** What the page has measured, by source key (the timeline's `sources` key). Filled by the editor before it asks. */
export const measured = new Map<string, Measured>();
/** Each source's spoken words in source seconds, [start, end], when it has a transcript. */
export const spoken = new Map<string, [number, number][]>();

/** The blocks wholly inside source seconds [from, from + dur]. */
export function blocksIn(m: Measured, from: number, dur: number): number[] {
  const out: number[] = [];
  const i0 = Math.max(0, Math.ceil(from * BLOCKS_PER_S - 1e-9));
  const i1 = Math.floor((from + dur - 0.4) * BLOCKS_PER_S + 1e-9);
  for (let i = i0; i <= i1 && i < m.blocks.length; i++) out.push(m.blocks[i]!);
  return out;
}

/** Source seconds a clip plays: [from, dur]. */
const playedOf = (tl: NleTimeline, it: NleItem): [number, number] => {
  const sfps = tl.sources[it.src]?.fps || tl.timeline.fps;
  return [it.in / sfps, (it.len * rateOf(tl, it)) / sfps];
};

/** Normalize's target by track, in LUFS: A1 the voice (the engine's check), A4 the music, any other −14. */
export const normTarget = (track: string) => (track === "A1" ? -15 : track === "A4" ? -30 : -14);

/** The sound clips among `keys` (a picture clip's sound is its linked A clip, picked with it). */
export const soundKeys = (tl: NleTimeline, keys: string[]) => keys.filter((k) => find(tl, k)?.track.startsWith("A"));

/**
 * Normalize Audio Levels: `norm_db` on each sound clip in `keys` so it plays at `target` LUFS. Independent: each clip
 * on its own loudness. Relative: one gain for all, from their blocks gated together, so they keep their levels to each
 * other. A clip not measured, or silent, is left as it is. Rounded to 0.1 dB.
 */
export function normalize(tl: NleTimeline, keys: string[], target: number, relative: boolean, m = measured): NleTimeline {
  const blocksOf = (k: string): number[] | null => {
    const hit = find(tl, k);
    const got = hit && m.get(hit.item.src);
    return got ? blocksIn(got, ...playedOf(tl, hit.item)) : null;
  };
  const ks = soundKeys(tl, keys).filter((k) => blocksOf(k));
  const gainFor = (b: number[]) => {
    const l = gated(b);
    return Number.isFinite(l) ? Math.round((target - l) * 10) / 10 : null;
  };
  if (relative) {
    const g = gainFor(ks.flatMap((k) => blocksOf(k)!));
    return g === null ? tl : setItems(tl, ks, { norm_db: g });
  }
  let out = tl;
  for (const k of ks) {
    const g = gainFor(blocksOf(k)!);
    if (g !== null) out = setItems(out, [k], { norm_db: g });
  }
  return out;
}

/**
 * Where A1 speaks, in timeline frames [start, end), merged: from its clips' words when the source has them, else a level
 * gate on its measured blocks (a block within 15 LU of the clip's own loudness, and above −50 LUFS, is speech).
 */
export function speechSpans(tl: NleTimeline, words = spoken, m = measured): [number, number][] {
  const fps = tl.timeline.fps;
  const t = tl.tracks.A1;
  const spans: [number, number][] = [];
  for (const it of t && t.enabled !== false && !t.mute ? t.items : []) {
    if (it.enabled === false) continue;
    const [from, dur] = playedOf(tl, it);
    const r = rateOf(tl, it);
    const sfps = tl.sources[it.src]?.fps || fps;
    // source seconds → timeline frames inside the clip
    const at = (s: number) => Math.min(endOf(it), Math.max(it.rec, it.rec + (s * sfps - it.in) / r));
    const w = words.get(it.src);
    if (w) {
      for (const [s, e] of w) if (e > from && s < from + dur) spans.push([at(s), at(e)]);
      continue;
    }
    const got = m.get(it.src);
    if (!got) continue;
    const b = blocksIn(got, from, dur);
    const own = gated(b);
    if (!Number.isFinite(own)) continue;
    const floor = lufsToEnergy(Math.max(-50, own - 15));
    const i0 = Math.max(0, Math.ceil(from * BLOCKS_PER_S - 1e-9));
    b.forEach((e, n) => {
      if (e >= floor) spans.push([at((i0 + n) / BLOCKS_PER_S), at((i0 + n) / BLOCKS_PER_S + 0.4)]);
    });
  }
  return merge(spans, 0);
}

/** Spans sorted and joined where the gap between them is at most `gap` frames. */
export function merge(spans: [number, number][], gap: number): [number, number][] {
  const out: [number, number][] = [];
  for (const [a, b] of [...spans].filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0])) {
    const last = out[out.length - 1];
    if (last && a <= last[1] + gap) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

export interface Duck {
  /** dB under the voice (negative) */
  amount: number;
  attackMs: number;
  releaseMs: number;
}

export const DUCK: Duck = { amount: -12, attackMs: 150, releaseMs: 400 };

/**
 * Lower Under Voice: `gain_db` keys on each clip of `track` that come down by `amount` over `attackMs` before each
 * span of speech and go back up over `releaseMs` after it (a gap shorter than both stays down). The clip's earlier
 * volume keys are replaced; its own gain is the level it comes back to. Keys he can move after (keyframes.ts).
 */
export function lowerUnderVoice(tl: NleTimeline, track: string, spans: [number, number][], d: Duck = DUCK): NleTimeline {
  const t = tl.tracks[track];
  if (!t || t.locked || !track.startsWith("A")) return tl;
  const fps = tl.timeline.fps;
  const att = (d.attackMs / 1000) * fps, rel = (d.releaseMs / 1000) * fps;
  const ducks = merge(spans, att + rel);
  let out = tl;
  for (const it of t.items) {
    const k = it._k;
    if (!k) continue;
    const { gain_db: _, ...others } = it.keys ?? {};
    out = setItems(out, [k], { keys: Object.keys(others).length ? others : undefined });
    const base = it.gain_db ?? 0;
    for (const [a, b] of ducks) {
      if (b + rel <= it.rec || a - att >= endOf(it)) continue;
      out = setKey(out, k, "gain_db", a - att, base);
      out = setKey(out, k, "gain_db", a, base + d.amount);
      out = setKey(out, k, "gain_db", b, base + d.amount);
      out = setKey(out, k, "gain_db", b + rel, base);
    }
  }
  return out;
}
