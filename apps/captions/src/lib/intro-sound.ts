import type { Beat } from "@/components/HomeIntro";

/**
 * The sound of Home's welcome (components/HomeIntro.tsx): a quiet bed of held notes under the whole of it, and a small
 * sound on each move: a run of notes as the name's letters rise, air moving with the marker box, a note as each stage
 * pops up, a soft thud as each box opens, a note for every tool and tile, a closing chord. All of it is made here with
 * the browser's own audio (no sound files), on whichever audio context it is given: the page's, or an offline one that
 * renders the same sound to a buffer (how a recording of the welcome gets its soundtrack).
 */

/** What is on the page, so there is one note for each thing that pops in. */
export interface IntroCounts {
  /** The boxes on Home: three, fewer when every tool of one is switched off. */
  stages: number;
  tiles: number;
  extras: number;
  chips: number;
}

/** One sound, `at` seconds into its beat. */
export type Hit =
  | { at: number; kind: "note"; hz: number; gain: number } // a soft pluck
  | { at: number; kind: "sweep"; len: number } // air moving
  | { at: number; kind: "thud" } // a box opening
  | { at: number; kind: "bell"; hz: number[] }; // notes left ringing

/** D major pentatonic from D4: step 0 = D4, 1 = E4, 5 = D5; negative steps go down. Any run of it sounds settled. */
const PENTA = [0, 2, 4, 7, 9];
export const step = (n: number): number => 293.66 * 2 ** ((Math.floor(n / 5) * 12 + PENTA[((n % 5) + 5) % 5]!) / 12);

/** How loud the whole of it is (a gain on everything): set by measuring a render, about -18 LUFS with peaks near -5 dBFS. */
const LEVEL = 1.8;

/** The notes held under each beat (Hz); a beat not named keeps what is sounding. D, then G under connect, then D again. */
const CHORDS: Partial<Record<Beat, number[]>> = {
  hello: [73.42, 146.83, 220, 329.63, 369.99],
  connect: [98, 146.83, 246.94, 369.99, 440],
  all: [73.42, 146.83, 220, 293.66, 369.99, 440],
};

/** `count` plucks, `every` seconds apart from `from`, climbing the scale from `first` by `stride` steps. */
const run = (count: number, from: number, every: number, first: number, gain: number, stride = 1): Hit[] =>
  Array.from({ length: count }, (_, i): Hit => ({ at: from + i * every, kind: "note", hz: step(first + i * stride), gain }));

/**
 * A beat's sounds, timed to its moves in index.css (.intro-*): each delay here is the one there plus the moment the
 * thing takes to land. Change a delay there and change it here.
 */
export function hitsFor(beat: Beat, n: IntroCounts): Hit[] {
  switch (beat) {
    case "hello": // a letter every 45 ms from 300 ms (.intro-letter); the marker box from 1350 ms for 800 ms (.intro-marked)
      return [...run(14, 0.42, 0.045, -8, 0.07), { at: 1.35, kind: "sweep", len: 0.8 }, { at: 2.12, kind: "bell", hz: [step(0), step(3)] }];
    case "pipeline": // the line arrives
      return [
        { at: 0.12, kind: "note", hz: step(-2), gain: 0.1 },
        { at: 0.3, kind: "note", hz: step(0), gain: 0.1 },
      ];
    case "stages": // a stage every 450 ms from 350 ms (.intro-node), the line to it 200 ms earlier (.intro-line)
      return Array.from({ length: n.stages }, (_, i) => i).flatMap((i): Hit[] => [
        ...(i ? [{ at: 0.15 + i * 0.45, kind: "sweep" as const, len: 0.42 }] : []),
        { at: 0.43 + i * 0.45, kind: "note", hz: step([0, 2, 3][i] ?? 3), gain: 0.17 },
      ]);
    case "tools": // a box every 140 ms (.intro-frame); a tool every 150 ms from 700 ms (.intro-tile); an extra every 70 ms from 2000 ms (.intro-extra)
      return [...Array.from({ length: n.stages }, (_, i): Hit => ({ at: 0.08 + i * 0.14, kind: "thud" })), ...run(n.tiles, 0.8, 0.15, 0, 0.15), ...run(n.extras, 2.06, 0.07, 5, 0.065)];
    case "connect": // a tile every 220 ms from 600 ms (.intro-chip, after the scene's 250 ms wait)
      return run(n.chips, 0.7, 0.22, 3, 0.15, 2);
    case "all":
      return [{ at: 0.3, kind: "bell", hz: [step(-5), step(-2), step(0), step(2)] }];
  }
}

/** Two seconds of hiss: what the sweeps and thuds are cut from, and the room's echo is made of. */
function hiss(ctx: BaseAudioContext, seconds = 2): AudioBuffer {
  const buf = ctx.createBuffer(2, Math.ceil(ctx.sampleRate * seconds), ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  return buf;
}

/** A room to play in: hiss dying away over about two and a half seconds, duller as it goes. */
function room(ctx: BaseAudioContext): AudioBuffer {
  const buf = hiss(ctx, 2.6);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let low = 0;
    for (let i = 0; i < d.length; i++) {
      const left = 1 - i / d.length;
      low += (d[i]! - low) * (0.12 + 0.5 * left); // a one-pole low-pass that closes with time
      d[i] = low * left ** 3;
    }
  }
  return buf;
}

/**
 * The welcome's sound on one audio context. `beat` schedules a beat's sounds from the time `t` on the context's clock
 * (now, on a live one); `end` lets it die away from `t`.
 */
export function introSound(ctx: BaseAudioContext) {
  const out = ctx.createGain();
  out.gain.value = LEVEL;
  const guard = ctx.createDynamicsCompressor(); // only against a loud sum: nothing here is meant to reach it
  guard.threshold.value = -5;
  guard.ratio.value = 3;
  out.connect(guard).connect(ctx.destination);
  const echo = ctx.createConvolver();
  echo.buffer = room(ctx);
  const wet = ctx.createGain();
  wet.gain.value = 0.55;
  wet.connect(echo).connect(out);
  const air = hiss(ctx);
  /** Sends a sound out, and a share of it through the room. */
  const send = (node: AudioNode, share: number) => {
    node.connect(out);
    const s = ctx.createGain();
    s.gain.value = share;
    node.connect(s).connect(wet);
  };
  /** A gain that rises to `peak` in `attack` s from `t` and dies away over about `tail` s. */
  const shape = (t: number, peak: number, attack: number, tail: number): GainNode => {
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + attack);
    g.gain.setTargetAtTime(0, t + attack, tail / 5);
    return g;
  };
  const tone = (type: OscillatorType, hz: number, t: number, stop: number): OscillatorNode => {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(hz, t);
    o.start(t);
    o.stop(stop);
    return o;
  };

  // the bed: each held note is a soft triangle with a quieter, slightly sharp saw beside it, all behind one low-pass
  // that opens as the welcome begins
  const dark = ctx.createBiquadFilter();
  dark.type = "lowpass";
  dark.Q.value = 0.4;
  send(dark, 0.6);
  let held: { g: GainNode; os: OscillatorNode[] }[] = [];
  const hold = (hz: number[], t: number) => {
    for (const v of held) {
      v.g.gain.setTargetAtTime(0, t, 0.5);
      for (const o of v.os) o.stop(t + 4);
    }
    held = hz.map((f) => {
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.setTargetAtTime(0.026, t, 0.7); // quiet: the bed sits under the notes, and its lowest note must not drone
      const a = tone("triangle", f, t, t + 600);
      const b = tone("sawtooth", f * 1.004, t, t + 600);
      const thin = ctx.createGain();
      thin.gain.value = 0.22;
      a.connect(g);
      b.connect(thin).connect(g);
      g.connect(dark);
      return { g, os: [a, b] };
    });
  };

  const play = (h: Hit, t: number) => {
    if (h.kind === "note") {
      // a pluck: a sine that starts a touch sharp and settles (the "boop"), with a quiet octave on top that goes first
      const body = tone("sine", h.hz * 1.22, t, t + 1.2);
      body.frequency.exponentialRampToValueAtTime(h.hz, t + 0.035);
      const g = shape(t, h.gain, 0.006, 0.55);
      body.connect(g);
      const top = tone("triangle", h.hz * 2, t, t + 0.5);
      const tg = shape(t, h.gain * 0.1, 0.004, 0.16);
      top.connect(tg);
      send(g, 0.5);
      send(tg, 0.5);
    } else if (h.kind === "sweep") {
      const src = ctx.createBufferSource();
      src.buffer = air;
      const band = ctx.createBiquadFilter();
      band.type = "bandpass";
      band.Q.value = 1.1;
      band.frequency.setValueAtTime(420, t);
      band.frequency.exponentialRampToValueAtTime(3200, t + h.len);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.11, t + h.len * 0.6);
      g.gain.linearRampToValueAtTime(0, t + h.len);
      src.connect(band).connect(g);
      send(g, 0.4);
      src.start(t);
      src.stop(t + h.len + 0.05);
    } else if (h.kind === "thud") {
      const o = tone("sine", 150, t, t + 0.5);
      o.frequency.exponentialRampToValueAtTime(62, t + 0.12);
      const g = shape(t, 0.2, 0.004, 0.2);
      o.connect(g);
      send(g, 0.25);
      const src = ctx.createBufferSource();
      src.buffer = air;
      const soft = ctx.createBiquadFilter();
      soft.type = "lowpass";
      soft.frequency.value = 900;
      const ng = shape(t, 0.035, 0.003, 0.07);
      src.connect(soft).connect(ng);
      send(ng, 0.3);
      src.start(t);
      src.stop(t + 0.3);
    } else {
      for (const [i, hz] of h.hz.entries()) {
        const o = tone("sine", hz, t + i * 0.03, t + 4.5);
        const g = shape(t + i * 0.03, 0.085 / (1 + i * 0.35), 0.012, 2.4);
        o.connect(g);
        send(g, 0.7);
      }
    }
  };

  return {
    /** A beat's sounds from `t`. `len` (s) and `last` let the final beat thin out before it ends. */
    beat(id: Beat, n: IntroCounts, at: { t?: number; len?: number; last?: boolean } = {}) {
      const t = at.t ?? ctx.currentTime;
      if (id === "hello") {
        dark.frequency.setValueAtTime(320, t);
        dark.frequency.exponentialRampToValueAtTime(1500, t + 2.4);
      }
      // a beat that names no notes keeps what is held; with nothing held yet (sound joined late), the opening ones
      const chord = CHORDS[id] ?? (held.length ? null : CHORDS.hello);
      if (chord) hold(chord, t);
      for (const h of hitsFor(id, n)) play(h, t + h.at);
      if (at.last && at.len) out.gain.setTargetAtTime(LEVEL * 0.4, t + Math.max(0, at.len - 1.6), 0.6);
    },
    /** Dies away from `t` (the end, or Skip). */
    end(t = ctx.currentTime) {
      out.gain.cancelScheduledValues(t);
      out.gain.setTargetAtTime(0, t, 0.22);
    },
  };
}

/** The page's own audio context and the welcome playing on it. */
let live: { ctx: AudioContext; score: ReturnType<typeof introSound>; done: Set<Beat> } | null = null;

/**
 * Gets the page ready to make sound. Call it in the press that starts the welcome (Done): a browser lets sound start
 * only from a press, and by the time the welcome begins the press is over.
 */
export function primeIntroSound(): void {
  try {
    const ctx = new AudioContext();
    void ctx.resume();
    live = { ctx, score: introSound(ctx), done: new Set() };
  } catch {
    live = null; // no audio here: the welcome plays without it
  }
}

/** Plays a beat's sounds now, once (a second call for the same beat does nothing). Silent when the page may not make sound. */
export function playIntroBeat(id: Beat, n: IntroCounts, at: { len: number; last: boolean }): void {
  if (!live) primeIntroSound(); // the welcome started without a press (the replay link): it sounds only where the browser allows that
  if (!live || live.ctx.state !== "running" || live.done.has(id)) return;
  live.done.add(id);
  live.score.beat(id, n, at);
}

/** The welcome ended or was skipped: the sound dies away and the audio context is given back. */
export function stopIntroSound(): void {
  const was = live;
  live = null;
  if (!was) return;
  if (was.ctx.state === "running") was.score.end();
  window.setTimeout(() => void was.ctx.close().catch(() => {}), 1500);
}
