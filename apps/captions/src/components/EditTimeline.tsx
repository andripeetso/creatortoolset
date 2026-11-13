import { useEffect, useMemo, useRef, useState } from "react";
import { Crop, Magnet, Minus, MousePointer2, MoveHorizontal, Palette, Pencil, Plus, Redo2, RotateCcw, Scissors, Smile, SquareDashed, Trash2, Undo2, X } from "lucide-react";
import { SNAP_PX, snapDelta } from "@/lib/clip-drag";
import { TimelineFrame } from "@/components/timeline/TimelineFrame";
import { useTimeAxis } from "@/lib/use-time-axis";
import { PEAKS_PER_SECOND, wavePath } from "@/lib/waveform";
import {
  editedSpan,
  layerFor,
  mediaRoom,
  type ItemEdit,
  type PlaceholderLook,
  type TimelineItem,
  type TimelineView,
} from "@contracts/edit-timeline";

/**
 * A timeline as tracks (Review's timeline editor, and a plug-in's editor page):
 * ruler with line markers and QA flags, one lane per track, a playhead.
 * Click an item to select it (and jump to it), empty space to let go of it;
 * press or drag on the ruler to scrub; a drag on empty lanes draws the
 * comment's range. Keys and wheel as in a video editor: ⌥ + scroll or a pinch zooms, ⌘ or Shift + scroll and a
 * middle-button drag go left and right, = / - zoom, \ fits; every zoom keeps
 * the playhead where it is (the slider too).
 * With `onEdit` (Review) an Edit mode moves (to another layer too), trims,
 * extends and removes items, adds and removes layers and draws placeholders;
 * the page keeps the edits (with undo) and sends them as a comment.
 * `rules` say what whoever makes the next version can make of an edit: an edit nobody would make isn't offered.
 */
const LABEL_W = 72;
const RIGHT = 8;
const TRACK_COLOR: Record<string, string> = {
  V1: "bg-violet-600/70 border-violet-400/60",
  V2: "bg-sky-600/60 border-sky-300/50",
  V3: "bg-amber-500/60 border-amber-300/50",
  V4: "bg-zinc-600/60 border-zinc-400/50",
  A1: "bg-emerald-700/60 border-emerald-400/50",
  A2: "bg-teal-700/60 border-teal-400/50",
  A3: "bg-cyan-800/60 border-cyan-400/50",
};
const MARKER_COLOR: Record<string, string> = {
  Red: "#ef4444", Yellow: "#eab308", Green: "#22c55e", Cyan: "#06b6d4",
  Blue: "#3b82f6", Purple: "#a855f7", Pink: "#ec4899", Lavender: "#a78bfa",
};
const REMOVED = "repeating-linear-gradient(135deg, rgba(239,68,68,.55) 0 4px, rgba(0,0,0,.35) 4px 8px)";
// what an extension adds, so it shows at a glance
const ADDED = "repeating-linear-gradient(45deg, rgba(251,191,36,.55) 0 3px, rgba(251,191,36,.15) 3px 6px)";
// the blade's cursor: a razor
const RAZOR = `url("data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round">'
  + '<g stroke="black" stroke-width="4"><circle cx="6" cy="6" r="3"/><path d="M8.12 8.12 12 12"/><path d="M20 4 8.12 15.88"/><circle cx="6" cy="18" r="3"/><path d="M14.8 14.8 20 20"/></g>'
  + '<g stroke="white" stroke-width="2"><circle cx="6" cy="6" r="3"/><path d="M8.12 8.12 12 12"/><path d="M20 4 8.12 15.88"/><circle cx="6" cy="18" r="3"/><path d="M14.8 14.8 20 20"/></g></svg>',
)}") 12 12, crosshair`;
/** V4 V3 V2 V1 on top, then A1 A2 A3 (as the contract orders them). */
const rank = (id: string) => (id[0] === "V" ? 10 - Number(id.slice(1)) : 10 + Number(id.slice(1)));

/** A span on a lane the reviewer wants something in; id "new" = the one being written. */
export type Placeholder = { id: string; track: string; rec: number; len: number; text?: string; look?: PlaceholderLook; color?: string };
type Mode = "move" | "head" | "tail" | "slip";
/** What can be edited on this timeline (none = everything Edit mode has). */
export interface TimelineRules {
  /** false = this clip is not moved, has that edge dragged, or is slipped */
  can?: (item: TimelineItem, mode: Mode) => boolean;
  /** false = the layers stay as they are: none added or removed, and no clip changes layer */
  layers?: boolean;
}
// the loudest peak of a clip's own sound, found once per array
const peakCache = new WeakMap<Float32Array, number>();
function peakOf(data: Float32Array): number {
  let peak = peakCache.get(data);
  if (peak === undefined) {
    peak = 0;
    for (const v of data) if (v > peak) peak = v;
    peakCache.set(data, peak);
  }
  return peak;
}
type Drag =
  | { kind: "scrub"; tap?: number; lane?: boolean }
  | { kind: "pan"; x0: number; left0: number }
  | { kind: "range"; x0: number; f0: number; f1: number; moved: boolean; outside: boolean }
  | { kind: "item"; it: TimelineItem; mode: Mode | null; x0: number; f0: number; df: number; moved: boolean; lane?: string;
      /** Shift/⌘: add to the picked clips; Option: drag a copy; the picked clips moving with it */
      add?: boolean; dup?: boolean; group?: string[] }
  | { kind: "hole"; ph: Placeholder; mode: Mode | "draw"; x0: number; f0: number; df: number; moved: boolean };

export function EditTimeline({ view, time, onSeek, selected, onSelect, pins, showFlags = true,
  edits, placeholders, onEdit, onPlaceholder, onPickPlaceholder, onReframe, onColor, onFace, range, onRange, onClearRange, waves, history, onLive, marked, onPin, rules }: {
  view: TimelineView;
  /** seconds */
  time: number;
  onSeek: (t: number) => void;
  selected?: string | null;
  /** null = a click on empty space; `editing`: picked in Edit mode (keys like Delete act on it there);
   *  `group`: every clip picked with it (Shift/⌘-click, ⌘A), for one comment about them all */
  onSelect?: (item: TimelineItem | null, editing?: boolean, group?: TimelineItem[]) => void;
  /** a sent comment's other items, ringed with `selected` */
  marked?: string[];
  /** comment count per item key */
  pins?: Record<string, number>;
  /** a count clicked: its comment */
  onPin?: (key: string) => void;
  showFlags?: boolean;
  /** hand edits to draw (the ones being made, or a picked comment's) */
  edits?: ItemEdit[];
  placeholders?: Placeholder[];
  /** set = an Edit button, and edits in Edit mode (absolute move/head/tail/track, or remove), several at once */
  onEdit?: (changes: [TimelineItem, Partial<ItemEdit>][]) => void;
  /** the placeholder being written, moved or resized; null = dropped */
  onPlaceholder?: (p: Placeholder | null) => void;
  /** a sent placeholder was clicked: its comment */
  onPickPlaceholder?: (id: string) => void;
  onReframe?: (item: TimelineItem) => void;
  /** a talent shot's grade (GradePanel) */
  onColor?: (item: TimelineItem) => void;
  /** Face: the face refinement strength on this talent shot, at the playhead (a plug-in that renders it, ReviewTimelineSlot) */
  onFace?: (item: TimelineItem) => void;
  /** the comment's range to draw (seconds, either order) */
  range?: [number, number] | null;
  /** set = a drag across empty lane space draws a range (from where it was pressed to the playhead) */
  onRange?: (from: number, to: number) => void;
  /** a click on empty space outside the range: drop it */
  onClearRange?: () => void;
  /** audio peaks (lib/waveform) by lane ("*" = any other audio lane): the cut's own sound, drawn under each clip's own
   *  span. By a clip's key: that clip's own media from its first second (its span starts `before` frames in), drawn
   *  under the clip and under what its edges are pulled out to */
  waves?: Record<string, Float32Array> | null;
  rules?: TimelineRules;
  /** the page's undo and redo of the unsent edits, with how many steps each way */
  history?: { back: number; ahead: number; undo: () => void; redo: () => void };
  /** an edge or a slip while it's dragged (null when let go): the page plays it live */
  onLive?: (changes: [TimelineItem, Partial<ItemEdit>][] | null) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const [editing, setEditing] = useState(false);
  // Slip (Y): drag a clip to play another part of it where it is
  const [tool, setTool] = useState<"select" | "placeholder" | "blade" | "slip">("select");
  const [snapOn, setSnapOn] = useState(true);
  // where the blade would cut: the frame and the clip under the pointer
  const [bladeAt, setBladeAt] = useState<{ f: number; key: string } | null>(null);
  // several clips picked (Shift/⌘-click, ⌘A), and what ⌘C / ⌘X copied
  const [pickedHere, setPicked] = useState<string[]>([]);
  const [clip, setClip] = useState<{ it: TimelineItem; off: number; head: number; tail: number; track: string }[]>([]);
  const [holePicked, setHolePicked] = useState(false);
  // the Placeholder badge dragged onto a lane
  const [badge, setBadge] = useState<{ x: number; y: number; lane?: string; rec: number } | null>(null);
  const badgeFrom = useRef<{ x: number; y: number } | null>(null);
  const [layers, setLayers] = useState<string[]>([]);
  const [layerMenu, setLayerMenu] = useState(false);
  // audio lanes can be made taller to read the waveform (the audio lanes only)
  const [heights, setHeights] = useState<Record<string, number>>({});
  const resize = useRef<{ lane: string; y0: number; h0: number } | null>(null);
  // the timeline's own right-click menu
  const [menu, setMenu] = useState<{ x: number; y: number; f: number; lane?: string; it?: TimelineItem; onHole?: boolean } | null>(null);
  // the drag lives in a ref (pointer events can outrun renders) and in state (to draw it)
  const [drag, setDragState] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const setDrag = (d: Drag | null) => {
    dragRef.current = d;
    setDragState(d);
  };
  const { fps } = view;
  const seconds = Math.max(view.duration / fps, 0.1);
  // the time axis the app's timelines share (lib/use-time-axis.ts): zoom about the playhead, the wheel and the pinch;
  // a frame gets 16 px at most
  const timeNow = useRef(time);
  timeNow.current = time;
  const { zoom, maxZoom, pps, zoomTo, zoomBy, follow } = useTimeAxis({ scroller, seconds, left: LABEL_W, right: RIGHT, maxPps: fps * 16, now: () => timeNow.current });
  const x = (frames: number) => (frames / fps) * pps;
  const edit = editing && !!onEdit;
  const editOf = Object.fromEntries((edits ?? []).map((e) => [e.key, e]));
  const items = view.tracks.flatMap((t) => t.items);
  const sel = items.find((i) => i.key === selected);
  const hole = placeholders?.find((p) => p.id === "new");
  const picked = !selected ? [] : pickedHere.includes(selected) ? pickedHere : [selected];
  const waveOf = useMemo(() => {
    const out: Record<string, { d: string; n: number }> = {};
    for (const t of view.tracks) {
      const data = t.id[0] === "A" ? waves?.[t.id] ?? waves?.["*"] : undefined;
      if (!data?.length) continue;
      let peak = 0;
      for (const v of data) if (v > peak) peak = v;
      for (const it of t.items) out[it.key] = wavePath(data, it.rec / view.fps, (it.rec + it.len) / view.fps, peak);
    }
    return out;
  }, [waves, view]);
  // lanes: the draft's, the ones added here, and any an edit moves something to
  const lanes = [...new Set([...view.tracks.map((t) => t.id), ...layers, ...(edits ?? []).flatMap((e) => (e.track ? [e.track] : []))])]
    .sort((a, b) => rank(a) - rank(b))
    .map((id) => ({ id, name: view.tracks.find((t) => t.id === id)?.name ?? "NEW LAYER" }));

  // keep the playhead in view while it plays past the edge (only when it moves: a zoom keeps its own spot)
  const lastTime = useRef(time);
  useEffect(() => {
    if (lastTime.current === time) return;
    lastTime.current = time;
    if (zoom > 1 && !drag) follow(time);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- follow reads the axis as it is now
  }, [time, pps, zoom, drag]);

  const removeToggle = (list: TimelineItem[]) => {
    const on = list; // the voice too: a piece out = silence there
    const out = !on.every((i) => editOf[i.key]?.remove);
    onEdit?.(on.map((i) => [i, i.copyOf
      ? { copyOf: undefined, move: undefined, head: undefined, tail: undefined, track: undefined, split: undefined }
      : { remove: out }]));
  };
  useEffect(() => {
    if (!menu && !layerMenu) return;
    const close = (e: Event) => {
      if (e.type === "keydown" && (e as KeyboardEvent).key !== "Escape") return;
      if (e.type === "pointerdown" && (e.target as HTMLElement).closest?.("[data-menu]")) return;
      setMenu(null);
      setLayerMenu(false);
    };
    window.addEventListener("pointerdown", close, true);
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("pointerdown", close, true);
      window.removeEventListener("keydown", close);
    };
  }, [menu, layerMenu]);

  const frameAt = (clientX: number) =>
    Math.round(((clientX - inner.current!.getBoundingClientRect().left - LABEL_W) / pps) * fps);
  const seekFrame = (f: number) => onSeek(Math.max(0, Math.min(seconds, f / fps)));
  const editable = (it: TimelineItem, mode: Mode) =>
    // the talent never moves; the voice moves sideways, never slips
    edit && !editOf[it.key]?.remove && !(it.track === "V1" && (mode === "move" || mode === "slip")) && !(it.track === "A1" && mode === "slip") &&
    (rules?.can?.(it, mode) ?? true);
  const layered = rules?.layers !== false;
  /** A clip's own sound: its own, or that of the clip it was cut or copied from (a piece's `before` counts from the same first second). */
  const ownWave = (it: TimelineItem) => waves?.[it.key] ?? (it.from ? waves?.[it.from] : undefined) ?? (it.copyOf ? waves?.[it.copyOf] : undefined);
  const shape = (it: TimelineItem, now = drag) => {
    const e = editOf[it.key];
    const d = now?.kind === "item" && now.mode && now.moved && !now.dup &&
      (now.it.key === it.key || (now.mode === "move" && now.group?.includes(it.key))) ? now : null;
    const v = { move: e?.move ?? 0, head: e?.head ?? 0, tail: e?.tail ?? 0, slip: e?.slip ?? 0,
      track: d && d.it.key === it.key ? d.lane ?? e?.track : e?.track };
    if (d?.mode === "move") v.move += d.df;
    else if (d?.mode === "head") v.head -= d.df;
    else if (d?.mode === "tail") v.tail += d.df;
    else if (d?.mode === "slip") v.slip -= d.df; // the footage follows the hand: dragged right, an earlier part shows
    if (v.track === it.track) v.track = undefined;
    return v;
  };
  const holeSpan = (ph: Placeholder, now = drag) => {
    if (now?.kind !== "hole" || now.ph.id !== ph.id || !now.moved) return ph;
    const { f0, df, mode } = now;
    if (mode === "draw") return { ...ph, rec: Math.max(0, Math.min(f0, f0 + df)), len: Math.max(1, Math.abs(df)) };
    if (mode === "move") return { ...ph, rec: Math.max(0, ph.rec + df) };
    if (mode === "head") return { ...ph, rec: ph.rec + df, len: ph.len - df };
    return { ...ph, len: ph.len + df };
  };
  // a dragged edge lands on the playhead, a cut, or a line marker when it passes near one
  const snap = (edges: number[], df: number, skip?: string) => {
    if (!snapOn) return df;
    const at = [Math.round(time * fps), ...view.markers.map((m) => m.frame),
      ...items.filter((i) => i.key !== skip).flatMap((i) => [i.rec, i.rec + i.len])];
    return snapDelta(edges, df, at, (SNAP_PX / pps) * fps);
  };

  // ---- editing moves (split and the rest) ----
  const playF = Math.round(time * fps);
  const spanOf = (i: TimelineItem) => editedSpan(i, editOf[i.key]);
  /** Cut these at frame f; a piece's cuts are kept on the item it came from (splitView). */
  const splitAt = (list: TimelineItem[], f: number) => {
    const changes: [TimelineItem, Partial<ItemEdit>][] = [];
    for (const it of list) {
      if (editOf[it.key]?.remove) continue;
      const at = f - (editOf[it.key]?.move ?? 0); // cuts are made before moves: where f is in it as rendered
      const min = it.track === "V1" ? 6 : 1; // the worker leaves no talent piece under 6 frames
      if (at - it.rec < min || it.rec + it.len - at < min) continue;
      const key = it.from ?? it.key;
      changes.push([{ ...it, key }, { split: [...new Set([...(editOf[key]?.split ?? []), at])].sort((a, b) => a - b) }]);
    }
    if (changes.length) onEdit?.(changes);
  };
  /** the picked clips (several with Shift/⌘), else the one the page picked */
  const group = picked.length ? items.filter((i) => picked.includes(i.key)) : sel ? [sel] : [];
  const inPlayhead = (i: TimelineItem) => playF > spanOf(i).rec && playF < spanOf(i).rec + spanOf(i).len;
  const underPlayhead = () => items.filter((i) => i.track !== "A1" && inPlayhead(i));
  // the picked clips the playhead is in, else everything there
  const splitHere = () => splitAt(group.some(inPlayhead) ? group.filter(inPlayhead) : underPlayhead(), playF);
  const trimTo = (list: TimelineItem[], end: "head" | "tail") => {
    const changes: [TimelineItem, Partial<ItemEdit>][] = [];
    for (const it of list) {
      const e = editOf[it.key];
      const s = spanOf(it);
      if (e?.remove) continue;
      const room = mediaRoom(it, e);
      if (end === "head" && playF < s.rec + s.len - 1) changes.push([it, { head: Math.min(room.head, (e?.head ?? 0) + s.rec - playF) }]);
      if (end === "tail" && playF > s.rec) changes.push([it, { tail: Math.min(room.tail, (e?.tail ?? 0) + playF - (s.rec + s.len)) }]);
    }
    if (changes.length) onEdit?.(changes);
  };
  const nudgeBy = (list: TimelineItem[], n: number) => {
    const on = list.filter((i) => editable(i, "move"));
    const step = Math.max(n, ...on.map((i) => -spanOf(i).rec)); // the earliest stops the group at 0:00
    if (on.length) onEdit?.(on.map((i) => [i, { move: (editOf[i.key]?.move ?? 0) + step }]));
  };
  const selectAll = () => {
    const all = items.filter((i) => i.track !== "A1");
    setPicked(all.map((i) => i.key));
    if (all[0]) onSelect?.(all.find((i) => i.key === selected) ?? all[0], true, all);
  };
  // copy and paste: a copy is a new clip (ItemEdit.copyOf) the worker places too; never the talent or its voice
  const copyGroup = () => {
    const list = group.filter((i) => i.track !== "V1" && i.track !== "A1" && !editOf[i.key]?.remove);
    if (!list.length) return false;
    const base = Math.min(...list.map((i) => spanOf(i).rec));
    setClip(list.map((i) => ({ it: i, off: spanOf(i).rec - base, head: editOf[i.key]?.head ?? 0, tail: editOf[i.key]?.tail ?? 0,
      track: editOf[i.key]?.track ?? i.track })));
    return list;
  };
  const place = (list: { it: TimelineItem; start: number; head: number; tail: number; track: string }[]) => {
    const taken = new Set(items.map((i) => i.key));
    const made: [TimelineItem, Partial<ItemEdit>][] = [];
    for (const c of list) {
      let rec = Math.max(0, c.start) + c.head; // its key is where it starts before its own head change
      while (taken.has(`${c.track}:${rec}`)) rec += 1;
      const key = `${c.track}:${rec}`;
      taken.add(key);
      made.push([{ ...c.it, key, track: c.track, copyOf: c.it.key },
        { copyOf: c.it.key, ...(c.head ? { head: c.head } : {}), ...(c.tail ? { tail: c.tail } : {}) }]);
    }
    if (!made.length) return;
    onEdit?.(made);
    setPicked(made.map(([i]) => i.key));
    onSelect?.(made[0][0], true, made.map(([i]) => i));
  };
  /** at frame f; on `lane` when it's a layer of the clip's kind, else where it came from */
  const pasteAt = (f: number, lane?: string) =>
    place(clip.map((c) => ({ ...c, start: f + c.off, track: lane && (lane === c.it.track || (layered && layerFor(c.it.track, lane))) ? lane : c.track })));
  const jumpCut = (dir: 1 | -1) => {
    const cuts = [0, view.duration, ...items.flatMap((i) => [spanOf(i).rec, spanOf(i).rec + spanOf(i).len])];
    const to = dir > 0 ? Math.min(...cuts.filter((c) => c > playF)) : Math.max(...cuts.filter((c) => c < playF));
    if (Number.isFinite(to)) seekFrame(to);
  };
  const resetView = () => {
    zoomTo(1);
    setHeights({});
    if (scroller.current) scroller.current.scrollLeft = 0;
  };

  // keys: = / - zoom, \ fits, ↑ / ↓ the previous / next
  // cut; in Edit mode ⌘B or ⌘K cuts at the playhead, A / B select / blade, N snapping, Q / W (Shift+[ / ])
  // trim the picked clip's start / end to the playhead, , / . nudge it (Shift: 5 frames), Delete takes
  // out the picked item or placeholder, Esc lets go
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest?.("input, textarea, select, [contenteditable=true]")) return;
      const k = e.key.toLowerCase();
      if (edit && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey) {
        const texting = !!window.getSelection()?.toString(); // copying words off the page stays the browser's
        let done = true;
        if (k === "b" || k === "k") splitHere();
        else if (k === "a") selectAll();
        else if (k === "c" && !texting && group.length) done = !!copyGroup();
        else if (k === "x" && !texting && group.length) {
          const copied = copyGroup();
          if (copied) removeToggle(copied);
          done = !!copied;
        } else if (k === "v" && clip.length) pasteAt(playF);
        else done = false;
        if (done) {
          e.preventDefault();
          return;
        }
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "=" || e.key === "+") zoomBy(1.5);
      else if (e.key === "-" || e.key === "_") zoomBy(1 / 1.5);
      else if (e.key === "\\") zoomTo(1);
      else if (e.key === "ArrowUp") jumpCut(-1);
      else if (e.key === "ArrowDown") jumpCut(1);
      else if (edit && k === "n") setSnapOn((v) => !v);
      else if (edit && k === "a") setTool("select");
      else if (edit && k === "b") setTool(tool === "blade" ? "select" : "blade");
      else if (edit && k === "y") setTool(tool === "slip" ? "select" : "slip");
      else if (edit && group.length && (k === "q" || e.key === "{")) trimTo(group, "head");
      else if (edit && group.length && (k === "w" || e.key === "}")) trimTo(group, "tail");
      else if (edit && group.length && (e.key === "," || e.key === "<")) nudgeBy(group, e.shiftKey ? -5 : -1);
      else if (edit && group.length && (e.key === "." || e.key === ">")) nudgeBy(group, e.shiftKey ? 5 : 1);
      else if (edit && (e.key === "Delete" || e.key === "Backspace") && holePicked && hole) {
        onPlaceholder?.(null);
        setHolePicked(false);
      } else if (edit && (e.key === "Delete" || e.key === "Backspace") && group.length) removeToggle(group);
      else if (edit && e.key === "Escape") {
        setTool("select");
        setHolePicked(false);
        setPicked([]);
      } else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // a press on the timeline takes the keys back from a text box: the press itself can't move the focus, it
  // keeps the browser from selecting text
  const release = () => {
    const a = document.activeElement as HTMLElement | null;
    if (a?.matches?.("input:not([type=range]), textarea, [contenteditable=true]")) a.blur();
  };
  const down = (e: React.PointerEvent<HTMLDivElement>) => {
    release();
    if (e.button === 1) { // the middle button drags the view left and right
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      setDrag({ kind: "pan", x0: e.clientX, left0: scroller.current?.scrollLeft ?? 0 });
      return;
    }
    if (e.button !== 0) return;
    const el = e.target as HTMLElement;
    const f = frameAt(e.clientX);
    const mode = (el.closest<HTMLElement>("[data-mode]")?.dataset.mode ?? "move") as Mode;
    const key = el.closest<HTMLElement>("[data-key]")?.dataset.key;
    const lane = el.closest<HTMLElement>("[data-lane]")?.dataset.lane;
    const sent = el.closest<HTMLElement>("[data-sent]")?.dataset.sent;
    const onHole = !!el.closest<HTMLElement>("[data-ph]") && hole;
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault(); // no text selection while dragging
    const it = key ? items.find((i) => i.key === key) : undefined;
    if (sent) {
      onPickPlaceholder?.(sent);
      setDrag(null);
    } else if (onHole && edit) setDrag({ kind: "hole", ph: onHole, mode, x0: e.clientX, f0: f, df: 0, moved: false });
    else if (it && edit && tool === "blade") {
      splitAt([it], f + snap([f], 0));
      setDrag(null);
    } else if (it && tool === "slip" && editable(it, "slip")) {
      setHolePicked(false);
      setPicked([it.key]);
      onSelect?.(it, true);
      const span = spanOf(it);
      // the playhead in the clip, so the picture shows what the slip brings
      if (playF < span.rec || playF >= span.rec + span.len) seekFrame(span.rec);
      setDrag({ kind: "item", it, mode: "slip", x0: e.clientX, f0: f, df: 0, moved: false });
    }
    else if (it) {
      setHolePicked(false);
      const m = editable(it, mode) ? mode : null;
      const moving = m === "move" && picked.length > 1 && picked.includes(it.key) && !e.altKey;
      setDrag({ kind: "item", it, mode: m, x0: e.clientX, f0: f, df: 0, moved: false, add: e.shiftKey || e.metaKey,
        dup: m === "move" && e.altKey && it.track !== "A1", // the voice is never copied
        group: moving ? items.filter((i) => picked.includes(i.key) && editable(i, "move")).map((i) => i.key) : undefined });
    } else if (edit && tool === "placeholder" && lane && lane !== "V1" && lane !== "A1") {
      setDrag({ kind: "hole", ph: { id: "new", track: lane, rec: f, len: 1, look: "card" }, mode: "draw", x0: e.clientX, f0: f, df: 0, moved: false });
    } else if (e.pointerType === "touch") { // a finger may be scrolling the lanes: seek when it lifts
      setDrag({ kind: "scrub", tap: f, lane: !!lane });
    } else {
      seekFrame(f);
      // the ruler scrubs; empty lane space scrubs on a click and draws a range on a drag
      // outside the range or not is decided now: the seek above moves the range's end (the playhead) here
      const outside = !!range && (f < Math.min(...range) * fps - 0.5 || f > Math.max(...range) * fps + 0.5);
      setDrag(lane && onRange ? { kind: "range", x0: e.clientX, f0: f, f1: f, moved: false, outside } : { kind: "scrub" });
    }
  };
  const move = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) {
      if (edit && tool === "blade") {
        const key = (e.target as HTMLElement).closest<HTMLElement>("[data-key]")?.dataset.key;
        const f = frameAt(e.clientX);
        setBladeAt(key ? { key, f: f + snap([f], 0) } : null);
      }
      return;
    }
    if (drag.kind === "pan") {
      if (scroller.current) scroller.current.scrollLeft = drag.left0 - (e.clientX - drag.x0);
      return;
    }
    if (drag.kind === "scrub") return seekFrame(frameAt(e.clientX));
    if (!drag.moved && Math.abs(e.clientX - drag.x0) < 4 && drag.kind !== "item") return;
    if (drag.kind === "range") {
      const f = frameAt(e.clientX);
      const f1 = f + snap([f], 0);
      seekFrame(f1);
      return setDrag({ ...drag, f1, moved: true });
    }
    // a hand never moves quite straight: under 4 px sideways is no move in time (a drag up or down keeps its timing)
    const raw = Math.abs(e.clientX - drag.x0) < 4 ? 0 : Math.round(((e.clientX - drag.x0) / pps) * fps);
    if (drag.kind === "item") {
      // up or down onto another layer of its kind (a B-roll shot onto V3, a sound onto A3...)
      const over = drag.mode === "move"
        ? (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest<HTMLElement>("[data-lane]")?.dataset.lane
        : undefined;
      const lane = over && drag.it.track !== "A1" && (over === drag.it.track || (layered && layerFor(drag.it.track, over))) ? over : drag.lane;
      if (!drag.moved && Math.abs(e.clientX - drag.x0) < 4 && lane === drag.lane) return;
      if (!drag.mode) { // not editable here: a drag from an item scrubs
        seekFrame(frameAt(e.clientX));
        return setDrag({ ...drag, moved: true });
      }
      const { it } = drag;
      const e0 = editOf[it.key];
      const [mv, hd, tl] = [e0?.move ?? 0, e0?.head ?? 0, e0?.tail ?? 0];
      const span = editedSpan(it, e0);
      const edges = drag.mode === "move" ? [span.rec, span.rec + span.len] : drag.mode === "head" ? [span.rec] : [span.rec + span.len];
      let df = raw ? snap(edges, raw, it.key) : 0;
      // an edge stops at its media's first or last frame, a slip where the clip ends
      const room = mediaRoom(it, e0);
      if (drag.mode === "slip") df = Math.min(Math.max(raw, (e0?.slip ?? 0) - room.slip[1]), (e0?.slip ?? 0) - room.slip[0]);
      else if (drag.mode === "move") df = Math.max(df, hd - it.rec - mv,
        ...(drag.group ?? []).map((k) => { const g = items.find((i) => i.key === k)!; const ge = editOf[k]; return (ge?.head ?? 0) - g.rec - (ge?.move ?? 0); }));
      else if (drag.mode === "head") df = Math.min(Math.max(df, hd - it.rec - mv, hd - room.head), it.len + hd + tl - 1);
      else df = Math.min(Math.max(df, 1 - it.len - hd - tl), room.tail - tl);
      const next = { ...drag, df, lane, moved: true };
      if (drag.mode !== "move") onLive?.([[it, shape(it, next)]]);
      return setDrag(next);
    }
    const { ph, mode } = drag;
    const edges = mode === "draw" ? [drag.f0] : mode === "move" ? [ph.rec, ph.rec + ph.len] : mode === "head" ? [ph.rec] : [ph.rec + ph.len];
    let df = snap(edges, raw);
    if (mode === "head") df = Math.min(Math.max(df, -ph.rec), ph.len - 1);
    else if (mode === "tail") df = Math.max(df, 1 - ph.len);
    setDrag({ ...drag, df, moved: true });
  };
  const up = () => {
    const d = dragRef.current;
    setDrag(null);
    if (d?.kind === "item" && d.mode && d.mode !== "move") onLive?.(null);
    if (!d || d.kind === "pan") return;
    if (d.kind === "scrub") {
      if (d.tap !== undefined) seekFrame(d.tap);
      if (d.lane) letGo();
      return;
    }
    if (d.kind === "range") {
      if (d.moved && d.f1 !== d.f0) onRange?.(Math.max(0, d.f0) / fps, Math.max(0, d.f1) / fps);
      else { // a click on empty space lets go of the picked item, and of the range when it's outside it
        letGo();
        if (d.outside) onClearRange?.();
      }
      return;
    }
    if (d.kind === "item") {
      if (!d.moved && d.add) { // Shift/⌘-click: in or out of the group (Edit mode or not: a comment can be about them all)
        const next = picked.includes(d.it.key) ? picked.filter((k) => k !== d.it.key) : [...picked, d.it.key];
        setPicked(next);
        const list = next.map((k) => items.find((i) => i.key === k)!).filter(Boolean);
        onSelect?.(list.at(-1) ?? null, edit, list);
        return;
      }
      if (!d.moved) {
        setPicked([d.it.key]);
        // the frame clicked, not the item's in point: a comment on an item can sit anywhere in it
        onSelect?.(d.it, edit);
        const span = editedSpan(d.it, editOf[d.it.key]);
        seekFrame(Math.max(span.rec, Math.min(span.rec + span.len - 1, d.f0)));
      } else if (d.mode && d.dup) { // Option-drag: a copy where it was dropped, the original stays
        const e = editOf[d.it.key];
        place([{ it: d.it, start: spanOf(d.it).rec + d.df, head: e?.head ?? 0, tail: e?.tail ?? 0, track: d.lane ?? e?.track ?? d.it.track }]);
      } else if (d.mode && d.group) {
        onEdit!(d.group.map((k) => items.find((i) => i.key === k)!).map((i) => [i, { move: (editOf[i.key]?.move ?? 0) + d.df }]));
      } else if (d.mode) {
        onSelect?.(d.it, edit);
        onEdit!([[d.it, shape(d.it, d)]]);
      }
      return;
    }
    if (d.mode === "draw" && !d.moved) { // a click: two seconds from there
      onPlaceholder?.({ ...d.ph, rec: Math.max(0, d.f0), len: 2 * fps });
    } else if (d.moved) onPlaceholder?.(holeSpan(d.ph, d));
    setHolePicked(true); // drawn or clicked: picked, so Delete drops it
    setTool("select");
  };
  const onContext = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!onEdit) return; // the draft page keeps the browser's menu
    e.preventDefault();
    const el = e.target as HTMLElement;
    const key = el.closest<HTMLElement>("[data-key]")?.dataset.key;
    setMenu({
      x: e.clientX, y: e.clientY, f: Math.max(0, frameAt(e.clientX)),
      lane: el.closest<HTMLElement>("[data-lane]")?.dataset.lane,
      it: key ? items.find((i) => i.key === key) : undefined,
      onHole: !!el.closest("[data-ph]"),
    });
  };
  const DROP_LEN = 5 * fps; // a dropped placeholder's length; drag its edges after
  const badgeAt = (x: number, y: number) => {
    const lane = (document.elementFromPoint(x, y) as HTMLElement | null)?.closest<HTMLElement>("[data-lane]")?.dataset.lane;
    const f = frameAt(x);
    const rec = Math.max(0, Math.min(f + snap([f], 0), view.duration - DROP_LEN));
    return { x, y, rec, lane: lane && lane !== "V1" && lane !== "A1" ? lane : undefined };
  };
  const badgeDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    badgeFrom.current = { x: e.clientX, y: e.clientY };
  };
  const badgeMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    const from = badgeFrom.current;
    if (!from || (!badge && Math.hypot(e.clientX - from.x, e.clientY - from.y) < 4)) return;
    setBadge(badgeAt(e.clientX, e.clientY));
  };
  const badgeUp = (e: React.PointerEvent<HTMLButtonElement>) => {
    const was = badge;
    badgeFrom.current = null;
    setBadge(null);
    if (!was) return setTool(tool === "placeholder" ? "select" : "placeholder"); // a click: draw one instead
    const at = badgeAt(e.clientX, e.clientY);
    if (!at.lane) return;
    onPlaceholder?.({ id: "new", track: at.lane, rec: at.rec, len: DROP_LEN, look: "card" });
    setHolePicked(true);
    setTool("select");
  };
  const letGo = () => {
    setPicked([]);
    setHolePicked(false);
    onSelect?.(null);
  };
  const addLayer = (kind: "V" | "A") => {
    const taken = lanes.filter((l) => l.id[0] === kind).map((l) => Number(l.id.slice(1)));
    const n = Math.max(...taken, kind === "V" ? 1 : 1) + 1;
    if (n <= 9) setLayers((l) => [...l, `${kind}${n}`]);
  };
  const dropLayer = (id: string) => {
    const on = items.filter((i) => (editOf[i.key]?.track ?? i.track) === id && !editOf[i.key]?.remove);
    if (on.length) onEdit?.(on.map((i) => [i, { remove: true }]));
    else setLayers((l) => l.filter((x) => x !== id));
  };

  const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
  const btn = "rounded p-1 hover:bg-zinc-900 disabled:opacity-30";
  const tbtn = "flex items-center gap-1 rounded px-1.5 py-0.5 text-zinc-300 hover:bg-zinc-900";
  const holes = [...(placeholders ?? [])].filter((p) => !(badge?.lane && p.id === "new"));
  if (badge?.lane) holes.push({ id: "new", track: badge.lane, rec: badge.rec, len: DROP_LEN, look: "card", text: "Placeholder · 5 s" });
  if (drag?.kind === "hole" && drag.ph.id === "new" && !holes.some((p) => p.id === "new")) holes.push(drag.ph);
  const laneOf = (it: TimelineItem) => shape(it).track ?? it.track;
  /** an edge handle's width: 6 px, never more than a quarter of the clip */
  const grip = (len: number) => Math.max(2, Math.min(6, (x(len) - 1) / 4));
  const zoomPos = maxZoom > 1 ? Math.round((Math.log(zoom) / Math.log(maxZoom)) * 1000) : 0;

  return (
    <div className={`select-none rounded-lg border bg-zinc-950 text-[11px] [&_button]:outline-none ${edit ? "border-violet-500 ring-2 ring-violet-500/40" : "border-zinc-900"}`}>
      <div className="flex items-center gap-2 border-b border-zinc-900 px-2 py-1 text-zinc-500"
        // buttons here don't keep the focus (no ring left on them; Space and Delete stay the timeline's)
        onMouseDown={(e) => {
          if ((e.target as HTMLElement).tagName === "INPUT") return;
          e.preventDefault();
          release();
        }}>
        <span className="font-mono text-zinc-300">{clock(time)}.{String(Math.floor((time % 1) * fps)).padStart(2, "0")}</span>
        <span className="truncate">{view.name}</span>
        {edit && history && (
          <div className="flex shrink-0 items-center gap-0.5">
            <button onClick={history.undo} disabled={!history.back} title="Undo (⌘Z)"
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-zinc-300 hover:bg-zinc-900 disabled:opacity-30">
              <Undo2 className="h-3 w-3" /> {history.back}
            </button>
            <button onClick={history.redo} disabled={!history.ahead} title="Redo (⇧⌘Z)"
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-zinc-300 hover:bg-zinc-900 disabled:opacity-30">
              <Redo2 className="h-3 w-3" /> {history.ahead}
            </button>
          </div>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {onEdit && (
            <>
              {edit && holePicked && hole && (
                <button onClick={() => { onPlaceholder?.(null); setHolePicked(false); }} title="Drop this placeholder (Delete)" className={tbtn}>
                  <Trash2 className="h-3 w-3" /> Delete
                </button>
              )}
              {edit && !holePicked && sel && (
                <>
                  {sel.track === "V1" && onReframe && (
                    <button onClick={() => onReframe(sel)} title="Reframe: zoom and move the picture of this shot (or every shot framed like it)" className={tbtn}>
                      <Crop className="h-3 w-3" /> Reframe
                    </button>
                  )}
                  {sel.track === "V1" && onColor && (
                    <button onClick={() => onColor(sel)} title="Color: grade this shot (or its take, or match the others to it)" className={tbtn}>
                      <Palette className="h-3 w-3" /> Color
                    </button>
                  )}
                  {sel.track === "V1" && onFace && (
                    <button onClick={() => onFace(sel)} title="Face: how strong the face refinement is, on this frame" className={tbtn}>
                      <Smile className="h-3 w-3" /> Face
                    </button>
                  )}
                  <button onClick={() => removeToggle(group.length ? group : [sel])} title={editOf[sel.key]?.remove ? "Put it back" : "Take it out (Delete)"} className={tbtn}>
                    {editOf[sel.key]?.remove ? <Undo2 className="h-3 w-3" /> : <Trash2 className="h-3 w-3" />}
                    {editOf[sel.key]?.remove ? "Put back" : group.length > 1 ? `Delete ${group.length}` : "Delete"}
                  </button>
                </>
              )}
              {edit && (
                <div className="flex rounded border border-zinc-800 p-px">
                  <button onClick={() => setTool("select")} title="Select (A): drag to move, edges to trim"
                    className={`rounded p-1 ${tool !== "blade" && tool !== "slip" ? "bg-zinc-800 text-zinc-50" : "text-zinc-400 hover:text-zinc-200"}`}>
                    <MousePointer2 className="h-3 w-3" />
                  </button>
                  <button onClick={() => setTool(tool === "slip" ? "select" : "slip")}
                    title="Slip (Y): drag a B-roll clip or graphic sideways to play another part of it in the same spot"
                    className={`rounded p-1 ${tool === "slip" ? "bg-zinc-800 text-zinc-50" : "text-zinc-400 hover:text-zinc-200"}`}>
                    <MoveHorizontal className="h-3 w-3" />
                  </button>
                  <button onClick={() => setTool(tool === "blade" ? "select" : "blade")} title="Blade (B): click a clip to cut it there · ⌘B cuts at the playhead"
                    className={`rounded p-1 ${tool === "blade" ? "bg-zinc-800 text-zinc-50" : "text-zinc-400 hover:text-zinc-200"}`}>
                    <Scissors className="h-3 w-3" />
                  </button>
                </div>
              )}
              {edit && (
                <button onClick={() => setSnapOn((v) => !v)} title={`Snapping ${snapOn ? "on" : "off"} (N)`}
                  className={`rounded p-1 ${snapOn ? "text-violet-300" : "text-zinc-600"} hover:bg-zinc-900`}>
                  <Magnet className="h-3 w-3" />
                </button>
              )}
              {edit && onPlaceholder && (
                <button onPointerDown={badgeDown} onPointerMove={badgeMove} onPointerUp={badgeUp}
                  onPointerCancel={() => { badgeFrom.current = null; setBadge(null); }}
                  onClick={(ev) => ev.detail === 0 && setTool(tool === "placeholder" ? "select" : "placeholder")}
                  title="Drag onto a B-roll, graphics or sound lane for a 5 s placeholder (or click, then draw one); then say what goes there"
                  className={`flex touch-none cursor-grab items-center gap-1 rounded px-1.5 py-0.5 ${tool === "placeholder" ? "bg-amber-400 text-black" : "text-zinc-300 hover:bg-zinc-900"}`}>
                  <SquareDashed className="h-3 w-3" /> Placeholder
                </button>
              )}
              <button onClick={() => { setEditing(!editing); setTool("select"); setHolePicked(false); }}
                title="Edit mode: drag items to move them (up or down for another layer), their edges to trim or extend; ⌘Z undoes; your edits go with your next comment"
                className={`flex items-center gap-1 rounded px-1.5 py-0.5 ${editing ? "bg-violet-600 text-white" : "text-zinc-300 hover:bg-zinc-900"}`}>
                <Pencil className="h-3 w-3" /> Edit
              </button>
              <span className="mx-1 h-3 w-px bg-zinc-800" />
            </>
          )}
          <button aria-label="Reset the view" title="Reset the view: the whole cut, audio layers back to their height" onClick={resetView} className={btn}>
            <RotateCcw className="h-3 w-3" />
          </button>
          <button aria-label="Zoom out (-)" disabled={zoom <= 1} onClick={() => zoomBy(1 / 1.5)} className={btn}>
            <Minus className="h-3 w-3" />
          </button>
          <input type="range" aria-label="Zoom" min={0} max={1000} value={zoomPos} disabled={maxZoom <= 1}
            onChange={(e) => zoomTo(Math.exp((Number(e.target.value) / 1000) * Math.log(maxZoom)))}
            // let go of the keys once used: ←/→ stay the timeline's (they zoomed instead)
            onPointerUp={(e) => e.currentTarget.blur()}
            className="hidden h-1 w-24 cursor-pointer accent-violet-500 outline-none sm:block" />
          <button aria-label="Zoom in (=)" disabled={zoom >= maxZoom} onClick={() => zoomBy(1.5)} className={btn}>
            <Plus className="h-3 w-3" />
          </button>
          <button onClick={() => zoomTo(1)} title="Fit the whole cut (\)"
            className="w-8 rounded text-center tabular-nums hover:bg-zinc-900">{zoom < 10 ? zoom.toFixed(1).replace(/\.0$/, "") : Math.round(zoom)}×</button>
        </div>
      </div>
      {/* the frame the app's timelines share: the scroller, the content at the axis's width, the ruler's marks.
          On the ruler here: the Layer button, line markers, QA flags */}
      <TimelineFrame scroller={scroller} inner={inner} seconds={seconds} pps={pps} labelWidth={LABEL_W} right={RIGHT} rulerHeight={28} className="[contain:inline-size]"
        content={{
          className: tool === "placeholder" && edit ? "cursor-crosshair" : drag?.kind === "pan" ? "cursor-grabbing" : "",
          onPointerDown: down, onPointerMove: move, onPointerUp: up, onPointerCancel: () => setDrag(null), onContextMenu: onContext,
        }}
        ruler={{ className: "cursor-ew-resize" }}
        rulerLabel={(
            <>
              {edit && layered && (
                <button data-menu onPointerDown={(e) => e.stopPropagation()} onClick={() => setLayerMenu((v) => !v)}
                  title="Add a video or audio layer"
                  className="flex items-center gap-0.5 rounded border border-zinc-700 px-1.5 py-0.5 text-[10px] text-zinc-200 hover:border-violet-500 hover:bg-zinc-900">
                  <Plus className="h-3 w-3" /> Layer
                </button>
              )}
              {edit && layerMenu && (
                <div data-menu className="absolute left-1 top-7 z-50 w-32 rounded-md border border-zinc-800 bg-zinc-950 py-1 shadow-xl"
                  onPointerDown={(e) => e.stopPropagation()}>
                  {(["V", "A"] as const).map((k) => (
                    <button key={k} onClick={() => { addLayer(k); setLayerMenu(false); }}
                      className="block w-full px-2 py-1 text-left text-zinc-200 hover:bg-zinc-900">{k === "V" ? "Video layer" : "Audio layer"}</button>
                  ))}
                </div>
              )}
            </>
        )}
        rulerChildren={(
            <>
              {view.markers.map((m) => (
                <span key={`${m.frame}-${m.name}`} title={m.name}
                  className="absolute bottom-0 flex h-3.5 max-w-[140px] items-center truncate rounded-sm px-1 text-[9px] font-medium text-black"
                  style={{ left: x(m.frame), background: MARKER_COLOR[m.color ?? ""] ?? "#a1a1aa" }}>
                  {m.name}
                </span>
              ))}
              {showFlags && view.flags.map((f, i) => (
                <span key={i} title={`${f.check}: ${f.what}`} className="absolute top-2 h-2 rounded-full bg-red-500"
                  style={{ left: x(f.rec), width: Math.max(4, x(f.len ?? 1)) }} />
              ))}
            </>
        )}>
          {lanes.map((t) => (
            <div key={t.id} className="group/lane flex border-t border-zinc-900/80" style={{ height: heights[t.id] ?? 28 }}>
              <div className="sticky left-0 z-20 flex shrink-0 items-center gap-1 bg-zinc-950 px-1.5 text-zinc-500"
                style={{ width: LABEL_W }} title={t.name}>
                {t.id[0] === "A" && (
                  <span title="Drag to make this audio layer taller or shorter"
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      e.currentTarget.setPointerCapture(e.pointerId);
                      resize.current = { lane: t.id, y0: e.clientY, h0: heights[t.id] ?? 28 };
                    }}
                    onPointerMove={(e) => {
                      const r = resize.current;
                      if (r) setHeights((h) => ({ ...h, [r.lane]: Math.round(Math.min(160, Math.max(28, r.h0 + e.clientY - r.y0))) }));
                    }}
                    onPointerUp={() => (resize.current = null)}
                    className="absolute inset-x-0 bottom-0 z-10 h-1.5 cursor-row-resize hover:bg-violet-500/50" />
                )}
                <span className="font-mono text-zinc-400">{t.id}</span>
                <span className="truncate text-[9px]">{t.name}</span>
                {edit && layered && t.id !== "V1" && t.id !== "A1" && (
                  <button aria-label={`Remove layer ${t.id}`} title="Remove this layer (takes out what's on it)"
                    onPointerDown={(e) => e.stopPropagation()} onClick={() => dropLayer(t.id)}
                    className="ml-auto hidden rounded text-zinc-500 hover:text-rose-400 group-hover/lane:block">
                    <X className="h-3 w-3" />
                  </button>
                )}
              </div>
              <div data-lane={t.id} className={`relative flex-1 ${
                (drag?.kind === "item" && drag.lane === t.id && drag.lane !== drag.it.track) || badge?.lane === t.id ? "bg-violet-500/10" : ""}`}>
                {drag?.kind === "item" && drag.mode && drag.mode !== "move" && drag.moved && laneOf(drag.it) === t.id && (() => {
                  // all of its media while an edge or a slip is dragged: how far it can go
                  const v = shape(drag.it);
                  const span = editedSpan(drag.it, v);
                  const room = mediaRoom(drag.it, v);
                  const [pre, post] = [room.head - v.head, room.tail - v.tail];
                  const end = Number.isFinite(post) ? x(span.rec + span.len + post) : x(view.duration);
                  return (
                    <span className="pointer-events-none absolute inset-y-0 rounded-[3px] border border-dashed border-sky-300/70 bg-sky-300/10"
                      style={{ left: x(span.rec - pre), width: Math.max(2, end - x(span.rec - pre)) }} />
                  );
                })()}
                {items.filter((it) => laneOf(it) === t.id).map((it) => {
                  const e = editOf[it.key];
                  const v = shape(it);
                  const span = editedSpan(it, v);
                  const changed = span.rec !== it.rec || span.len !== it.len || laneOf(it) !== it.track;
                  const blade = edit && tool === "blade";
                  const slipping = edit && tool === "slip" && editable(it, "slip");
                  const handles = (editable(it, "head") || editable(it, "tail")) && !blade && tool !== "slip";
                  // its own sound reaches under what its edges were pulled out to; the cut's sound only under its own span
                  const own = ownWave(it);
                  let wave: { d: string; n: number; left: number; width: number } | null = null;
                  if (own?.length) {
                    const from = ((it.before ?? 0) + v.slip - v.head) / fps;
                    const [a, b] = [Math.max(0, from), Math.min(own.length / PEAKS_PER_SECOND, from + span.len / fps)];
                    if (b > a) wave = { ...wavePath(own, a, b, peakOf(own)), left: x((a - from) * fps), width: x((b - a) * fps) };
                  } else if (waveOf[it.key]) wave = { ...waveOf[it.key], left: x(v.head), width: x(it.len) };
                  return (
                    <button key={it.key} data-key={it.key}
                      title={`${it.label}${it.detail ? `\n${it.detail}` : ""}`}
                      // a click is handled on pointer up (a drag scrubs or edits); Enter / Space still select
                      onClick={(ev) => ev.detail === 0 && onSelect?.(it, edit)}
                      className={`group absolute inset-y-0.5 overflow-hidden rounded-[3px] border px-1 text-left text-[10px] leading-6 text-white/90 ${
                        TRACK_COLOR[it.track] ?? TRACK_COLOR.V4
                      } ${selected === it.key || picked.includes(it.key) || marked?.includes(it.key) ? "z-10 ring-2 ring-white" : e || changed ? "ring-1 ring-amber-300" : ""} ${
                        edit && it.track !== "V1" && it.track !== "A1" && !e?.remove ? "cursor-grab" : ""}`}
                      style={{ left: x(span.rec), width: Math.max(2, x(span.len) - 1), ...(e?.remove ? { background: REMOVED } : {}),
                        ...(blade ? { cursor: RAZOR } : slipping ? { cursor: "ew-resize" } : {}) }}
                      onPointerLeave={() => blade && setBladeAt(null)}>
                      {blade && bladeAt?.key === it.key && (
                        <span className="pointer-events-none absolute inset-y-0 z-10 w-px bg-white shadow-[0_0_0_1px_rgba(0,0,0,0.6)]"
                          style={{ left: x(bladeAt.f - span.rec) }} />
                      )}
                      {wave && (
                        <svg viewBox={`0 -1 ${wave.n} 2`} preserveAspectRatio="none" aria-hidden
                          className="pointer-events-none absolute top-0.5 h-[calc(100%-4px)] text-white/35"
                          style={{ left: wave.left, width: wave.width }}>
                          <path d={wave.d} fill="currentColor" />
                        </svg>
                      )}
                      {v.head > 0 && <span className="pointer-events-none absolute inset-y-0 left-0" style={{ width: x(v.head), background: ADDED }} />}
                      {v.tail > 0 && <span className="pointer-events-none absolute inset-y-0 right-0" style={{ width: x(v.tail), background: ADDED }} />}
                      <span className={`relative block truncate ${e?.remove ? "line-through opacity-60" : ""}`}>
                        {it.label}{e?.zoom !== undefined ? ` → ${e.zoom.toFixed(2)}×` : ""}
                        {!!v.slip && ` · slip ${v.slip > 0 ? "+" : "−"}${(Math.abs(v.slip) / fps).toFixed(2)} s`}
                      </span>
                      {!!pins?.[it.key] && (
                        <span title={onPin ? "Show its comment" : undefined}
                          onPointerDown={onPin ? (ev) => ev.stopPropagation() : undefined}
                          onClick={onPin ? (ev) => { ev.stopPropagation(); onPin(it.key); } : undefined}
                          className={`absolute right-0.5 top-0.5 z-10 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-amber-400 px-0.5 text-[9px] font-bold leading-none text-black ${
                            onPin ? "cursor-pointer hover:bg-amber-300 hover:ring-2 hover:ring-amber-200" : ""}`}>
                          {pins[it.key]}
                        </span>
                      )}
                      {handles && (
                        <>
                          {/* a short clip keeps a middle to grab and move */}
                          {editable(it, "head") && <span data-mode="head" className="absolute inset-y-0 left-0 cursor-ew-resize group-hover:bg-white/50" style={{ width: grip(span.len) }} />}
                          {editable(it, "tail") && <span data-mode="tail" className="absolute inset-y-0 right-0 cursor-ew-resize group-hover:bg-white/50" style={{ width: grip(span.len) }} />}
                        </>
                      )}
                    </button>
                  );
                })}
                {drag?.kind === "item" && drag.dup && drag.moved && (drag.lane ?? laneOf(drag.it)) === t.id && (
                  <span className="pointer-events-none absolute inset-y-0.5 z-20 rounded-[3px] border-2 border-dashed border-white/80 bg-white/15 text-[10px] leading-6 text-white/90"
                    style={{ left: x(spanOf(drag.it).rec + drag.df), width: Math.max(2, x(spanOf(drag.it).len) - 1) }}>
                    <span className="px-1">+ copy</span>
                  </span>
                )}
                {/* where an edited item was */}
                {items.filter((it) => it.track === t.id).map((it) => {
                  const span = editedSpan(it, shape(it));
                  const changed = span.rec !== it.rec || span.len !== it.len || laneOf(it) !== it.track;
                  return changed && (
                    <span key={`${it.key}-was`} className="pointer-events-none absolute inset-y-0.5 rounded-[3px] border border-dashed border-white/30"
                      style={{ left: x(it.rec), width: Math.max(2, x(it.len) - 1) }} />
                  );
                })}
                {holes.filter((p) => p.track === t.id).map((p) => {
                  const s = holeSpan(p);
                  const mine = p.id === "new";
                  const solid = p.look === "solid";
                  return (
                    <div key={p.id} data-ph={mine ? "" : undefined} data-sent={mine ? undefined : p.id} title={p.text || "Placeholder"}
                      className={`group absolute inset-y-0.5 z-10 overflow-hidden rounded-[3px] border border-dashed px-1 text-[10px] leading-6 ${
                        solid ? "border-white/60 text-white" : "border-amber-300 text-amber-200"} ${
                        p.look === "outline" ? "bg-transparent" : solid ? "" : "bg-amber-300/15"} ${
                        mine && edit ? "cursor-grab" : "cursor-pointer"} ${mine && holePicked ? "ring-2 ring-white" : ""}`}
                      style={{ left: x(s.rec), width: Math.max(4, x(s.len) - 1), ...(solid ? { background: `${p.color ?? "#6d28d9"}cc` } : {}) }}>
                      <span className="block truncate">{p.text || "Placeholder"}</span>
                      {mine && edit && (
                        <>
                          <span data-mode="head" className="absolute inset-y-0 left-0 w-1.5 cursor-ew-resize group-hover:bg-amber-200/60" />
                          <span data-mode="tail" className="absolute inset-y-0 right-0 w-1.5 cursor-ew-resize group-hover:bg-amber-200/60" />
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
          {(() => {
            const band = drag?.kind === "range" && drag.moved ? [drag.f0 / fps, drag.f1 / fps] : range;
            if (!band) return null;
            const [a, b] = [Math.min(...band), Math.max(...band)];
            return (
              <div className="pointer-events-none absolute bottom-0 top-7 z-[5] border-x border-violet-400 bg-violet-500/15"
                style={{ left: LABEL_W + a * pps, width: Math.max(1, (b - a) * pps) }} />
            );
          })()}
          {pps >= 30 && view.words.length > 0 && (
            <div className="flex h-4 border-t border-zinc-900/80">
              <div className="sticky left-0 z-20 shrink-0 bg-zinc-950 px-1.5 text-[9px] text-zinc-600" style={{ width: LABEL_W }}>words</div>
              <div className="relative flex-1">
                {view.words.map((w) => (
                  <span key={`${w.rs}-${w.t}`} className="absolute truncate text-[9px] leading-4 text-zinc-500"
                    style={{ left: x(w.rs), width: Math.max(8, x(w.re - w.rs)) }}>{w.t}</span>
                ))}
              </div>
            </div>
          )}
          <div className="pointer-events-none absolute inset-y-0 z-30 w-px bg-red-400"
            style={{ left: LABEL_W + time * pps }}>
            <div className="absolute -left-[5px] top-0 h-0 w-0 border-x-[5px] border-t-[7px] border-x-transparent border-t-red-400" />
          </div>
      </TimelineFrame>
      {menu && (() => {
        const it = menu.it;
        const may = !!it;
        const lane = menu.lane && menu.lane !== "V1" && menu.lane !== "A1" ? menu.lane : undefined;
        const act = (fn: () => void) => () => {
          setMenu(null);
          fn();
        };
        const row = "block w-full px-3 py-1 text-left text-zinc-200 hover:bg-zinc-800 disabled:opacity-40";
        return (
          <div data-menu className="fixed z-50 w-52 rounded-md border border-zinc-800 bg-zinc-950 py-1 text-[12px] shadow-xl"
            style={{ left: Math.min(menu.x, window.innerWidth - 216), top: Math.min(menu.y, window.innerHeight - 280) }}>
            {menu.onHole && hole && <button className={row} onClick={act(() => { onPlaceholder?.(null); setHolePicked(false); })}>Delete placeholder</button>}
            {it && (
              <>
                <div className="truncate px-3 pb-1 pt-0.5 text-[10px] text-zinc-500">{it.track} · {it.label}</div>
                <button className={row} onClick={act(() => onSelect?.(it, false))}>Comment on this</button>
                {may && <button className={row} onClick={act(() => { setEditing(true); removeToggle(group.some((g) => g.key === it.key) ? group : [it]); })}>
                  {editOf[it.key]?.remove ? "Put back" : group.length > 1 && group.some((g) => g.key === it.key) ? `Delete ${group.length}` : "Delete"}</button>}
                {may && it.track !== "V1" && it.track !== "A1" && (
                  <>
                    <button className={row} onClick={act(() => {
                      if (!group.some((g) => g.key === it.key)) setPicked([it.key]);
                      const e = editOf[it.key];
                      setEditing(true);
                      if (group.some((g) => g.key === it.key)) copyGroup();
                      else setClip([{ it, off: 0, head: e?.head ?? 0, tail: e?.tail ?? 0, track: e?.track ?? it.track }]);
                    })}>Copy (⌘C)</button>
                    <button className={row} onClick={act(() => {
                      const e = editOf[it.key];
                      setEditing(true);
                      place([{ it, start: spanOf(it).rec + spanOf(it).len, head: e?.head ?? 0, tail: e?.tail ?? 0, track: e?.track ?? it.track }]);
                    })}>Duplicate after it</button>
                  </>
                )}
                {it.track === "V1" && onReframe && <button className={row} onClick={act(() => { setEditing(true); onReframe(it); })}>Reframe…</button>}
                {it.track === "V1" && onColor && <button className={row} onClick={act(() => { setEditing(true); onColor(it); })}>Color…</button>}
                {it.track === "V1" && onFace && <button className={row} onClick={act(() => { setEditing(true); onFace(it); })}>Face…</button>}
              </>
            )}
            {it && may && (
              <>
                <div className="my-1 border-t border-zinc-800" />
                <button className={row} onClick={act(() => { setEditing(true); splitAt([it], menu.f); })}>Split here</button>
                <button className={row} disabled={!(playF > spanOf(it).rec && playF < spanOf(it).rec + spanOf(it).len)}
                  onClick={act(() => { setEditing(true); splitAt([it], playF); })}>Split at the playhead (⌘B)</button>
                <button className={row} onClick={act(() => { setEditing(true); trimTo([it], "head"); })}>Trim start to the playhead (Q)</button>
                <button className={row} onClick={act(() => { setEditing(true); trimTo([it], "tail"); })}>Trim end to the playhead (W)</button>
              </>
            )}
            {clip.length > 0 && (
              <button className={row} onClick={act(() => { setEditing(true); pasteAt(menu.f, menu.lane); })}>
                Paste here{clip.length > 1 ? ` (${clip.length})` : ""} (⌘V at the playhead)
              </button>
            )}
            {!it && lane && onPlaceholder && (
              <button className={row} onClick={act(() => {
                setEditing(true);
                onPlaceholder({ id: "new", track: lane, rec: Math.min(menu.f, Math.max(0, view.duration - DROP_LEN)), len: DROP_LEN, look: "card" });
                setHolePicked(true);
              })}>Add a placeholder here (5 s)</button>
            )}
            <div className="my-1 border-t border-zinc-800" />
            {layered && <button className={row} onClick={act(() => { setEditing(true); addLayer("V"); })}>Add a video layer</button>}
            {layered && <button className={row} onClick={act(() => { setEditing(true); addLayer("A"); })}>Add an audio layer</button>}
            {history && (
              <>
                <div className="my-1 border-t border-zinc-800" />
                <button className={row} disabled={!history.back} onClick={act(history.undo)}>Undo{history.back ? ` (${history.back})` : ""}</button>
                <button className={row} disabled={!history.ahead} onClick={act(history.redo)}>Redo{history.ahead ? ` (${history.ahead})` : ""}</button>
              </>
            )}
            <div className="my-1 border-t border-zinc-800" />
            <button className={row} onClick={act(() => { setEditing(!editing); setTool("select"); })}>{editing ? "Leave Edit mode" : "Edit mode"}</button>
          </div>
        );
      })()}
      {badge && (
        <div className="pointer-events-none fixed z-50 flex -translate-x-1/2 -translate-y-1/2 items-center gap-1 rounded border border-dashed border-amber-300 bg-amber-400/90 px-1.5 py-0.5 text-[11px] font-medium text-black shadow-lg"
          style={{ left: badge.x, top: badge.y }}>
          <SquareDashed className="h-3 w-3" /> {badge.lane ? `Placeholder on ${badge.lane}` : "Drop on a lane"}
        </div>
      )}

    </div>
  );
}

/** Where 0:00 and the end sit inside the timeline at 1× (its border included), for a bar above to line up. */
EditTimeline.inset = { left: LABEL_W + 1, right: RIGHT + 1 };
