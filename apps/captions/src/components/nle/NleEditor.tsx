import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from "react";
import { toast } from "sonner";
import { ChevronDown, ChevronRight, Film, Loader2, Magnet, MousePointer2, Music, Pause, Play, Plus, Redo2, Save, Scissors, SkipBack, SkipForward, Undo2, UnfoldHorizontal } from "lucide-react";
import { freshHist, histChange, histRedo, histUndo, type Hist } from "@/lib/edit-history";
import {
  addSource, addTrack, blade, clipAt, clipsFrom, copyOf, duplicate, endOf, extendTo, find, freeTrack, isVideo, lengthOf, linkTogether, move, paste,
  place, remove, removeTrack, rippleToPlayhead, setItems, setTrack, timecode, toSaved, unlink, withKeys, type NleItem, type NleTimeline, type PlaceMode,
} from "@/lib/nle/model";
import { cn } from "@/lib/utils";
import { NleInspector } from "./NleInspector";
import { nleAudio } from "@/lib/nle/audio";
import type { NleFile } from "./NlePlayer";
import { NleLayout, Panel } from "./NleLayout";
import { NleViewer } from "./NleViewer";

export type { NleFile };
import { NleTracks as Timeline, type Tool } from "./NleTracks";

// A non-linear editor for one timeline, laid out as editors are (NleLayout): Media on the left (the timeline's own
// sources, then the page's media bin), the viewer in the middle playing the timeline live from its files, the inspector
// on the right, the timeline across the bottom. It fills the box it is put in. The page gives the timeline, where its
// files play from and what Save does; everything else (edits, undo, keys, playback) is here.

/** A clip from the media bin: its file and what is known of it. */
export interface NleDrop {
  path: string;
  name: string;
  seconds?: number;
  fps?: number;
  w?: number;
  h?: number;
  /** false: a picture with no sound */
  sound?: boolean;
}

export interface NleControl {
  /** a clip from the bin laid at the playhead on V1 (or the In mark) */
  put: (d: NleDrop) => void;
}

let clipboard: { track: string; item: NleItem }[] = [];
/** A drag of one of the timeline's own sources (Media → In this timeline): its key. */
const SOURCE_MIME = "application/x-ct-nle-source";


export function NleEditor({ initial, resetKey, urlOf, onSave, saving, bin, readDrop, control, status, notes, readOnly }: {
  initial: NleTimeline;
  /** a new key opens `initial` afresh (another version); the same key keeps what is being edited */
  resetKey: string;
  /** where a source's file plays from in this browser (null: not here) */
  urlOf: (src: string, tl: NleTimeline) => NleFile | null;
  /** Save (⌘S): the timeline as it is saved; resolves once it is kept */
  onSave: (tl: NleTimeline) => Promise<void>;
  saving?: { line: string; done?: number } | null;
  bin?: ReactNode;
  readDrop?: (dt: DataTransfer) => Promise<NleDrop | null>;
  control?: MutableRefObject<NleControl | null>;
  /** what else the transport row says (files not found here, a save that failed) */
  status?: ReactNode;
  /** what the inspector's Timeline tab says besides the timeline's settings */
  notes?: ReactNode;
  readOnly?: boolean;
}) {
  const [hist, setHist] = useState<Hist<NleTimeline>>(() => freshHist(withKeys(initial)));
  const [saved, setSaved] = useState<NleTimeline>(hist.now);
  const [live, setLive] = useState<NleTimeline | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(1);
  const [tool, setTool] = useState<Tool>("select");
  const [snap, setSnap] = useState(true);
  const [mode, setMode] = useState<PlaceMode>("overwrite");
  const [marks, setMarks] = useState<[number | null, number | null]>([null, null]);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const zoomKeys = useRef<((e: KeyboardEvent) => boolean) | null>(null);

  useEffect(() => {
    const fresh = withKeys(initial);
    setHist(freshHist(fresh));
    setSaved(fresh);
    setLive(null);
    setSelected([]);
    setTime(0);
    setPlaying(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- a new version only
  }, [resetKey]);

  const tl = hist.now;
  const shown = live ?? tl;
  const fps = tl.timeline.fps;
  const end = lengthOf(shown) / fps;
  // the cut's last frame: playing stops on it and End goes to it, so the viewer ends on a picture, never on past-the-end
  const last = Math.max(0, lengthOf(shown) - 1) / fps;
  const dirty = tl !== saved;

  const commit = useCallback((next: NleTimeline) => {
    setLive(null);
    if (readOnly) return;
    setHist((h) => histChange(h, () => next));
  }, [readOnly]);
  const live_ = useCallback((next: NleTimeline | null) => !readOnly && setLive(next), [readOnly]);

  // the clock: the playhead runs on the page's frame clock while playing (backwards for J)
  const timeRef = useRef(time);
  timeRef.current = time;
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    const step = (now: number) => {
      const t = timeRef.current + ((now - last) / 1000) * rate;
      last = now;
      if (t >= last && rate > 0) {
        setTime(last);
        setPlaying(false);
        return;
      }
      if (t <= 0 && rate < 0) {
        setTime(0);
        setPlaying(false);
        return;
      }
      setTime(t);
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [playing, rate, last]);

  const play = (on: boolean, r = 1) => {
    nleAudio();
    if (on && r > 0 && timeRef.current >= last - 0.5 / fps) setTime(0);
    setRate(r);
    setPlaying(on);
  };
  const seek = useCallback((t: number) => setTime(Math.max(0, t)), []);
  const shuttle = (dir: 1 | -1) => {
    const next = !playing || Math.sign(rate) !== dir ? dir : Math.max(-8, Math.min(8, rate * 2));
    play(true, next);
  };

  const urlFor = useCallback((src: string) => urlOf(src, shown), [urlOf, shown]);
  const nameOfSrc = useCallback((src: string) => String(shown.sources[src]?.path ?? src).split("/").pop()!.replace(/\.[^.]+$/, "").replace(/[_-]?%0\d+d/, ""), [shown]);
  const nameOf = useCallback((it: NleItem) => (typeof it.name === "string" && it.name) || (typeof it.line === "string" && it.line ? `${it.line} · ${nameOfSrc(it.src)}` : nameOfSrc(it.src)), [nameOfSrc]);

  // a clip from the bin: its picture on a video track, its sound with it on a free sound track, linked; on a sound
  // track its sound alone
  const lay = (d: NleDrop, at: { track: string; frame: number }) => {
    if (readOnly) return;
    const s = addSource(tl, { path: d.path, fps: d.fps, ...(d.seconds ? { dur: Math.round(d.seconds * (d.fps || fps)) } : {}), w: d.w, h: d.h });
    let next = s.tl;
    // ponytail: a file picked on the computer comes with no length: 5 s, pulled out on the timeline
    const len = Math.max(1, Math.round((d.seconds ?? 5) * fps));
    const item: NleItem = { src: s.src, rec: at.frame, len, in: 0 };
    const clips: { track: string; item: NleItem }[] = [{ track: at.track, item }];
    if (isVideo(at.track) && d.sound !== false) {
      const a = freeTrack(next, "A", at.frame, at.frame + len, at.track === "V1" ? 1 : 2);
      next = a.tl;
      const link = `l${Date.now().toString(36)}`;
      item.link = link;
      clips.push({ track: a.id, item: { ...item } });
    }
    const made = place(next, clips, mode);
    commit(made.tl);
    setSelected(made.keys.slice(0, 1));
  };
  if (control) control.current = { put: (d) => lay(d, { track: "V1", frame: marks[0] ?? Math.round(time * fps) }) };

  const sel = selected.filter((k) => find(tl, k));
  const act = {
    delete: (ripple: boolean) => sel.length && commit(remove(tl, sel, ripple)),
    copy: () => sel.length && (clipboard = copyOf(tl, sel)),
    cut: () => {
      if (!sel.length) return;
      clipboard = copyOf(tl, sel);
      commit(remove(tl, sel));
    },
    paste: () => {
      if (!clipboard.length) return;
      const made = paste(tl, clipboard, Math.round(time * fps), mode);
      commit(made.tl);
      setSelected(made.keys);
    },
    duplicate: () => {
      const made = duplicate(tl, sel);
      if (made.keys.length) commit(made.tl);
      setSelected(made.keys);
    },
    unlink: () => sel.length && commit(unlink(tl, sel)),
    link: () => sel.length > 1 && commit(linkTogether(tl, sel)),
    blade: () => commit(blade(tl, Math.round(time * fps), sel.length ? sel : undefined)),
  };

  const save = async () => {
    if (!dirty || saving || readOnly) return;
    const now = tl;
    try {
      await onSave(toSaved(now));
      setSaved(now);
    } catch {
      // not saved: the page says why, and the timeline stays as it is to save again
    }
  };

  // the edit points, for ↑ and ↓
  const points = useMemo(() => [...new Set([0, ...Object.values(tl.tracks).flatMap((t) => t.items.flatMap((i) => [i.rec, endOf(i)]))])].sort((a, b) => a - b), [tl]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement | null)?.closest?.("input:not([type=range]):not([type=checkbox]), textarea, select, [contenteditable=true], [role=dialog]")) return;
      const k = e.key.toLowerCase();
      const mod = e.metaKey || e.ctrlKey;
      const f = Math.round(time * fps);
      // Y / ⌘Y: the clips from the playhead on / before it, all tracks; with ⌥ only the track under the pointer (or the
      // picked clips' tracks), as Resolve has them
      const pickFrom = (dir: 1 | -1) => {
        const over = document.querySelector<HTMLElement>("[data-lane]:hover")?.dataset.lane;
        const tracks = !e.altKey ? undefined : over ? [over] : sel.length ? [...new Set(sel.map((s) => find(tl, s)!.track))] : ["V1"];
        setSelected(clipsFrom(tl, f, dir, tracks));
      };
      if (e.code === "KeyY" && !e.shiftKey) pickFrom(mod ? -1 : 1);
      else if (mod && k === "s") void save();
      else if (mod && k === "z") setHist(e.shiftKey ? histRedo : histUndo);
      else if (mod && e.key === "\\") act.blade();
      else if (mod && k === "c") act.copy();
      else if (mod && k === "x") act.cut();
      else if (mod && k === "v") act.paste();
      else if (mod && k === "d") act.duplicate();
      else if (mod && k === "b") act.blade();
      else if (mod && k === "a") setSelected(Object.values(tl.tracks).flatMap((t) => t.items.map((i) => i._k!)));
      else if (e.altKey && e.code === "KeyX") setMarks([null, null]);
      else if (mod || e.altKey) return;
      else if (e.key === " ") play(!playing);
      else if (k === "k") play(false);
      else if (k === "l") shuttle(1);
      else if (k === "j") shuttle(-1);
      else if (k === "i") setMarks(([, o]) => [f, o !== null && o > f ? o : null]);
      else if (k === "o") setMarks(([i]) => [i !== null && i < f ? i : null, f]);
      else if (k === "a") setTool("select");
      else if (k === "t") setTool("trim");
      else if (k === "b") setTool("blade");
      else if (k === "n") setSnap((s) => !s);
      // Q / W: ripple-trim the clip under the playhead's start / end to it; E: the picked clip's nearer end to it
      else if (k === "q" && !readOnly) {
        const h = clipAt(tl, f, sel);
        const next = rippleToPlayhead(tl, f, "head", sel);
        commit(next);
        if (h && next !== tl) seek(h.item.rec / fps); // the playhead goes to the cut, where the next shot now starts
      } else if (k === "w" && !readOnly) commit(rippleToPlayhead(tl, f, "tail", sel));
      else if (k === "e" && sel.length) commit(extendTo(tl, sel[0], f));
      else if (k === "d" && sel.length) commit(setItems(tl, sel, { enabled: find(tl, sel[0])!.item.enabled === false ? undefined : false }));
      else if ((e.key === "," || e.key === "<" || e.key === "." || e.key === ">") && sel.length) commit(move(tl, sel, (e.key === "," || e.key === "<" ? -1 : 1) * (e.shiftKey ? 5 : 1)));
      else if (e.key === "Delete" || e.key === "Backspace") act.delete(e.shiftKey);
      else if (e.key === "Escape") setSelected([]);
      else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        play(false);
        seek(time + ((e.key === "ArrowLeft" ? -1 : 1) * (e.shiftKey ? fps : 1)) / fps);
      } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        play(false);
        const p = e.key === "ArrowUp" ? points.filter((x) => x < f).at(-1) : points.find((x) => x > f);
        if (p !== undefined) seek(p / fps);
      } else if (e.key === "Home") seek(0);
      else if (e.key === "End") seek(last);
      else if (k === "z" && e.shiftKey) zoomKeys.current?.(new KeyboardEvent("keydown", { key: "\\" }));
      else if (!zoomKeys.current?.(e)) return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const menuRow = "flex w-full items-center justify-between gap-4 px-3 py-1.5 text-left text-[13px] text-zinc-200 hover:bg-zinc-800 disabled:opacity-40 disabled:hover:bg-transparent";
  const linked = sel.some((k) => find(tl, k)?.item.link !== undefined);
  const iconBtn = (on: boolean) => cn("inline-flex h-6 shrink-0 items-center gap-1 rounded px-1.5 text-[11px]", on ? "bg-zinc-700 text-zinc-50" : "text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100");
  const sep = <span className="mx-1 h-4 w-px shrink-0 bg-zinc-700/70" />;

  // a drop on a lane: one of the timeline's own sources, or what the page reads from its bin
  const dropOn = (dt: DataTransfer, at: { track: string; frame: number }) => {
    const src = dt.getData(SOURCE_MIME);
    const s = src ? tl.sources[src] : undefined;
    if (s?.path) {
      const sfps = s.fps || fps;
      return lay({ path: s.path, name: nameOfSrc(src), fps: s.fps, w: s.w, h: s.h, ...(s.dur ? { seconds: s.dur / sfps } : {}) }, at);
    }
    if (readDrop) void readDrop(dt).then((d) => d && lay(d, at), (e: Error) => toast.error(e.message));
  };

  return (
    <>
      <NleLayout
        media={
          <Panel title="Media" className="flex-1">
            <Sources tl={tl} nameOf={nameOfSrc} here={urlFor} bin={!!bin}
              onPick={(src) => setSelected(Object.values(tl.tracks).flatMap((t) => t.items.filter((i) => i.src === src).map((i) => i._k!)))} />
            {bin && <div className="flex min-h-0 flex-1 flex-col p-2">{bin}</div>}
          </Panel>
        }
        viewer={
          <Panel title="Viewer" className="flex-1" bar={<span className="min-w-0 truncate text-zinc-500">{tl.timeline.name}</span>}>
            <NleViewer tl={shown} time={time} playing={playing} rate={rate} urlOf={urlFor} nameOf={nameOfSrc} onClick={() => play(!playing)}
              clock={
                <span className="font-mono tabular-nums">
                  <span className="text-[13px] text-zinc-100">{timecode(Math.round(time * fps), fps)}</span>
                  <span className="text-zinc-500"> / {timecode(Math.round(end * fps), fps)}</span>
                  {playing && rate !== 1 && <span className="pl-1.5 text-violet-300">{rate}×</span>}
                </span>
              }
              transport={
                <>
                  <button type="button" aria-label="Start" title="Start (Home)" onClick={() => seek(0)} className={cn(iconBtn(false), "w-7 justify-center")}><SkipBack className="size-3.5" /></button>
                  <button type="button" aria-label={playing ? "Pause" : "Play"} title={playing ? "Pause (Space, K)" : "Play (Space, L; J plays back)"} onClick={() => play(!playing)}
                    className="inline-flex size-7 items-center justify-center rounded-full bg-zinc-200 text-zinc-900 hover:bg-white">
                    {playing ? <Pause className="size-3.5 fill-current" /> : <Play className="size-3.5 translate-x-px fill-current" />}
                  </button>
                  <button type="button" aria-label="End" title="End (End)" onClick={() => seek(last)} className={cn(iconBtn(false), "w-7 justify-center")}><SkipForward className="size-3.5" /></button>
                </>
              } />
          </Panel>
        }
        inspector={<NleInspector tl={tl} keys={sel} nameOf={nameOf} onLive={live_} onCommit={commit} notes={notes} />}
        timeline={
          <Timeline tl={shown} time={time} selected={sel} tool={tool} snap={snap} marks={marks} onSeek={seek} onSelect={setSelected}
            onLive={live_} onCommit={commit} nameOf={nameOf} zoomKeys={zoomKeys} fileOf={urlFor}
            onBlade={(f, key) => commit(blade(tl, f, [key]))}
            onMenu={(at) => setMenu(at)}
            onTrack={(id, patch) => commit(setTrack(tl, id, patch))}
            onRemoveTrack={(id) => commit(removeTrack(tl, id))}
            onDrop={readOnly ? undefined : dropOn}
            tools={
              <>
                <button type="button" aria-pressed={tool === "select"} aria-label="Select" title="Select (A): move, trim the ends, ⌥ an end rolls" onClick={() => setTool("select")} className={iconBtn(tool === "select")}><MousePointer2 className="size-3.5" /></button>
                <button type="button" aria-pressed={tool === "trim"} aria-label="Trim" title="Trim (T): slip a clip, ripple-trim the ends, ⌥ an end rolls" onClick={() => setTool("trim")} className={iconBtn(tool === "trim")}><UnfoldHorizontal className="size-3.5" /></button>
                <button type="button" aria-pressed={tool === "blade"} aria-label="Blade" title="Blade (B): a click cuts there" onClick={() => setTool("blade")} className={iconBtn(tool === "blade")}><Scissors className="size-3.5" /></button>
                {sep}
                <span className="inline-flex shrink-0 rounded border border-zinc-700/70 p-0.5" role="group" aria-label="Edit mode">
                  {(["overwrite", "insert"] as const).map((m) => (
                    <button key={m} type="button" aria-pressed={mode === m} onClick={() => setMode(m)}
                      title={m === "overwrite" ? "A clip put on the timeline replaces what is under it" : "A clip put on the timeline pushes what is after it"}
                      className={cn("h-5 rounded-[3px] px-1.5 capitalize", mode === m ? "bg-zinc-700 text-zinc-50" : "text-zinc-400 hover:text-zinc-100")}>{m}</button>
                  ))}
                </span>
                <button type="button" aria-pressed={snap} aria-label="Snapping" title="Snapping (N)" onClick={() => setSnap(!snap)} className={iconBtn(snap)}><Magnet className="size-3.5" /></button>
                {sep}
                <button type="button" title="A video track above the others" disabled={readOnly} onClick={() => commit(addTrack(tl, "V").tl)} className={iconBtn(false)}><Plus className="size-3" />Video</button>
                <button type="button" title="An audio track below the others" disabled={readOnly} onClick={() => commit(addTrack(tl, "A").tl)} className={iconBtn(false)}><Plus className="size-3" />Audio</button>
                {sep}
                <button type="button" aria-label="Undo" title="Undo (⌘Z)" disabled={!hist.past.length} onClick={() => setHist(histUndo)} className={cn(iconBtn(false), "disabled:opacity-30")}><Undo2 className="size-3.5" /></button>
                <button type="button" aria-label="Redo" title="Redo (⇧⌘Z)" disabled={!hist.future.length} onClick={() => setHist(histRedo)} className={cn(iconBtn(false), "disabled:opacity-30")}><Redo2 className="size-3.5" /></button>
              </>
            }
            end={
              <>
                <span className="flex min-w-0 items-center gap-2 truncate">{status}</span>
                {saving && <span className="min-w-0 truncate text-zinc-500">{saving.line}</span>}
                {!readOnly && (
                  <button type="button" disabled={!dirty || !!saving} onClick={() => void save()}
                    title={dirty ? "Save (⌘S): this timeline as this version's newest draft" : "Saved"}
                    className="relative inline-flex h-6 min-w-[5.5rem] shrink-0 items-center justify-center gap-1.5 overflow-hidden rounded bg-violet-600 px-2.5 text-[12px] font-medium text-white hover:bg-violet-500 disabled:bg-zinc-700 disabled:text-zinc-300">
                    {saving?.done ? <span className="absolute inset-y-0 left-0 bg-white/20" style={{ width: `${Math.round(saving.done * 100)}%` }} /> : null}
                    <span className="relative inline-flex items-center gap-1.5">
                      {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
                      {saving ? (saving.done ? `Saving ${Math.round(saving.done * 100)} %` : "Saving") : dirty ? "Save" : "Saved"}
                    </span>
                  </button>
                )}
              </>
            } />
        } />

      {menu && (
        <div className="fixed inset-0 z-50" onPointerDown={() => setMenu(null)} onContextMenu={(e) => { e.preventDefault(); setMenu(null); }}>
          <div role="menu" className="fixed w-52 rounded-md border border-zinc-800 bg-zinc-950 py-1 shadow-xl" style={{ left: menu.x, top: Math.min(menu.y, window.innerHeight - 300) }}
            onPointerDown={(e) => e.stopPropagation()}>
            {([
              ["Cut", "⌘X", act.cut, false],
              ["Copy", "⌘C", act.copy, false],
              ["Paste", "⌘V", act.paste, !clipboard.length],
              ["Duplicate", "⌘D", act.duplicate, false],
              ["Delete", "⌫", () => act.delete(false), false],
              ["Ripple delete", "⇧⌫", () => act.delete(true), false],
              [linked ? "Unlink" : "Link", "", linked ? act.unlink : act.link, !linked && sel.length < 2],
            ] as const).map(([l, key, fn, off]) => (
              <button key={l} type="button" role="menuitem" disabled={off} className={menuRow} onClick={() => { setMenu(null); fn(); }}>
                <span>{l}</span><span className="text-zinc-500">{key}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

/** Media → In this timeline: the sources its clips play, each with how often it is used; a click selects its clips,
 *  a drag lays it on a track. One with no file here has an amber mark. */
function Sources({ tl, nameOf, here, bin, onPick }: {
  tl: NleTimeline; nameOf: (src: string) => string; here: (src: string) => NleFile | null; bin: boolean; onPick: (src: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const uses = new Map<string, { n: number; video: boolean }>();
  for (const [id, t] of Object.entries(tl.tracks)) for (const i of t.items) {
    const u = uses.get(i.src) ?? { n: 0, video: false };
    u.n++;
    u.video ||= isVideo(id);
    uses.set(i.src, u);
  }
  const list = [...uses.entries()].sort((a, b) => nameOf(a[0]).localeCompare(nameOf(b[0])));
  return (
    <div className={cn("flex min-h-0 flex-col border-b border-black/60", bin ? "max-h-[45%] shrink-0" : "flex-1")}>
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}
        className="flex h-7 shrink-0 items-center gap-1.5 px-2 text-[11px] font-medium text-zinc-300 hover:bg-white/[0.03]">
        {open ? <ChevronDown className="size-3.5 text-zinc-500" /> : <ChevronRight className="size-3.5 text-zinc-500" />}
        In this timeline <span className="tabular-nums text-zinc-500">{list.length}</span>
      </button>
      {open && (
        <ul aria-label="In this timeline" className="min-h-0 overflow-x-hidden overflow-y-scroll pb-1">
          {list.map(([src, u]) => {
            const away = !here(src);
            return (
              <li key={src}>
                <button type="button" draggable={!!tl.sources[src]?.path} title={String(tl.sources[src]?.path ?? src)}
                  onDragStart={(e) => { e.dataTransfer.setData(SOURCE_MIME, src); e.dataTransfer.effectAllowed = "copy"; }}
                  onClick={() => onPick(src)}
                  className="flex h-7 w-full min-w-0 items-center gap-2 px-2 text-left text-[12px] text-zinc-300 hover:bg-white/[0.05]">
                  <span className="relative shrink-0 text-zinc-500">
                    {u.video ? <Film className="size-3.5" /> : <Music className="size-3.5" />}
                    {away && <span title="Not found here" className="absolute -top-1 -right-1 size-1.5 rounded-full bg-amber-400" />}
                  </span>
                  <span className={cn("min-w-0 flex-1 truncate", away && "text-zinc-500")}>{nameOf(src)}</span>
                  <span className="shrink-0 tabular-nums text-[11px] text-zinc-500" title={`Used ${u.n} time${u.n === 1 ? "" : "s"}`}>{u.n}</span>
                </button>
              </li>
            );
          })}
          {!list.length && <li className="px-2 py-3 text-[12px] text-zinc-500">Empty</li>}
        </ul>
      )}
      {bin && <div className="flex h-7 shrink-0 items-center border-t border-black/60 px-2 text-[11px] font-medium text-zinc-300">Library</div>}
    </div>
  );
}
