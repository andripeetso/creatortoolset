import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { useCachedList } from "@/lib/local-cache";
import { Download, Eraser, Loader2, Play, Scissors, Upload, UploadCloud, X } from "lucide-react";
import { AppBar, ToolIntro } from "@/components/AppBar";
import { dropZoneClass } from "@/components/DropZone";
import { BrowseBar, NewFolderButton } from "@/components/browse/Bar";
import { FolderTrail, MoveToMenu, ToolFolderCards, ToolFolderRows } from "@/components/browse/ToolFolders";
import { useToolFolders } from "@/lib/folders";
import { FolderGrid, ItemCard } from "@/components/browse/Grid";
import { byName, matches, persistSort, storedSort, useBrowseView } from "@/components/browse/views";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { useMe } from "@/lib/auth";
import { downloadBlob } from "@/lib/download";
import {
  analyse,
  MAX_STORY,
  planCuts,
  readSignals,
  renderStories,
  snapCut,
  spotAt,
  WHY,
  type Analysis,
} from "@/lib/story-split";

/**
 * Story Splitter (/stories): a video in, stories of about 20 s out, as one
 * ZIP. The cuts land on the edit's own cuts, pauses and beats; the owner can
 * drop, add ("about here", snapped) and re-plan around the ones the author added.
 * Opened from a library piece with ?clip=<version id>&name=<file> (&split=<id> for a saved split). A download keeps
 * the split (api/stories.ts); a saved one is listed, and its video is dropped again to open it.
 */

type Cut = { t: number; mine: boolean };
type Source = { blob: Blob; name: string; url: string; clip?: string };
type Split = { id: string; name: string; clip?: string; cuts: number[]; target: number; duration: number; updatedAt: number };

const SORTS = ["recent", "name"] as const;
const SORT_KEY = "stories:sort";
const storiesOf = (s: Split) => `${s.cuts.length + 1} ${s.cuts.length ? "stories" : "story"}`;
const dayOf = (at: number) => new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });

const clock = (t: number) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, "0")}`;
const baseName = (name: string) =>
  name.replace(/\.[^.]+$/, "").replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "story";
const tone = (score: number) => (score >= 0.6 ? "bg-emerald-400" : score >= 0.2 ? "bg-amber-400" : "bg-red-400");
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const plan = (a: Analysis, target: number, cuts: Cut[]) => {
  const mine = cuts.filter((c) => c.mine).map((c) => c.t);
  return planCuts(a, target, mine).map((t) => ({ t, mine: mine.includes(t) }));
};

export default function StorySplitterPage() {
  const [params, setParams] = useSearchParams();
  const me = useMe();
  const lists = !!me; // an account keeps its splits
  // the saved splits: the local copy at once, live with changes from elsewhere (lib/local-cache)
  const { items: splits, setItems: setSplits } = useCachedList<Split>(lists ? "/api/stories" : null, () =>
    fetch("/api/stories").then((r) => (r.ok ? (r.json() as Promise<Split[]>) : Promise.reject(new Error(`HTTP ${r.status}`)))),
  );
  const [saved, setSaved] = useState<Split | null>(null); // the open video's split
  const [waiting, setWaiting] = useState<Split | null>(null); // a local file's split, until it's dropped again
  const [source, setSource] = useState<Source | null>(null);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [busy, setBusy] = useState<{ label: string; p: number } | null>(null);
  const [exporting, setExporting] = useState<{ story: number; p: number } | null>(null);
  const [error, setError] = useState("");
  const [target, setTarget] = useState(20);
  const [cuts, setCuts] = useState<Cut[]>([]);
  const [time, setTime] = useState(0);
  const [dragging, setDragging] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const stopAt = useRef<number | null>(null);
  const run = useRef(0);
  const targetRef = useRef(target);

  const open = useCallback(async (blob: Blob, name: string, clip?: string, split?: Split) => {
    const my = ++run.current;
    setError("");
    setAnalysis(null);
    setCuts([]);
    setSaved(split ?? null);
    setSource((old) => {
      if (old) URL.revokeObjectURL(old.url);
      return { blob, name, url: URL.createObjectURL(blob), clip };
    });
    const label = "Finding cuts, pauses and beats";
    setBusy({ label, p: 0 });
    try {
      const a = analyse(await readSignals(blob, (p) => run.current === my && setBusy({ label, p })));
      if (run.current !== my) return;
      setAnalysis(a);
      if (split && Math.abs(split.duration - a.duration) < 0.5) {
        setTarget(split.target);
        targetRef.current = split.target;
        setCuts(split.cuts.filter((t) => t > 0 && t < a.duration).map((t) => ({ t, mine: false })));
        return;
      }
      if (split) {
        // not the video it was made on: a new split
        setSaved(null);
        setError(`That's not this split's video (${a.duration.toFixed(1)} s, it was ${split.duration.toFixed(1)} s), so it's split afresh.`);
      }
      setCuts(plan(a, targetRef.current, []));
    } catch (e) {
      if (run.current === my) setError(message(e));
    } finally {
      if (run.current === my) setBusy(null);
    }
  }, []);

  // From a library piece: the master, read on this origin (and a saved split's cuts).
  const clip = params.get("clip");
  const clipName = params.get("name");
  const splitId = params.get("split");
  useEffect(() => {
    if (!clip) return;
    let stop = false;
    void (async () => {
      const label = "Loading from the library";
      setBusy({ label, p: 0 });
      try {
        const split = splitId
          ? await fetch(`/api/stories/${splitId}`).then((r) => (r.ok ? (r.json() as Promise<Split>) : undefined))
          : undefined;
        const res = await fetch(`/api/library/media/${encodeURIComponent(clip)}/source`);
        if (!res.ok || !res.body)
          throw new Error((await res.json().catch(() => null))?.error || `Couldn't load it from the library (${res.status})`);
        const total = Number(res.headers.get("content-length")) || 0;
        const reader = res.body.getReader();
        const parts: BlobPart[] = [];
        let got = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (stop) return void reader.cancel();
          if (done) break;
          parts.push(value);
          got += value.length;
          if (total) setBusy({ label, p: got / total });
        }
        const blob = new Blob(parts, { type: res.headers.get("content-type") || "video/mp4" });
        void open(blob, clipName || `clip-${clip.slice(0, 8)}.mp4`, clip, split);
      } catch (e) {
        if (stop) return;
        setError(message(e));
        setBusy(null);
      }
    })();
    return () => {
      stop = true;
    };
  }, [clip, clipName, splitId, open]);


  // Playhead, and stop at the end of a story played on its own.
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const v = video.current;
      if (v) {
        setTime(v.currentTime);
        if (stopAt.current !== null && v.currentTime >= stopAt.current) {
          v.pause();
          stopAt.current = null;
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const addCut = useCallback(
    (t: number) => {
      if (!analysis) return;
      const at = snapCut(analysis, t);
      if (at <= 0.3 || at >= analysis.duration - 0.3) return;
      setCuts((cs) =>
        cs.some((c) => Math.abs(c.t - at) < 0.5) ? cs : [...cs, { t: at, mine: true }].sort((a, b) => a.t - b.t),
      );
    },
    [analysis],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "c" || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      addCut(video.current?.currentTime ?? 0);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [addCut]);

  const stories = useMemo(() => {
    if (!analysis) return [];
    const bounds = [0, ...cuts.map((c) => c.t), analysis.duration];
    return bounds.slice(1).map((end, i) => ({
      start: bounds[i],
      end,
      cut: i < cuts.length ? { ...spotAt(analysis, cuts[i].t), mine: cuts[i].mine } : null,
    }));
  }, [analysis, cuts]);

  const wave = useMemo(() => {
    const e = analysis?.energy;
    if (!e?.length) return "";
    const cols = 400, top: string[] = [], bottom: string[] = [];
    for (let x = 0; x < cols; x++) {
      let peak = 0;
      for (let i = Math.floor((x * e.length) / cols); i < Math.floor(((x + 1) * e.length) / cols); i++) peak = Math.max(peak, e[i]);
      const h = 4 + 44 * peak, px = ((x + 0.5) * 1000) / cols;
      top.push(`${px.toFixed(1)},${(50 - h).toFixed(1)}`);
      bottom.unshift(`${px.toFixed(1)},${(50 + h).toFixed(1)}`);
    }
    return `M0,50 L${top.join(" L")} L1000,50 L${bottom.join(" L")} Z`;
  }, [analysis]);

  const duration = analysis?.duration ?? 0;
  const pct = (t: number) => `${(100 * t) / (duration || 1)}%`;
  const timeAt = (clientX: number) => {
    const r = bar.current!.getBoundingClientRect();
    return Math.min(duration, Math.max(0, ((clientX - r.left) / r.width) * duration));
  };
  const seek = (t: number) => {
    stopAt.current = null;
    if (video.current) video.current.currentTime = t;
  };
  const playStory = (start: number, end: number) => {
    const v = video.current;
    if (!v) return;
    v.currentTime = start;
    stopAt.current = end;
    void v.play();
  };
  const replan = (t = target) => analysis && setCuts((cs) => plan(analysis, t, cs));

  const exportZip = async () => {
    if (!source || !analysis) return;
    setError("");
    setExporting({ story: 0, p: 0 });
    try {
      const base = baseName(source.name);
      const ts = cuts.map((c) => c.t);
      const zip = await renderStories(source.blob, ts, analysis.duration, base, (story, p) => setExporting({ story, p }));
      downloadBlob(`${base}-stories.zip`, zip);
      // kept on download: a new split, or the open one's new cuts
      if (lists) {
        const res = await fetch(saved ? `/api/stories/${saved.id}` : "/api/stories", {
          method: saved ? "PUT" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            saved
              ? { cuts: ts, target }
              : { name: source.name.slice(0, 160), clip: source.clip, cuts: ts, target, duration: analysis.duration },
          ),
        });
        const j = (await res.json().catch(() => null)) as (Split & { error?: string }) | null;
        if (!res.ok || !j) throw new Error(`The stories are downloaded, but the split wasn't saved: ${j?.error || res.status}`);
        setSaved(j);
        setSplits((ss) => [j, ...ss.filter((s) => s.id !== j.id)]);
      }
    } catch (e) {
      setError(message(e));
    } finally {
      setExporting(null);
    }
  };

  const reopen = (s: Split) => {
    setError("");
    if (s.clip) setParams({ clip: s.clip, name: s.name, split: s.id });
    else setWaiting(s);
  };
  const [view, setView] = useBrowseView("stories");
  const [find, setFind] = useState("");
  const [sort, setSort] = useState(() => storedSort(SORT_KEY, SORTS));
  // the open folder's splits (every folder's when searching); the server sends them newest change first
  const folders = useToolFolders("stories", splits, find, lists);
  const listed = folders.here.filter((s) => matches(find, s.name)).sort((a, b) => (sort === "name" ? byName(a, b) : 0));
  const splitPicture = (id: string) => {
    const clip = splits.find((s) => s.id === id)?.clip;
    return clip ? `/api/library/media/${encodeURIComponent(clip)}/thumb` : undefined;
  };
  const remove = async (s: Split) => {
    const res = await fetch(`/api/stories/${s.id}`, { method: "DELETE" }).catch(() => null);
    if (res?.ok) setSplits((ss) => ss.filter((x) => x.id !== s.id));
    else setError("Couldn't delete that split");
  };

  const pick = (files: FileList | null) => {
    const f = files?.[0];
    if (f) void open(f, f.name, undefined, waiting ?? undefined);
    setWaiting(null);
  };
  const filePicker = (label: string, className: string) => (
    <label className={className}>
      <Upload className="h-4 w-4" /> {label}
      <input type="file" accept="video/*" className="hidden" onChange={(e) => pick(e.target.files)} />
    </label>
  );

  return (
    <div
      className="flex min-h-dvh flex-col bg-zinc-950 text-zinc-200"
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => e.currentTarget === e.target && setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        pick(e.dataTransfer.files);
      }}
    >
      <AppBar tool="Story Splitter" trail={source && <span className="truncate font-normal text-zinc-500">{source.name}</span>}>
        {!source && lists && splits.length > 0 && <NewFolderButton onClick={() => void folders.newFolder()} />}
        {source && filePicker("Another video", "flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2 py-1.5 text-sm text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200")}
      </AppBar>

      {error && <p className="mx-4 mt-3 rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-300">{error}</p>}

      {!source ? (
        <main className="flex flex-1 flex-col items-center justify-center gap-6 p-6">
          <ToolIntro icon={Scissors} title="Story Splitter" line="Cut a finished edit into stories of about 20 seconds, in your browser" className="mb-0 mt-0" />
          {busy ? (
            <Progress label={busy.label} p={busy.p} />
          ) : (
            <>
              <div
                className={dropZoneClass(dragging, "max-w-lg gap-4 px-6")}
              >
                {waiting ? (
                  <>
                    <p className="text-base text-zinc-300">
                      Drop <span className="font-medium text-zinc-50">{waiting.name}</span> again to open its split.
                    </p>
                    <p className="text-sm text-zinc-500">Only the cuts were kept, the video stays on your computer.</p>
                    {filePicker("Choose it", "flex cursor-pointer items-center gap-2 rounded-md bg-violet-600 px-3.5 py-2 text-sm font-medium text-white hover:bg-violet-500")}
                    <button type="button" className="text-xs text-zinc-500 hover:text-zinc-300" onClick={() => setWaiting(null)}>
                      Cancel
                    </button>
                  </>
                ) : (
                  <>
                    <UploadCloud className="h-10 w-10 text-zinc-500" />
                    <p className="text-base font-semibold">Drop a video to split it into stories of about 20 seconds.</p>
                    <p className="text-sm text-zinc-500">
                      It cuts on the edit's own cuts, in pauses and on the beat. Nothing is uploaded.
                    </p>
                    {filePicker("Choose a video", "flex cursor-pointer items-center gap-2 rounded-md bg-violet-600 px-3.5 py-2 text-sm font-medium text-white hover:bg-violet-500")}
                  </>
                )}
              </div>
              {lists && !waiting && splits.length > 0 && (
                <section className="w-full max-w-lg">
                  <h2 className="mb-1.5 px-2.5 text-sm font-medium text-zinc-400">Previous splits</h2>
                  <FolderTrail state={folders} top="Previous splits" />
                  <BrowseBar
                    search={{ value: find, onChange: setFind, placeholder: "Search splits (⌘K)" }}
                    sort={{
                      value: sort,
                      onChange: (v) => {
                        setSort(v);
                        persistSort(SORT_KEY, v);
                      },
                      label: "Sort splits",
                      options: [
                        { id: "recent", label: "Recent" },
                        { id: "name", label: "Name" },
                      ],
                    }}
                    view={{ value: view, onChange: setView }}
                  />
                  {find.trim() && listed.length === 0 && folders.folders.length === 0 && <p className="py-8 text-center text-sm text-zinc-500">No matches.</p>}
                  {view === "grid" ? (
                    <FolderGrid size="column">
                      <ToolFolderCards state={folders} pictureOf={splitPicture} />
                      {listed.map((s) => (
                        <ItemCard
                          key={s.id}
                          onClick={() => reopen(s)}
                          title={s.clip ? "Open it again from the library" : "Drop the video again to open it"}
                          picture={s.clip ? `/api/library/media/${encodeURIComponent(s.clip)}/thumb` : undefined}
                          icon={Scissors}
                          name={s.name}
                          meta={`${storiesOf(s)} · ${dayOf(s.updatedAt)}`}
                          drag={folders.drag(s.id)}
                          actions={
                            <>
                            <MoveToMenu state={folders} id={s.id} className="rounded p-1 hover:bg-white/20" />
                            <button type="button" onClick={() => void remove(s)} title="Delete this split" aria-label={`Delete the split of ${s.name}`} className="rounded p-1 hover:bg-red-600">
                              <X className="h-3.5 w-3.5" />
                            </button>
                            </>
                          }
                        />
                      ))}
                    </FolderGrid>
                  ) : (
                  <ul className="flex flex-col">
                    {folders.folders.length > 0 && (
                      <li className="mb-1.5 flex flex-col gap-1.5">
                        <ToolFolderRows state={folders} />
                      </li>
                    )}
                    {listed.map((s) => (
                      <li key={s.id} {...folders.drag(s.id)} className="group flex items-center rounded-lg hover:bg-zinc-900">
                        <button
                          type="button"
                          onClick={() => reopen(s)}
                          className="flex min-w-0 flex-1 items-baseline gap-3 px-2.5 py-2 text-left"
                          title={s.clip ? "Open it again from the library" : "Drop the video again to open it"}
                        >
                          <span className="min-w-0 flex-1 truncate text-sm">{s.name}</span>
                          <span className="shrink-0 text-xs tabular-nums text-zinc-500">
                            {s.cuts.length + 1} {s.cuts.length ? "stories" : "story"} ·{" "}
                            {new Date(s.updatedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                          </span>
                        </button>
                        <MoveToMenu state={folders} id={s.id} className="rounded p-1.5 text-zinc-600 opacity-0 hover:bg-zinc-800 hover:text-zinc-200 focus-visible:opacity-100 group-hover:opacity-100" />
                        {lists && (
                          <button
                            type="button"
                            onClick={() => void remove(s)}
                            title="Delete this split"
                            aria-label={`Delete the split of ${s.name}`}
                            className="mr-1 rounded p-1.5 text-zinc-600 hover:bg-zinc-800 hover:text-red-400"
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                  )}
                </section>
              )}
            </>
          )}
        </main>
      ) : (
        <main className="grid flex-1 gap-4 p-3 sm:p-4 lg:grid-cols-[minmax(0,1fr)_340px]">
          <section className="flex min-w-0 flex-col gap-3">
            <div className="flex justify-center rounded-xl bg-black">
              <video ref={video} src={source.url} controls playsInline className="max-h-[62vh] w-auto max-w-full" />
            </div>
            {busy || !analysis ? (
              busy && <Progress label={busy.label} p={busy.p} />
            ) : (
              <>
                <div
                  ref={bar}
                  className="relative mt-2 h-20 cursor-pointer select-none rounded-lg bg-zinc-900"
                  onClick={(e) => seek(timeAt(e.clientX))}
                  onDoubleClick={(e) => addCut(timeAt(e.clientX))}
                  title="Click to jump, double-click to cut near there"
                >
                  {stories.map((s, i) => (
                    <div
                      key={s.start}
                      className={`absolute inset-y-0 ${i % 2 ? "bg-violet-500/10" : "bg-violet-500/[0.03]"}`}
                      style={{ left: pct(s.start), width: pct(s.end - s.start) }}
                    >
                      <span className="absolute bottom-1 left-1.5 text-[10px] tabular-nums text-zinc-500">{i + 1}</span>
                    </div>
                  ))}
                  <svg viewBox="0 0 1000 100" preserveAspectRatio="none" className="pointer-events-none absolute inset-0 h-full w-full">
                    <path d={wave} className="fill-zinc-500/40" />
                  </svg>
                  {analysis.spots
                    .filter((s) => s.why.startsWith("shot"))
                    .map((s) => (
                      <div key={s.t} className="pointer-events-none absolute top-0 h-2.5 w-px bg-zinc-400/80" style={{ left: pct(s.t) }} />
                    ))}
                  {stories.map(
                    (s, i) =>
                      s.cut && (
                        <div key={s.cut.t} className="absolute inset-y-0" style={{ left: pct(s.cut.t) }}>
                          <div className={`absolute inset-y-0 -left-px w-0.5 ${s.cut.mine ? "bg-amber-300" : "bg-violet-400"}`} />
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setCuts((cs) => cs.filter((c) => c.t !== s.cut!.t));
                            }}
                            onDoubleClick={(e) => e.stopPropagation()}
                            title={`Cut ${i + 1}: ${WHY[s.cut.why]}. Click to remove.`}
                            aria-label={`Remove cut ${i + 1}`}
                            className={`absolute -top-2.5 left-0 flex h-5 w-5 -translate-x-1/2 items-center justify-center rounded-full text-zinc-950 ${
                              s.cut.mine ? "bg-amber-300" : "bg-violet-400"
                            } hover:bg-red-400`}
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </div>
                      ),
                  )}
                  <div className="pointer-events-none absolute inset-y-0 w-px bg-white" style={{ left: pct(time) }} />
                </div>
                <p className="text-xs text-zinc-500">
                  Double-click the timeline, or press <kbd className="rounded bg-zinc-800 px-1">C</kbd> at the playhead,
                  to cut about there: it snaps to the best moment within 2.5 s. Ticks on top are cuts in the edit.
                </p>
              </>
            )}
          </section>

          {analysis && !busy && (
            <aside className="flex flex-col gap-4 rounded-xl border border-zinc-900 bg-zinc-950/60 p-4">
              <p className="text-xs text-zinc-500">
                {analysis.shots} cuts in the edit · {analysis.pauses} pauses ·{" "}
                {analysis.bpm ? `${analysis.bpm} BPM beat` : "no steady beat"}
              </p>

              <div className="flex flex-col gap-2">
                <div className="flex items-baseline justify-between text-sm">
                  <span>Story length</span>
                  <span className="tabular-nums text-zinc-400">about {target} s</span>
                </div>
                <Slider
                  min={8}
                  max={45}
                  step={1}
                  value={[target]}
                  onValueChange={([v]) => {
                    setTarget(v);
                    targetRef.current = v;
                    replan(v);
                  }}
                />
              </div>

              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  className="flex-1 border-zinc-800 bg-transparent"
                  title="Place the cuts again, keeping the ones you added"
                  onClick={() => replan()}
                >
                  <Scissors /> Auto split
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="border-zinc-800 bg-transparent"
                  title="Remove every cut, then add your own"
                  onClick={() => setCuts([])}
                >
                  <Eraser /> Clear
                </Button>
              </div>

              <ol className="flex flex-col gap-1">
                {stories.map((s, i) => {
                  const len = s.end - s.start;
                  const current = time >= s.start && time < s.end;
                  return (
                    <li key={s.start}>
                      <button
                        type="button"
                        onClick={() => playStory(s.start, s.end)}
                        className={`flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left hover:bg-zinc-900 ${
                          current ? "bg-zinc-900" : ""
                        }`}
                      >
                        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-violet-600/20 text-xs font-medium text-violet-300">
                          {i + 1}
                        </span>
                        <span className="flex min-w-0 flex-1 flex-col">
                          <span className="text-sm tabular-nums">
                            {clock(s.start)} – {clock(s.end)}{" "}
                            <span className={len > MAX_STORY ? "text-red-400" : "text-zinc-500"}>
                              · {len.toFixed(1)} s{len > MAX_STORY && " (over 60 s)"}
                            </span>
                          </span>
                          {s.cut && (
                            <span className="flex items-center gap-1.5 text-xs text-zinc-500">
                              <span className={`h-1.5 w-1.5 rounded-full ${tone(s.cut.score)}`} />
                              ends {WHY[s.cut.why]}
                              {s.cut.mine && " · yours"}
                            </span>
                          )}
                        </span>
                        <Play className="h-4 w-4 shrink-0 text-zinc-500" />
                      </button>
                    </li>
                  );
                })}
              </ol>

              <div className="mt-auto flex flex-col gap-2">
                {exporting && (
                  <Progress
                    label={`Story ${exporting.story + 1} of ${stories.length}`}
                    p={(exporting.story + exporting.p) / stories.length}
                  />
                )}
                <Button
                  className="bg-violet-600 text-white hover:bg-violet-500"
                  disabled={!!exporting}
                  onClick={() => void exportZip()}
                >
                  {exporting ? <Loader2 className="animate-spin" /> : <Download />}
                  Download {stories.length} {stories.length === 1 ? "story" : "stories"} (ZIP)
                </Button>
              </div>
            </aside>
          )}
        </main>
      )}
    </div>
  );
}

function Progress({ label, p }: { label: string; p: number }) {
  return (
    <div className="flex w-full max-w-md flex-col gap-2 text-sm text-zinc-400">
      <span className="flex items-center gap-2">
        <Loader2 className="h-4 w-4 animate-spin text-violet-400" /> {label}
        <span className="ml-auto tabular-nums">{Math.round(p * 100)}%</span>
      </span>
      <div className="h-1.5 overflow-hidden rounded-full bg-zinc-800">
        <div className="h-full bg-violet-500 transition-[width]" style={{ width: `${p * 100}%` }} />
      </div>
    </div>
  );
}
