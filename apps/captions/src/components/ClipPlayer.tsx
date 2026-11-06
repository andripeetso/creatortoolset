import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type Ref,
} from "react";
import {
  Maximize,
  Minimize,
  Pause,
  Play,
  RectangleHorizontal,
  Square,
} from "lucide-react";
import {
  ClipCaptions,
  ClipCaptionsToggle,
  useClipCaptionsOn,
} from "@/components/ClipCaptions";
import { ClipSpeedControl } from "@/components/ClipSpeedControl";
import {
  atWindowEnd,
  clampToWindow,
  clipPlayWindow,
  nudgeClipSpeed,
  pauseOtherVideos,
  useClipPlaybackRate,
} from "@/lib/clip-playback";
import type { ClipWord } from "@/lib/clips";
import { cn } from "@/lib/utils";

function fmtMmSs(t: number): string {
  if (!Number.isFinite(t) || t < 0) t = 0;
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function fsElement(): Element | null {
  const d = document as Document & { webkitFullscreenElement?: Element | null };
  return document.fullscreenElement ?? d.webkitFullscreenElement ?? null;
}

export type ClipPlayerHandle = {
  seek: (t: number) => void;
};

/**
 * Loom-style player: click the picture, space to pause, drag the bar.
 * Native <video controls> is skipped so transcript/chapter clicks stay
 * the seeking UI, not the browser's chrome.
 */
export function ClipPlayer({
  src,
  poster,
  duration: knownDuration,
  playerRef,
  onTime,
  words = [],
  theater = false,
  onTheaterChange,
  embedded = false,
  start,
  end,
  autoPlay = false,
}: {
  src?: string;
  poster?: string;
  duration?: number;
  playerRef?: Ref<ClipPlayerHandle>;
  onTime?: (t: number) => void;
  words?: ClipWord[];
  theater?: boolean;
  onTheaterChange?: (next: boolean) => void;
  /** In a document: no cinema mode, no page-wide keyboard shortcuts. */
  embedded?: boolean;
  start?: number;
  end?: number;
  autoPlay?: boolean;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(knownDuration || 0);
  const [hovering, setHovering] = useState(false);
  const [fs, setFs] = useState(false);
  const { rate, setRate } = useClipPlaybackRate(videoRef);
  const captions = useClipCaptionsOn();
  const hasCaptions = words.length > 0;
  const win = clipPlayWindow(duration, start, end);

  const report = useCallback(
    (t: number) => {
      setTime(t);
      onTime?.(t);
    },
    [onTime],
  );

  const seek = useCallback(
    (t: number) => {
      const v = videoRef.current;
      if (!v) return;
      const d = v.duration || duration;
      const { lo, hi } = clipPlayWindow(d, start, end);
      const next = clampToWindow(Math.max(0, Math.min(d || t, t)), lo, hi);
      v.currentTime = next;
      report(next);
    },
    [duration, end, report, start],
  );

  useImperativeHandle(playerRef, () => ({ seek }), [seek]);

  const toggle = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) {
      const d = v.duration || duration;
      const { lo, hi } = clipPlayWindow(d, start, end);
      if (atWindowEnd(v.currentTime, lo, hi)) v.currentTime = lo;
      void v.play();
    } else v.pause();
  }, [duration, end, start]);

  const toggleTheater = useCallback(() => {
    if (fsElement()) return;
    onTheaterChange?.(!theater);
  }, [onTheaterChange, theater]);

  const toggleFs = useCallback(() => {
    const root = rootRef.current;
    const video = videoRef.current;
    if (!root) return;
    if (fsElement()) {
      const d = document as Document & { webkitExitFullscreen?: () => void };
      if (document.exitFullscreen) void document.exitFullscreen();
      else d.webkitExitFullscreen?.();
      return;
    }
    const webkitRoot = root as HTMLElement & {
      webkitRequestFullscreen?: () => void;
    };
    if (root.requestFullscreen) void root.requestFullscreen();
    else if (webkitRoot.webkitRequestFullscreen)
      webkitRoot.webkitRequestFullscreen();
    else
      (
        video as HTMLVideoElement & { webkitEnterFullscreen?: () => void }
      )?.webkitEnterFullscreen?.();
  }, []);

  const seekFromClientX = useCallback(
    (clientX: number) => {
      const bar = barRef.current;
      const v = videoRef.current;
      if (!bar || !v) return;
      const r = bar.getBoundingClientRect();
      const pct = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
      const d = v.duration || duration || 0;
      const { lo, hi } = clipPlayWindow(d, start, end);
      const span = Math.max(0.001, (hi > lo ? hi : d) - lo);
      seek(lo + pct * span);
    },
    [duration, end, seek, start],
  );

  useEffect(() => {
    const v = videoRef.current;
    if (!v || start == null || !Number.isFinite(start)) return;
    const apply = () => {
      const { lo } = clipPlayWindow(v.duration || duration, start, end);
      v.currentTime = lo;
      report(lo);
    };
    if (v.readyState >= 1) apply();
    else v.addEventListener("loadedmetadata", apply, { once: true });
    return () => v.removeEventListener("loadedmetadata", apply);
  }, [duration, end, report, start]);

  useEffect(() => {
    const sync = () => setFs(fsElement() === rootRef.current);
    document.addEventListener("fullscreenchange", sync);
    document.addEventListener("webkitfullscreenchange", sync);
    return () => {
      document.removeEventListener("fullscreenchange", sync);
      document.removeEventListener("webkitfullscreenchange", sync);
    };
  }, []);

  useEffect(() => {
    if (embedded) return;
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "BUTTON") return;
      if (e.key === " " || e.key === "k" || e.key === "K") {
        e.preventDefault();
        toggle();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        seek((videoRef.current?.currentTime || 0) - 5);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        seek((videoRef.current?.currentTime || 0) + 5);
      } else if (e.key === "f" || e.key === "F") {
        e.preventDefault();
        toggleFs();
      } else if (onTheaterChange && (e.key === "t" || e.key === "T")) {
        e.preventDefault();
        toggleTheater();
      } else if (e.key === "<" || e.key === ",") {
        e.preventDefault();
        setRate(nudgeClipSpeed(rate, -1));
      } else if (e.key === ">" || e.key === ".") {
        e.preventDefault();
        setRate(nudgeClipSpeed(rate, 1));
      } else if (hasCaptions && (e.key === "c" || e.key === "C")) {
        e.preventDefault();
        captions.toggle();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    captions.toggle,
    embedded,
    hasCaptions,
    onTheaterChange,
    rate,
    seek,
    setRate,
    toggle,
    toggleFs,
    toggleTheater,
  ]);

  const span = Math.max(0.001, win.hi - win.lo);
  const pct =
    duration > 0 ? Math.min(100, Math.max(0, ((time - win.lo) / span) * 100)) : 0;
  const expanded = fs || theater;

  return (
    <div
      ref={rootRef}
      className={cn(
        "group relative overflow-hidden bg-black",
        fs
          ? "flex h-full w-full items-center justify-center rounded-none"
          : theater
            ? "w-full rounded-none"
            : embedded
              ? "rounded-none"
              : "rounded-xl",
      )}
      style={
        !fs && theater
          ? { height: "min(calc(100vh - 2.5rem), 56.25vw)" }
          : undefined
      }
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
    >
      <video
        ref={videoRef}
        {...(src ? { src } : {})}
        poster={poster}
        playsInline
        preload="metadata"
        className={cn(
          "cursor-pointer",
          expanded
            ? "h-full w-full object-contain"
            : "aspect-video w-full",
        )}
        onClick={toggle}
        onPlay={(e) => {
          pauseOtherVideos(e.currentTarget);
          const v = e.currentTarget;
          const { lo, hi } = clipPlayWindow(v.duration || duration, start, end);
          if (atWindowEnd(v.currentTime, lo, hi)) v.currentTime = lo;
          setPlaying(true);
        }}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onLoadedMetadata={(e) => {
          const d = e.currentTarget.duration;
          if (Number.isFinite(d) && d > 0) setDuration(d);
          const { lo } = clipPlayWindow(d, start, end);
          if (start != null && Number.isFinite(start)) {
            e.currentTarget.currentTime = lo;
            report(lo);
          }
          if (autoPlay) void e.currentTarget.play();
        }}
        onTimeUpdate={(e) => {
          if (dragging.current) return;
          const v = e.currentTarget;
          const { lo, hi } = clipPlayWindow(v.duration || duration, start, end);
          if (atWindowEnd(v.currentTime, lo, hi)) {
            v.pause();
            v.currentTime = hi;
            report(hi);
            return;
          }
          report(v.currentTime);
        }}
      />

      {hasCaptions && (
        <ClipCaptions
          words={words}
          time={time}
          on={captions.on}
          className="bottom-[3.5rem]"
        />
      )}

      <button
        type="button"
        aria-label={playing ? "Pause" : "Play"}
        onClick={toggle}
        className={`pointer-events-none absolute left-1/2 top-1/2 flex h-16 w-16 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-black/50 text-white shadow-lg backdrop-blur-sm transition-opacity ${
          playing ? "opacity-0" : "opacity-100"
        }`}
      >
        <Play className="ml-0.5 h-7 w-7 fill-current" />
      </button>

      <div
        className={`absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent px-3 pb-2.5 pt-10 transition-opacity ${
          playing && !hovering ? "opacity-0 group-hover:opacity-100" : "opacity-100"
        }`}
      >
        <div
          ref={barRef}
          role="slider"
          aria-label="Seek"
          aria-valuemin={Math.round(win.lo)}
          aria-valuemax={Math.round(win.hi || duration)}
          aria-valuenow={Math.round(time)}
          tabIndex={0}
          className="group/bar mb-2 h-4 cursor-pointer py-1.5"
          onPointerDown={(e) => {
            e.preventDefault();
            dragging.current = true;
            seekFromClientX(e.clientX);
            const move = (ev: PointerEvent) => seekFromClientX(ev.clientX);
            const up = () => {
              dragging.current = false;
              window.removeEventListener("pointermove", move);
              window.removeEventListener("pointerup", up);
              window.removeEventListener("pointercancel", up);
            };
            window.addEventListener("pointermove", move);
            window.addEventListener("pointerup", up);
            window.addEventListener("pointercancel", up);
          }}
        >
          <div className="relative h-1 rounded-full bg-white/25 group-hover/bar:h-1.5">
            <div
              className="absolute inset-y-0 left-0 rounded-full bg-violet-400"
              style={{ width: `${pct}%` }}
            />
            <div
              className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white opacity-0 shadow group-hover/bar:opacity-100"
              style={{ left: `${pct}%` }}
            />
          </div>
        </div>
        <div className="flex items-center gap-2 text-white">
          <button
            type="button"
            onClick={toggle}
            className="rounded p-1 hover:bg-white/10"
            aria-label={playing ? "Pause" : "Play"}
          >
            {playing ? (
              <Pause className="h-4 w-4 fill-current" />
            ) : (
              <Play className="h-4 w-4 fill-current" />
            )}
          </button>
          <span className="font-mono text-[11px] tabular-nums text-white/80">
            {fmtMmSs(time)} / {fmtMmSs(win.hi || duration)}
          </span>
          <div className="ml-auto flex items-center">
            {hasCaptions && (
              <ClipCaptionsToggle on={captions.on} onToggle={captions.toggle} />
            )}
            <ClipSpeedControl rate={rate} onChange={setRate} />
            {!fs && onTheaterChange && (
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={toggleTheater}
                title={theater ? "Default view" : "Cinema view"}
                aria-label={theater ? "Default view" : "Cinema view"}
                aria-pressed={theater}
                className={cn(
                  "hidden rounded p-1 hover:bg-white/10 sm:block",
                  theater && "bg-white/10",
                )}
              >
                {theater ? (
                  <Square className="h-4 w-4" />
                ) : (
                  <RectangleHorizontal className="h-4 w-4" />
                )}
              </button>
            )}
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={toggleFs}
              title={fs ? "Exit full screen" : "Full screen"}
              aria-label={fs ? "Exit full screen" : "Full screen"}
              aria-pressed={fs}
              className="rounded p-1 hover:bg-white/10"
            >
              {fs ? (
                <Minimize className="h-4 w-4" />
              ) : (
                <Maximize className="h-4 w-4" />
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
