import {
  Fragment,
  useCallback,
  useEffect,
  useRef,
  useState,
  type MutableRefObject,
} from "react";
import {
  Check,
  ChevronLeft,
  Download,
  Loader2,
  Maximize,
  MoreHorizontal,
  Pause,
  Pencil,
  Play,
  Share2,
  Trash2,
  Wand2,
  X,
} from "lucide-react";
import { ClipAgentDiscovery } from "@/components/ClipAgentDiscovery";
import {
  ClipCaptions,
  ClipCaptionsToggle,
  useClipCaptionsOn,
} from "@/components/ClipCaptions";
import { ClipSpeedControl } from "@/components/ClipSpeedControl";
import {
  atWindowEnd,
  clampToWindow,
  clipPlayWindow,
  useClipPlaybackRate,
} from "@/lib/clip-playback";
import {
  CLIP_BLOCK_CATALOG,
  clipChapters,
  deleteClip,
  displayBlocks,
  downloadClip,
  getClip,
  getClipTranscript,
  cleanupClipTranscript,
  restoreClipTranscript,
  isProcessing,
  playClipUrl,
  renameClip,
  retryClip,
  thumbClipUrl,
  transcriptParagraphs,
  type ClipBlock,
  type ClipChapter,
  type ClipSession,
  type ClipWord,
} from "@/lib/clips";
import { useAutoChapters } from "@/components/ClipBlocks";
import { ShareThemeSwitch } from "@/components/ShareTheme";

function fmtMmSs(t: number): string {
  const m = Math.floor(Math.max(0, t) / 60);
  const s = Math.floor(Math.max(0, t) % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

const STEPS = [
  { id: "thumbnail", label: "Grabbing a thumbnail" },
  { id: "audio", label: "Extracting audio" },
  { id: "transcribe", label: "Transcribing speech" },
  { id: "title", label: "Titling and summarizing" },
] as const;

function useLocalChecks(clipId: string, stamp: string) {
  const key = `clip-check:${clipId}:${stamp}`;
  const [done, setDone] = useState<Set<number>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem(key) ?? "[]") as number[]);
    } catch {
      return new Set();
    }
  });
  const toggle = (i: number) => {
    setDone((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      try {
        localStorage.setItem(key, JSON.stringify([...next]));
      } catch {
        /* private mode */
      }
      return next;
    });
  };
  return { done, toggle };
}

function MobilePlayer({
  src,
  poster,
  duration: known,
  onTime,
  seekRef,
  words = [],
  start,
  end,
}: {
  src: string;
  poster?: string;
  duration?: number;
  onTime: (t: number) => void;
  seekRef: MutableRefObject<(t: number) => void>;
  words?: ClipWord[];
  start?: number;
  end?: number;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(known || 0);
  const { rate, setRate } = useClipPlaybackRate(videoRef);
  const captions = useClipCaptionsOn();
  const hasCaptions = words.length > 0;
  const win = clipPlayWindow(duration, start, end);

  const report = useCallback(
    (t: number) => {
      setTime(t);
      onTime(t);
    },
    [onTime],
  );

  const seek = useCallback(
    (t: number) => {
      const v = videoRef.current;
      if (!v) return;
      const d = v.duration || duration;
      const { lo, hi } = clipPlayWindow(d, start, end);
      const next = clampToWindow(Math.max(0, Math.min(d || t, t)), lo, hi);
      v.currentTime = next;
      report(next);
    },
    [duration, end, report, start],
  );

  useEffect(() => {
    seekRef.current = seek;
  }, [seek, seekRef]);

  const toggle = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) {
      const { lo, hi } = clipPlayWindow(v.duration || duration, start, end);
      if (atWindowEnd(v.currentTime, lo, hi)) v.currentTime = lo;
      void v.play();
    } else v.pause();
  };

  const seekFromX = (clientX: number) => {
    const bar = barRef.current;
    const v = videoRef.current;
    if (!bar || !v) return;
    const r = bar.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    const d = v.duration || duration || 0;
    const { lo, hi } = clipPlayWindow(d, start, end);
    const span = Math.max(0.001, (hi > lo ? hi : d) - lo);
    seek(lo + pct * span);
  };

  useEffect(() => {
    const v = videoRef.current;
    if (!v || start == null || !Number.isFinite(start)) return;
    const apply = () => {
      const { lo } = clipPlayWindow(v.duration || duration, start, end);
      v.currentTime = lo;
      report(lo);
    };
    if (v.readyState >= 1) apply();
    else v.addEventListener("loadedmetadata", apply, { once: true });
    return () => v.removeEventListener("loadedmetadata", apply);
  }, [duration, end, report, start]);

  const goFs = () => {
    const video = videoRef.current as HTMLVideoElement & {
      webkitEnterFullscreen?: () => void;
    };
    const root = rootRef.current as HTMLElement & {
      webkitRequestFullscreen?: () => void;
    };
    if (video?.webkitEnterFullscreen) {
      video.webkitEnterFullscreen();
      return;
    }
    if (root?.requestFullscreen) void root.requestFullscreen();
    else root?.webkitRequestFullscreen?.();
  };

  const span = Math.max(0.001, win.hi - win.lo);
  const pct =
    duration > 0 ? Math.min(100, Math.max(0, ((time - win.lo) / span) * 100)) : 0;

  return (
    <div ref={rootRef} className="bg-black">
      <div className="relative">
        <video
          ref={videoRef}
          src={src}
          poster={poster}
          playsInline
          preload="metadata"
          className="aspect-video max-h-[42dvh] w-full cursor-pointer object-contain"
          onClick={toggle}
          onPlay={(e) => {
            const v = e.currentTarget;
            const { lo, hi } = clipPlayWindow(v.duration || duration, start, end);
            if (atWindowEnd(v.currentTime, lo, hi)) v.currentTime = lo;
            setPlaying(true);
          }}
          onPause={() => setPlaying(false)}
          onEnded={() => setPlaying(false)}
          onLoadedMetadata={(e) => {
            const d = e.currentTarget.duration;
            if (Number.isFinite(d) && d > 0) setDuration(d);
            const { lo } = clipPlayWindow(d, start, end);
            if (start != null && Number.isFinite(start)) {
              e.currentTarget.currentTime = lo;
              report(lo);
            }
          }}
          onTimeUpdate={(e) => {
            if (dragging.current) return;
            const v = e.currentTarget;
            const { lo, hi } = clipPlayWindow(v.duration || duration, start, end);
            if (atWindowEnd(v.currentTime, lo, hi)) {
              v.pause();
              v.currentTime = hi;
              report(hi);
              return;
            }
            report(v.currentTime);
          }}
        />
        {hasCaptions && (
          <ClipCaptions
            words={words}
            time={time}
            on={captions.on}
            className="bottom-3"
          />
        )}
        {!playing && (
          <button
            type="button"
            onClick={toggle}
            className="absolute left-1/2 top-1/2 flex h-16 w-16 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-black/50 text-white"
            aria-label="Play"
          >
            <Play className="ml-0.5 h-7 w-7 fill-current" />
          </button>
        )}
      </div>
      <div className="flex items-center gap-2 bg-zinc-925 px-3 py-1.5">
        <button
          type="button"
          onClick={toggle}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-zinc-50 active:bg-zinc-50/10"
          aria-label={playing ? "Pause" : "Play"}
        >
          {playing ? (
            <Pause className="h-5 w-5 fill-current" />
          ) : (
            <Play className="ml-0.5 h-5 w-5 fill-current" />
          )}
        </button>
        <span className="w-[4.5rem] shrink-0 font-mono text-[11px] tabular-nums text-zinc-400">
          {fmtMmSs(time)} / {fmtMmSs(win.hi || duration)}
        </span>
        <div
          ref={barRef}
          role="slider"
          aria-label="Seek"
          aria-valuemin={0}
          aria-valuemax={Math.round(duration)}
          aria-valuenow={Math.round(time)}
          className="flex h-11 min-w-0 flex-1 cursor-pointer items-center"
          onPointerDown={(e) => {
            e.preventDefault();
            dragging.current = true;
            (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
            seekFromX(e.clientX);
          }}
          onPointerMove={(e) => {
            if (dragging.current) seekFromX(e.clientX);
          }}
          onPointerUp={() => {
            dragging.current = false;
          }}
          onPointerCancel={() => {
            dragging.current = false;
          }}
        >
          <div className="relative h-1.5 w-full rounded-full bg-zinc-50/20">
            <div
              className="absolute inset-y-0 left-0 rounded-full bg-violet-400"
              style={{ width: `${pct}%` }}
            />
            <div
              className="absolute top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow"
              style={{ left: `${pct}%` }}
            />
          </div>
        </div>
        {hasCaptions && (
          <ClipCaptionsToggle
            on={captions.on}
            onToggle={captions.toggle}
            className="flex h-11 w-11 items-center justify-center hover:bg-transparent active:bg-zinc-50/10"
          />
        )}
        <ClipSpeedControl
          rate={rate}
          onChange={setRate}
          className="flex h-11 min-w-[2.75rem] items-center justify-center text-[12px] hover:bg-transparent active:bg-zinc-50/10"
        />
        <button
          type="button"
          onClick={goFs}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-zinc-50 active:bg-zinc-50/10"
          aria-label="Full screen"
        >
          <Maximize className="h-5 w-5" />
        </button>
      </div>
    </div>
  );
}

function ChapterStrip({
  chapters,
  playhead,
  seek,
}: {
  chapters: ClipChapter[];
  playhead: number;
  seek: (t: number) => void;
}) {
  const activeI = chapters.reduce(
    (acc, ch, i) => (playhead >= ch.t ? i : acc),
    0,
  );
  const activeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    activeRef.current?.scrollIntoView({
      inline: "center",
      block: "nearest",
      behavior: "smooth",
    });
  }, [activeI]);

  return (
    <div className="shrink-0 border-b border-border bg-background">
      <div className="flex snap-x snap-mandatory gap-2 overflow-x-auto px-3 py-2.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {chapters.map((ch, i) => {
          const on = i === activeI;
          return (
            <button
              key={`${ch.t}-${ch.title}`}
              ref={on ? activeRef : undefined}
              type="button"
              aria-current={on ? "true" : undefined}
              onClick={() => seek(ch.t)}
              className={`snap-start touch-manipulation whitespace-nowrap rounded-full px-3 py-2 text-left ${
                on
                  ? "bg-violet-600 text-white"
                  : "bg-muted text-foreground active:bg-accent"
              }`}
            >
              <span className="font-mono text-[10px] tabular-nums opacity-80">
                {fmtMmSs(ch.t)}
              </span>
              <span className="ml-1.5 text-[13px] font-medium">{ch.title}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function MobileActions({
  clipId,
  block,
  seek,
}: {
  clipId: string;
  block: ClipBlock;
  seek: (t: number) => void;
}) {
  const checks = useLocalChecks(
    clipId,
    `${block.kind}:${block.items?.[0]?.text ?? ""}`,
  );
  if (!block.items?.length) return null;
  return (
    <ul className="flex flex-col">
      {block.items.map((it, i) => (
        <li key={`${it.text}-${i}`} className="border-b border-border/60">
          <label className="flex min-h-12 cursor-pointer items-start gap-3 px-1 py-3">
            <input
              type="checkbox"
              checked={checks.done.has(i)}
              onChange={() => checks.toggle(i)}
              className="mt-1 h-5 w-5 shrink-0 rounded border-border bg-background text-violet-500"
            />
            <span
              className={`min-w-0 flex-1 text-[15px] leading-6 ${
                checks.done.has(i)
                  ? "text-muted-foreground line-through"
                  : "text-foreground"
              }`}
            >
              {it.text}
            </span>
            {typeof it.t === "number" && (
              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault();
                  seek(it.t!);
                }}
                className="mt-0.5 shrink-0 font-mono text-[12px] text-violet-400"
              >
                {fmtMmSs(it.t)}
              </button>
            )}
          </label>
        </li>
      ))}
    </ul>
  );
}

function MobileBlock({
  clipId,
  block,
  seek,
}: {
  clipId: string;
  block: ClipBlock;
  seek: (t: number) => void;
}) {
  if (block.kind === "summary" && block.text) {
    return (
      <p className="text-[15px] leading-7 text-foreground">{block.text}</p>
    );
  }
  if (block.kind === "actions") {
    return <MobileActions clipId={clipId} block={block} seek={seek} />;
  }
  if (!block.items?.length) return null;
  return (
    <ul className="flex flex-col gap-4">
      {block.items.map((it, i) => (
        <li key={`${it.text}-${i}`} className="flex gap-3">
          {block.kind === "quotes" ? (
            <span className="mt-0.5 text-lg text-violet-500/80">“</span>
          ) : (
            <span className="mt-1 w-5 shrink-0 font-mono text-[11px] text-muted-foreground">
              {i + 1}
            </span>
          )}
          {typeof it.t === "number" ? (
            <button
              type="button"
              onClick={() => seek(it.t!)}
              className="text-left text-[15px] leading-7 text-foreground active:text-foreground"
            >
              {it.text}
              <span className="ml-2 font-mono text-[11px] text-violet-400">
                {fmtMmSs(it.t)}
              </span>
            </button>
          ) : (
            <span className="text-[15px] leading-7 text-foreground">{it.text}</span>
          )}
        </li>
      ))}
    </ul>
  );
}

export function MobileClipView({
  session,
  owns,
  canClean,
  onChange,
  onClose,
  closeLabel = "All recordings",
  onDeleted,
  start,
  end,
}: {
  session: ClipSession;
  owns: boolean;
  canClean?: boolean;
  onChange: (s: ClipSession) => void;
  onClose: () => void;
  closeLabel?: string;
  onDeleted: () => void;
  start?: number;
  end?: number;
}) {
  const seekRef = useRef<(t: number) => void>(() => {});
  const [words, setWords] = useState<ClipWord[]>([]);
  const [cleaned, setCleaned] = useState(false);
  const [playhead, setPlayhead] = useState(0);
  const [copied, setCopied] = useState(false);
  const [menu, setMenu] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState("");

  const chapters = clipChapters(session);
  const chaptersPending = useAutoChapters(session, owns, onChange);
  const blocks = displayBlocks(session);
  const tabs = [
    ...blocks.map((b) => ({
      id: b.kind,
      label: CLIP_BLOCK_CATALOG.find((c) => c.kind === b.kind)?.label ?? b.kind,
    })),
    ...(words.length ? [{ id: "transcript", label: "Transcript" }] : []),
  ];
  const [tab, setTab] = useState<string | null>(null);
  const activeTab =
    tab && tabs.some((t) => t.id === tab)
      ? tab
      : (tabs.find((t) => t.id === "actions")?.id ?? tabs[0]?.id ?? null);

  useEffect(() => {
    if (!isProcessing(session) && !session.generating?.length) return;
    const t = setInterval(async () => {
      const next = await getClip(session.id).catch(() => null);
      if (next) onChange(next);
    }, 400);
    return () => clearInterval(t);
  }, [session.id, session.status, session.generating, onChange]);

  useEffect(() => {
    if (!session.hasTranscript) {
      setWords([]);
      return;
    }
    getClipTranscript(session.id)
      .then((d) => {
        setWords(d.words);
        setCleaned(!!d.cleaned);
      })
      .catch(() => {
        setWords([]);
        setCleaned(false);
      });
  }, [session.id, session.hasTranscript]);

  useEffect(() => {
    setRenaming(false);
  }, [session.id]);

  const seek = (t: number) => seekRef.current(t);

  const startRename = () => {
    setMenu(false);
    setDraft(session.name);
    setRenaming(true);
  };

  const commitRename = (raw: string) => {
    const name = raw.trim().slice(0, 120);
    setRenaming(false);
    if (!owns || !name || name === session.name) return;
    void renameClip(session.id, name)
      .then(onChange)
      .catch(() => {});
  };

  const share = async () => {
    const url = `${window.location.origin}/clips/${session.id}`;
    if (navigator.share) {
      try {
        await navigator.share({ title: session.name, url });
        return;
      } catch (e) {
        if (e instanceof Error && e.name === "AbortError") return;
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* ignore */
    }
  };

  const retry = async () => {
    setError(null);
    setBusy(true);
    try {
      onChange(await retryClip(session.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const runCleanup = async (restore: boolean) => {
    setError(null);
    setBusy(true);
    setMenu(false);
    try {
      const d = restore
        ? await restoreClipTranscript(session.id)
        : await cleanupClipTranscript(session.id);
      setWords(d.words);
      setCleaned(!!d.cleaned);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (
      !window.confirm(`Delete “${session.name}”?\n\nThis cannot be undone.`)
    ) {
      return;
    }
    setMenu(false);
    await deleteClip(session.id).catch(() => {});
    onDeleted();
  };

  const pct = Math.round(Math.max(0, Math.min(1, session.progress)) * 100);
  const stepLabel =
    STEPS.find((s) => s.id === session.step)?.label ?? "Processing this clip";

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-background text-foreground">
      <ClipAgentDiscovery
        clipId={session.id}
        title={session.name}
        status={session.status}
      />
      <header className="pt-safe shrink-0 border-b border-border bg-background">
        <div className="flex h-12 items-center gap-1 px-1">
          {owns || closeLabel !== "All recordings" ? (
            <button
              type="button"
              onClick={onClose}
              className="flex h-11 w-11 items-center justify-center rounded-lg text-foreground active:bg-accent"
              aria-label={closeLabel}
            >
              <ChevronLeft className="h-6 w-6" />
            </button>
          ) : (
            <span className="w-2" />
          )}
          {owns && renaming ? (
            <input
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onFocus={(e) => e.currentTarget.select()}
              onBlur={(e) => commitRename(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
                else if (e.key === "Escape") {
                  e.currentTarget.value = session.name;
                  e.currentTarget.blur();
                }
              }}
              maxLength={120}
              aria-label="Clip name"
              className="min-w-0 flex-1 rounded-md border border-violet-500 bg-background px-2 py-1 text-[15px] font-semibold text-foreground outline-none"
            />
          ) : (
            <h1 className="min-w-0 flex-1 truncate text-[15px] font-semibold">
              {session.name}
            </h1>
          )}
          <ShareThemeSwitch compact />
          <button
            type="button"
            onClick={() => void share()}
            className="flex h-11 w-11 items-center justify-center rounded-lg text-foreground active:bg-accent"
            aria-label="Share"
          >
            {copied ? (
              <Check className="h-5 w-5 text-emerald-400" />
            ) : (
              <Share2 className="h-5 w-5" />
            )}
          </button>
          {owns && (
            <button
              type="button"
              onClick={() => setMenu(true)}
              className="flex h-11 w-11 items-center justify-center rounded-lg text-foreground active:bg-accent"
              aria-label="More"
            >
              <MoreHorizontal className="h-5 w-5" />
            </button>
          )}
        </div>
      </header>

      {isProcessing(session) ? (
        <div className="flex flex-1 flex-col items-center justify-center px-8">
          <Loader2 className="h-8 w-8 animate-spin text-violet-400" />
          <p className="mt-4 text-sm font-medium">{stepLabel}</p>
          <p className="mt-1 font-mono text-xs tabular-nums text-muted-foreground">
            {pct}%
          </p>
          <div className="mt-4 h-1.5 w-full max-w-xs overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-violet-500"
              style={{ width: `${Math.max(4, pct)}%` }}
            />
          </div>
        </div>
      ) : (
        <>
          <MobilePlayer
            src={playClipUrl(session.id)}
            poster={session.hasThumb ? thumbClipUrl(session.id) : undefined}
            duration={session.duration}
            onTime={setPlayhead}
            seekRef={seekRef}
            words={words}
            start={start}
            end={end}
          />
          {chapters.length > 0 ? (
            <ChapterStrip
              chapters={chapters}
              playhead={playhead}
              seek={seek}
            />
          ) : chaptersPending ? (
            <div className="flex shrink-0 items-center gap-2 border-b border-border bg-background px-4 py-2.5 text-[13px] text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Generating chapters…
            </div>
          ) : null}

          {session.status === "error" && (
            <div className="flex items-start gap-3 border-b border-red-500/30 bg-red-500/10 px-4 py-3 text-[13px] text-red-700 dark:text-red-300">
              <span className="min-w-0 flex-1">
                {session.error || "Processing failed"}
              </span>
              {owns && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void retry()}
                  className="shrink-0 font-medium text-red-800 dark:text-red-100"
                >
                  Try again
                </button>
              )}
            </div>
          )}
          {error && (
            <p className="px-4 py-2 text-[12px] text-red-400">{error}</p>
          )}

          {tabs.length > 1 && (
            <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-border px-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {tabs.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setTab(t.id)}
                  className={`touch-manipulation whitespace-nowrap px-3 py-3 text-[13px] font-medium ${
                    activeTab === t.id
                      ? "border-b-2 border-violet-500 text-foreground"
                      : "text-muted-foreground"
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>
          )}

          <div className="min-h-0 flex-1 overflow-y-auto px-4 pt-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
            {activeTab === "transcript" ? (
              <div className="flex flex-col gap-5">
                {owns && canClean ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void runCleanup(cleaned)}
                    className="flex h-10 w-fit items-center gap-2 rounded-lg border border-border px-3 text-[13px] text-foreground active:bg-accent disabled:opacity-40"
                  >
                    {busy ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Wand2 className="h-4 w-4" />
                    )}
                    {cleaned ? "Restore original" : "Clean up transcript"}
                  </button>
                ) : null}
                {transcriptParagraphs(words, chapters).map((para, pi) => (
                  <p key={pi} className="text-[15px] leading-7 text-foreground">
                    {para.map((w, i) => {
                      const on = playhead >= w.start && playhead < w.end;
                      return (
                        <Fragment key={`${w.start}-${i}`}>
                          {i > 0 ? " " : null}
                          <button
                            type="button"
                            onClick={() => seek(w.start)}
                            className={`rounded-sm ${
                              on ? "bg-violet-500/30 text-zinc-50" : ""
                            }`}
                          >
                            {w.text}
                          </button>
                        </Fragment>
                      );
                    })}
                  </p>
                ))}
              </div>
            ) : activeTab ? (
              (() => {
                const block = blocks.find((b) => b.kind === activeTab);
                return block ? (
                  <MobileBlock
                    clipId={session.id}
                    block={block}
                    seek={seek}
                  />
                ) : null;
              })()
            ) : (
              <p className="text-sm text-muted-foreground">
                Play the video — chapters and notes appear here when they are
                ready.
              </p>
            )}
          </div>
        </>
      )}

      {menu && (
        <>
          <button
            type="button"
            className="fixed inset-0 z-40 bg-black/55"
            aria-label="Close menu"
            onClick={() => setMenu(false)}
          />
          <div className="pb-safe fixed inset-x-0 bottom-0 z-50 rounded-t-2xl border-t border-border bg-card px-2 pb-2 pt-1">
            <div className="mx-auto mb-2 mt-1 h-1 w-10 rounded-full bg-muted-foreground/40" />
            <button
              type="button"
              onClick={startRename}
              className="flex h-12 w-full items-center gap-3 rounded-xl px-3 text-[15px] text-foreground active:bg-accent"
            >
              <Pencil className="h-5 w-5 text-muted-foreground" />
              Rename
            </button>
            <button
              type="button"
              onClick={() => {
                setMenu(false);
                downloadClip(session);
              }}
              className="flex h-12 w-full items-center gap-3 rounded-xl px-3 text-[15px] text-foreground active:bg-accent"
            >
              <Download className="h-5 w-5 text-muted-foreground" />
              Download
            </button>
            {owns && canClean && words.length > 0 ? (
              <button
                type="button"
                onClick={() => void runCleanup(cleaned)}
                className="flex h-12 w-full items-center gap-3 rounded-xl px-3 text-[15px] text-foreground active:bg-accent"
              >
                <Wand2 className="h-5 w-5 text-muted-foreground" />
                {cleaned ? "Restore original transcript" : "Clean up transcript"}
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => void remove()}
              className="flex h-12 w-full items-center gap-3 rounded-xl px-3 text-[15px] text-red-500 active:bg-accent"
            >
              <Trash2 className="h-5 w-5" />
              Delete clip
            </button>
            <button
              type="button"
              onClick={() => setMenu(false)}
              className="flex h-12 w-full items-center gap-3 rounded-xl px-3 text-[15px] text-muted-foreground active:bg-accent"
            >
              <X className="h-5 w-5" />
              Cancel
            </button>
          </div>
        </>
      )}
    </div>
  );
}

export function MobileClipSplash({
  message,
}: {
  message: string;
}) {
  return (
    <div className="flex h-dvh flex-col items-center justify-center bg-background px-8 text-muted-foreground">
      <Loader2 className="h-6 w-6 animate-spin text-violet-400" />
      <p className="mt-3 text-sm">{message}</p>
    </div>
  );
}
