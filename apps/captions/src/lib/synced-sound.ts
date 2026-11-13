import { useEffect, useRef, useState, type RefObject } from "react";
import { editedFrame } from "@contracts/edit-timeline";
import type { ReviewPlayPlan } from "./plugin";

// Sound on a picture's clock (Web Audio). Each file is laid on the clock in pieces (from `at` seconds, `offset` seconds
// into the file, for `dur`), restarted at the clock's time on play, a seek, a stall or a speed change, and when it
// drifts more than DRIFT_S. Review's voice controls lay each stem once from 0 on the video's own time; an edit played
// from its originals lays each recording where its clips play on the edited timeline (contracts/edit-timeline.ts
// voicePieces), and there the clock runs on through a hold while the picture waits on its frame.

const DRIFT_S = 0.08;
const EVENTS = ["play", "playing", "pause", "waiting", "seeked", "ratechange", "ended"] as const;

export type Piece = { file: string; at: number; offset: number; dur: number };
/** The clock now: `t` seconds, whether it runs, its speed; `steady` false = it runs without the picture (no drift check). */
export type Clock = () => { t: number; run: boolean; rate: number; steady: boolean };

const live = new Set<AudioContext>();
/** Lets the sound start: call it from a click or a key (browsers start sound only from a gesture). */
export const resumeSound = () => live.forEach((c) => void c.resume());

/** A file as sound: a WAV is read only around `span` seconds (a long recording isn't loaded whole), anything else whole. */
async function readSound(ctx: AudioContext, url: string, span?: [number, number]): Promise<{ buf: AudioBuffer; from: number }> {
  if (span && /\.wav(\?|$)/i.test(url)) {
    const part = await wavPart(ctx, url, span).catch(() => null);
    if (part) return part;
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url.split("/").pop()} (${res.status})`);
  return { buf: await ctx.decodeAudioData(await res.arrayBuffer()), from: 0 };
}

const range = async (url: string, a: number, b: number) => {
  const res = await fetch(url, { headers: { Range: `bytes=${a}-${b - 1}` } });
  if (res.status !== 206) throw new Error("no range");
  return new DataView(await res.arrayBuffer());
};

/** PCM samples [span] of a WAV by byte range: its header, then only those bytes. Null for a WAV this doesn't read. */
async function wavPart(ctx: AudioContext, url: string, [a, b]: [number, number]): Promise<{ buf: AudioBuffer; from: number } | null> {
  const head = await range(url, 0, 65536);
  const tag = (o: number) => String.fromCharCode(head.getUint8(o), head.getUint8(o + 1), head.getUint8(o + 2), head.getUint8(o + 3));
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") return null;
  let fmt = 0, data = 0, dataLen = 0;
  for (let o = 12; o + 8 <= head.byteLength;) {
    const len = head.getUint32(o + 4, true);
    if (tag(o) === "fmt ") fmt = o + 8;
    if (tag(o) === "data") { data = o + 8; dataLen = len; break; }
    o += 8 + len + (len & 1);
  }
  if (!fmt || !data) return null;
  const tagged = head.getUint16(fmt, true); // 1 = integer PCM, 3 = float, 0xFFFE = extensible (its sub-format says which)
  const kind = tagged === 0xfffe ? head.getUint16(fmt + 24, true) : tagged;
  const ch = head.getUint16(fmt + 2, true);
  const rate = head.getUint32(fmt + 4, true);
  const bits = head.getUint16(fmt + 14, true);
  const float = kind === 3;
  if (![1, 3].includes(kind) || ![16, 24, 32].includes(bits) || (float && bits !== 32)) return null;
  const frame = ch * (bits / 8);
  const total = Math.floor(dataLen / frame);
  const s0 = Math.max(0, Math.floor(a * rate));
  const s1 = Math.min(total, Math.ceil(b * rate));
  if (s1 <= s0) return null;
  const view = await range(url, data + s0 * frame, data + s1 * frame);
  const n = s1 - s0;
  const buf = ctx.createBuffer(ch, n, rate);
  const out = Array.from({ length: ch }, (_, c) => buf.getChannelData(c));
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < ch; c++) {
      const o = i * frame + c * (bits / 8);
      out[c][i] = float ? view.getFloat32(o, true)
        : bits === 16 ? view.getInt16(o, true) / 32768
        : bits === 24 ? ((view.getUint8(o) | (view.getUint8(o + 1) << 8) | (view.getInt8(o + 2) << 16)) / 8388608)
        : view.getInt32(o, true) / 2147483648;
    }
  }
  return { buf, from: s0 / rate };
}

export class SyncedSound {
  ctx = new AudioContext();
  master = this.ctx.createGain();
  private files = new Map<string, { buf: AudioBuffer; from: number; gain: GainNode }>();
  private pieces: Piece[] = [];
  private playing: AudioBufferSourceNode[] = [];
  private from = 0;
  private t0 = 0;
  private rate = 1;
  private timer = 0;
  private el: HTMLMediaElement;
  private clock: Clock;

  constructor(el: HTMLMediaElement, clock?: Clock) {
    this.el = el;
    this.clock = clock ?? (() => ({ t: el.currentTime, run: !el.paused && !el.ended && el.readyState >= 3, rate: el.playbackRate, steady: true }));
    this.master.connect(this.ctx.destination);
    live.add(this.ctx);
    void this.ctx.resume();
  }

  /** The files' sound (`url(file)`), each read around the seconds its pieces use, and where each plays. */
  async load(pieces: Piece[], url: (file: string) => string) {
    const names = [...new Set(pieces.map((p) => p.file))];
    await Promise.all(names.map(async (f) => {
      const mine = pieces.filter((p) => p.file === f && Number.isFinite(p.dur));
      const span: [number, number] | undefined = mine.length === pieces.filter((p) => p.file === f).length && mine.length
        ? [Math.min(...mine.map((p) => p.offset)), Math.max(...mine.map((p) => p.offset + p.dur))] : undefined;
      const { buf, from } = await readSound(this.ctx, url(f), span);
      const gain = this.ctx.createGain();
      gain.connect(this.master);
      this.files.set(f, { buf, from, gain });
    }));
    this.pieces = pieces;
  }

  run() {
    for (const e of EVENTS) this.el.addEventListener(e, this.follow);
    this.timer = window.setInterval(this.follow, 250);
    this.follow();
  }

  /** Play, pause, a seek, a stall, a speed change: restart only when out of step. */
  follow = () => {
    const c = this.clock();
    if (!c.run) this.stop();
    else if (!this.playing.length || this.rate !== c.rate || (c.steady && Math.abs(this.drift(c.t)) > DRIFT_S)) this.start();
  };

  // what's heard now left the graph outputLatency ago (Bluetooth: ~0.2 s), so the sound runs that far ahead
  private latency = () => this.ctx.outputLatency || this.ctx.baseLatency || 0;
  private drift = (t: number) => this.from + (this.ctx.currentTime - this.t0) * this.rate - t - this.latency();

  private start() {
    this.stop();
    void this.ctx.resume();
    const c = this.clock();
    this.rate = c.rate;
    this.from = c.t + this.latency();
    this.t0 = this.ctx.currentTime;
    for (const p of this.pieces) {
      const f = this.files.get(p.file);
      if (!f) continue;
      const late = Math.max(0, this.from - p.at); // already into this piece by
      const offset = p.offset + late - f.from;
      const dur = Math.min(p.dur - late, f.buf.duration - offset);
      if (dur <= 0 || offset < 0) continue;
      const s = this.ctx.createBufferSource();
      s.buffer = f.buf;
      s.playbackRate.value = this.rate;
      s.connect(f.gain);
      s.start(this.t0 + Math.max(0, p.at - this.from) / this.rate, offset, dur);
      this.playing.push(s);
    }
  }

  stop() {
    for (const s of this.playing) {
      s.stop();
      s.disconnect();
    }
    this.playing = [];
  }

  level(file: string, v: number) {
    this.files.get(file)?.gain.gain.setTargetAtTime(v, this.ctx.currentTime, 0.015);
  }

  close() {
    window.clearInterval(this.timer);
    for (const e of EVENTS) this.el.removeEventListener(e, this.follow);
    this.stop();
    live.delete(this.ctx);
    void this.ctx.close();
  }
}

/**
 * The edited timeline's clock for a plan (seconds): the video's frame mapped through the plan's skips and holds, running
 * on through a hold while the picture waits on its frame (`holding` = frames the page holds for, lib/review-play.ts).
 */
export function editedClock(el: HTMLVideoElement, plan: Pick<ReviewPlayPlan, "fps" | "skips" | "holds">, holding: { current: number }): Clock {
  const fps = plan.fps || 25;
  let held = { since: 0, at: 0 };
  return () => {
    const run = !el.paused && !el.ended && el.readyState >= 3;
    const r = el.currentTime * fps;
    const t = editedFrame(plan, r) / fps;
    const h = holding.current > 0 ? plan.holds.find((x) => Math.abs(r - (x.at + 0.5)) < 1) : undefined;
    if (h) { // the picture waits on its frame; the timeline runs on from where it stopped, for the hold's length
      if (!held.since) held = { since: performance.now(), at: t - h.frames / fps };
      const t1 = held.at + Math.min(h.frames / fps, ((performance.now() - held.since) / 1000) * el.playbackRate);
      return { t: t1, run: true, rate: el.playbackRate, steady: false };
    }
    held = { since: 0, at: 0 };
    return { t, run, rate: el.playbackRate, steady: true };
  };
}

/**
 * An edit played from its originals (the plan's `sound`, frames on the edited timeline): its pieces on the edited
 * timeline's clock, which is the video's frame mapped through the plan's skips and holds, and runs on through a hold
 * while the picture waits. True while it plays its own sound (the page mutes the video then); false while loading or
 * when a file wouldn't load (`error`), and the video's own sound plays.
 */
export function useEditSound(video: RefObject<HTMLVideoElement | null>, plan: ReviewPlayPlan | null, holding: number): { live: boolean; error: string } {
  const [state, setState] = useState({ live: false, error: "" });
  const sound = plan?.sound;
  const key = sound ? JSON.stringify([plan!.fps, plan!.skips, plan!.holds, sound]) : "";
  const hold = useRef(holding);
  hold.current = holding;
  useEffect(() => {
    const el = video.current;
    if (!key || !el || !plan?.sound) return void setState({ live: false, error: "" });
    const fps = plan.fps || 25;
    const clock = editedClock(el, plan, hold);
    let s: SyncedSound;
    try {
      s = new SyncedSound(el, clock);
    } catch (e) { // no sound engine here (or the browser refused one): the video's own sound plays, as before
      return void setState({ live: false, error: (e as Error).message || "No sound engine" });
    }
    let gone = false;
    setState({ live: false, error: "" });
    s.load(plan.sound.map((p) => ({ file: p.src, at: p.at / fps, offset: p.offset, dur: p.frames / fps })), (f) => f).then(
      () => {
        if (gone) return;
        s.run();
        setState({ live: true, error: "" });
      },
      (e: Error) => !gone && setState({ live: false, error: e.message || "The original sound didn't load" }),
    );
    return () => {
      gone = true;
      s.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on what plays, not on the plan object
  }, [key]);
  return state;
}
