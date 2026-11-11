import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { drawFrame, outputSize, trimOf, type CameraImage, type ScreenEvents, type ScreenLook } from "@/lib/screen-recording";
import { frameReader, type FrameReader } from "@/lib/frame-reader";
import { Deck } from "./deck";

type Path = [number, number, number][];

/** The preview of the screen recording editor: the video, its picture on the canvas, and where it is in time. */
export type Player = {
  /** Where the player keeps its <video> elements (out of sight). */
  holder: RefObject<HTMLDivElement | null>;
  canvas: RefObject<HTMLCanvasElement | null>;
  /** The box the canvas is fitted into. */
  stage: RefObject<HTMLDivElement | null>;
  playing: boolean;
  /** The first frame is on the canvas. */
  ready: boolean;
  /** The video could not be opened. */
  failed: boolean;
  /** The recording's length as the file itself reports it (0 until known). */
  mediaDuration: number;
  muted: boolean;
  setMuted: (muted: boolean) => void;
  /** At the end of the kept part it starts again (on unless switched off; remembered). */
  loop: boolean;
  setLoop: (loop: boolean) => void;
  /** Where the playhead is (the place a scrub is heading for, while the video catches up). */
  time: () => number;
  /** Called with the time whenever it moves: every painted frame while playing, every seek. */
  onTime: (listener: (t: number) => void) => () => void;
  /** Called when the picture on the canvas is a new frame of the recording. */
  onFrame: (listener: () => void) => () => void;
  seek: (t: number) => void;
  toggle: () => void;
  pause: () => void;
  /** The recording's width over its height, as the file has it (0 until known). */
  ratio: () => number;
  /** The recording's current frame, whole, into a small canvas (the zoom's aim pad). False before the first frame. */
  drawSource: (ctx: CanvasRenderingContext2D) => boolean;
};

const stored = (key: string, fallback: boolean) => {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v === "1";
  } catch {
    return fallback;
  }
};
const store = (key: string, on: boolean) => {
  try {
    localStorage.setItem(key, on ? "1" : "0");
  } catch {
    // kept for this visit only
  }
};
const MUTED_KEY = "screen-editor-muted";

/** The checkerboard that shows through a look with no background: one fill, `cell` pixels a square. */
function checker(ctx: CanvasRenderingContext2D, cell: number): CanvasPattern | null {
  const tile = document.createElement("canvas");
  tile.width = tile.height = cell * 2;
  const t = tile.getContext("2d");
  if (!t) return null;
  t.fillStyle = "#52525b";
  t.fillRect(0, 0, cell * 2, cell * 2);
  t.fillStyle = "#3f3f46";
  t.fillRect(0, 0, cell, cell);
  t.fillRect(cell, cell, cell, cell);
  return ctx.createPattern(tile, "repeat");
}
const LOOP_KEY = "screen-editor-loop";

/**
 * Plays the recording and paints it with its look. What keeps it light (measured in WebKit on a 3008×3130 recording,
 * where drawing the <video> itself onto a 2D canvas takes 23 to 58 ms a frame):
 * - while it plays, or while a control is being dragged, the graphics card reads the frame (lib/frame-reader.ts,
 *   about 3 ms), when the video's clock has moved;
 * - once things have stood still for a moment, one frame is painted with the 2D canvas's own best scaling, from a
 *   bitmap of the frame (33 ms, once);
 * - nothing is painted while it is paused and nothing changes;
 * - the time goes to listeners (the playhead, the clock), never through React state;
 * - a look with no background gets its checkerboard as one pattern fill on the same canvas, which stays opaque.
 * What keeps it steady: the video is never asked to announce its frames (requestVideoFrameCallback made every start
 * stand still after 0.3 s), and each video is on two elements that take turns (deck.ts), because one that has played
 * and is then moved stands still for a quarter of a second soon after it starts again.
 * It plays round and round (the kept part) unless that is switched off.
 * `o` is read through a ref, so a new look never restarts the loop.
 */
export function usePlayer(o: {
  url: string;
  cameraUrl: string | null;
  look: ScreenLook | null;
  events: ScreenEvents | null;
  path: Path;
  duration: number;
  width: number;
  height: number;
}): Player {
  const holder = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const screen = useRef<Deck | null>(null);
  const camera = useRef<Deck | null>(null);
  const [playing, setPlaying] = useState(false);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [mediaDuration, setMediaDuration] = useState(0);
  const [muted, setMutedState] = useState(() => stored(MUTED_KEY, false));
  const [loop, setLoopState] = useState(() => stored(LOOP_KEY, true));
  const loopRef = useRef(loop);
  loopRef.current = loop;
  const mutedRef = useRef(muted);
  mutedRef.current = muted;
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
    /** A seek waiting for the one in flight to land. */
    target: null as number | null,
    /** It is playing as far as the person is concerned, while the videos are held for a jump or a takeover. */
    held: false,
    resume: 0,
    started: false,
    box: { w: 0, h: 0 },
    /** The checkerboard's pattern, kept while the canvas keeps its size. */
    checker: null as { cell: number; fill: CanvasPattern | null } | null,
    times: new Set<(t: number) => void>(),
    frames: new Set<() => void>(),
  }).current;

  const emit = useCallback((t: number) => s.times.forEach((fn) => fn(t)), [s]);
  const length = useCallback(() => live.current.duration || screen.current?.el.duration || 0, []);

  useEffect(() => {
    s.dirty = true;
  }, [o.look, o.events, o.path, s]);

  /** Plays from where it stands (from the start of the kept part when it stands at its end or outside it). */
  const play = useCallback(() => {
    const deck = screen.current;
    const look = live.current.look;
    if (!deck || !look) return;
    const { start, end } = trimOf(look, length());
    const t = deck.el.currentTime;
    if (t >= end - 0.05 || t < start - 0.05) {
      deck.seek(start);
      camera.current?.seek(start);
    }
    s.held = true;
    setPlaying(true);
    const stopped = () => {
      s.held = false;
      setPlaying(false);
    };
    deck.play().then((mine) => {
      if (mine) s.held = false;
    }, stopped);
    void camera.current?.play().catch(() => {});
  }, [length, s]);

  const pause = useCallback(() => {
    window.clearTimeout(s.resume);
    s.held = false;
    screen.current?.pause();
    camera.current?.pause();
    setPlaying(false);
    s.dirty = true;
  }, [s]);

  // the videos: two elements each (deck.ts), made here so that they can take turns
  useEffect(() => {
    const box = holder.current;
    if (!box) return;
    setFailed(false);
    const deck = new Deck(box, o.url, true, mutedRef.current, {
      play: () => setPlaying(true),
      pause: () => {
        // held for a jump or a takeover, or at its end with the spare already started: it is still playing
        if (s.held || deck.turning) return;
        setPlaying(false);
        s.fresh = true; // the frame it stopped on
        s.dirty = true;
      },
      seeked: () => {
        const next = s.target;
        s.target = null;
        if (next !== null && Math.abs(next - deck.el.currentTime) > 0.01) {
          deck.seek(next);
          camera.current?.seek(next);
          return;
        }
        s.fresh = true;
        s.dirty = true;
        emit(deck.el.currentTime);
      },
      loaded: () => {
        s.fresh = true;
        s.dirty = true;
      },
      // it reached its own end after all (the loop turns a little before it): round again
      ended: () => {
        if (deck.turning) return; // the spare is on its way: the next frame's turn takes it over
        if (loopRef.current) play();
        else setPlaying(false);
      },
      duration: (d) => setMediaDuration(d),
      error: () => setFailed(true),
    });
    screen.current = deck;
    const quiet = () => {};
    camera.current = o.cameraUrl
      ? new Deck(box, o.cameraUrl, false, true, { play: quiet, pause: quiet, seeked: quiet, loaded: quiet, ended: quiet, duration: quiet, error: quiet })
      : null;
    s.fresh = true;
    s.dirty = true;
    return () => {
      window.clearTimeout(s.resume);
      deck.dispose();
      camera.current?.dispose();
      screen.current = camera.current = null;
    };
  }, [o.url, o.cameraUrl, emit, play, s]);

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
      const v = screen.current?.el;
      if (!v || v.readyState < 2 || s.grabbing || s.direct) return;
      s.grabbing = true;
      const at = v.currentTime;
      try {
        const k = camera.current?.el;
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
      const v = screen.current?.el;
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
      if (look.background === "none") {
        const cell = Math.max(4, Math.round(Math.max(pw, ph) / 90));
        if (s.checker?.cell !== cell) s.checker = { cell, fill: checker(ctx, cell) };
        ctx.fillStyle = s.checker.fill ?? "#3f3f46";
        ctx.fillRect(0, 0, pw, ph);
      }
      const camEl = camera.current?.el;
      const liveCamera: CameraImage | null =
        camEl && camEl.readyState >= 2 ? { image: camEl, width: camEl.videoWidth, height: camEl.videoHeight } : null;
      if (careful && s.frame && !s.direct) {
        const cam: CameraImage | null = s.camFrame ? { image: s.camFrame, width: s.camFrame.width, height: s.camFrame.height } : liveCamera;
        drawFrame(ctx, s.frame, s.frame.width, s.frame.height, t, look, path, events.clicks, cam);
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
      const deck = screen.current;
      const { look, duration } = live.current;
      if (!deck || !look) return;
      let v = deck.el;
      let t = v.currentTime;
      // at its own end with the spare already started for the turn, it still counts as running
      const running = (!v.paused && !v.ended) || deck.turning;
      const moving = running || s.held;
      const now = performance.now();
      if (running && !s.held) {
        const cam = camera.current;
        const kept = trimOf(look, duration || v.duration || 0);
        if (loopRef.current) {
          deck.park(kept.start);
          cam?.park(kept.start);
          // a video takes a moment to get going: the spare is started a little before the end, and takes over at it
          if (!deck.turning && t >= kept.end - 0.25 && deck.canTurn()) {
            deck.beginTurn();
            if (cam?.canTurn()) cam.beginTurn();
          }
          if (t >= kept.end - 0.04 || v.ended) {
            if (deck.turning) {
              deck.finishTurn();
              if (cam?.turning) cam.finishTurn();
              else if (cam) {
                cam.seek(kept.start);
                void cam.play().catch(() => {});
              }
              v = deck.el;
              t = v.currentTime;
              s.fresh = true;
            } else {
              // no spare ready (a kept part shorter than a video takes to load): held, moved, played again
              s.held = true;
              v.pause();
              cam?.el.pause();
              deck.seek(kept.start);
              cam?.seek(kept.start);
              s.resume = window.setTimeout(play, 200);
            }
          }
        } else if (t >= kept.end - 0.03) pause();
        if (t !== s.takenAt && now - s.takenWhen >= 12) s.fresh = true;
      }

      if (s.dirty || moving) {
        if (paint(s.target ?? t, false)) {
          s.dirty = false;
          s.settle = moving ? 0 : now + 160;
          if (!s.started) {
            s.started = true;
            setReady(true);
          }
        }
        if (running) emit(t);
      } else if (s.settle && now >= s.settle && !v.seeking) {
        // it stands still: the frame once more, with the canvas's best scaling
        if (!s.direct && s.frameAt !== t) void grab().then(() => alive && (s.settle = s.settle && performance.now()));
        else if (paint(t, true)) s.settle = 0;
      }
    };
    raf = requestAnimationFrame(tick);

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
      watch?.disconnect();
      s.reader?.dispose();
      s.reader = null;
      s.frame?.close();
      s.camFrame?.close();
      s.frame = s.camFrame = null;
      s.frameAt = -1;
      s.fresh = true;
    };
  }, [emit, pause, play, s]);

  useEffect(() => {
    screen.current?.setMuted(muted);
  }, [muted]);

  const seek = useCallback(
    (t: number) => {
      const deck = screen.current;
      if (!deck) return;
      const at = Math.max(0, Math.min(length(), t));
      emit(at);
      s.dirty = true;
      // while it plays: held for the jump (the picture follows a drag), and played again a moment after the last one
      const v = deck.el;
      if ((!v.paused && !v.ended) || s.held) {
        s.held = true;
        deck.pause();
        camera.current?.pause();
        window.clearTimeout(s.resume);
        s.resume = window.setTimeout(play, 180);
      }
      // one seek at a time: the newest waits for the one in flight (a 4K frame takes a while to reach)
      if (deck.el.seeking) s.target = at;
      else {
        deck.seek(at);
        camera.current?.seek(at);
      }
    },
    [emit, length, play, s],
  );

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
      holder,
      canvas,
      stage,
      playing,
      ready,
      failed,
      mediaDuration,
      muted,
      setMuted: (m) => {
        setMutedState(m);
        store(MUTED_KEY, m);
      },
      loop,
      setLoop: (on) => {
        setLoopState(on);
        store(LOOP_KEY, on);
      },
      time: () => s.target ?? screen.current?.el.currentTime ?? 0,
      onTime: (fn) => {
        s.times.add(fn);
        return () => void s.times.delete(fn);
      },
      onFrame: (fn) => {
        s.frames.add(fn);
        return () => void s.frames.delete(fn);
      },
      seek,
      toggle: () => {
        const v = screen.current?.el;
        if (!v) return;
        if ((v.paused || v.ended) && !s.held) play();
        else pause();
      },
      pause,
      ratio: () => {
        const v = screen.current?.el;
        return v && v.videoWidth && v.videoHeight ? v.videoWidth / v.videoHeight : 0;
      },
      drawSource: (ctx) => {
        const v = screen.current?.el;
        // the bitmap when it is of this very frame (it is, once the picture has stood still); else the video itself
        const source = s.frame && v && s.frameAt === v.currentTime ? s.frame : v && v.readyState >= 2 ? v : null;
        if (!source) return false;
        ctx.imageSmoothingQuality = "medium";
        ctx.drawImage(source, 0, 0, ctx.canvas.width, ctx.canvas.height);
        return true;
      },
    }),
    [failed, loop, mediaDuration, muted, pause, play, playing, ready, s, seek],
  );
}
