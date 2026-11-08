import { useEffect, useRef, useState } from "react";
import { Pause, Play, SkipBack, SkipForward, Volume2, X } from "lucide-react";
import { frameAt, frameTime, timecode, type ReviewVersion } from "@/lib/review";
import { cn } from "@/lib/utils";

type Mode = "side" | "wipe" | "diff";
const MODES: [Mode, string][] = [
  ["side", "Side by side"],
  ["wipe", "Wipe"],
  ["diff", "Difference"],
];

/**
 * Two versions of one video on one clock. The left player is the master;
 * the right one follows it. Wipe and Difference stack the right player on
 * the left one (same elements, so switching modes never reloads).
 */
export function ReviewCompare({
  versions,
  media,
  n,
  start,
  onClose,
}: {
  /** Ready versions, oldest first. */
  versions: ReviewVersion[];
  media: (n: number) => string;
  /** The version being watched: it goes on the right, the one before it on the left. */
  n: number;
  /** Where the main player was. */
  start: number;
  onClose: () => void;
}) {
  const i = Math.max(0, versions.findIndex((v) => v.n === n));
  const [left, setLeft] = useState(versions[i > 0 ? i - 1 : 0].n);
  const [right, setRight] = useState(versions[i > 0 ? i : Math.min(1, versions.length - 1)].n);
  const [mode, setMode] = useState<Mode>("side");
  const [wipe, setWipe] = useState(0.5);
  const [audio, setAudio] = useState<"left" | "right">("right");
  const [time, setTime] = useState(start);
  const [duration, setDuration] = useState(0);
  const [playing, setPlaying] = useState(false);
  const a = useRef<HTMLVideoElement>(null);
  const b = useRef<HTMLVideoElement>(null);
  const fps = versions.find((v) => v.n === left)?.fps || 0;

  // the right player follows the left one's clock
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const x = a.current;
      const y = b.current;
      if (x && y) {
        setTime(x.currentTime);
        // ponytail: seek-to-correct drifts > 80 ms while playing; rate nudging if it stutters
        const drift = Math.abs(y.currentTime - x.currentTime);
        if ((x.paused ? drift > 0.001 : drift > 0.08) && x.currentTime <= y.duration) {
          y.currentTime = x.currentTime;
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const toggle = () => {
    const x = a.current;
    const y = b.current;
    if (!x || !y) return;
    if (x.paused) {
      void x.play();
      void y.play();
    } else {
      x.pause();
      y.pause();
    }
  };
  const seek = (t: number) => {
    const clamped = Math.max(0, Math.min(t, (duration || 0) - 0.001));
    for (const el of [a.current, b.current]) if (el) el.currentTime = clamped;
    setTime(clamped);
  };
  const step = (frames: number) => {
    a.current?.pause();
    b.current?.pause();
    const t = a.current?.currentTime ?? 0;
    seek(fps ? frameTime(frameAt(t, fps) + frames, fps) : t + frames / 30);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || (e.target as HTMLElement)?.tagName === "SELECT") return;
      const k = e.key.toLowerCase();
      if (k === "escape") onClose();
      else if (k === " " || k === "k") toggle();
      else if (k === "arrowleft") step(e.shiftKey ? -Math.max(1, Math.round(fps || 30)) : -1);
      else if (k === "arrowright") step(e.shiftKey ? Math.max(1, Math.round(fps || 30)) : 1);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const stacked = mode !== "side";
  const label = (n: number, side: string) => (
    <span className={cn("pointer-events-none absolute top-2 z-10 rounded bg-black/70 px-1.5 py-0.5 text-xs font-medium", side)}>
      V{n}
    </span>
  );
  const picker = (value: number, set: (n: number) => void, title: string) => (
    <select
      value={value}
      title={title}
      onChange={(e) => set(Number(e.target.value))}
      className="max-w-40 rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1 text-xs"
    >
      {versions.map((v) => (
        <option key={v.n} value={v.n}>
          V{v.n} · {v.name}
        </option>
      ))}
    </select>
  );

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-zinc-950 text-zinc-200">
      <header data-titlebar className="flex flex-wrap items-center gap-2 border-b border-zinc-900 px-3 py-2">
        <h2 className="text-sm font-semibold">Compare</h2>
        {picker(left, setLeft, "Left")}
        <span className="text-xs text-zinc-600">vs</span>
        {picker(right, setRight, "Right")}
        <div className="ml-auto flex items-center gap-1 rounded-md border border-zinc-800 p-0.5">
          {MODES.map(([m, name]) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={cn("rounded px-2 py-1 text-xs", mode === m ? "bg-zinc-800 text-zinc-100" : "text-zinc-500 hover:text-zinc-300")}
            >
              {name}
            </button>
          ))}
        </div>
        <button onClick={onClose} className="rounded-md p-1.5 text-zinc-400 hover:bg-zinc-900 hover:text-zinc-100" aria-label="Close compare (Esc)">
          <X className="h-4 w-4" />
        </button>
      </header>

      <div
        className={cn("relative min-h-0 flex-1 bg-zinc-900 dark:bg-black", stacked ? "isolate" : "grid grid-rows-2 gap-1 md:grid-cols-2 md:grid-rows-1")}
        onPointerDown={(e) => {
          if (mode !== "wipe") return;
          e.currentTarget.setPointerCapture(e.pointerId);
          const r = e.currentTarget.getBoundingClientRect();
          setWipe((e.clientX - r.left) / r.width);
        }}
        onPointerMove={(e) => {
          if (mode !== "wipe" || e.buttons !== 1) return;
          const r = e.currentTarget.getBoundingClientRect();
          setWipe(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)));
        }}
      >
        <div className={cn("relative min-h-0", stacked && "h-full")}>
          <video
            ref={a}
            src={media(left)}
            className="h-full w-full object-contain"
            playsInline
            preload="auto"
            muted={audio !== "left"}
            onLoadedMetadata={(e) => {
              setDuration(e.currentTarget.duration);
              e.currentTarget.currentTime = time;
              if (playing) void e.currentTarget.play();
            }}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onEnded={() => {
              b.current?.pause();
              setPlaying(false);
            }}
          />
          {label(left, "left-2")}
        </div>
        <div
          className={cn("min-h-0", stacked ? "absolute inset-0" : "relative")}
          style={
            mode === "wipe"
              ? { clipPath: `inset(0 0 0 ${wipe * 100}%)` }
              : mode === "diff"
                ? { mixBlendMode: "difference" }
                : undefined
          }
        >
          <video
            ref={b}
            src={media(right)}
            className="h-full w-full object-contain"
            playsInline
            preload="auto"
            muted={audio !== "right"}
            onLoadedMetadata={(e) => {
              e.currentTarget.currentTime = a.current?.currentTime ?? 0;
              if (a.current && !a.current.paused) void e.currentTarget.play();
            }}
          />
          {mode !== "diff" && label(right, "right-2")}
        </div>
        {mode === "wipe" && (
          <div className="pointer-events-none absolute inset-y-0 w-0.5 -translate-x-1/2 bg-white shadow" style={{ left: `${wipe * 100}%` }} />
        )}
        {mode === "diff" && (
          <p className="pointer-events-none absolute bottom-2 left-1/2 -translate-x-1/2 rounded bg-black/70 px-2 py-1 text-xs text-zinc-300">
            Black = unchanged · bright = what changed
          </p>
        )}
      </div>

      <div className="px-3 pt-2">
        <input
          type="range"
          min={0}
          max={duration || 0}
          step="any"
          value={time}
          onChange={(e) => seek(Number(e.target.value))}
          className="w-full accent-violet-500"
          aria-label="Seek"
        />
      </div>
      <div className="flex items-center gap-1 px-3 pb-2 text-zinc-300">
        <button onClick={toggle} className="rounded-md p-1.5 hover:bg-zinc-800" aria-label={playing ? "Pause (space)" : "Play (space)"}>
          {playing ? <Pause className="h-5 w-5" /> : <Play className="h-5 w-5" />}
        </button>
        <button onClick={() => step(-1)} className="rounded-md p-1.5 hover:bg-zinc-800" aria-label="Previous frame (←)">
          <SkipBack className="h-4 w-4" />
        </button>
        <button onClick={() => step(1)} className="rounded-md p-1.5 hover:bg-zinc-800" aria-label="Next frame (→)">
          <SkipForward className="h-4 w-4" />
        </button>
        <span className="ml-1 font-mono text-sm tabular-nums">
          {timecode(time, fps)}
          <span className="hidden text-zinc-600 sm:inline"> / {timecode(duration, fps)}</span>
        </span>
        <button
          onClick={() => setAudio((x) => (x === "left" ? "right" : "left"))}
          className="ml-auto flex items-center gap-1.5 rounded-md px-2 py-1 text-xs hover:bg-zinc-800"
          title="Which version you hear"
        >
          <Volume2 className="h-4 w-4" /> V{audio === "left" ? left : right}
        </button>
      </div>
    </div>
  );
}
