import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { toast } from "sonner";
import { Download, Eye, Loader2, MoreHorizontal, PanelLeft, Pause, Play, Save, Trash2, Undo2 } from "lucide-react";
import type { Draft, Edit, TrackId } from "@contracts/editor";
import { describeEdit, editedSpan, mediaRoom, mergeEdit, playPlan, splitView, stackEdits, type ItemEdit, type TimelineItem, type TimelineView } from "@contracts/edit-timeline";
import { describeEdits } from "@contracts/edit-summary";
import type { AssetCard, LibrarySummary } from "@contracts/library";
import { AppBar } from "@/components/AppBar";
import { EditTimeline } from "@/components/EditTimeline";
import { PlanOverlay } from "@/components/PlanOverlay";
import { Picture } from "@/components/Picture";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { canChange, useMe } from "@/lib/auth";
import { promptDialog } from "@/lib/dialogs";
import { freshHist, histChange, histRedo, histUndo, type Hist } from "@/lib/edit-history";
import { addClip, duplicateVersion, exportUrl, getDraft, getEdit, markVersion, saveCut } from "@/lib/editor";
import { listAssets, listLibraries } from "@/lib/library";
import { useCachedLoad } from "@/lib/local-cache";
import { usePageNote } from "@/lib/page-context";
import type { ReviewPlayPlan } from "@/lib/plugin";
import { mutedAt, usePlanFollow } from "@/lib/review-play";
import { undoable } from "@/lib/undo";
import { cn } from "@/lib/utils";
import { versionTitle } from "./ProjectView";

/**
 * One version on the timeline (/editor/:id/:draft), as an editor: the timeline edits it (move, trim, slip, blade,
 * copy, ripple, lanes locked), the player plays the edits as they are made (Review's play plan over the version's render),
 * and Save (⌘S) cuts exactly those edits into this version with no AI (the `/cut` route): it stays the same version, its
 * new render is filed in Review as that video's next version. Clips come from the media bin on the left (the Media
 * Library), dropped on a lane or put at the playhead; a timeline with clips put on it and never rendered has no edits to
 * cut: its Save renders it as it is.
 */

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const BIN_MIME = "application/x-ct-bin-clip";
type Change = [TimelineItem, Partial<ItemEdit>];
const timecode = (f: number, fps: number) => {
  const s = Math.floor(f / fps);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}:${String(Math.round(f % fps)).padStart(2, "0")}`;
};

export function TimelinePage({ id, name }: { id: string; name: string }) {
  const editable = canChange(useMe(), "editor");
  const navigate = useNavigate();
  const edit = useCachedLoad<Edit>(`/api/editor/${id}`, () => getEdit(id));
  const e = edit.data;
  const [draft, setDraft] = useState<Draft | null>(null);
  const [reviewView, setReviewView] = useState<TimelineView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [hist, setHist] = useState<Hist<ItemEdit[]>>(() => freshHist([]));
  const [live, setLive] = useState<Change[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(0); // the J / K / L shuttle: < 0 backwards
  const [range, setRange] = useState<[number, number] | null>(null);
  const [saving, setSaving] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  // the media bin on the left: closed until opened, open by itself on an empty timeline
  const [bin, setBin] = useState<boolean | null>(null);
  const [adding, setAdding] = useState(false);
  const video = useRef<HTMLVideoElement>(null);

  const making = e?.jobs.find((j) => j.variant === name && (j.state === "queued" || j.state === "running"));
  // the draft read again when a step of this version ends (its render filed: the player has it)
  const doneKey = e ? e.jobs.filter((j) => j.variant === name && j.state === "done").length : 0;
  useEffect(() => {
    let gone = false;
    getDraft(id, name).then((d) => !gone && setDraft(d), (x) => !gone && setLoadError(message(x)));
    return () => void (gone = true);
  }, [id, name, doneKey]);
  // what Review has of exactly this draft: its timeline (with the words lane) and its render to play
  const filed = draft?.filed ?? null;
  useEffect(() => {
    setReviewView(null);
    if (!filed) return;
    let gone = false;
    fetch(`/api/review/assets/${filed.assetId}/v/${filed.n}/timeline`)
      .then((r) => (r.ok ? (r.json() as Promise<TimelineView>) : null))
      .then((v) => !gone && setReviewView(v), () => {});
    return () => void (gone = true);
  }, [filed?.assetId, filed?.n]);
  // another version: its own clean timeline
  useEffect(() => {
    setHist(freshHist([]));
    setSelected(null);
    setRefused(null);
    setRange(null);
  }, [id, name]);

  const edits = hist.now;
  const view = useMemo(() => {
    const v = reviewView ?? draft?.view;
    if (!v) return null;
    // an empty timeline still has its picture and sound lanes to drop onto
    const missing = ["V1", "A1"].filter((t) => !v.tracks.some((x) => x.id === t)).map((t) => ({ id: t, name: t === "V1" ? "Speaker" : "Voice", items: [] }));
    return missing.length ? { ...v, tracks: [...v.tracks, ...missing] } : v;
  }, [reviewView, draft?.view]);
  const shown = useMemo(() => (view ? splitView(view, edits) : null), [view, edits]);
  // what plays: the edits, and an edge or a slip while it is dragged
  const playEdits = live ? live.reduce((acc, [i, x]) => mergeEdit(acc, i.key, i.label, x), edits) : edits;
  const plan = useMemo(() => (view && playEdits.length ? playPlan(splitView(view, playEdits), playEdits) : null), [view, playEdits]);
  const fps = view?.fps ?? 25;
  const rplan: ReviewPlayPlan | null = plan ? { fps, skips: plan.skips, mutes: plan.mutes, holds: plan.holds, cards: plan.cards as ReviewPlayPlan["cards"], frames: plan.frames } : null;
  const { holding, endHold } = usePlanFollow(video, rplan, time, playing);
  const frameNow = plan?.frames.find((r) => time * fps >= r.from && time * fps < r.to);

  // follow the player while it plays; J plays backwards by stepping (a video can't play in reverse)
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      if (video.current && !video.current.paused) setTime(video.current.currentTime);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
  useEffect(() => {
    if (rate >= 0) return;
    const t = window.setInterval(() => {
      const el = video.current;
      if (!el) return;
      el.currentTime = Math.max(0, el.currentTime + rate * 0.04);
      setTime(el.currentTime);
    }, 40);
    return () => window.clearInterval(t);
  }, [rate]);

  const busy = saving || !!making;
  const items = shown?.tracks.flatMap((t) => t.items) ?? [];
  const item = items.find((i) => i.key === selected);
  const editOf = (key: string) => edits.find((x) => x.key === key);
  // the length once saved: the speaker track sets it (a shot made longer runs on in its take, one taken out moves the rest up)
  const after = view ? view.duration + items.filter((i) => i.track === "V1").reduce((n, i) => {
    const x = editOf(i.key);
    return n + (x?.remove ? -i.len : (x?.head ?? 0) + (x?.tail ?? 0));
  }, 0) : 0;
  const empty = !!view && !items.length;
  // something to save: hand edits, or clips put on a timeline Review does not have yet
  const dirty = edits.length > 0 || (!!draft && !filed && items.length > 0);
  const binOpen = editable && (bin ?? empty);

  const put = async (clip: string, at: { lane?: string; frame: number }) => {
    if (edits.length) return void toast("Save the edits first: a clip goes onto the saved timeline");
    if (busy || adding) return;
    setBin(binOpen); // the bin stays as it is once the timeline is no longer empty
    setAdding(true);
    try {
      const lane = at.lane && /^[VA][1-3]$/.test(at.lane) ? at.lane : "V1";
      const made = await addClip(id, name, { clip, track: lane as TrackId, rec: Math.max(0, Math.round(at.frame)) });
      setDraft((d) => (d ? { ...d, view: made.view, filed: null } : d));
      setSelected(made.key);
      void edit.refresh().catch(() => {});
    } catch (x) {
      toast.error(message(x));
    } finally {
      setAdding(false);
    }
  };
  const change = (changes: Change[]) => {
    setHist((h) => histChange(h, (list) => changes.reduce((acc, [i, x]) => mergeEdit(acc, i.key, i.label, x), list)));
    setRefused(null);
  };
  const undo = () => setHist(histUndo);
  const redo = () => setHist(histRedo);
  const seek = (t: number) => {
    endHold();
    setTime(t);
    if (video.current) video.current.currentTime = t;
  };
  const play = (on: boolean) => {
    endHold();
    setRate(on ? 1 : 0);
    const el = video.current;
    if (!el) return;
    el.playbackRate = 1;
    if (on) void el.play().catch(() => {});
    else el.pause();
  };
  const shuttle = (dir: 1 | -1) => {
    endHold();
    const el = video.current;
    if (!el) return;
    const next = dir > 0 ? (rate > 0 ? Math.min(rate * 2, 8) : 1) : rate < 0 ? Math.max(rate * 2, -8) : -1;
    setRate(next);
    if (next > 0) {
      el.playbackRate = next;
      void el.play().catch(() => {});
    } else el.pause();
  };
  const save = async () => {
    if (!dirty || busy || !editable) return;
    setSaving(true);
    setRefused(null);
    try {
      edit.set(await saveCut(id, name, stackEdits([edits])));
      setHist(freshHist([]));
      setDraft(await getDraft(id, name));
      toast.success(e?.previews[name] ? "Saved: its render goes to Review as the next version" : "Saved: rendering it");
    } catch (x) {
      setRefused(message(x));
    } finally {
      setSaving(false);
    }
  };

  // the keys of an editor: Space, J / K / L, I / O (⌥X clears), ← / → a frame, ⌘Z / ⇧⌘Z, ⌘S; the timeline has its own
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if ((ev.target as HTMLElement | null)?.closest?.("input, textarea, select, [contenteditable=true], [role=dialog], [role=menu]")) return;
      const k = ev.key.toLowerCase();
      const mod = ev.metaKey || ev.ctrlKey;
      if (mod && !ev.altKey && k === "s") void save();
      else if (mod && !ev.altKey && k === "z") (ev.shiftKey ? redo : undo)();
      else if (ev.altKey && !mod && ev.code === "KeyX") setRange(null);
      else if (mod || ev.altKey) return;
      else if (ev.key === " ") play(!!video.current?.paused);
      else if (k === "k") play(false);
      else if (k === "l") shuttle(1);
      else if (k === "j") shuttle(-1);
      else if (k === "i") setRange([time, Math.max(time, range?.[1] ?? after / fps)]);
      else if (k === "o") setRange([Math.min(time, range?.[0] ?? 0), time]);
      else if (ev.key === "ArrowLeft" || ev.key === "ArrowRight") {
        video.current?.pause();
        seek(Math.max(0, time + (ev.key === "ArrowLeft" ? -1 : 1) / fps));
      } else return;
      ev.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const title = e ? versionTitle(e, name) : name;
  // the chat knows which version is open here and what was changed by hand and not saved yet
  const said = `Editor timeline: ${e?.name ?? id}, ${title}. ${edits.length ? `Unsaved edits by hand: ${describeEdits(edits, fps)}` : "No unsaved edits"}`;
  useEffect(() => usePageNote.setState({ note: said }), [said]);
  useEffect(() => () => usePageNote.setState({ note: null }), []);
  const run = (f: () => Promise<unknown>) => void f().catch((x) => toast.error(message(x)));
  const duplicate = () => run(async () => {
    const made = await duplicateVersion(id, name);
    navigate(`/editor/${id}/${made.name}`);
    undoable("duplicated", () => markVersion(id, made.name, { trashed: true }));
  });
  const rename = () => run(async () => {
    const to = await promptDialog({ title: `Rename ${title}`, value: title, ok: "Rename" });
    if (to === null) return;
    const marks = await markVersion(id, name, { label: to.trim() === name ? "" : to.trim() });
    if (e) edit.set({ ...e, marks });
  });
  const remove = () => run(async () => {
    await markVersion(id, name, { trashed: true });
    navigate(`/editor/${id}`);
    undoable("version deleted", () => markVersion(id, name, { trashed: false }));
  });

  const bar = (
    <AppBar tool="Editor" to={`/editor/${id}`} trail={title}>
      <a href={exportUrl(id, name, "otio")} download className="hidden items-center gap-1 rounded-md px-2 py-1.5 text-xs text-zinc-500 hover:bg-zinc-500/10 hover:text-foreground sm:inline-flex">
        <Download className="h-3.5 w-3.5" /> .otio
      </a>
      {filed && (
        <Button asChild size="sm" variant="outline">
          <Link to={`/review/${filed.assetId}?v=${filed.n}`}><Eye className="h-4 w-4" /> <span className="hidden md:inline">In Review</span></Link>
        </Button>
      )}
      {editable && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="ghost" aria-label="More" className="px-2"><MoreHorizontal className="h-4 w-4" /></Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={duplicate}>Duplicate</DropdownMenuItem>
            <DropdownMenuItem onSelect={rename}>Rename</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="text-red-500" onSelect={remove}>Delete</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </AppBar>
  );

  if (!view || !shown) {
    // the page's frame in its final places (player, inspector, timeline), no spinner
    return (
      <div className="flex min-h-dvh flex-col">
        {bar}
        <div className="flex min-h-0 w-full flex-1 flex-col gap-2 px-3 py-2">
          <div className="grid gap-2 lg:grid-cols-[minmax(0,1fr)_288px]">
            <div className="h-[50vh] rounded-lg border border-zinc-500/20 bg-black" />
            <aside className="hidden h-[50vh] rounded-lg border border-zinc-500/20 lg:block" />
          </div>
          <div className="h-56 rounded-lg border border-zinc-500/20" />
          {(loadError || edit.error) && <p className="text-xs text-red-400">{loadError || edit.error}</p>}
        </div>
      </div>
    );
  }
  const past = after > view.duration;

  return (
    <div className="flex min-h-dvh flex-col">
      {bar}
      <div className="flex min-h-0 w-full min-w-0 flex-1 flex-col gap-2 px-3 py-2">
        <div className={cn("grid gap-2", binOpen ? "lg:grid-cols-[260px_minmax(0,1fr)_288px]" : "lg:grid-cols-[minmax(0,1fr)_288px]")}>
          {binOpen && (
            <aside aria-label="Media" className="h-[50vh] min-h-[260px] overflow-hidden rounded-lg border border-zinc-500/20">
              <MediaBin onUse={(clip) => void put(clip, { frame: Math.round(time * fps) })} />
            </aside>
          )}
          <div className="flex h-[50vh] min-h-[260px] justify-center overflow-hidden rounded-lg border border-zinc-500/20 bg-black">
            {filed ? (
              <div className="relative h-full overflow-hidden" style={{ aspectRatio: `${view.width || 1080} / ${view.height || 1920}` }}>
                <video ref={video} src={`/api/review/assets/${filed.assetId}/v/${filed.n}/play`} playsInline preload="auto" className="h-full w-full"
                  muted={mutedAt(rplan, time)}
                  style={frameNow ? { transform: `scale(${1 / frameNow.box.k}) translate(${-frameNow.box.x * 100}%, ${-frameNow.box.y * 100}%)`, transformOrigin: "0 0" } : undefined}
                  onClick={() => play(!!video.current?.paused)}
                  onSeeked={() => video.current && setTime(video.current.currentTime)}
                  onTimeUpdate={() => video.current?.paused && setTime(video.current.currentTime)}
                  onPlay={() => setPlaying(true)}
                  onPause={() => setPlaying(false)}
                  onEnded={() => { setPlaying(false); setRate(0); }} />
                {plan && <PlanOverlay cards={rplan!.cards} fps={fps} time={time} holding={holding} playing={playing} rate={Math.max(1, rate)} />}
              </div>
            ) : (
              <div className="grid place-items-center p-6 text-center text-sm text-zinc-500">
                {making ? "Rendering" : empty ? "Empty timeline" : "Not rendered yet: Save renders it"}
              </div>
            )}
          </div>
          {/* on a phone only while a clip is picked: the timeline needs the height */}
          <aside className={cn("h-[50vh] min-h-[260px] overflow-y-auto rounded-lg border border-zinc-500/20 p-3 text-xs", !item && "hidden lg:block")}>
            {item ? (
              <Inspector key={`${item.key}:${JSON.stringify(editOf(item.key) ?? null)}`} item={item} e={editOf(item.key)} fps={fps}
                locked={busy || !editable} onChange={(x) => change([[item, x]])} />
            ) : (
              <div className="grid gap-1.5 text-zinc-500">
                <div className="text-sm font-medium text-foreground">{title}</div>
                <div>{(view.duration / fps).toFixed(2)} s{edits.length ? ` → ${(after / fps).toFixed(2)} s once saved` : ""}</div>
                <div>{edits.length ? `${edits.length} ${edits.length === 1 ? "clip" : "clips"} edited` : "No edits"}</div>
              </div>
            )}
          </aside>
        </div>

        <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-500">
          {editable && (
            <Button size="sm" variant="ghost" aria-pressed={binOpen} onClick={() => setBin(!binOpen)} className={cn("h-7 px-2", binOpen && "bg-zinc-500/15 text-foreground")}>
              <PanelLeft className="h-3.5 w-3.5" /> Media
            </Button>
          )}
          <Button size="sm" variant="outline" aria-label={playing ? "Pause (Space)" : "Play (Space)"} className="h-7 w-7 p-0" disabled={!filed} onClick={() => play(!playing)}>
            {playing ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
          </Button>
          <span className="font-mono tabular-nums text-foreground">{timecode(Math.round(time * fps), fps)}</span>
          <span className="font-mono tabular-nums">/ {timecode(after, fps)}</span>
          {adding && <span>Adding the clip</span>}
          {rate !== 0 && rate !== 1 && <span className="tabular-nums">{rate}×</span>}
          {holding > 0 && <span className="text-amber-600">Held {holding} frames: past the render</span>}
          {past && filed && <span className="text-amber-600">The last {((after - view.duration) / fps).toFixed(2)} s render on Save</span>}
          {refused && <span role="alert" className="text-rose-500">{refused}</span>}
          {making && <span className="ml-auto truncate">{making.state === "queued" ? "Waiting for a computer" : "Rendering"}</span>}
          {editable && (
            <Button size="sm" disabled={!dirty || busy} onClick={() => void save()} title="Save (⌘S): these edits, exactly, into this version"
              className={cn("min-w-24", !making && "ml-auto")}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              {busy ? "Saving" : "Save"}
            </Button>
          )}
        </div>
        <EditTimeline nle view={shown} time={time} onSeek={seek} edits={edits} showFlags={!edits.length}
          selected={selected} onSelect={(it) => setSelected(it?.key ?? null)}
          range={range} onRange={(a, b) => setRange([a, b])} onClearRange={() => setRange(null)}
          onDropMedia={(dt, at) => {
            const clip = dt.getData(BIN_MIME);
            if (clip) void put(clip, at);
          }}
          {...(busy || !editable ? {} : { onEdit: change, onLive: setLive, history: { back: hist.past.length, ahead: hist.future.length, undo, redo } })} />
      </div>
    </div>
  );
}

/** The selected clip: its timing, framing (a speaker shot), sound (an audio clip), and Remove. */
function Inspector({ item, e, fps, locked, onChange }: { item: TimelineItem; e?: ItemEdit; fps: number; locked: boolean; onChange: (x: Partial<ItemEdit>) => void }) {
  const span = editedSpan(item, e);
  const room = mediaRoom(item, e);
  const talent = item.track === "V1";
  const sound = item.track[0] === "A";
  // a typed value is made when the field is left or Enter is pressed: one step of undo, not one per key
  const field = (label: string, value: number, step: number, set: (v: number) => void, disabled = false) => (
    <label className="grid gap-1">
      <span className="text-zinc-500">{label}</span>
      <input type="number" step={step} defaultValue={Math.round(value * 1000) / 1000} disabled={disabled || locked}
        onBlur={(ev) => { const v = Number(ev.target.value); if (Number.isFinite(v) && v !== value) set(v); }}
        onKeyDown={(ev) => ev.key === "Enter" && ev.currentTarget.blur()}
        className="w-full rounded-md border border-zinc-500/30 bg-transparent px-2 py-1 font-mono disabled:opacity-50" />
    </label>
  );
  const frames = (s: number) => Math.round(s * fps);
  return (
    <div className="grid gap-3">
      <div>
        <div className="font-mono text-zinc-500">{item.track}</div>
        <div className="truncate text-sm font-medium" title={item.label}>{item.label}</div>
        {item.detail && <div className="mt-0.5 text-zinc-500">{item.detail}</div>}
        {e && <div className="mt-1 text-amber-600">{describeEdit(e, fps)}</div>}
      </div>
      <div className="grid grid-cols-2 gap-2">
        {field("Start (s)", span.rec / fps, 0.04, (v) => onChange({ move: (e?.move ?? 0) + frames(v) - span.rec }), talent)}
        {field("Length (s)", span.len / fps, 0.04, (v) => onChange({ tail: Math.min(room.tail, (e?.tail ?? 0) + frames(v) - span.len) }))}
      </div>
      {talent && (
        <div className="grid grid-cols-3 gap-2">
          {field("Zoom", e?.zoom ?? item.zoom ?? 1, 0.01, (v) => onChange({ zoom: Math.min(3, Math.max(1, v)), pan: e?.pan ?? item.pan ?? 0, tilt: e?.tilt ?? item.tilt ?? 0 }))}
          {field("Pan", e?.pan ?? item.pan ?? 0, 2, (v) => onChange({ zoom: e?.zoom ?? item.zoom ?? 1, pan: v, tilt: e?.tilt ?? item.tilt ?? 0 }))}
          {field("Tilt", e?.tilt ?? item.tilt ?? 0, 2, (v) => onChange({ zoom: e?.zoom ?? item.zoom ?? 1, pan: e?.pan ?? item.pan ?? 0, tilt: v }))}
        </div>
      )}
      {sound && field("Gain change (dB)", e?.gain ?? 0, 0.5, (v) => onChange({ gain: Math.min(30, Math.max(-30, Math.round(v * 10) / 10)) }))}
      <button type="button" disabled={locked} onClick={() => onChange(e?.remove ? { remove: undefined } : { remove: true })}
        className="inline-flex w-fit items-center gap-1 rounded-md px-2 py-1 text-red-500 hover:bg-red-500/10 disabled:opacity-40">
        {e?.remove ? <Undo2 className="h-3.5 w-3.5" /> : <Trash2 className="h-3.5 w-3.5" />}
        {e?.remove ? "Restore" : talent ? "Remove shot and its voice" : "Remove"}
      </button>
    </div>
  );
}

/** The Media Library's clips, searched: drag one onto a lane, or click it to put it at the playhead on the speaker lane. */
function MediaBin({ onUse }: { onUse: (clip: string) => void }) {
  const [libraries, setLibraries] = useState<LibrarySummary[]>([]);
  const [q, setQ] = useState("");
  const [items, setItems] = useState<AssetCard[] | null>(null);
  const lib = libraries[0]?.id;
  useEffect(() => void listLibraries().then(setLibraries, () => setItems([])), []);
  useEffect(() => {
    if (!lib) return;
    let live = true;
    const t = setTimeout(() => {
      listAssets(lib, { q: q.trim() || undefined, kind: ["video", "audio"] }).then((p) => live && setItems(p.items), () => live && setItems([]));
    }, 200);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [lib, q]);
  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-zinc-500/15 p-2">
        <Input type="search" value={q} onChange={(x) => setQ(x.target.value)} placeholder="Search media" aria-label="Search media" className="h-8" />
      </div>
      <ul className="grid flex-1 grid-cols-2 content-start gap-2 overflow-y-auto p-2">
        {items?.length === 0 && <li className="col-span-2 py-6 text-center text-xs text-zinc-500">No clips</li>}
        {items?.filter((a) => a.state === "ready").map((a) => (
          <li key={a.id}>
            <button type="button" draggable title={a.title}
              onDragStart={(x) => { x.dataTransfer.setData(BIN_MIME, a.versionId); x.dataTransfer.effectAllowed = "copy"; }}
              onClick={() => onUse(a.versionId)}
              className="flex w-full flex-col overflow-hidden rounded-md border border-zinc-500/20 text-left hover:border-zinc-500/50">
              <span className="relative block aspect-video w-full overflow-hidden bg-zinc-800">
                <Picture src={a.thumbUrl ?? `/api/library/media/${a.versionId}/thumb`} alt="" className="absolute inset-0 h-full w-full object-cover" />
              </span>
              <span className="truncate px-1.5 py-1 text-[11px]">{a.title}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
