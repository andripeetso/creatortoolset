export type MatchState = "matched" | "ambiguous" | "unmatched" | "low-detail";
export interface ComparisonSample {
  start: number;
  end: number;
  state: MatchState;
  sourceStart: number | null;
  sourceEnd: number | null;
  distance: number | null;
  candidates: number;
}
export interface ComparisonTimeline {
  method: string;
  beforeDuration: number;
  afterDuration: number;
  beforeInterval: number;
  afterInterval: number;
  distanceLimit: number;
  samples: ComparisonSample[];
  originalSamples: ComparisonSample[];
  longestRun: { seconds: number; start: number; end: number } | null;
}
export interface TimedHash {
  hash: string;
  quality: number;
}
/** Search every sampled source moment, independent of scene order or wall-clock alignment. */
export function comparisonTimeline(
  before: TimedHash[],
  after: TimedHash[],
  durations: [number, number],
  intervals: [number, number],
): ComparisonTimeline {
  const packed = new Map<string, Uint8Array>();
  const popcount = [0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4];
  const pack = (hash: string) => {
    let value = packed.get(hash);
    if (!value) {
      value = Uint8Array.from([...hash], (c) => parseInt(c, 16));
      packed.set(hash, value);
    }
    return value;
  };
  const distance = (a: string, b: string) => {
    const aa = pack(a),
      bb = pack(b);
    let bits = 0;
    for (let i = 0; i < 64; i++) bits += popcount[aa[i] ^ bb[i]];
    return bits;
  };
  const valid = (f: TimedHash) =>
    f.quality >= 50 && /^[a-f\d]{64}$/i.test(f.hash);
  function search(
    source: TimedHash[],
    target: TimedHash[],
    si: number,
    ti: number,
  ) {
    return target.map((frame, i): ComparisonSample => {
      const start = Math.min(durations[ti], i * intervals[ti]);
      const end =
        i === target.length - 1
          ? durations[ti]
          : Math.min(durations[ti], (i + 1) * intervals[ti]);
      const base = {
        start,
        end,
        sourceStart: null,
        sourceEnd: null,
        distance: null,
        candidates: 0,
      };
      if (!valid(frame)) return { ...base, state: "low-detail" };
      const ranked = source
        .flatMap((f, j) =>
          valid(f)
            ? [{ index: j, distance: distance(f.hash, frame.hash) }]
            : [],
        )
        .sort((a, b) => a.distance - b.distance || a.index - b.index);
      if (!ranked.length) return { ...base, state: "low-detail" };
      const best = ranked[0];
      const candidates = ranked.filter((x) => x.distance <= 31);
      if (!candidates.length)
        return { ...base, state: "unmatched", distance: best.distance };
      // Nearby frames describe the same moment; equally good distant matches can be repeats or static shots.
      const ambiguous = candidates.some(
        (x) =>
          Math.abs(x.index - best.index) > 1 && x.distance <= best.distance + 4,
      );
      return {
        ...base,
        state: ambiguous ? "ambiguous" : "matched",
        sourceStart: best.index * intervals[si],
        sourceEnd: Math.min(durations[si], (best.index + 1) * intervals[si]),
        distance: best.distance,
        candidates: candidates.length,
      };
    });
  }
  const samples = search(before, after, 0, 1);
  // Runs require consecutive, unambiguous samples advancing in source order.
  // Small rate changes are tolerated; a single frame never proves a continuous sequence.
  let longestRun: ComparisonTimeline["longestRun"] = null;
  let run: ComparisonSample[] = [];
  const flush = () => {
    if (run.length >= 3) {
      const first = run[0],
        last = run[run.length - 1];
      const seconds = last.start - first.start;
      if (!longestRun || seconds > longestRun.seconds)
        longestRun = { seconds, start: first.start, end: last.start };
    }
    run = [];
  };
  for (const sample of samples) {
    if (sample.state !== "matched") {
      flush();
      continue;
    }
    const previous = run.at(-1);
    if (previous) {
      const ds = sample.sourceStart! - previous.sourceStart!;
      const dt = sample.start - previous.start;
      if (ds <= 0 || Math.abs(ds - dt) > Math.max(...intervals) * 0.6) flush();
    }
    run.push(sample);
  }
  flush();
  return {
    method:
      "Sampled PDQ search across all timestamps; distance ≤31, quality ≥50. Bins approximate sampled moments, not verified continuous footage. Repeated/static matches are ambiguous. No match does not establish new or original content.",
    beforeDuration: durations[0],
    afterDuration: durations[1],
    beforeInterval: intervals[0],
    afterInterval: intervals[1],
    distanceLimit: 31,
    samples,
    originalSamples: search(after, before, 1, 0),
    longestRun,
  };
}
