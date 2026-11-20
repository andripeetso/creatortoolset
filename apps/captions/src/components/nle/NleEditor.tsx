import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from "react";
import { toast } from "sonner";
import { Link2, Loader2, Magnet, MousePointer2, Pause, Play, Redo2, Repeat, Save, Scissors, SkipBack, SkipForward, Undo2, UnfoldHorizontal } from "lucide-react";
import { freshHist, histChange, histRedo, histUndo, type Hist } from "@/lib/edit-history";
import {
  addSource, blade, clipAt, closeGap, clipOfPart, clipsFrom, copyOf, duplicate, editTracks, endOf, find, freeTrack, isVideo, lengthOf, linkTogether,
  loopNext, loopPart, markedPart, move, NO_MARKS, paste, place, remove, rippleToPlayhead, setItems, setMark, setTrack, sourceTimeline,
  timecode, toSaved, unlink, withKeys, type Gap, type Marks, type NleItem, type NleSource, type NleTimeline, type PlaceMode,
} from "@/lib/nle/model";
import { dragging, type Dragged } from "@/lib/nle/drag";
import { fingerprint, keepUnsaved, readUnsaved } from "@/lib/nle/unsaved";
import { cn } from "@/lib/utils";
import { keyAction } from "@/lib/nle/keys";
import { NleInspector } from "./NleInspector";
import { NleClock, nleAudio } from "@/lib/nle/audio";
import { holdWaves } from "@/lib/waveform";
import type { NleFile } from "./NlePlayer";
import { NleLayout, Panel } from "./NleLayout";
import { NleMediaPool, SOUND, SOURCE_MIME, STILL } from "./NleMediaPool";
import { NleViewer, SoundCard, SourceStrip, Timecode } from "./NleViewer";

export type { NleFile };
import { NleTracks as Timeline, useLinkedSelection, type Tool } from "./NleTracks";

// A non-linear editor for one timeline, laid out as editors are (NleLayout): the Media Pool on the left (the timeline's own
// sources, then the page's media bin), the viewer in the middle playing the timeline live from its files (or, as Source,
// one clip opened from the pool to mark In and Out on and lay on the timeline), the inspector on the right, the timeline
// across the bottom. It fills the box it is put in. The page gives the timeline, where its
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
  /** the part laid, seconds into the file (its marked In–Out); the whole file when absent */
  from?: number;
  to?: number;
}

export interface NleControl {
  /** a clip from the bin laid at the playhead on V1 (or the In mark) */
  put: (d: NleDrop) => void;
  /** a clip from the bin opened in the viewer as the source, to mark and lay */
  source: (d: NleDrop) => void;
}

let clipboard: { track: string; item: NleItem }[] = [];
/** A drag from the source viewer's picture: the source's marked part. */
const VIEWER_MIME = "application/x-ct-nle-viewer";
const LOOP_KEY = "ct-nle-loop";

/** What a timeline opens as: as saved, and with the edits this browser kept unsaved on that same timeline (unsaved.ts). */
const openOf = (initial: NleTimeline, key: string) => {
  const saved = withKeys(initial);
  const base = fingerprint(initial);
  return { key, base, saved, now: readUnsaved(key, base) ?? saved };
};

/** A playhead and its clock (lib/nle/audio.ts NleClock): played on the sound's time (backwards for J), it stops on the
 *  last frame, or with `loop` (seconds) goes round that part. `time` is React's only at a pause, a seek or a stop; while
 *  it plays, whatever moves with it reads `clock` (nothing else renders again 60 times a second). */
function useTransport(last: number, fps: number, loop: [number, number] | null) {
  const [clock] = useState(() => new NleClock());
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(1);
  const loopRef = useRef(loop);
  loopRef.current = loop;
  const lastRef = useRef(last);
  lastRef.current = last;
  useEffect(() => {
    if (!playing) return;
    const release = holdWaves();
    clock.play(rate);
    let raf = 0;
    const step = () => {
      const t = clock.tick();
      const lp = loopRef.current;
      const end = lastRef.current;
      if (lp) {
        // straight back to the other end on this frame: the player has its pictures waiting there
        const to = loopNext(t, rate, lp);
        if (to !== t) clock.seek(to);
      } else if ((t >= end && rate > 0) || (t <= 0 && rate < 0)) {
        clock.stop();
        clock.seek(rate > 0 ? end : 0);
        setPlaying(false);
        return;
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(raf);
      release();
      setTime(clock.stop());
    };
  }, [playing, rate, clock]);

  const seek = useCallback((t: number) => {
    clock.seek(Math.max(0, t));
    setTime(Math.max(0, t));
  }, [clock]);
  const play = (on: boolean, r = 1) => {
    nleAudio();
    if (on && r > 0 && !loopRef.current && clock.now() >= last - 0.5 / fps) seek(0);
    setRate(r);
    setPlaying(on);
  };
  const shuttle = (dir: 1 | -1) => play(true, !playing || Math.sign(rate) !== dir ? dir : Math.max(-8, Math.min(8, rate * 2)));
  /** the playhead now (playing: where the clock is) */
  const now = useCallback(() => clock.now(), [clock]);
  return { time, clock, now, playing, setPlaying, rate, play, seek, shuttle };
}


export function NleEditor({ initial, resetKey, urlOf, onSave, saving, bin, readDrop, control, status, notes, readOnly, onRelink, picker, onChange }: {
  initial: NleTimeline;
  /** a new key opens `initial` afresh (another version); the same key keeps what is being edited */
  resetKey: string;
  /** where a source's file plays from in this browser (null: not here) */
  urlOf: (src: string, tl: NleTimeline) => NleFile | null;
  /** Save (⌘S): the timeline as it is saved; resolves once it is kept */
  onSave: (tl: NleTimeline) => Promise<void>;
  /** each edit and save: the timeline as it is now and as it was last saved (the page tells the chat what changed) */
  onChange?: (now: NleTimeline, saved: NleTimeline) => void;
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
  /** in the middle of the Viewer's bar, in place of the timeline's name: a way to the edit's other timelines */
  picker?: ReactNode;
}) {
  const [first] = useState(() => openOf(initial, resetKey));
  // the timeline open now (its key and fingerprint), for keeping its unsaved edits
  const opened = useRef(first);
  const [hist, setHist] = useState<Hist<NleTimeline>>(() => freshHist(first.now));
  const [saved, setSaved] = useState<NleTimeline>(first.saved);
  const [live, setLive] = useState<NleTimeline | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  // a gap picked on the timeline (its clips' selection let go); any edit lets it go
  const [gap, setGap] = useState<Gap | null>(null);
  const pick = useCallback((keys: string[]) => {
    setSelected(keys);
    if (keys.length) setGap(null);
  }, []);
  const [tool, setTool] = useState<Tool>("select");
  const [snap, setSnap] = useState(true);
  const [linkSel, toggleLinkSel] = useLinkedSelection();
  const [mode, setMode] = useState<PlaceMode>("overwrite");
  const [marks, setMarks] = useState<Marks>(NO_MARKS);
  // the source viewer: the clip open in it, each source's own marks (by file, kept while the editor is open), which shows
  const [source, setSource] = useState<NleDrop | null>(null);
  const [srcMarks, setSrcMarks] = useState<Record<string, Marks>>({});
  const [view, setView] = useState<"source" | "timeline">("timeline");
  const [loop, setLoop] = useState(() => {
    try {
      return localStorage.getItem(LOOP_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const zoomKeys = useRef<((e: KeyboardEvent) => boolean) | null>(null);
  const panelKeys = useRef<((p: "media" | "inspector") => void) | null>(null);

  // every edit kept in this browser until it is saved, so a reload or the page opened again never loses it. Before the
  // effect below: on another version it still keeps the last edits under the timeline they were made on
  useEffect(() => keepUnsaved(opened.current.key, opened.current.base, hist.now === saved ? null : hist.now), [hist.now, saved]);
  // said once when a timeline opens with edits that were never saved
  const back = opened.current.now !== opened.current.saved;
  useEffect(() => {
    if (back) toast("Your edits that weren't saved are back", { description: "Save keeps them in this version" });
  }, [back, resetKey]);

  useEffect(() => {
    if (opened.current.key === resetKey) return; // opened with the page
    const o = openOf(initial, resetKey);
    opened.current = o;
    setHist(freshHist(o.now));
    setSaved(o.saved);
    setLive(null);
    setSelected([]);
    tln.setPlaying(false);
    tln.seek(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- a new version only
  }, [resetKey]);

  const tl = hist.now;
  const sel = selected.filter((k) => find(tl, k));
  const shown = live ?? tl;
  const fps = tl.timeline.fps;
  const end = lengthOf(shown) / fps;
  // the cut's last frame: playing stops on it and End goes to it, so the viewer ends on a picture, never on past-the-end
  const last = Math.max(0, lengthOf(shown) - 1) / fps;
  const dirty = tl !== saved;
  const tln = useTransport(last, fps, loop && lengthOf(shown) ? loopPart(marks, lengthOf(shown), fps) : null);
  const { time, play, seek, now } = tln;

  // the source: one of the timeline's own when it plays the same file (so it plays from where that one is found here)
  const sfpsOf = (d: NleDrop) => d.fps || Number(Object.values(tl.sources).find((x) => x.path === d.path)?.fps) || fps;
  const srcKey = source ? Object.keys(tl.sources).find((k) => tl.sources[k].path === source.path) ?? null : null;
  const srcRec: NleSource | null = source && (srcKey ? tl.sources[srcKey] : { path: source.path, fps: source.fps, w: source.w, h: source.h });
  const sfps = source ? sfpsOf(source) : fps;
  const srcSecs = source ? source.seconds ?? (srcRec?.dur ? srcRec.dur / sfps : 5) : 0;
  const srcFrames = Math.max(1, Math.round(srcSecs * sfps));
  const srcPicture = !!source && !SOUND.test(source.path);
  const srcJson = JSON.stringify([srcKey, srcRec, sfps, srcFrames, source?.sound, source?.path]);
  const srcTl = useMemo(() => source && srcRec
    ? sourceTimeline(srcKey ?? "source", srcRec, { fps: sfps, frames: srcFrames, picture: srcPicture, sound: source.sound !== false && !STILL.test(source.path) })
    : null, [srcJson]); // eslint-disable-line react-hooks/exhaustive-deps -- by what it plays
  const sm = (source && srcMarks[source.path]) || NO_MARKS;
  const srcT = useTransport((srcFrames - 1) / sfps, sfps, loop ? loopPart(sm, srcFrames, sfps) : null);
  const inSource = view === "source" && !!srcTl;
  const T = inSource ? srcT : tln;
  const tfps = inSource ? sfps : fps;
  const show = (v: "source" | "timeline") => {
    if (v === view) return;
    (v === "source" ? tln : srcT).play(false);
    setView(v);
  };
  const toggleLoop = () => {
    const on = !loop;
    setLoop(on);
    try {
      localStorage.setItem(LOOP_KEY, on ? "1" : "0");
    } catch {
      // for this page only
    }
  };

  const commit = useCallback((next: NleTimeline) => {
    setLive(null);
    setGap(null);
    if (readOnly) return;
    setHist((h) => histChange(h, () => next));
  }, [readOnly]);
  const live_ = useCallback((next: NleTimeline | null) => !readOnly && setLive(next), [readOnly]);

  const urlFor = useCallback((src: string) => urlOf(src, shown), [urlOf, shown]);
  const srcUrl = useCallback((k: string) => (srcTl ? urlOf(k, srcTl) : null), [urlOf, srcTl]);
  const nameOfSrc = useCallback((src: string) => String(shown.sources[src]?.path ?? src).split("/").pop()!.replace(/\.[^.]+$/, "").replace(/[_-]?%0\d+d/, ""), [shown]);
  const nameOf = useCallback((it: NleItem) => (typeof it.name === "string" && it.name) || (typeof it.line === "string" && it.line ? `${it.line} · ${nameOfSrc(it.src)}` : nameOfSrc(it.src)), [nameOfSrc]);

  // a clip from the bin: its picture on a video track, its sound with it on a free sound track (F9 / F10: the one given),
  // linked; on a sound track its sound alone; only its `from`–`to` part when it has one
  const lay = (d: NleDrop, at: { track: string; frame: number; sound?: string }, how: PlaceMode = mode) => {
    if (readOnly) return;
    const s = addSource(tl, { path: d.path, fps: d.fps, ...(d.seconds ? { dur: Math.round(d.seconds * (d.fps || fps)) } : {}), w: d.w, h: d.h });
    let next = s.tl;
    // a file picked on the computer comes with no length: 5 s, pulled out on the timeline
    const item = clipOfPart(s.src, at.frame, fps, Number(next.sources[s.src].fps) || fps, d);
    const clips: { track: string; item: NleItem }[] = [{ track: at.track, item }];
    if (isVideo(at.track) && d.sound !== false) {
      const a = at.sound && next.tracks[at.sound] ? { tl: next, id: at.sound } : freeTrack(next, "A", at.frame, endOf(item), at.track === "V1" ? 1 : 2);
      next = a.tl;
      const link = `l${Date.now().toString(36)}`;
      item.link = link;
      clips.push({ track: a.id, item: { ...item } });
    }
    const made = place(next, clips, how);
    commit(made.tl);
    setSelected(made.keys.slice(0, 1));
  };
  // a drop with the marks its file has in the source viewer: their part only
  const marked = (d: NleDrop): NleDrop => (d.from !== undefined || d.to !== undefined ? d : { ...d, ...markedPart(srcMarks[d.path], sfpsOf(d), d.seconds) });
  const noteOf = (d: NleDrop): Dragged => {
    const p = marked(d);
    const to = p.to ?? p.seconds;
    return { name: d.name, seconds: to !== undefined ? to - (p.from ?? 0) : null, picture: !SOUND.test(d.path), sound: d.sound !== false && !STILL.test(d.path) };
  };
  const note = (d: NleDrop | null) => void (dragging.current = d && noteOf(d));
  const openSource = (d: NleDrop) => {
    tln.play(false);
    srcT.play(false);
    if (d.path !== source?.path) srcT.seek((srcMarks[d.path]?.[0] ?? 0) / sfpsOf(d));
    setSource(d);
    setView("source");
  };
  const dropOfSrc = (src: string): NleDrop | null => {
    const s = tl.sources[src];
    if (!s?.path) return null;
    return { path: s.path, name: nameOfSrc(src), fps: s.fps, w: s.w, h: s.h, ...(s.dur ? { seconds: s.dur / (s.fps || fps) } : {}) };
  };
  // F9 / F10: the source's marked part at the In mark or the playhead, on V1 and A1 or the picked clips' tracks
  const edit = (how: PlaceMode) => {
    if (!source) return;
    const t = editTracks(tl, sel);
    const track = srcPicture ? t.picture : t.sound;
    if (tl.tracks[track]) lay(marked(source), { track, frame: marks[0] ?? Math.round(now() * fps), sound: t.sound }, how);
  };
  if (control) control.current = { put: (d) => lay(marked(d), { track: "V1", frame: marks[0] ?? Math.round(now() * fps) }), source: openSource };

  const act = {
    // a gap goes with either delete key, as in Resolve: what is after it moves back
    delete: (ripple: boolean) => (gap ? commit(closeGap(tl, gap)) : sel.length && commit(remove(tl, sel, ripple))),
    copy: () => sel.length && (clipboard = copyOf(tl, sel)),
    cut: () => {
      if (!sel.length) return;
      clipboard = copyOf(tl, sel);
      commit(remove(tl, sel));
    },
    paste: () => {
      if (!clipboard.length) return;
      const made = paste(tl, clipboard, Math.round(now() * fps), mode);
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
      const f = Math.round(now() * fps);
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
  // eslint-disable-next-line react-hooks/exhaustive-deps -- on a change of the timeline only
  useEffect(() => onChange?.(tl, saved), [tl, saved]);

  // the edit points, for ↑ and ↓
  const points = useMemo(() => [...new Set([0, ...Object.values(tl.tracks).flatMap((t) => t.items.flatMap((i) => [i.rec, endOf(i)]))])].sort((a, b) => a - b), [tl]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement | null)?.closest?.("input:not([type=range]):not([type=checkbox]), textarea, select, [contenteditable=true], [role=dialog]")) return;
      const a = keyAction(e);
      if (!a) return;
      const f = Math.round(now() * fps);
      const zoom = (key: string) => zoomKeys.current?.(new KeyboardEvent("keydown", { key }));
      // playing, stepping and marks go to what the viewer shows (Source or Timeline)
      const pf = Math.round(T.now() * tfps);
      const step = (d: number) => {
        T.play(false);
        T.seek(T.now() + d / tfps);
      };
      const mark = (what: Parameters<typeof setMark>[1]) => inSource && source
        ? setSrcMarks((all) => ({ ...all, [source.path]: setMark(all[source.path] ?? NO_MARKS, what, pf) }))
        : setMarks((m) => setMark(m, what, pf));
      if (a.startsWith("lock:")) {
        const id = a.slice(5);
        if (tl.tracks[id]) commit(setTrack(tl, id, { locked: tl.tracks[id].locked ? undefined : true }));
      } else switch (a) {
        case "play": T.play(!T.playing); break;
        case "stop": T.play(false); break;
        case "forward": T.shuttle(1); break;
        case "reverse": T.shuttle(-1); break;
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
          // Q in the source viewer: back to the timeline (the owner's Q ripples on the timeline)
          if (inSource) { show("timeline"); break; }
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
        case "markIn": mark("in"); break;
        case "markOut": mark("out"); break;
        case "clearMarks": mark("clear"); break;
        case "clearIn": mark("clearIn"); break;
        case "clearOut": mark("clearOut"); break;
        case "insertEdit": edit("insert"); break;
        case "overwriteEdit": edit("overwrite"); break;
        case "loop": toggleLoop(); break;
        case "toolSelect": setTool("select"); break;
        case "toolTrim": setTool("trim"); break;
        case "toolBlade": setTool("blade"); break;
        case "snap": setSnap((s) => !s); break;
        case "linkedSelection": toggleLinkSel(); break;
        case "nudgeBack": case "nudgeBack5": case "nudgeOn": case "nudgeOn5":
          if (sel.length) commit(move(tl, sel, (a.startsWith("nudgeBack") ? -1 : 1) * (a.endsWith("5") ? 5 : 1)));
          break;
        case "frameBack": step(-1); break;
        case "frameOn": step(1); break;
        case "secondBack": step(-tfps); break;
        case "secondOn": step(tfps); break;
        case "prevEdit": case "nextEdit": {
          play(false);
          const p = a === "prevEdit" ? points.filter((x) => x < f).at(-1) : points.find((x) => x > f);
          if (p !== undefined) seek(p / fps);
          break;
        }
        case "start": T.seek(0); break;
        case "end": T.seek(inSource ? (srcFrames - 1) / sfps : last); break;
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
    if (source && dt.types.includes(VIEWER_MIME)) return lay(marked(source), at);
    const d = dropOfSrc(dt.getData(SOURCE_MIME));
    if (d) return lay(marked(d), at);
    if (readDrop) void readDrop(dt).then((d) => d && lay(marked(d), at), (e: Error) => toast.error(e.message));
  };
  // a drag out of the library bin: its length known once the page has read what it is
  const binDrag = (dt: DataTransfer | null) => {
    if (!dt) return note(null);
    const n: Dragged = { name: "", seconds: null, picture: true, sound: true };
    dragging.current = n;
    void readDrop?.(dt).then((d) => { if (d && dragging.current === n) dragging.current = noteOf(d); }, () => {});
  };

  return (
    <>
      <NleLayout panelKeys={panelKeys}
        center={
          <>
            {saving && <span className="min-w-0 truncate text-zinc-500">{saving.line}</span>}
            {!readOnly && (
              <button type="button" disabled={!dirty || !!saving} onClick={() => void save()}
                title={dirty ? "Save (⌘S): this timeline as this version's newest draft" : "Saved"}
                className="relative inline-flex h-5 shrink-0 items-center gap-1.5 overflow-hidden rounded px-2 text-[12px] text-zinc-300 hover:bg-white/[0.06] hover:text-zinc-100 disabled:text-zinc-500 disabled:hover:bg-transparent">
                {saving?.done ? <span className="absolute inset-y-0 left-0 bg-white/10" style={{ width: `${Math.round(saving.done * 100)}%` }} /> : null}
                <span className="relative inline-flex items-center gap-1.5">
                  {saving ? <Loader2 className="size-3 animate-spin" /> : dirty ? <span className="size-1.5 rounded-full bg-amber-400" /> : <Save className="size-3" />}
                  {saving ? (saving.done ? `Saving ${Math.round(saving.done * 100)} %` : "Saving") : dirty ? "Save" : "Saved"}
                </span>
              </button>
            )}
          </>
        }
        media={
          <NleMediaPool tl={tl} nameOf={nameOfSrc} here={urlFor} bin={bin} onRelink={onRelink}
            onPick={(src) => setSelected(Object.values(tl.tracks).flatMap((t) => t.items.filter((i) => i.src === src).map((i) => i._k!)))}
            onOpen={(src) => { const d = dropOfSrc(src); if (d) openSource(d); }}
            onDrag={(src) => note(src ? dropOfSrc(src) : null)} onBinDrag={binDrag} />
        }
        viewer={
          <Panel title="Viewer" className="flex-1 select-none"
            bar={
              <div className="flex min-w-0 flex-1 items-center gap-2">
                <span className="inline-flex shrink-0 rounded border border-zinc-700/70 p-0.5" role="group" aria-label="Viewer shows">
                  {(["source", "timeline"] as const).map((v) => (
                    <button key={v} type="button" aria-pressed={view === v} disabled={v === "source" && !source} onClick={() => show(v)}
                      title={v === "source" ? "The clip opened from the Media Pool: mark In and Out, drag it on, F9 insert, F10 overwrite (Q back)" : "The timeline"}
                      className={cn("h-5 rounded-[3px] px-1.5 capitalize disabled:opacity-40", view === v ? "bg-zinc-700 text-zinc-50" : "text-zinc-400 hover:text-zinc-100")}>{v}</button>
                  ))}
                </span>
                {(inSource || !picker) && <span className="min-w-0 truncate text-zinc-500">{inSource ? source!.name : tl.timeline.name}</span>}
                {/* the timeline's: in the middle, in place of its name, a way to the edit's other timelines */}
                {picker && !inSource && (
                  <div className="pointer-events-none absolute inset-x-0 flex justify-center"><div className="pointer-events-auto max-w-[60%]">{picker}</div></div>
                )}
              </div>
            }>
            <NleViewer tl={inSource ? srcTl! : shown} playhead={T.clock} rate={T.rate} urlOf={inSource ? srcUrl : urlFor}
              nameOf={inSource ? () => source!.name : nameOfSrc} onClick={() => T.play(!T.playing)}
              loop={loop ? (inSource ? loopPart(sm, srcFrames, sfps) : lengthOf(shown) ? loopPart(marks, lengthOf(shown), fps) : null) : null}
              onDragStart={inSource ? (e) => { e.dataTransfer.setData(VIEWER_MIME, "1"); e.dataTransfer.effectAllowed = "copy"; note(source); } : undefined}
              onDragEnd={() => note(null)}
              over={inSource && !srcPicture ? <SoundCard url={srcUrl(srcKey ?? "source")?.url ?? null} seconds={srcSecs} clock={srcT.clock} /> : null}
              below={inSource ? (
                <SourceStrip clock={srcT.clock} seconds={srcSecs} from={sm[0] !== null ? sm[0] / sfps : null} to={sm[1] !== null ? (sm[1] + 1) / sfps : null}
                  onSeek={(t) => { srcT.play(false); srcT.seek(t); }} />
              ) : null}
              clock={
                <span className="font-mono tabular-nums">
                  <span className="text-[13px] text-zinc-100"><Timecode clock={T.clock} fps={tfps} /></span>
                  <span className="text-zinc-500"> / {inSource ? timecode(srcFrames, sfps) : timecode(Math.round(end * fps), fps)}</span>
                  {T.playing && T.rate !== 1 && <span className="pl-1.5 text-violet-300">{T.rate}×</span>}
                </span>
              }
              transport={
                <>
                  <button type="button" aria-label="Start" title="Start (Home)" onClick={() => T.seek(0)} className={cn(iconBtn(false), "w-7 justify-center")}><SkipBack className="size-3.5" /></button>
                  <button type="button" aria-label={T.playing ? "Pause" : "Play"} title={T.playing ? "Pause (Space, 2, K)" : "Play (Space, 2; 3 or L forward, 1 or J back)"} onClick={() => T.play(!T.playing)}
                    className="inline-flex size-7 items-center justify-center rounded-full bg-zinc-200 text-zinc-900 hover:bg-white">
                    {T.playing ? <Pause className="size-3.5 fill-current" /> : <Play className="size-3.5 translate-x-px fill-current" />}
                  </button>
                  <button type="button" aria-label="End" title="End (End)" onClick={() => T.seek(inSource ? (srcFrames - 1) / sfps : last)} className={cn(iconBtn(false), "w-7 justify-center")}><SkipForward className="size-3.5" /></button>
                  <button type="button" aria-label="Loop" aria-pressed={loop} title="Loop (⌘/): plays In to Out, or all of it, round and round" onClick={toggleLoop}
                    className={cn(iconBtn(loop), "w-7 justify-center", loop && "text-violet-300")}><Repeat className="size-3.5" /></button>
                </>
              } />
          </Panel>
        }
        inspector={<NleInspector tl={tl} keys={sel} nameOf={nameOf} onLive={live_} onCommit={commit} notes={notes} />}
        timeline={
          // a click in the timeline puts the viewer back on it
          <div className="flex min-h-0 min-w-0 flex-1" onPointerDownCapture={() => show("timeline")}>
          <Timeline tl={shown} time={time} clock={tln.clock} selected={sel} tool={tool} snap={snap} linkedSelection={linkSel} marks={marks} onSeek={seek} onSelect={pick} gap={gap} onGap={setGap}
            onLive={live_} onCommit={commit} nameOf={nameOf} zoomKeys={zoomKeys} fileOf={urlFor}
            onBlade={(f, key) => commit(blade(tl, f, [key]))}
            onMenu={(at) => setMenu(at)}
            onTrack={(id, patch) => commit(setTrack(tl, id, patch))}
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
                <button type="button" aria-pressed={linkSel} aria-label="Linked Selection" title="Linked Selection (⇧⌘L)" onClick={toggleLinkSel} className={iconBtn(linkSel)}><Link2 className="size-3.5" /></button>
                {sep}
                <button type="button" aria-label="Undo" title="Undo (⌘Z)" disabled={!hist.past.length} onClick={() => setHist(histUndo)} className={cn(iconBtn(false), "disabled:opacity-30")}><Undo2 className="size-3.5" /></button>
                <button type="button" aria-label="Redo" title="Redo (⇧⌘Z)" disabled={!hist.future.length} onClick={() => setHist(histRedo)} className={cn(iconBtn(false), "disabled:opacity-30")}><Redo2 className="size-3.5" /></button>
              </>
            }
            end={<span className="flex min-w-0 items-center gap-2 truncate">{status}</span>} />
          </div>
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
              ["Ripple delete", "S", () => act.delete(true), false],
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
