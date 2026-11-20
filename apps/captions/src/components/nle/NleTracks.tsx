import { memo, useEffect, useRef, useState, type DragEvent as ReactDragEvent, type MouseEvent as ReactMouseEvent, type MutableRefObject, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { ChevronRight, Eye, EyeOff, Lock, LockOpen, Rows3, Volume2, VolumeX, X, ZoomIn } from "lucide-react";
import { TimelineFrame } from "@/components/timeline/TimelineFrame";
import { SNAP_PX, snapDelta } from "@/lib/clip-drag";
import { useTimeAxis } from "@/lib/use-time-axis";
import { addTrack, addTrackAt, boxPick, canDeleteTrack, copyOf, deleteEmptyTracks, deleteTrack, dropPlan, edgesOf, gapAt, endOf, find, isVideo, keepLooks, lengthOf, lookOn, move, moveTarget, moveTrack, paste, roll, setFade, slip, timecode, trackNo, trackOrder, trim, withLinked, type Edge, type Gap, type NleItem, type NleTimeline, type NleTrack } from "@/lib/nle/model";
import { dragging } from "@/lib/nle/drag";
import { cn } from "@/lib/utils";
import { drawWave, idleLevels, levels, type Levels } from "@/lib/waveform";
import type { NleClock } from "@/lib/nle/audio";
import { thumbAt } from "@/lib/nle/thumbs";
import type { NleFile } from "./NlePlayer";
import { Panel } from "./NleLayout";
import { Timecode } from "./NleViewer";

// The editor's timeline: track headers (name, lock, hide or mute, take off), the clips on their lanes, the ruler and the
// playhead. A drag shows its result live (`onLive`) and becomes one step of undo when let go (`onCommit`).
// Select tool: drag a clip to move it (onto any track of its kind; it overwrites what it lands on), ⌥ + drag to move a
// copy and leave it, an end to trim it, ⌥ + an end to roll the cut, a top corner to fade it in or out. Trim tool: drag a clip to slip it, an end to ripple-trim it, ⌥ + an end to roll.
// Blade tool: a click cuts the clip there. A drag on empty space draws a box: every clip it touches is picked (⇧ adds,
// ⌘ flips). With Linked Selection on, a click picks the clip with the clips linked to it (⌥-click: the one alone).
// A right-click on a track header opens the track menu (add, move, delete, lock).
// The panel's title bar carries the editor's tools (`tools`, `end`) and the timeline's own: track height and zoom.

export type Tool = "select" | "trim" | "blade";

const LABEL_W = 152;
const RULER_H = 30;
const HEIGHT_KEY = "ct-nle-track-height";
const LINKED_KEY = "ct-nle-linked-selection";
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
/** Linked Selection (Resolve's chain button, ⇧⌘L): on unless turned off, kept for next time. */
export function useLinkedSelection(): [boolean, () => void] {
  const [on, setOn] = useState(() => {
    try {
      return localStorage.getItem(LINKED_KEY) !== "0";
    } catch {
      return true;
    }
  });
  return [on, () => setOn((v) => (keep(LINKED_KEY, v ? "0" : "1"), !v))];
}
const EDGE_PX = 6;
/** A drop of something whose length isn't known yet is drawn this long while it is dragged. */
const GHOST_SECONDS = 2;
/** The clips' pictures and waveforms are drawn for what shows and half a view either side, on a grid of this many px. */
const DRAW_GRID = 256;
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
  tl, time: paused, clock, selected, tool, snap, marks, onSeek, onSelect, onLive, onCommit, onBlade, onDrop, onMenu, onTrack, onLowerUnderVoice, nameOf, zoomKeys, fileOf, tools, end, linkedSelection = true, gap = null, onGap,
}: {
  tl: NleTimeline;
  /** the playhead at rest (a pause, a seek): a new one draws the timeline again */
  time: number;
  /** the playhead while it plays: moves the playhead lines and the ruler's timecode, never the rest */
  clock: NleClock;
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
  /** a sound track menu's Lower Under Voice… (NleSound.tsx) */
  onLowerUnderVoice?: (track: string) => void;
  nameOf: (it: NleItem) => string;
  /** the timeline's zoom keys (= - \), for the editor's key handler */
  zoomKeys: MutableRefObject<((e: KeyboardEvent) => boolean) | null>;
  /** a source's file here (the player's): sound clips show its waveform, video clips its pictures */
  fileOf?: (src: string) => NleFile | null;
  /** the editor's tools, at the start of the title bar */
  tools?: ReactNode;
  /** at its end, before the track height and zoom (what the save says, Save) */
  end?: ReactNode;
  /** Resolve's Linked Selection: a click picks the clip and the clips linked to it */
  linkedSelection?: boolean;
  /** the gap picked by a click on empty space (ripple deleted with the delete keys) */
  gap?: Gap | null;
  onGap?: (g: Gap | null) => void;
}) {
  const fps = tl.timeline.fps;
  const content = lengthOf(tl) / fps;
  const drag = useRef<Drag | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const time = clock.now();
  // no end: the timeline runs for a day, it opens on (and \ fits) what is on it
  const axis = useTimeAxis({ scroller, seconds: DAY, left: LABEL_W, maxPps: MAX_PPS, now: () => clock.now(), fit: Math.max(10, content * 1.04 + 1), minPps: 0.001 });
  // a browser can't lay out a box much over 30 million px: zoomed in close, the content is drawn for as many hours as
  // fit in 16 million (7 h at a frame's closest), and always past what is on it and the playhead
  const shown = Math.min(DAY, Math.max(MAX_PX / axis.pps, content + 3600, time + 60));
  zoomKeys.current = axis.key;
  const pps = axis.pps;
  // what the clips' pictures and waveforms are drawn for: the zoom and the view once a zoom stops (until then the drawn
  // pictures stretch with their clips, so a zoom step only moves boxes), and the view again once a scroll has gone half
  // a view or stops
  const [view, setView] = useState({ pps: 0, left: 0, width: 0 });
  const viewRef = useRef(view);
  viewRef.current = view;
  const ppsRef = useRef(pps);
  ppsRef.current = pps;
  const takeView = useRef(() => {});
  takeView.current = () => {
    const el = scroller.current;
    if (el) setView({ pps: ppsRef.current, left: el.scrollLeft, width: el.clientWidth });
  };
  useEffect(() => {
    const t = setTimeout(() => takeView.current(), viewRef.current.pps ? 120 : 0);
    return () => clearTimeout(t);
  }, [pps]);
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    let t: ReturnType<typeof setTimeout> | undefined;
    const on = () => {
      clearTimeout(t);
      if (Math.abs(el.scrollLeft - viewRef.current.left) > el.clientWidth / 2) takeView.current();
      else t = setTimeout(() => takeView.current(), 120);
    };
    el.addEventListener("scroll", on, { passive: true });
    return () => {
      el.removeEventListener("scroll", on);
      clearTimeout(t);
    };
  }, []);
  // the playhead kept in view while it moves, and its lines moved, on the clock (nothing else draws again while it plays)
  const follow = useRef(axis.follow);
  follow.current = axis.follow;
  const rulerHead = useRef<HTMLDivElement>(null);
  const laneHead = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- on the time at rest alone
  useEffect(() => follow.current(clock.now()), [paused]);
  useEffect(() => clock.subscribe((t) => {
    const x = t * ppsRef.current;
    if (rulerHead.current) rulerHead.current.style.left = `${x}px`;
    if (laneHead.current) laneHead.current.style.left = `${LABEL_W + x}px`;
    follow.current(t);
  }), [clock]);
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
    // Linked Selection: the clip with its linked clips (its picture and its sound); ⌥: the one clip alone
    const group = linkedSelection && !e.altKey ? withLinked(tl, [key]) : [key];
    if (e.shiftKey || e.metaKey) {
      onSelect(selected.includes(key) ? selected.filter((k) => !group.includes(k)) : [...new Set([...selected, ...group])]);
      return;
    }
    const keys = selected.includes(key) && !e.altKey ? selected : group;
    if (keys !== selected) onSelect(keys);
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
    e.stopPropagation();
    if (!selected.includes(key)) onSelect(linkedSelection ? withLinked(tl, [key]) : [key]);
    onMenu({ x: e.clientX, y: e.clientY }, key);
  };
  // the clips call through this (one object for good), so a clip that didn't change isn't drawn again
  const ctl = useRef<Ctl>(null!);
  ctl.current = { down, fade, menu };

  // a box drawn on empty space: every clip it touches on the tracks it spans (Resolve's), live while it is drawn
  const boxEl = useRef<HTMLDivElement>(null);
  const boxing = useRef<{ x0: number; y0: number; cx: number; lane: string | null; base: string[]; how: "set" | "add" | "flip"; moved: boolean; last: string } | null>(null);
  const startBox = (e: ReactPointerEvent) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest("[data-head]")) return;
    if (tool !== "select") return void (tool === "trim" && !e.shiftKey && onSelect([]));
    const r = inner.current!.getBoundingClientRect();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const how = e.metaKey ? "flip" : e.shiftKey ? "add" : "set";
    boxing.current = { x0: e.clientX - r.left, y0: e.clientY - r.top, cx: e.clientX, lane: (e.target as HTMLElement).closest<HTMLElement>("[data-lane]")?.dataset.lane ?? null, base: how === "set" ? [] : selected, how, moved: false, last: "" };
    // a plain click on empty space lets go of the selection
    if (how === "set" && selected.length) onSelect([]);
  };
  const drawBox = (e: ReactPointerEvent) => {
    const b = boxing.current!;
    const r = inner.current!.getBoundingClientRect();
    const [x, y] = [e.clientX - r.left, e.clientY - r.top];
    if (!b.moved && Math.hypot(x - b.x0, y - b.y0) < 3) return;
    b.moved = true;
    const [l, t, w, h] = [Math.min(x, b.x0), Math.min(y, b.y0), Math.abs(x - b.x0), Math.abs(y - b.y0)];
    const el = boxEl.current;
    if (el) Object.assign(el.style, { display: "block", left: `${l}px`, top: `${t}px`, width: `${w}px`, height: `${h}px` });
    const lanes = [...inner.current!.querySelectorAll<HTMLElement>("[data-lane]")].filter((n) => {
      const lr = n.getBoundingClientRect();
      return lr.bottom - r.top > t && lr.top - r.top < t + h;
    }).map((n) => n.dataset.lane!);
    const hits = boxPick(tl, lanes, ((l - LABEL_W) / pps) * fps, ((l + w - LABEL_W) / pps) * fps);
    const next = b.how === "set" ? hits
      : b.how === "add" ? [...new Set([...b.base, ...hits])]
      : [...b.base.filter((k) => !hits.includes(k)), ...hits.filter((k) => !b.base.includes(k))];
    const id = next.join();
    if (id !== b.last) onSelect(next);
    b.last = id;
  };

  const moveTo = (e: ReactPointerEvent) => {
    const p = pan.current;
    const el = scroller.current;
    if (p && el) {
      el.scrollLeft = p.left0 - (e.clientX - p.x0);
      el.scrollTop = p.top0 - (e.clientY - p.y0);
      return;
    }
    if (boxing.current) return drawBox(e);
    const d = drag.current;
    if (!d) return;
    const px = e.clientX - d.x0;
    const to = laneAt(e.clientX, e.clientY);
    if (!d.moved && Math.abs(px) < 3 && (d.grip !== "body" || !to || to === d.track)) return;
    let df = Math.round((px / pps) * fps);
    const it = d.base.tracks[d.track].items.find((i) => i._k === d.key)!;
    const linked = new Set(withLinked(d.base, d.keys));
    const targets = snap ? [...edgesOf(d.base, linked), Math.round(clock.now() * fps), ...marks.filter((m): m is number => m !== null)] : [];
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
        // the copy looks as the clip does, on whichever track it lands (lookOn)
        const clip = copyOf(d.base, d.keys).map((c) => (c.track === d.track ? { track: lane, item: lookOn(d.base, c.item, c.track, lane) } : c));
        const got = paste(d.base, clip, Math.max(0, Math.min(...[...linked].map((k) => find(d.base, k)!.item.rec)) + df));
        next = got.tl;
        d.copy = got.keys;
      } else next = keepLooks(d.base, move(d.base, d.keys, df, to ? { from: d.track, to } : undefined));
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
    if (boxing.current) {
      const b = boxing.current;
      // a plain click on empty space picks the gap there (Resolve's), a box or a click elsewhere lets it go
      const lane = !b.moved && b.how === "set" ? b.lane : null;
      onGap?.(lane ? gapAt(tl, lane, frameAt(b.cx)) : null);
      boxing.current = null;
      if (boxEl.current) boxEl.current.style.display = "none";
    }
    const d = drag.current;
    drag.current = null;
    if (!d?.moved) return;
    onLive(null);
    if (d.next !== d.base) onCommit(d.next);
    if (d.copy?.length && d.next !== d.base) onSelect(d.copy);
  };

  // the ruler: a press puts the playhead there at once, a drag scrubs every frame (held by the ruler outside it too)
  const scrubbed = useRef(-1);
  const scrubTo = (clientX: number) => {
    const f = frameAt(clientX);
    if (f !== scrubbed.current) onSeek(f / fps);
    scrubbed.current = f;
  };
  const scrub = (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    scrubbed.current = -1;
    scrubTo(e.clientX);
  };

  // where a drop lands (snapped as a move snaps) and the boxes that show it while something is dragged over a track
  const dropFrame = (clientX: number, len: number) => {
    const f = frameAt(clientX);
    if (!snap) return f;
    const targets = [...edgesOf(tl, new Set()), Math.round(clock.now() * fps), ...marks.filter((m): m is number => m !== null)];
    return Math.max(0, f + snapDelta([f, f + len], 0, targets, (SNAP_PX / pps) * fps));
  };
  const ghostEls = [useRef<HTMLDivElement>(null), useRef<HTMLDivElement>(null)];
  const hideGhost = () => ghostEls.forEach((g) => g.current && (g.current.style.display = "none"));
  const showGhost = (e: ReactDragEvent, track: string) => {
    const d = dragging.current;
    if (!d) return hideGhost();
    const len = Math.max(1, Math.round((d.seconds ?? GHOST_SECONDS) * fps));
    const plan = dropPlan(tl, track, dropFrame(e.clientX, len), len, d.sound);
    const r = inner.current!.getBoundingClientRect();
    ghostEls.forEach((g, i) => {
      const el = g.current;
      const p = plan[i];
      const lane = p && inner.current!.querySelector<HTMLElement>(`[data-lane="${p.track}"]`);
      if (!el) return;
      // shortcut: a sound that would get a new track shows no box, the track isn't there yet
      if (!p || !lane) return void (el.style.display = "none");
      const lr = lane.getBoundingClientRect();
      Object.assign(el.style, { display: "block", left: `${LABEL_W + (p.rec / fps) * pps}px`, top: `${lr.top - r.top + 1}px`, width: `${Math.max(2, (p.len / fps) * pps)}px`, height: `${lr.height - 2}px` });
      el.textContent = d.name;
    });
  };
  useEffect(() => {
    const off = () => hideGhost();
    window.addEventListener("dragend", off);
    window.addEventListener("drop", off);
    return () => {
      window.removeEventListener("dragend", off);
      window.removeEventListener("drop", off);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the refs stay
  }, []);

  // the track menu: a right-click on a track header (`id`) or on the empty part of the header column (null)
  const [trackMenu, setTrackMenu] = useState<{ x: number; y: number; id: string | null } | null>(null);
  const openTrackMenu = (e: ReactMouseEvent, id: string | null) => {
    e.preventDefault();
    e.stopPropagation();
    setTrackMenu({ x: e.clientX, y: e.clientY, id });
  };

  const ph = LABEL_W + time * pps;
  const cursor = tool === "blade" ? "cursor-crosshair" : "";

  // the ruler: a timecode on each major tick and small ticks between, for what shows and a view and more either side
  // under a second, steps of frames that divide a second (at 25 fps: 1 and 5), so each label is on a whole second's grid
  const inSecond = Array.from({ length: Math.round(fps) - 1 }, (_, i) => i + 1).filter((n) => Math.round(fps) % n === 0);
  const majorF = [...inSecond, ...[1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1200, 1800, 3600, 7200, 10800].map((s) => Math.round(s * fps))]
    .find((f) => (f / fps) * pps >= 110) ?? Math.round(21600 * fps);
  const majorPx = (majorF / fps) * pps;
  const minorPx = majorPx / [10, 5, 2].find((n) => majorPx / n >= 8)!;
  const vw = view.width || 2000;
  const vl = (scroller.current?.scrollLeft ?? 0) - LABEL_W;
  const ticks: number[] = [];
  for (let k = Math.max(0, Math.floor((vl - 1.5 * vw) / majorPx)); k <= Math.ceil((vl + 2.5 * vw) / majorPx) && (k * majorF) / fps <= shown; k++) ticks.push(k);

  // what of each clip gets its pictures or waveform drawn (clip px), from the view they were last drawn for
  const drawLo = view.left - LABEL_W - view.width / 2;
  const drawHi = view.left - LABEL_W + view.width * 1.5;

  const slider = "h-1 w-20 cursor-pointer accent-zinc-300";
  const headCol = "sticky left-0 z-20 shrink-0 border-r border-black/60 bg-[#1f1f23]";
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
    <TimelineFrame scroller={scroller} inner={inner} seconds={shown} pps={pps} labelWidth={LABEL_W} rulerHeight={RULER_H} noMarks
      className="min-h-0 flex-1 overflow-y-scroll bg-[#151517] select-none" stickyRuler="bg-[#1d1d20] border-b border-black/60"
      ruler={{ onPointerDown: scrub, onPointerMove: (e) => e.buttons === 1 && scrubTo(e.clientX), className: "cursor-ew-resize" }}
      rulerLabel={<span className="font-mono text-[13px] tabular-nums text-zinc-200" title="The playhead"><Timecode clock={clock} fps={fps} /></span>}
      rulerChildren={
        <>
          {ticks.map((k) => (
            <div key={k} className="pointer-events-none absolute inset-y-0 border-l border-zinc-600" style={{
              left: k * majorPx, width: majorPx,
              backgroundImage: `repeating-linear-gradient(to right, transparent 0 ${minorPx - 1}px, rgb(113 113 122 / 0.75) ${minorPx - 1}px ${minorPx}px)`,
              backgroundSize: "100% 6px", backgroundPosition: "bottom", backgroundRepeat: "no-repeat",
            }}>
              <span className="absolute top-[7px] left-1 font-mono text-[10px] leading-none tabular-nums text-zinc-400">{timecode(k * majorF, fps)}</span>
            </div>
          ))}
          {marks[0] !== null && marks[1] !== null && (
            <div className="pointer-events-none absolute inset-y-0 bg-violet-500/20" style={{ left: (marks[0] / fps) * pps, width: ((marks[1] - marks[0]) / fps) * pps }} />
          )}
          <div ref={rulerHead} className="pointer-events-none absolute inset-y-0 z-10" style={{ left: time * pps }}>
            <div className="absolute inset-y-0 left-0 w-px bg-red-500" />
            <div className="absolute top-0 left-px h-[15px] w-[13px] -translate-x-1/2 bg-red-500 [clip-path:polygon(0_0,100%_0,100%_62%,50%_100%,0_62%)]" />
          </div>
        </>
      }
      content={{
        onPointerDown: (e) => {
          const el = scroller.current;
          if (e.button !== 1 || !el) return startBox(e);
          e.preventDefault();
          e.currentTarget.setPointerCapture(e.pointerId);
          pan.current = { x0: e.clientX, y0: e.clientY, left0: el.scrollLeft, top0: el.scrollTop };
        },
        onPointerMove: moveTo, onPointerUp: up, onPointerCancel: up,
        // never the browser's menu in the timeline
        onContextMenu: (e) => e.preventDefault(),
        onDragLeave: (e) => !inner.current?.contains(e.relatedTarget as Node | null) && hideGhost(),
        className: cn("flex min-h-full flex-col", cursor),
      }}>
      {/* Resolve's: room above the video tracks and under the sound tracks, both for a box to start in */}
      <div className="flex flex-1"><div data-head className={headCol} style={{ width: LABEL_W }} onContextMenu={(e) => openTrackMenu(e, null)} /></div>
      {order.map((id) => {
        const t = tl.tracks[id];
        const v = isVideo(id);
        const off = v ? t.hidden : t.mute;
        const h = laneH(id);
        const n = t.items.length;
        return (
          <div key={id} className="flex border-b border-black/50" style={{ height: h }}>
            {/* Resolve's header: the track's badge, lock and eye (or sound) on top, its name and clip count under */}
            <div data-head className="group/h sticky left-0 z-20 flex shrink-0 flex-col justify-center gap-0.5 overflow-hidden border-r border-black/60 bg-[#1f1f23] py-0.5 pr-1.5 pl-2.5 text-[11px]" style={{ width: LABEL_W }}
              onContextMenu={(e) => openTrackMenu(e, id)}>
              <span className={cn("absolute inset-y-0 left-0 w-[3px]", v ? "bg-[#3d6e9c]" : "bg-[#2f8a5e]")} />
              <div className="flex items-center gap-0.5">
                <span className="shrink-0 rounded-[3px] border border-[#b04848] bg-[#7a2c2c] px-1 font-mono text-[10px] leading-[14px] font-semibold text-white">{id}</span>
                <span className="flex-1" />
                {canDeleteTrack(tl, id) && (
                  <button type="button" aria-label={`Remove ${id}`} title={`Remove ${id} and its clips`} onClick={() => onCommit(deleteTrack(tl, id))}
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
              onDragOver={(e) => {
                if (!onDrop || t.locked) return hideGhost();
                e.preventDefault();
                e.dataTransfer.dropEffect = "copy";
                showGhost(e, id);
              }}
              onDrop={(e) => {
                hideGhost();
                if (!onDrop || t.locked) return;
                e.preventDefault();
                const d = dragging.current;
                onDrop(e.dataTransfer, { track: id, frame: dropFrame(e.clientX, d ? Math.max(1, Math.round((d.seconds ?? GHOST_SECONDS) * fps)) : 0) });
              }}>
              {gap?.track === id && (
                <div data-gap className="pointer-events-none absolute inset-y-px rounded-[3px] border-2 border-[#e8483f] bg-white/10"
                  style={{ left: (gap.from / fps) * pps, width: ((gap.to - gap.from) / fps) * pps }} />
              )}
              {t.items.map((it) => {
                // plain values only: the page hands a new file object every render, and a clip drawn again for every
                // clip on every frame of playback (or of a drag) is what made the timeline lag
                const file = fileOf?.(it.src);
                const sfps = tl.sources[it.src]?.fps || fps;
                const from = it.in / sfps;
                const drawW = (it.len / fps) * view.pps;
                const at = (it.rec / fps) * view.pps;
                const x0 = Math.max(0, Math.min(drawW, Math.floor((drawLo - at) / DRAW_GRID) * DRAW_GRID));
                const x1 = Math.max(0, Math.min(drawW, Math.ceil((drawHi - at) / DRAW_GRID) * DRAW_GRID));
                return (
                  <Clip key={it._k} k={it._k!} track={id} video={v} left={(it.rec / fps) * pps} width={(it.len / fps) * pps} height={h}
                    name={nameOf(it)} length={timecode(it.len, fps).replace(/^0:/, "")} on={picked.has(it._k!)} dim={it.enabled === false || !!off}
                    tool={tool} locked={!!t.locked} fadeIn={((it.fade_in ?? 0) / fps) * pps} fadeOut={((it.fade_out ?? 0) / fps) * pps}
                    // a flash is drawn by the player itself, it never needs its file
                    offline={fileOf && it.fx !== "flash" && (!file || file.why) ? file?.why || "Media offline" : null}
                    path={String(tl.sources[it.src]?.path ?? "")} from={from} to={from + (it.len / fps) * (it.speed || 1)}
                    url={fileOf ? file?.url || null : undefined} still={!!file?.frame} drawW={drawW} x0={x0} x1={x1} ctl={ctl} />
                );
              })}
            </div>
          </div>
        );
      })}
      <div className="flex flex-1"><div data-head className={headCol} style={{ width: LABEL_W }} onContextMenu={(e) => openTrackMenu(e, null)} /></div>
      <div ref={laneHead} className="pointer-events-none absolute top-0 bottom-0 z-[15] w-px bg-red-500" style={{ left: ph }} />
      <div ref={boxEl} data-box className="pointer-events-none absolute z-[16] hidden border border-zinc-300/50 bg-zinc-300/15" />
      {ghostEls.map((g, i) => (
        <div key={i} ref={g} data-ghost className="pointer-events-none absolute z-[16] hidden truncate rounded-[3px] border border-white/70 bg-white/20 px-1 text-[10px] leading-4 text-white" />
      ))}
    </TimelineFrame>
    {trackMenu && <TrackMenu tl={tl} {...trackMenu} onClose={() => setTrackMenu(null)} onCommit={onCommit} onTrack={onTrack} onLowerUnderVoice={onLowerUnderVoice}
      onSwap={(a, b) => setHeights((all) => {
        // a moved track takes its height with it
        const next = { ...all };
        delete next[a];
        delete next[b];
        if (all[a] !== undefined) next[b] = all[a];
        if (all[b] !== undefined) next[a] = all[b];
        return next;
      })} />}
    </Panel>
  );
});

const MENU = "rounded-md border border-zinc-800 bg-zinc-950 py-1 shadow-xl";
const MENU_ROW = "flex w-full items-center justify-between gap-4 px-3 py-1.5 text-left text-[13px] text-zinc-200 hover:bg-zinc-800 disabled:opacity-40 disabled:hover:bg-transparent";

/** Resolve's track menu: add a track (above or below this one, or at the ends of its kind), move, delete, lock, hide or mute. */
function TrackMenu({ tl, x, y, id, onClose, onCommit, onTrack, onSwap, onLowerUnderVoice }: {
  tl: NleTimeline; x: number; y: number;
  /** the track right-clicked, null: the empty part of the header column */
  id: string | null;
  onClose: () => void; onCommit: (tl: NleTimeline) => void; onTrack: (id: string, patch: Partial<Omit<NleTrack, "items">>) => void;
  /** two tracks that traded numbers (Move Track): their heights trade too */
  onSwap: (a: string, b: string) => void;
  onLowerUnderVoice?: (track: string) => void;
}) {
  const t = id ? tl.tracks[id] : null;
  // a track keeps its number (the AI Editor reads tracks by number): a new one goes on top / at the bottom, or right
  // above / below this one when that number is free
  const n = id ? trackNo(id) : 0;
  const at = (k: "V" | "A", no: number) => {
    const got = id?.[0] === k ? addTrackAt(tl, k, no) : null;
    return got ? () => onCommit(got.tl) : null;
  };
  const adds: [string, (() => void) | null][] = [
    ["Video Track", () => onCommit(addTrack(tl, "V").tl)],
    ["Audio Track", () => onCommit(addTrack(tl, "A").tl)],
    ["Video Track Above", at("V", n + 1)],
    ["Video Track Below", at("V", n - 1)],
    ["Audio Track Above", at("A", n - 1)],
    ["Audio Track Below", at("A", n + 1)],
  ];
  const moveRow = (label: string, up: boolean): [string, (() => void) | null] => {
    const other = id ? moveTarget(tl, id, up) : null;
    return [label, other ? () => { onCommit(moveTrack(tl, id!, up)); onSwap(id!, other); } : null];
  };
  const empties = deleteEmptyTracks(tl);
  const v = !!id && isVideo(id);
  const rows: ([string, (() => void) | null] | null)[] = [
    null,
    moveRow("Move Track Up", true),
    moveRow("Move Track Down", false),
    null,
    ["Delete Track", id && canDeleteTrack(tl, id) ? () => onCommit(deleteTrack(tl, id)) : null],
    ["Delete Empty Tracks", empties !== tl ? () => onCommit(empties) : null],
    null,
    [t?.locked ? "Unlock Track" : "Lock Track", id ? () => onTrack(id, { locked: t!.locked ? undefined : true }) : null],
    v ? [t!.hidden ? "Enable Video Track" : "Disable Video Track", () => onTrack(id!, { hidden: t!.hidden ? undefined : true })]
      : [t?.mute ? "Unmute Track" : "Mute Track", id ? () => onTrack(id, { mute: t!.mute ? undefined : true }) : null],
    ...(onLowerUnderVoice && id?.startsWith("A") && id !== "A1" ? [null, ["Lower Under Voice…", () => onLowerUnderVoice(id)] as [string, () => void]] : []),
  ];
  const run = (fn: () => void) => () => {
    onClose();
    fn();
  };
  return (
    <div className="fixed inset-0 z-50" onPointerDown={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }}>
      <div role="menu" aria-label="Track" className={cn("fixed w-52", MENU)} style={{ left: x, top: Math.min(y, window.innerHeight - 320) }} onPointerDown={(e) => e.stopPropagation()}>
        <div className="group/sub relative">
          <button type="button" role="menuitem" aria-haspopup="menu" className={MENU_ROW}><span>Add Track</span><ChevronRight className="size-3.5 text-zinc-500" /></button>
          <div role="menu" aria-label="Add Track" className={cn("absolute -top-1 left-full hidden w-48 group-focus-within/sub:block group-hover/sub:block", MENU)}>
            {adds.map(([l, fn]) => <button key={l} type="button" role="menuitem" disabled={!fn} className={MENU_ROW} onClick={fn ? run(fn) : undefined}>{l}</button>)}
          </div>
        </div>
        {rows.map((r, i) => (r ? (
          <button key={r[0]} type="button" role="menuitem" disabled={!r[1]} className={MENU_ROW} onClick={r[1] ? run(r[1]) : undefined}>{r[0]}</button>
        ) : <div key={i} role="separator" className="my-1 h-px bg-zinc-800" />))}
      </div>
    </div>
  );
}


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
const Clip = memo(function Clip({ k, track, video, left, width, height, name, length, on, dim, tool, locked, fadeIn, fadeOut, offline, path, from, to, url, still, drawW, x0, x1, ctl }: {
  k: string; track: string; video: boolean; left: number; width: number; height: number; name: string; length: string; on: boolean; dim: boolean;
  tool: Tool; locked: boolean;
  /** the fades, in px */
  fadeIn: number; fadeOut: number;
  /** why its file isn't here, or null when it is */
  offline: string | null;
  /** its source file's path and the seconds of it the clip plays; `url` undefined: the timeline shows no files */
  path: string; from: number; to: number; url: string | null | undefined; still: boolean;
  /** the clip's width its pictures or waveform are drawn at, and the part of it drawn (px): they stretch with a zoom */
  drawW: number; x0: number; x1: number;
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
      className={// strict containment and content-visibility: a zoom lays out and paints only the clips that show, each on its own
      cn("group absolute top-px bottom-px overflow-hidden rounded-[3px] border text-[10px] leading-4 select-none [contain:strict] [content-visibility:auto]", look.box,
        dim && "opacity-40", tool === "select" ? "cursor-grab" : tool === "trim" ? "cursor-ew-resize" : "")}
      style={{ left, width: w }}>
      <div className="pointer-events-none absolute inset-x-0 top-0" style={{ bottom: bar, ...(offline ? OFFLINE_BG : {}) }}>
        {!offline && url !== undefined && w > 8 && <ClipLook path={path} from={from} to={to} video={video} url={url} still={still} w={drawW} x0={x0} x1={x1} height={Math.max(1, body)} />}
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
      {on && <span className="pointer-events-none absolute inset-0 rounded-[3px] border-2 border-[#e8483f]" />}
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
const WAVE = { peak: "rgb(209 250 229 / 0.45)", rms: "rgb(236 253 245 / 0.92)" };

/**
 * A clip's body: a sound clip's waveform from its sound file, a video clip's pictures along it (a picture a tile), drawn
 * on one canvas for the part `x0`…`x1` of the clip as wide as `w` px. The canvas is placed in % of the clip, so a zoom
 * stretches it until the timeline draws it again for the new width.
 */
const ClipLook = memo(function ClipLook({ path, from, to, video, url, still, w, x0, x1, height }: {
  /** the source's file; `from` and `to`: the seconds of it the clip plays */
  path: string; from: number; to: number; video: boolean; url: string | null; still: boolean; w: number; x0: number; x1: number; height: number;
}) {
  const [wave, setWave] = useState<Levels | null>(null);
  const sound = !video && !!url;
  useEffect(() => {
    if (!sound || !url) return void setWave(null);
    let gone = false;
    // a video file's sound too, unless it is too big to read whole, and only while nothing plays (waveform.ts idleLevels)
    (SOUND_FILE.test(path) ? levels(url) : idleLevels(url, VIDEO_SOUND_BYTES)).then((d) => !gone && setWave(d), () => {});
    return () => void (gone = true);
  }, [sound, url, path]);
  const canvas = useRef<HTMLCanvasElement>(null);
  const pictures = video && !!url && !still && !/\.(png|jpe?g|webp|gif)$/i.test(path);
  const span = x1 - x0;
  const shows = span >= 1 && w > 0 && (pictures || !!wave);
  useEffect(() => {
    const c = canvas.current;
    if (!shows || !c) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.ceil(span * dpr);
    c.height = Math.ceil(height * dpr);
    const g = c.getContext("2d");
    if (!g) return;
    const sec = (x: number) => from + ((to - from) * x) / w;
    if (!pictures) return void drawWave(g, wave!, sec(x0), sec(x1), c.width, c.height, WAVE);
    let gone = false;
    const tile = Math.max(8, Math.round(height * 0.75));
    for (let i = Math.floor(x0 / tile); i * tile < x1; i++) {
      void thumbAt(url!, Math.floor(sec(i * tile))).then((b) => {
        if (gone || !b) return;
        // a picture filling its tile, cut to it
        const s = Math.max(tile / b.width, height / b.height) * dpr;
        g.save();
        g.beginPath();
        g.rect((i * tile - x0) * dpr, 0, tile * dpr, height * dpr);
        g.clip();
        g.drawImage(b, (i * tile - x0 + tile / 2) * dpr - (b.width * s) / 2, (height * dpr - b.height * s) / 2, b.width * s, b.height * s);
        g.restore();
      });
    }
    return () => void (gone = true);
  }, [shows, pictures, wave, url, from, to, w, x0, x1, span, height]);
  if (!shows) return null;
  return <canvas ref={canvas} className="pointer-events-none absolute top-0 h-full" style={{ left: `${(x0 / w) * 100}%`, width: `${(span / w) * 100}%` }} />;
});
