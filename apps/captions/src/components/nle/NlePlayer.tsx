import { useEffect, useMemo, useRef } from "react";
import { readSound } from "@/lib/synced-sound";
import { fadePoints, nleAudio, runningAudio } from "@/lib/nle/audio";
import { fadeAt, lengthOf, type NleItem, type NleTimeline } from "@/lib/nle/model";
import { drawScale, picturesAt, picturesSoon, placement, soundPieces, sourceTime, steer, type SoundPiece } from "@/lib/nle/picture";
import { localFileState, pathLine } from "@/lib/local-files";
import { drawnAsShot, lookFilter, shotPlan, shotSource, shotTime, type Pic, type ShotOp } from "@/lib/nle/shot";

// The editor's viewer: the timeline played live from its source files. Every picture at the playhead is drawn on a
// canvas the timeline's shape (in timeline units, at the size it is shown), V1 at the bottom, each with its transform,
// crop and opacity, and a shot-list edit's V1 shots with their frame size, blurred fill, split rows and smooth zoom, as the renderer draws them (lib/nle/shot.ts);
// the sound tracks play through Web Audio with each clip's gain. One <video> per picture on screen (and the ones about to
// start, so they are ready), kept on the timeline's clock: seeked when paused, played at the clip's speed and put back
// when they drift; a card made as numbered pictures shows its picture for the frame. A clip's fades ramp its picture's
// opacity (black under V1) and its sound's gain. A clip whose file can't play here is a red Media Offline frame with its
// name and why, never an older render. A picture not ready yet (a file opening, a move landing) keeps the frame drawn
// last on screen, never black.

type Media = {
  el: HTMLVideoElement | HTMLImageElement;
  url: string;
  lead: number;
  bad: boolean;
  used: number;
  /** why it doesn't play, once the Mac app said (a drive away, a folder not allowed) */
  why?: string;
  /** a numbered picture sequence: its pictures by number, loaded ahead of the playhead */
  seq?: { frame: (n: number) => string; got: Map<number, HTMLImageElement> };
};

/** A source's file as this browser plays it; `lead`: seconds into the file where the source's frame 0 is; `frame`: the
 *  file of picture n when the source is a numbered picture sequence (from 0). `why`, with no `url`: it doesn't play here,
 *  and this is the line drawn on its frame ("<drive> isn't connected", "Needs your OK"). */
export type NleFile = { url: string; lead?: number; frame?: (n: number) => string; why?: string };

/** The line for a Mac file that didn't load, from the Mac app's answer (HTTP 409 disk_away, 403 not allowed). */
export async function whyNot(url: string): Promise<string | undefined> {
  return url.startsWith("ctlocal://media/") ? pathLine(await localFileState(url)) : undefined;
}

/** frames (about a second) the last picture is kept while one on screen isn't ready; then drawn without it */
const HOLD = 60;
const SEQ_AHEAD = 8;
const isImage = (url: string) => /\.(png|jpe?g|webp|gif)(\?|$)/i.test(url);
type Drawable = { el: CanvasImageSource; w: number; h: number };
const canFilter = typeof CanvasRenderingContext2D !== "undefined" && "filter" in CanvasRenderingContext2D.prototype;

export function NlePlayer({ tl, time, playing, rate, urlOf, nameOf, className, loop }: {
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
  /** looping playback's part, seconds: the pictures where it wraps to are opened ahead, so the jump back shows at once */
  loop?: [number, number] | null;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const pool = useRef(new Map<string, Media>());
  const now = useRef({ tl, time, playing, rate, urlOf, nameOf, loop });
  now.current = { tl, time, playing, rate, urlOf, nameOf, loop };
  const W = tl.timeline.width || 1080;
  const H = tl.timeline.height || 1920;

  useEffect(() => {
    let raf = 0;
    let tick = 0;
    let painted = 0;
    // drawn at the size shown (CSS px × the screen's), never the timeline's 8 MP when it is shown small
    let px = 1;
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(([e]) => void (px = drawScale(e.contentRect.width, devicePixelRatio, W)));
    if (canvas.current) ro?.observe(canvas.current);
    // a shot is composed here first, then its zoom drawn onto the viewer; a blurred fill is made small here
    const layer = document.createElement("canvas");
    const small = document.createElement("canvas");
    const media = (k: string, src: string): Media | null => {
      const file = now.current.urlOf(src);
      if (!file?.url) return null;
      const u = file.url;
      let m = pool.current.get(k);
      if (m && m.url !== u) {
        drop(k);
        m = undefined;
      }
      if (!m) {
        const el = file.frame || isImage(u) ? new Image() : Object.assign(document.createElement("video"), { muted: true, playsInline: true, preload: "auto" });
        const made: Media = { el, url: u, lead: file.lead ?? 0, bad: false, used: tick, ...(file.frame ? { seq: { frame: file.frame, got: new Map() } } : {}) };
        el.addEventListener("error", () => {
          made.bad = true;
          void whyNot(u).then((why) => void (made.why = why));
        });
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
    const keep = (el: HTMLVideoElement, want: number, run: boolean, speed: number, fps = 25) => {
      if (el.readyState < 1) return;
      if (run) {
        const go = steer(el.currentTime - want, Math.min(16, Math.max(0.0625, speed)), fps);
        if (Math.abs(el.playbackRate - go.rate) > 0.005) el.playbackRate = go.rate;
        if (el.paused) void el.play().catch(() => {});
        if (go.seek && !el.seeking) el.currentTime = want;
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
        keep(el, secs + m.lead, run, speed, fps);
        return el.readyState >= 2 && el.videoWidth ? { el, w: el.videoWidth, h: el.videoHeight } : null;
      }
      return el.complete && el.naturalWidth ? { el, w: el.naturalWidth, h: el.naturalHeight } : null;
    };
    // a picture with no file here: Resolve's red Media Offline frame where the picture would be (as if it were the
    // frame's size), with the clip's name and why
    const missing = (ctx: CanvasRenderingContext2D, it: NleItem, track: string, name: string, why?: string) => {
      const p = placement(it, track, W, H, W, H);
      ctx.save();
      ctx.transform(...p.m);
      ctx.fillStyle = "#8f1414";
      ctx.fillRect(...p.crop);
      ctx.setTransform(px, 0, 0, px, 0, 0);
      const [cx, cy] = [p.m[0] * (W / 2) + p.m[2] * (H / 2) + p.m[4], p.m[1] * (W / 2) + p.m[3] * (H / 2) + p.m[5]];
      ctx.fillStyle = "#fff";
      ctx.textAlign = "center";
      ctx.font = `600 ${Math.round(W / 14)}px system-ui, sans-serif`;
      ctx.fillText("Media Offline", cx, cy, W * 0.9);
      ctx.font = `${Math.round(W / 30)}px system-ui, sans-serif`;
      ctx.fillStyle = "#fecaca";
      ctx.fillText(name, cx, cy + W / 14, W * 0.9);
      if (why) ctx.fillText(why, cx, cy + W / 8, W * 0.9);
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
      const cv = canvas.current!;
      const [cw, ch] = [Math.max(1, Math.round(W * px)), Math.max(1, Math.round(H * px))];
      if (cv.width !== cw || cv.height !== ch) {
        Object.assign(cv, { width: cw, height: ch });
        Object.assign(layer, { width: cw, height: ch });
        painted = 0;
      }
      // what is on screen now: each picture's file and frame (a shot's other pictures too), before anything is drawn
      const pics = on.map(({ item, track }) => {
        const key = item._k ?? `${item.src}:${item.rec}`;
        const k = f - item.rec;
        if (item.fx === "flash") return { item, track, key, k, m: null, d: null, got: null };
        const v1 = track === "V1";
        // V1 plays a freeze held and a reversed shot backwards (seeked frame by frame); the other tracks as they are
        const still = v1 && (!!item.freeze || !!item.rev);
        const own = v1 ? shotTime(item, "main", k, fps, srcFps) : sourceTime(t, item, s);
        const m = media(key, item.src);
        live.add(key);
        const d = m && !m.bad ? pictureOf(m, own, srcFps(item.src), forward && !still, (item.speed || 1) * r) : null;
        // the shot's other pictures: the shot before under an inset, the split rows; each plays on from its own frame
        const got: Partial<Record<Pic, Drawable>> = d ? { main: d } : {};
        if (d && drawnAsShot(item, track, W, H)) {
          for (const pic of ["under", 1, 2] as const) {
            const src = shotSource(item, pic);
            if (!src) continue;
            const pk = `${key}:${pic}`;
            const pm = media(pk, src);
            live.add(pk);
            const pd = pm && !pm.bad ? pictureOf(pm, shotTime(item, pic, k, fps, srcFps), srcFps(src), forward, r) : null;
            if (pd) got[pic] = pd;
          }
        }
        return { item, track, key, k, m, d, got };
      });
      // one not ready (opening, a move landing): the last frame stays on screen, as it was
      const waiting = pics.some((p) => p.m && !p.m.bad && !p.d);
      if (!waiting || !painted || tick - painted >= HOLD) {
        painted = tick;
        const flashes: number[] = [];
        ctx.setTransform(px, 0, 0, px, 0, 0);
        ctx.globalAlpha = 1;
        // a gap in the cut is black; past its last clip there is no picture, only the frame's edge on the pasteboard
        ctx.fillStyle = "#000";
        if (f < lengthOf(t)) ctx.fillRect(0, 0, W, H);
        else ctx.clearRect(0, 0, W, H);
        for (const { item, track, k, m, d, got } of pics) {
          // the fades: how much of the picture shows now (what is under it, or black, shows through)
          const fade = fadeAt(item, s * fps - item.rec);
          if (item.fx === "flash") {
            // a designed white flash, fading as its file does (drawn over everything, as the renderer does)
            flashes.push(1 - (item.in + k) / Math.max(Number(t.sources[item.src]?.dur) || item.len, 1));
            continue;
          }
          if (!m || m.bad) {
            const why = m?.why ?? now.current.urlOf(item.src)?.why;
            missing(ctx, item, track, name(item.src), why ?? (m ? "This file won't play here" : undefined));
            continue;
          }
          if (!d || !got) continue;
          if (drawnAsShot(item, track, W, H)) {
            const plan = shotPlan(item, k, (pic) => (got[pic] ? [got[pic]!.w, got[pic]!.h] : null), W, H);
            const lc = layer.getContext("2d")!;
            lc.setTransform(px, 0, 0, px, 0, 0);
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
            ctx.globalAlpha = fade;
            // the filter's blur is in the canvas's own px
            const look = canFilter ? lookFilter(item, k, W * px) : "";
            if (look) ctx.filter = look;
            const [vx, vy, vw, vh] = plan.view;
            ctx.drawImage(layer, vx * px, vy * px, vw * px, vh * px, 0, 0, W, H);
            ctx.restore();
            continue;
          }
          const p = placement(item, track, d.w, d.h, W, H);
          if (p.crop[2] <= 0 || p.crop[3] <= 0 || !p.alpha || !fade) continue;
          ctx.save();
          ctx.globalAlpha = p.alpha * fade;
          ctx.transform(...p.m);
          ctx.drawImage(d.el, ...p.crop, ...p.crop);
          ctx.restore();
        }
        for (const a of flashes) {
          ctx.fillStyle = `rgba(255,255,255,${Math.min(1, Math.max(0, a))})`;
          ctx.fillRect(0, 0, W, H);
        }
      }
      // the clips about to start: their files open and waiting on their first frame
      if (forward || !run) {
        for (const { item, track } of picturesSoon(t, f, 2 * fps)) {
          if (item.fx === "flash") continue;
          const key = item._k ?? `${item.src}:${item.rec}`;
          const m = media(key, item.src);
          live.add(key);
          const at = track === "V1" ? shotTime(item, "main", 0, fps, srcFps) : sourceTime(t, item, item.rec / fps);
          if (m && !m.seq && m.el instanceof HTMLVideoElement) keep(m.el, at + m.lead, false, 1);
        }
      }
      // near a loop's end: the pictures at the other end open and waiting there (a clip playing now and there too is
      // seeked at the wrap: one file can't wait in two places)
      const lp = now.current.loop;
      if (run && lp && (r > 0 ? lp[1] - s : s - lp[0]) < 2) {
        const to = r > 0 ? lp[0] : lp[1] - 1 / fps;
        const tf = Math.max(0, Math.floor(to * fps + 1e-6));
        for (const { item, track } of picturesAt(t, tf)) {
          const key = item._k ?? `${item.src}:${item.rec}`;
          if (item.fx === "flash" || live.has(key)) continue;
          const m = media(key, item.src);
          live.add(key);
          const at = track === "V1" ? shotTime(item, "main", tf - item.rec, fps, srcFps) : sourceTime(t, item, to);
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
      ro?.disconnect();
      for (const k of [...all.keys()]) drop(k);
    };
  }, [W, H]);

  useNleSound(tl, time, playing, rate, urlOf);

  return <canvas ref={canvas} className={className} style={{ aspectRatio: `${W} / ${H}` }} />;
}

const buffers = new Map<string, Promise<{ buf: AudioBuffer; from: number }>>();

/** The sound tracks on the timeline's clock: laid from the playhead on play, again after a seek, a change or a drift. */
function useNleSound(tl: NleTimeline, time: number, playing: boolean, rate: number, urlOf: (src: string) => NleFile | null) {
  const pieces = useMemo(() => soundPieces(tl).flatMap((p): (SoundPiece & { url: string })[] => {
    const f = urlOf(p.src);
    return f?.url ? [{ ...p, url: f.url, offset: p.offset + (f.lead ?? 0) }] : [];
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
        ramp(g, p, a, late);
        src.connect(g).connect(ctx.destination);
        src.start(Math.max(ctx.currentTime, a.at + Math.max(0, p.at - a.t) / rate), offset, Math.min(dur, buf.duration - offset));
        state.current.nodes.push(src);
      }, () => {});
    }
  };

  // the clip's gain, up from silence over its fade in and down over its fade out, on the engine's clock
  const ramp = (g: GainNode, p: SoundPiece, a: { t: number; at: number }, late: number) => {
    const [first, ...rest] = fadePoints(p, a.at + (p.at - a.t) / rate, late, rate);
    g.gain.setValueAtTime(first[1], first[0]);
    for (const [t, v] of rest) g.gain.linearRampToValueAtTime(v, t);
  };

  // a clip at another speed keeps its pitch, as the render's (a media element stretches its sound; a buffer can't)
  const stretched = (ctx: AudioContext, p: SoundPiece & { url: string }, gen: number) => {
    const a = state.current.anchor!;
    const el = Object.assign(new Audio(), { crossOrigin: "anonymous", preload: "auto", preservesPitch: true, src: p.url });
    const g = ctx.createGain();
    const late = Math.max(0, a.t - p.at);
    ramp(g, p, a, late);
    ctx.createMediaElementSource(el).connect(g).connect(ctx.destination);
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
