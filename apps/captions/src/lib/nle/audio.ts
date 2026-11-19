let shared: AudioContext | null = null;

/** The editor's one sound engine, woken: call it from a click or a key so the browser lets it play. */
export function nleAudio(): AudioContext | null {
  try {
    shared ??= new AudioContext();
    void shared.resume();
    return shared;
  } catch {
    return null;
  }
}

/** The sound engine if one was made. */
export const runningAudio = () => shared;

/**
 * A sound clip's loudness over its fades as points on the engine's clock, [time, gain], to ramp between: `t0` is when
 * the clip's first frame plays (may be past), `from` the seconds into the clip that play first, `rate` the play speed.
 */
export function fadePoints(p: { dur: number; gain: number; fadeIn?: number; fadeOut?: number }, t0: number, from: number, rate: number): [number, number][] {
  const fi = p.fadeIn ?? 0;
  const fo = p.fadeOut ?? 0;
  if (!fi && !fo) return [[t0 + from / rate, p.gain]];
  const at = (x: number) => p.gain * Math.max(0, Math.min(1, fi ? x / fi : 1, fo ? (p.dur - x) / fo : 1));
  // where the two ramps meet when they overlap (a trim shorter than both fades)
  const xs = [from, fi, p.dur - fo, p.dur, fi + fo > p.dur ? (p.dur * fi) / (fi + fo) : from];
  return [...new Set(xs.filter((x) => x >= from && x <= p.dur))].sort((a, b) => a - b).map((x) => [t0 + x / rate, at(x)]);
}
