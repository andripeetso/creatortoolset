import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { drawFrame, outputSize, trimOf, type CameraImage, type ScreenEvents, type ScreenLook } from "@/lib/screen-recording";
import { frameReader, type FrameReader } from "./frame-reader";

type Path = [number, number, number][];

/** The preview of the screen recording editor: the video, its picture on the canvas, and where it is in time. */
export type Player = {
  video: RefObject<HTMLVideoElement | null>;
  cam: RefObject<HTMLVideoElement | null>;
  canvas: RefObject<HTMLCanvasElement | null>;
  /** The box the canvas is fitted into. */
  stage: RefObject<HTMLDivElement | null>;
  playing: boolean;
  /** The first frame is on the canvas. */
  ready: boolean;
  /** The recording's length as the file itself reports it (0 until known). */
  mediaDuration: number;
  muted: boolean;
  setMuted: (muted: boolean) => void;
  /** Where the playhead is (the place a scrub is heading for, while the video catches up). */
  time: () => number;
  /** Called with the time whenever it moves: every painted frame while playing, every seek. */
  onTime: (listener: (t: number) => void) => () => void;
  /** Called when the picture on the canvas is a new frame of the recording. */
  onFrame: (listener: () => void) => () => void;
  seek: (t: number) => void;
  toggle: () => void;
  pause: () => void;
  /** The recording's current frame, whole, into a small canvas (the zoom's aim pad). False before the first frame. */
  drawSource: (ctx: CanvasRenderingContext2D) => boolean;
  /** Spread on the screen <video>. */
  videoProps: {
    onPlay: () => void;
    onPause: () => void;
    onSeeked: () => void;
    onLoadedData: () => void;
    onLoadedMetadata: () => void;
  };
};

const MUTED_KEY = "screen-editor-muted";
const readMuted = () => {
  try {
    return localStorage.getItem(MUTED_KEY) === "1";
  } catch {
    return false;
  }
};

/**
 * Plays the recording and paints it with its look. What keeps it light (measured in WebKit on a 3008×3130 recording,
 * where drawing the <video> itself onto a 2D canvas takes 23 to 58 ms a frame):
 * - while it plays, or while a control is being dragged, the graphics card reads the frame (frame-reader.ts, about
 *   3 ms), and only when the video shows a new one;
 * - once things have stood still for a moment, one frame is painted the careful way the export paints it, from a
 *   bitmap of the frame, so the still picture is exactly what Export makes;
 * - nothing is painted while it is paused and nothing changes;
 * - the time goes to listeners (the playhead, the clock), never through React state.
 * `o` is read through a ref, so a new look never restarts the loop.
 */
export function usePlayer(o: {
  look: ScreenLook | null;
  events: ScreenEvents | null;
  path: Path;
  duration: number;
  width: number;
  height: number;
}): Player {
  const video = useRef<HTMLVideoElement>(null);
  const cam = useRef<HTMLVideoElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const [playing, setPlaying] = useState(false);
  const [ready, setReady] = useState(false);
  const [mediaDuration, setMediaDuration] = useState(0);
  const [muted, setMutedState] = useState(readMuted);
  const live = useRef(o);
  live.current = o;

  const s = useRef({
    reader: null as FrameReader | null,
    /** The video shows a frame the reader has not taken yet. */
    fresh: true,
    takenAt: -1,
    takenWhen: 0,
    /** The frame for the careful paint, and the video time it is of. */
    frame: null as ImageBitmap | null,
    camFrame: null as ImageBitmap | null,
    frameAt: -1,
    grabbing: false,
    /** createImageBitmap is missing or refused the video: the careful paint draws the <video> itself. */
    direct: false,
    dirty: true,
    /** When the careful paint is due (0 = not owed). */
    settle: 0,
    /** The video tells us about each new frame (requestVideoFrameCallback); false = look at its clock instead. */
    frameCalls: false,
    frameCallSeen: 0,
    playedSince: 0,
    /** A seek waiting for the one in flight to land. */
    target: null as number | null,
    started: false,
    box: { w: 0, h: 0 },
    times: new Set<(t: number) => void>(),
    frames: new Set<() => void>(),
  }).current;

  const emit = useCallback((t: number) => s.times.forEach((fn) => fn(t)), [s]);

  useEffect(() => {
    s.dirty = true;
  }, [o.look, o.events, o.path, s]);

  useEffect(() => {
    let raf = 0;
    let alive = true;
    try {
      s.reader = frameReader();
    } catch {
      s.reader = null;
    }

    /** A bitmap of the frame the video is on, for the careful paint. */
    const grab = async () => {
      const v = video.current;
      if (!v || v.readyState < 2 || s.grabbing || s.direct) return;
      s.grabbing = true;
      const at = v.currentTime;
      try {
        const k = cam.current;
        const [frame, camFrame] = await Promise.all([createImageBitmap(v), k && k.readyState >= 2 ? createImageBitmap(k) : null]);
        if (!alive) {
          frame.close();
          camFrame?.close();
          return;
        }
        s.frame?.close();
        s.frame = frame;
        s.camFrame?.close();
        s.camFrame = camFrame;
        s.frameAt = at;
        s.frames.forEach((fn) => fn());
      } catch {
        s.direct = true;
      } finally {
        s.grabbing = false;
      }
    };

    const paint = (t: number, careful: boolean) => {
      const c = canvas.current;
      const v = video.current;
      const { look, events, path, width, height } = live.current;
      if (!c || !v || !look || !events || v.readyState < 2) return false;
      // the canvas: the output's shape, as large as the stage allows, in the screen's own pixels
      const out = outputSize(look.shape, width || v.videoWidth, height || v.videoHeight, false);
      const k = Math.min(s.box.w / out.width, s.box.h / out.height);
      if (!(k > 0)) return false;
      const cssW = Math.max(1, Math.floor(out.width * k));
      const cssH = Math.max(1, Math.floor(out.height * k));
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const fit = Math.min(1, 2880 / (Math.max(cssW, cssH) * dpr));
      const pw = Math.max(2, Math.round(cssW * dpr * fit));
      const ph = Math.max(2, Math.round(cssH * dpr * fit));
      if (c.width !== pw || c.height !== ph) {
        c.width = pw;
        c.height = ph;
      }
      if (c.style.width !== `${cssW}px`) c.style.width = `${cssW}px`;
      if (c.style.height !== `${cssH}px`) c.style.height = `${cssH}px`;
      const ctx = c.getContext("2d", { alpha: false });
      if (!ctx) return false;
      const camEl = cam.current;
      const liveCamera: CameraImage | null =
        camEl && camEl.readyState >= 2 ? { image: camEl, width: camEl.videoWidth, height: camEl.videoHeight } : null;
      if (careful && s.frame && !s.direct) {
        const camera: CameraImage | null = s.camFrame ? { image: s.camFrame, width: s.camFrame.width, height: s.camFrame.height } : liveCamera;
        drawFrame(ctx, s.frame, s.frame.width, s.frame.height, t, look, path, events.clicks, camera);
        return true;
      }
      const reader = s.reader;
      if (reader && s.fresh && reader.take(v)) {
        s.fresh = false;
        s.takenAt = v.currentTime;
        s.takenWhen = performance.now();
        s.frames.forEach((fn) => fn());
      }
      const W = v.videoWidth;
      const H = v.videoHeight;
      drawFrame(ctx, v, W, H, t, look, path, events.clicks, liveCamera, {
        // without the reader the video is drawn itself: carefully when it stands still, cheaply while it moves
        quality: careful ? "high" : "low",
        picture: careful || !reader ? undefined : (src, w, h) => reader.part(src, W, H, w, h),
      });
      return true;
    };

    const tick = () => {
      raf = requestAnimationFrame(tick);
      const v = video.current;
      const { look, duration } = live.current;
      if (!v || !look) return;
      const t = v.currentTime;
      const moving = !v.paused && !v.ended;
      const now = performance.now();
      if (moving) {
        if (t >= trimOf(look, duration || v.duration || 0).end) v.pause();
        const k = cam.current;
        if (k && Math.abs(k.currentTime - t) > 0.15) k.currentTime = t;
        if (!s.playedSince) s.playedSince = now;
        // no word from the video about its frames after half a second of playing: go by its clock instead
        if (s.frameCalls && now - s.playedSince > 500 && s.frameCallSeen < s.playedSince) s.frameCalls = false;
        if (!s.frameCalls && t !== s.takenAt && now - s.takenWhen >= 15) s.fresh = true;
      } else s.playedSince = 0;

      if (s.dirty || moving) {
        if (paint(s.target ?? t, false)) {
          s.dirty = false;
          s.settle = moving ? 0 : now + 160;
          if (!s.started) {
            s.started = true;
            setReady(true);
          }
        }
        if (moving) emit(t);
      } else if (s.settle && now >= s.settle && !v.seeking) {
        // it stands still: the frame once more, the way the export draws it
        if (!s.direct && s.frameAt !== t) void grab().then(() => alive && (s.settle = s.settle && performance.now()));
        else if (paint(t, true)) s.settle = 0;
      }
    };
    raf = requestAnimationFrame(tick);

    // the video says when it shows a new frame, so a still screen costs nothing
    const v = video.current;
    let frameCall = 0;
    if (v && "requestVideoFrameCallback" in v) {
      s.frameCalls = true;
      const onFrame = () => {
        s.frameCallSeen = performance.now();
        s.fresh = true;
        frameCall = v.requestVideoFrameCallback(onFrame);
      };
      frameCall = v.requestVideoFrameCallback(onFrame);
    }

    const box = stage.current;
    const watch = box
      ? new ResizeObserver(() => {
          s.box = { w: box.clientWidth, h: box.clientHeight };
          s.dirty = true;
        })
      : null;
    if (box && watch) {
      s.box = { w: box.clientWidth, h: box.clientHeight };
      watch.observe(box);
    }

    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      if (v && frameCall) v.cancelVideoFrameCallback(frameCall);
      watch?.disconnect();
      s.reader?.dispose();
      s.reader = null;
      s.frame?.close();
      s.camFrame?.close();
      s.frame = s.camFrame = null;
      s.frameAt = -1;
      s.fresh = true;
    };
  }, [emit, s]);

  useEffect(() => {
    if (video.current) video.current.muted = muted;
  }, [muted]);

  const length = useCallback(() => live.current.duration || video.current?.duration || 0, []);
  const jump = useCallback((t: number) => {
    const v = video.current;
    if (!v) return;
    v.currentTime = t;
    if (cam.current) cam.current.currentTime = t;
  }, []);
  const seek = useCallback(
    (t: number) => {
      const v = video.current;
      if (!v) return;
      const at = Math.max(0, Math.min(length(), t));
      emit(at);
      s.dirty = true;
      // one seek at a time: the newest waits for the one in flight (a 4K frame takes a while to reach)
      if (v.seeking) s.target = at;
      else jump(at);
    },
    [emit, jump, length, s],
  );
  const play = useCallback(() => {
    const v = video.current;
    const look = live.current.look;
    if (!v || !look) return;
    const { start, end } = trimOf(look, length());
    if (v.currentTime >= end - 0.05 || v.currentTime < start - 0.05) jump(start);
    void v.play().catch(() => {});
  }, [jump, length]);

  // it opens playing, from the start of the kept part; a refused play() leaves it on its first frame
  const opened = useRef(false);
  const hasLook = o.look !== null;
  useEffect(() => {
    if (!ready || !hasLook || opened.current) return;
    opened.current = true;
    play();
  }, [ready, hasLook, play]);

  return useMemo<Player>(
    () => ({
      video,
      cam,
      canvas,
      stage,
      playing,
      ready,
      mediaDuration,
      muted,
      setMuted: (m) => {
        setMutedState(m);
        try {
          localStorage.setItem(MUTED_KEY, m ? "1" : "0");
        } catch {
          // kept for this visit only
        }
      },
      time: () => s.target ?? video.current?.currentTime ?? 0,
      onTime: (fn) => {
        s.times.add(fn);
        return () => void s.times.delete(fn);
      },
      onFrame: (fn) => {
        s.frames.add(fn);
        return () => void s.frames.delete(fn);
      },
      seek,
      toggle: () => (video.current?.paused ? play() : video.current?.pause()),
      pause: () => video.current?.pause(),
      drawSource: (ctx) => {
        const v = video.current;
        // the bitmap when it is of this very frame (it is, once the picture has stood still); else the video itself
        const source = s.frame && v && s.frameAt === v.currentTime ? s.frame : v && v.readyState >= 2 ? v : null;
        if (!source) return false;
        ctx.imageSmoothingQuality = "medium";
        ctx.drawImage(source, 0, 0, ctx.canvas.width, ctx.canvas.height);
        return true;
      },
      videoProps: {
        onPlay: () => {
          setPlaying(true);
          if (cam.current) void cam.current.play().catch(() => {});
        },
        onPause: () => {
          setPlaying(false);
          cam.current?.pause();
          s.fresh = true; // the frame it stopped on
          s.dirty = true;
        },
        onSeeked: () => {
          const v = video.current;
          if (!v) return;
          const next = s.target;
          s.target = null;
          if (next !== null && Math.abs(next - v.currentTime) > 0.01) return jump(next);
          s.fresh = true;
          s.dirty = true;
          emit(v.currentTime);
        },
        onLoadedData: () => {
          s.fresh = true;
          s.dirty = true;
        },
        onLoadedMetadata: () => {
          const d = video.current?.duration ?? 0;
          if (Number.isFinite(d) && d > 0) setMediaDuration(d);
        },
      },
    }),
    [emit, jump, mediaDuration, muted, play, playing, ready, s, seek],
  );
}
