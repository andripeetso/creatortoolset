import { useEffect, useMemo, useRef } from "react";
import { glStage, type GlStage, type Look, type Painter } from "@/lib/nle/gl-stage";
import { gradeOf, hasLook, lutOf } from "@/lib/nle/looks";
import type { EdjCamera } from "@contracts/editor";
import { readSound } from "@/lib/synced-sound";
import { fadePoints, isSoundFile, nleAudio, nleOut, runningAudio, type NleClock } from "@/lib/nle/audio";
import { lengthOf, type NleItem, type NleTimeline } from "@/lib/nle/model";
import { chains, drawScale, envPoints, keyed, keyOf, pickSlot, picturesAt, picturesSoon, placement, plainVideo, soundPieces, sourceTime, spanOf, steer, type SoundPiece } from "@/lib/nle/picture";
import { localFileState, pathLine } from "@/lib/local-files";
import { drawnAsShot, lookFilter, shotPlan, shotSource, shotTime, type Pic, type ShotOp } from "@/lib/nle/shot";

// The editor's viewer: the timeline played live from its source files. Every picture at the playhead is drawn on a
// canvas the timeline's shape (in timeline units, at the size it is shown), V1 at the bottom, each with its transform,
// crop and opacity, and a shot-list edit's V1 shots with their frame size, blurred fill, split rows and smooth zoom, as the renderer draws them (lib/nle/shot.ts);
// the sound tracks play through Web Audio with each clip's gain. Everything follows one clock (lib/nle/audio.ts NleClock):
// the sound engine's time while sound plays. Play waits for the pictures at the playhead (at most half a second) before
// the clock starts. Each file has at most two <video> elements, one playing and one waiting on the next clip's first
// frame, and a clip that plays on from the one before it in the same file keeps its element across the cut (no seek);
// at most MAX_VIDEOS are open at once. A video is played at the clip's speed and its speed bent when it drifts; the canvas
// is drawn only when a picture changed (requestVideoFrameCallback) or the playhead moved. A card made as numbered
// pictures shows its picture for the frame. A clip's keys move its picture and its gain frame by frame; its fades ramp
// its picture's opacity (black under V1) and its sound's gain; a transition plays both clips of its cut, each into its
// handle and from its own element, mixed as the renderer mixes them (picture.ts seenAt), so never as the plain <video>. A clip whose file can't play here is a red Media Offline frame with its name and why, never an older render. A
// picture not ready yet (a file opening, a move landing) keeps the frame drawn last on screen, never black.
// The pictures are drawn on the graphics card (lib/nle/gl-stage.ts: a video frame there costs about 1 ms, on a 2D canvas
// 8–31 ms), with each source's camera conversion and each clip's grade, and the scopes read from there; where WebGL 2
// is missing or its context is lost, the same calls draw on a 2D canvas, without the colour changes or the scopes.

type Media = {
  el: HTMLVideoElement | HTMLImageElement;
  url: string;
  lead: number;
  bad: boolean;
  used: number;
  /** the run of clips (picture.ts chains) this element plays now */
  owner: string;
  /** frames the element has shown (requestVideoFrameCallback), and whether it tells them at all */
  frames: number;
  vfc: boolean;
  gone?: boolean;
  /** why it doesn't play, once the Mac app or server said (a drive away, a folder not allowed, proxy not ready) */
  why?: string;
  /** true while the library is generating a proxy for this clip */
  preparing?: boolean;
  /** a numbered picture sequence: its pictures by number, loaded ahead of the playhead */
  seq?: { frame: (n: number) => string; got: Map<number, HTMLImageElement> };
};

/** A source's file as this browser plays it; `lead`: seconds into the file where the source's frame 0 is; `frame`: the
 *  file of picture n when the source is a numbered picture sequence (from 0). `why`, with no `url`: it doesn't play here,
 *  and this is the line drawn on its frame ("<drive> isn't connected", "Needs your OK"). `preparing`: a proxy is being
 *  made now, so a failed <video> shows a calm dark progress card instead of the red Media Offline alarm. `log`: whether
 *  the file is in its camera's log. Not said = the file as filmed (an original, today's proxies and blurred masters,
 *  which keep the log), so the source's camera conversion applies; a file already converted (a 709 proxy or render) must
 *  say false, or it is converted twice. */
export type NleFile = { url: string; lead?: number; frame?: (n: number) => string; why?: string; preparing?: boolean; log?: boolean;
  /** what it shows may be drawn into a design (Design on This Frame): a blurred copy, the person's own file, a design */
  grab?: true;
  /** a sound heard as a blend of two files of one recording, lined up sample for sample (a voice as recorded and its
   *  cleaned version): `url` at 1 − share of the clip's gain, this one at `share` */
  mix?: { url: string; share: number } };

const LIBRARY_PLAY = /^\/api\/library\/media\/[^/?#]+\/play(?:[?#]|$)/;

/** The line for a clip that didn't load: a Mac file asks the Mac app (409 disk_away, 403 not allowed); a library `/play`
 *  URL does a 1-byte range request so 409 reasons and codec failures surface instead of a generic error. */
export async function whyNot(url: string): Promise<string | undefined> {
  if (url.startsWith("ctlocal://media/")) return pathLine(await localFileState(url));
  if (!LIBRARY_PLAY.test(url)) return undefined;
  try {
    const r = await fetch(url, { headers: { Range: "bytes=0-0" } });
    if (r.status === 200 || r.status === 206) {
      void r.body?.cancel?.();
      return "This format needs a proxy to play here";
    }
    if (r.status === 409) {
      const body = (await r.json().catch(() => null)) as { error?: string; message?: string; code?: string } | null;
      if (!body) return undefined;
      if (body.code === "conflict" || body.error === "Not ready") return "Proxy isn't ready yet";
      return body.error || body.message || undefined;
    }
    if (r.status === 404) return "Clip not found";
    return undefined;
  } catch {
    return undefined;
  }
}

const SEQ_AHEAD = 8;
/** the scopes' size in px (as GradePanel's) */
export const SCOPE_W = 340;
export const SCOPE_H = 170;
/** 4K decoders open at once at most (a run of short clips used to open a dozen) */
const MAX_VIDEOS = 6;
/** elements per file: the one playing and the one waiting on the next clip's first frame */
const PER_FILE = 2;
const isImage = (url: string) => /\.(png|jpe?g|webp|gif)(\?|$)/i.test(url);
type Drawable = { el: CanvasImageSource; w: number; h: number };
type Vfc = HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number };
const canFilter = typeof CanvasRenderingContext2D !== "undefined" && "filter" in CanvasRenderingContext2D.prototype;
const chainsOf = new WeakMap<NleTimeline, Map<string, string>>();
const chainOf = (tl: NleTimeline) => {
  let c = chainsOf.get(tl);
  if (!c) chainsOf.set(tl, (c = chains(tl)));
  return c;
};

/** Whether a picture at the playhead is ready for the clock to start (a <video> with its frame there and more coming). */
const readyToPlay = (m: Media | null, d: Drawable | null) =>
  !m || m.bad || (m.el instanceof HTMLVideoElement ? m.el.readyState >= 3 && !m.el.seeking : !!d);

export function NlePlayer({ tl, clock, rate, urlOf, nameOf, className, loop, onScopes }: {
  tl: NleTimeline;
  /** the playhead (seconds on the timeline) and whether it runs */
  clock: NleClock;
  /** the J / K / L speed: < 0 plays backwards (picture only) */
  rate: number;
  /** a source's file as the browser plays it; null when it has none here */
  /** `clip`: a sound clip's key, when it asks (its own processing can pick another file of its source) */
  urlOf: (src: string, clip?: string) => NleFile | null;
  nameOf: (src: string) => string;
  className?: string;
  /** looping playback's part, seconds: the pictures where it wraps to are opened ahead, so the jump back shows at once */
  loop?: [number, number] | null;
  /** when set, the scopes of new pictures (SCOPE_W × SCOPE_H, about 10 a second while playing): the waveform and the
   *  vectorscope; nulls when the graphics card can't make them here (no WebGL 2, or a picture it may not read) */
  onScopes?: ((wave: ImageData | null, vector: ImageData | null) => void) | null;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const pool = useRef(new Map<string, Media>());
  const now = useRef({ tl, clock, rate, urlOf, nameOf, loop, onScopes });
  now.current = { tl, clock, rate, urlOf, nameOf, loop, onScopes };
  const W = tl.timeline.width || 1080;
  const H = tl.timeline.height || 1920;

  useEffect(() => {
    let raf = 0;
    let tick = 0;
    let made = 0;
    let painted = false;
    // what was drawn last: the canvas is drawn again only when this changes (a new frame, the playhead, an edit)
    let drawn = "";
    let drawnTl: NleTimeline | null = null;
    // the <video> shown as it is over the canvas (one plain picture), if any
    let shown: HTMLVideoElement | null = null;
    const show = (el: HTMLVideoElement, fit: "cover" | "contain") => {
      if (el.parentElement !== host.current) {
        Object.assign(el.style, { position: "absolute", inset: "0", width: "100%", height: "100%", background: "#000" });
        host.current?.appendChild(el);
      }
      el.style.objectFit = fit;
      el.style.visibility = "visible";
      if (shown && shown !== el) shown.style.visibility = "hidden";
      shown = el;
    };
    const unshow = () => {
      // hidden, not taken out: a <video> taken out of the page pauses, and it may play on under the canvas
      if (shown) shown.style.visibility = "hidden";
      shown = null;
    };
    // the elements a picture wants on this frame (none of them is handed to another)
    const claimed = new Set<Media>();
    // drawn at the size shown (CSS px × the screen's), never the timeline's 8 MP when it is shown small
    let px = 1;
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(([e]) => void (px = drawScale(e.contentRect.width, devicePixelRatio, W)));
    if (canvas.current) ro?.observe(canvas.current);
    // a shot is composed here first, then its zoom drawn onto the viewer; a blurred fill is made small here (2D)
    const layer = document.createElement("canvas");
    const small = document.createElement("canvas");
    // the Media Offline lines, drawn as text here and laid on the graphics stage
    const note = document.createElement("canvas");
    let stage: GlStage | null = glStage();
    const toStage = (on: boolean) => {
      if (stage && on) {
        Object.assign(stage.canvas.style, { position: "absolute", inset: "0", width: "100%", height: "100%" });
        host.current?.prepend(stage.canvas);
      } else stage?.canvas.remove();
      if (canvas.current) canvas.current.style.visibility = on && stage ? "hidden" : "";
    };
    toStage(true);
    const videos = () => [...pool.current.values()].filter((m) => m.el instanceof HTMLVideoElement);
    const make = (u: string, file: NleFile, el: Media["el"], owner: string): Media => {
      const m: Media = { el, url: u, lead: file.lead ?? 0, bad: false, used: tick, owner, frames: 0, vfc: false, preparing: !!file.preparing, ...(file.frame ? { seq: { frame: file.frame, got: new Map() } } : {}) };
      el.addEventListener("error", () => {
        m.bad = true;
        void whyNot(u).then((why) => void (m.why = why));
      });
      const v = el as Vfc;
      if (v instanceof HTMLVideoElement && v.requestVideoFrameCallback) {
        const seen = () => {
          m.frames++;
          m.vfc = true;
          if (!m.gone) v.requestVideoFrameCallback!(seen);
        };
        v.requestVideoFrameCallback(seen);
      }
      // read by the graphics stage and back from the viewer for Design on This Frame: a file from another origin only with
      // CORS (the Mac app's files and the server's answer it, as for the sound)
      el.crossOrigin = "anonymous";
      el.src = file.frame ? file.frame(0) : u;
      return m;
    };
    const drop = (k: string) => {
      const m = pool.current.get(k);
      if (!m) return;
      m.gone = true;
      stage?.forget(m.el);
      if (m.el instanceof HTMLVideoElement) {
        if (m.el === shown) shown = null;
        m.el.remove();
        m.el.pause();
        m.el.removeAttribute("src");
        m.el.load();
      }
      pool.current.delete(k);
    };
    /** the idle elements let go, longest unused first, until fewer than `max` videos are open; false when none could go */
    const trim = (max: number) => {
      const idle = [...pool.current].filter(([, m]) => m.el instanceof HTMLVideoElement && !claimed.has(m) && m.el !== shown).sort((a, b) => a[1].used - b[1].used);
      while (videos().length >= max && idle.length) drop(idle.shift()![0]);
      return videos().length < max;
    };
    /** The element a run of clips (`owner`) shows `src` from. `urgent`: on screen now (always one); else (a clip about to
     *  start) only when its file has a free one and the cap allows. */
    const media = (owner: string, src: string, urgent: boolean): Media | null => {
      const file = now.current.urlOf(src);
      if (!file?.url) return null;
      const u = file.url;
      let m: Media | undefined;
      if (file.frame || isImage(u)) {
        m = pool.current.get(u);
        if (!m) pool.current.set(u, (m = make(u, file, new Image(), owner)));
      } else {
        const mine = videos().filter((x) => x.url === u);
        // the <video> held on screen while the next one opens is never moved for another clip
        const i = pickSlot(mine.map((x) => ({ owner: x.owner, used: x.used, busy: claimed.has(x) || x.el === shown })), owner, PER_FILE);
        if (i !== null && i >= 0) m = mine[i];
        else if (i === -1 || urgent) {
          if (!trim(MAX_VIDEOS) && !urgent) return null;
          const el = Object.assign(document.createElement("video"), { muted: true, playsInline: true, preload: "auto" });
          pool.current.set(`${u}#${++made}`, (m = make(u, file, el, owner)));
        } else return null;
        m.owner = owner;
        m.lead = file.lead ?? 0;
      }
      m.preparing = !!file.preparing;
      m.used = tick;
      claimed.add(m);
      return m;
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
          const img = Object.assign(new Image(), { crossOrigin: "anonymous" });
          img.src = frame(i);
          got.set(i, img);
        }
        for (const [i, img] of got) if (i < n - 2 || i > n + 4 * SEQ_AHEAD) {
          stage?.forget(img);
          got.delete(i);
        }
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
    /** what a picture shows now, for knowing whether to draw again: its frame count, else its time or image */
    const stamp = (m: Media | null, d: Drawable | null) =>
      !m ? "x" : m.bad ? `bad${m.preparing ? "!" : ""}${m.why ?? ""}` : !d ? "-" : m.el instanceof HTMLVideoElement ? `${m.vfc ? `f${m.frames}` : `t${m.el.currentTime}`}${m.el.seeking ? "s" : ""}${m.el.readyState}` : (d.el as HTMLImageElement).src;
    // a picture with no file here: red Media Offline frame with name and why, or a calm dark card while a proxy is being made
    const missing = (ctx: CanvasRenderingContext2D, it: NleItem, track: string, name: string, why?: string, preparing = false) => {
      if (stage) {
        // as text on a 2D canvas the frame's size, then laid on the stage as a picture
        const [cw, ch] = [Math.max(1, Math.round(W * px)), Math.max(1, Math.round(H * px))];
        if (note.width !== cw || note.height !== ch) Object.assign(note, { width: cw, height: ch });
        const n = note.getContext("2d")!;
        n.setTransform(px, 0, 0, px, 0, 0);
        n.clearRect(0, 0, W, H);
        drawMissing(n, it, track, name, why, preparing);
        stage.screen.save();
        stage.screen.setTransform(1, 0, 0, 1, 0, 0);
        stage.screen.drawImage(note, 0, 0, cw, ch, 0, 0, cw, ch);
        stage.screen.restore();
      } else drawMissing(ctx, it, track, name, why, preparing);
    };
    const drawMissing = (ctx: CanvasRenderingContext2D, it: NleItem, track: string, name: string, why?: string, preparing = false) => {
      const p = placement(it, track, W, H, W, H);
      ctx.save();
      ctx.transform(...p.m);
      ctx.fillStyle = preparing ? "#18181b" : "#8f1414";
      ctx.fillRect(...p.crop);
      ctx.setTransform(px, 0, 0, px, 0, 0);
      const [cx, cy] = [p.m[0] * (W / 2) + p.m[2] * (H / 2) + p.m[4], p.m[1] * (W / 2) + p.m[3] * (H / 2) + p.m[5]];
      ctx.fillStyle = preparing ? "#f4f4f5" : "#fff";
      ctx.textAlign = "center";
      ctx.font = `600 ${Math.round(W / 14)}px system-ui, sans-serif`;
      ctx.fillText(preparing ? "Making a proxy…" : "Media Offline", cx, cy, W * 0.9);
      ctx.font = `${Math.round(W / 30)}px system-ui, sans-serif`;
      ctx.fillStyle = preparing ? "#a1a1aa" : "#fecaca";
      ctx.fillText(name, cx, cy + W / 14, W * 0.9);
      if (why) ctx.fillText(why, cx, cy + W / 8, W * 0.9);
      ctx.restore();
    };
    /** A darkened blur of a picture behind a shot (the renderer's: an eighth of the size, blurred, darkened, scaled up). */
    const blurred = (lc: Painter, d: Drawable, op: ShotOp) => {
      const { w, h, sigma, dim } = op.bg!;
      // darker by a fixed amount, as the renderer's brightness: 1 − ((1 − x) + d)
      const by = Math.round(dim * 327);
      if (stage) return stage.layer.blurFill(d.el, op.src, w, h, sigma, by / 255, op.dst);
      small.width = w;
      small.height = h;
      const s = small.getContext("2d")!;
      s.drawImage(d.el, ...op.src, 0, 0, w, h); // under the blur: its edges stay filled where the blur thins out
      if (canFilter) {
        s.filter = `blur(${sigma}px)`;
        s.drawImage(d.el, ...op.src, 0, 0, w, h);
        s.filter = "none";
      }
      for (const [mode, fill] of [["difference", "#fff"], ["lighter", `rgb(${by},${by},${by})`], ["difference", "#fff"]] as const) {
        s.globalCompositeOperation = mode;
        s.fillStyle = fill;
        s.fillRect(0, 0, w, h);
      }
      s.globalCompositeOperation = "source-over";
      lc.drawImage(small, 0, 0, w, h, ...op.dst);
    };
    // the colour change on a clip's picture (looks.ts), kept per timeline and files; a LUT still loading isn't kept, and
    // draws again once it is here
    let looks = new Map<string, Look | null>();
    let looksOf: [NleTimeline, unknown] | null = null;
    const lookOf = (t: NleTimeline, key: string, src: string, grade: unknown): Look | null => {
      if (looksOf?.[0] !== t || looksOf[1] !== now.current.urlOf) [looks, looksOf] = [new Map(), [t, now.current.urlOf]];
      if (looks.has(key)) return looks.get(key)!;
      const file = now.current.urlOf(src);
      const cam = t.sources[src]?.camera as EdjCamera | undefined;
      const want = hasLook(cam, file?.log, grade);
      const lut = want && file?.log !== false ? lutOf(cam, () => void ((looks = new Map()), (painted = false))) : null;
      const look = want ? { lut, grade: gradeOf(grade) } : null;
      if (!(want && cam?.on && file?.log !== false && !lut)) looks.set(key, look);
      return look;
    };
    // a lost context (the card was reset): the 2D way meanwhile, the stage again when the canvas says it is back or
    // after a wait that doubles up to 30 s
    let retryAt = 0;
    let backoff = 1000;
    let old: GlStage | null = null;
    const retrySoon = () => void (retryAt = 1);
    let scopedAt = 0;
    let sized = "";
    const frame = () => {
      raf = requestAnimationFrame(frame);
      tick++;
      claimed.clear();
      if (stage?.lost) {
        toStage(false);
        if (stage.tainted) stage.dispose(); // for good: a picture the card may not read
        else {
          old = stage;
          old.canvas.addEventListener("webglcontextrestored", retrySoon, { once: true });
          retryAt = performance.now() + backoff;
        }
        stage = null;
        painted = false;
      }
      if (!stage && retryAt && performance.now() >= retryAt) {
        old?.dispose();
        old = null;
        stage = glStage();
        backoff = Math.min(2 * backoff, 30_000);
        retryAt = stage ? 0 : performance.now() + backoff;
        if (stage) {
          toStage(true);
          painted = false;
        }
      }
      const cv = canvas.current;
      const ctx: Painter | null = stage ? stage.screen : (cv?.getContext("2d") ?? null);
      if (!cv || !ctx) return;
      const { tl: t, clock: c, rate: r, nameOf: name, onScopes } = now.current;
      const scope = !!onScopes;
      const s = c.now();
      const run = c.state === "running";
      const fps = t.timeline.fps;
      const srcFps = (src: string) => t.sources[src]?.fps || fps;
      const f = Math.floor(s * fps + 1e-6);
      const chain = chainOf(t);
      const on = picturesAt(t, f);
      const forward = run && r > 0;
      const [cw, ch] = [Math.max(1, Math.round(W * px)), Math.max(1, Math.round(H * px))];
      if (sized !== `${cw}x${ch}${!stage}`) {
        sized = `${cw}x${ch}${!stage}`;
        // the 2D canvases hold a picture only when they draw (no graphics stage)
        if (!stage) {
          Object.assign(cv, { width: cw, height: ch });
          Object.assign(layer, { width: cw, height: ch });
        }
        painted = false;
      }
      // what is on screen now: each picture's file and frame (a shot's other pictures too), before anything is drawn
      const pics = on.map(({ item: raw, track, seen = 1, under }) => {
        const key = keyOf(raw);
        // its zoom, pan, tilt, rotation and opacity on this frame
        const item = keyed(t, raw, f);
        const k = f - item.rec;
        if (item.fx === "flash") return { item, track, key, k, seen, under, m: null, d: null, got: null, look: null };
        const v1 = track === "V1";
        // V1 plays a freeze held and a reversed shot backwards (seeked frame by frame); the other tracks as they are
        const still = v1 && (!!item.freeze || !!item.rev);
        const own = v1 ? shotTime(item, "main", k, fps, srcFps) : sourceTime(t, item, s);
        const m = media(chain.get(key) ?? key, item.src, true);
        const d = m && !m.bad ? pictureOf(m, own, srcFps(item.src), forward && !still, (item.speed || 1) * r) : null;
        // the shot's other pictures: the shot before under an inset, the split rows; each plays on from its own frame
        const got: Partial<Record<Pic, Drawable>> = d ? { main: d } : {};
        let more = "";
        if (d && drawnAsShot(item, track, W, H)) {
          for (const pic of ["under", 1, 2] as const) {
            const src = shotSource(item, pic);
            if (!src) continue;
            const pm = media(`${key}:${pic}`, src, true);
            const pd = pm && !pm.bad ? pictureOf(pm, shotTime(item, pic, k, fps, srcFps), srcFps(src), forward, r) : null;
            if (pd) got[pic] = pd;
            more += stamp(pm, pd);
          }
        }
        return { item, track, key, k, seen, under, m, d, got, more, look: lookOf(t, key, item.src, item.grade) };
      });
      // Play waits until the pictures at the playhead can play on (or the clock's half second is up)
      if (c.state === "waiting" && pics.every((p) => p.item.fx === "flash" || readyToPlay(p.m, p.d))) c.ready();
      // drawn again only for a new frame of a picture (or, with no playing video telling its frames, a new playhead
      // frame), an edit, a resize; a picture not ready (a file opening, a move landing) keeps the last frame on screen,
      // never black (a file that can't play errors, and is drawn as Media Offline)
      // keys and transitions change the picture every frame, whatever the videos do
      const told = run && pics.some((p) => p.d && p.m?.vfc) && !pics.some((p) => p.item.keys || p.under || p.seen < 1);
      const sig = `${cw}x${ch}|${told ? "" : f}|${scope}|${pics.map((p) => `${p.key}:${stamp(p.m, p.d)}${p.more ?? ""}`).join("|")}`;
      // one plain picture (picture.ts plainVideo) with its frame: its hardware-decoded <video> shown as it is, the canvas
      // not drawn; back to the canvas only once it has drawn the new picture, so a cut between the two never shows black
      const fit = plainVideo(on);
      const one = pics[0];
      // a colour change or the scopes need the picture drawn
      const direct = fit && !(stage && (one?.look || scope)) && one?.d && one.m && !one.m.seq && one.m.el instanceof HTMLVideoElement && !one.m.el.seeking ? one.m.el : null;
      if (direct) {
        show(direct, fit!);
        painted = true;
        drawn = "";
      } else if (!painted || ((t !== drawnTl || sig !== drawn) && !pics.some((p) => p.m && !p.m.bad && !p.d))) {
        painted = true;
        drawn = sig;
        drawnTl = t;
        const flashes: number[] = [];
        stage?.begin(cw, ch);
        ctx.setTransform(px, 0, 0, px, 0, 0);
        ctx.globalAlpha = 1;
        // a gap in the cut is black; past its last clip there is no picture, only the frame's edge on the pasteboard
        ctx.fillStyle = "#000";
        if (f < lengthOf(t)) ctx.fillRect(0, 0, W, H);
        else ctx.clearRect(0, 0, W, H);
        for (const { item, track, k, m, d, got, seen: fade, under, look: colour } of pics) {
          // a dip's colour over the whole frame, under the earlier clip and the later one
          if (under) {
            ctx.fillStyle = under === "white" ? "#fff" : "#000";
            ctx.fillRect(0, 0, W, H);
          }
          // `fade`: how much of the picture shows now from its fades and transitions (what is under it shows through)
          if (item.fx === "flash") {
            // a designed white flash, fading as its file does (drawn over everything, as the renderer does)
            flashes.push(1 - (item.in + k) / Math.max(Number(t.sources[item.src]?.dur) || item.len, 1));
            continue;
          }
          if (!m || m.bad) {
            const f = now.current.urlOf(item.src);
            const preparing = !!(m?.preparing || f?.preparing);
            const why = preparing ? f?.why : (m?.why ?? f?.why);
            missing(ctx as CanvasRenderingContext2D, item, track, name(item.src), why ?? (!preparing && m ? "This file won't play here" : undefined), preparing);
            continue;
          }
          if (!d || !got || !fade) continue;
          if (drawnAsShot(item, track, W, H)) {
            const plan = shotPlan(item, k, (pic) => (got[pic] ? [got[pic]!.w, got[pic]!.h] : null), W, H);
            const lc: Painter = stage ? stage.layer : layer.getContext("2d")!;
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
            const look = canFilter || stage ? lookFilter(item, k, W * px) : "";
            if (look) ctx.filter = look;
            // the camera conversion and the grade on the whole composed shot, as the renderer's _picture
            if (stage) stage.screen.look = colour;
            const [vx, vy, vw, vh] = plan.view;
            ctx.drawImage(stage ? stage.layer.token : layer, vx * px, vy * px, vw * px, vh * px, 0, 0, W, H);
            ctx.restore();
            continue;
          }
          const p = placement(item, track, d.w, d.h, W, H);
          if (p.crop[2] <= 0 || p.crop[3] <= 0 || !p.alpha || !fade) continue;
          ctx.save();
          ctx.globalAlpha = p.alpha * fade;
          ctx.transform(...p.m);
          if (stage) stage.screen.look = colour;
          ctx.drawImage(d.el, ...p.crop, ...p.crop);
          ctx.restore();
        }
        for (const a of flashes) {
          ctx.fillStyle = `rgba(255,255,255,${Math.min(1, Math.max(0, a))})`;
          ctx.fillRect(0, 0, W, H);
        }
        stage?.present();
        unshow();
        // the scopes wait for the card to finish the frame: about 10 a second while playing, every new picture else
        if (onScopes && stage && (!run || performance.now() - scopedAt >= 100)) {
          scopedAt = performance.now();
          const both = stage.scopes(SCOPE_W, SCOPE_H);
          if (both) onScopes(...both);
        } else if (onScopes && !stage && !retryAt) onScopes(null, null);
      }
      // the next clip on each track: its file open in a free element of its file, waiting on its first frame (a clip
      // that plays on from this one needs none: its element plays across the cut)
      if (forward || !run) {
        for (const { item, track } of picturesSoon(t, f, 2 * fps, chain)) {
          if (item.fx === "flash") continue;
          const key = keyOf(item);
          const m = media(chain.get(key) ?? key, item.src, false);
          // waiting on the first frame it shows: a transition into it starts before its cut (its head handle)
          const k = spanOf(t, item)[0] - item.rec;
          const at = track === "V1" ? shotTime(item, "main", k, fps, srcFps) : sourceTime(t, item, (item.rec + k) / fps);
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
          const owner = chain.get(keyOf(item)) ?? keyOf(item);
          if (item.fx === "flash" || pics.some((p) => (chain.get(p.key) ?? p.key) === owner)) continue;
          const m = media(owner, item.src, false);
          const at = track === "V1" ? shotTime(item, "main", tf - item.rec, fps, srcFps) : sourceTime(t, item, to);
          if (m && !m.seq && m.el instanceof HTMLVideoElement) keep(m.el, at + m.lead, false, 1);
        }
      }
      for (const [k, m] of pool.current) {
        if (claimed.has(m)) continue;
        if (m.el instanceof HTMLVideoElement && !m.el.paused) m.el.pause();
        // shortcut: idle files stay open for scrubbing back within MAX_VIDEOS; an LRU by memory if long timelines need it
        if (tick - m.used > 600 && m.el !== shown) drop(k);
      }
      trim(MAX_VIDEOS + 1);
    };
    raf = requestAnimationFrame(frame);
    const all = pool.current;
    return () => {
      cancelAnimationFrame(raf);
      ro?.disconnect();
      for (const k of [...all.keys()]) drop(k);
      toStage(false);
      stage?.dispose();
      old?.dispose();
    };
  }, [W, H]);

  useNleSound(tl, clock, urlOf);

  return (
    <>
      <canvas ref={canvas} className={className} style={{ aspectRatio: `${W} / ${H}` }} />
      {/* over the canvas, in the frame: the one plain picture's <video> when it shows as it is */}
      <div ref={host} aria-hidden className="pointer-events-none absolute inset-0" />
    </>
  );
}

const buffers = new Map<string, Promise<{ buf: AudioBuffer; from: number }>>();
export type Piece = SoundPiece & { url: string; owner: string };
type Voice = { el: HTMLAudioElement; url: string; owner: string; used: number; gain: GainNode; piece: string; laid: number };

/** The sound clips that play here, each with its file (a blend of two files of one recording: both, each at its share). */
export function playedPieces(tl: NleTimeline, urlOf: (src: string, clip?: string) => NleFile | null): Piece[] {
  const chain = chains(tl);
  const at = (p: Piece, k: number): Piece => ({ ...p, gain: p.gain * k, env: p.env?.map(([t, v]): [number, number] => [t, v * k]) });
  return soundPieces(tl).flatMap((p): Piece[] => {
    const f = urlOf(p.src, p.key);
    if (!f?.url) return [];
    const one = { ...p, url: f.url, offset: p.offset + (f.lead ?? 0), owner: chain.get(p.key) ?? p.key };
    return f.mix ? [at(one, 1 - f.mix.share), { ...at(one, f.mix.share), key: `${p.key}+mix`, url: f.mix.url, owner: `${one.owner}+mix` }] : [one];
  });
}

/** The pieces heard at `t` and, on each track, the next one about to start (within `ahead` s) that isn't the same run. */
function piecesNear(pieces: Piece[], t: number, ahead = 2): { p: Piece; now: boolean }[] {
  const out: { p: Piece; now: boolean }[] = [];
  const tracks = new Map<string, Piece[]>();
  for (const p of pieces) tracks.set(p.track ?? "", [...(tracks.get(p.track ?? "") ?? []), p]);
  for (const list of tracks.values()) {
    // both clips of a transition are heard at once
    const on = list.filter((p) => p.at <= t && t < p.at + p.dur);
    for (const p of on) out.push({ p, now: true });
    const next = list.filter((p) => p.at > t && p.at <= t + ahead && !on.some((o) => o.owner === p.owner)).sort((a, b) => a.at - b.at)[0];
    if (next) out.push({ p: next, now: false });
  }
  return out.sort((a, b) => Number(b.now) - Number(a.now));
}

/**
 * The sound tracks on the clock. A sound file's clips are laid from its decoded samples on the engine's clock, at each
 * start or seek (never again for drift: the clock is the engine's). A video file's sound is never read whole: it plays
 * from the file's own <audio> element (at most two per file, the next clip's waiting), routed through the engine with
 * the clip's gain and fades, kept on the clock as the pictures are.
 */
function useNleSound(tl: NleTimeline, clock: NleClock, urlOf: (src: string, clip?: string) => NleFile | null) {
  const pieces = useMemo(() => playedPieces(tl, urlOf), [tl, urlOf]);
  const live = useRef(pieces);
  live.current = pieces;
  const fps = tl.timeline.fps;
  const relay = useRef<() => void>(() => {});
  const key = JSON.stringify(pieces);
  // an edit while it plays: the sound files' clips laid again where the clock is
  useEffect(() => relay.current(), [key]);

  useEffect(() => {
    clock.sound = pieces.length > 0;
  }, [clock, pieces]);

  useEffect(() => {
    let gen = 0;
    let anchors = 0;
    let tick = 0;
    const nodes: { stop(): void; disconnect(): void }[] = [];
    const voices: Voice[] = [];
    const fromSamples = (p: Piece) => isSoundFile(p.url) && p.speed === 1;
    const stopNodes = () => {
      for (const n of nodes.splice(0)) {
        try {
          n.stop();
        } catch {
          // never started
        }
        n.disconnect();
      }
    };
    // the clip's gain, up from silence over its fade in and down over its fade out, on the engine's clock (`t0`: when
    // its first frame plays there)
    const ramp = (g: GainNode, p: Piece, t0: number, late: number) => {
      const [first, ...rest] = p.env ? envPoints(p.env, t0, late, clock.rate) : fadePoints(p, t0, late, clock.rate);
      g.gain.cancelScheduledValues(0);
      g.gain.setValueAtTime(first[1], first[0]);
      for (const [t, v] of rest) g.gain.linearRampToValueAtTime(v, t);
    };
    // the sound files' clips, laid where the clock is
    const lay = () => {
      stopNodes();
      const ctx = clock.leader;
      if (!ctx || clock.state !== "running" || clock.rate <= 0) return;
      const g0 = ++gen;
      const t = clock.now();
      for (const p of live.current) {
        if (!fromSamples(p) || p.at + p.dur <= t) continue;
        let got = buffers.get(p.url);
        if (!got) {
          got = readSound(ctx, p.url);
          got.catch(() => buffers.delete(p.url));
          buffers.set(p.url, got);
        }
        void got.then(({ buf, from }) => {
          if (gen !== g0 || clock.leader !== ctx) return;
          // laid at the clock's time now (a file that took a while to read comes in where the timeline is)
          const late = Math.max(0, clock.now() - p.at);
          const offset = p.offset + late * p.speed - from;
          const dur = (p.dur - late) * p.speed;
          if (dur <= 0 || offset < 0 || offset >= buf.duration) return;
          const src = ctx.createBufferSource();
          src.buffer = buf;
          src.playbackRate.value = p.speed * clock.rate;
          const g = ctx.createGain();
          ramp(g, p, clock.engineTimeOf(p.at), late);
          src.connect(g).connect(nleOut(ctx));
          src.start(Math.max(ctx.currentTime, clock.engineTimeOf(p.at + late)), offset, Math.min(dur, buf.duration - offset));
          nodes.push({ stop: () => src.stop(), disconnect: () => (src.disconnect(), g.disconnect()) });
        }, () => {});
      }
    };
    const dropVoice = (v: Voice) => {
      v.el.pause();
      v.el.removeAttribute("src");
      v.el.load();
      v.gain.disconnect();
      voices.splice(voices.indexOf(v), 1);
    };
    const voice = (p: Piece, urgent: boolean, busy: Set<Voice>): Voice | null => {
      const mine = voices.filter((v) => v.url === p.url);
      const i = pickSlot(mine.map((v) => ({ owner: v.owner, used: v.used, busy: busy.has(v) })), p.owner, PER_FILE);
      let v: Voice | undefined;
      if (i !== null && i >= 0) v = mine[i];
      else if (i === -1 || urgent) {
        const ctx = nleAudio();
        if (!ctx) return null;
        // routed through the engine: a file from another origin is heard only with CORS (the Mac app's files answer it)
        const el = Object.assign(new Audio(), { crossOrigin: "anonymous", preload: "auto", preservesPitch: true });
        el.src = p.url;
        const gain = ctx.createGain();
        ctx.createMediaElementSource(el).connect(gain).connect(nleOut(ctx));
        voices.push((v = { el, url: p.url, owner: p.owner, used: tick, gain, piece: "", laid: -1 }));
      } else return null;
      if (v.owner !== p.owner) Object.assign(v, { owner: p.owner, piece: "" });
      v.used = tick;
      busy.add(v);
      return v;
    };
    // the video files' sound: each element on the clock, like a picture
    const follow = (t: number) => {
      tick++;
      const run = clock.state === "running" && clock.rate > 0;
      const busy = new Set<Voice>();
      for (const { p, now } of piecesNear(live.current.filter((x) => !fromSamples(x)), t)) {
        const v = voice(p, now, busy);
        if (!v || v.el.readyState < 1) continue;
        const pos = p.offset + Math.max(0, t - p.at) * p.speed;
        if (now && run) {
          if (v.piece !== p.key || v.laid !== anchors) {
            const ctx = runningAudio()!;
            const t0 = clock.leader ? clock.engineTimeOf(p.at) : ctx.currentTime + (p.at - t) / clock.rate;
            ramp(v.gain, p, t0, Math.max(0, t - p.at));
            Object.assign(v, { piece: p.key, laid: anchors });
          }
          const go = steer(v.el.currentTime - pos, p.speed * clock.rate, fps);
          if (Math.abs(v.el.playbackRate - go.rate) > 0.005) v.el.playbackRate = go.rate;
          if (v.el.paused) void v.el.play().catch(() => {});
          if (go.seek && !v.el.seeking) v.el.currentTime = pos;
        } else {
          if (!v.el.paused) v.el.pause();
          if (Math.abs(v.el.currentTime - pos) > 0.01 && !v.el.seeking) v.el.currentTime = pos;
        }
      }
      for (const v of [...voices]) {
        if (busy.has(v)) continue;
        if (!v.el.paused) v.el.pause();
        if (tick - v.used > 600 || !live.current.some((p) => p.url === v.url)) dropVoice(v);
      }
    };
    relay.current = lay;
    const offTick = clock.subscribe(follow);
    const offAnchor = clock.onAnchor(() => {
      anchors++;
      lay();
      follow(clock.now());
    });
    return () => {
      offTick();
      offAnchor();
      gen++;
      stopNodes();
      for (const v of [...voices]) dropVoice(v);
    };
  }, [clock, fps]);
}
