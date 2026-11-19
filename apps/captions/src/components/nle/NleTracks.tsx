import { memo, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type MutableRefObject, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { Eye, EyeOff, Lock, LockOpen, Rows3, Volume2, VolumeX, X, ZoomIn } from "lucide-react";
import { TimelineFrame } from "@/components/timeline/TimelineFrame";
import { SNAP_PX, snapDelta } from "@/lib/clip-drag";
import { useTimeAxis } from "@/lib/use-time-axis";
import { copyOf, edgesOf, endOf, find, isVideo, lengthOf, move, paste, roll, setFade, slip, timecode, trackNo, trackOrder, trim, withLinked, type Edge, type NleItem, type NleTimeline, type NleTrack } from "@/lib/nle/model";
import { cn } from "@/lib/utils";
import { peaks, wavePath } from "@/lib/waveform";
import { thumbAt } from "@/lib/nle/thumbs";
import type { NleFile } from "./NlePlayer";
import { Panel } from "./NleLayout";

// The editor's timeline: track headers (name, lock, hide or mute, take off), the clips on their lanes, the ruler and the
// playhead. A drag shows its result live (`onLive`) and becomes one step of undo when let go (`onCommit`).
// Select tool: drag a clip to move it (onto any track of its kind; it overwrites what it lands on), ⌥ + drag to move a
// copy and leave it, an end to trim it, ⌥ + an end to roll the cut, a top corner to fade it in or out. Trim tool: drag a clip to slip it, an end to ripple-trim it, ⌥ + an end to roll.
// Blade tool: a click cuts the clip there.
// The panel's title bar carries the editor's tools (`tools`, `end`) and the timeline's own: track height and zoom.

export type Tool = "select" | "trim" | "blade";

const LABEL_W = 152;
const RULER_H = 24;
const HEIGHT_KEY = "ct-nle-track-height";
const readHeight = () => {
  try {
    const v = Number(localStorage.getItem(HEIGHT_KEY));
    return v >= 0.7 && v <= 2.5 ? v : 1;
  } catch {
    return 1;
  }
};
/** Each track's own height in px (a drag on its lower edge), before the height slider scales them all. */
const HEIGHTS_KEY = "ct-nle-track-heights";
const readHeights = (): Record<string, number> => {
  try {
    const v = JSON.parse(localStorage.getItem(HEIGHTS_KEY) ?? "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
};
const keep = (k: string, v: unknown) => {
  try {
    localStorage.setItem(k, typeof v === "string" ? v : JSON.stringify(v));
  } catch {
    // not kept for next time
  }
};
/** A sound clip cut from a video file shows its waveform when the file is at most this big (the file is read whole). */
// shortcut: whole-file decode, capped; a server-made peaks file would lift the cap for long camera files
const VIDEO_SOUND_BYTES = 300e6;
const EDGE_PX = 6;
const DAY = 24 * 3600;
const MAX_PPS = 600;
const MAX_PX = 16e6;

type Drag = {
  key: string;
  track: string;
  grip: "body" | "head" | "tail" | "fade-head" | "fade-tail";
  /** a fade drag: the fade it started from */
  f0?: number;
  /** an ⌥-drag: the copy's clips, picked when let go */
  copy?: string[];
  x0: number;
  base: NleTimeline;
  moved: boolean;
  next: NleTimeline;
  keys: string[];
};

export const NleTracks = memo(function NleTracks({
  tl, time, selected, tool, snap, marks, onSeek, onSelect, onLive, onCommit, onBlade, onDrop, onMenu, onTrack, onRemoveTrack, nameOf, zoomKeys, fileOf, tools, end,
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
  /** the editor's tools, at the start of the title bar */
  tools?: ReactNode;
  /** at its end, before the track height and zoom (what the save says, Save) */
  end?: ReactNode;
}) {
  const fps = tl.timeline.fps;
  const content = lengthOf(tl) / fps;
  const drag = useRef<Drag | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const timeRef = useRef(time);
  timeRef.current = time;
  // no end: the timeline runs for a day, it opens on (and \ fits) what is on it
  const axis = useTimeAxis({ scroller, seconds: DAY, left: LABEL_W, maxPps: MAX_PPS, now: () => timeRef.current, fit: Math.max(10, content * 1.04 + 1), minPps: 0.001 });
  // a browser can't lay out a box much over 30 million px: zoomed in close, the content is drawn for as many hours as
  // fit in 16 million (7 h at a frame's closest), and always past what is on it and the playhead
  const shown = Math.min(DAY, Math.max(MAX_PX / axis.pps, content + 3600, time + 60));
  zoomKeys.current = axis.key;
  const pps = axis.pps;
  // the playhead kept in view while it moves
  // eslint-disable-next-line react-hooks/exhaustive-deps -- on the time alone
  useEffect(() => axis.follow(time), [time]);
  const [scale, setScale] = useState(readHeight);
  const [heights, setHeights] = useState(readHeights);
  const laneH = (id: string) => Math.round((heights[id] ?? (isVideo(id) ? 54 : 40)) * scale);
  const keepHeight = (v: number) => {
    setScale(v);
    keep(HEIGHT_KEY, String(v));
  };
  // a drag on a track's lower edge sets its height; a double click puts it back
  const sizing = useRef<{ id: string; y0: number; h0: number } | null>(null);
  const sizeTrack = (id: string, h: number | null) => setHeights((all) => {
    const next = { ...all };
    if (h === null) delete next[id];
    else next[id] = Math.max(18, Math.min(400, h / scale));
    return next;
  });
  useEffect(() => keep(HEIGHTS_KEY, heights), [heights]);
  // the middle button drags the view, left and right and up and down
  const pan = useRef<{ x0: number; y0: number; left0: number; top0: number } | null>(null);
  const order = trackOrder(tl);
  const picked = new Set(selected);

  const frameAt = (clientX: number) => {
    const r = inner.current!.getBoundingClientRect();
    return Math.max(0, Math.round(((clientX - r.left - LABEL_W) / pps) * fps));
  };
  const laneAt = (clientX: number, clientY: number) =>
    (document.elementFromPoint(clientX, clientY)?.closest("[data-lane]") as HTMLElement | null)?.dataset.lane ?? null;

  const down = (e: ReactPointerEvent, key: string, track: string) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    if (tool === "blade") {
      const f = frameAt(e.clientX);
      const ph = Math.round(time * fps);
      onBlade(snap && Math.abs(f - ph) * (pps / fps) < SNAP_PX ? ph : f, key);
      return;
    }
    const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
    // a clip a few px wide (zoomed far out) is moved by its middle half, its ends are the quarters
    const edge = Math.min(EDGE_PX, box.width / 4);
    const grip = e.clientX - box.left < edge ? "head" : box.right - e.clientX < edge ? "tail" : "body";
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
  // a clip's top corner: its fade in (head) or out (tail), this clip alone
  const fade = (e: ReactPointerEvent, key: string, track: string, edge: Edge) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const it = tl.tracks[track].items.find((i) => i._k === key);
    if (!it) return;
    if (!selected.includes(key)) onSelect([key]);
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    drag.current = { key, track, grip: edge === "head" ? "fade-head" : "fade-tail", f0: (edge === "head" ? it.fade_in : it.fade_out) ?? 0, x0: e.clientX, base: tl, moved: false, next: tl, keys: [key] };
  };
  const menu = (e: ReactMouseEvent, key: string) => {
    e.preventDefault();
    if (!selected.includes(key)) onSelect([key]);
    onMenu({ x: e.clientX, y: e.clientY }, key);
  };
  // the clips call through this (one object for good), so a clip that didn't change isn't drawn again
  const ctl = useRef<Ctl>(null!);
  ctl.current = { down, fade, menu };

  const moveTo = (e: ReactPointerEvent) => {
    const p = pan.current;
    const el = scroller.current;
    if (p && el) {
      el.scrollLeft = p.left0 - (e.clientX - p.x0);
      el.scrollTop = p.top0 - (e.clientY - p.y0);
      return;
    }
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
    d.copy = undefined;
    if (d.grip === "fade-head" || d.grip === "fade-tail") {
      next = setFade(d.base, d.key, d.grip === "fade-head" ? "head" : "tail", d.f0! + (d.grip === "fade-head" ? df : -df));
    } else if (d.grip === "body" && tool === "select") {
      if (snap) df = snapDelta([it.rec, endOf(it)], df, targets, tol);
      if (e.altKey) {
        // ⌥: a copy moves, the clips stay (onto the track it is over when it is one of its kind and open)
        const lane = to && to !== d.track && isVideo(to) === isVideo(d.track) && !d.base.tracks[to]?.locked ? to : d.track;
        const clip = copyOf(d.base, d.keys).map((c) => (c.track === d.track ? { ...c, track: lane } : c));
        const got = paste(d.base, clip, Math.max(0, Math.min(...[...linked].map((k) => find(d.base, k)!.item.rec)) + df));
        next = got.tl;
        d.copy = got.keys;
      } else next = move(d.base, d.keys, df, to ? { from: d.track, to } : undefined);
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
    pan.current = null;
    const d = drag.current;
    drag.current = null;
    if (!d?.moved) return;
    onLive(null);
    if (d.next !== d.base) onCommit(d.next);
    if (d.copy?.length && d.next !== d.base) onSelect(d.copy);
  };

  const scrub = (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    onSeek(frameAt(e.clientX) / fps);
  };

  const ph = LABEL_W + time * pps;
  const cursor = tool === "blade" ? "cursor-crosshair" : "";

  const slider = "h-1 w-20 cursor-pointer accent-zinc-300";
  return (
    <Panel title="Timeline" className="flex-1" bar={
      <div className="flex min-w-0 flex-1 items-center gap-1">
        <span className="mx-1 h-4 w-px shrink-0 bg-zinc-700/70" />
        {tools}
        <div className="ml-auto flex min-w-0 items-center gap-2">
          {end}
          <span className="h-4 w-px shrink-0 bg-zinc-700/70" />
          <label className="flex shrink-0 items-center gap-1" title="Track height">
            <Rows3 className="size-3.5" />
            <input type="range" aria-label="Track height" min={0.7} max={2.5} step={0.05} value={scale} onChange={(e) => keepHeight(Number(e.target.value))} className={slider} />
          </label>
          <label className="flex shrink-0 items-center gap-1" title="Zoom (= and -, \ fits the clips)">
            <ZoomIn className="size-3.5" />
            <input type="range" aria-label="Timeline zoom" min={0} max={1000} step={1}
              value={axis.maxZoom > 1 ? Math.round((Math.log(axis.zoom) / Math.log(axis.maxZoom)) * 1000) : 0}
              onChange={(e) => axis.zoomTo(Math.exp((Number(e.target.value) / 1000) * Math.log(Math.max(1, axis.maxZoom))))} className={slider} />
          </label>
        </div>
      </div>
    }>
    <TimelineFrame scroller={scroller} inner={inner} seconds={shown} pps={pps} labelWidth={LABEL_W} rulerHeight={RULER_H}
      className="min-h-0 flex-1 overflow-y-scroll bg-[#151517]" stickyRuler="bg-[#1d1d20] border-b border-black/60"
      ruler={{ onPointerDown: scrub, onPointerMove: (e) => e.buttons === 1 && onSeek(frameAt(e.clientX) / fps), className: "cursor-ew-resize" }}
      rulerLabel={<span className="font-mono text-[11px] tabular-nums text-zinc-300" title="The playhead">{timecode(Math.round(time * fps), fps)}</span>}
      rulerChildren={
        <>
          {marks[0] !== null && marks[1] !== null && (
            <div className="absolute inset-y-0 bg-violet-500/20" style={{ left: (marks[0] / fps) * pps, width: ((marks[1] - marks[0]) / fps) * pps }} />
          )}
          <div className="pointer-events-none absolute bottom-0 z-10 -translate-x-1/2" style={{ left: time * pps }}>
            <div className="h-2.5 w-3 rounded-t-[2px] bg-red-500 [clip-path:polygon(0_0,100%_0,100%_60%,50%_100%,0_60%)]" />
          </div>
        </>
      }
      content={{
        onPointerDown: (e) => {
          const el = scroller.current;
          if (e.button !== 1 || !el) return;
          e.preventDefault();
          e.currentTarget.setPointerCapture(e.pointerId);
          pan.current = { x0: e.clientX, y0: e.clientY, left0: el.scrollLeft, top0: el.scrollTop };
        },
        onPointerMove: moveTo, onPointerUp: up, onPointerCancel: up, className: cn("flex min-h-full flex-col", cursor),
      }}>
      {order.map((id) => {
        const t = tl.tracks[id];
        const v = isVideo(id);
        const off = v ? t.hidden : t.mute;
        const h = laneH(id);
        const n = t.items.length;
        return (
          <div key={id} className="flex border-b border-black/50" style={{ height: h }}>
            {/* Resolve's header: the track's badge, lock and eye (or sound) on top, its name and clip count under */}
            <div className="group/h sticky left-0 z-20 flex shrink-0 flex-col justify-center gap-0.5 overflow-hidden border-r border-black/60 bg-[#1f1f23] py-0.5 pr-1.5 pl-2.5 text-[11px]" style={{ width: LABEL_W }}>
              <span className={cn("absolute inset-y-0 left-0 w-[3px]", v ? "bg-[#3d6e9c]" : "bg-[#2f8a5e]")} />
              <div className="flex items-center gap-0.5">
                <span className="shrink-0 rounded-[3px] border border-[#b04848] bg-[#7a2c2c] px-1 font-mono text-[10px] leading-[14px] font-semibold text-white">{id}</span>
                <span className="flex-1" />
                {id !== "V1" && id !== "A1" && !t.locked && (
                  <button type="button" aria-label={`Remove ${id}`} title={`Remove ${id} and its clips`} onClick={() => onRemoveTrack(id)}
                    className="hidden rounded p-0.5 text-zinc-500 group-hover/h:block hover:bg-zinc-800 hover:text-zinc-200"><X className="size-3" /></button>
                )}
                <button type="button" aria-pressed={!!t.locked} aria-label={t.locked ? `Unlock ${id}` : `Lock ${id}`} title={t.locked ? "Locked" : "Unlocked"}
                  onClick={() => onTrack(id, { locked: t.locked ? undefined : true })}
                  className={cn("rounded p-0.5 hover:bg-zinc-800", t.locked ? "text-amber-400" : "text-zinc-500")}>
                  {t.locked ? <Lock className="size-3.5" /> : <LockOpen className="size-3.5" />}
                </button>
                <button type="button" aria-pressed={!!off} aria-label={v ? (off ? `Show ${id}` : `Hide ${id}`) : off ? `Unmute ${id}` : `Mute ${id}`}
                  title={v ? (off ? "Hidden" : "Shown") : off ? "Muted" : "Heard"}
                  onClick={() => onTrack(id, v ? { hidden: off ? undefined : true } : { mute: off ? undefined : true })}
                  className={cn("rounded p-0.5 hover:bg-zinc-800", off ? "text-amber-400" : "text-zinc-500")}>
                  {v ? (off ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />) : off ? <VolumeX className="size-3.5" /> : <Volume2 className="size-3.5" />}
                </button>
              </div>
              {h >= 36 && <span className="truncate leading-3.5 text-zinc-300" title={t.name ?? id}>{t.name && t.name !== id ? t.name : `${v ? "Video" : "Audio"} ${trackNo(id)}`}</span>}
              {h >= 52 && <span className="leading-3.5 text-zinc-500">{n} {n === 1 ? "Clip" : "Clips"}</span>}
              <span role="separator" aria-orientation="horizontal" aria-label={`${id} height`} title="Drag: this track's height · double click: back to the usual"
                className="absolute inset-x-0 -bottom-px z-10 h-1.5 cursor-row-resize hover:bg-violet-400/60"
                onPointerDown={(e) => {
                  if (e.button !== 0) return;
                  e.stopPropagation();
                  e.preventDefault();
                  e.currentTarget.setPointerCapture(e.pointerId);
                  sizing.current = { id, y0: e.clientY, h0: h };
                }}
                onPointerMove={(e) => {
                  const s = sizing.current;
                  if (s) sizeTrack(s.id, s.h0 + e.clientY - s.y0);
                }}
                onPointerUp={() => void (sizing.current = null)}
                onDoubleClick={() => sizeTrack(id, null)} />
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
                // plain values only: the page hands a new file object every render, and a clip drawn again for every
                // clip on every frame of playback (or of a drag) is what made the timeline lag
                const file = fileOf?.(it.src);
                const sfps = tl.sources[it.src]?.fps || fps;
                const from = it.in / sfps;
                return (
                  <Clip key={it._k} k={it._k!} track={id} video={v} left={(it.rec / fps) * pps} width={(it.len / fps) * pps} height={h}
                    name={nameOf(it)} length={timecode(it.len, fps).replace(/^0:/, "")} on={picked.has(it._k!)} dim={it.enabled === false || !!off}
                    tool={tool} locked={!!t.locked} fadeIn={((it.fade_in ?? 0) / fps) * pps} fadeOut={((it.fade_out ?? 0) / fps) * pps}
                    offline={fileOf && it.fx !== "flash" && (!file || file.why) ? file?.why || "Media offline" : null}
                    path={String(tl.sources[it.src]?.path ?? "")} from={from} to={from + (it.len / fps) * (it.speed || 1)}
                    url={fileOf ? file?.url || null : undefined} still={!!file?.frame} ctl={ctl} />
                );
              })}
            </div>
          </div>
        );
      })}
      {/* under the last track: the headers' column goes on to the bottom */}
      <div className="flex flex-1"><div className="sticky left-0 z-20 shrink-0 border-r border-black/60 bg-[#1f1f23]" style={{ width: LABEL_W }} /></div>
      <div className="pointer-events-none absolute top-0 bottom-0 z-[15] w-px bg-red-500" style={{ left: ph }} />
    </TimelineFrame>
    </Panel>
  );
});


type Ctl = {
  down: (e: ReactPointerEvent, key: string, track: string) => void;
  fade: (e: ReactPointerEvent, key: string, track: string, edge: Edge) => void;
  menu: (e: ReactMouseEvent, key: string) => void;
};

/** Resolve's name bar under a clip, in px; none on a lane too low for it (the name goes on the clip). */
const barOf = (laneH: number) => (laneH >= 30 ? 15 : 0);
/** Resolve's offline clip: a dark red strip of crossed-out film frames. */
const OFFLINE_BG = {
  backgroundImage: `url("data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="36" height="16"><g fill="none" stroke="#c43c3c" stroke-width="1"><rect x="11.5" y="2.5" width="14" height="11"/><path d="M11.5 13.5 25.5 2.5"/></g></svg>')}")`,
  backgroundRepeat: "repeat-x",
  backgroundPosition: "left center",
};
const LOOK = {
  video: { box: "border-[#5d7d9c] bg-[#2b4157]", bar: "bg-[#41607f] text-white" },
  sound: { box: "border-[#3a9a6e] bg-[#1d6b47]", bar: "bg-[#25805a] text-white" },
  offline: { box: "border-[#a32424] bg-[#4a0909]", bar: "bg-[#7d1111] text-red-50" },
};
/** A fade's ramp on the clip: the shade over the part that fades and the line from silence or black up to full. */
const ramp = (side: "left" | "right", px: number) => (
  <svg className="pointer-events-none absolute top-0 h-full" style={{ [side]: 0, width: px }} viewBox="0 0 1 1" preserveAspectRatio="none">
    <path d={side === "left" ? "M0 0H1L0 1Z" : "M0 0H1V1Z"} fill="rgb(0 0 0 / 0.45)" />
    <path d={side === "left" ? "M0 1 1 0" : "M0 0 1 1"} stroke="white" strokeOpacity={0.85} vectorEffect="non-scaling-stroke" />
  </svg>
);

/**
 * One clip as Resolve draws it: a video clip its pictures with a name and length bar along its bottom, a sound clip its
 * waveform, an offline clip dark red with its name (the why on hover). Plain values only, so it is drawn again only when
 * it changes.
 */
const Clip = memo(function Clip({ k, track, video, left, width, height, name, length, on, dim, tool, locked, fadeIn, fadeOut, offline, path, from, to, url, still, ctl }: {
  k: string; track: string; video: boolean; left: number; width: number; height: number; name: string; length: string; on: boolean; dim: boolean;
  tool: Tool; locked: boolean;
  /** the fades, in px */
  fadeIn: number; fadeOut: number;
  /** why its file isn't here, or null when it is */
  offline: string | null;
  /** its source file's path and the seconds of it the clip plays; `url` undefined: the timeline shows no files */
  path: string; from: number; to: number; url: string | null | undefined; still: boolean;
  ctl: MutableRefObject<Ctl>;
}) {
  const w = Math.max(2, width);
  const bar = w > 24 ? barOf(height) : 0;
  const body = height - 2 - bar;
  const look = offline ? LOOK.offline : video ? LOOK.video : LOOK.sound;
  const fades = w > 24 && !locked && tool !== "blade";
  return (
    <div data-clip={k} role="button" aria-pressed={on} aria-label={`${track} ${name}`} title={offline ?? undefined}
      onPointerDown={(e) => ctl.current.down(e, k, track)}
      onContextMenu={(e) => ctl.current.menu(e, k)}
      className={cn("group absolute top-px bottom-px overflow-hidden rounded-[3px] border text-[10px] leading-4 select-none", look.box,
        dim && "opacity-40", tool === "select" ? "cursor-grab" : tool === "trim" ? "cursor-ew-resize" : "")}
      style={{ left, width: w }}>
      <div className="pointer-events-none absolute inset-x-0 top-0" style={{ bottom: bar, ...(offline ? OFFLINE_BG : {}) }}>
        {!offline && url !== undefined && w > 8 && <ClipLook path={path} from={from} to={to} video={video} url={url} still={still} width={w} height={Math.max(1, body)} />}
        {fadeIn > 0 && ramp("left", Math.min(fadeIn, w))}
        {fadeOut > 0 && ramp("right", Math.min(fadeOut, w))}
      </div>
      {bar > 0 ? (
        <div className={cn("pointer-events-none absolute inset-x-0 bottom-0 flex items-center gap-1 px-1", look.bar)} style={{ height: bar }}>
          <span className="min-w-0 flex-1 truncate">{name}</span>
          {w > 70 && <span className="shrink-0 font-mono text-[9px] tabular-nums opacity-80">{length}</span>}
        </div>
      ) : w > 24 && <span className="pointer-events-none relative block truncate px-1 text-white [text-shadow:0_1px_2px_rgb(0_0_0/0.8)]">{name}</span>}
      <span className="absolute inset-y-0 left-0 w-1.5 cursor-ew-resize hover:bg-white/30" />
      <span className="absolute inset-y-0 right-0 w-1.5 cursor-ew-resize hover:bg-white/30" />
      {on && <span className="pointer-events-none absolute inset-0 rounded-[3px] border-2 border-[#ff9d3b]" />}
      {fades && (["head", "tail"] as const).map((edge) => (
        <span key={edge} role="slider" aria-label={edge === "head" ? "Fade in" : "Fade out"} aria-valuenow={Math.round(edge === "head" ? fadeIn : fadeOut)}
          title={edge === "head" ? "Drag: fade in" : "Drag: fade out"}
          onPointerDown={(e) => ctl.current.fade(e, k, track, edge)}
          className={cn("absolute top-0 z-[2] size-2 cursor-ew-resize rounded-[1px] border border-black/60 bg-zinc-100", on ? "block" : "hidden group-hover:block")}
          style={edge === "head" ? { left: Math.max(0, Math.min(w - 8, fadeIn - 4)) } : { right: Math.max(0, Math.min(w - 8, fadeOut - 4)) }} />
      ))}
    </div>
  );
});


const SOUND_FILE = /\.(wav|aif|aiff|m4a|mp3|flac|caf|aac)$/i;
const peakOf = new WeakMap<Float32Array, number>();
const loudestIn = (d: Float32Array) => {
  let p = peakOf.get(d);
  if (p === undefined) peakOf.set(d, (p = d.reduce((a, b) => Math.max(a, b), 0)));
  return p;
};

/** A clip's body: a sound clip's waveform from its sound file, a video clip's pictures along it (a picture a second). */
const ClipLook = memo(function ClipLook({ path, from, to, video, url, still, width, height }: {
  /** the source's file; `from` and `to`: the seconds of it the clip plays */
  path: string; from: number; to: number; video: boolean; url: string | null; still: boolean; width: number; height: number;
}) {
  const [wave, setWave] = useState<Float32Array | null>(null);
  const sound = !video && !!url;
  useEffect(() => {
    if (!sound || !url) return void setWave(null);
    let gone = false;
    // a video file's sound too, unless it is too big to read whole
    peaks(url, SOUND_FILE.test(path) ? undefined : VIDEO_SOUND_BYTES).then((d) => !gone && setWave(d), () => {});
    return () => void (gone = true);
  }, [sound, url, path]);
  const wavePath_ = useMemo(() => wave && wavePath(wave, from, to, loudestIn(wave)), [wave, from, to]);
  const strip = useRef<HTMLCanvasElement>(null);
  const pictures = video && !!url && !still && !/\.(png|jpe?g|webp|gif)$/i.test(path);
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
  if (pictures) return <canvas ref={strip} width={Math.min(Math.ceil(width), 4000)} height={height} className="pointer-events-none absolute inset-0 h-full" style={{ width: Math.min(Math.ceil(width), 4000) }} />;
  if (!wavePath_) return null;
  const path_ = wavePath_;
  return (
    <svg className="pointer-events-none absolute inset-0 size-full text-emerald-100/80" viewBox={`0 -1 ${path_.n} 2`} preserveAspectRatio="none">
      <path d={path_.d} fill="currentColor" />
    </svg>
  );
});
