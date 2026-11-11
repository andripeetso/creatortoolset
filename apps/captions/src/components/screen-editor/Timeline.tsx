import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Film, MoveHorizontal, Pause, Play, Plus, Redo2, SkipBack, SkipForward, Undo2, Volume2, VolumeX, ZoomIn } from "lucide-react";
import { Slider } from "@/components/ui/slider";
import { cn } from "@/lib/utils";
import { trimOf, type ScreenEvents, type ScreenLook, type Zoom } from "@/lib/screen-recording";
import { clock, dragTrim, dragZoom, rulerStep, zoomSlot, type ZoomGrip } from "@/lib/screen-timeline";
import type { Player } from "./usePlayer";

/** Follows a press until it lifts: `move` gets the distance from where it began, `end` whether it moved at all. */
function drag(e: ReactPointerEvent<HTMLElement>, move: (dx: number, clientX: number) => void, end?: (moved: boolean) => void) {
  if (e.button !== 0) return;
  const el = e.currentTarget;
  const from = e.clientX;
  let moved = false;
  el.setPointerCapture(e.pointerId);
  const onMove = (ev: PointerEvent) => {
    const dx = ev.clientX - from;
    if (Math.abs(dx) > 2) moved = true;
    if (moved) move(dx, ev.clientX);
  };
  const onUp = () => {
    el.removeEventListener("pointermove", onMove);
    el.removeEventListener("pointerup", onUp);
    el.removeEventListener("pointercancel", onUp);
    end?.(moved);
  };
  el.addEventListener("pointermove", onMove);
  el.addEventListener("pointerup", onUp);
  el.addEventListener("pointercancel", onUp);
}

/**
 * Under the picture: play, the clock, undo, and the recording as two tracks. The top one is the recording itself:
 * drag anywhere on it to move through it, drag its ends to cut the start and the end off. The lower one holds the
 * zooms: press an empty stretch to add one, drag one to move it, drag its ends to make it longer or shorter.
 */
export function Timeline({
  player,
  duration,
  look,
  clicks,
  picked,
  onPick,
  change,
  aim,
  depth,
  undo,
  redo,
}: {
  player: Player;
  duration: number;
  look: ScreenLook;
  clicks: ScreenEvents["clicks"];
  picked: number | null;
  onPick: (index: number | null) => void;
  change: (patch: Partial<ScreenLook>) => void;
  /** Where a new zoom at t should look (the pointer there). */
  aim: (t: number) => { x: number; y: number };
  /** How deep a new zoom is. */
  depth: number;
  undo: (() => void) | null;
  redo: (() => void) | null;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const head = useRef<HTMLDivElement>(null);
  const label = useRef<HTMLSpanElement>(null);
  const [width, setWidth] = useState(0);
  const [base, setBase] = useState(0);
  const [factor, setFactor] = useState(1);
  const [ghost, setGhost] = useState<{ start: number; end: number } | null>(null);
  const trim = trimOf(look, duration);
  const perSecond = duration > 0 ? width / duration : 0;
  const x = (t: number) => t * perSecond;
  // stretching the timeline is only offered when a second can get wider than it already is
  const maxFactor = base > 0 && duration > 0 ? Math.min(40, (240 * duration) / base) : 1;

  useEffect(() => {
    const el = inner.current;
    const outer = scroller.current;
    if (!el || !outer) return;
    const watch = new ResizeObserver(() => {
      setWidth(el.clientWidth);
      setBase(outer.clientWidth - 12);
    });
    watch.observe(el);
    watch.observe(outer);
    return () => watch.disconnect();
  }, []);

  // the playhead and the clock follow the player without a render
  useEffect(() => {
    const show = (t: number) => {
      if (head.current) head.current.style.transform = `translateX(${t * perSecond}px)`;
      const text = `${clock(t, duration < 60)} / ${clock(duration, duration < 60)}`;
      if (label.current && label.current.textContent !== text) label.current.textContent = text;
      // a stretched timeline scrolls along while it plays
      const box = scroller.current;
      if (box && player.playing && box.scrollWidth > box.clientWidth) {
        const at = t * perSecond;
        if (at < box.scrollLeft || at > box.scrollLeft + box.clientWidth - 40) box.scrollLeft = Math.max(0, at - 80);
      }
    };
    show(player.time());
    return player.onTime(show);
  }, [player, perSecond, duration]);

  const timeAt = (clientX: number) => {
    const r = inner.current?.getBoundingClientRect();
    return r && perSecond > 0 ? Math.max(0, Math.min(duration, (clientX - r.left) / perSecond)) : 0;
  };

  const scrub = (e: ReactPointerEvent<HTMLElement>) => {
    player.seek(timeAt(e.clientX));
    drag(e, (_dx, clientX) => player.seek(timeAt(clientX)));
  };

  const setTrim = (grip: "start" | "end", t: number) => {
    const next = dragTrim(trim, grip, t, duration);
    change({ trim: next.start <= 0.001 && next.end >= duration - 0.001 ? undefined : next });
    player.seek(grip === "start" ? next.start : next.end);
  };

  const grabZoom = (e: ReactPointerEvent<HTMLElement>, index: number, grip: ZoomGrip) => {
    e.stopPropagation();
    const before = look.zooms;
    onPick(index);
    drag(e, (dx) => perSecond > 0 && change({ zooms: dragZoom(before, index, grip, dx / perSecond, duration) }));
  };

  const addZoom = (slot: { start: number; end: number }) => {
    const at = aim((slot.start + slot.end) / 2);
    const z: Zoom = { ...slot, x: at.x, y: at.y, scale: depth };
    const zooms = [...look.zooms, z].sort((a, b) => a.start - b.start);
    change({ zooms });
    onPick(zooms.indexOf(z));
    setGhost(null);
  };

  const marks = useMemo(() => {
    const out: number[] = [];
    if (!(perSecond > 0)) return { step: 1, at: out };
    const step = rulerStep(perSecond);
    for (let t = 0; t <= duration + 1e-6; t += step) out.push(Math.round(t * 10) / 10);
    return { step, at: out };
  }, [perSecond, duration]);

  const icon = "rounded-md p-1.5 text-zinc-300 hover:bg-zinc-800 hover:text-zinc-50 disabled:pointer-events-none disabled:opacity-30 [&_svg]:h-4 [&_svg]:w-4";

  return (
    <div className="select-none border-t border-zinc-800 px-4 pb-3 pt-2">
      <div className="mb-1.5 grid grid-cols-[1fr_auto_1fr] items-center">
        <div className="flex items-center gap-1">
          <button type="button" className={icon} disabled={!undo} onClick={() => undo?.()} aria-label="Undo" title="Undo (⌘Z)">
            <Undo2 />
          </button>
          <button type="button" className={icon} disabled={!redo} onClick={() => redo?.()} aria-label="Redo" title="Redo (⇧⌘Z)">
            <Redo2 />
          </button>
          <span ref={label} className="ml-2 text-xs tabular-nums text-zinc-400" />
        </div>
        <div className="flex items-center gap-1">
          <button type="button" className={icon} onClick={() => player.seek(trim.start)} aria-label="To the start" title="To the start">
            <SkipBack />
          </button>
          <button
            type="button"
            onClick={player.toggle}
            aria-label={player.playing ? "Pause" : "Play"}
            title={player.playing ? "Pause (Space)" : "Play (Space)"}
            className="rounded-full bg-zinc-100 p-2 text-zinc-900 hover:bg-white [&_svg]:h-4 [&_svg]:w-4"
          >
            {player.playing ? <Pause className="fill-current" /> : <Play className="translate-x-px fill-current" />}
          </button>
          <button type="button" className={icon} onClick={() => player.seek(trim.end)} aria-label="To the end" title="To the end">
            <SkipForward />
          </button>
        </div>
        <div className="flex items-center justify-end gap-2">
          {maxFactor > 1.5 && <MoveHorizontal className="h-3.5 w-3.5 text-zinc-500" aria-hidden />}
          {maxFactor > 1.5 && (
            <Slider
              aria-label="Stretch the timeline"
              title="Stretch the timeline"
              value={[factor]}
              min={1}
              max={maxFactor}
              step={0.1}
              onValueChange={([v]) => setFactor(v)}
              className="w-28 [&_[data-slot=slider-range]]:bg-zinc-500 [&_[data-slot=slider-thumb]]:size-3 [&_[data-slot=slider-thumb]]:border-zinc-400 [&_[data-slot=slider-track]]:h-1 [&_[data-slot=slider-track]]:bg-zinc-800"
            />
          )}
          <button
            type="button"
            className={icon}
            onClick={() => player.setMuted(!player.muted)}
            aria-label={player.muted ? "Sound on" : "Sound off"}
            title={player.muted ? "Sound on" : "Sound off"}
          >
            {player.muted ? <VolumeX /> : <Volume2 />}
          </button>
        </div>
      </div>

      <div className="flex gap-2">
        {/* what each track is */}
        <div className="flex w-5 shrink-0 flex-col items-center text-zinc-500 [&_svg]:h-3.5 [&_svg]:w-3.5">
          <span className="h-5" />
          <span className="flex h-10 items-center" title="The recording">
            <Film />
          </span>
          <span className="mt-1.5 flex h-9 items-center" title="Zooms">
            <ZoomIn />
          </span>
        </div>

        <div ref={scroller} className="min-w-0 flex-1 overflow-x-auto overflow-y-hidden px-1.5">
          <div ref={inner} className="relative" style={{ width: `${factor * 100}%` }}>
            {/* the ruler: press or drag to move through the recording */}
            <div className="relative h-5 cursor-pointer overflow-hidden" onPointerDown={scrub}>
              {marks.at.map((t) => (
                <span key={t} className="absolute top-0 flex h-full items-end pb-0.5" style={{ left: x(t) }}>
                  <span className="absolute bottom-0 h-1.5 w-px bg-zinc-700" />
                  <span className="pl-1.5 text-[10px] tabular-nums text-zinc-500">{clock(t, marks.step < 1)}</span>
                </span>
              ))}
            </div>

            {/* the recording: the kept part is lit, its ends are handles */}
            <div className="relative h-10 cursor-pointer overflow-hidden rounded-lg bg-zinc-900" onPointerDown={scrub}>
              <div
                className="absolute inset-y-0 rounded-lg border border-violet-400/40 bg-violet-500/25"
                style={{ left: x(trim.start), width: Math.max(4, x(trim.end) - x(trim.start)) }}
              />
              {clicks.map(([t], i) => (
                <span key={i} className="absolute bottom-1 h-1.5 w-0.5 rounded-full bg-zinc-100/70" style={{ left: x(t) }} title="A click" />
              ))}
              {(["start", "end"] as const).map((grip) => (
                <div
                  key={grip}
                  role="slider"
                  aria-label={grip === "start" ? "Where the video starts" : "Where the video ends"}
                  aria-valuemin={0}
                  aria-valuemax={Math.round(duration * 10) / 10}
                  aria-valuenow={Math.round(trim[grip] * 10) / 10}
                  title={grip === "start" ? "Drag to cut the start off" : "Drag to cut the end off"}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    drag(e, (_dx, clientX) => setTrim(grip, timeAt(clientX)));
                  }}
                  className={cn(
                    "absolute inset-y-0 flex w-3 cursor-ew-resize items-center justify-center bg-violet-400/80 hover:bg-violet-300",
                    grip === "start" ? "rounded-l-lg" : "-translate-x-full rounded-r-lg",
                  )}
                  style={{ left: x(trim[grip]) }}
                >
                  <span className="h-4 w-0.5 rounded-full bg-violet-950/70" />
                </div>
              ))}
            </div>

            {/* the zooms */}
            <div
              className="relative mt-1.5 h-9 rounded-lg bg-zinc-900"
              onPointerMove={(e) => setGhost(e.target === e.currentTarget ? zoomSlot(look.zooms, timeAt(e.clientX), duration) : null)}
              onPointerLeave={() => setGhost(null)}
              onPointerDown={(e) => {
                if (e.target !== e.currentTarget || e.button !== 0) return;
                const slot = zoomSlot(look.zooms, timeAt(e.clientX), duration);
                if (slot) addZoom(slot);
              }}
            >
              {ghost && (
                <div
                  className="pointer-events-none absolute inset-y-1 flex items-center justify-center rounded-md border border-dashed border-violet-400/60 bg-violet-500/10 text-violet-200"
                  style={{ left: x(ghost.start), width: x(ghost.end) - x(ghost.start) }}
                >
                  <Plus className="h-3.5 w-3.5" />
                </div>
              )}
              {look.zooms.map((z, i) => (
                <div
                  key={i}
                  role="button"
                  tabIndex={0}
                  aria-pressed={picked === i}
                  aria-label={`Zoom ${clock(z.start, true)} to ${clock(z.end, true)}, ${z.scale.toFixed(1)} times`}
                  onPointerDown={(e) => grabZoom(e, i, "body")}
                  onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onPick(i))}
                  className={cn(
                    "absolute inset-y-1 flex cursor-grab items-center justify-center overflow-hidden rounded-md border text-[11px] font-medium tabular-nums active:cursor-grabbing",
                    picked === i
                      ? "border-violet-300 bg-violet-500 text-white"
                      : "border-violet-500/50 bg-violet-600/45 text-violet-100 hover:bg-violet-600/60",
                  )}
                  style={{ left: x(z.start), width: Math.max(10, x(z.end) - x(z.start)) }}
                >
                  <span onPointerDown={(e) => grabZoom(e, i, "start")} className="absolute inset-y-0 left-0 w-2 cursor-ew-resize" />
                  <span className="pointer-events-none truncate px-2">{z.scale.toFixed(1)}×</span>
                  <span onPointerDown={(e) => grabZoom(e, i, "end")} className="absolute inset-y-0 right-0 w-2 cursor-ew-resize" />
                </div>
              ))}
            </div>

            {/* the playhead */}
            <div ref={head} className="pointer-events-none absolute inset-y-0 left-0 w-0">
              <span className="absolute -left-[5px] top-0 h-2.5 w-[11px] rounded-sm bg-zinc-100" />
              <span className="absolute inset-y-0 -left-px w-0.5 bg-zinc-100" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
