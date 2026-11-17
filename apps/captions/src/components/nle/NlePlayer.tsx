import { useEffect, useMemo, useRef } from "react";
import { readSound } from "@/lib/synced-sound";
import { nleAudio, runningAudio } from "@/lib/nle/audio";
import type { NleItem, NleTimeline } from "@/lib/nle/model";
import { picturesAt, picturesSoon, placement, soundPieces, sourceTime, type SoundPiece } from "@/lib/nle/picture";

// The editor's viewer: the timeline played live from its source files. Every picture at the playhead is drawn on a
// canvas the timeline's size, V1 at the bottom, each with its transform, crop and opacity; the sound tracks play through
// Web Audio with each clip's gain. One <video> per clip on screen (and the ones about to start, so they are ready),
// kept on the timeline's clock: seeked when paused, played at the clip's speed and put back when they drift. A clip whose
// file can't play here is a grey frame with its name, never an older render.

type Media = { el: HTMLVideoElement | HTMLImageElement; url: string; lead: number; bad: boolean; used: number };

/** A source's file as this browser plays it; `lead`: seconds into the file where the source's frame 0 is. */
export type NleFile = { url: string; lead?: number };

const DRIFT_S = 0.25;
const isImage = (url: string) => /\.(png|jpe?g|webp|gif)(\?|$)/i.test(url);

export function NlePlayer({ tl, time, playing, rate, urlOf, nameOf, className }: {
  tl: NleTimeline;
  /** seconds on the timeline */
  time: number;
  playing: boolean;
  /** the J / K / L speed: < 0 plays backwards (picture only) */
  rate: number;
  /** a source's file as the browser plays it; null when it has none here */
  urlOf: (src: string) => NleFile | null;
  nameOf: (src: string) => string;
  className?: string;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const pool = useRef(new Map<string, Media>());
  const now = useRef({ tl, time, playing, rate, urlOf, nameOf });
  now.current = { tl, time, playing, rate, urlOf, nameOf };
  const W = tl.timeline.width || 1080;
  const H = tl.timeline.height || 1920;

  useEffect(() => {
    let raf = 0;
    let tick = 0;
    const media = (it: NleItem): Media | null => {
      const { urlOf: url } = now.current;
      const file = url(it.src);
      if (!file) return null;
      const u = file.url;
      const k = it._k ?? `${it.src}:${it.rec}`;
      let m = pool.current.get(k);
      if (m && m.url !== u) {
        drop(k);
        m = undefined;
      }
      if (!m) {
        const el = isImage(u) ? new Image() : Object.assign(document.createElement("video"), { muted: true, playsInline: true, preload: "auto" });
        const made: Media = { el, url: u, lead: file.lead ?? 0, bad: false, used: tick };
        el.addEventListener("error", () => void (made.bad = true));
        el.src = u;
        pool.current.set(k, (m = made));
      }
      m.used = tick;
      return m;
    };
    const drop = (k: string) => {
      const m = pool.current.get(k);
      if (!m) return;
      if (m.el instanceof HTMLVideoElement) {
        m.el.pause();
        m.el.removeAttribute("src");
        m.el.load();
      }
      pool.current.delete(k);
    };
    const keep = (el: HTMLVideoElement, want: number, run: boolean, speed: number) => {
      if (el.readyState < 1) return;
      if (run) {
        el.playbackRate = Math.min(16, Math.max(0.0625, speed));
        if (el.paused) void el.play().catch(() => {});
        if (Math.abs(el.currentTime - want) > DRIFT_S && !el.seeking) el.currentTime = want;
      } else {
        if (!el.paused) el.pause();
        if (Math.abs(el.currentTime - want) > 0.01 && !el.seeking) el.currentTime = want;
      }
    };
    // a picture with no file here: a grey frame with its name where the picture would be (as if it were the frame's size)
    const missing = (ctx: CanvasRenderingContext2D, it: NleItem, track: string, name: string, why: string) => {
      const p = placement(it, track, W, H, W, H);
      ctx.save();
      ctx.setTransform(...p.m);
      ctx.fillStyle = "#3f3f46";
      ctx.fillRect(...p.crop);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      const [cx, cy] = [p.m[0] * (W / 2) + p.m[2] * (H / 2) + p.m[4], p.m[1] * (W / 2) + p.m[3] * (H / 2) + p.m[5]];
      ctx.fillStyle = "#e4e4e7";
      ctx.textAlign = "center";
      ctx.font = `600 ${Math.round(W / 24)}px system-ui, sans-serif`;
      ctx.fillText(name, cx, cy, W * 0.9);
      ctx.font = `${Math.round(W / 34)}px system-ui, sans-serif`;
      ctx.fillStyle = "#a1a1aa";
      ctx.fillText(why, cx, cy + W / 18, W * 0.9);
      ctx.restore();
    };
    const frame = () => {
      raf = requestAnimationFrame(frame);
      tick++;
      const ctx = canvas.current?.getContext("2d");
      if (!ctx) return;
      const { tl: t, time: s, playing: run, rate: r, nameOf: name } = now.current;
      const fps = t.timeline.fps;
      const f = Math.floor(s * fps + 1e-6);
      const on = picturesAt(t, f);
      const live = new Set<string>();
      ctx.globalAlpha = 1;
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, W, H);
      for (const { item, track } of on) {
        const m = media(item);
        live.add(item._k ?? "");
        if (!m) {
          missing(ctx, item, track, name(item.src), /%0\dd/.test(String(t.sources[item.src]?.path ?? "")) ? "Image sequence: shows on Save" : "File not found here");
          continue;
        }
        if (m.bad) {
          missing(ctx, item, track, name(item.src), "This file won't play here");
          continue;
        }
        const el = m.el;
        let sw = 0;
        let sh = 0;
        if (el instanceof HTMLVideoElement) {
          keep(el, sourceTime(t, item, s) + m.lead, run && r > 0, (item.speed || 1) * r);
          if (el.readyState < 2) continue;
          [sw, sh] = [el.videoWidth, el.videoHeight];
        } else {
          if (!el.complete || !el.naturalWidth) continue;
          [sw, sh] = [el.naturalWidth, el.naturalHeight];
        }
        if (!sw || !sh) continue;
        const p = placement(item, track, sw, sh, W, H);
        if (p.crop[2] <= 0 || p.crop[3] <= 0 || !p.alpha) continue;
        ctx.save();
        ctx.globalAlpha = p.alpha;
        ctx.setTransform(...p.m);
        ctx.drawImage(el, ...p.crop, ...p.crop);
        ctx.restore();
      }
      // the clips about to start: their files open and waiting on their first frame
      if (run && r > 0) {
        for (const { item } of picturesSoon(t, f, 2 * fps)) {
          const m = media(item);
          live.add(item._k ?? "");
          if (m && m.el instanceof HTMLVideoElement) keep(m.el, sourceTime(t, item, item.rec / fps) + m.lead, false, 1);
        }
      }
      for (const [k, m] of pool.current) {
        if (live.has(k)) continue;
        if (m.el instanceof HTMLVideoElement && !m.el.paused) m.el.pause();
        // ponytail: keeps the last dozen files open for scrubbing back; an LRU by memory if long timelines need it
        if (tick - m.used > 600 || pool.current.size > 12) drop(k);
      }
    };
    raf = requestAnimationFrame(frame);
    const all = pool.current;
    return () => {
      cancelAnimationFrame(raf);
      for (const k of [...all.keys()]) drop(k);
    };
  }, [W, H]);

  useNleSound(tl, time, playing, rate, urlOf);

  return <canvas ref={canvas} width={W} height={H} className={className} style={{ aspectRatio: `${W} / ${H}` }} />;
}

const buffers = new Map<string, Promise<{ buf: AudioBuffer; from: number }>>();

/** The sound tracks on the timeline's clock: laid from the playhead on play, again after a seek, a change or a drift. */
function useNleSound(tl: NleTimeline, time: number, playing: boolean, rate: number, urlOf: (src: string) => NleFile | null) {
  const pieces = useMemo(() => soundPieces(tl).flatMap((p): (SoundPiece & { url: string })[] => {
    const f = urlOf(p.src);
    return f ? [{ ...p, url: f.url, offset: p.offset + (f.lead ?? 0) }] : [];
  }), [tl, urlOf]);
  const key = JSON.stringify(pieces);
  const state = useRef<{ nodes: AudioScheduledSourceNode[]; anchor: { t: number; at: number } | null; gen: number }>({ nodes: [], anchor: null, gen: 0 });
  const timeRef = useRef(time);
  timeRef.current = time;

  const stop = () => {
    for (const n of state.current.nodes) {
      try {
        n.stop();
      } catch {
        // never started
      }
      n.disconnect();
    }
    state.current.nodes = [];
    state.current.anchor = null;
  };

  const start = () => {
    stop();
    const ctx = nleAudio();
    if (!ctx) return;
    const gen = ++state.current.gen;
    const t = timeRef.current;
    const at = ctx.currentTime + 0.05;
    state.current.anchor = { t, at };
    for (const p of pieces) {
      if (p.at + p.dur <= t) continue;
      let got = buffers.get(p.url);
      if (!got) {
        got = readSound(ctx, p.url);
        got.catch(() => buffers.delete(p.url));
        buffers.set(p.url, got);
      }
      void got.then(({ buf, from }) => {
        if (state.current.gen !== gen) return;
        // laid at the clock's time now (a file that took a while to read comes in where the timeline is)
        const a = state.current.anchor!;
        const tNow = a.t + Math.max(0, ctx.currentTime - a.at) * rate;
        const late = Math.max(0, tNow - p.at);
        const offset = p.offset + late * p.speed - from;
        const dur = (p.dur - late) * p.speed;
        if (dur <= 0 || offset < 0 || offset >= buf.duration) return;
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.playbackRate.value = p.speed * rate;
        const g = ctx.createGain();
        g.gain.value = p.gain;
        src.connect(g).connect(ctx.destination);
        src.start(Math.max(ctx.currentTime, a.at + Math.max(0, p.at - a.t) / rate), offset, Math.min(dur, buf.duration - offset));
        state.current.nodes.push(src);
      }, () => {});
    }
  };

  const run = playing && rate > 0;
  useEffect(() => {
    if (run) start();
    else stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- laid again when what plays changes
  }, [run, rate, key]);
  useEffect(() => () => stop(), []);
  // a seek while playing, or the two clocks drifting apart: laid again from where the timeline is
  useEffect(() => {
    const a = state.current.anchor;
    const ctx = runningAudio();
    if (!run || !a || !ctx) return;
    if (Math.abs(a.t + Math.max(0, ctx.currentTime - a.at) * rate - time) > 0.15) start();
  });
}
