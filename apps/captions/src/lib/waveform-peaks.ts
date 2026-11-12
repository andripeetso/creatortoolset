/**
 * The timeline's waveform: the loudest sample in each of 500 to 4000 buckets (12 a second). Its own file so the
 * server makes the same waveform when it transcribes a clip by itself (api/captions-job.ts).
 */
export function waveformPeaks(pcm: Float32Array, duration: number): Float32Array {
  const buckets = Math.min(4000, Math.max(500, Math.floor(duration * 12)));
  const peaks = new Float32Array(buckets);
  const step = Math.max(1, Math.floor(pcm.length / buckets));
  for (let i = 0; i < buckets; i++) {
    let max = 0;
    const start = i * step;
    const end = Math.min(pcm.length, start + step);
    for (let j = start; j < end; j += 4) {
      const value = Math.abs(pcm[j]);
      if (value > max) max = value;
    }
    peaks[i] = max;
  }
  return peaks;
}
