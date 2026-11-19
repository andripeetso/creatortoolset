import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from "react";
import { toast } from "sonner";
import { Loader2, Magnet, MousePointer2, Pause, Play, Plus, Redo2, Save, Scissors, SkipBack, SkipForward, Undo2, UnfoldHorizontal } from "lucide-react";
import { freshHist, histChange, histRedo, histUndo, type Hist } from "@/lib/edit-history";
import {
  addSource, addTrack, blade, clipAt, clipsFrom, copyOf, duplicate, endOf, find, freeTrack, isVideo, lengthOf, linkTogether, move, paste,
  place, remove, removeTrack, rippleToPlayhead, setItems, setTrack, timecode, toSaved, unlink, withKeys, type NleItem, type NleTimeline, type PlaceMode,
} from "@/lib/nle/model";
import { cn } from "@/lib/utils";
import { keyAction } from "@/lib/nle/keys";
import { NleInspector } from "./NleInspector";
import { nleAudio } from "@/lib/nle/audio";
import type { NleFile } from "./NlePlayer";
import { NleLayout, Panel } from "./NleLayout";
import { NleMediaPool, SOURCE_MIME } from "./NleMediaPool";
import { NleViewer } from "./NleViewer";

export type { NleFile };
import { NleTracks as Timeline, type Tool } from "./NleTracks";

// A non-linear editor for one timeline, laid out as editors are (NleLayout): the Media Pool on the left (the timeline's own
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


export function NleEditor({ initial, resetKey, urlOf, onSave, saving, bin, readDrop, control, status, notes, readOnly, onRelink }: {
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
  /** Relink… on a clip in the Media Pool: look for the files not found here */
  onRelink?: () => void;
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
  const panelKeys = useRef<((p: "media" | "inspector") => void) | null>(null);

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
    let then = performance.now();
    const step = (now: number) => {
      const t = timeRef.current + ((now - then) / 1000) * rate;
      then = now;
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
    // the picked clips under the playhead, or (none there) every clip under it on the unlocked tracks
    blade: () => {
      const f = Math.round(time * fps);
      const under = sel.filter((k) => { const it = find(tl, k)!.item; return it.rec < f && f < endOf(it); });
      commit(blade(tl, f, under.length ? under : undefined));
    },
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
      const a = keyAction(e);
      if (!a) return;
      const f = Math.round(time * fps);
      const zoom = (key: string) => zoomKeys.current?.(new KeyboardEvent("keydown", { key }));
      const step = (d: number) => {
        play(false);
        seek(time + d / fps);
      };
      if (a.startsWith("lock:")) {
        const id = a.slice(5);
        if (tl.tracks[id]) commit(setTrack(tl, id, { locked: tl.tracks[id].locked ? undefined : true }));
      } else switch (a) {
        case "play": play(!playing); break;
        case "stop": play(false); break;
        case "forward": shuttle(1); break;
        case "reverse": shuttle(-1); break;
        case "save": void save(); break;
        case "undo": setHist(histUndo); break;
        case "redo": setHist(histRedo); break;
        case "split": act.blade(); break;
        case "copy": act.copy(); break;
        case "cut": act.cut(); break;
        case "paste": act.paste(); break;
        case "duplicate": act.duplicate(); break;
        case "selectAll": setSelected(Object.values(tl.tracks).flatMap((t) => t.items.map((i) => i._k!))); break;
        case "deselect": setSelected([]); break;
        // ⌥Y / ⌥⌘Y: every clip from the playhead on / up to it, on all tracks
        case "selectForward": setSelected(clipsFrom(tl, f, 1)); break;
        case "selectBack": setSelected(clipsFrom(tl, f, -1)); break;
        case "rippleStart": {
          if (readOnly) break;
          const h = clipAt(tl, f, sel);
          const next = rippleToPlayhead(tl, f, "head", sel);
          commit(next);
          if (h && next !== tl) seek(h.item.rec / fps); // the playhead goes to the cut, where the next shot now starts
          break;
        }
        case "rippleEnd": if (!readOnly) commit(rippleToPlayhead(tl, f, "tail", sel)); break;
        case "delete": act.delete(false); break;
        case "rippleDelete": act.delete(true); break;
        case "enable": if (sel.length) commit(setItems(tl, sel, { enabled: find(tl, sel[0])!.item.enabled === false ? undefined : false })); break;
        case "markIn": setMarks(([, o]) => [f, o !== null && o > f ? o : null]); break;
        case "markOut": setMarks(([i]) => [i !== null && i < f ? i : null, f]); break;
        case "clearMarks": setMarks([null, null]); break;
        case "toolSelect": setTool("select"); break;
        case "toolTrim": setTool("trim"); break;
        case "toolBlade": setTool("blade"); break;
        case "snap": setSnap((s) => !s); break;
        case "nudgeBack": case "nudgeBack5": case "nudgeOn": case "nudgeOn5":
          if (sel.length) commit(move(tl, sel, (a.startsWith("nudgeBack") ? -1 : 1) * (a.endsWith("5") ? 5 : 1)));
          break;
        case "frameBack": step(-1); break;
        case "frameOn": step(1); break;
        case "secondBack": step(-fps); break;
        case "secondOn": step(fps); break;
        case "prevEdit": case "nextEdit": {
          play(false);
          const p = a === "prevEdit" ? points.filter((x) => x < f).at(-1) : points.find((x) => x > f);
          if (p !== undefined) seek(p / fps);
          break;
        }
        case "start": seek(0); break;
        case "end": seek(last); break;
        case "zoomIn": zoom("="); break;
        case "zoomOut": zoom("-"); break;
        case "zoomFit": zoom("\\"); break;
        case "mediaPool": panelKeys.current?.("media"); break;
        case "inspector": panelKeys.current?.("inspector"); break;
      }
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
      <NleLayout panelKeys={panelKeys}
        media={
          <NleMediaPool tl={tl} nameOf={nameOfSrc} here={urlFor} bin={bin} onRelink={onRelink}
            onPick={(src) => setSelected(Object.values(tl.tracks).flatMap((t) => t.items.filter((i) => i.src === src).map((i) => i._k!)))} />
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
                  <button type="button" aria-label={playing ? "Pause" : "Play"} title={playing ? "Pause (Space, 2, K)" : "Play (Space, 2; 3 or L forward, 1 or J back)"} onClick={() => play(!playing)}
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
                <button type="button" aria-pressed={tool === "blade"} aria-label="Blade" title="Blade (B): a click cuts there. W or ⌘B splits at the playhead" onClick={() => setTool("blade")} className={iconBtn(tool === "blade")}><Scissors className="size-3.5" /></button>
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
