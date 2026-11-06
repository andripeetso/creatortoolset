import {
  ALL_FORMATS,
  AudioBufferSink,
  BlobSource,
  BufferTarget,
  CanvasSink,
  Conversion,
  Input,
  Mp4OutputFormat,
  Output,
  Quality,
} from "mediabunny";

/**
 * Story Splitter: one video → stories of about 20 s, cut where it hurts
 * least. Runs in the browser (mediabunny): nothing is uploaded.
 *
 * Three signals become scored spots: hard cuts in the edit (frame
 * differences), pauses (quiet runs in the audio) and beats (a steady pulse
 * in the loudness onsets). planCuts picks the spots that keep every story
 * near the target length.
 */

/** Audio envelope rate: values per second. */
const HZ = 100;
/** Instagram's longest story. */
export const MAX_STORY = 60;

export interface Signals {
  duration: number;
  /** Each decoded frame's time and how much it differs from the one before (0..1). */
  frames: { t: number; diff: number }[];
  /** Loudness in dB, HZ values per second; empty without audio. */
  db: Float32Array;
}

export type Why = "shot" | "shot+pause" | "shot+beat" | "pause" | "beat" | "quiet" | "speech";
export interface Spot {
  t: number;
  /** Higher = a better place to cut; below 0 = it cuts through sound. */
  score: number;
  why: Why;
}
export interface Analysis {
  duration: number;
  /** Loudness 0..1, HZ values per second. */
  energy: Float32Array;
  spots: Spot[];
  shots: number;
  pauses: number;
  bpm: number | null;
}

export const WHY: Record<Why, string> = {
  shot: "on a cut",
  "shot+pause": "on a cut, in a pause",
  "shot+beat": "on a cut, on the beat",
  pause: "in a pause",
  beat: "on the beat",
  quiet: "quiet moment",
  speech: "mid-sound",
};

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[s.length >> 1] : 0;
};

/** Hard cuts: one frame far more different than the frames around it. */
function shotCuts(frames: Signals["frames"]) {
  const out: { t: number; strength: number }[] = [];
  for (let i = 1; i < frames.length; i++) {
    const d = frames[i].diff;
    if (d < 0.025 || d <= frames[i - 1].diff || d < (frames[i + 1]?.diff ?? 0)) continue;
    const around = frames.slice(Math.max(1, i - 6), i + 7).filter((_, k, a) => a[k] !== frames[i]).map((f) => f.diff);
    if (d >= 4 * median(around)) out.push({ t: frames[i].t, strength: Math.min(1, d / 0.25) });
  }
  return out;
}

/** A steady pulse in the loudness onsets: its period in envelope steps, or null. */
function pulse(flux: Float32Array): number | null {
  const mean = flux.reduce((a, b) => a + b, 0) / (flux.length || 1);
  const f = flux.map((x) => x - mean);
  const energy = f.reduce((a, x) => a + x * x, 0);
  if (!energy || f.length < 8 * HZ) return null;
  let best = 0, period = 0;
  // ponytail: plain autocorrelation over 60–200 BPM; a real beat tracker if cuts drift off the beat
  for (let lag = 30; lag <= 100; lag++) {
    let r = 0;
    for (let i = 0; i + lag < f.length; i++) r += f[i] * f[i + lag];
    if (r / energy > best) [best, period] = [r / energy, lag];
  }
  return best >= 0.25 ? period : null;
}

export function analyse(sig: Signals): Analysis {
  const { duration, db } = sig;
  const sorted = Float32Array.from(db).sort();
  const lo = sorted[Math.floor(sorted.length * 0.1)] ?? 0;
  const hi = sorted[Math.floor(sorted.length * 0.9)] ?? 0;
  // Under 6 dB of range there is nothing to tell speech from silence.
  const flat = hi - lo < 6;
  const energy = flat ? new Float32Array(db.length) : db.map((v) => Math.min(1, Math.max(0, (v - lo) / (hi - lo))));
  const loudness = (from: number, to: number) => {
    const a = Math.max(0, Math.floor(from * HZ)), b = Math.min(energy.length, Math.ceil(to * HZ));
    let sum = 0;
    for (let i = a; i < b; i++) sum += energy[i];
    return b > a ? sum / (b - a) : 0;
  };
  const penalty = (t: number, before = 0.05, after = 0.05) => 0.8 * loudness(t - before, t + after);

  const pauses: { start: number; end: number }[] = [];
  if (!flat) {
    const quiet = lo + 0.35 * (hi - lo);
    for (let i = 0; i < db.length; ) {
      if (db[i] >= quiet) { i++; continue; }
      let j = i;
      while (j < db.length && db[j] < quiet) j++;
      if (j - i >= 0.15 * HZ) pauses.push({ start: i / HZ, end: j / HZ });
      i = j;
    }
  }

  const flux = db.map((v, i) => (i < 2 || flat ? 0 : Math.min(20, Math.max(0, v - db[i - 2]))));
  const period = pulse(flux);
  const beats: number[] = [];
  if (period) {
    let phase = 0, top = -1;
    for (let p = 0; p < period; p++) {
      let s = 0;
      for (let i = p; i < flux.length; i += period) s += flux[i];
      if (s > top) [top, phase] = [s, p];
    }
    for (let i = phase; i < flux.length; i += period) {
      let at = i;
      for (let k = Math.max(0, i - 3); k <= Math.min(flux.length - 1, i + 3); k++) if (flux[k] > flux[at]) at = k;
      beats.push(Math.max(0, at - 2) / HZ); // the start of the rise
    }
  }

  const shots = shotCuts(sig.frames);
  const spots: Spot[] = [];
  const usedPause = new Set<number>(), usedBeat = new Set<number>();
  for (const s of shots) {
    let spot: Spot = { t: s.t, score: 0.6 + 0.4 * s.strength - penalty(s.t), why: "shot" };
    const p = pauses.findIndex((x) => s.t >= x.start - 0.1 && s.t <= x.end + 0.1);
    const b = beats.findIndex((x) => Math.abs(x - s.t) <= 0.08);
    if (p >= 0) {
      usedPause.add(p);
      spot = { ...spot, score: Math.max(spot.score, pauseScore(pauses[p])) + 0.3, why: "shot+pause" };
    } else if (b >= 0) {
      usedBeat.add(b);
      spot = { ...spot, score: spot.score + 0.15, why: "shot+beat" };
    }
    spots.push(spot);
  }
  pauses.forEach((p, i) => {
    if (!usedPause.has(i)) spots.push({ t: (p.start + p.end) / 2, score: pauseScore(p), why: "pause" });
  });
  beats.forEach((t, i) => {
    if (!usedBeat.has(i)) spots.push({ t, score: 0.35 - penalty(t, 0.08, 0), why: "beat" });
  });
  return {
    duration,
    energy,
    spots: spots.filter((s) => s.t > 0.3 && s.t < duration - 0.3).sort((a, b) => a.t - b.t),
    shots: shots.length,
    pauses: pauses.length,
    bpm: period ? Math.round((60 * HZ) / period) : null,
  };
}

/** A breath scores 0.5, a sentence end (1 s+) 1. */
const pauseScore = (p: { start: number; end: number }) => 0.4 + 0.6 * Math.min(1, p.end - p.start);

/** What cutting at `t` does: the spot there, else how loud it is. */
export function spotAt(a: Analysis, t: number): Spot {
  const near = a.spots.find((s) => Math.abs(s.t - t) < 0.02);
  if (near) return near;
  const i0 = Math.max(0, Math.floor((t - 0.05) * HZ)), i1 = Math.min(a.energy.length, Math.ceil((t + 0.05) * HZ));
  let sum = 0;
  for (let i = i0; i < i1; i++) sum += a.energy[i];
  const loud = i1 > i0 ? sum / (i1 - i0) : 0;
  return { t, score: -0.8 * loud, why: loud > 0.4 ? "speech" : "quiet" };
}

/** Where to cut when asked for "about here": the best spot within 2.5 s, else here. */
export function snapCut(a: Analysis, t: number): number {
  let best = spotAt(a, t), value = best.score;
  for (const s of a.spots) {
    const v = s.score - 0.2 * Math.abs(s.t - t);
    if (Math.abs(s.t - t) <= 2.5 && v > value) [best, value] = [s, v];
  }
  return best.t;
}

/**
 * The cuts that make stories of about `target` seconds, through the
 * `pinned` cuts (the owner's). Per stretch between pinned cuts: shortest
 * path over the spots plus a 0.25 s grid (so there is always a way), paying
 * ((length − target) / 30% of target)² per story and earning each cut's score.
 */
export function planCuts(a: Analysis, target: number, pinned: number[] = []): number[] {
  const bounds = [0, ...pinned.filter((t) => t > 0 && t < a.duration).sort((x, y) => x - y), a.duration];
  const cuts: number[] = [];
  for (let k = 0; k + 1 < bounds.length; k++) {
    cuts.push(...planStretch(a, bounds[k], bounds[k + 1], target));
    if (k + 2 < bounds.length) cuts.push(bounds[k + 1]);
  }
  return cuts;
}

function planStretch(a: Analysis, from: number, to: number, target: number): number[] {
  const minLen = Math.max(2, 0.3 * target), maxLen = Math.min(MAX_STORY, 2 * target), tol = 0.3 * target;
  const inside = a.spots.filter((s) => s.t > from && s.t < to);
  const grid: Spot[] = [];
  for (let t = Math.ceil(from * 4 + 1e-9) / 4; t < to; t += 0.25)
    if (!inside.some((s) => Math.abs(s.t - t) < 0.1)) grid.push(spotAt(a, t));
  const nodes = [{ t: from, score: 0 }, ...[...inside, ...grid].sort((x, y) => x.t - y.t), { t: to, score: 0 }];
  const n = nodes.length;
  const cost = new Float64Array(n).fill(Infinity), prev = new Int32Array(n).fill(-1);
  cost[0] = 0;
  for (let j = 1; j < n; j++) {
    for (let i = j - 1; i >= 0; i--) {
      const len = nodes[j].t - nodes[i].t;
      if (len > maxLen) break;
      // A stretch shorter than a story (between two pinned cuts) stays whole.
      if (len < minLen && !(i === 0 && j === n - 1)) continue;
      const c = cost[i] + ((len - target) / tol) ** 2 - (j < n - 1 ? nodes[j].score : 0);
      if (c < cost[j]) [cost[j], prev[j]] = [c, i];
    }
  }
  const cuts: number[] = [];
  for (let j = prev[n - 1]; j > 0; j = prev[j]) cuts.unshift(nodes[j].t);
  return cuts;
}

// ---------- in the browser: read, render, zip ----------

/** Frame differences and loudness, decoded side by side. */
export async function readSignals(blob: Blob, onProgress: (p: number) => void): Promise<Signals> {
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
  try {
    const video = await input.getPrimaryVideoTrack();
    if (!video) throw new Error("This file has no video.");
    if (!(await video.canDecode())) throw new Error("This browser can't decode this video. Try Chrome.");
    const duration = await input.computeDuration();
    const done = [0, 0];
    const report = (k: number, t: number) => {
      done[k] = Math.min(1, t / duration);
      onProgress(0.7 * done[0] + 0.3 * done[1]);
    };

    const frames = async () => {
      const w = 64, h = 36;
      const small = Object.assign(document.createElement("canvas"), { width: w, height: h });
      const ctx = small.getContext("2d", { willReadFrequently: true })!;
      const out: Signals["frames"] = [];
      let last: Float32Array | null = null;
      for await (const f of new CanvasSink(video, { width: w, height: h, fit: "fill", poolSize: 2 }).canvases()) {
        ctx.drawImage(f.canvas, 0, 0);
        const px = ctx.getImageData(0, 0, w, h).data;
        const luma = new Float32Array(w * h);
        let diff = 0;
        for (let i = 0; i < luma.length; i++) {
          luma[i] = (0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2]) / 255;
          if (last) diff += Math.abs(luma[i] - last[i]);
        }
        out.push({ t: f.timestamp, diff: diff / luma.length });
        last = luma;
        report(0, f.timestamp);
      }
      return out;
    };

    const loudness = async () => {
      const track = await input.getPrimaryAudioTrack();
      if (!track || !(await track.canDecode())) return new Float32Array(0);
      const n = Math.ceil(duration * HZ);
      const sum = new Float64Array(n), count = new Uint32Array(n);
      for await (const { buffer, timestamp } of new AudioBufferSink(track).buffers()) {
        const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c));
        for (let j = 0; j < buffer.length; j++) {
          const k = Math.floor((timestamp + j / buffer.sampleRate) * HZ);
          if (k < 0 || k >= n) continue;
          let v = 0;
          for (const ch of channels) v += ch[j];
          v /= channels.length;
          sum[k] += v * v;
          count[k]++;
        }
        report(1, timestamp);
      }
      return Float32Array.from(sum, (s, k) => 10 * Math.log10(s / Math.max(1, count[k]) + 1e-10));
    };

    const [f, db] = await Promise.all([frames(), loudness()]);
    return { duration, frames: f, db };
  } finally {
    input.dispose();
  }
}

/** Each story as an H.264 MP4 (frame-exact: trimmed stories are re-encoded), zipped. */
export async function renderStories(
  blob: Blob,
  cuts: number[],
  duration: number,
  base: string,
  onProgress: (story: number, p: number) => void,
): Promise<Blob> {
  const bounds = [0, ...cuts, duration];
  const files: { name: string; data: Uint8Array }[] = [];
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
  try {
    const hasAudio = !!(await input.getPrimaryAudioTrack());
    for (let i = 0; i + 1 < bounds.length; i++) {
      const target = new BufferTarget();
      const output = new Output({ format: new Mp4OutputFormat({ fastStart: "in-memory" }), target });
      const conversion = await Conversion.init({
        input,
        output,
        tracks: "primary",
        showWarnings: false,
        trim: { start: bounds[i], end: bounds[i + 1] },
        // A bitrate, not a quantizer: WebKit (Safari, the iPhone app) throws on
        // bitrateMode "quantizer", which Mediabunny tries first for a quality level.
        video: { codec: "avc", quality: new Quality({ quality: "very-high", preferBitrate: true }) },
        audio: { codec: "aac" },
      });
      const kept = conversion.utilizedTracks;
      if (!conversion.isValid || !kept.some((t) => t.isVideoTrack()) || (hasAudio && !kept.some((t) => t.isAudioTrack())))
        throw new Error(
          `This browser can't make H.264/AAC stories (${conversion.discardedTracks.map((d) => d.reason).join(", ") || "no encoder"}). Try Chrome.`,
        );
      conversion.onProgress = (p) => onProgress(i, p);
      await conversion.execute();
      files.push({ name: `${base}-${String(i + 1).padStart(2, "0")}.mp4`, data: new Uint8Array(target.buffer!) });
    }
  } finally {
    input.dispose();
  }
  return zipStored(files);
}

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A ZIP without compression (MP4s don't shrink): local headers, data, central directory. */
export function zipStored(files: { name: string; data: Uint8Array }[], now = new Date()): Blob {
  const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const body: BlobPart[] = [], central: BlobPart[] = [];
  let offset = 0, centralSize = 0;
  for (const f of files) {
    const name = new TextEncoder().encode(f.name);
    const crc = crc32(f.data), size = f.data.length;
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true); // UTF-8 names
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, size, true);
    local.setUint32(22, size, true);
    local.setUint16(26, name.length, true);
    const entry = new DataView(new ArrayBuffer(46));
    entry.setUint32(0, 0x02014b50, true);
    entry.setUint16(4, 20, true);
    entry.setUint16(6, 20, true);
    entry.setUint16(8, 0x0800, true);
    entry.setUint16(12, time, true);
    entry.setUint16(14, date, true);
    entry.setUint32(16, crc, true);
    entry.setUint32(20, size, true);
    entry.setUint32(24, size, true);
    entry.setUint16(28, name.length, true);
    entry.setUint32(42, offset, true);
    body.push(local.buffer, name, f.data as Uint8Array<ArrayBuffer>);
    central.push(entry.buffer, name);
    offset += 30 + name.length + size;
    centralSize += 46 + name.length;
  }
  if (offset > 0xffffffff) throw new Error("The stories add up to more than 4 GB: split a shorter video.");
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...body, ...central, end.buffer], { type: "application/zip" });
}
