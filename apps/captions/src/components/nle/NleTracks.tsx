import { memo, useEffect, useRef, useState, type MutableRefObject, type PointerEvent as ReactPointerEvent } from "react";
import { Eye, EyeOff, Lock, LockOpen, Volume2, VolumeX, X } from "lucide-react";
import { TimelineFrame } from "@/components/timeline/TimelineFrame";
import { SNAP_PX, snapDelta } from "@/lib/clip-drag";
import { useTimeAxis } from "@/lib/use-time-axis";
import { edgesOf, endOf, isVideo, lengthOf, move, roll, slip, trackOrder, trim, withLinked, type NleItem, type NleTimeline, type NleTrack } from "@/lib/nle/model";
import { cn } from "@/lib/utils";
import { peaks, wavePath } from "@/lib/waveform";
import { thumbAt } from "@/lib/nle/thumbs";
import type { NleFile } from "./NlePlayer";

// The editor's timeline: track headers (name, lock, hide or mute, take off), the clips on their lanes, the ruler and the
// playhead. A drag shows its result live (`onLive`) and becomes one step of undo when let go (`onCommit`).
// Select tool: drag a clip to move it (onto any track of its kind; it overwrites what it lands on), an end to trim it,
// ⌥ + an end to roll the cut. Trim tool: drag a clip to slip it, an end to ripple-trim it, ⌥ + an end to roll.
// Blade tool: a click cuts the clip there.

export type Tool = "select" | "trim" | "blade";

const LABEL_W = 136;
const RULER_H = 22;
const laneH = (id: string) => (isVideo(id) ? 46 : 38);
const EDGE_PX = 6;

type Drag = {
  key: string;
  track: string;
  grip: "body" | "head" | "tail";
  x0: number;
  base: NleTimeline;
  moved: boolean;
  next: NleTimeline;
  keys: string[];
};

export const NleTracks = memo(function NleTracks({
  tl, time, selected, tool, snap, marks, onSeek, onSelect, onLive, onCommit, onBlade, onDrop, onMenu, onTrack, onRemoveTrack, nameOf, zoomKeys, fileOf,
}: {
  tl: NleTimeline;
  time: number;
  selected: string[];
  tool: Tool;
  snap: boolean;
  marks: [number | null, number | null];
  onSeek: (t: number) => void;
  onSelect: (keys: string[]) => void;
  onLive: (tl: NleTimeline | null) => void;
  onCommit: (tl: NleTimeline) => void;
  onBlade: (frame: number, key: string) => void;
  onDrop?: (dt: DataTransfer, at: { track: string; frame: number }) => void;
  onMenu: (at: { x: number; y: number }, key: string) => void;
  onTrack: (id: string, patch: Partial<Omit<NleTrack, "items">>) => void;
  onRemoveTrack: (id: string) => void;
  nameOf: (it: NleItem) => string;
  /** the timeline's zoom keys (= - \), for the editor's key handler */
  zoomKeys: MutableRefObject<((e: KeyboardEvent) => boolean) | null>;
  /** a source's file here (the player's): sound clips show its waveform, video clips its pictures */
  fileOf?: (src: string) => NleFile | null;
}) {
  const fps = tl.timeline.fps;
  const seconds = Math.max(lengthOf(tl) / fps, 1);
  // room after the end to pull a clip out into and to drop onto. It grows when the timeline outgrows it, never during a
  // drag: the clip under the pointer stays where it is
  const span = useRef(0);
  const drag = useRef<Drag | null>(null);
  if (!drag.current && (seconds + 2 > span.current || span.current > seconds * 4 + 8)) span.current = seconds * 1.4 + 3;
  const shown = span.current;
  const scroller = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const timeRef = useRef(time);
  timeRef.current = time;
  const axis = useTimeAxis({ scroller, seconds: shown, left: LABEL_W, maxPps: 600, now: () => timeRef.current });
  zoomKeys.current = axis.key;
  const pps = axis.pps;
  // the playhead kept in view while it moves
  // eslint-disable-next-line react-hooks/exhaustive-deps -- on the time alone
  useEffect(() => axis.follow(time), [time]);
  const [hover, setHover] = useState<string | null>(null);
  const order = trackOrder(tl);
  const picked = new Set(selected);

  const frameAt = (clientX: number) => {
    const r = inner.current!.getBoundingClientRect();
    return Math.max(0, Math.round(((clientX - r.left - LABEL_W) / pps) * fps));
  };
  const laneAt = (clientX: number, clientY: number) =>
    (document.elementFromPoint(clientX, clientY)?.closest("[data-lane]") as HTMLElement | null)?.dataset.lane ?? null;

  const down = (e: ReactPointerEvent, it: NleItem, track: string) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const key = it._k!;
    if (tool === "blade") {
      const f = frameAt(e.clientX);
      const ph = Math.round(time * fps);
      onBlade(snap && Math.abs(f - ph) * (pps / fps) < SNAP_PX ? ph : f, key);
      return;
    }
    const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const grip = e.clientX - box.left < EDGE_PX ? "head" : box.right - e.clientX < EDGE_PX ? "tail" : "body";
    let keys = selected.includes(key) ? selected : [key];
    if (e.shiftKey || e.metaKey) {
      keys = selected.includes(key) ? selected.filter((k) => k !== key) : [...selected, key];
      onSelect(keys);
      return;
    }
    if (!selected.includes(key)) onSelect([key]);
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    drag.current = { key, track, grip, x0: e.clientX, base: tl, moved: false, next: tl, keys };
  };

  const moveTo = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const px = e.clientX - d.x0;
    const to = laneAt(e.clientX, e.clientY);
    if (!d.moved && Math.abs(px) < 3 && (d.grip !== "body" || !to || to === d.track)) return;
    let df = Math.round((px / pps) * fps);
    const it = d.base.tracks[d.track].items.find((i) => i._k === d.key)!;
    const linked = new Set(withLinked(d.base, d.keys));
    const targets = snap ? [...edgesOf(d.base, linked), Math.round(timeRef.current * fps), ...marks.filter((m): m is number => m !== null)] : [];
    const tol = (SNAP_PX / pps) * fps;
    const roll_ = e.altKey && d.grip !== "body";
    let next = d.base;
    if (d.grip === "body" && tool === "select") {
      if (snap) df = snapDelta([it.rec, endOf(it)], df, targets, tol);
      next = move(d.base, d.keys, df, to ? { from: d.track, to } : undefined);
    } else if (d.grip === "body") {
      next = slip(d.base, d.key, -df);
    } else {
      if (snap) df = snapDelta([d.grip === "head" ? it.rec : endOf(it)], df, targets, tol);
      if (roll_) {
        // the cut at the clip's start is the end of the clip before it
        const prev = d.grip === "head" ? d.base.tracks[d.track].items.find((x) => endOf(x) === it.rec) : it;
        next = prev ? roll(d.base, prev._k!, df) : d.base;
      } else next = trim(d.base, d.key, d.grip, df, tool === "trim");
    }
    d.moved = true;
    d.next = next;
    onLive(next);
  };

  const up = () => {
    const d = drag.current;
    drag.current = null;
    if (!d?.moved) return;
    onLive(null);
    if (d.next !== d.base) onCommit(d.next);
  };

  const scrub = (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    onSeek(frameAt(e.clientX) / fps);
  };

  const ph = LABEL_W + time * pps;
  const cursor = tool === "blade" ? "cursor-crosshair" : "";

  return (
    <TimelineFrame scroller={scroller} inner={inner} seconds={shown} pps={pps} labelWidth={LABEL_W} rulerHeight={RULER_H}
      className="rounded-md border border-zinc-800 bg-zinc-950"
      ruler={{ onPointerDown: scrub, onPointerMove: (e) => e.buttons === 1 && onSeek(frameAt(e.clientX) / fps), className: "cursor-ew-resize" }}
      rulerLabel={<span className="font-mono text-[10px] text-zinc-500">{tl.timeline.width}×{tl.timeline.height}</span>}
      rulerChildren={
        <>
          {marks[0] !== null && marks[1] !== null && (
            <div className="absolute inset-y-0 bg-violet-500/20" style={{ left: (marks[0] / fps) * pps, width: ((marks[1] - marks[0]) / fps) * pps }} />
          )}
          <div className="pointer-events-none absolute inset-y-0 border-l border-dashed border-zinc-600" style={{ left: seconds * pps }} title="End" />
        </>
      }
      content={{ onPointerMove: moveTo, onPointerUp: up, onPointerCancel: up, className: cursor }}>
      {order.map((id) => {
        const t = tl.tracks[id];
        const v = isVideo(id);
        const off = v ? t.hidden : t.mute;
        return (
          <div key={id} className="flex border-t border-zinc-900" style={{ height: laneH(id) }}>
            <div className="sticky left-0 z-20 flex shrink-0 items-center gap-0.5 border-r border-zinc-800 bg-zinc-950 px-1.5 text-[11px]" style={{ width: LABEL_W }}
              onMouseEnter={() => setHover(id)} onMouseLeave={() => setHover(null)}>
              <span className={cn("w-6 shrink-0 rounded px-0.5 text-center font-mono font-semibold", v ? "bg-sky-900/60 text-sky-200" : "bg-emerald-900/60 text-emerald-200")}>{id}</span>
              <span className="min-w-0 flex-1 truncate text-zinc-400" title={t.name ?? id}>{t.name && t.name !== id ? t.name : ""}</span>
              {hover === id && id !== "V1" && id !== "A1" && !t.locked && (
                <button type="button" aria-label={`Remove ${id}`} title={`Remove ${id} and its clips`} onClick={() => onRemoveTrack(id)}
                  className="rounded p-0.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"><X className="size-3" /></button>
              )}
              <button type="button" aria-pressed={!!off} aria-label={v ? (off ? `Show ${id}` : `Hide ${id}`) : off ? `Unmute ${id}` : `Mute ${id}`}
                title={v ? (off ? "Hidden" : "Shown") : off ? "Muted" : "Heard"}
                onClick={() => onTrack(id, v ? { hidden: off ? undefined : true } : { mute: off ? undefined : true })}
                className={cn("rounded p-0.5 hover:bg-zinc-800", off ? "text-amber-400" : "text-zinc-500")}>
                {v ? (off ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />) : off ? <VolumeX className="size-3.5" /> : <Volume2 className="size-3.5" />}
              </button>
              <button type="button" aria-pressed={!!t.locked} aria-label={t.locked ? `Unlock ${id}` : `Lock ${id}`} title={t.locked ? "Locked" : "Unlocked"}
                onClick={() => onTrack(id, { locked: t.locked ? undefined : true })}
                className={cn("rounded p-0.5 hover:bg-zinc-800", t.locked ? "text-amber-400" : "text-zinc-500")}>
                {t.locked ? <Lock className="size-3.5" /> : <LockOpen className="size-3.5" />}
              </button>
            </div>
            <div data-lane={id} className={cn("relative flex-1", t.locked && "bg-[repeating-linear-gradient(135deg,transparent_0_6px,rgba(255,255,255,0.03)_6px_12px)]")}
              onPointerDown={(e) => e.button === 0 && tool !== "blade" && !e.shiftKey && onSelect([])}
              onDragOver={(e) => {
                if (!onDrop || t.locked) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "copy";
              }}
              onDrop={(e) => {
                if (!onDrop || t.locked) return;
                e.preventDefault();
                onDrop(e.dataTransfer, { track: id, frame: frameAt(e.clientX) });
              }}>
              {t.items.map((it) => {
                const on = picked.has(it._k!);
                const w = (it.len / fps) * pps;
                return (
                  <div key={it._k} data-clip={it._k} role="button" aria-pressed={on} aria-label={`${id} ${nameOf(it)}`}
                    onPointerDown={(e) => down(e, it, id)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      if (!on) onSelect([it._k!]);
                      onMenu({ x: e.clientX, y: e.clientY }, it._k!);
                    }}
                    className={cn("absolute inset-y-1 overflow-hidden rounded-[3px] border px-1 text-[10px] leading-4 select-none",
                      v ? "border-sky-700/70 bg-sky-800/70 text-sky-50" : "border-emerald-700/70 bg-emerald-800/60 text-emerald-50",
                      on && "border-amber-300 ring-1 ring-amber-300",
                      (it.enabled === false || off) && "opacity-40",
                      tool === "select" ? "cursor-grab" : tool === "trim" ? "cursor-ew-resize" : "")}
                    style={{ left: (it.rec / fps) * pps, width: Math.max(2, w) }}>
                    {fileOf && w > 8 && <ClipLook it={it} tl={tl} video={v} file={fileOf(it.src)} width={w} height={laneH(id) - 8} />}
                    {w > 24 && <span className="relative block truncate [text-shadow:0_1px_2px_rgb(0_0_0/0.8)]">{nameOf(it)}</span>}
                    {w > 60 && isVideo(id) && <span className="relative block truncate text-[9px] text-sky-200/70 [text-shadow:0_1px_2px_rgb(0_0_0/0.8)]">{(it.len / fps).toFixed(2)} s</span>}
                    <span className="absolute inset-y-0 left-0 w-1.5 cursor-ew-resize hover:bg-white/30" />
                    <span className="absolute inset-y-0 right-0 w-1.5 cursor-ew-resize hover:bg-white/30" />
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
      <div className="pointer-events-none absolute top-0 bottom-0 z-30 w-px bg-red-500" style={{ left: ph }} />
    </TimelineFrame>
  );
});

const SOUND_FILE = /\.(wav|aif|aiff|m4a|mp3|flac|caf|aac)$/i;
const peakOf = new WeakMap<Float32Array, number>();
const loudestIn = (d: Float32Array) => {
  let p = peakOf.get(d);
  if (p === undefined) peakOf.set(d, (p = d.reduce((a, b) => Math.max(a, b), 0)));
  return p;
};

/** Under a clip's name: a sound clip's waveform from its sound file, a video clip's pictures along it (a picture a second). */
const ClipLook = memo(function ClipLook({ it, tl, video, file, width, height }: {
  it: NleItem; tl: NleTimeline; video: boolean; file: NleFile | null; width: number; height: number;
}) {
  const path = String(tl.sources[it.src]?.path ?? "");
  const fps = tl.timeline.fps;
  const sfps = tl.sources[it.src]?.fps || fps;
  const from = it.in / sfps;
  const to = from + (it.len / fps) * (it.speed || 1);
  const url = file?.url ?? null;
  const [wave, setWave] = useState<Float32Array | null>(null);
  // sound files only: a camera file would be decoded whole for its sound
  const sound = !video && !!url && SOUND_FILE.test(path);
  useEffect(() => {
    if (!sound || !url) return void setWave(null);
    let gone = false;
    peaks(url).then((d) => !gone && setWave(d), () => {});
    return () => void (gone = true);
  }, [sound, url]);
  const strip = useRef<HTMLCanvasElement>(null);
  const pictures = video && !!url && !file?.frame && !/\.(png|jpe?g|webp|gif)$/i.test(path);
  useEffect(() => {
    const c = strip.current;
    if (!pictures || !url || !c) return;
    let gone = false;
    const tile = Math.round(height * 0.75);
    const n = Math.min(40, Math.ceil(width / tile));
    const g = c.getContext("2d");
    for (let i = 0; i < n; i++) {
      const sec = Math.floor(from + ((to - from) * i) / n);
      void thumbAt(url, sec).then((b) => {
        if (gone || !b || !g) return;
        // a picture filling its tile, cut to it
        const s = Math.max(tile / b.width, height / b.height);
        g.save();
        g.beginPath();
        g.rect(i * tile, 0, tile, height);
        g.clip();
        g.drawImage(b, i * tile + (tile - b.width * s) / 2, (height - b.height * s) / 2, b.width * s, b.height * s);
        g.restore();
      });
    }
    return () => void (gone = true);
  }, [pictures, url, from, to, width, height]);
  if (pictures) return <canvas ref={strip} width={Math.min(Math.ceil(width), 4000)} height={height} className="pointer-events-none absolute inset-0 h-full opacity-60" style={{ width: Math.min(Math.ceil(width), 4000) }} />;
  if (!wave) return null;
  const path_ = wavePath(wave, from, to, loudestIn(wave));
  return (
    <svg className="pointer-events-none absolute inset-0 size-full text-emerald-300/50" viewBox={`0 -1 ${path_.n} 2`} preserveAspectRatio="none">
      <path d={path_.d} fill="currentColor" />
    </svg>
  );
});
