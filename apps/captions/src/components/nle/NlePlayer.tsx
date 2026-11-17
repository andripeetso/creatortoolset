import { useEffect, useMemo, useRef } from "react";
import { readSound } from "@/lib/synced-sound";
import { nleAudio, runningAudio } from "@/lib/nle/audio";
import type { NleItem, NleTimeline } from "@/lib/nle/model";
import { picturesAt, picturesSoon, placement, soundPieces, sourceTime, type SoundPiece } from "@/lib/nle/picture";
import { drawnAsShot, lookFilter, shotPlan, shotSource, shotTime, type Pic, type ShotOp } from "@/lib/nle/shot";

// The editor's viewer: the timeline played live from its source files. Every picture at the playhead is drawn on a
// canvas the timeline's size, V1 at the bottom, each with its transform, crop and opacity, and a shot-list edit's V1
// shots with their frame size, blurred fill, split rows and smooth zoom, as the renderer draws them (lib/nle/shot.ts);
// the sound tracks play through Web Audio with each clip's gain. One <video> per picture on screen (and the ones about to
// start, so they are ready), kept on the timeline's clock: seeked when paused, played at the clip's speed and put back
// when they drift; a card made as numbered pictures shows its picture for the frame. A clip whose file can't play here
// is a grey frame with its name, never an older render.

type Media = {
  el: HTMLVideoElement | HTMLImageElement;
  url: string;
  lead: number;
  bad: boolean;
  used: number;
  /** a numbered picture sequence: its pictures by number, loaded ahead of the playhead */
  seq?: { frame: (n: number) => string; got: Map<number, HTMLImageElement> };
};

/** A source's file as this browser plays it; `lead`: seconds into the file where the source's frame 0 is; `frame`: the
 *  file of picture n when the source is a numbered picture sequence (from 0). */
export type NleFile = { url: string; lead?: number; frame?: (n: number) => string };

const DRIFT_S = 0.25;
const SEQ_AHEAD = 8;
const isImage = (url: string) => /\.(png|jpe?g|webp|gif)(\?|$)/i.test(url);
type Drawable = { el: CanvasImageSource; w: number; h: number };
const canFilter = typeof CanvasRenderingContext2D !== "undefined" && "filter" in CanvasRenderingContext2D.prototype;

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
    // a shot is composed here first, then its zoom drawn onto the viewer; a blurred fill is made small here
    const layer = Object.assign(document.createElement("canvas"), { width: W, height: H });
    const small = document.createElement("canvas");
    const media = (k: string, src: string): Media | null => {
      const file = now.current.urlOf(src);
      if (!file) return null;
      const u = file.url;
      let m = pool.current.get(k);
      if (m && m.url !== u) {
        drop(k);
        m = undefined;
      }
      if (!m) {
        const el = file.frame || isImage(u) ? new Image() : Object.assign(document.createElement("video"), { muted: true, playsInline: true, preload: "auto" });
        const made: Media = { el, url: u, lead: file.lead ?? 0, bad: false, used: tick, ...(file.frame ? { seq: { frame: file.frame, got: new Map() } } : {}) };
        el.addEventListener("error", () => void (made.bad = true));
        el.src = file.frame ? file.frame(0) : u;
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
    /** The picture of `m` at `secs` into its file (a sequence: picture n, the nearest earlier one while n loads). */
    const pictureOf = (m: Media, secs: number, fps: number, run: boolean, speed: number): Drawable | null => {
      if (m.seq) {
        const n = Math.max(0, Math.floor(secs * fps + 1e-6));
        const { got, frame } = m.seq;
        for (let i = n; i <= n + SEQ_AHEAD; i++) {
          if (got.has(i)) continue;
          const img = new Image();
          img.src = frame(i);
          got.set(i, img);
        }
        for (const i of got.keys()) if (i < n - 2 || i > n + 4 * SEQ_AHEAD) got.delete(i);
        for (let i = n; i >= n - 2; i--) {
          const img = got.get(i);
          if (img?.complete && img.naturalWidth) return { el: img, w: img.naturalWidth, h: img.naturalHeight };
        }
        return null;
      }
      const el = m.el;
      if (el instanceof HTMLVideoElement) {
        keep(el, secs + m.lead, run, speed);
        return el.readyState >= 2 && el.videoWidth ? { el, w: el.videoWidth, h: el.videoHeight } : null;
      }
      return el.complete && el.naturalWidth ? { el, w: el.naturalWidth, h: el.naturalHeight } : null;
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
    /** A darkened blur of a picture behind a shot (the renderer's: an eighth of the size, blurred, darkened, scaled up). */
    const blurred = (lc: CanvasRenderingContext2D, d: Drawable, op: ShotOp) => {
      const { w, h, sigma, dim } = op.bg!;
      small.width = w;
      small.height = h;
      const s = small.getContext("2d")!;
      s.drawImage(d.el, ...op.src, 0, 0, w, h); // under the blur: its edges stay filled where the blur thins out
      if (canFilter) {
        s.filter = `blur(${sigma}px)`;
        s.drawImage(d.el, ...op.src, 0, 0, w, h);
        s.filter = "none";
      }
      // darker by a fixed amount, as the renderer's brightness: 1 − ((1 − x) + d)
      const by = Math.round(dim * 327);
      for (const [mode, fill] of [["difference", "#fff"], ["lighter", `rgb(${by},${by},${by})`], ["difference", "#fff"]] as const) {
        s.globalCompositeOperation = mode;
        s.fillStyle = fill;
        s.fillRect(0, 0, w, h);
      }
      s.globalCompositeOperation = "source-over";
      lc.drawImage(small, 0, 0, w, h, ...op.dst);
    };
    const frame = () => {
      raf = requestAnimationFrame(frame);
      tick++;
      const ctx = canvas.current?.getContext("2d");
      if (!ctx) return;
      const { tl: t, time: s, playing: run, rate: r, nameOf: name } = now.current;
      const fps = t.timeline.fps;
      const srcFps = (src: string) => t.sources[src]?.fps || fps;
      const f = Math.floor(s * fps + 1e-6);
      const on = picturesAt(t, f);
      const live = new Set<string>();
      const forward = run && r > 0;
      const flashes: number[] = [];
      ctx.globalAlpha = 1;
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, W, H);
      for (const { item, track } of on) {
        const key = item._k ?? `${item.src}:${item.rec}`;
        const k = f - item.rec;
        if (item.fx === "flash") {
          // a designed white flash, fading as its file does (drawn over everything, as the renderer does)
          flashes.push(1 - (item.in + k) / Math.max(Number(t.sources[item.src]?.dur) || item.len, 1));
          continue;
        }
        const v1 = track === "V1";
        // V1 plays a freeze held and a reversed shot backwards (seeked frame by frame); the other tracks as they are
        const still = v1 && (!!item.freeze || !!item.rev);
        const own = v1 ? shotTime(item, "main", k, fps, srcFps) : sourceTime(t, item, s);
        const m = media(key, item.src);
        live.add(key);
        if (!m || m.bad) {
          missing(ctx, item, track, name(item.src), m ? "This file won't play here" : "File not found here");
          continue;
        }
        const d = pictureOf(m, own, srcFps(item.src), forward && !still, (item.speed || 1) * r);
        if (!d) continue;
        if (drawnAsShot(item, track, W, H)) {
          // the shot's other pictures: the shot before under an inset, the split rows; each plays on from its own frame
          const got: Partial<Record<Pic, Drawable>> = { main: d };
          for (const pic of ["under", 1, 2] as const) {
            const src = shotSource(item, pic);
            if (!src) continue;
            const pk = `${key}:${pic}`;
            const pm = media(pk, src);
            live.add(pk);
            const pd = pm && !pm.bad ? pictureOf(pm, shotTime(item, pic, k, fps, srcFps), srcFps(src), forward, r) : null;
            if (pd) got[pic] = pd;
          }
          const plan = shotPlan(item, k, (pic) => (got[pic] ? [got[pic]!.w, got[pic]!.h] : null), W, H);
          const lc = layer.getContext("2d")!;
          lc.fillStyle = "#000";
          lc.fillRect(0, 0, W, H);
          for (const op of plan.ops) {
            const pd = got[op.pic];
            if (!pd) continue;
            if (op.bg) {
              blurred(lc, pd, op);
              continue;
            }
            if (op.edge) {
              lc.fillStyle = "#fff";
              lc.fillRect(op.dst[0] - op.edge, op.dst[1] - op.edge, op.dst[2] + 2 * op.edge, op.dst[3] + 2 * op.edge);
            }
            lc.drawImage(pd.el, ...op.src, ...op.dst);
          }
          ctx.save();
          const look = canFilter ? lookFilter(item, k, W) : "";
          if (look) ctx.filter = look;
          ctx.drawImage(layer, ...plan.view, 0, 0, W, H);
          ctx.restore();
          continue;
        }
        const p = placement(item, track, d.w, d.h, W, H);
        if (p.crop[2] <= 0 || p.crop[3] <= 0 || !p.alpha) continue;
        ctx.save();
        ctx.globalAlpha = p.alpha;
        ctx.setTransform(...p.m);
        ctx.drawImage(d.el, ...p.crop, ...p.crop);
        ctx.restore();
      }
      for (const a of flashes) {
        ctx.fillStyle = `rgba(255,255,255,${Math.min(1, Math.max(0, a))})`;
        ctx.fillRect(0, 0, W, H);
      }
      // the clips about to start: their files open and waiting on their first frame
      if (forward) {
        for (const { item, track } of picturesSoon(t, f, 2 * fps)) {
          if (item.fx === "flash") continue;
          const key = item._k ?? `${item.src}:${item.rec}`;
          const m = media(key, item.src);
          live.add(key);
          const at = track === "V1" ? shotTime(item, "main", 0, fps, srcFps) : sourceTime(t, item, item.rec / fps);
          if (m && !m.seq && m.el instanceof HTMLVideoElement) keep(m.el, at + m.lead, false, 1);
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
  const state = useRef<{ nodes: { stop(): void; disconnect(): void }[]; anchor: { t: number; at: number } | null; gen: number }>({ nodes: [], anchor: null, gen: 0 });
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
      if (p.speed !== 1) {
        stretched(ctx, p, gen);
        continue;
      }
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

  // a clip at another speed keeps its pitch, as the render's (a media element stretches its sound; a buffer can't)
  const stretched = (ctx: AudioContext, p: SoundPiece & { url: string }, gen: number) => {
    const a = state.current.anchor!;
    const el = Object.assign(new Audio(), { crossOrigin: "anonymous", preload: "auto", preservesPitch: true, src: p.url });
    const g = ctx.createGain();
    g.gain.value = p.gain;
    ctx.createMediaElementSource(el).connect(g).connect(ctx.destination);
    const late = Math.max(0, a.t - p.at);
    el.currentTime = p.offset + late * p.speed;
    el.playbackRate = p.speed * rate;
    const wait = (a.at + Math.max(0, p.at - a.t) / rate - ctx.currentTime) * 1000;
    const timers = [
      window.setTimeout(() => state.current.gen === gen && void el.play().catch(() => {}), Math.max(0, wait)),
      window.setTimeout(() => el.pause(), Math.max(0, wait) + ((p.dur - late) / rate) * 1000),
    ];
    // stopped with the rest: a node that pauses its element and lets go of its file
    const node = { stop: () => { timers.forEach(clearTimeout); el.pause(); el.removeAttribute("src"); el.load(); }, disconnect: () => g.disconnect() };
    state.current.nodes.push(node);
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
