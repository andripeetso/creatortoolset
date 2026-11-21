import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from "react";
import { toast } from "sonner";
import { ChevronRight, Gauge, Keyboard, Link2, Loader2, Magnet, MousePointer2, MoveHorizontal, Pause, Play, Redo2, Repeat, Save, Scissors, SkipBack, SkipForward, Undo2, UnfoldHorizontal } from "lucide-react";
import { freshHist, histChange, histGo, histRedo, histUndo, type Hist } from "@/lib/edit-history";
import {
  addSource, blade, clipOfPart, editTracks, endOf, find, freeTrack, isVideo, lengthOf, linkTogether,
  loopNext, loopPart, markedPart, markerAt, markersCsv, markersOf, NO_MARKS, place, removeMarker, setMarker, setTrack, sourceTimeline,
  timecode, toSaved, unlink, withKeys, type Gap, type Marks, type NleItem, type NleSource, type NleTimeline, type PlaceMode,
} from "@/lib/nle/model";
import { COMMANDS, runAll, stateView, type NleRun, type NleState } from "@/lib/nle/commands";
import { nlePending, nleReply, type NleAsk } from "@/lib/editor";
import { clientId, onTopic } from "@/lib/sync";
import { dragging, type Dragged } from "@/lib/nle/drag";
import { stillCached } from "@/lib/nle/cache";
import { addAutosave, AUTOSAVE_MS, fingerprint, LIVE_MS, markSaved, readAutosaves, sealAutosave, toRestore, type Autosave } from "@/lib/nle/autosave";
import { cn } from "@/lib/utils";
import { chordLabel, chordsOf, commandOfKey } from "@/lib/nle/keys";
import { NleKeyboard, useKeymap } from "./NleKeyboard";
import { CAMERA_FILE, readCamera, rangeReader } from "@/lib/nle/camera";
import { downloadText } from "@/lib/download";
import { NleMarkerDialog } from "./NleMarkerDialog";
import { CHAT_STEP, NleInspector } from "./NleInspector";
import { NleClock, nleAudio } from "@/lib/nle/audio";
import { holdWaves } from "@/lib/waveform";
import type { NleFile } from "./NlePlayer";
import { NleGate, NleLayout, Panel } from "./NleLayout";
import { edjVersion, type Edj, type Renders } from "@contracts/editor";
import { newlyUnrendered, NOT_RENDERED, unrendered } from "@/lib/nle/check";
import { NleMeter } from "./NleMeter";
import { NleRendered } from "./NleRendered";
import { LowerUnderVoiceDialog, NormalizeDialog } from "./NleSound";
import { soundKeys } from "@/lib/nle/loudness";
import { NleMediaPool, SOUND, SOURCE_MIME, STILL } from "./NleMediaPool";
import { NleViewer, SoundCard, SourceStrip, Timecode } from "./NleViewer";
import { NleText } from "./NleText";
import { getDesign } from "@/lib/designs";
import { canGrab, designFile, isDesign, placeText, renderScale } from "@/lib/nle/text-clip";
import { drawFrame, grabDesign, grabFrame, makeText } from "@/lib/nle/text-design";
import { CaptionsBody, CaptionsHead, CaptionsOver, captionsHref, downloadSrt, useCaptionClip } from "./NleCaptions";
import { captionCards, captionsStale, fromOf, withoutCards } from "@/lib/nle/captions";
import { useChatShown } from "@/lib/chat-mode";

export type { NleFile };
import { NleTracks as Timeline, useLinkedSelection, type MenuAt, type Tool } from "./NleTracks";

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
  /** the timeline's key for its source, when the page names it (a library clip by its id); else the file's name */
  src?: string;
  /** more of what the page knows of the source, kept on it */
  source?: Record<string, unknown>;
}

/** What the chat-mode foot (NleEditor `foot`) is told: the person's own edits since the timeline opened, and a save. */
export interface NleFoot {
  /** edits by hand since it opened (undo steps) */
  changes: number;
  /** some not saved yet */
  dirty: boolean;
  /** Save (⌘S): resolves true once saved, or when there was nothing to save */
  save: () => Promise<boolean>;
}

/** What the chat-mode side panel beside the viewer (NleEditor `side`) is given: the timeline as it is now, the picked
 *  clips, the playhead at rest, a hand edit as one undo step, a clip opened in the viewer as Source, and a try: a
 *  timeline shown and played in place of this one until Enter keeps it (one undo step) or Esc drops it. */
export interface NleSide {
  tl: NleTimeline;
  picked: string[];
  /** the playhead's frame, at rest (a pause, a seek) */
  playhead: number;
  commit: (next: NleTimeline, label: string) => void;
  /** a drop with `from` / `to` opens on that part, marked In and Out */
  source: (d: NleDrop) => void;
  /** shows `next` in place of the timeline until it is kept or dropped (null drops it); `label` names the kept step */
  preview: (next: NleTimeline | null, label?: string) => void;
  /** a try is on */
  trying: boolean;
  /** keeps the try as one undo step, as Enter does */
  commitPreview: () => void;
  /** the playhead to this frame, the picked clips let go */
  seek: (frame: number) => void;
}

export interface NleControl {
  /** a clip from the bin laid at the playhead on V1 (or the In mark) */
  put: (d: NleDrop) => void;
  /** a clip from the bin opened in the viewer as the source, to mark and lay */
  source: (d: NleDrop) => void;
}

// the designer is loaded when it is first opened, not with the editor
const DesignEditor = lazy(() => import("@/pages/DesignPage").then((m) => ({ default: m.DesignEditor })));

let clipboard: { track: string; item: NleItem }[] = [];
/** A drag from the source viewer's picture: the source's marked part. */
const VIEWER_MIME = "application/x-ct-nle-viewer";
const LOOP_KEY = "ct-nle-loop";
/** Keys that go to what the viewer shows (Source or Timeline); the first six stop it playing. */
const STEPS = new Set(["frameBack", "frameOn", "secondBack", "secondOn", "prevEdit", "nextEdit"]);
/** Home and End go there even from within the frame they are on. */
const HOME_END = new Set(["start", "end"]);
const VIEWER = new Set(["frameBack", "frameOn", "secondBack", "secondOn", "start", "end", "markIn", "markOut", "clearMarks", "clearIn", "clearOut"]);
/** a row of the editor's menu: its words, its key, what it does, greyed */
type MenuRow = [string, string, () => void, boolean, string?];
/** The edit and draft a timeline page's path shows, as api/editor/nle-bridge.ts reads it. */
const PAGE = /^\/editor\/(?!p\/)([^/?#]+)\/([^/?#]+)/;
/** The chat's requests already taken by this window: one delivered twice is run once. */
const taken = new Set<string>();

/** What a timeline opens as: as saved (its autosaves come back a moment later: lib/nle/autosave.ts). */
const openOf = (initial: NleTimeline, key: string) => ({ key, base: fingerprint(initial), saved: withKeys(initial) });

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


export function NleEditor({ initial, resetKey, urlOf: pageUrlOf, onSave, saving, bin, readDrop, control, status, notes, readOnly, onRelink, picker, onChange, captions, renders, rendered, cached, bar, foot, side }: {
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
  /** the Captions lane (lib/nle/captions.ts): `send` gives the saved cut's render to Caption Studio (made, or moved from
   *  the timeline's older captions) and answers with its clip; `open` goes to Caption Studio. None: no Captions lane */
  captions?: { send: () => Promise<{ project: string; clip: string; note?: string }>; open: (href: string) => void };
  /** what the server's renders draw (contracts/editor.ts Renders): an edit they wouldn't draw is refused, its controls
   *  greyed; absent: everything draws */
  renders?: Renders;
  /** the render of the timeline as saved (its texts and effects drawn), played in the Viewer as Rendered while nothing is
   *  unsaved; `first`: the Viewer opens on it */
  rendered?: { url: string; first?: boolean } | null;
  /** the V1 ranges [rec, len] of the timeline as last saved that the render cache holds: the render bar under the ruler */
  cached?: readonly (readonly [number, number])[];
  /** beside the chats (chat mode): the page's bar over the viewer (its drafts and versions), in place of the panels' buttons */
  bar?: ReactNode;
  /** beside the chats: the bar under the timeline (what the person changed, the page's own buttons) */
  foot?: (s: NleFoot) => ReactNode;
  /** beside the chats: a panel beside the viewer (NleLayout viewerBeside: a portrait cut's viewer narrows for it) */
  side?: (s: NleSide) => ReactNode;
}) {
  // beside the chats the viewer takes the room: the side panels hidden until All editing tools, the empty tracks and the
  // rarer tools left out of a smaller timeline (NleLayout `chat`)
  const besideChat = useChatShown();
  const [first] = useState(() => openOf(initial, resetKey));
  // the timeline open now (its key and fingerprint), for keeping its unsaved edits
  const opened = useRef(first);
  const [hist, setHist] = useState<Hist<NleTimeline>>(() => freshHist(first.saved));
  const [saved, setSaved] = useState<NleTimeline>(first.saved);
  const [live, setLive] = useState<NleTimeline | null>(null);
  // the side panel's try, on the timeline it was made from (an undo or another edit under it drops it)
  const [tried, setTried] = useState<{ tl: NleTimeline; label?: string; base: NleTimeline } | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  // a gap picked on the timeline (its clips' selection let go); any edit lets it go
  const [gap, setGap] = useState<Gap | null>(null);
  // a transition picked on the timeline (the clip after its cut); picking clips lets it go
  const [transPick, pickTrans] = useState<string | null>(null);
  const pick = useCallback((keys: string[]) => {
    setSelected(keys);
    pickTrans(null);
    if (keys.length) setGap(null);
  }, []);
  // a double click on a transition's band picks it alone
  const pickTransAt = useCallback((k: string) => {
    setSelected([]);
    setGap(null);
    pickTrans(k);
  }, []);
  // the marker open in its dialog (its frame)
  const [markerEdit, setMarkerEdit] = useState<number | null>(null);
  const keys = useKeymap();
  const [keysOpen, setKeysOpen] = useState(false);
  const [tool, setTool] = useState<Tool>("select");
  const [snap, setSnap] = useState(true);
  const [linkSel, toggleLinkSel] = useLinkedSelection();
  const [mode, setMode] = useState<PlaceMode>("overwrite");
  const [marks, setMarks] = useState<Marks>(NO_MARKS);
  // the source viewer: the clip open in it, each source's own marks (by file, kept while the editor is open), which shows
  const [source, setSource] = useState<NleDrop | null>(null);
  const [srcMarks, setSrcMarks] = useState<Record<string, Marks>>({});
  // Rendered: the timeline's render (`rendered`) over the frame, while nothing is unsaved
  const [view, setView] = useState<"source" | "timeline" | "rendered">(() => (rendered?.first ? "rendered" : "timeline"));
  const [loop, setLoop] = useState(() => {
    try {
      return localStorage.getItem(LOOP_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [menu, setMenu] = useState<MenuAt | null>(null);
  const [sound, setSound] = useState<{ normalize: string[] } | { duck: string } | null>(null);
  const zoomKeys = useRef<((e: KeyboardEvent) => boolean) | null>(null);
  const panelKeys = useRef<((p: "media" | "inspector") => void) | null>(null);

  // autosaves: unsaved edits kept in this browser a moment after each change (the live one, rewritten), sealed every
  // 30 s, on leaving the window and on closing the timeline when they changed, so a reload, a crash or the page opened
  // again never loses them
  const [autosaves, setAutosaves] = useState<Autosave[]>([]);
  const latest = useRef({ hist, saved });
  latest.current = { hist, saved };
  const snapped = useRef<NleTimeline | null>(null);
  const keep = useCallback((live: boolean) => {
    const { hist: h, saved: s } = latest.current;
    const o = opened.current;
    const p = h.now !== s && h.now !== snapped.current
      ? ((snapped.current = h.now), addAutosave(o.key, { at: Date.now(), base: o.base, label: h.labels?.[h.past.length], tl: h.now, ...(live ? { live: true as const } : {}) }))
      : live ? null : sealAutosave(o.key);
    void p?.then((r) => opened.current.key === o.key && setAutosaves(r.list));
  }, []);
  const autosave = useCallback(() => keep(false), [keep]);
  useEffect(() => {
    if (hist.now === saved) return;
    const t = setTimeout(() => keep(true), LIVE_MS);
    return () => clearTimeout(t);
  }, [hist.now, saved, keep]);
  useEffect(() => {
    if (hist.now === saved) return;
    const t = setInterval(autosave, AUTOSAVE_MS);
    return () => clearInterval(t);
  }, [hist.now === saved, autosave]); // eslint-disable-line react-hooks/exhaustive-deps -- unsaved or not only
  useEffect(() => {
    window.addEventListener("blur", autosave);
    window.addEventListener("pagehide", autosave);
    return () => {
      window.removeEventListener("blur", autosave);
      window.removeEventListener("pagehide", autosave);
      autosave();
    };
  }, [autosave]);
  // a timeline opened with unsaved edits on it: the newest autosave since its last save comes back, said once
  const [back, setBack] = useState<NleTimeline | null>(null);
  useEffect(() => {
    if (back && latest.current.hist.now === back) toast("Your edits that weren't saved are back", { description: "Save keeps them in this version" });
  }, [back]);

  useEffect(() => {
    if (opened.current.key === resetKey) return; // opened with the page
    autosave(); // the one closing
    const o = openOf(initial, resetKey);
    opened.current = o;
    snapped.current = null;
    setAutosaves([]);
    setHist(freshHist(o.saved));
    setSaved(o.saved);
    setLive(null);
    setTried(null);
    setSelected([]);
    tln.setPlaying(false);
    tln.seek(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- a new version only
  }, [resetKey]);
  useEffect(() => {
    const o = opened.current;
    let on = true;
    void readAutosaves(o.key).then((r) => {
      if (!on) return;
      setAutosaves(r.list);
      const last = toRestore(r, o.base);
      if (!last) return;
      snapped.current = last.tl;
      // only on a timeline not edited yet
      setHist((h) => (h.past.length || h.future.length || h.now !== o.saved ? h : freshHist(last.tl)));
      setBack(last.tl);
    });
    return () => void (on = false);
  }, [resetKey]);
  /** An autosave picked in History: back to it as one step, so undo goes back to where it was left. */
  const restore = (a: Autosave) => {
    autosave(); // where it was stays an autosave too
    snapped.current = a.tl;
    setHist((h) => histChange(h, () => a.tl, "Restore autosave"));
  };

  const tl = hist.now;
  const sel = selected.filter((k) => find(tl, k));
  const tryOn = tried?.base === tl ? tried : null;
  if (tried && !tryOn) setTried(null); // its timeline undone or changed: gone for good, never back on a redo
  const shown = live ?? tryOn?.tl ?? tl;
  const cachedNow = useMemo(() => stillCached(shown, saved, cached), [shown, saved, cached]);
  const fps = tl.timeline.fps;
  const end = lengthOf(shown) / fps;
  // the cut's last frame: playing stops on it and End goes to it, so the viewer ends on a picture, never on past-the-end
  const last = Math.max(0, lengthOf(shown) - 1) / fps;
  const dirty = tl !== saved;
  // what the render doesn't show: unsaved edits, or a try on
  const unrendered = dirty || !!tryOn;
  const tln = useTransport(last, fps, loop && lengthOf(shown) ? loopPart(marks, lengthOf(shown), fps) : null);
  const { time, seek, now } = tln;

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
  const show = (v: "source" | "timeline" | "rendered") => {
    if (v === view) return;
    if (v === "source") tln.play(false);
    else if (view === "source") srcT.play(false);
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

  // the one rule for what the server's renders don't draw: an edit that needs a newer timeline version, or adds a field or
  // a track they don't draw (one the timeline came with stays), is not made (lib/nle/check.ts, as the save judges it)
  const base = opened.current.saved;
  const why = useCallback((next: NleTimeline): string | null => {
    if (!renders) return null;
    const v = edjVersion(next as unknown as Edj);
    if (v > renders.edj_version) return `${NOT_RENDERED}: this server renders timeline version ${renders.edj_version}`;
    const extra = newlyUnrendered(next, renders, base);
    return extra.length ? `${NOT_RENDERED}: ${extra.join(", ")}` : null;
  }, [renders, base]);
  const beyond = useCallback((next: NleTimeline) => why(next) !== null, [why]);
  // the controls that only make version-2 fields, greyed while the server's renders take version 1; and each field's
  const gate = renders && renders.edj_version < 2 ? NOT_RENDERED : null;
  const baseOff = useMemo(() => new Set(renders ? unrendered(base, renders) : []), [renders, base]);
  const fieldOff = useCallback((tracks: string[], f: string) =>
    renders && tracks.some((t) => (f ? !renders.tracks[t]?.includes(f) : !renders.tracks[t]) && !baseOff.has(f ? `${t} ${f}` : t)) ? NOT_RENDERED : null, [renders, baseOff]);
  const gateCtx = useMemo(() => ({ v2: gate, field: fieldOff }), [gate, fieldOff]);
  const commit = useCallback((next: NleTimeline, label?: string) => {
    // while a try is on, only the try itself is kept: other edits wait for Enter or Esc
    if (tryOn && next !== tryOn.tl) return;
    setLive(null);
    setTried(null);
    setGap(null);
    if (readOnly) return;
    const no = why(next);
    if (no) return void toast(no);
    setHist((h) => histChange(h, () => next, label));
  }, [readOnly, why, tryOn]);
  const live_ = useCallback((next: NleTimeline | null) => !readOnly && !tryOn && setLive(next), [readOnly, tryOn]);

  // a text clip plays its design's PNG from the server; a design deleted since is a red clip (asked once a PNG)
  const [gone, setGone] = useState<ReadonlySet<string>>(() => new Set());
  const urlOf = useCallback((src: string, t: NleTimeline): NleFile | null => (isDesign(t.sources[src]) ? designFile(t.sources[src], gone) : pageUrlOf(src, t)), [pageUrlOf, gone]);
  const asked = useRef(new Set<string>());
  useEffect(() => {
    for (const s of Object.values(tl.sources)) {
      const url = isDesign(s) ? designFile(s, gone).url : "";
      if (!url || asked.current.has(url)) continue;
      asked.current.add(url);
      void fetch(url, { method: "HEAD" }).then((r) => r.status === 404 && setGone((g) => new Set(g).add(String(s.path))), () => {});
    }
  }, [tl.sources]); // eslint-disable-line react-hooks/exhaustive-deps -- each PNG once
  // a new text clip's design, made once its clip is laid (by the menu or the chat): every step that has the clip gets it,
  // so undo and redo never make it twice
  const making = useRef(new Set<string>());
  useEffect(() => {
    for (const s of Object.values(tl.sources)) {
      const id = s.pending;
      if (!isDesign(s) || typeof id !== "string" || making.current.has(id)) continue;
      making.current.add(id);
      void makeText(String(s.words ?? ""), Number(s.w), Number(s.h)).then(
        (made) => fill(id, made),
        (e: Error) => fill(id, { kind: "design", failed: e.message }),
      );
    }
  }, [tl.sources]); // eslint-disable-line react-hooks/exhaustive-deps -- each new text once
  const fill = (id: string, made: NleSource) => {
    const one = (t: NleTimeline) => {
      const k = Object.keys(t.sources).find((x) => t.sources[x].pending === id);
      return k ? { ...t, sources: { ...t.sources, [k]: made } } : t;
    };
    setHist((h) => ({ ...h, past: h.past.map(one), now: one(h.now), future: h.future.map(one) }));
  };
  /** A text clip's source drawn again (a new PNG): one step. */
  const redrawn = (src: string, made: NleSource) => setHist((h) => histChange(h, (t) => (t.sources[src]?.design === made.design ? { ...t, sources: { ...t.sources, [src]: made } } : t), "Text"));

  // Design full screen over the editor (its keys are its own while it is open): a text clip's design, or a frame of the
  // video to design over, laid at frame `at` once it is done
  const [designing, setDesigning] = useState<{ id: string; src: string } | { id: string; at: number } | null>(null);
  const [reread, setReread] = useState(0);
  const viewerBox = useRef<HTMLElement | null>(null);
  const designDone = async () => {
    const was = designing;
    setDesigning(null);
    setReread((n) => n + 1);
    if (!was || readOnly) return;
    try {
      const d = await getDesign(was.id);
      if ("src" in was) {
        const s = latest.current.hist.now.sources[was.src];
        if (s) redrawn(was.src, await drawFrame(d, String(s.frame), renderScale(latest.current.hist.now, was.src, Number(s.w), Number(s.h))));
      } else if (d.pages[0]?.layers.some((l) => !l.reference && !l.hidden)) {
        const made = await drawFrame(d, d.pages[0].id, 1);
        setHist((h) => histChange(h, (t) => placeText(t, made, was.at).tl, "Design on This Frame"));
      }
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  const designOnFrame = async () => {
    const box = viewerBox.current?.closest<HTMLElement>("[data-frame]");
    if (!box) return;
    tln.play(false);
    const at = Math.round(now() * fps);
    const [W, H] = [tl.timeline.width || 1080, tl.timeline.height || 1920];
    try {
      const d = await grabDesign(await grabFrame(box, W, H), W, H);
      setDesigning({ id: d.id, at });
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const urlFor = useCallback((src: string) => urlOf(src, shown), [urlOf, shown]);
  const srcUrl = useCallback((k: string) => (srcTl ? urlOf(k, srcTl) : null), [urlOf, srcTl]);
  const nameOfSrc = useCallback((src: string) => isDesign(shown.sources[src]) ? "Text" : String(shown.sources[src]?.path ?? shown.sources[src]?.name ?? src).split("/").pop()!.replace(/\.[^.]+$/, "").replace(/[_-]?%0\d+d/, ""), [shown]);
  const nameOf = useCallback((it: NleItem) => (typeof it.name === "string" && it.name) || (typeof it.line === "string" && it.line ? `${it.line} · ${nameOfSrc(it.src)}` : nameOfSrc(it.src)), [nameOfSrc]);

  // a clip from the bin: its picture on a video track, its sound with it on a free sound track (F9 / F10: the one given),
  // linked; on a sound track its sound alone; only its `from`–`to` part when it has one
  const lay = (d: NleDrop, at: { track: string; frame: number; sound?: string }, how: PlaceMode = mode) => {
    if (readOnly) return;
    const known = { path: d.path, fps: d.fps, ...(d.seconds ? { dur: Math.round(d.seconds * (d.fps || fps)) } : {}), w: d.w, h: d.h };
    const s = d.src ? { src: d.src, tl: tl.sources[d.src] ? tl : { ...tl, sources: { ...tl.sources, [d.src]: { ...known, ...d.source } } } } : addSource(tl, known);
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
    if (isVideo(at.track)) lookCamera(s.src, d.path, made.tl);
  };
  // the camera curve its file names, read in the background onto its source: never in the way of laying the clip, and a
  // failed read records nothing
  const lookCamera = (src: string, path: string, at: NleTimeline) => {
    const f = urlOf(src, at);
    if (!f?.url || f.frame || f.why || !CAMERA_FILE.test(path) || at.sources[src]?.camera) return;
    void readCamera(rangeReader(f.url)).then((camera) => camera && setHist((h) => {
      const x = h.now.sources[src];
      const now = { ...h.now, sources: { ...h.now.sources, [src]: { ...x, camera } } };
      return x?.path === path && !x.camera && !beyond(now) ? { ...h, now } : h;
    }));
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
    const f = sfpsOf(d);
    // a drop naming its part opens on it, marked
    const part: Marks | null = d.from !== undefined ? [Math.round(d.from * f), d.to !== undefined ? Math.max(Math.round(d.from * f), Math.round(d.to * f) - 1) : null] : null;
    if (part) setSrcMarks((all) => ({ ...all, [d.path]: part }));
    if (part || d.path !== source?.path) srcT.seek(((part ?? srcMarks[d.path])?.[0] ?? 0) / f);
    // the part is the marks from here on: moved, they decide what is laid
    setSource(part ? { ...d, from: undefined, to: undefined } : d);
    setView("source");
  };
  const dropOfSrc = (src: string): NleDrop | null => {
    const s = tl.sources[src];
    const path = s?.path ?? (typeof s?.name === "string" ? s.name : undefined);
    if (!path) return null;
    return { path, src, name: nameOfSrc(src), fps: s.fps, w: s.w, h: s.h, ...(s.dur ? { seconds: s.dur / (s.fps || fps) } : {}) };
  };
  // F9 / F10: the source's marked part at the In mark or the playhead, on V1 and A1 or the picked clips' tracks
  const edit = (how: PlaceMode) => {
    if (!source) return;
    const t = editTracks(tl, sel);
    const track = srcPicture ? t.picture : t.sound;
    if (tl.tracks[track]) lay(marked(source), { track, frame: marks[0] ?? Math.round(now() * fps), sound: t.sound }, how);
  };
  if (control) control.current = { put: (d) => lay(marked(d), { track: "V1", frame: marks[0] ?? Math.round(now() * fps) }), source: openSource };

  // the Captions lane: Caption Studio's clip (components/nle/NleCaptions.tsx), made from the saved cut's render
  const cap = useCaptionClip(tl.captions);
  const [capBusy, setCapBusy] = useState(false);
  const [capMenu, setCapMenu] = useState<{ x: number; y: number } | null>(null);
  // burned in, Caption Studio's captions replace the caption cards in renders, so the viewer leaves them out too
  const burnt = !!tl.captions?.burn && !!cap?.clip && !captionsStale(shown);
  const viewed = useMemo(() => (burnt ? withoutCards(shown) : shown), [burnt, shown]);
  const sendCaptions = () => {
    if (!captions || capBusy || readOnly) return;
    if (dirty) return void toast.error("Save this cut first: its captions are made from the saved cut's render");
    const at = tl;
    setCapBusy(true);
    captions.send().then((r) => {
      // onto the timeline as it is now; `from` is the cut that was rendered
      setHist((h) => histChange(h, (now) => ({ ...now, captions: { project: r.project, clip: r.clip, burn: at.captions?.burn ?? false, from: fromOf(at) } }), at.captions ? "Update Captions" : "Make Captions"));
      if (r.note) toast(r.note);
    }, (e: Error) => toast.error(e.message)).finally(() => setCapBusy(false));
  };

  // the registry's commands (lib/nle/commands.ts) on the timeline as it is now; keys, the menu and the chat all run them
  const stateNow = (): NleState => ({ tl, sel, playhead: Math.round(now() * fps), marks, clipboard, mode, gap, trans: transPick });
  /** A command's state after, onto the page: a changed timeline as one undo step named `label` (read only: nothing), then
   *  the picks, the marks, what Paste lays and the playhead. */
  const apply = (s: NleState, next: NleState, label: string) => {
    if (next.tl !== s.tl) {
      if (readOnly || tryOn) return;
      commit(next.tl, label);
    } else if (next.gap !== s.gap) setGap(next.gap ?? null);
    if (next.sel !== s.sel) setSelected(next.sel);
    if ((next.trans ?? null) !== (s.trans ?? null)) pickTrans(next.trans ?? null);
    // picking clips (⌘A, Escape, the chat's ref) lets go of a picked transition
    else if (next.sel !== s.sel) pickTrans(null);
    if (next.marks !== s.marks) setMarks(next.marks);
    if (next.clipboard !== s.clipboard) clipboard = next.clipboard ?? [];
    if (next.playhead !== s.playhead) seek(next.playhead / fps);
    if (next.captionsAsk) sendCaptions();
  };
  const run = (id: string) => {
    const s = stateNow();
    if (COMMANDS[id].enabled(s)) apply(s, COMMANDS[id].run(s, {}), COMMANDS[id].title);
  };
  /** The Inspector's commands on clips `on` (the picks when left out), one undo step; the picks stay. */
  const runOn = (list: NleRun[], on?: string[]) => {
    const s = stateNow();
    try {
      const next = runAll(on ? { ...s, sel: on } : s, list);
      apply(s, { ...next, sel: s.sel }, [...new Set(list.map((r) => COMMANDS[r.id]?.title ?? r.id))].join(", "));
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  /** a command on one cut (the clip after it), from its menu: the picks and the playhead stay */
  const runAtCut = (id: string, cut: string) => {
    const s = stateNow();
    const c = find(tl, cut);
    if (c) apply(s, { ...COMMANDS[id].run({ ...s, sel: [cut], playhead: c.item.rec }, {}), sel: s.sel, playhead: s.playhead }, COMMANDS[id].title);
  };
  // M: a marker at the playhead, or the one there opened
  const marker = () => {
    const m = markerAt(tl, Math.round(now() * fps));
    if (m) setMarkerEdit(m.frame);
    else run("addMarker");
  };
  const exportMarkers = () => downloadText(`${tl.timeline.name || "Timeline"} Markers.csv`, markersCsv(tl), "text/csv;charset=utf-8");

  // The chat's editor commands (api/editor/nle-bridge.ts): asked for on topic nle:<this window>, taken once each, and run
  // here on the timeline as it is now, with its unsaved edits: a run is one undo step, unsaved like his own (Save stays his).
  const answer = useRef<(asks: NleAsk[]) => void>(() => {});
  answer.current = (asks) => {
    const m = PAGE.exec(window.location.pathname);
    const here = m && { edit: decodeURIComponent(m[1]), draft: decodeURIComponent(m[2]) };
    let s = stateNow();
    for (const a of asks) {
      const reply = (r: { result?: unknown; error?: string }) => void nleReply({ id: a.id, ...r }).catch(() => {});
      if (!here || here.edit !== a.edit || here.draft !== a.draft) {
        reply({ error: `This window has ${here ? `draft ${here.draft} of edit ${here.edit}` : "no timeline"} open, not draft ${a.draft} of edit ${a.edit}.` });
      } else if (a.kind === "state") reply({ result: stateView(s) });
      else if (readOnly) reply({ error: "This timeline is read-only here." });
      else if (tryOn) reply({ error: "A take is being tried on this timeline: it changes once the person keeps it (Enter) or drops it (Esc)." });
      else {
        try {
          const list = a.commands ?? [];
          const next = runAll(s, list);
          const no = next.tl !== s.tl ? why(next.tl) : null;
          if (no) throw new Error(no);
          apply(s, next, CHAT_STEP + list.map((r) => COMMANDS[r.id]?.title ?? r.id).join(", "));
          s = next;
          reply({ result: stateView(next) });
        } catch (e) {
          reply({ error: (e as Error).message });
        }
      }
    }
  };
  useEffect(() => {
    let on = true;
    const take = () => void nlePending(clientId).then(({ requests }) => {
      const fresh = requests.filter((a) => !taken.has(a.id));
      fresh.forEach((a) => taken.add(a.id));
      if (on && fresh.length) answer.current(fresh);
    }, () => {});
    const off = onTopic(`nle:${clientId}`, take);
    take(); // the ones waiting when the editor opened
    return () => {
      on = false;
      off();
    };
  }, []);

  const keepTry = () => tryOn && commit(tryOn.tl, tryOn.label);
  const save = async (): Promise<boolean> => {
    if (tryOn) return (toast("Enter keeps the take you're trying, Esc drops it"), false);
    if (!dirty) return true;
    if (saving || readOnly) return false;
    if (Object.values(tl.sources).some((s) => isDesign(s) && !s.path)) return (toast("A text is still being drawn", { description: "Save again in a moment, or delete it" }), false);
    const now = tl;
    try {
      await onSave(toSaved(now));
      setSaved(now);
      void markSaved(opened.current.key);
      return true;
    } catch {
      // not saved: the page says why, and the timeline stays as it is to save again
      return false;
    }
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- on a change of the timeline only
  useEffect(() => onChange?.(tl, saved), [tl, saved]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (designing) return;
      if ((e.target as HTMLElement | null)?.closest?.("input:not([type=range]):not([type=checkbox]), textarea, select, [contenteditable=true], [role=dialog]")) return;
      // the side panel's try: Enter keeps it, Esc drops it (the picked clips stay picked)
      if (tryOn && (e.key === "Enter" || e.key === "Escape") && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey
        && !(e.target as HTMLElement | null)?.closest?.("button, a[href], [role=menu]")) {
        e.preventDefault();
        return void (e.key === "Enter" ? keepTry() : setTried(null));
      }
      const k = commandOfKey(e, keys);
      const c = k && COMMANDS[k.id];
      if (!c) return;
      const zoom = (key: string) => zoomKeys.current?.(new KeyboardEvent("keydown", { key }));
      const { id, params } = k;
      // Q in the source viewer: back to the timeline (the owner's Q ripples on the timeline)
      if (id === "rippleStart" && inSource) show("timeline");
      else if (id === "addMarker") marker();
      else if (c.chat) {
        // playing, stepping and marks go to what the viewer shows (Source or Timeline)
        const X = VIEWER.has(id) ? T : tln;
        if (STEPS.has(id)) X.play(false);
        if (VIEWER.has(id) && inSource && source) {
          const s: NleState = { tl: srcTl!, sel: [], playhead: Math.round(srcT.now() * sfps), marks: sm };
          const next = c.run(s, params);
          if (next.marks !== sm) setSrcMarks((all) => ({ ...all, [source.path]: next.marks }));
          if (next.playhead !== s.playhead || HOME_END.has(id)) srcT.seek(next.playhead / sfps);
        } else {
          const s = stateNow();
          if (c.enabled(s)) {
            const next = c.run(s, params);
            apply(s, next, c.title);
            if (next.playhead === s.playhead && HOME_END.has(id)) seek(next.playhead / fps);
          }
        }
      } else switch (id) {
        case "play": T.play(!T.playing); break;
        case "stop": T.play(false); break;
        case "forward": T.shuttle(1); break;
        case "reverse": T.shuttle(-1); break;
        case "save": void save(); break;
        case "undo": setHist(histUndo); break;
        case "redo": setHist(histRedo); break;
        case "insertEdit": edit("insert"); break;
        case "overwriteEdit": edit("overwrite"); break;
        case "loop": toggleLoop(); break;
        case "toolSelect": setTool("select"); break;
        case "toolTrim": setTool("trim"); break;
        case "toolBlade": setTool("blade"); break;
        case "toolSlide": setTool("slide"); break;
        case "toolStretch": setTool("stretch"); break;
        case "exportMarkers": exportMarkers(); break;
        case "snap": setSnap((s) => !s); break;
        case "linkedSelection": toggleLinkSel(); break;
        case "zoomIn": zoom("="); break;
        case "zoomOut": zoom("-"); break;
        case "zoomFit": zoom("\\"); break;
        case "mediaPool": panelKeys.current?.("media"); break;
        case "inspector": panelKeys.current?.("inspector"); break;
        case "keyboard": setKeysOpen(true); break;
      }
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  /** a command's first chord, as the menus write it ("" when it has none) */
  const kl = (id: string) => chordLabel(chordsOf(keys, id)[0] ?? "");
  const tip = (id: string) => (kl(id) ? ` (${kl(id)})` : "");
  // one text clip picked: Design's text panel on it in the Inspector
  const textSrc = sel.length === 1 ? find(tl, sel[0])?.item.src : undefined;
  const textSource = textSrc && isDesign(tl.sources[textSrc]) && typeof tl.sources[textSrc].path === "string" ? tl.sources[textSrc] : null;
  const newTextRow: MenuRow = ["New Text", "", () => run("newText"), !!readOnly || !!gate, gate ?? undefined];
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
    <NleGate.Provider value={gateCtx}>
      <NleLayout panelKeys={panelKeys}
        chat={besideChat ? { bar, foot: foot?.({ changes: hist.past.length, dirty, save }) } : null}
        side={besideChat && side ? side({ tl, picked: sel, playhead: Math.round(tln.time * fps), commit: (next, label) => commit(next, label), source: openSource,
          preview: (next, label) => setTried(next && !readOnly ? { tl: next, label, base: tl } : null), trying: !!tryOn, commitPreview: () => void keepTry(),
          seek: (f) => (seek(f / fps), pick([])) }) : undefined}
        frame={{ w: tl.timeline.width || 1080, h: tl.timeline.height || 1920 }}
        center={
          <>
            {saving && <span className="min-w-0 truncate text-zinc-500">{saving.line}</span>}
            {!readOnly && (
              <button type="button" disabled={!dirty || !!saving} onClick={() => void save()}
                title={dirty ? `Save${tip("save")}: this timeline as this version's newest draft` : "Saved"}
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
          <NleMediaPool tl={tl} nameOf={nameOfSrc} here={urlFor} bin={bin} onRelink={onRelink} onNewText={readOnly ? undefined : () => run("newText")}
            onPick={(src) => setSelected(Object.values(tl.tracks).flatMap((t) => t.items.filter((i) => i.src === src).map((i) => i._k!)))}
            onOpen={(src) => { const d = dropOfSrc(src); if (d) openSource(d); }}
            onDrag={(src) => note(src ? dropOfSrc(src) : null)} onBinDrag={binDrag} />
        }
        viewer={
          <Panel title="Viewer" className="flex-1 select-none"
            bar={
              <div className="flex min-w-0 flex-1 items-center gap-2">
                <span className="inline-flex shrink-0 rounded border border-zinc-700/70 p-0.5" role="group" aria-label="Viewer shows">
                  {(["source", "timeline", ...(rendered ? ["rendered" as const] : [])] as const).map((v) => (
                    <button key={v} type="button" aria-pressed={view === v || (v === "timeline" && view === "rendered" && unrendered)} disabled={(v === "source" && !source) || (v === "rendered" && unrendered)} onClick={() => show(v)}
                      title={v === "source" ? "The clip opened from the Media Pool: mark In and Out, drag it on, F9 insert, F10 overwrite (Q back)"
                        : v === "rendered" ? (unrendered ? "Save to render the edits" : "The render of the saved timeline, with its texts and effects") : "The timeline"}
                      className={cn("h-5 rounded-[3px] px-1.5 capitalize disabled:opacity-40", view === v ? "bg-zinc-700 text-zinc-50" : "text-zinc-400 hover:text-zinc-100")}>{v}</button>
                  ))}
                </span>
                {(inSource || !picker || besideChat) && <span className={cn("min-w-0 truncate text-zinc-500", besideChat && "font-mono text-[11px]")}>{inSource ? source!.name : tl.timeline.name}</span>}
                {/* the timeline's: in the middle, in place of its name, a way to the edit's other timelines (beside the chats the page's bar has it) */}
                {picker && !inSource && !besideChat && (
                  <div className="pointer-events-none absolute inset-x-0 flex justify-center"><div className="pointer-events-auto max-w-[60%]">{picker}</div></div>
                )}
              </div>
            }>
            <NleViewer tl={inSource ? srcTl! : viewed} playhead={T.clock} rate={T.rate} urlOf={inSource ? srcUrl : urlFor}
              nameOf={inSource ? () => source!.name : nameOfSrc} onClick={() => T.play(!T.playing)}
              onMenu={(e) => { e.preventDefault(); viewerBox.current = e.currentTarget; setMenu({ x: e.clientX, y: e.clientY, on: "viewer" }); }}
              loop={loop ? (inSource ? loopPart(sm, srcFrames, sfps) : lengthOf(shown) ? loopPart(marks, lengthOf(shown), fps) : null) : null}
              onDragStart={inSource ? (e) => { e.dataTransfer.setData(VIEWER_MIME, "1"); e.dataTransfer.effectAllowed = "copy"; note(source); } : undefined}
              onDragEnd={() => note(null)}
              over={inSource ? (!srcPicture ? <SoundCard url={srcUrl(srcKey ?? "source")?.url ?? null} seconds={srcSecs} clock={srcT.clock} /> : null)
                : view === "rendered" && rendered && !unrendered ? <NleRendered url={rendered.url} clock={tln.clock} playing={tln.playing} />
                : cap?.clip && !captionsStale(shown) ? <CaptionsOver clip={cap.clip} clock={T.clock} fps={fps} /> : null}
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
                  <button type="button" aria-label="Loop" aria-pressed={loop} title={`Loop${tip("loop")}: plays In to Out, or all of it, round and round`} onClick={toggleLoop}
                    className={cn(iconBtn(loop), "w-7 justify-center", loop && "text-violet-300")}><Repeat className="size-3.5" /></button>
                </>
              } />
          </Panel>
        }
        inspector={<NleInspector tl={tl} keys={sel} nameOf={nameOf} onLive={live_} onCommit={commit} notes={notes} playhead={Math.round(tln.time * fps)}
          transKey={transPick} onRun={runOn} hist={hist} onHistory={(i) => setHist((h) => histGo(h, i))}
          autosaves={autosaves} onAutosave={restore}
          text={textSource && !readOnly ? (
            <NleText key={textSrc} source={textSource} scale={renderScale(tl, textSrc!, Number(textSource.w), Number(textSource.h))} reread={reread}
              onDrawn={(s) => redrawn(textSrc!, s)} onOpen={() => { tln.play(false); setDesigning({ id: String(textSource.design), src: textSrc! }); }} />
          ) : null} />}
        timeline={(full) => (
          // a click in the timeline puts the viewer back on it
          <div className="flex min-h-0 min-w-0 flex-1" onPointerDownCapture={() => view === "source" && show("timeline")}>
          <Timeline compact={!full} tl={shown} time={time} clock={tln.clock} selected={sel} tool={tool} snap={snap} linkedSelection={linkSel} marks={marks} onSeek={seek} onSelect={pick} gap={gap} onGap={setGap}
            trans={transPick} onTrans={pickTransAt} onMarker={setMarkerEdit} cached={cachedNow}
            onLive={live_} onCommit={commit} nameOf={nameOf} zoomKeys={zoomKeys} fileOf={urlFor}
            onBlade={(f, key) => commit(blade(tl, f, [key]))}
            onMenu={(at) => setMenu(at)}
            onTrack={(id, patch) => commit(setTrack(tl, id, patch))}
            onLowerUnderVoice={readOnly ? undefined : (duck) => setSound({ duck })}
            onDrop={readOnly ? undefined : dropOn}
            lane={captions && (full || tl.captions) ? {
              head: <CaptionsHead link={tl.captions} busy={capBusy} readOnly={readOnly} onMake={() => run("makeCaptions")} onBurn={() => run("burnCaptions")} onMenu={setCapMenu} />,
              body: (pps) => <CaptionsBody pps={pps} link={tl.captions} clip={cap ? cap.clip : undefined} captioning={!!cap?.captioning} stale={captionsStale(shown)} busy={capBusy} cards={captionCards(tl)}
                readOnly={readOnly} onUpdate={() => run("updateCaptions")} onOpen={() => tl.captions && captions.open(captionsHref(tl.captions))} />,
            } : undefined}
            tools={
              <>
                <button type="button" aria-pressed={tool === "select"} aria-label="Select" title="Select (A): move, trim the ends, ⌥ an end rolls" onClick={() => setTool("select")} className={iconBtn(tool === "select")}><MousePointer2 className="size-3.5" /></button>
                {full && <button type="button" aria-pressed={tool === "trim"} aria-label="Trim" title="Trim (T): slip a clip, ripple-trim the ends, ⌥ an end rolls" onClick={() => setTool("trim")} className={iconBtn(tool === "trim")}><UnfoldHorizontal className="size-3.5" /></button>}
                <button type="button" aria-pressed={tool === "blade"} aria-label="Blade" title="Blade (B): a click cuts there. W or ⌘B splits at the playhead" onClick={() => setTool("blade")} className={iconBtn(tool === "blade")}><Scissors className="size-3.5" /></button>
                {full && (<>
                <button type="button" aria-pressed={tool === "slide"} aria-label="Slide" title="Slide: drag a clip between its neighbours, they trim" onClick={() => setTool("slide")} className={iconBtn(tool === "slide")}><MoveHorizontal className="size-3.5" /></button>
                <button type="button" aria-pressed={tool === "stretch"} aria-label="Rate Stretch" title="Rate Stretch: drag an end, the clip plays faster or slower" onClick={() => setTool("stretch")} className={iconBtn(tool === "stretch")}><Gauge className="size-3.5" /></button>
                {sep}
                <span className="inline-flex shrink-0 rounded border border-zinc-700/70 p-0.5" role="group" aria-label="Edit mode">
                  {(["overwrite", "insert"] as const).map((m) => (
                    <button key={m} type="button" aria-pressed={mode === m} onClick={() => setMode(m)}
                      title={m === "overwrite" ? "A clip put on the timeline replaces what is under it" : "A clip put on the timeline pushes what is after it"}
                      className={cn("h-5 rounded-[3px] px-1.5 capitalize", mode === m ? "bg-zinc-700 text-zinc-50" : "text-zinc-400 hover:text-zinc-100")}>{m}</button>
                  ))}
                </span>
                <button type="button" aria-pressed={snap} aria-label="Snapping" title="Snapping (N)" onClick={() => setSnap(!snap)} className={iconBtn(snap)}><Magnet className="size-3.5" /></button>
                <button type="button" aria-pressed={linkSel} aria-label="Linked Selection" title={`Linked Selection${tip("linkedSelection")}`} onClick={toggleLinkSel} className={iconBtn(linkSel)}><Link2 className="size-3.5" /></button>
                </>)}
                {sep}
                <button type="button" aria-label="Undo" title={`Undo${tip("undo")}`} disabled={!hist.past.length} onClick={() => setHist(histUndo)} className={cn(iconBtn(false), "disabled:opacity-30")}><Undo2 className="size-3.5" /></button>
                <button type="button" aria-label="Redo" title={`Redo${tip("redo")}`} disabled={!hist.future.length} onClick={() => setHist(histRedo)} className={cn(iconBtn(false), "disabled:opacity-30")}><Redo2 className="size-3.5" /></button>
                {full && <button type="button" aria-label="Keyboard Customization" title={`Keyboard Customization${tip("keyboard")}`} onClick={() => setKeysOpen(true)} className={iconBtn(false)}><Keyboard className="size-3.5" /></button>}
              </>
            }
            end={<span className="flex min-w-0 items-center gap-2 truncate">{status}</span>} />
          {full && <NleMeter clock={tln.clock} />}
          </div>
        )} />

      {sound && "normalize" in sound && <NormalizeDialog tl={tl} keys={sound.normalize} onCommit={commit} onClose={() => setSound(null)} />}
      {sound && "duck" in sound && <LowerUnderVoiceDialog tl={tl} track={sound.duck} onCommit={commit} onClose={() => setSound(null)} />}
      {menu && (
        <div className="fixed inset-0 z-50" onPointerDown={() => setMenu(null)} onContextMenu={(e) => { e.preventDefault(); setMenu(null); }}>
          <div role="menu" className="fixed w-52 rounded-md border border-zinc-800 bg-zinc-950 py-1 shadow-xl" style={{ left: menu.x, top: Math.min(menu.y, window.innerHeight - 300) }}
            onPointerDown={(e) => e.stopPropagation()}>
            {menu.on === "clip" && menu.cut && (
              <div className="group/sub relative">
                <button type="button" role="menuitem" aria-haspopup="menu" className={menuRow}><span>Add Transition</span><ChevronRight className="size-3.5 text-zinc-500" /></button>
                <div role="menu" aria-label="Add Transition" className="absolute -top-1 left-full hidden w-44 rounded-md border border-zinc-800 bg-zinc-950 py-1 shadow-xl group-focus-within/sub:block group-hover/sub:block">
                  {(isVideo(find(tl, menu.cut)?.track ?? "V") ? [["Cross Dissolve", "addDissolve"], ["Dip to Black", "addDipToBlack"], ["Dip to White", "addDipToWhite"]] : [["Cross Fade", "addDissolve"]]).map(([l, id]) => (
                    <button key={id} type="button" role="menuitem" disabled={!!gate} title={gate ?? undefined} className={menuRow} onClick={() => { setMenu(null); runAtCut(id, menu.cut!); }}>
                      <span>{l}</span><span className="text-zinc-500">{kl(id)}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
            {(menu.on === "gap" ? [["Close Gap", kl("closeGap"), () => run("closeGap"), false], newTextRow] as MenuRow[]
              : menu.on === "ruler" ? [
                ["Add Marker", kl("addMarker"), marker, false],
                ["Export Markers…", kl("exportMarkers"), exportMarkers, !markersOf(tl).length],
                newTextRow,
              ] as MenuRow[]
              : menu.on === "lane" ? [newTextRow]
              // a catalog original is never drawn into a design: only blurred copies, his own files and designs (canGrab)
              : menu.on === "viewer" ? [["Design on This Frame", "", () => void designOnFrame(), readOnly || !!gate || inSource || !canGrab(shown, Math.round(tln.now() * fps), urlFor), gate ?? undefined] as MenuRow]
              : [
              ["Cut", kl("cut"), () => run("cut"), false],
              ["Copy", kl("copy"), () => run("copy"), false],
              ["Paste", kl("paste"), () => run("paste"), !clipboard.length],
              ["Duplicate", kl("duplicate"), () => run("duplicate"), false],
              ["Delete", kl("delete"), () => run("delete"), false],
              ["Ripple delete", kl("rippleDelete"), () => run("rippleDelete"), false],
              [linked ? "Unlink" : "Link", "", () => commit(linked ? unlink(tl, sel) : linkTogether(tl, sel)), !linked && sel.length < 2],
              ["Normalize Audio Levels…", "", () => setSound({ normalize: sel }), readOnly || !!gate || !soundKeys(tl, sel).length, gate ?? undefined],
            ] as MenuRow[]).map(([l, key, fn, off, why]) => (
              <button key={l} type="button" role="menuitem" disabled={off} title={why} className={menuRow} onClick={() => { setMenu(null); fn(); }}>
                <span>{l}</span><span className="text-zinc-500">{key}</span>
              </button>
            ))}
          </div>
        </div>
      )}
      {keysOpen && <NleKeyboard onClose={() => setKeysOpen(false)} />}
      {designing && <Suspense><DesignEditor id={designing.id} onDone={() => void designDone()} /></Suspense>}
      {capMenu && (
        <div className="fixed inset-0 z-50" onPointerDown={() => setCapMenu(null)} onContextMenu={(e) => { e.preventDefault(); setCapMenu(null); }}>
          <div role="menu" className="fixed w-52 rounded-md border border-zinc-800 bg-zinc-950 py-1 shadow-xl" style={{ left: capMenu.x, top: Math.min(capMenu.y, window.innerHeight - 160) }}
            onPointerDown={(e) => e.stopPropagation()}>
            {([
              [tl.captions ? "Update Captions" : "Make Captions", () => run(tl.captions ? "updateCaptions" : "makeCaptions"), readOnly || capBusy || (!!tl.captions && !captionsStale(tl))],
              ["Open in Caption Studio", () => tl.captions && captions?.open(captionsHref(tl.captions)), !tl.captions],
              ["Export Subtitles…", () => cap?.clip && downloadSrt(tl.timeline.name ?? "", cap.clip), !cap?.clip?.cues?.length],
            ] as [string, () => void, boolean][]).map(([l, fn, off]) => (
              <button key={l} type="button" role="menuitem" disabled={off} className={menuRow} onClick={() => { setCapMenu(null); fn(); }}>{l}</button>
            ))}
          </div>
        </div>
      )}
      {markerEdit !== null && markersOf(tl).some((m) => m.frame === markerEdit) && (
        <NleMarkerDialog key={markerEdit} marker={markersOf(tl).find((m) => m.frame === markerEdit)!} fps={fps} onClose={() => setMarkerEdit(null)}
          onDone={(patch) => { commit(setMarker(tl, markerEdit, patch), "Edit marker"); setMarkerEdit(null); }}
          onDelete={() => { commit(removeMarker(tl, markerEdit), "Delete marker"); setMarkerEdit(null); }} />
      )}
    </NleGate.Provider>
  );
}
