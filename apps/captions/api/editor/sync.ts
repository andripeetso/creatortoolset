import { spawn } from "node:child_process";
import { ffmpegCommand } from "../ffmpeg-runtime";
import { probe } from "../library/media/probe";
import { ffmpegSlot } from "../library/media/run";

/**
 * Finding recordings' sound in one another, over ffmpeg PCM: matchPair says where one file's sound sits in another
 * (a mic against the camera, or two takes), and voiceChannel says which channel of a recorder file is the voice mic.
 * The Python engine's sources.match and sources.voice_channel, with their measured constants. Files are decoded
 * whole for matchPair, so an hour of audio is about 115 MB of samples and a long correlation takes seconds.
 */

/** The rate matchPair works at: 8 kHz is enough for speech and keeps a long track small. */
export const SYNC_RATE = 8000;
const WINDOWS = 5; // windows of the shorter file, spread evenly across it
const WIN_S = 20; // seconds per window (less when the shorter file is short)
const AGREE_S = 0.05; // windows within 50 ms of each other count as one offset
const MIN_AGREE = 3;

export interface PairMatch {
  /** Seconds into `b` at `a`'s 0 s (negative when `a` starts after `b` does). */
  offset_s: number;
  /** The weakest agreeing window's normalised correlation: true pairs score high, wrong pairs scatter low. */
  score: number;
}

/** Mono float32 samples of `file`'s first audio stream (or of one `ac` layout), read through the server's ffmpeg limit. */
function decode(
  file: string,
  o: { rate: number; ac: number; start?: number; dur?: number; af?: string; signal?: AbortSignal },
): Promise<Float32Array> {
  const args = ["-v", "error", "-nostdin"];
  if (o.start !== undefined) args.push("-ss", o.start.toFixed(3), "-t", (o.dur ?? 0).toFixed(3));
  args.push("-i", file, "-vn", "-ac", String(o.ac), "-ar", String(o.rate));
  if (o.af) args.push("-af", o.af);
  args.push("-f", "f32le", "pipe:1");
  return ffmpegSlot(
    () =>
      new Promise((resolve, reject) => {
        const p = spawn(ffmpegCommand(), args, { signal: o.signal });
        const chunks: Buffer[] = [];
        let err = "";
        p.stdout.on("data", (d: Buffer) => chunks.push(d));
        p.stderr.on("data", (d) => (err = (err + d.toString()).slice(-2000)));
        p.on("error", reject);
        p.on("close", (code) => {
          if (code !== 0) return reject(new Error(err.trim() || `ffmpeg exited ${code}`));
          const b = Buffer.concat(chunks);
          resolve(new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength - (b.byteLength % 4))));
        });
      }),
  );
}

// ponytail: one cached table, the last size only; a second size in a run rebuilds it
let table: { n: number; cs: Float64Array; sn: Float64Array } | undefined;
/** cos and sin of 2πk/n for k < n/2, from one table: a recurrence drifts over a 2^25-point transform. */
function twiddles(n: number) {
  if (table?.n !== n) {
    const cs = new Float64Array(n >> 1);
    const sn = new Float64Array(n >> 1);
    for (let k = 0; k < n >> 1; k++) {
      cs[k] = Math.cos((2 * Math.PI * k) / n);
      sn[k] = Math.sin((2 * Math.PI * k) / n);
    }
    table = { n, cs, sn };
  }
  return table;
}

/** In-place radix-2 FFT over (re, im), length a power of two; `inv` runs the inverse, scaled by 1/n. */
function fft(re: Float64Array, im: Float64Array, inv: boolean): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j]!, re[i]!];
      [im[i], im[j]] = [im[j]!, im[i]!];
    }
  }
  const { cs, sn } = twiddles(n);
  const sign = inv ? 1 : -1;
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const step = n / len;
    for (let i = 0; i < n; i += len) {
      for (let j = 0; j < half; j++) {
        const wr = cs[j * step]!;
        const wi = sign * sn[j * step]!;
        const a = i + j;
        const b = a + half;
        const vr = re[b]! * wr - im[b]! * wi;
        const vi = re[b]! * wi + im[b]! * wr;
        re[b] = re[a]! - vr;
        im[b] = im[a]! - vi;
        re[a] = re[a]! + vr;
        im[a] = im[a]! + vi;
      }
    }
  }
  if (inv) for (let i = 0; i < n; i++) {
    re[i] = re[i]! / n;
    im[i] = im[i]! / n;
  }
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/** The `p`-th percentile of a sorted list, interpolated between neighbours as numpy does. */
function percentile(sorted: number[], p: number): number {
  const at = ((sorted.length - 1) * p) / 100;
  const lo = Math.floor(at);
  const hi = Math.ceil(at);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (at - lo);
}

/**
 * Where `a`'s sound sits in `b`, or null. The shorter file's windows are correlated against the longer one in one
 * FFT pass each; at least 3 of 5 windows must land within 50 ms of one another, so agreement decides, not the score.
 * Band-passed to 100-4000 Hz, the speech band, before matching.
 */
export async function matchPair(a: string, b: string, signal?: AbortSignal): Promise<PairMatch | null> {
  const band = { rate: SYNC_RATE, ac: 1, af: "highpass=f=100,lowpass=f=4000", signal };
  const ta = await decode(a, band);
  const tb = await decode(b, band);
  const flip = ta.length > tb.length;
  const A = flip ? tb : ta; // the shorter file
  const B = flip ? ta : tb;
  if (A.length < 3 * SYNC_RATE) return null;
  const win = Math.floor(Math.min(WIN_S, (A.length / SYNC_RATE) * 0.3) * SYNC_RATE);
  const n = 1 << Math.ceil(Math.log2(B.length + win));
  const FBr = new Float64Array(n);
  const FBi = new Float64Array(n);
  FBr.set(B);
  fft(FBr, FBi, false);
  const hits: { o: number; score: number }[] = [];
  for (let k = 0; k < WINDOWS; k++) {
    const s = Math.max(0, Math.floor((A.length * (k + 1)) / (WINDOWS + 1) - win / 2));
    const c = A.subarray(s, s + win);
    // circular cross-correlation: corr[lag] = sum over j of B[lag + j] * c[j]
    const cr = new Float64Array(n);
    const ci = new Float64Array(n);
    cr.set(c);
    fft(cr, ci, false);
    for (let i = 0; i < n; i++) {
      const r = FBr[i]! * cr[i]! + FBi[i]! * ci[i]!;
      ci[i] = FBi[i]! * cr[i]! - FBr[i]! * ci[i]!;
      cr[i] = r;
    }
    fft(cr, ci, true);
    let pos = 0;
    for (let lag = 1; lag <= B.length - win; lag++) if (cr[lag]! > cr[pos]!) pos = lag;
    let cn = 0;
    let bn = 0;
    for (let j = 0; j < win; j++) {
      cn += c[j]! * c[j]!;
      bn += B[pos + j]! * B[pos + j]!;
    }
    const score = cr[pos]! / (Math.sqrt(cn) * Math.sqrt(bn) + 1e-9);
    hits.push({ o: (pos - s) / SYNC_RATE, score });
  }
  const agreeing = (h: { o: number }) => hits.filter((g) => Math.abs(g.o - h.o) <= AGREE_S).length;
  const best = hits.reduce((x, h) => (agreeing(h) > agreeing(x) ? h : x));
  const agree = hits.filter((h) => Math.abs(h.o - best.o) <= AGREE_S);
  if (agree.length < MIN_AGREE) return null;
  const off = median(agree.map((h) => h.o));
  return {
    offset_s: Math.round((flip ? -off : off) * 1e4) / 1e4,
    score: Math.round(Math.min(...agree.map((h) => h.score)) * 1e3) / 1e3,
  };
}

/**
 * Which channel of a recorder file is the voice mic: the one with the widest gap between speech and silence (the
 * closest mic), read from three 20 s windows. Null for one channel, or two carrying the same sound (a stereo copy of
 * one mic, a camera's own pair, or a mono file upmixed). Measured on a two-mic recorder file (2026-09-29): the dynamic
 * mic in the shot had the wider range and the roomy mic the narrower one, and their mix sounded like camera audio.
 */
export async function voiceChannel(file: string, signal?: AbortSignal): Promise<number | null> {
  const { duration } = await probe(file);
  const same: number[] = [];
  const ranges = [0, 0];
  for (const at of [0.2, 0.5, 0.8]) {
    const x = await decode(file, { rate: 16000, ac: 2, start: Math.max(0, duration * at - 10), dur: 20, signal });
    const frames = x.length >> 1;
    if (frames < 16000) continue;
    const ch = [new Float64Array(frames), new Float64Array(frames)];
    for (let i = 0; i < frames; i++) {
      ch[0]![i] = x[2 * i]!;
      ch[1]![i] = x[2 * i + 1]!;
    }
    same.push(correlation(ch[0]!, ch[1]!));
    for (const c of [0, 1] as const) {
      const db: number[] = [];
      for (let f = 0; f + 320 <= frames; f += 320) {
        let sq = 0;
        for (let i = f; i < f + 320; i++) sq += ch[c]![i]! ** 2;
        db.push(20 * Math.log10(Math.sqrt(sq / 320) + 1e-9));
      }
      db.sort((p, q) => p - q);
      ranges[c]! += percentile(db, 95) - percentile(db, 10);
    }
  }
  // a stereo pair of one mic is one sound; NaN (a silent channel) is not "the same"
  if (!same.length || same.every((c) => c > 0.9)) return null;
  return ranges[1]! > ranges[0]! ? 1 : 0;
}

function correlation(x: Float64Array, y: Float64Array): number {
  const n = x.length;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) {
    mx += x[i]!;
    my += y[i]!;
  }
  mx /= n;
  my /= n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i]! - mx;
    const dy = y[i]! - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  return sxy / Math.sqrt(sxx * syy);
}
