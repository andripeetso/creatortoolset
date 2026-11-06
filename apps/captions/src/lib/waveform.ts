/**
 * Waveforms for the timeline's audio lanes: an audio file's loudest sample in every 1/100 s,
 * 0..1, decoded once per URL (at 8 kHz: enough for peaks, light on memory).
 */
export const PEAKS_PER_SECOND = 100;

const cache = new Map<string, Promise<Float32Array>>();

export function peaks(url: string): Promise<Float32Array> {
  let p = cache.get(url);
  if (!p) {
    p = (async () => {
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) throw new Error(`${res.status}`);
      const audio = await new OfflineAudioContext(1, 1, 8000).decodeAudioData(await res.arrayBuffer());
      return peaksOf(Array.from({ length: audio.numberOfChannels }, (_, c) => audio.getChannelData(c)), audio.sampleRate);
    })();
    cache.set(url, p);
    p.catch(() => cache.delete(url));
  }
  return p;
}

/** The loudest of the channels' samples in each 1/100 s. */
export function peaksOf(channels: Float32Array[], rate: number): Float32Array {
  const step = rate / PEAKS_PER_SECOND;
  const out = new Float32Array(Math.ceil((channels[0]?.length ?? 0) / step));
  for (const d of channels) {
    for (let i = 0; i < d.length; i++) {
      const k = Math.floor(i / step);
      const v = Math.abs(d[i]);
      if (v > out[k]) out[k] = v;
    }
  }
  return out;
}

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
