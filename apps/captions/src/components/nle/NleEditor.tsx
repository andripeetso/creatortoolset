import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from "react";
import { toast } from "sonner";
import { Loader2, Magnet, MousePointer2, Pause, Play, Plus, Redo2, Save, Scissors, SkipBack, SkipForward, Undo2, UnfoldHorizontal } from "lucide-react";
import { freshHist, histChange, histRedo, histUndo, type Hist } from "@/lib/edit-history";
import {
  addSource, addTrack, blade, copyOf, duplicate, endOf, find, freeTrack, isVideo, lengthOf, linkTogether, paste, place, remove,
  removeTrack, setTrack, toSaved, unlink, withKeys, type NleItem, type NleTimeline, type PlaceMode,
} from "@/lib/nle/model";
import { cn } from "@/lib/utils";
import { NleInspector } from "./NleInspector";
import { nleAudio } from "@/lib/nle/audio";
import { NlePlayer, type NleFile } from "./NlePlayer";

export type { NleFile };
import { NleTracks as Timeline, type Tool } from "./NleTracks";

// A non-linear editor for one timeline: the media bin (the page's own) on the left, the viewer in the middle playing the
// timeline live from its files, the inspector on the right, the timeline below. The page gives the timeline, where its
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

const tc = (f: number, fps: number) => {
  const s = Math.floor(f / fps);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}:${String(Math.round(f % fps)).padStart(2, "0")}`;
};

export function NleEditor({ initial, resetKey, urlOf, onSave, saving, bin, readDrop, control, status, readOnly }: {
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
      if (t >= end && rate > 0) {
        setTime(end);
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
  }, [playing, rate, end]);

  const play = (on: boolean, r = 1) => {
    nleAudio();
    if (on && r > 0 && timeRef.current >= end - 0.5 / fps) setTime(0);
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
      if ((e.target as HTMLElement | null)?.closest?.("input, textarea, select, [contenteditable=true], [role=dialog]")) return;
      const k = e.key.toLowerCase();
      const mod = e.metaKey || e.ctrlKey;
      const f = Math.round(time * fps);
      if (mod && k === "s") void save();
      else if (mod && k === "z") setHist(e.shiftKey ? histRedo : histUndo);
      else if (mod && k === "y") setHist(histRedo);
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
      else if (e.key === "Delete" || e.key === "Backspace") act.delete(e.shiftKey);
      else if (e.key === "Escape") setSelected([]);
      else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        play(false);
        seek(time + ((e.key === "ArrowLeft" ? -1 : 1) * (e.shiftKey ? 10 : 1)) / fps);
      } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        play(false);
        const p = e.key === "ArrowUp" ? points.filter((x) => x < f).at(-1) : points.find((x) => x > f);
        if (p !== undefined) seek(p / fps);
      } else if (e.key === "Home") seek(0);
      else if (e.key === "End") seek(end);
      else if (k === "z" && e.shiftKey) zoomKeys.current?.(new KeyboardEvent("keydown", { key: "\\" }));
      else if (!zoomKeys.current?.(e)) return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const menuRow = "flex w-full items-center justify-between gap-4 px-3 py-1.5 text-left text-[13px] text-zinc-200 hover:bg-zinc-800 disabled:opacity-40 disabled:hover:bg-transparent";
  const linked = sel.some((k) => find(tl, k)?.item.link !== undefined);
  const iconBtn = (on: boolean) => cn("inline-flex h-7 items-center gap-1 rounded px-1.5 text-xs", on ? "bg-zinc-700 text-zinc-50" : "text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100");

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col gap-2">
      <div className={cn("grid min-h-0 gap-2", bin ? "lg:grid-cols-[260px_minmax(0,1fr)_300px]" : "lg:grid-cols-[minmax(0,1fr)_300px]")}>
        {bin && <aside className="h-[48vh] min-h-[240px] overflow-y-auto rounded-lg border border-zinc-900 bg-zinc-950/60 p-2">{bin}</aside>}
        <div className="relative flex h-[48vh] min-h-[240px] items-center justify-center overflow-hidden rounded-lg border border-zinc-900 bg-black"
          onClick={() => play(!playing)}>
          <NlePlayer tl={shown} time={time} playing={playing} rate={rate} urlOf={urlFor} nameOf={nameOfSrc} className="h-full max-h-full max-w-full" />
        </div>
        <aside aria-label="Inspector" className="h-[48vh] min-h-[240px] overflow-x-hidden overflow-y-auto rounded-lg border border-zinc-900 bg-zinc-950/60 p-3 [scrollbar-gutter:stable]">
          <NleInspector tl={tl} keys={sel} nameOf={nameOf} onLive={live_} onCommit={commit} />
        </aside>
      </div>

      <div className="flex flex-wrap items-center gap-1 text-xs text-zinc-400">
        <button type="button" aria-label="Start" title="Start (Home)" onClick={() => seek(0)} className={iconBtn(false)}><SkipBack className="size-3.5" /></button>
        <button type="button" aria-label={playing ? "Pause" : "Play"} title={playing ? "Pause (Space)" : "Play (Space)"} onClick={() => play(!playing)}
          className="inline-flex size-7 items-center justify-center rounded-md border border-zinc-800 text-zinc-100 hover:bg-zinc-800">
          {playing ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
        </button>
        <button type="button" aria-label="End" title="End (End)" onClick={() => seek(end)} className={iconBtn(false)}><SkipForward className="size-3.5" /></button>
        <span className="ml-1 font-mono tabular-nums text-zinc-200">{tc(Math.round(time * fps), fps)}</span>
        <span className="font-mono tabular-nums text-zinc-600">/ {tc(Math.round(end * fps), fps)}</span>
        {playing && rate !== 1 && <span className="tabular-nums text-violet-300">{rate}×</span>}
        <span className="mx-1 h-4 w-px bg-zinc-800" />
        <button type="button" aria-pressed={tool === "select"} title="Select (A): move, trim the ends, ⌥ an end rolls" onClick={() => setTool("select")} className={iconBtn(tool === "select")}><MousePointer2 className="size-3.5" /></button>
        <button type="button" aria-pressed={tool === "trim"} title="Trim (T): slip a clip, ripple-trim the ends, ⌥ an end rolls" onClick={() => setTool("trim")} className={iconBtn(tool === "trim")}><UnfoldHorizontal className="size-3.5" /></button>
        <button type="button" aria-pressed={tool === "blade"} title="Blade (B): a click cuts there" onClick={() => setTool("blade")} className={iconBtn(tool === "blade")}><Scissors className="size-3.5" /></button>
        <span className="ml-1 inline-flex rounded-md border border-zinc-800 p-0.5">
          {(["overwrite", "insert"] as const).map((m) => (
            <button key={m} type="button" aria-pressed={mode === m} onClick={() => setMode(m)}
              title={m === "overwrite" ? "A clip put on the timeline replaces what is under it" : "A clip put on the timeline pushes what is after it"}
              className={cn("rounded px-1.5 py-0.5 capitalize", mode === m ? "bg-zinc-700 text-zinc-50" : "text-zinc-400 hover:text-zinc-100")}>{m}</button>
          ))}
        </span>
        <button type="button" aria-pressed={snap} title="Snapping (N)" onClick={() => setSnap(!snap)} className={iconBtn(snap)}><Magnet className="size-3.5" /></button>
        <span className="mx-1 h-4 w-px bg-zinc-800" />
        <button type="button" title="A video track above the others" disabled={readOnly} onClick={() => commit(addTrack(tl, "V").tl)} className={iconBtn(false)}><Plus className="size-3" />Video</button>
        <button type="button" title="An audio track below the others" disabled={readOnly} onClick={() => commit(addTrack(tl, "A").tl)} className={iconBtn(false)}><Plus className="size-3" />Audio</button>
        <span className="mx-1 h-4 w-px bg-zinc-800" />
        <button type="button" aria-label="Undo" title="Undo (⌘Z)" disabled={!hist.past.length} onClick={() => setHist(histUndo)} className={cn(iconBtn(false), "disabled:opacity-30")}><Undo2 className="size-3.5" /></button>
        <button type="button" aria-label="Redo" title="Redo (⇧⌘Z)" disabled={!hist.future.length} onClick={() => setHist(histRedo)} className={cn(iconBtn(false), "disabled:opacity-30")}><Redo2 className="size-3.5" /></button>
        <div className="ml-auto flex min-w-0 items-center gap-2">
          {status}
          {saving && <span className="truncate text-zinc-500">{saving.line}</span>}
          {!readOnly && (
            <button type="button" disabled={!dirty || !!saving} onClick={() => void save()}
              title={dirty ? "Save (⌘S): this timeline as this version's newest draft" : "Saved"}
              className="relative inline-flex h-8 min-w-24 items-center justify-center gap-1.5 overflow-hidden rounded-md bg-violet-600 px-3 text-sm font-medium text-white hover:bg-violet-500 disabled:opacity-50">
              {saving?.done ? <span className="absolute inset-y-0 left-0 bg-white/20" style={{ width: `${Math.round(saving.done * 100)}%` }} /> : null}
              <span className="relative inline-flex items-center gap-1.5">
                {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
                {saving ? (saving.done ? `Saving ${Math.round(saving.done * 100)} %` : "Saving") : dirty ? "Save" : "Saved"}
              </span>
            </button>
          )}
        </div>
      </div>

      <div className="min-h-32 flex-1 overflow-y-auto">
      <Timeline tl={shown} time={time} selected={sel} tool={tool} snap={snap} marks={marks} onSeek={seek} onSelect={setSelected}
        onLive={live_} onCommit={commit} nameOf={nameOf} zoomKeys={zoomKeys} fileOf={urlFor}
        onBlade={(f, key) => commit(blade(tl, f, [key]))}
        onMenu={(at) => setMenu(at)}
        onTrack={(id, patch) => commit(setTrack(tl, id, patch))}
        onRemoveTrack={(id) => commit(removeTrack(tl, id))}
        onDrop={readDrop ? (dt, at) => void readDrop(dt).then((d) => d && lay(d, at), (e: Error) => toast.error(e.message)) : undefined} />
      </div>

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
    </div>
  );
}
