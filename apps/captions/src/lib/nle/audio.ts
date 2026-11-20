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

/** What the loudness meter reads every 100 ms: Momentary, Short-term, Integrated (LUFS), True Peak (dBTP), sample peaks L/R (linear). */
export interface MeterRead {
  m: number;
  s: number;
  i: number;
  tp: number;
  pk: [number, number];
}

let bus: GainNode | null = null;
let meter: AudioWorkletNode | null = null;
const reads = new Set<(r: MeterRead) => void>();

/**
 * The editor's master bus: whatever the player plays connects here, not to `ctx.destination`, so the loudness meter
 * hears the mix as it goes out. The meter is an AudioWorklet (meter-worklet.ts) on the bus; where worklets can't load,
 * the sound still plays and the meter stays empty.
 */
export function nleOut(ctx: AudioContext): AudioNode {
  if (bus?.context === ctx) return bus;
  const b = (bus = ctx.createGain());
  b.connect(ctx.destination);
  void (async () => {
    try {
      const { default: url } = await import("./meter-worklet.ts?worker&url");
      await ctx.audioWorklet.addModule(url);
      // stereo always (a mono clip counts in both ears, as it plays and as ebur128 reads the render); its silent
      // output goes to the speakers only so every engine pulls it
      const n = new AudioWorkletNode(ctx, "nle-meter", { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 2, channelCountMode: "explicit", channelInterpretation: "speakers" });
      n.port.onmessage = (e: MessageEvent<MeterRead>) => reads.forEach((f) => f(e.data));
      b.connect(n).connect(ctx.destination);
      meter = n;
    } catch {
      // no worklets here: no meter
    }
  })();
  return b;
}

/** Hears the meter every 100 ms while sound plays; returns the unsubscribe. */
export function onMeter(f: (r: MeterRead) => void): () => void {
  reads.add(f);
  return () => void reads.delete(f);
}

/** The meter's Integrated and True Peak start over (Play from a new place). */
export const resetMeter = () => meter?.port.postMessage("reset");

/** A file that is sound only (laid from its decoded samples); anything else is a video file, heard through its element. */
export const isSoundFile = (url: string) => /\.(wav|aiff?|m4a|mp3|flac|caf|aac|ogg|opus)(\?|#|$)/i.test(url);

/** How long Play waits at most for the pictures at the playhead before the clock starts. */
export const PREROLL_S = 0.5;
/** In front of a start on the sound engine's clock, so the first sound is laid on time rather than late. */
const LEAD_S = 0.03;
const latency = (c: AudioContext) => c.outputLatency || c.baseLatency || 0;

/**
 * The playhead's one clock. Stopped, it holds `t`. Play waits (`waiting`) until the pictures are ready (`ready()`) or
 * PREROLL_S has gone, then runs: on the sound engine's time while there is sound to hear (what is heard now, so the
 * pictures follow the sound), on the page's clock until the engine runs or when there is no sound. Whoever lays sound
 * listens for `onAnchor` (a start, a seek, the move to the engine's time) and lays it at `engineTimeOf`; the player, the
 * playhead and the timecodes read `now()` or listen with `subscribe` (called on each `tick`).
 */
export class NleClock {
  state: "stopped" | "waiting" | "running" = "stopped";
  rate = 1;
  /** set by the sound: something here to hear, so the engine leads */
  sound = false;
  private t = 0;
  private at = 0;
  private since = 0;
  private engine: AudioContext | null = null;
  private subs = new Set<(t: number) => void>();
  private anchors = new Set<() => void>();

  private wall: () => number;
  private audio: () => AudioContext | null;

  constructor(wall = () => performance.now() / 1000, audio: () => AudioContext | null = runningAudio) {
    this.wall = wall;
    this.audio = audio;
  }

  /** the engine whose time leads now, or null (the page's clock) */
  get leader() {
    return this.engine;
  }
  private src = () => (this.engine ? this.engine.currentTime - latency(this.engine) : this.wall());
  now(): number {
    return this.state === "running" ? this.t + Math.max(0, this.src() - this.at) * this.rate : this.t;
  }
  /** Play from where it is at `rate`: waits for `ready()`, at most PREROLL_S. */
  play(rate: number) {
    this.t = this.now();
    this.rate = rate;
    this.state = "waiting";
    this.since = this.wall();
  }
  /** The pictures at the playhead are ready: a waiting clock starts. */
  ready() {
    if (this.state === "waiting") this.anchor(this.t);
  }
  /** Each frame while playing: a wait gone on long enough starts, the engine takes over once it runs; tells the listeners. */
  tick(): number {
    if (this.state === "waiting" && this.wall() - this.since >= PREROLL_S) this.anchor(this.t);
    else if (this.state === "running" && !this.engine && this.sound && this.audio()?.state === "running") this.anchor(this.now());
    const t = this.now();
    for (const f of this.subs) f(t);
    return t;
  }
  stop(): number {
    this.t = this.now();
    this.state = "stopped";
    this.engine = null;
    this.tell();
    return this.t;
  }
  seek(t: number) {
    if (this.state === "running") this.anchor(t);
    else this.t = t;
    for (const f of this.subs) f(t);
  }
  /** Where timeline second `x` is heard on the engine's clock (only while it leads). */
  engineTimeOf(x: number): number {
    return this.engine ? this.at + latency(this.engine) + (x - this.t) / this.rate : NaN;
  }
  subscribe(f: (t: number) => void) {
    this.subs.add(f);
    return () => void this.subs.delete(f);
  }
  onAnchor(f: () => void) {
    this.anchors.add(f);
    return () => void this.anchors.delete(f);
  }
  private anchor(t: number) {
    const c = this.audio();
    this.engine = this.sound && c?.state === "running" ? c : null;
    this.t = t;
    this.at = this.src() + (this.engine ? LEAD_S : 0);
    this.state = "running";
    this.tell();
  }
  private tell() {
    for (const f of this.anchors) f();
  }
}

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
