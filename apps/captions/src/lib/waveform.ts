/**
 * Waveforms for the timelines' audio lanes: an audio file's loudest sample (`peak`) and its loudness (`rms`) in every
 * 1/600 s, 0..1, decoded once per URL (at 8 kHz: enough for peaks, light on memory). 600 a second is the editor's
 * closest zoom, so each px column has its own value there; a 5 min song takes about 1.4 MB.
 */
export const PEAKS_PER_SECOND = 600;

export interface Levels {
  peak: Float32Array;
  rms: Float32Array;
}

const cache = new Map<string, Promise<Levels>>();

/** `maxBytes`: a file bigger than this (or of no known size) is not fetched whole for its sound (a long camera file). */
export function levels(url: string, maxBytes?: number): Promise<Levels> {
  let p = cache.get(url);
  if (!p) {
    p = (async () => {
      const stop = new AbortController();
      // the Mac app's local files answer any page (Access-Control-Allow-Origin *), which WebKit refuses with credentials
      const res = await fetch(url, { credentials: url.startsWith("ctlocal:") ? "omit" : "include", signal: stop.signal });
      if (!res.ok) throw new Error(`${res.status}`);
      if (maxBytes && !(Number(res.headers.get("content-length")) <= maxBytes)) {
        stop.abort();
        throw new Error("too big");
      }
      const audio = await new OfflineAudioContext(1, 1, 8000).decodeAudioData(await res.arrayBuffer());
      return levelsOf(Array.from({ length: audio.numberOfChannels }, (_, c) => audio.getChannelData(c)), audio.sampleRate);
    })();
    cache.set(url, p);
    p.catch(() => cache.delete(url));
  }
  return p;
}

/** The peaks alone (Review's waveforms). */
export const peaks = (url: string, maxBytes?: number): Promise<Float32Array> => levels(url, maxBytes).then((l) => l.peak);

/** The loudest of the channels' samples and their loudness (root mean square) in each 1/PEAKS_PER_SECOND s. */
export function levelsOf(channels: Float32Array[], rate: number): Levels {
  const step = rate / PEAKS_PER_SECOND;
  const len = channels[0]?.length ?? 0;
  const n = Math.ceil(len / step);
  const peak = new Float32Array(n);
  const rms = new Float32Array(n);
  for (const d of channels) {
    for (let i = 0; i < d.length; i++) {
      const k = Math.floor(i / step);
      const v = d[i];
      if (Math.abs(v) > peak[k]) peak[k] = Math.abs(v);
      rms[k] += v * v;
    }
  }
  for (let k = 0; k < n; k++) {
    const count = (Math.min(len, Math.ceil((k + 1) * step)) - Math.ceil(k * step)) * channels.length;
    rms[k] = Math.sqrt(rms[k] / Math.max(1, count));
  }
  return { peak, rms };
}

export const peaksOf = (channels: Float32Array[], rate: number): Float32Array => levelsOf(channels, rate).peak;

/** Several recordings on one lane (two mics): the louder at each moment. */
export function loudest(list: Float32Array[]): Float32Array {
  const out = new Float32Array(Math.max(0, ...list.map((l) => l.length)));
  for (const l of list) for (let i = 0; i < l.length; i++) if (l[i] > out[i]) out[i] = l[i];
  return out;
}

/**
 * An SVG path of `data` from second `from` to `to`, mirrored around 0, in a
 * `0 -1 n 2` box (it stretches with the zoom; no redraw). Long spans are
 * thinned to about 4000 points, each the loudest it stands for.
 */
export function wavePath(data: Float32Array, from: number, to: number, peak: number): { d: string; n: number } {
  const a = Math.max(0, Math.floor(from * PEAKS_PER_SECOND));
  const b = Math.min(data.length, Math.ceil(to * PEAKS_PER_SECOND));
  const n = Math.max(1, b - a);
  const per = Math.max(1, Math.ceil(n / 4000));
  const top: string[] = [];
  const bottom: string[] = [];
  for (let i = a; i < b; i += per) {
    let v = 0;
    for (let j = i; j < Math.min(b, i + per); j++) v = Math.max(v, data[j]);
    const y = Math.min(1, Math.sqrt(v / (peak || 1))).toFixed(3); // sqrt: quiet words still show
    top.push(`${i - a},${-y}`);
    bottom.push(`${i - a},${y}`);
  }
  return { d: top.length ? `M${top.join("L")}L${bottom.reverse().join("L")}Z` : "", n };
}

/**
 * The scale a file is drawn on, in dB: its loudest peak is the top (1) and its quiet floor (the loudness most of it is
 * louder than) the bottom, so a song mastered loud, whose peaks are all near the top, still shows its beats in the
 * loudness, and a talk with pauses keeps its quiet words. Kept per file.
 */
const scales = new WeakMap<Levels, { top: number; range: number }>();
export function scaleOf(lv: Levels): { top: number; range: number } {
  let s = scales.get(lv);
  if (!s) {
    let top = 0;
    for (const v of lv.peak) if (v > top) top = v;
    const sorted = lv.rms.filter((v) => v > 1e-5).sort();
    const floor = sorted.length ? sorted[Math.floor(sorted.length * 0.05)] : 0;
    const topDb = 20 * Math.log10(top || 1);
    const range = Math.max(18, Math.min(54, topDb - 20 * Math.log10(floor || 1e-3)));
    scales.set(lv, (s = { top: topDb, range }));
  }
  return s;
}

/** 0..1 for a level on a file's scale. */
export const heightOf = (v: number, s: { top: number; range: number }) =>
  v > 0 ? Math.max(0, Math.min(1, 1 + (20 * Math.log10(v) - s.top) / s.range)) : 0;

/**
 * Seconds `from` to `to` of a file drawn as Resolve draws a waveform, across a canvas `w` × `h` px: per px column, mirrored
 * about the middle, the peaks lighter and the loudness solid over them.
 */
export function drawWave(g: CanvasRenderingContext2D, lv: Levels, from: number, to: number, w: number, h: number, colors: { peak: string; rms: string }) {
  const s = scaleOf(lv);
  const mid = h / 2;
  const per = ((to - from) * PEAKS_PER_SECOND) / w;
  const col = (x: number) => {
    const a = Math.max(0, Math.floor(from * PEAKS_PER_SECOND + x * per));
    const b = Math.min(lv.peak.length, Math.max(a + 1, Math.floor(from * PEAKS_PER_SECOND + (x + 1) * per)));
    let p = 0;
    let q = 0;
    for (let k = a; k < b; k++) {
      if (lv.peak[k] > p) p = lv.peak[k];
      q += lv.rms[k] * lv.rms[k];
    }
    return [heightOf(p, s), heightOf(Math.sqrt(q / Math.max(1, b - a)), s)];
  };
  const cols = Array.from({ length: Math.ceil(w) }, (_, x) => col(x));
  g.fillStyle = colors.peak;
  cols.forEach(([p], x) => p > 0 && g.fillRect(x, mid - p * mid, 1, Math.max(1, 2 * p * mid)));
  g.fillStyle = colors.rms;
  cols.forEach(([, r], x) => r > 0 && g.fillRect(x, mid - r * mid, 1, Math.max(1, 2 * r * mid)));
}
