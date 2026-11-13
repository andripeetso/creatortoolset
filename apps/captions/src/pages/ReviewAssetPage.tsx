import { confirmDialog } from "@/lib/dialogs";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import {
  ArrowLeft,
  Captions,
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  Columns2,
  Download,
  Layers,
  Loader2,
  Maximize,
  MessageSquare,
  MoreHorizontal,
  MoveHorizontal,
  Paperclip,
  Pause,
  PenLine,
  Play,
  RotateCcw,
  Ruler,
  Send,
  SkipBack,
  SkipForward,
  Trash2,
  TriangleAlert,
  Undo2,
  Volume2,
  VolumeX,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Picture } from "@/components/Picture";
import { PictureRulers, RULER, type Guide } from "@/components/PictureRulers";
import { HistoryArrows, HomeLink } from "@/components/HomeLink";
import { UserMenu } from "@/components/UserMenu";
import { ReviewShareButton } from "@/components/ReviewShareButton";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { timeAgo } from "@/lib/exports";
import {
  APPROVAL,
  deleteReviewAsset,
  frameAt,
  frameTime,
  markCaptioned,
  clearEarlierVersions,
  openInCaptionStudio,
  patchReviewAsset,
  reviewApi,
  reviewerName,
  setReviewerName,
  shareUrl,
  timecode,
  uploadReviewFile,
  type Approval,
  type ReviewAsset,
  attachTimeline,
  type ReviewAnchor,
  type ReviewComment,
  type ReviewRef,
  type ReviewView,
  type Stroke,
} from "@/lib/review";
import { undoable } from "@/lib/undo";
import { TIMELINE_ACCEPT } from "@contracts/timeline-import";
import { cn } from "@/lib/utils";
import { cornerTaken } from "@/lib/dock-place";
import { useCachedLoad } from "@/lib/local-cache";
import { fmtBytes } from "@/lib/exports";
import { ReviewCompare } from "./ReviewCompare";
import { VoiceMix } from "@/components/VoiceMix";
import { saveVoiceMix } from "@/lib/editor";
import { ScreenRecordingEditor } from "@/components/ScreenRecordingEditor";
import { reviewSource } from "@/lib/screen-source";
import { reviewSlotsFor, reviewTimelineOf, type ReviewActionEntry } from "@/lib/plugin";
import { ReviewActionButtons, ReviewPanelSlots, type ReviewBaseContext, type ReviewBind } from "@/components/ReviewSlots";
import ReviewEdits, { REVIEW_TIMELINE_ID } from "@/components/ReviewEdits";
import { ReviewSlotBridge } from "@/lib/review-slots";
import { mutedAt, usePlanFollow } from "@/lib/review-play";
import { resumeSound, useEditSound } from "@/lib/synced-sound";
import { OriginalsPicture } from "@/components/OriginalsPicture";
import { PlanOverlay } from "@/components/PlanOverlay";
import { payloadError } from "@contracts/review-payload";
import { useMe } from "@/lib/auth";
import { webPlugins } from "@/plugins.gen";

const COLORS = ["#ff3b30", "#ffcc00", "#34c759", "#0a84ff", "#ffffff"];
const AVATARS = ["bg-violet-600", "bg-sky-600", "bg-emerald-600", "bg-amber-600", "bg-rose-600", "bg-fuchsia-600", "bg-teal-600"];
const avatarColor = (name: string) =>
  AVATARS[[...name].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7) % AVATARS.length];
const SPEEDS = [0.5, 1, 1.5, 2];
// what plug-ins add to the timeline editor (clips in cards, the camera frame, full-quality colour)
const timelineHooks = reviewTimelineOf(webPlugins);

const typing = (e: KeyboardEvent) => {
  const el = e.target as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
};

/**
 * One video under review. Owners open /review/:assetId; reviewers open a
 * video's share link /r/:token or a project's /rp/:ptoken/:assetId. Same
 * screen, the server decides who may do what. ?v=<n>&c=<comment> (from a
 * notification) opens that version at that comment.
 */
export default function ReviewAssetPage() {
  const { assetId, token, ptoken } = useParams();
  const base = ptoken
    ? `/api/review/p/${ptoken}/a/${assetId}`
    : token
      ? `/api/review/s/${token}`
      : `/api/review/assets/${assetId}`;
  const api = useMemo(() => reviewApi(base), [base]);
  const [params] = useSearchParams();
  // the video's saved view shows at once; the fetch below refreshes it (signed in: kept on this device, lib/local-cache)
  const shown = useCachedLoad<ReviewView>(base, () => api.get());
  const view = shown.data;
  const setView = shown.set;
  const { refresh: refreshShown } = shown;
  const [loadError, setLoadError] = useState("");
  // a version picked here wins until the link itself changes
  const [picked, setPicked] = useState<{ n: number; search: string } | null>(null);
  const pickedN = picked?.search === params.toString() ? picked.n : Number(params.get("v")) || null;

  const load = useCallback(
    () =>
      refreshShown()
        .then(() => setLoadError(""))
        .catch((e: Error) => setLoadError(e.message)),
    [refreshShown],
  );
  useEffect(() => {
    // the first load is the hook's. Signed in, change notices keep it live (lib/local-cache); a link opened without
    // this server's stream (a share link's reviewer) asks again every 5 s while shown
    if (!token && !ptoken) return;
    const t = window.setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, 5000);
    return () => window.clearInterval(t);
  }, [load, token, ptoken]);

  if (!view) {
    return (
      <div className="flex h-dvh items-center justify-center bg-zinc-950 px-6 text-center text-sm text-zinc-400">
        {loadError ? (
          <p>
            {token || ptoken ? "This review link is off or doesn't exist." : loadError}
            <br />
            <Link to="/" className="mt-3 inline-block text-violet-400 hover:underline">
              Creator Toolset
            </Link>
          </p>
        ) : null}
      </div>
    );
  }

  const version = view.asset.versions.find((v) => v.n === pickedN) ?? view.asset.versions.at(-1);
  if (!version) return null;
  return (
    <Review
      key={`${version.n}:${params.get("c") ?? ""}`}
      view={view}
      setView={setView}
      api={api}
      n={version.n}
      focusId={params.get("c")}
      faceAt={params.get("face") === null ? null : Number(params.get("face"))}
      pickVersion={(n) => setPicked({ n, search: params.toString() })}
      reload={load}
    />
  );
}

type Api = ReturnType<typeof reviewApi>;

function Review({
  view,
  setView,
  api,
  n,
  focusId,
  faceAt,
  pickVersion,
  reload,
}: {
  view: ReviewView;
  setView: React.Dispatch<React.SetStateAction<ReviewView | null>>;
  api: Api;
  n: number;
  /** Comment to open on arrival. */
  focusId: string | null;
  /** ?face=<frame>: open the timeline's Face on that frame (the assistant's "refine my face") */
  faceAt?: number | null;
  pickVersion: (n: number) => void;
  reload: () => Promise<void>;
}) {
  const { asset, manage } = view;
  const [comparing, setComparing] = useState(false);
  // a screen recording from the Mac app: its Zoom & pointer editor (components/ScreenRecordingEditor.tsx)
  const [screenEditor, setScreenEditor] = useState(false);
  const version = asset.versions.find((v) => v.n === n)!;
  const fps = version.fps;
  const video = useRef<HTMLVideoElement>(null);
  const player = useRef<HTMLDivElement>(null);
  const composerBox = useRef<HTMLTextAreaElement>(null);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(version.duration);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  // the voice controls play the version's sound parts; the video is muted while they do
  const [voiceLive, setVoiceLive] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [natural, setNatural] = useState<number | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "open" | "done">("all");
  // a comment just sent: the list glides to it and it lights up
  const [flash, setFlash] = useState<string | null>(null);
  useEffect(() => {
    if (!flash) return;
    document.getElementById(`c-${flash}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    const t = window.setTimeout(() => setFlash(null), 1800);
    return () => clearTimeout(t);
  }, [flash]);
  const [name, setName] = useState(reviewerName);
  const guest = !view.user;
  const me = useMe();
  const slots = useMemo(() => reviewSlotsFor(me, webPlugins), [me]);
  // plug-in slots: their chips above the box, their data for the next comment, their ⌘Z (see lib/review-slots.ts)
  const [, setSlotTick] = useState(0);
  const bridge = useMemo(() => new ReviewSlotBridge(() => setSlotTick((t) => t + 1)), []);
  const slotCtx = { asset, version, manage, api, reload, player: { video: () => video.current, seek: (t: number) => seek(t), pause: () => pause() } };
  // each plug-in's slot functions, plus what its open comments on this version already sent (its panel shows them)
  const bindSlot = (pluginId: string) => ({
    ...bridge.bind(pluginId),
    sent: view.comments
      .filter((c) => c.version === version.n && !c.parentId && !c.resolved && c.plugins?.[pluginId] !== undefined)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((c) => ({ id: c.id, data: c.plugins![pluginId] })),
  });

  // ---- composer ----
  const [text, setText] = useState("");
  // a plug-in that writes a placeholder's words reads what is typed here
  useEffect(() => bridge.setComposerText(text), [bridge, text]);
  const plugged = bridge.payload() !== undefined;
  const [withTime, setWithTime] = useState(true);
  const [rangeIn, setRangeIn] = useState<number | null>(null);
  // a range's end: set (drawn on the timeline, or O), else wherever the playhead is when you post
  const [rangeOut, setRangeOut] = useState<number | null>(null);
  const clearRange = () => {
    setRangeIn(null);
    setRangeOut(null);
  };
  // the timeline clip the comment being written is about (anyone who can comment picks it on the timeline)
  const [anchors, setAnchors] = useState<ReviewAnchor[]>([]);
  const anchor = anchors[0] ?? null;
  const setAnchor = (a: ReviewAnchor | null) => setAnchors(a ? [a] : []);
  useEffect(() => setAnchors([]), [n]);
  // a range only runs forwards: while its
  // end follows the playhead, a playhead behind the start moves the start there
  if (rangeIn !== null && rangeOut === null && time < rangeIn) setRangeIn(time);
  const [drawMode, setDrawMode] = useState(false);
  const [color, setColor] = useState(COLORS[0]);
  const [draft, setDraft] = useState<Stroke[]>([]);
  const [posting, setPosting] = useState(false);
  const [postError, setPostError] = useState("");
  // references for the comment being written, uploaded as they're added (to this version)
  const [refs, setRefs] = useState<{ key: string; n: number; name: string; ref?: ReviewRef; error?: string }[]>([]);
  const attached = refs.filter((x) => x.n === n);
  const uploadingRefs = attached.some((x) => !x.ref && !x.error);
  const refIds = attached.flatMap((x) => (x.ref ? [x.ref.id] : []));
  const refFailed = attached.find((x) => x.error);
  const refInput = useRef<HTMLInputElement>(null);
  const [dropping, setDropping] = useState(false);
  const dropTimer = useRef(0);
  const attach = (files: File[]) => {
    for (const file of files) {
      const key = crypto.randomUUID();
      setRefs((l) => [...l, { key, n, name: file.name }]);
      api.uploadRef(n, file).then(
        (ref) => setRefs((l) => l.map((x) => (x.key === key ? { ...x, ref } : x))),
        (e: Error) => setRefs((l) => l.map((x) => (x.key === key ? { ...x, error: e.message } : x))),
      );
    }
  };
  useEffect(() => {
    setPic({ z: 1, x: 0, y: 0 }); // a new version starts unzoomed
  }, [n]);

  // ---- playback ----
  const pause = () => video.current?.pause();
  // a plug-in's preview (ReviewPlayPlan, lib/review-play.ts): the player skips, holds and follows it while it plays
  const plan = bridge.plan();
  const { holding, endHold } = usePlanFollow(video, plan, time, playing);
  // the timeline's edits with their sound from the originals (the plan's `sound`): the video plays muted under it
  const editSound = useEditSound(video, plan, holding);
  const pf = time * fps;
  const frameNow = plan?.frames.find((r) => pf >= r.from && pf < r.to);
  const lookNow = plan?.looks?.find((r) => pf >= r.from && pf < r.to);
  // J / K / L as in Resolve, and 1 / 2 / 3 the same ("JKL123"): L plays fast at once
  // (Space is the 1×; one press of J should already speed it up), again for 4×, 8×; J the same
  // backwards (the page steps the picture back: a video can't play in reverse); K stops
  const [shuttle, setShuttle] = useState(0);
  const shuttleTo = (n: number) => {
    endHold();
    const el = video.current;
    if (!el || version.status !== "ready") return;
    setShuttle(n);
    if (n > 0) {
      el.playbackRate = n;
      void el.play();
    } else {
      el.pause();
      el.playbackRate = speed;
    }
  };
  useEffect(() => {
    const el = video.current;
    if (shuttle >= 0 || !el) return;
    let last = performance.now();
    let at = el.currentTime;
    const id = window.setInterval(() => { // a frame's step 25 times a second
      const now = performance.now();
      at = Math.max(0, at - ((now - last) / 1000) * -shuttle);
      last = now;
      if (!el.seeking) el.currentTime = at; // the decoder shows the frames it keeps up with
      setTime(at);
      if (at <= 0) setShuttle(0);
    }, 40);
    return () => clearInterval(id);
  }, [shuttle]);
  const toggle = () => {
    endHold();
    resumeSound(); // sound made outside a click starts only after one
    const el = video.current;
    if (!el || version.status !== "ready") return;
    if (shuttle) {
      setShuttle(0);
      el.playbackRate = speed;
      if (shuttle < 0) return;
    }
    if (el.paused) {
      setDrawMode(false);
      setSelected(null);
      void el.play();
    } else el.pause();
  };
  const seek = useCallback(
    (t: number) => {
      endHold();
      const el = video.current;
      if (!el) return;
      const clamped = Math.max(0, Math.min(t, (duration || el.duration || 0) - 0.001));
      el.currentTime = clamped;
      setTime(clamped);
      setShuttle((sh) => (sh < 0 ? 0 : sh)); // a seek stops playing backwards
    },
    [duration],
  );
  const step = (frames: number) => {
    endHold();
    const el = video.current;
    if (!el) return;
    el.pause();
    seek(fps ? frameTime(frameAt(el.currentTime, fps) + frames, fps) : el.currentTime + frames / 30);
  };

  useEffect(() => {
    if (!playing) return;
    const el = video.current;
    // the time of the frame on screen, not the video's clock (which runs up to a frame ahead):
    // the timeline edits drawn over the picture change exactly on its frames
    if (el && "requestVideoFrameCallback" in el) {
      let id = 0;
      const onFrame = (_now: number, meta: VideoFrameCallbackMetadata) => {
        setTime(meta.mediaTime);
        id = el.requestVideoFrameCallback(onFrame);
      };
      id = el.requestVideoFrameCallback(onFrame);
      return () => el.cancelVideoFrameCallback(id);
    }
    let raf = 0;
    const tick = () => {
      setTime(video.current?.currentTime ?? 0);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  // a clicked button or slider never keeps the keys: after a press it lets go,
  // so Space, the arrows and Delete stay the player's and the timeline's. Text boxes keep theirs, and
  // menus and dialogs their own focus; Tab goes to the comment box, Shift+Tab still reaches everything.
  useEffect(() => {
    const up = () => setTimeout(() => { // after the press's own handlers
      const a = document.activeElement as HTMLElement | null;
      if (!a?.matches?.("button:not([aria-haspopup]), input[type=range], input[type=checkbox], [role=slider], [role=switch]")) return;
      if (a.closest("[role=menu], [role=dialog], [role=alertdialog], [role=listbox], [data-radix-popper-content-wrapper]")) return;
      a.blur();
    }, 0);
    window.addEventListener("pointerup", up, true);
    return () => window.removeEventListener("pointerup", up, true);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (comparing || screenEditor || typing(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "Escape" && rangeIn !== null) {
        clearRange();
        return;
      }
      const k = e.key.toLowerCase();
      if (k === " ") toggle();
      else if (k === "k" || k === "2") shuttleTo(0);
      else if (k === "l" || k === "3") shuttleTo(shuttle > 0 ? Math.min(shuttle * 2, 8) : 2);
      else if (k === "j" || k === "1") shuttleTo(shuttle < 0 ? Math.max(shuttle * 2, -8) : -2);
      else if (k === "arrowleft") step(e.shiftKey ? -Math.max(1, Math.round(fps || 30)) : -1);
      else if (k === "arrowright") step(e.shiftKey ? Math.max(1, Math.round(fps || 30)) : 1);
      else if (k === "m") setMuted((m) => !m);
      else if (k === "f") void fullscreen();
      else if (k === "c" || k === "enter") composerBox.current?.focus();
      // Tab = straight into the comment box; Shift+Tab, menus and dialogs keep Tab's own job
      else if (k === "tab" && !e.shiftKey && composerBox.current
        && !(e.target as HTMLElement | null)?.closest?.("[role=menu], [role=dialog], [role=alertdialog], [role=listbox]")) {
        composerBox.current.focus();
      }
      else if (k === "i" || k === "o") { // in and out points: the comment's range (Resolve, Premiere)
        const now = video.current?.currentTime ?? time;
        setWithTime(true);
        if (k === "i") {
          setRangeIn(now);
          if (rangeOut !== null && rangeOut <= now) setRangeOut(null);
        } else if (rangeIn === null || rangeIn >= now) { // no start before here: the range starts here
          setRangeIn(now);
          setRangeOut(null);
        } else {
          setRangeOut(now);
        }
      }
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // ⌘Z / ⇧⌘Z: a plug-in's own edits (its undo history registers on the bridge)
  useEffect(() => {
    const onUndo = (e: KeyboardEvent) => {
      const z = e.key.toLowerCase();
      if (comparing || screenEditor || typing(e) || !(e.metaKey || e.ctrlKey) || e.altKey || (z !== "z" && z !== "y")) return;
      if (bridge.history(z === "y" || e.shiftKey)) e.preventDefault();
    };
    window.addEventListener("keydown", onUndo);
    return () => window.removeEventListener("keydown", onUndo);
  }, [bridge, comparing, screenEditor]);

  // a sent comment clears the plug-ins' chips and data
  const fullscreen = async () => {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await player.current?.requestFullscreen().catch(() => {});
  };

  // ---- comments ----
  const all = view.comments.filter((c) => c.version === n);
  const threads = all
    .filter((c) => !c.parentId)
    .sort((a, b) => (a.t ?? Infinity) - (b.t ?? Infinity) || a.createdAt - b.createdAt);
  const shown = threads.filter((c) => (filter === "all" ? true : filter === "done" ? c.resolved : !c.resolved));
  const replies = (id: string) => all.filter((c) => c.parentId === id).sort((a, b) => a.createdAt - b.createdAt);
  const sel = threads.find((c) => c.id === selected);
  const frameTol = fps ? 1 / fps : 0.05;
  const overlay: Stroke[] =
    drawMode || draft.length
      ? draft
      : sel?.drawing && !playing && sel.t !== undefined && Math.abs(time - sel.t) < frameTol
        ? sel.drawing
        : [];

  // how many comments sit on each timeline clip, and a click on a clip's count goes through them, newest first
  const pinKey = (a: ReviewAnchor) => `${a.track}:${a.rec}`;
  const clipsOf = (c: ReviewComment) => (c.anchors ?? (c.anchor ? [c.anchor] : []));
  const pins = threads.reduce<Record<string, number>>((acc, c) => {
    for (const k of new Set(clipsOf(c).map(pinKey))) acc[k] = (acc[k] ?? 0) + 1;
    return acc;
  }, {});
  type Clip = { track: string; rec: number; len: number; label: string };
  const clipOf = (i: Clip): ReviewAnchor => ({ track: i.track, rec: i.rec, len: i.len, label: i.label });
  const shownClips = anchors.length ? anchors : sel ? clipsOf(sel) : [];
  const timelinePin = {
    selected: shownClips[0] ? pinKey(shownClips[0]) : null,
    marked: shownClips.slice(1).map(pinKey),
    pins,
    onSelect: (item: Clip | null, group?: Clip[]) => {
      setAnchors(!item ? [] : group && group.length > 1 ? group.map(clipOf) : [clipOf(item)]);
      if (item) composerBox.current?.focus();
    },
    onPin: (key: string) => {
      const on = threads.filter((c) => clipsOf(c).some((a) => pinKey(a) === key)).sort((a, b) => b.createdAt - a.createdAt);
      if (!on.length) return;
      const c = on[(on.findIndex((x) => x.id === selected) + 1) % on.length]!;
      setFilter((f) => (f === "done" && !c.resolved ? "all" : f === "open" && c.resolved ? "all" : f));
      focusComment(c);
      setFlash(c.id);
    },
    // the comment being written's range, else the picked comment's; a drag across the lanes sets it
    range: rangeIn !== null ? [rangeIn, rangeOut ?? time] as [number, number]
      : sel?.t !== undefined && sel.tEnd !== undefined ? [sel.t, sel.tEnd] as [number, number] : null,
    onRange: (from: number, to: number) => {
      pause();
      setWithTime(true);
      setRangeIn(from);
      setRangeOut(to);
      seek(to);
      composerBox.current?.focus();
    },
    onClearRange: clearRange,
  };

  const focusComment = (c: ReviewComment) => {
    setSelected(c.id);
    if (c.t !== undefined) {
      pause();
      seek(c.t);
    }
    document.getElementById(`c-${c.id}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  };

  const arrived = useRef(false);
  useEffect(() => {
    if (arrived.current) return;
    arrived.current = true;
    const c = threads.find((x) => x.id === focusId);
    if (c) focusComment(c);
  });

  const patchComments = (fn: (list: ReviewComment[]) => ReviewComment[]) =>
    setView((v) => (v ? { ...v, comments: fn(v.comments) } : v));

  const needName = () => {
    if (!guest || name.trim()) return false;
    setPostError("Add your name first");
    document.getElementById("review-name")?.focus();
    return true;
  };

  const post = async () => {
    if (posting || uploadingRefs || (!text.trim() && !draft.length && !refIds.length && !plugged) || needName()) return;
    const plugins = bridge.payload();
    const pluginsWhy = payloadError(plugins);
    if (pluginsWhy) {
      setPostError(pluginsWhy);
      return;
    }
    const need = bridge.textNeeded();
    if (need && !text.trim()) {
      setPostError(need);
      return;
    }
    const at = video.current?.currentTime ?? time;
    const timed = withTime || draft.length > 0;
    const [a, b] = rangeIn === null ? [at, undefined] : [Math.min(rangeIn, rangeOut ?? at), Math.max(rangeIn, rangeOut ?? at)];
    setPosting(true);
    setPostError("");
    try {
      if (guest) setReviewerName(name.trim());
      const c = await api.comment({
        version: n,
        text: text.trim(),
        ...(timed ? { t: a, ...(b !== undefined && b > a ? { tEnd: b } : {}) } : {}),
        ...(draft.length ? { drawing: draft } : {}),
        ...(guest ? { author: name.trim() } : {}),
        ...(refIds.length ? { refs: refIds } : {}),
        ...(plugins ? { plugins } : {}),
        ...(anchor ? { anchor, ...(anchors.length > 1 ? { anchors } : {}) } : {}),
      });
      patchComments((l) => [...l, c]);
      setAnchor(null);
      setText("");
      setRefs([]);
      setDraft([]);
      setDrawMode(false);
      clearRange();
      bridge.sent();
      setSelected(c.id);
      setFilter((f) => (f === "done" ? "all" : f));
      setFlash(c.id);
      // the keys go back to the player: Space plays, not a space in the next comment
      (document.activeElement as HTMLElement | null)?.blur();
    } catch (e) {
      setPostError((e as Error).message);
    } finally {
      setPosting(false);
    }
  };

  const reply = async (parentId: string, body: string) => {
    if (needName()) return false;
    if (guest) setReviewerName(name.trim());
    const c = await api.comment({ version: n, text: body, parentId, ...(guest ? { author: name.trim() } : {}) });
    patchComments((l) => [...l, c]);
    return true;
  };
  const edit = async (id: string, patch: { text?: string; resolved?: boolean }) => {
    const c = await api.editComment(id, patch);
    patchComments((l) => l.map((x) => (x.id === id ? c : x)));
  };
  const remove = async (id: string) => {
    if (!(await confirmDialog({ title: "Delete this comment?", body: "Its replies go with it.", ok: "Delete", danger: true, deleting: true }))) return;
    await api.deleteComment(id);
    patchComments((l) => l.filter((x) => x.id !== id && x.parentId !== id));
  };
  const approve = async (status: Approval) => {
    if (needName()) return;
    if (guest) setReviewerName(name.trim());
    const was = asset.approval.status;
    const put = async (to: Approval) => {
      const a = await api.approve(to, guest ? name.trim() : undefined);
      setView((v) => (v ? { ...v, asset: { ...v.asset, approval: a.approval } } : v));
    };
    await put(status);
    // a reviewer on a share link may only approve or ask for changes, so there is no way back for them to take
    if (manage && was !== status) undoable(`set to ${APPROVAL[status].label}`, () => put(was));
  };

  // ---- fit the video box to the stage so drawings line up with the picture ----
  const stage = useRef<HTMLDivElement>(null);
  // the picture's size and top-left in the stage, and the stage's size
  const [fit, setFit] = useState({ w: 0, h: 0, ox: 0, oy: 0, sw: 0, sh: 0 });
  const aspect = natural ?? (version.width && version.height ? version.width / version.height : 16 / 9);
  // rulers and guides, this viewer's own
  const [rulers, setRulers] = useState(() => PictureRulers.load().on);
  const [guides, setGuides] = useState<Guide[]>(() => PictureRulers.load().guides);
  useEffect(() => PictureRulers.save({ on: rulers, guides }), [rulers, guides]);
  useLayoutEffect(() => {
    const el = stage.current;
    if (!el) return;
    const measure = () => {
      const pad = rulers ? RULER : 0; // the picture sits clear of the rulers
      const [cw, ch] = [el.clientWidth - pad, el.clientHeight - pad];
      const w = Math.max(0, Math.min(cw, ch * aspect));
      setFit({ w, h: w / aspect, ox: pad + (cw - w) / 2, oy: pad + (ch - w / aspect) / 2, sw: el.clientWidth, sh: el.clientHeight });
    };
    measure(); // now, not only when a resize is reported
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [aspect, rulers]);

  // ---- zoom into the picture: ⌥ + scroll or a pinch over it, drag (or middle-drag) to move it, the % button fits;
  // the picture always covers its own frame ----
  const wrap = useRef<HTMLDivElement>(null);
  const [pic, setPic] = useState({ z: 1, x: 0, y: 0 });
  const picNow = useRef({ pic, fit });
  useLayoutEffect(() => {
    picNow.current = { pic, fit };
  });
  const picAt = (z: number, x: number, y: number, f = fit) => ({
    z, x: Math.min(0, Math.max(-(z - 1) * f.w, x)), y: Math.min(0, Math.max(-(z - 1) * f.h, y)),
  });
  /** by `factor` about a point on screen (the middle of the picture without one) */
  const zoomPic = (factor: number, cx?: number, cy?: number) => {
    const w = wrap.current;
    if (!w) return;
    const { pic: p, fit: f } = picNow.current;
    const st = (w.offsetParent as HTMLElement | null)?.getBoundingClientRect();
    const [ox, oy] = [(st?.left ?? 0) + w.offsetLeft, (st?.top ?? 0) + w.offsetTop]; // where the unzoomed picture sits (layout, not the transform)
    const [sx, sy] = [cx ?? ox + f.w / 2, cy ?? oy + f.h / 2];
    const [px, py] = [(sx - ox - p.x) / p.z, (sy - oy - p.y) / p.z];
    const z = Math.min(8, Math.max(1, p.z * factor));
    const next = picAt(z, sx - ox - z * px, sy - oy - z * py, f);
    picNow.current = { pic: next, fit: f }; // wheel events come faster than renders: the next one builds on this
    setPic(next);
  };
  const zoomPicRef = useRef(zoomPic);
  useLayoutEffect(() => {
    zoomPicRef.current = zoomPic;
  });
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      if (!(e.altKey || (e.ctrlKey && !e.metaKey))) return; // ⌥ + scroll, or a pinch (sent as Ctrl)
      e.preventDefault();
      zoomPicRef.current(Math.exp(-Math.max(-60, Math.min(60, e.deltaY)) * 0.006), e.clientX, e.clientY);
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, []);
  const panFrom = useRef<{ x0: number; y0: number; x: number; y: number } | null>(null);
  const panned = useRef(false); // a drag that moved the picture isn't a click on it (play / pause)

  const stroke = useRef<Stroke | null>(null);
  const point = (e: ReactPointerEvent<SVGSVGElement>): [number, number] => {
    const r = e.currentTarget.getBoundingClientRect();
    return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height];
  };

  return (
    <div
      data-fills-window
      className="flex h-dvh flex-col bg-zinc-950 text-zinc-200"
      // a file dropped anywhere on the page (textbox included) attaches to the comment
      // being written; a near miss used to open the image in the tab instead
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        setDropping(true);
        clearTimeout(dropTimer.current);
        // dragover repeats while a drag is over the page (≤ 550 ms apart); silence = it left
        dropTimer.current = window.setTimeout(() => setDropping(false), 600);
      }}
      onDrop={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        setDropping(false);
        attach([...e.dataTransfer.files]);
      }}
    >
      <Header
        view={view}
        setView={setView}
        n={n}
        pickVersion={pickVersion}
        reload={reload}
        api={api}
        approve={approve}
        comments={view.comments}
        onCompare={() => {
          pause();
          setComparing(true);
        }}
        onZoom={() => {
          pause();
          setScreenEditor(true);
        }}
        actions={slots.actions}
        slotCtx={slotCtx}
        bind={bindSlot}
      />
      {/* the plug-ins' panels */}
      <ReviewPanelSlots slots={slots.panels} ctx={slotCtx} bind={bindSlot} />
      {comparing && (
        <ReviewCompare
          versions={asset.versions.filter((v) => v.status === "ready" && !v.removed)}
          media={(x) => api.media(asset.versions.find((v) => v.n === x)!, "play")}
          n={n}
          start={video.current?.currentTime ?? time}
          onClose={() => setComparing(false)}
        />
      )}
      {screenEditor && (
        <ScreenRecordingEditor
          key={`${asset.id}:${version.n}`}
          source={reviewSource(asset.id, version)}
          meta={{ name: version.name, duration: version.duration, width: version.width, height: version.height }}
          onClose={() => setScreenEditor(false)}
          actions={[
            {
              label: "Make video",
              primary: true,
              title: "Renders it on this computer and adds it to this video as the next version",
              run: async ({ blob, name }, progress) => {
                const made = await uploadReviewFile(new File([blob], `${name}.mp4`, { type: "video/mp4" }), (pct) => progress("Uploading", pct), { assetId: asset.id });
                setScreenEditor(false);
                const top = made.versions.at(-1);
                void reload().then(() => top && pickVersion(top.n));
              },
            },
          ]}
        />
      )}

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        {/* ---------- player ---------- */}
        <div ref={player} className="flex min-h-0 min-w-0 flex-col bg-zinc-900 dark:bg-black lg:flex-1">
          <div ref={stage} style={rulers ? { paddingLeft: RULER, paddingTop: RULER } : undefined}
            className="relative flex h-[40dvh] items-center justify-center overflow-hidden lg:h-auto lg:min-h-0 lg:flex-1">
            {version.status === "ready" && !version.removed && (
              // the viewer's tools, top left
              <div className="absolute z-30 hidden items-center gap-1 text-xs text-zinc-300 sm:flex"
                style={{ left: (rulers ? RULER : 0) + 8, top: (rulers ? RULER : 0) + 8 }}>
                <div className="flex items-center rounded-md bg-zinc-950/80 shadow" title="Zoom into the picture: ⌥ + scroll or pinch over it, drag to move it">
                  <button aria-label="Zoom the picture out" title="Zoom out" onClick={() => zoomPic(1 / 1.5)} disabled={pic.z <= 1}
                    className="rounded-l-md px-2 py-1 hover:bg-zinc-800 disabled:opacity-30">−</button>
                  <button onClick={() => setPic({ z: 1, x: 0, y: 0 })} title="Fit the picture"
                    className="w-12 py-1 text-center tabular-nums hover:bg-zinc-800">{Math.round(pic.z * 100)}%</button>
                  <button aria-label="Zoom the picture in" title="Zoom in" onClick={() => zoomPic(1.5)} disabled={pic.z >= 8}
                    className="px-2 py-1 hover:bg-zinc-800 disabled:opacity-30">+</button>
                  <button aria-label="Reset the view" title="Reset the view: fit the picture" onClick={() => setPic({ z: 1, x: 0, y: 0 })}
                    disabled={pic.z === 1} className="rounded-r-md px-2 py-1.5 hover:bg-zinc-800 disabled:opacity-30">
                    <RotateCcw className="h-3 w-3" />
                  </button>
                </div>
                <button aria-pressed={rulers} onClick={() => setRulers((r) => !r)}
                  title={rulers ? "Hide the rulers and guides" : "Rulers: drag out of one for a guide (kept for you)"}
                  className={cn("rounded-md px-2 py-1.5 shadow", rulers ? "bg-violet-600 text-white" : "bg-zinc-950/80 hover:bg-zinc-800")}>
                  <Ruler className="h-3 w-3" />
                </button>
                {rulers && guides.length > 0 && (
                  <button onClick={() => setGuides([])} title="Take every guide away"
                    className="rounded-md bg-zinc-950/80 px-2 py-1 shadow hover:bg-zinc-800">Clear guides</button>
                )}
              </div>
            )}
            {rulers && version.status === "ready" && !version.removed && (
              <PictureRulers fit={fit} pic={pic} guides={guides} setGuides={setGuides}
                px={{ w: version.width || 1080, h: version.height || 1920 }} />
            )}
            {version.removed ? (
              <div className="flex flex-col items-center gap-3 px-6 text-center text-sm text-zinc-400">
                <span className="block h-[30dvh] overflow-hidden rounded bg-zinc-900 opacity-40" style={{ aspectRatio: `${version.width || 9} / ${version.height || 16}` }}>
                  <Picture src={api.media(version, "thumb")} alt="" className="h-full w-full object-contain" />
                </span>
                V{version.n}'s video was deleted to save space. Its comments are still here.
              </div>
            ) : version.status === "ready" ? (
              <div ref={wrap} className={cn("relative", "overflow-hidden", pic.z > 1 && !drawMode && "cursor-grab active:cursor-grabbing")}
                style={{ width: fit.w, height: fit.h, ...(pic.z > 1 ? { transform: `translate(${pic.x}px, ${pic.y}px) scale(${pic.z})`, transformOrigin: "0 0" } : {}) }}
                onPointerDown={(e) => {
                  panned.current = false;
                  if (drawMode || (e.target as HTMLElement).closest("button")) return;
                  if (e.button === 1 || (e.button === 0 && pic.z > 1)) {
                    if (e.button === 1) e.preventDefault();
                    e.currentTarget.setPointerCapture(e.pointerId);
                    panFrom.current = { x0: e.clientX, y0: e.clientY, x: pic.x, y: pic.y };
                  }
                }}
                onPointerMove={(e) => {
                  const p = panFrom.current;
                  if (!p) return;
                  const [dx, dy] = [e.clientX - p.x0, e.clientY - p.y0];
                  if (!panned.current && Math.hypot(dx, dy) < 4) return;
                  panned.current = true;
                  setPic(picAt(pic.z, p.x + dx, p.y + dy));
                }}
                onPointerUp={() => (panFrom.current = null)}
                onPointerCancel={() => (panFrom.current = null)}>
                <video
                  ref={video}
                  src={api.media(version, "play")}
                  className="h-full w-full"
                  playsInline
                  preload="auto"
                  muted={muted || voiceLive || editSound.live || mutedAt(plan, time)}
                  style={frameNow || lookNow ? {
                    ...(frameNow && {
                      transform: `scale(${1 / frameNow.box.k}) translate(${-frameNow.box.x * 100}%, ${-frameNow.box.y * 100}%)`,
                      transformOrigin: "0 0",
                    }),
                    ...(lookNow && { filter: lookNow.filter }),
                  } : undefined}
                  onClick={() => (panned.current ? (panned.current = false) : toggle())}
                  onLoadedMetadata={(e) => {
                    const el = e.currentTarget;
                    if (el.videoWidth && el.videoHeight) setNatural(el.videoWidth / el.videoHeight);
                    if (Number.isFinite(el.duration)) setDuration(el.duration);
                    el.playbackRate = speed;
                  }}
                  onTimeUpdate={(e) => !playing && setTime(e.currentTarget.currentTime)}
                  onSeeked={(e) => setTime(e.currentTarget.currentTime)}
                  onPlay={() => setPlaying(true)}
                  onPause={() => setPlaying(false)}
                  onEnded={() => setPlaying(false)}
                />
                {/* an edit's talent shots from their camera originals, when it plays from them */}
                <OriginalsPicture video={video} plan={plan} holding={holding} filter={lookNow?.filter} />
                {plan && <PlanOverlay cards={plan.cards} fps={fps} time={time} holding={holding} playing={playing} rate={speed} />}
                <svg
                  viewBox="0 0 1 1"
                  preserveAspectRatio="none"
                  className={cn("absolute inset-0 h-full w-full", drawMode ? "cursor-crosshair touch-none" : "pointer-events-none")}
                  onPointerDown={(e) => {
                    if (!drawMode) return;
                    e.currentTarget.setPointerCapture(e.pointerId);
                    stroke.current = { color, points: [point(e)] };
                    setDraft((d) => [...d, stroke.current!]);
                  }}
                  onPointerMove={(e) => {
                    const s = stroke.current;
                    if (!s) return;
                    const next = { ...s, points: [...s.points, point(e)] };
                    stroke.current = next;
                    setDraft((d) => [...d.slice(0, -1), next]);
                  }}
                  onPointerUp={() => (stroke.current = null)}
                >
                  {overlay.map((s, i) => (
                    <polyline
                      key={i}
                      points={s.points.map(([x, y]) => `${x},${y}`).join(" ")}
                      fill="none"
                      stroke={s.color}
                      strokeWidth={4}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      vectorEffect="non-scaling-stroke"
                    />
                  ))}
                </svg>
              </div>
            ) : version.status === "processing" ? (
              // keyed: the video that replaces it is a new box, not this one growing
              <div key="processing" className="flex flex-col items-center gap-3 text-sm text-zinc-400">
                <span className="h-1 w-48 overflow-hidden rounded-full bg-zinc-800">
                  <span className="block h-full bg-violet-500 transition-[width] duration-500" style={{ width: `${Math.round(version.progress * 100)}%` }} />
                </span>
                Preparing video for review · {Math.round(version.progress * 100)}%
              </div>
            ) : (
              <p className="flex max-w-md items-center gap-2 px-6 text-sm text-red-400">
                <TriangleAlert className="h-4 w-4 shrink-0" /> {version.error || "This version failed to process"}
              </p>
            )}
          </div>

          <Timeline
            duration={duration}
            time={time}
            threads={threads}
            selected={selected}
            rangeIn={rangeIn}
            rangeOut={rangeOut}
            onSeek={(t) => {
              setSelected(null);
              seek(t);
            }}
            onPick={focusComment}
          />

          {/* the timeline on a version with a timeline, between the scrub bar and play/pause, as it always was (everyone; its edit tools are the managers') */}
          {version.status === "ready" && !version.removed && (
            <ReviewEdits {...slotCtx} {...bindSlot(REVIEW_TIMELINE_ID)} hooks={timelineHooks} pin={timelinePin} faceAt={faceAt} />
          )}

          <div className="flex items-center gap-1 px-3 pb-2 text-zinc-300">
            <IconBtn label={playing ? "Pause (space)" : "Play (space)"} onClick={toggle}>
              {playing ? <Pause className="h-5 w-5" /> : <Play className="h-5 w-5" />}
            </IconBtn>
            <IconBtn label="Previous frame (←)" onClick={() => step(-1)}>
              <SkipBack className="h-4 w-4" />
            </IconBtn>
            <IconBtn label="Next frame (→)" onClick={() => step(1)}>
              <SkipForward className="h-4 w-4" />
            </IconBtn>
            <span className="ml-1 whitespace-nowrap font-mono text-sm tabular-nums">
              {timecode(time, fps)}
              <span className="hidden text-zinc-600 sm:inline"> / {timecode(duration, fps)}</span>
            </span>
            {fps > 0 && <span className="ml-2 hidden text-xs text-zinc-600 sm:inline">{fps} fps</span>}
            {shuttle !== 0 && (
              <span className="ml-2 rounded bg-violet-600/30 px-1.5 text-xs tabular-nums text-violet-200">
                {shuttle < 0 ? "◀◀" : "▶▶"} {Math.abs(shuttle)}×
              </span>
            )}
            <div className="ml-auto flex items-center gap-1">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button className="rounded px-2 py-1 text-xs tabular-nums hover:bg-zinc-800">{speed}×</button>
                </DropdownMenuTrigger>
                <DropdownMenuContent>
                  {SPEEDS.map((s) => (
                    <DropdownMenuItem
                      key={s}
                      onClick={() => {
                        setSpeed(s);
                        if (video.current) video.current.playbackRate = s;
                      }}
                    >
                      {s}×
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
              <IconBtn label="Mute (m)" onClick={() => setMuted((m) => !m)}>
                {muted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
              </IconBtn>
              <IconBtn label="Fullscreen (f)" onClick={() => void fullscreen()}>
                <Maximize className="h-4 w-4" />
              </IconBtn>
            </div>
          </div>

          {version.stems && version.status === "ready" && !version.removed && (
            <VoiceMix
              key={`${version.n}-${version.createdAt}`}
              video={video}
              stems={version.stems}
              url={(f) => api.stem(version, f)}
              muted={muted || editSound.live}
              onLive={setVoiceLive}
              save={version.edit ? (mix, voice) => saveVoiceMix(version.edit!.project, version.edit!.draft, mix, voice).then(
                () => "Kept for this edit: the AI Editor cuts it again with this voice, back here as the next version.") : undefined}
            />
          )}

        </div>

        {/* ---------- comments ---------- */}
        <aside className="flex min-h-0 flex-1 flex-col border-zinc-900 lg:w-[380px] lg:flex-none lg:border-l">
          <div className={cn("flex items-center gap-1 border-b border-zinc-900 px-3 py-2 text-xs")}>
            {(["all", "open", "done"] as const).map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={cn("rounded-md px-2.5 py-1 capitalize", filter === f ? "bg-zinc-800 text-zinc-100" : "text-zinc-500 hover:text-zinc-300")}
              >
                {f}
                <span className="ml-1 text-zinc-600">
                  {f === "all" ? threads.length : threads.filter((c) => (f === "done" ? c.resolved : !c.resolved)).length}
                </span>
              </button>
            ))}
          </div>

          <div className="clears-bubble min-h-0 flex-1 overflow-y-scroll px-3 py-2">
            {shown.length === 0 ? (
              <p className="px-2 py-10 text-center text-sm text-zinc-600">
                {threads.length ? "Nothing here." : "No comments yet. Pause on a frame and write one below."}
              </p>
            ) : (
              shown.map((c) => (
                <Thread
                  key={c.id}
                  c={c}
                  replies={replies(c.id)}
                  fps={fps}
                  active={c.id === selected}
                  flash={c.id === flash}
                  manage={manage}
                  refUrl={api.refUrl}
                  onPick={() => focusComment(c)}
                  onReply={(body) => reply(c.id, body)}
                  onEdit={edit}
                  onDelete={remove}
                />
              ))
            )}
          </div>

          {/* composer: drop (anywhere on the page) or paste images and videos in as references */}
          {/* in the window's bottom right corner: the assistant's bubble sits above this box, not over Send (dock-place.ts) */}
          <div ref={cornerTaken} className={cn("border-t border-zinc-900 p-3", dropping && "bg-violet-950/40 ring-2 ring-inset ring-violet-500")}>
            {guest && (
              <input
                id="review-name"
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  setPostError("");
                }}
                placeholder="Your name"
                maxLength={60}
                className="mb-2 w-full rounded-md border border-zinc-800 bg-zinc-950 px-3 py-1.5 text-sm outline-none focus:border-violet-500"
              />
            )}
            {attached.length > 0 && (
              <div className="mb-2 flex flex-wrap gap-1.5">
                {attached.map((x) => (
                  <div
                    key={x.key}
                    title={x.error ?? x.name}
                    className={cn(
                      "relative flex h-12 w-12 items-center justify-center overflow-hidden rounded-md border bg-zinc-900",
                      x.error ? "border-red-500" : "border-zinc-800",
                    )}
                  >
                    {x.ref ? (
                      <Picture src={api.refUrl(n, x.ref.id, "look")} alt={x.name} className="h-full w-full object-cover" />
                    ) : x.error ? (
                      <TriangleAlert className="h-5 w-5 text-red-400" />
                    ) : (
                      <span className="h-full w-full animate-pulse bg-zinc-800" />
                    )}
                    <button
                      aria-label={`Remove ${x.name}`}
                      onClick={() => setRefs((l) => l.filter((y) => y.key !== x.key))}
                      className="absolute right-0 top-0 rounded-bl bg-zinc-950/80 px-1 text-xs leading-4 text-zinc-300 hover:text-zinc-50"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}
            {refFailed && <p className="mb-2 text-xs text-red-400">{refFailed.name}: {refFailed.error}</p>}
            {anchor && (
              <div className="mb-2 flex items-center gap-2 rounded-md border border-violet-700/60 bg-violet-950/30 px-2 py-1 text-xs text-violet-200">
                <span className="min-w-0 flex-1 truncate">
                  {anchors.length > 1 ? `About ${anchors.length} clips: ${anchors.map((a) => a.label).join(", ")}` : `About ${anchor.label} (${anchor.track})`}
                </span>
                <button aria-label={anchors.length > 1 ? "Not about these clips" : "Not about this clip"} onClick={() => setAnchor(null)} className="rounded px-1 text-violet-300 hover:text-zinc-50">×</button>
              </div>
            )}
            <textarea
              ref={composerBox}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onPaste={(e) => {
                if (!e.clipboardData.files.length) return;
                e.preventDefault();
                attach([...e.clipboardData.files]);
              }}
              onFocus={pause}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void post();
                } else if (e.key === "Escape") { // the range and the picked item go too
                  clearRange();
                  e.currentTarget.blur();
                }
              }}
              rows={3}
              placeholder={dropping ? "Drop to attach it to this comment" : drawMode ? "Draw on the frame, then say what to change" : "Leave a comment…"}
              className="[field-sizing:content] min-h-20 max-h-[50vh] w-full resize-none rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm outline-none focus:border-violet-500"
            />
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <Chip on={withTime || draft.length > 0} onClick={() => setWithTime((w) => !w)} title="Attach to this timecode">
                <Clock className="h-3.5 w-3.5" />
                {withTime || draft.length ? (
                  <span className="font-mono tabular-nums">
                    {rangeIn !== null && `${timecode(rangeIn, fps)} → `}
                    {timecode(rangeIn !== null && rangeOut !== null ? rangeOut : time, fps)}
                  </span>
                ) : (
                  "No timecode"
                )}
              </Chip>
              <Chip
                on={rangeIn !== null}
                onClick={() => {
                  setWithTime(true);
                  setRangeOut(null);
                  setRangeIn((r) => (r === null ? (video.current?.currentTime ?? time) : null));
                }}
                title="Range: starts here, ends where the playhead is when you post"
              >
                <MoveHorizontal className="h-3.5 w-3.5" /> Range
              </Chip>
              <Chip
                on={drawMode}
                onClick={() => {
                  pause();
                  setDrawMode((d) => !d);
                }}
                title="Draw on the frame"
              >
                <PenLine className="h-3.5 w-3.5" />
              </Chip>
              <Chip on={false} onClick={() => refInput.current?.click()}
                title="Attach an image or video to show what you mean (or paste or drop one); the AI reads it too">
                <Paperclip className="h-3.5 w-3.5" />
              </Chip>
              <input
                ref={refInput}
                type="file"
                accept="image/*,video/*"
                multiple
                hidden
                onChange={(e) => {
                  attach([...(e.target.files ?? [])]);
                  e.target.value = "";
                }}
              />
              {(drawMode || draft.length > 0) && (
                <>
                  {COLORS.map((c) => (
                    <button
                      key={c}
                      aria-label={`Color ${c}`}
                      onClick={() => setColor(c)}
                      className={cn("h-5 w-5 rounded-full border-2", color === c ? "border-white" : "border-transparent")}
                      style={{ background: c }}
                    />
                  ))}
                  <IconBtn label="Undo stroke" onClick={() => setDraft((d) => d.slice(0, -1))}>
                    <Undo2 className="h-3.5 w-3.5" />
                  </IconBtn>
                </>
              )}
              <Button
                size="sm"
                className="ml-auto h-8 rounded-md px-3 text-sm font-medium bg-violet-600 text-white hover:bg-violet-500"
                disabled={posting || uploadingRefs || (!text.trim() && !draft.length && !refIds.length && !plugged)}
                onClick={() => void post()}
              >
                {posting ? <Loader2 className="animate-spin" /> : <Send />} Send
              </Button>
            </div>
            {bridge.pendingLabels().length > 0 && (
              <ul className="mt-1.5 flex flex-wrap gap-1 text-[11px] text-violet-300">
                {bridge.pendingLabels().map((l, i) => (
                  <li key={i} className="rounded bg-violet-950/60 px-1.5 py-0.5">{l}</li>
                ))}
              </ul>
            )}
            {postError && <p className="mt-1.5 text-xs text-red-400">{postError}</p>}
            <p className="mt-1.5 hidden text-[11px] text-zinc-600 lg:block">
              Space play · J/K/L or 1/2/3 shuttle · ←/→ frame · Shift ←/→ second · C comment
            </p>
          </div>
        </aside>
      </div>
    </div>
  );
}

// ---------- header: title, versions, approval, share ----------

function Header({
  view,
  setView,
  n,
  pickVersion,
  reload,
  api,
  approve,
  comments,
  onCompare,
  onZoom,
  actions,
  slotCtx,
  bind,
}: {
  view: ReviewView;
  setView: React.Dispatch<React.SetStateAction<ReviewView | null>>;
  n: number;
  pickVersion: (n: number) => void;
  reload: () => Promise<void>;
  api: Api;
  approve: (s: Approval) => Promise<void>;
  comments: ReviewComment[];
  onCompare: () => void;
  /** A screen recording: open Zoom & pointer. */
  onZoom: () => void;
  /** Toolbar buttons plug-ins add (shown to managers on a ready version). */
  actions: ReviewActionEntry[];
  slotCtx: ReviewBaseContext;
  bind: ReviewBind;
}) {
  const [error, setError] = useState("");
  const { asset, manage } = view;
  const { ptoken } = useParams();
  const navigate = useNavigate();
  const [renaming, setRenaming] = useState(false);
  const [uploadPct, setUploadPct] = useState<number | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  // the editing app's timeline file for this version (owners): added or replaced, then reloaded
  const timelineInput = useRef<HTMLInputElement>(null);
  const [timelineError, setTimelineError] = useState("");
  const addTimeline = (file: File) => {
    setTimelineError("");
    attachTimeline(asset.id, n, file).then(reload, (e: Error) => setTimelineError(e.message));
  };
  const version = asset.versions.find((v) => v.n === n)!;
  const setAsset = (a: ReviewAsset) => setView((v) => (v ? { ...v, asset: { ...v.asset, ...a } } : v));
  const libraryPath = asset.projectId ? `/review?p=${asset.projectId}` : "/review";
  const back = manage ? libraryPath : ptoken ? `/rp/${ptoken}` : null;

  const uploadVersion = async (file: File) => {
    setUploadPct(0);
    setError("");
    try {
      const a = await uploadReviewFile(file, setUploadPct, { assetId: asset.id });
      await reload();
      pickVersion(a.versions.at(-1)!.n);
    } catch (e) {
      setError(`${(e as Error).message}. Upload the same file again to continue where it stopped.`);
    } finally {
      setUploadPct(null);
    }
  };

  const exportCsv = () => {
    const cell = (s: string) => `"${s.replace(/"/g, '""')}"`;
    const rows = comments
      .filter((c) => c.version === n)
      .sort((a, b) => (a.t ?? Infinity) - (b.t ?? Infinity))
      .map((c) =>
        [
          c.t === undefined ? "" : timecode(c.t, version.fps),
          c.tEnd === undefined ? "" : timecode(c.tEnd, version.fps),
          c.parentId ? "reply" : "comment",
          c.author,
          c.resolved ? "done" : "",
          c.text,
        ]
          .map(cell)
          .join(","),
      );
    const blob = new Blob([["In,Out,Type,Author,Status,Comment", ...rows].join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${asset.name} v${n} comments.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    // the app's bar (AppBar) for the owner: logo, Review › this video; a reviewer on a link gets only the way back
    <header data-titlebar className="flex min-h-14 flex-wrap items-center gap-2 px-3 py-2 sm:h-14 sm:flex-nowrap sm:px-4">
      {manage ? (
        <>
          <HomeLink />
          <HistoryArrows />
          <Link to={libraryPath} className="shrink-0 text-sm font-semibold tracking-tight text-zinc-500 hover:text-zinc-200">
            Review
          </Link>
          <ChevronRight className="h-4 w-4 shrink-0 text-zinc-500" />
        </>
      ) : back && (
        <Link to={back} className="rounded-md p-1.5 text-zinc-500 hover:bg-zinc-900 hover:text-zinc-200" aria-label="All videos">
          <ArrowLeft className="h-5 w-5" />
        </Link>
      )}
      {renaming ? (
        <input
          autoFocus
          defaultValue={asset.name}
          maxLength={160}
          className="min-w-0 rounded-md border border-violet-500 bg-zinc-950 px-2 py-1 text-sm outline-none"
          onBlur={async (e) => {
            setRenaming(false);
            const name = e.target.value.trim();
            if (name && name !== asset.name) setAsset(await patchReviewAsset(asset.id, { name }));
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") setRenaming(false);
          }}
        />
      ) : (
        <h1
          className={cn("min-w-0 truncate text-sm font-semibold", manage && "cursor-text rounded px-1 hover:bg-zinc-900")}
          onClick={() => manage && setRenaming(true)}
          title={manage ? "Rename" : undefined}
        >
          {asset.name}
        </h1>
      )}

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button className="flex items-center gap-1 rounded-md border border-zinc-800 px-2 py-1 text-xs font-medium hover:bg-zinc-900">
            <Layers className="h-3.5 w-3.5" /> V{n}
            <ChevronDown className="h-3 w-3 text-zinc-500" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64">
          <DropdownMenuLabel>Versions</DropdownMenuLabel>
          {[...asset.versions].reverse().map((v) => (
            <DropdownMenuItem key={v.n} onClick={() => pickVersion(v.n)} className="flex items-center gap-2">
              <span className="w-7 font-medium">V{v.n}</span>
              <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{v.name}</span>
              {v.captioned && <CC />}
              {v.removed && <span className="text-[10px] text-zinc-500" title="Video deleted to save space">no file</span>}
              <span className="flex items-center gap-0.5 text-xs text-muted-foreground">
                <MessageSquare className="h-3 w-3" />
                {comments.filter((c) => c.version === v.n && !c.parentId).length}
              </span>
              {v.n === n && <Check className="h-3.5 w-3.5" />}
            </DropdownMenuItem>
          ))}
          {manage && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => fileInput.current?.click()}>Upload new version…</DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {asset.versions.filter((v) => v.status === "ready" && !v.removed).length > 1 && (
        <button
          onClick={onCompare}
          title="Compare two versions side by side"
          className="flex items-center gap-1 rounded-md border border-zinc-800 px-2 py-1 text-xs font-medium hover:bg-zinc-900"
        >
          <Columns2 className="h-3.5 w-3.5" /> Compare
        </button>
      )}
      {manage && version.screen && version.status === "ready" && !version.removed && (
        <button
          onClick={onZoom}
          title="Zooms where you clicked, a smooth pointer, background and frame shape; makes the next version"
          className="rounded-md bg-violet-600/20 px-2 py-1 text-xs font-medium text-violet-200 hover:bg-violet-600/30"
        >
          Zoom & pointer
        </button>
      )}
      {manage && version.source && (
        <Link to={version.source.href} title={`Made in ${version.source.label}`} className="truncate text-xs text-violet-300 hover:text-violet-200">
          {version.source.label}
        </Link>
      )}
      {/* an AI Editor version has its own timeline (the editor's), so no file is added here */}
      {manage && version.status === "ready" && !version.removed && !version.edit && !version.draft && (
        <>
          {version.timelineFile && <span className="truncate text-xs text-zinc-500">Timeline from {version.timelineFile}</span>}
          <button
            onClick={() => timelineInput.current?.click()}
            title="OTIO, FCP 7 XML, FCPXML or EDL. Resolve: File → Export → Timeline. Premiere: File → Export → Final Cut Pro XML. Final Cut: File → Export XML (pick Info.fcpxml inside the .fcpxmld)."
            className="rounded px-1 text-xs text-violet-300 hover:bg-zinc-900 hover:text-violet-200"
          >
            {version.timelineFile ? "Replace timeline" : "Add timeline file"}
          </button>
          {timelineError && <span className="text-xs text-red-400">{timelineError}</span>}
          <input
            ref={timelineInput}
            type="file"
            accept={TIMELINE_ACCEPT}
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) addTimeline(f);
            }}
          />
        </>
      )}
      <input
        ref={fileInput}
        type="file"
        accept="video/*,audio/*,.mov,.mxf,.mkv"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) void uploadVersion(f);
        }}
      />
      {uploadPct !== null && (
        <span className="flex items-center gap-1.5 text-xs text-zinc-400">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Uploading V{asset.versions.length + 1} · {uploadPct}%
        </span>
      )}
      {error && <span className="text-xs text-red-400">{error}</span>}

      <div className="ml-auto flex items-center gap-2">
        <ApprovalControl asset={asset} manage={manage} approve={approve} />
        {asset.download && version.status !== "error" && !version.removed && (
          <a
            href={api.media(version, "download")}
            download
            className="rounded-md p-1.5 text-zinc-400 hover:bg-zinc-900 hover:text-zinc-100"
            title="Download original"
          >
            <Download className="h-4 w-4" />
          </a>
        )}
        {manage && version.status !== "error" && !version.removed &&
          (version.captioned ? (
            <CaptionedPair asset={asset} n={n} />
          ) : (
            <CaptionStudioButton asset={asset} n={n} next={asset.approval.status === "approved"} />
          ))}
        {manage && (
          <ReviewShareButton
            share={asset.share}
            url={asset.share ? shareUrl(asset.share.token) : ""}
            what="every version"
            update={async (share) => setAsset(await patchReviewAsset(asset.id, { share }))}
          />
        )}
        <ReviewActionButtons actions={actions} ctx={slotCtx} bind={bind} />
        {manage && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="rounded-md p-1.5 text-zinc-400 hover:bg-zinc-900 hover:text-zinc-100" aria-label="More">
                <MoreHorizontal className="h-4 w-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={exportCsv}>Export V{n} comments (CSV)</DropdownMenuItem>
              <CaptionsMenu asset={asset} n={n} setAsset={setAsset} onError={setError} />
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="text-red-400"
                onClick={async () => {
                  if (!(await confirmDialog({ title: `Move “${asset.name}” to the trash?`, body: "You can restore it for 30 days.", ok: "Move to trash", danger: true, deleting: true }))) return;
                  await deleteReviewAsset(asset.id);
                  navigate(libraryPath);
                }}
              >
                <Trash2 /> Delete video
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        {view.user && (
          // phones: the library's header has it; this row is full
          <span className="hidden sm:contents">
            <UserMenu />
          </span>
        )}
      </div>
    </header>
  );
}

/** Caption this version: opens its Caption Studio project on the same file.
 *  Approved is the cue: then it becomes the page's next step, and it offers to
 *  delete the earlier versions' video files (the review rounds are over). */
function CaptionStudioButton({ asset, n, next }: { asset: ReviewAsset; n: number; next: boolean }) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <>
      {error && <span className="text-xs text-red-400">{error}</span>}
      <Button
        size="sm"
        variant={next ? "default" : "outline"}
        disabled={busy}
        title="Open this version in Caption Studio. Same file, no upload."
        className={cn(
          "h-7 text-xs",
          next ? "bg-emerald-600 text-white hover:bg-emerald-500" : "border-zinc-800 bg-transparent",
        )}
        onClick={async () => {
          setBusy(true);
          setError("");
          try {
            // same rule as the server's clearableBefore
            const kept = new Set(asset.versions.filter((x) => x.n >= n).map((x) => x.madeFrom));
            const old = asset.versions.filter((x) => x.n < n && !x.removed && x.status !== "processing" && !kept.has(x.n));
            if (
              next &&
              old.length &&
              (await confirmDialog({
                title: `V${n} is approved. Delete the video files of ${old.map((x) => `V${x.n}`).join(", ")}?`,
                body: `${fmtBytes(old.reduce((sum, x) => sum + x.bytes, 0))}. Their comments and thumbnails stay.`,
                ok: "Delete old files",
                danger: true,
              }))
            ) {
              await clearEarlierVersions(asset.id, n);
            }
            const { projectId } = await openInCaptionStudio(asset.id, n);
            navigate(`/captions?project=${projectId}`);
          } catch (e) {
            setError((e as Error).message);
            setBusy(false);
          }
        }}
      >
        {busy ? <Loader2 className="animate-spin" /> : <Captions />}
        {busy ? "Preparing…" : next ? "Caption it" : "Caption Studio"}
      </Button>
    </>
  );
}

const CC = () => (
  <span className="rounded bg-zinc-700 px-1 text-[10px] font-semibold leading-4 text-zinc-100" title="Captions burned in">
    CC
  </span>
);

/** "Captions burned in" for a version that skipped Caption Studio, and which
 *  version without captions it was made from (the pair Save to Content sends). */
function CaptionsMenu({
  asset,
  n,
  setAsset,
  onError,
}: {
  asset: ReviewAsset;
  n: number;
  setAsset: (a: ReviewAsset) => void;
  onError: (e: string) => void;
}) {
  const version = asset.versions.find((v) => v.n === n)!;
  const sources = asset.versions.filter((v) => v.n !== n && !v.captioned);
  const mark = (patch: { captioned: boolean; madeFrom?: number }) =>
    markCaptioned(asset.id, n, patch)
      .then(setAsset)
      .catch((e: Error) => onError(e.message));
  const tick = (on: boolean) => on && <Check className="ml-auto h-3.5 w-3.5" />;
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>V{n}: captions burned in?</DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-72">
        <DropdownMenuItem onClick={() => void mark({ captioned: false })}>
          No, not captioned {tick(!version.captioned)}
        </DropdownMenuItem>
        {sources.map((v) => (
          <DropdownMenuItem key={v.n} onClick={() => void mark({ captioned: true, madeFrom: v.n })}>
            <span className="min-w-0 truncate">
              Yes, made from V{v.n} <span className="text-xs text-muted-foreground">{v.name}</span>
            </span>
            {tick(!!version.captioned && version.madeFrom === v.n)}
          </DropdownMenuItem>
        ))}
        <DropdownMenuItem onClick={() => void mark({ captioned: true })}>
          Yes, no version without captions here {tick(!!version.captioned && !version.madeFrom)}
        </DropdownMenuItem>
        <DropdownMenuLabel className="text-[11px] font-normal leading-snug text-muted-foreground">
          To link its version without captions, add that file to this stack: upload it here as a new version, or drag
          its card onto this one in Review.
        </DropdownMenuLabel>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

/** A captioned version needs no Caption Studio: it shows as captioned, and the version it was made from. */
function CaptionedPair({ asset, n }: { asset: ReviewAsset; n: number }) {
  const version = asset.versions.find((v) => v.n === n)!;
  return (
    <>
      <span
        className="flex items-center gap-1.5 rounded-md border border-zinc-800 px-2 py-1 text-xs"
        title={version.madeFrom ? `Captions burned in, made from V${version.madeFrom}` : "Captions burned in"}
      >
        <CC /> {version.madeFrom ? `from V${version.madeFrom}` : "Captioned"}
      </span>
    </>
  );
}

function ApprovalControl({
  asset,
  manage,
  approve,
}: {
  asset: ReviewAsset;
  manage: boolean;
  approve: (s: Approval) => Promise<void>;
}) {
  const cur = asset.approval;
  const badge = (
    <span className="flex items-center gap-1.5 rounded-md border border-zinc-800 px-2 py-1 text-xs">
      <span className={cn("h-2 w-2 rounded-full", APPROVAL[cur.status].dot)} />
      {APPROVAL[cur.status].label}
      {cur.by && cur.status !== "none" && <span className="hidden text-zinc-500 sm:inline">· {cur.by}</span>}
      {manage && <ChevronDown className="h-3 w-3 text-zinc-500" />}
    </span>
  );
  if (manage) {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button>{badge}</button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {(Object.keys(APPROVAL) as Approval[]).map((s) => (
            <DropdownMenuItem key={s} onClick={() => void approve(s)} className="gap-2">
              <span className={cn("h-2 w-2 rounded-full", APPROVAL[s].dot)} /> {APPROVAL[s].label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }
  return (
    <div className="flex items-center gap-1.5">
      {cur.status !== "none" && badge}
      {cur.status !== "changes" && (
        <Button size="sm" variant="outline" className="h-7 border-zinc-800 bg-transparent text-xs" onClick={() => void approve("changes")}>
          Request changes
        </Button>
      )}
      {cur.status !== "approved" && (
        <Button size="sm" className="h-7 bg-emerald-600 text-xs text-white hover:bg-emerald-500" onClick={() => void approve("approved")}>
          <Check /> Approve
        </Button>
      )}
    </div>
  );
}

// ---------- timeline with comment markers ----------

function Timeline({
  duration,
  time,
  threads,
  selected,
  rangeIn,
  rangeOut,
  inset,
  onSeek,
  onPick,
}: {
  duration: number;
  time: number;
  threads: ReviewComment[];
  selected: string | null;
  rangeIn: number | null;
  rangeOut?: number | null;
  /** px from each side where 0:00 and the end are: lines up with the edit timeline below */
  inset?: { left: number; right: number };
  onSeek: (t: number) => void;
  onPick: (c: ReviewComment) => void;
}) {
  const bar = useRef<HTMLDivElement>(null);
  const pct = (t: number) => `${duration ? Math.min(100, (t / duration) * 100) : 0}%`;
  const at = (e: ReactPointerEvent) => {
    const r = bar.current!.getBoundingClientRect();
    return (Math.min(Math.max(0, e.clientX - r.left), r.width) / r.width) * duration;
  };
  return (
    <div className="px-3 pt-2" style={inset && { paddingLeft: 12 + inset.left, paddingRight: 12 + inset.right }}>
      <div
        ref={bar}
        className="group relative h-9 cursor-pointer touch-none"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          onSeek(at(e));
        }}
        onPointerMove={(e) => e.buttons === 1 && onSeek(at(e))}
      >
        {/* markers */}
        {threads.map((c) =>
          c.t === undefined ? null : (
            <button
              key={c.id}
              title={`${c.author}: ${c.text}`}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => onPick(c)}
              className={cn(
                "absolute top-0 z-10 flex h-4 -translate-x-1/2 items-center justify-center rounded-full text-[9px] font-semibold text-white ring-2 ring-black",
                avatarColor(c.author),
                c.tEnd !== undefined ? "min-w-4" : "w-4",
                c.resolved && "opacity-40",
                c.id === selected && "ring-white",
              )}
              style={{ left: pct(c.t) }}
            >
              {c.author.slice(0, 1).toUpperCase()}
            </button>
          ),
        )}
        {/* ranges */}
        {threads.map((c) =>
          c.t !== undefined && c.tEnd !== undefined ? (
            <div
              key={`r-${c.id}`}
              className={cn("absolute top-[22px] h-1 rounded-full opacity-70", avatarColor(c.author))}
              style={{ left: pct(c.t), width: `calc(${pct(c.tEnd)} - ${pct(c.t)})` }}
            />
          ) : null,
        )}
        {rangeIn !== null && (
          <div
            className="absolute top-[22px] h-1 rounded-full bg-violet-400"
            style={{ left: pct(Math.min(rangeIn, rangeOut ?? time)), width: `calc(${pct(Math.max(rangeIn, rangeOut ?? time))} - ${pct(Math.min(rangeIn, rangeOut ?? time))})` }}
          />
        )}
        {/* track */}
        <div className="absolute inset-x-0 top-7 h-1 rounded-full bg-zinc-800 group-hover:h-1.5">
          <div className="h-full rounded-full bg-violet-500" style={{ width: pct(time) }} />
        </div>
        <div className="absolute top-[22px] h-4 w-0.5 -translate-x-1/2 bg-white" style={{ left: pct(time) }} />
      </div>
    </div>
  );
}

// ---------- one comment thread ----------

function Thread({
  c,
  replies,
  fps,
  active,
  flash,
  manage,
  refUrl,
  onPick,
  onReply,
  onEdit,
  onDelete,
}: {
  c: ReviewComment;
  replies: ReviewComment[];
  fps: number;
  active: boolean;
  /** just sent: lit up for a moment */
  flash?: boolean;
  manage: boolean;
  refUrl: Api["refUrl"];
  onPick: () => void;
  onReply: (body: string) => Promise<boolean>;
  onEdit: (id: string, patch: { text?: string; resolved?: boolean }) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  const [replying, setReplying] = useState(false);
  const [body, setBody] = useState("");
  const [error, setError] = useState("");
  // an edit stays open until Save or Cancel: clicking away keeps it
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const saveEdit = async () => {
    const x = [c, ...replies].find((y) => y.id === editingId);
    const text = editText.trim();
    try {
      if (x && text && text !== x.text) await onEdit(x.id, { text });
      setEditingId(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const editProps = (x: ReviewComment) => ({
    startEdit: () => {
      setReplying(false);
      setError("");
      setEditingId(x.id);
      setEditText(x.text);
    },
    edit: editingId === x.id ? { text: editText, set: setEditText, save: saveEdit, cancel: () => setEditingId(null) } : null,
  });
  const send = async () => {
    if (!body.trim()) return;
    try {
      if (await onReply(body.trim())) {
        setBody("");
        setReplying(false);
      }
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <div
      id={`c-${c.id}`}
      className={cn(
        "mb-2 rounded-lg border px-3 py-2.5 transition-[background-color,border-color,box-shadow] duration-700",
        flash ? "border-violet-400 bg-violet-950/70 ring-[3px] ring-violet-400/35"
          : active ? "border-violet-500/60 bg-zinc-900" : "border-transparent hover:bg-zinc-900/60",
        c.resolved && "opacity-60",
      )}
    >
      <Entry c={c} fps={fps} manage={manage} refUrl={refUrl} onPick={onPick} onEdit={onEdit} onDelete={onDelete} top {...editProps(c)} />
      {replies.map((r) => (
        <div key={r.id} className="ml-8 mt-2 border-l border-zinc-800 pl-3">
          <Entry c={r} fps={fps} manage={manage} refUrl={refUrl} onEdit={onEdit} onDelete={onDelete} {...editProps(r)} />
        </div>
      ))}
      {replying ? (
        <div className="ml-8 mt-2">
          <textarea
            autoFocus
            value={body}
            onChange={(e) => setBody(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              } else if (e.key === "Escape") setReplying(false);
            }}
            rows={2}
            placeholder="Reply…"
            className="[field-sizing:content] min-h-16 max-h-60 w-full resize-none rounded-md border border-zinc-800 bg-zinc-950 px-2.5 py-1.5 text-sm outline-none focus:border-violet-500"
          />
          {error && <p className="text-xs text-red-400">{error}</p>}
        </div>
      ) : editingId ? (
        <div className="ml-8 mt-1.5 flex items-center gap-3 text-xs">
          <button className="h-8 rounded-md bg-violet-600 px-3 text-sm font-medium text-white hover:bg-violet-500" onClick={() => void saveEdit()}>
            Save
          </button>
          <button className="text-zinc-500 hover:text-zinc-300" onClick={() => setEditingId(null)}>
            Cancel
          </button>
          {error && <span className="text-red-400">{error}</span>}
        </div>
      ) : (
        <div className="ml-8 mt-1.5 flex gap-3 text-xs text-zinc-500">
          <button className="hover:text-zinc-300" onClick={() => setReplying(true)}>
            Reply
          </button>
          {c.mine && (
            <button className="hover:text-zinc-300" onClick={editProps(c).startEdit}>
              Edit
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function Entry({
  c,
  fps,
  manage,
  refUrl,
  top,
  onPick,
  onEdit,
  onDelete,
  edit,
  startEdit,
}: {
  c: ReviewComment;
  fps: number;
  manage: boolean;
  refUrl: Api["refUrl"];
  top?: boolean;
  onPick?: () => void;
  onEdit: (id: string, patch: { text?: string; resolved?: boolean }) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  /** Being edited: the text so far; the thread's Save / Cancel act on it. */
  edit: { text: string; set: (text: string) => void; save: () => Promise<void>; cancel: () => void } | null;
  startEdit: () => void;
}) {
  return (
    <div className="flex gap-2.5">
      <span
        className={cn(
          "flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold text-white",
          avatarColor(c.author),
        )}
      >
        {c.author.slice(0, 1).toUpperCase()}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-xs">
          <span className="truncate font-medium text-zinc-200">{c.author}</span>
          <span className="shrink-0 text-zinc-600">{timeAgo(c.createdAt)}</span>
          <div className="ml-auto flex shrink-0 items-center gap-0.5">
            {top && (manage || c.mine) && (
              <button
                title={c.resolved ? "Reopen" : "Mark done"}
                onClick={() => void onEdit(c.id, { resolved: !c.resolved })}
                className={cn(
                  "flex h-5 w-5 items-center justify-center rounded-full border",
                  c.resolved ? "border-emerald-500 bg-emerald-500 text-black" : "border-zinc-700 text-transparent hover:text-zinc-500",
                )}
              >
                <Check className="h-3 w-3" />
              </button>
            )}
            {(manage || c.mine) && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button className="rounded p-0.5 text-zinc-600 hover:text-zinc-300" aria-label="Comment actions">
                    <MoreHorizontal className="h-4 w-4" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {c.mine && <DropdownMenuItem onClick={startEdit}>Edit</DropdownMenuItem>}
                  <DropdownMenuItem className="text-red-400" onClick={() => void onDelete(c.id)}>
                    Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        </div>
        <div className="mt-1 text-sm text-zinc-300">
          {top && c.t !== undefined && (
            <button
              onClick={onPick}
              className="mr-1.5 inline-flex items-center gap-1 rounded bg-violet-600/20 px-1.5 py-px font-mono text-xs tabular-nums text-violet-300 hover:bg-violet-600/40"
            >
              {timecode(c.t, fps)}
              {c.tEnd !== undefined && ` → ${timecode(c.tEnd, fps)}`}
              {c.drawing && <PenLine className="h-3 w-3" />}
            </button>
          )}
          {top && c.anchor && (
            <span className="mr-1.5 inline-flex max-w-[12rem] truncate rounded bg-zinc-800 px-1.5 py-px text-xs text-zinc-300"
              title={`On the timeline: ${(c.anchors ?? [c.anchor]).map((a) => `${a.label} (${a.track})`).join(", ")}`}>
              {c.anchors && c.anchors.length > 1 ? `${c.anchors.length} clips` : c.anchor.label}
            </span>
          )}
          {edit ? (
            <textarea
              autoFocus
              value={edit.text}
              onChange={(e) => edit.set(e.target.value)}
              rows={3}
              className="mt-1 max-h-60 w-full resize-none rounded-md border border-violet-500 bg-zinc-950 px-2 py-1 text-sm outline-none [field-sizing:content]"
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void edit.save();
                } else if (e.key === "Escape") edit.cancel();
              }}
            />
          ) : (
            <span className="whitespace-pre-wrap break-words" onClick={top ? onPick : undefined}>
              {c.text}
              {c.editedAt && <span className="ml-1 text-xs text-zinc-600">(edited)</span>}
            </span>
          )}
        </div>
        {!!c.refs?.length && (
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {c.refs.map((r) => (
              <a
                key={r.id}
                href={refUrl(c.version, r.id, "file")}
                target="_blank"
                rel="noreferrer"
                title={r.name}
                className="relative block h-16 w-16 overflow-hidden rounded-md border border-zinc-800 hover:border-violet-500"
              >
                {/* a GIF plays as itself; a video shows the frames the AI reads */}
                <Picture
                  src={refUrl(c.version, r.id, r.mime === "image/gif" ? "file" : "look")}
                  alt={r.name}
                  className="h-full w-full object-cover"
                />
                {r.kind === "video" && r.mime !== "image/gif" && (
                  <Play className="absolute inset-0 m-auto h-5 w-5 fill-white text-white drop-shadow" />
                )}
              </a>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------- small bits ----------

function IconBtn({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button title={label} aria-label={label} onClick={onClick} className="rounded-md p-1.5 hover:bg-zinc-800">
      {children}
    </button>
  );
}

function Chip({
  on,
  onClick,
  title,
  children,
}: {
  on: boolean;
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      title={title}
      onClick={onClick}
      className={cn(
        "flex h-7 items-center gap-1 rounded-md border px-2 text-xs",
        on ? "border-violet-500/60 bg-violet-600/15 text-violet-200" : "border-zinc-800 text-zinc-500 hover:text-zinc-300",
      )}
    >
      {children}
    </button>
  );
}
