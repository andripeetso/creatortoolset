import { useEffect, useMemo, useRef, useState } from "react";
import type { ReviewEditRef, ReviewPlayCard, ReviewPlayPlan, ReviewSlotContext, ReviewTimelineSlot } from "@/lib/plugin";
import { CameraView, RecropBox } from "@/components/RecropBox";
import { toast } from "sonner";
import { EditTimeline, type Placeholder, type TimelineRules } from "@/components/EditTimeline";
import { getEdit, makeCut, retryJob } from "@/lib/editor";
import { useCachedLoad } from "@/lib/local-cache";
import type { Edit } from "@contracts/editor";
import { GradeFilter, GradePanel } from "@/components/GradePanel";
import { FacePanel } from "@/components/FacePanel";
import type { Grade } from "@contracts/grade";
import { loudest, peaks } from "@/lib/waveform";
import { allGranted, localMediaFiles, localMediaUrl } from "@/lib/local-files";
import { findOriginals, openOriginals, type Originals } from "@/lib/relink";
import {
  cameraIn,
  clampCrop,
  cropToFraming,
  framingToCrop,
  PLACEHOLDER_LOOKS,
  picturePieces,
  playPlan,
  renderPieces,
  soundPieces,
  type PlayCard,
  splitView,
  stackEdits,
  type CropBox,
  type Framing,
  type ItemEdit,
  type TimelineItem,
  type TimelineView,
} from "@contracts/edit-timeline";
import {
  EMPTY_PENDING,
  freshHist,
  histChange,
  histRedo,
  histUndo,
  layOn,
  sentForm,
  sentOf,
  type Hist,
  type Pending,
} from "@/lib/edit-history";

// Review's timeline editor, on every version with a timeline (an imported XML, FCPXML, OTIO or EDL, or one a plug-in
// filed), under the header. Moves, trims, cuts, removals, colour and a placeholder, with ⌘Z / ⇧⌘Z for its own edits.
// They play on the player (the preview plan) and go into the comment box as chips; the next comment carries them
// under REVIEW_TIMELINE_ID. What open comments already sent stays on the timeline until they are resolved (`sent`).
// Everyone who can watch the version sees it and can pin a comment to a clip (`pin`, from the page); the edit tools
// are the managers'. The reframe window and full-quality colour need the
// AI edit behind the version and a plug-in that sends its camera files (`hooks`, lib/plugin.ts ReviewTimelineSlot).
// On a cut the app's own AI Editor made (`version.draft`), Make the next version cuts the edits into it as they are,
// with no AI (api/editor/edits.ts), and the timeline offers only the edits that makes (OWN_RULES). The panel follows that
// edit's steps for this version: it says while the next version is being made, takes it in when it is filed, and shows
// a step that failed with Try again. The edit loads for its creator only, so nobody else gets the button.

/** The id the editor's data goes under on a comment (`plugins[id]`); no plug-in may take it. */
export const REVIEW_TIMELINE_ID = "timeline-edits";

/** The page's comment pins: the clip the comment being written is about, how many comments sit on each clip. */
export interface TimelinePins {
  selected: string | null;
  /** the other clips of a comment about several, ringed with `selected` */
  marked?: string[];
  pins: Record<string, number>;
  /** a click on a clip (Shift/⌘-click: `group` is every clip picked) */
  /** `editing`: picked in the timeline's Edit mode, where the keys stay the timeline's (Delete, Q / W, the nudges) */
  onSelect: (item: TimelineItem | null, group?: TimelineItem[], editing?: boolean) => void;
  onPin: (key: string) => void;
  /** the comment's time range (seconds); a drag across empty lane space sets it */
  range?: [number, number] | null;
  onRange?: (from: number, to: number) => void;
  onClearRange?: () => void;
}

export default function ReviewEdits(ctx: ReviewSlotContext & { hooks?: ReviewTimelineSlot; pin?: TimelinePins; faceAt?: number | null }) {
  const { version } = ctx;
  if (!version.timeline) return null;
  // a new version starts clean: the panel remounts per version
  return <Edits key={version.n} {...ctx} hooks={ctx.hooks ?? {}} edit={version.edit} />;
}

/** What the app's own AI Editor cuts into a version: a voice stays with its picture (cut, pulled in or taken out), the layers stay as they are. */
const OWN_RULES: TimelineRules = { can: (it, mode) => it.track !== "A1" || mode === "head" || mode === "tail", layers: false };

const framingOf = (i: TimelineItem): Framing => ({ zoom: i.zoom ?? 1, pan: i.pan ?? 0, tilt: i.tilt ?? 0 });
const secs = (s: number) => `${s.toFixed(1)}s`;
// the SVG filter id of a grade span, by its place in the plan (the plan is rebuilt on each render, so an index is stable)
const gradeId = (i: number) => `review-grade-${i}`;
// the SVG filter of the grade the colour panel is showing on its shot (see `shotLook`)
const LIVE_GRADE = "review-grade-live";

/** A planned card as the page draws it: a plug-in's clip plays in it, for managers only. */
const toCard = (c: PlayCard, manage: boolean, clipSrc?: (clip: number) => string): ReviewPlayCard => ({
  from: c.from,
  to: c.to,
  track: c.track,
  label: c.label,
  kind: c.kind,
  look: c.look,
  color: c.color,
  ...(manage && clipSrc && c.clip !== undefined ? { src: clipSrc(c.clip), at: c.at } : {}),
});

function Edits({ asset, version, api, reload, player, composer, history, preview, sent, edit, manage, hooks, pin, faceAt }: ReviewSlotContext & { edit?: ReviewEditRef; hooks: ReviewTimelineSlot; pin?: TimelinePins; faceAt?: number | null }) {
  const [view, setView] = useState<TimelineView | null>(null);
  const [hist, setHist] = useState<Hist<Pending>>(() => freshHist(EMPTY_PENDING));
  const [crop, setCrop] = useState<{ item: TimelineItem; box: CropBox } | null>(null);
  // the edit being dragged (an edge or a slip plays as it goes), and the preview: the planned edits play over the old cut
  const [live, setLive] = useState<[TimelineItem, Partial<ItemEdit>][] | null>(null);
  const [previewOn, setPreviewOn] = useState(true);
  // a cut of the app's own AI Editor: its timeline edits can be made into the next version, and it is being asked for
  const own = manage ? version.draft : undefined;
  const [making, setMaking] = useState(false);
  const ownEdit = useCachedLoad<Edit>(own ? `/api/editor/${own.edit}` : null, () => getEdit(own!.edit));
  const ownJobs = own ? (ownEdit.data?.jobs ?? []).filter((j) => j.variant === own.name) : [];
  const working = ownJobs.find((j) => j.state === "running") ?? ownJobs.find((j) => j.state === "queued");
  const failed = working ? undefined : ownJobs.find((j) => (j.state === "failed" || j.state === "needs_key") && j.error !== "Stopped");
  // the version that was being made is filed: the page takes it in
  const wasWorking = useRef(false);
  useEffect(() => {
    if (wasWorking.current && !working && !failed) void reload();
    wasWorking.current = !!working;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- when the steps start, end or fail
  }, [!!working, !!failed]);
  // the talent shot being graded (the colour panel, opened from the timeline's Color) and the grade it shows while you work
  const [colour, setColour] = useState<TimelineItem | null>(null);
  const [liveGrade, setLiveGrade] = useState<Grade | null>(null);
  // the talent shot Face is open on (the face refinement strength, from a plug-in that renders it)
  const [face, setFace] = useState<TimelineItem | null>(null);
  // the comment box's text: a placeholder's words are its label on the picture (the page's own text, as typed)
  const [text, setText] = useState("");
  const [time, setTime] = useState(0);
  // the whole camera frame under the reframe window: its URL once the plug-in has it
  const [cam, setCam] = useState<{ url?: string; error?: string }>({});
  const camAsk = useRef<AbortController | null>(null);
  // the slot's functions are rebuilt on each render: read the latest through refs, and subscribe once
  const slots = useRef({ player, composer, preview });
  slots.current = { player, composer, preview };
  // the colour panel's video: read on each use, so a remounted player element is the one it grades
  const video = useMemo(() => ({ get current() { return slots.current.player.video(); } }), []);
  useEffect(() => () => camAsk.current?.abort(), []);
  // the edit's recordings on this computer (source key to path: an AI edit's from the plug-in, an imported timeline's
  // from its file; managers only) and the ones the Mac app plays (lib/relink.ts): with every voice clip's file found,
  // the timeline's edits play with their real sound (a voice pulled out plays its words)
  const [originals, setOriginals] = useState<Originals | null>(null);
  const store = () => `${asset.id}.${version.n}`; // what was found here, per version
  useEffect(() => {
    const sources = edit ? hooks.sources && ((s: AbortSignal) => hooks.sources!(edit, s)) : () => api.timelineSources(version.n);
    if (!manage || !sources || !localMediaFiles()) return;
    const ctl = new AbortController();
    sources(ctl.signal).then(async (paths) => {
      if (!Object.keys(paths).length || ctl.signal.aborted) return;
      const o = await openOriginals(paths, store());
      if (!ctl.signal.aborted) setOriginals(o);
    }, () => {});
    return () => ctl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per edit
  }, [edit?.project, edit?.draft, manage]);
  const allowOriginals = async () => {
    if (originals) setOriginals(await findOriginals(originals, store()));
  };
  const { edits: handEdits, hole } = hist.now;
  const { edits: sentEdits, holes: sentHoles } = sentOf(sent);
  const planEdits = stackEdits([sentEdits, handEdits]);

  // the timeline of this version (404 when it has none)
  useEffect(() => {
    if (!version.timeline) return;
    let gone = false;
    api
      .timeline(version.n)
      .then((v) => !gone && setView(v as unknown as TimelineView), () => !gone && setView(null));
    return () => {
      gone = true;
    };
  }, [api, version.n, version.timeline]);

  // the audio lanes' waveforms: the voice on A1 and the rest of the sound on the others (the
  // version's stems), else the video's own sound on every one (an imported timeline)
  const [waves, setWaves] = useState<Record<string, Float32Array> | null>(null);
  const [clipWaves, setClipWaves] = useState<Record<string, Float32Array> | null>(null);
  const stems = version.stems;
  useEffect(() => {
    setWaves(null);
    if (!version.timeline || version.status !== "ready" || version.removed) return;
    let gone = false;
    const got = stems
      ? Promise.all([
        Promise.all(stems.groups.map((g) => peaks(api.stem(version, `${g.key}.original.m4a`)))).then(loudest),
        peaks(api.stem(version, "rest.m4a")),
      ]).then(([A1, rest]) => ({ A1, "*": rest }))
      : peaks(api.media(version, "play")).then((mix) => ({ "*": mix }));
    got.then((w) => !gone && setWaves(w), () => {});
    return () => {
      gone = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per version and its sound
  }, [api, version.n, version.timeline, version.status, version.removed, stems]);

  // the playhead, for the timeline's cursor
  useEffect(() => {
    const t = window.setInterval(() => setTime(slots.current.player.video()?.currentTime ?? 0), 200);
    return () => window.clearInterval(t);
  }, []);

  // what the comment box shows and carries: the edits with an open reframe made (as Send does), and the placeholder.
  // Keyed on state only: the slot's `sent` array is new on every render, and a dependency on it would loop.
  useEffect(() => {
    const c = slots.current.composer;
    const fps = view?.fps || version.fps || 25;
    const outgoing = withCropOf(handEdits, crop, view, sentEdits);
    const { chips, payload } = sentForm(handEdits, outgoing, hole, fps);
    c.setPending(chips);
    c.setPayload(payload);
    c.setNeedsText(hole ? "Say what goes in the placeholder" : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sentEdits comes from `sent`, which is new each render
  }, [handEdits, hole, crop, view, version.fps]);

  useEffect(() => slots.current.composer.onText(setText), []);
  // a sent comment clears them; the ⌘Z history registers once
  useEffect(() => slots.current.composer.onSent(() => {
    setHist(freshHist(EMPTY_PENDING));
    setCrop(null);
  }), []);
  useEffect(() => history.register({ undo, redo }), []);
  useEffect(() => () => {
    slots.current.composer.setPending([]);
    slots.current.composer.setPayload(null);
    slots.current.composer.setNeedsText(null);
    slots.current.preview.setPlan(null);
  }, []);

  const change = (fn: (p: Pending) => Pending) => setHist((h) => histChange(h, fn));
  const applyEdits = (changes: [TimelineItem, Partial<ItemEdit>][]) => change((p) => ({
    ...p,
    edits: changes.reduce((acc, [item, patch]) => layOn(sentEdits, acc, item.key, item.label, patch), p.edits),
  }));
  const setHole = (v: Placeholder | null) => change((p) => ({ ...p, hole: v }));
  const undo = () => setHist(histUndo);
  const redo = () => setHist(histRedo);
  const makeNext = () => {
    if (!own) return;
    setMaking(true);
    makeCut(own.edit, own.name, { asset: asset.id, n: version.n, edits: planEdits })
      .then((e) => {
        ownEdit.set(e);
        setHist(freshHist(EMPTY_PENDING));
        setCrop(null);
      }, (e: Error) => toast.error(e.message || "Couldn't make the next version"))
      .finally(() => setMaking(false));
  };

  // the camera frame from the plug-in (it may have to make it first); a newer ask or leaving the page stops the last one
  const askCamera = () => {
    const camera = hooks.camera;
    if (!edit || !camera) return;
    camAsk.current?.abort();
    const ctl = (camAsk.current = new AbortController());
    setCam({});
    camera(edit, ctl.signal).then(
      (url) => !ctl.signal.aborted && setCam({ url }),
      (e: Error) => !ctl.signal.aborted && setCam({ error: e.message || "Couldn't get the camera frame" }),
    );
  };

  // the planned edits as the player plays them: the open comments' edits and the ones being made (an edge being dragged
  // plays as it goes), cut at their frames; placeholders sent and being written. Off = the cut as rendered.
  const playEdits = live
    ? stackEdits([sentEdits, live.reduce((acc, [i, p]) => layOn(sentEdits, acc, i.key, i.label, p), handEdits)])
    : planEdits;
  const plan = view && previewOn
    ? playPlan(splitView(view, playEdits), playEdits, [...sentHoles, ...(hole ? [{ ...hole, text: text.trim() || hole.text }] : [])])
    : null;
  // played from the originals, only while there are edits (else the cut plays as rendered, its voice controls on): each
  // voice clip from its recording and the rest of the sound (music, effects) from the cut's own stem between the skips
  // and holds; a version without stems (an imported timeline) plays every audio lane from its files
  const soundLanes = version.stems ? ["A1"] : (view?.tracks ?? []).filter((t) => t.id[0] === "A").map((t) => t.id);
  // the voice clips' files: all found = played from them; else the header offers to find them
  const voiceFiles = [...new Set((view?.tracks.find((t) => t.id === "A1")?.items ?? []).flatMap((i) => i.src && originals?.paths[i.src] ? [i.src] : []))];
  const filesFound = voiceFiles.filter((s) => originals?.found[s]).length;
  const originalsOn = voiceFiles.length > 0 && filesFound === voiceFiles.length;
  const sound = view && plan && originals && originalsOn && (plan.skips.length + plan.mutes.length + plan.holds.length > 0) ? [
    ...soundPieces(splitView(view, playEdits), playEdits, plan, soundLanes)
      .filter((p) => originals.found[p.src]).map((p) => ({ ...p, src: localMediaUrl(originals.found[p.src]) })),
    ...(version.stems ? renderPieces(plan, Math.round(version.duration * view.fps), view.fps, api.stem(version, "rest.m4a")) : []),
  ] : null;
  // and the talent shots from their camera originals, framed as cut: a shot made longer shows the take past the cut
  const picture = sound && view ? picturePieces(splitView(view, playEdits), playEdits, plan!, (s) => !!originals!.found[s])
    .filter((p) => originals!.found[p.src])
    .map(({ src, at, frames, offset, zoom, pan, tilt }) => {
      const box = cameraIn({ zoom, pan, tilt }, { x: 0, y: 0, k: 1 }, view.width, view.height);
      return { src: localMediaUrl(originals!.found[src]), at, frames, offset, x: box.x, y: box.y, s: box.s };
    }) : null;
  // each sound clip's own waveform from its file, once the files are found: the timeline draws a clip and what its
  // edges are pulled out to from it (`waves[item.key]`, the file from its first second), so a stretched edge shows the
  // words that are really there. Sound files only: a camera file would be decoded whole for its sound.
  const audioFile = (p: string) => /\.(wav|aif|aiff|m4a|mp3|flac|caf)$/i.test(p);
  const waveFiles = originalsOn && originals ? Object.entries(originals.found).filter(([, p]) => audioFile(p)) : [];
  const waveKey = JSON.stringify(waveFiles);
  useEffect(() => {
    if (!waveFiles.length || !view) return void setClipWaves(null);
    let gone = false;
    Promise.all(waveFiles.map(([src, p]) => peaks(localMediaUrl(p)).then((d): [string, Float32Array] => [src, d], () => null)))
      .then((got) => {
        if (gone) return;
        const bySrc = Object.fromEntries(got.filter((g): g is [string, Float32Array] => !!g));
        const out: Record<string, Float32Array> = {};
        for (const t of view.tracks) {
          if (t.id[0] !== "A") continue;
          for (const it of t.items) if (it.src && bySrc[it.src]) out[it.key] = bySrc[it.src];
        }
        setClipWaves(Object.keys(out).length ? out : null);
      });
    return () => {
      gone = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per set of found files
  }, [waveKey, view]);
  const planned = !!plan && (plan.skips.length + plan.mutes.length + plan.holds.length + plan.cards.length + plan.frames.length + plan.grades.length > 0);
  // the shot being graded plays the panel's grade over its whole span while the panel is open, in place of the shot's
  // planned grades (while the reframe window is open the picture takes no look)
  const shotLook = colour && liveGrade && !crop ? { from: colour.rec, to: colour.rec + colour.len, was: colour.grade, grade: liveGrade } : null;
  const grades = (plan?.grades ?? []).filter((g) => !shotLook || g.to <= shotLook.from || g.from >= shotLook.to);
  // what the player is told: skips, holds, mutes and reframes as they are, the cards (B-roll, graphics, placeholders,
  // gone ones too: the page draws them), and the grades as looks over their spans. A plug-in's clip plays in its card for managers only.
  const play: ReviewPlayPlan | null = view && (planned || shotLook) ? {
    fps: view.fps || version.fps || 25,
    skips: plan?.skips ?? [],
    mutes: plan?.mutes ?? [],
    holds: plan?.holds ?? [],
    cards: plan?.cards.map((c) => toCard(c, manage, hooks.clipSrc)) ?? [],
    frames: plan?.frames ?? [],
    looks: crop ? [] : [
      ...grades.map((g, i) => ({ from: g.from, to: g.to, filter: `url(#${gradeId(i)})` })),
      ...(shotLook ? [{ from: shotLook.from, to: shotLook.to, filter: `url(#${LIVE_GRADE})` }] : []),
    ],
    ...(sound ? { sound } : {}),
    ...(picture?.length ? { picture } : {}),
  } : null;
  const playJson = JSON.stringify(play);
  // a new plan goes to the player; the page compares it with the last one, so a same plan costs nothing
  useEffect(() => {
    slots.current.preview.setPlan(play);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the JSON, so a rebuilt object does not resend
  }, [playJson]);

  // a link with ?face=<frame> (the assistant's "refine my face") opens Face on the talent shot at that frame, once
  const faceOpened = useRef(false);
  useEffect(() => {
    if (!view || faceAt == null || faceOpened.current || !manage || !edit || !hooks.face) return;
    faceOpened.current = true;
    const f = faceAt;
    const shots = view.tracks.flatMap((t) => t.items).filter((i) => i.track === "V1");
    const it = shots.find((i) => f >= i.rec && f < i.rec + i.len) ?? shots[0];
    if (!it) return;
    slots.current.player.pause();
    slots.current.player.seek((f >= it.rec && f < it.rec + it.len ? f : it.rec + Math.floor(it.len / 2)) / (view.fps || version.fps || 25));
    setFace(it);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per link, when the timeline is there
  }, [view, faceAt]);

  if (!view) return null;
  const fps = view.fps || version.fps || 25;
  const w = view.width;
  const h = view.height;
  const shown = splitView(view, planEdits);

  // the reframe window opens on the shot as it is now, or as a pending reframe left it
  // Face: paused on the shot (its middle, when the playhead is elsewhere); Color and Reframe close
  const openFace = (item: TimelineItem) => {
    slots.current.player.pause();
    setCrop(null);
    setColour(null);
    const f = time * fps;
    if (f < item.rec || f >= item.rec + item.len) slots.current.player.seek((item.rec + Math.floor(item.len / 2)) / fps);
    setFace(item);
  };
  const reframe = (item: TimelineItem) => {
    const f0 = framingOf(item);
    const e = handEdits.find((x) => x.key === item.key);
    const box = e?.zoom !== undefined
      ? framingToCrop(f0, { zoom: e.zoom, pan: e.pan ?? 0, tilt: e.tilt ?? 0 }, w, h)
      : { x: 0, y: 0, k: 1 };
    setFace(null);
    setCrop({ item, box: clampCrop(f0, box, w, h) });
    askCamera();
  };
  // Apply: a window back at the AI's framing clears the reframe; anything else sets the new zoom, pan and tilt
  const applyCrop = () => {
    if (!crop) return;
    const { item, box } = crop;
    const same = Math.abs(box.k - 1) < 0.005 && Math.abs(box.x) < 0.003 && Math.abs(box.y) < 0.003;
    const patch: Partial<ItemEdit> = same
      ? { zoom: undefined, pan: undefined, tilt: undefined }
      : cropToFraming(framingOf(item), box, w, h);
    change((p) => ({ ...p, edits: layOn(sentEdits, p.edits, item.key, item.label, patch) }));
    setCrop(null);
  };
  const looks = PLACEHOLDER_LOOKS;

  return (
    <div className="space-y-2 px-3 pb-2">
      {/* the grade looks the player takes (its filter ids are in `play.looks`); url(#id) resolves across the page */}
      {grades.map((g, i) => <GradeFilter key={gradeId(i)} id={gradeId(i)} from={g.was} to={g.grade} />)}
      {shotLook && <GradeFilter id={LIVE_GRADE} from={shotLook.was} to={shotLook.grade} />}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-[11px] text-zinc-500">
          {own ? "Timeline edits: make the next version from them, or send them with a comment" : manage ? "Timeline edits: sent with your next comment" : "Click a clip to comment on it"}
          {originals && voiceFiles.length > 0 && !originalsOn && (
            <button onClick={() => void allowOriginals()} className="rounded px-1.5 py-0.5 text-violet-300 hover:bg-zinc-800"
              title="Your edits play with the real sound from the original recordings: allow their folder, or the folder they are in now">
              {originals.tried || voiceFiles.some((s) => allGranted([originals.paths[s]], originals.folders))
                ? "Find the original files" : "Play edits from the originals"}
            </button>
          )}
          {originals?.tried && !originalsOn && voiceFiles.length > 0 && <span>{filesFound} of {voiceFiles.length} files found</span>}
        </div>
        {own && ownEdit.data && !working && planEdits.length > 0 && !crop && (
          <button type="button" disabled={making || !!hole} onClick={makeNext}
            title={hole ? "A placeholder goes with a comment: send it or drop it first" : "Cut the next version from these timeline edits as you made them, with no AI"}
            className="ml-auto rounded-full bg-violet-600 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-violet-500 disabled:opacity-40">
            {making ? "Starting…" : "Make the next version"}
          </button>
        )}
        {(planned || !previewOn) && !crop && (
          <button type="button" onClick={() => setPreviewOn((v) => !v)}
            title="Play your timeline edits and placeholders on this cut (cards where B-roll or a placeholder goes, cut frames skipped, longer shots held, reframes zoomed)"
            className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${previewOn ? "bg-violet-600 text-white" : "bg-zinc-800 text-zinc-300"}`}>
            {previewOn ? "Edits shown" : "Edits hidden"}
          </button>
        )}
      </div>
      {own && working && (
        <div className="text-[11px] text-violet-300">Making the next version{working.line ? `: ${working.line}` : "…"} It shows up here when it is ready.</div>
      )}
      {own && failed && (
        <div className="flex items-center gap-2 text-[11px] text-rose-400">
          <span className="min-w-0 flex-1">The next version wasn't made: {failed.error}</span>
          <button type="button" onClick={() => retryJob(own.edit, failed.id).then(ownEdit.set, (e: Error) => toast.error(e.message))}
            className="shrink-0 rounded border border-rose-400/50 px-1.5 py-0.5 text-rose-200 hover:bg-rose-950">
            Try again
          </button>
        </div>
      )}
      {sentEdits.length > 0 && (
        <div className="text-[11px] text-zinc-500">
          {sentEdits.length} edit{sentEdits.length === 1 ? "" : "s"} already sent with an open comment, shown until it is resolved
        </div>
      )}
      {crop && (
        <div className="relative mx-auto" style={{ width: "min(100%, 360px)", aspectRatio: `${w} / ${h}` }}>
          {cam.url && (() => {
            // the whole camera frame under the render: the picture past the AI's framing, on the playhead's frame
            const r = cameraIn(framingOf(crop.item), crop.box, w, h);
            return <CameraView src={cam.url!} time={time}
              style={{ left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.s * 100}%`, height: `${r.s * 100}%` }} />;
          })()}
          <RecropBox
            box={crop.box}
            framing={framingOf(crop.item)}
            w={w}
            h={h}
            onChange={(box) => setCrop((c) => c && { ...c, box })}
            onApply={applyCrop}
            onCancel={() => setCrop(null)}
          />
        </div>
      )}
      {crop && !cam.url && (
        <div className={cam.error ? "text-[11px] text-rose-400" : "text-[11px] text-zinc-500"}>
          {cam.error ?? "Getting the whole camera frame from the Mac…"}
        </div>
      )}
      {hole && (
        <div className="flex items-center gap-2 rounded-md border border-amber-700/70 bg-amber-950/30 px-2 py-1 text-xs text-amber-200">
          <span className="min-w-0 flex-1 truncate">
            Placeholder on {hole.track} · {secs(hole.rec / fps)} → {secs((hole.rec + hole.len) / fps)}
          </span>
          <button aria-label="Drop the placeholder" onClick={() => setHole(null)}
            className="rounded px-1 text-amber-400 hover:text-zinc-50">×</button>
        </div>
      )}
      {hole && hole.track[0] === "V" && (
        <div className="flex items-center gap-1 text-[11px] text-zinc-400">
          <span>Look</span>
          {looks.map((l) => (
            <button key={l} onClick={() => setHole({ ...hole, look: l })}
              className={`rounded px-1.5 py-0.5 capitalize ${(hole.look ?? "card") === l ? "bg-violet-600 text-white" : "hover:bg-amber-900/40"}`}>
              {l}
            </button>
          ))}
          {hole.look === "solid" && (
            <input type="color" aria-label="Placeholder colour" value={hole.color ?? "#6d28d9"}
              onChange={(e) => setHole({ ...hole, color: e.target.value })} />
          )}
        </div>
      )}
      {face && edit && hooks.face && (
        <FacePanel slot={hooks.face} edit={edit} item={face} fps={fps} video={video} onClose={() => setFace(null)} />
      )}
      {colour && (
        <GradePanel view={view} item={colour} video={video} edit={edit} look={hooks.look}
          pending={planEdits.find((e) => e.key === colour.key)?.grade}
          onLive={setLiveGrade} onApply={applyEdits} onClose={() => setColour(null)} />
      )}
      <EditTimeline
        view={shown}
        time={time}
        onSeek={(t) => slots.current.player.seek(t)}
        edits={planEdits}
        waves={clipWaves ? { ...waves, ...clipWaves } : waves}
        placeholders={[...sentHoles, ...(hole ? [hole] : [])]}
        selected={pin?.selected}
        marked={pin?.marked}
        pins={pin?.pins}
        onSelect={pin ? (item, editing, group) => {
          pin.onSelect(item ?? null, group, editing);
          if (item) slots.current.player.pause();
        } : undefined}
        onPin={pin?.onPin}
        range={pin?.range}
        onRange={pin?.onRange}
        onClearRange={pin?.onClearRange}
        {...(manage ? {
          onLive: setLive,
          onEdit: applyEdits,
          onPlaceholder: (p: Placeholder | null) => {
            setHole(p);
            slots.current.player.pause();
          },
          onReframe: edit && hooks.camera && w && h ? reframe : undefined,
          // a per-shot grade is not something the app's own AI Editor cuts in: not offered on its cuts
          onColor: own ? undefined : (item: TimelineItem) => {
            slots.current.player.pause();
            setCrop(null);
            const f = time * fps;
            if (f < item.rec || f >= item.rec + item.len) slots.current.player.seek((item.rec + Math.min(item.len - 1, Math.floor(item.len / 2))) / fps);
            setFace(null);
            setColour(item);
          },
          onFace: edit && hooks.face ? (item: TimelineItem) => openFace(item) : undefined,
          history: { back: hist.past.length, ahead: hist.future.length, undo, redo },
          rules: own ? OWN_RULES : undefined,
        } : {})}
      />
    </div>
  );
}

// The unsent edits with an open reframe box made in: the same as Send does with the box open (a window back at the AI's
// framing clears the reframe). Pure, so it is not rebuilt inside the effect's closure by hand.
function withCropOf(
  list: ItemEdit[],
  crop: { item: TimelineItem; box: CropBox } | null,
  view: TimelineView | null,
  sent: ItemEdit[],
): ItemEdit[] {
  if (!crop || !view) return list;
  const { item, box } = crop;
  const same = Math.abs(box.k - 1) < 0.005 && Math.abs(box.x) < 0.003 && Math.abs(box.y) < 0.003;
  return layOn(sent, list, item.key, item.label, same
    ? { zoom: undefined, pan: undefined, tilt: undefined }
    : cropToFraming(framingOf(item), box, view.width, view.height));
}
