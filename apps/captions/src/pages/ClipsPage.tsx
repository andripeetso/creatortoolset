import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router";
import {
  ArrowLeft,
  Check,
  Download,
  Loader2,
  Pause,
  Pencil,
  Play,
  RotateCcw,
  Share2,
  Square,
  Trash2,
  Video,
  Wand2,
  Circle,
} from "lucide-react";
import { canRecordScreen, openRecorder } from "@/lib/mac-record";
import { useAuth } from "@/lib/auth";
import { putCached, useCachedList, useCachedLoad } from "@/lib/local-cache";
import { useSteadyList } from "@/lib/steady-list";
import { Picture } from "@/components/Picture";
import { fmtBytes, timeAgo } from "@/lib/exports";
import { toolsetHomePath } from "@/lib/mobile";
import { useClipsRecorder } from "@/hooks/use-clips-recorder";
import {
  clipChapters,
  deleteClip,
  downloadClip,
  renameClip,
  getClip,
  getClipTranscript,
  cleanupClipTranscript,
  restoreClipTranscript,
  isProcessing,
  listClips,
  retryClip,
  retryClipBlock,
  transcriptParagraphs,
  uploadClip,
  playClipUrl,
  thumbClipUrl,
  type ClipSession,
  type ClipWord,
  useClipsAvailability,
} from "@/lib/clips";
import { ClipAgentDiscovery } from "@/components/ClipAgentDiscovery";
import { ClipPlayer, type ClipPlayerHandle } from "@/components/ClipPlayer";
import {
  ChapterRail,
  ClipBlocks,
  useChapters,
} from "@/components/ClipBlocks";
import { AppBar, ToolIntro } from "@/components/AppBar";
import { DropZoneText, dropZoneClass } from "@/components/DropZone";
import { DesktopHint } from "@/components/mobile/DesktopHint";
import { isPublicSharePath } from "@/components/AuthGate";
import { ShareThemeSwitch } from "@/components/ShareTheme";
import { usePhoneClipLayout } from "@/lib/phone-layout";
import { parseClipRangeParams } from "@/lib/clip-playback";
import {
  MobileClipSplash,
  MobileClipView,
} from "@/pages/mobile/MobileClipView";
import { confirmDialog } from "@/lib/dialogs";
import { BrowseBar } from "@/components/browse/Bar";
import { FolderGrid, ItemCard } from "@/components/browse/Grid";
import { askRename } from "@/components/browse/browse";
import { byName, matches, persistSort, storedSort, useBrowseView } from "@/components/browse/views";

function fmtMmSs(t: number): string {
  const m = Math.floor(Math.max(0, t) / 60);
  const s = Math.floor(Math.max(0, t) % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

const PROCESS_STEPS = [
  { id: "thumbnail", label: "Grabbing a thumbnail" },
  { id: "audio", label: "Extracting audio" },
  { id: "transcribe", label: "Transcribing speech" },
  { id: "title", label: "Titling and summarizing" },
] as const;

type ProcessStep = (typeof PROCESS_STEPS)[number]["id"];

function stepIndex(step: ProcessStep | undefined): number {
  if (!step) return -1;
  return PROCESS_STEPS.findIndex((s) => s.id === step);
}

function ProcessPanel({ session }: { session: ClipSession }) {
  const at = stepIndex(session.step);
  const pct = Math.round(Math.max(0, Math.min(1, session.progress)) * 100);
  return (
    <div className="rounded-xl border border-border bg-card px-5 py-6">
      <div className="mb-4 flex items-center justify-between gap-3">
        <p className="flex items-center gap-2 text-sm font-medium text-foreground">
          <Loader2 className="h-4 w-4 animate-spin text-violet-400" />
          Processing this clip
        </p>
        <span className="text-sm tabular-nums text-muted-foreground">{pct}%</span>
      </div>
      <div className="mb-5 h-2 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-violet-500 transition-[width] duration-500"
          style={{ width: `${Math.max(4, pct)}%` }}
        />
      </div>
      <ol className="flex flex-col gap-2.5">
        {PROCESS_STEPS.map((s, i) => {
          const done = at > i || session.progress >= 1;
          const active = at === i;
          return (
            <li key={s.id} className="flex items-center gap-2.5 text-sm">
              {done ? (
                <Check className="h-4 w-4 text-emerald-400" />
              ) : active ? (
                <Loader2 className="h-4 w-4 animate-spin text-violet-400" />
              ) : (
                <span className="h-4 w-4 rounded-full border border-border" />
              )}
              <span
                className={
                  done
                    ? "text-muted-foreground"
                    : active
                      ? "text-foreground"
                      : "text-muted-foreground/60"
                }
              >
                {(active && s.id === "transcribe" && session.note) || s.label}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

const NOTES_SORTS = ["recent", "name"] as const;
const NOTES_SORT_KEY = "notes:sort";

const label =
  "mb-2 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground";

function LiveVideo({ stream }: { stream: MediaStream | null }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.srcObject = stream;
    if (stream) void el.play().catch(() => {});
  }, [stream]);
  return (
    <video
      ref={ref}
      muted
      playsInline
      className="h-full w-full bg-black object-contain"
    />
  );
}

function documentReturnTo(state: unknown): string | null {
  const from =
    state && typeof state === "object" && "from" in state
      ? (state as { from: unknown }).from
      : null;
  return typeof from === "string" && from.startsWith("/documents/")
    ? from
    : null;
}

function ClipView({
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
  const playerRef = useRef<ClipPlayerHandle>(null);
  const [words, setWords] = useState<ClipWord[]>([]);
  const [cleaned, setCleaned] = useState(false);
  const [cleanBusy, setCleanBusy] = useState(false);
  const [playhead, setPlayhead] = useState(0);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [theater, setTheater] = useState(false);
  const [chapterBusy, setChapterBusy] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState("");

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
    setTheater(false);
    setRenaming(false);
  }, [session.id]);

  useEffect(() => {
    if (!theater) return;
    const t = window.setTimeout(() => window.scrollTo({ top: 0 }), 0);
    return () => window.clearTimeout(t);
  }, [theater]);

  const making = useChapters(session, owns, onChange);

  const retry = async () => {
    setError(null);
    try {
      onChange(await retryClip(session.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const retryChapters = async () => {
    setError(null);
    setChapterBusy(true);
    try {
      onChange(await retryClipBlock(session.id, "chapters"));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setChapterBusy(false);
    }
  };

  const runCleanup = async (restore: boolean) => {
    setError(null);
    setCleanBusy(true);
    try {
      const d = restore
        ? await restoreClipTranscript(session.id)
        : await cleanupClipTranscript(session.id);
      setWords(d.words);
      setCleaned(!!d.cleaned);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCleanBusy(false);
    }
  };

  const remove = async () => {
    if (
!(await confirmDialog({ title: `Delete “${session.name}”?`, body: "This cannot be undone.", ok: "Delete", danger: true }))
    ) {
      return;
    }
    await deleteClip(session.id).catch(() => {});
    onDeleted();
  };

  const seek = (t: number) => playerRef.current?.seek(t);
  const chapters = clipChapters(session);
  const cinema = theater && !isProcessing(session);
  // the rail stays when the request ended with none (it says why): the page around it does not move
  const showChapters = chapters.length > 0 || making.pending || !!making.failed;
  const col = "mx-auto w-[1080px] max-w-[96vw]";

  const copyLink = async () => {
    const url = `${window.location.origin}/clips/${session.id}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* ignore */
    }
  };

  const startRename = () => {
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

  const header = (
    <>
      {owns || closeLabel !== "All recordings" ? (
        <button
          onClick={onClose}
          className="mb-3 flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> {closeLabel}
        </button>
      ) : null}

      <div className="mb-4 flex items-center gap-3 rounded-lg border border-border bg-card px-3 py-2.5">
        <Video className="h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
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
              className="w-full rounded-md border border-violet-500 bg-background px-1.5 py-0.5 text-sm text-foreground outline-none"
            />
          ) : (
            <div className="flex min-w-0 items-center gap-1">
              <p
                className="min-w-0 truncate text-sm text-foreground"
                title={owns ? `${session.name} — double-click to rename` : session.name}
                onDoubleClick={owns ? startRename : undefined}
              >
                {session.name}
              </p>
              {owns && (
                <button
                  type="button"
                  onClick={startRename}
                  title="Rename"
                  className="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  <Pencil className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          )}
          <p className="text-[11px] text-muted-foreground">
            {session.duration > 0 && <>{fmtMmSs(session.duration)} · </>}
            {fmtBytes(session.bytes)}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void copyLink()}
          className="flex shrink-0 items-center gap-1.5 rounded-md bg-violet-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-violet-500"
        >
          {copied ? (
            <Check className="h-3.5 w-3.5" />
          ) : (
            <Share2 className="h-3.5 w-3.5" />
          )}
          {copied ? "Copied" : "Share"}
        </button>
        {owns && (
          <>
            <button
              onClick={() => downloadClip(session)}
              title="Download"
              className="rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <Download className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={remove}
              title="Delete this clip"
              className="rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-red-400"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </>
        )}
      </div>
    </>
  );

  return (
    <div className="w-full">
      <ClipAgentDiscovery
        clipId={session.id}
        title={session.name}
        status={session.status}
      />
      {!cinema && <div className={col}>{header}</div>}

      <div className={cinema ? "w-full" : col}>
        {isProcessing(session) ? (
          <ProcessPanel session={session} />
        ) : (
          <div
            className={
              cinema
                ? undefined
                : showChapters
                  ? "flex flex-col gap-3 lg:grid lg:grid-cols-[minmax(0,1fr)_17.5rem] lg:items-stretch"
                  : undefined
            }
          >
            <ClipPlayer
              src={playClipUrl(session.id)}
              poster={session.hasThumb ? thumbClipUrl(session.id) : undefined}
              duration={session.duration}
              playerRef={playerRef}
              onTime={setPlayhead}
              words={words}
              theater={theater}
              onTheaterChange={setTheater}
              start={start}
              end={end}
            />
            {!cinema && showChapters && (
              <ChapterRail
                chapters={chapters}
                playhead={playhead}
                seek={seek}
                pending={making.pending}
                failed={making.failed}
                onRetry={owns ? retryChapters : undefined}
                retrying={chapterBusy}
              />
            )}
          </div>
        )}
      </div>

      <div className={col}>
        {cinema ? <div className="mt-4">{header}</div> : null}
        {cinema && showChapters && (
          <div className="mb-1 mt-3">
            <ChapterRail
              chapters={chapters}
              playhead={playhead}
              seek={seek}
              pending={making.pending}
              failed={making.failed}
              onRetry={owns ? retryChapters : undefined}
              retrying={chapterBusy}
            />
          </div>
        )}

        {session.status === "error" && (
          <div className="mt-4 flex items-center justify-between gap-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2.5">
            <span className="min-w-0 text-xs text-red-600 dark:text-red-300">
              {session.error || "Processing failed"}
            </span>
            {owns && (
              <button
                onClick={retry}
                className="flex shrink-0 items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs text-foreground hover:bg-accent"
              >
                <RotateCcw className="h-3 w-3" /> Try again
              </button>
            )}
          </div>
        )}
        {error && <p className="mb-3 text-[11px] text-red-400">{error}</p>}

        {!isProcessing(session) && (
          <ClipBlocks
            session={session}
            owns={owns}
            seek={seek}
            hasTranscript={words.length > 0 || session.hasTranscript}
            onChange={onChange}
          />
        )}

        {words.length > 0 && (
          <div
            id="clip-transcript"
            className="mt-4 scroll-mt-4 rounded-xl border border-border bg-card px-4 py-3.5"
          >
            <h2 className={`${label} justify-between`}>
              Transcript
              {owns && canClean ? (
                <button
                  type="button"
                  disabled={cleanBusy}
                  onClick={() => void runCleanup(cleaned)}
                  className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium normal-case tracking-normal text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
                >
                  {cleanBusy ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Wand2 className="h-3 w-3" />
                  )}
                  {cleaned ? "Restore original" : "Clean up"}
                </button>
              ) : null}
            </h2>
            <div className="flex flex-col gap-4">
              {transcriptParagraphs(words, chapters).map((para, pi) => (
                <p key={pi} className="text-sm leading-relaxed text-foreground">
                  {para.map((w, i) => {
                    const active = playhead >= w.start && playhead < w.end;
                    return (
                      <Fragment key={`${w.start}-${i}`}>
                        {i > 0 ? " " : null}
                        <button
                          type="button"
                          onClick={() => seek(w.start)}
                          className={`rounded-sm px-px hover:bg-violet-500/20 hover:text-zinc-50 ${
                            active ? "bg-violet-500/30 text-zinc-50" : ""
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
          </div>
        )}
      </div>
    </div>
  );
}

export default function ClipsPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { clipId } = useParams<{ clipId?: string }>();
  const me = useAuth((s) => s.me);
  const required = useAuth((s) => s.required);
  const home = toolsetHomePath();
  const rec = useClipsRecorder();
  const phone = usePhoneClipLayout();
  const backTo = documentReturnTo(location.state);
  const closeLabel = backTo ? "Back to document" : "All recordings";
  const range = parseClipRangeParams(location.search);
  const [drag, setDrag] = useState(false);
  const [uploadPct, setUploadPct] = useState<number | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  // the saved list shows at once and refreshes underneath (lib/local-cache)
  const { items: sessions, setItems: setSessions, refresh: loadSessions } = useCachedList("/api/clips", listClips);
  // on screen: a list scrolled down keeps its rows where they are, and a new recording waits at its top (lib/steady-list)
  const clipsBox = useRef<HTMLDivElement>(null);
  const [view, setView] = useBrowseView("notes");
  const [find, setFind] = useState("");
  const [sort, setSort] = useState(() => storedSort(NOTES_SORT_KEY, NOTES_SORTS));
  // the server sends them newest first; a search or another sort is another list
  const listed = sessions.filter((s) => matches(find, s.name)).sort((a, b) => (sort === "name" ? byName(a, b) : 0));
  const shownClips = useSteadyList(listed, clipsBox, { scope: `${find.trim()}|${sort}|${view}` });
  // the open clip: its saved copy (or its row in the list) paints at once; processing and new blocks arrive as change
  // notices (lib/local-cache)
  const detail = useCachedLoad<ClipSession>(clipId ? `/api/clips/${clipId}` : null, () => getClip(clipId!));
  const current = clipId ? (detail.data ?? sessions.find((x) => x.id === clipId) ?? null) : null;
  const opening = !!clipId && !current && !detail.error;
  const pageError = uploadError || (clipId && !current ? detail.error : "") || null;
  const setDetail = detail.set;
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const avail = useClipsAvailability().data;

  const refreshList = useCallback(() => {
    loadSessions().catch(() => {});
  }, [loadSessions]);

  const applyClip = useCallback((s: ClipSession) => {
    setDetail((prev) => (prev && (prev.id !== s.id || s.updatedAt < prev.updatedAt) ? prev : s));
    setSessions((list) =>
      list.map((x) => {
        if (x.id !== s.id) return x;
        return s.updatedAt >= x.updatedAt ? s : x;
      }),
    );
  }, [setDetail, setSessions]);

  const uploadingRef = useRef(false);
  const saveBlob = async (blob: Blob, name: string, mime: string) => {
    if (uploadingRef.current) return;
    uploadingRef.current = true;
    setUploadError(null);
    setUploadPct(0);
    try {
      const s = await uploadClip(blob, name, mime, setUploadPct);
      rec.discard();
      putCached(me?.username, `/api/clips/${s.id}`, s);
      navigate(`/clips/${s.id}`);
      refreshList();
    } catch (e) {
      setUploadError(e instanceof Error ? e.message : String(e));
    } finally {
      uploadingRef.current = false;
      setUploadPct(null);
    }
  };

  const uploadFile = async (f: File) => {
    await saveBlob(
      f,
      f.name.replace(/\.[^.]+$/, "") || "Untitled recording",
      f.type || "video/webm",
    );
  };

  const savePreview = async () => {
    if (!rec.preview) return;
    const name = `Recording ${new Date().toLocaleString([], {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    })}`;
    await saveBlob(rec.preview.blob, name, rec.preview.mime);
  };

  const recording = rec.phase !== "idle" && rec.phase !== "preview";
  const showLibrary = !clipId && rec.phase === "idle";
  // a clip renamed or deleted from its row or its card: the list changes at once, a refused rename goes back
  const renameTo = (s: ClipSession, name: string) => {
    setSessions((list) => list.map((x) => (x.id === s.id ? { ...x, name } : x)));
    void renameClip(s.id, name).catch(() => setSessions((list) => list.map((x) => (x.id === s.id ? { ...x, name: s.name } : x))));
  };
  const removeClip = async (s: ClipSession) => {
    if (!(await confirmDialog({ title: `Delete “${s.name}”?`, body: "This cannot be undone.", ok: "Delete", danger: true }))) return;
    void deleteClip(s.id).then(() => setSessions((list) => list.filter((x) => x.id !== s.id)));
  };
  const ownsCurrent =
    !!me &&
    !!current &&
    (me.role === "admin" || me.username === current.owner);

  if (phone && clipId) {
    if (current) {
      return (
        <MobileClipView
          session={current}
          owns={ownsCurrent}
          canClean={!!avail?.ai}
          onChange={applyClip}
          onClose={() => {
            navigate(backTo || "/clips");
            refreshList();
          }}
          closeLabel={closeLabel}
          onDeleted={() => {
            setSessions((list) => list.filter((x) => x.id !== current.id));
            navigate(backTo || "/clips");
          }}
          start={range.start}
          end={range.end}
        />
      );
    }
    return (
      <MobileClipSplash
        message={
          opening
            ? "Opening clip…"
            : pageError || "This clip could not be opened."
        }
      />
    );
  }

  return (
    <div className="relative flex min-h-screen flex-col items-center bg-background pb-10 text-foreground [--bar-bg:hsl(var(--background))]">
      <AppBar tool="Video Notes" to={clipId ? "/clips" : undefined} trail={current?.name} account={!!me} className="mb-6">
        {isPublicSharePath(location.pathname) ? <ShareThemeSwitch /> : null}
        {!me && required ? (
          <Link
            to={home}
            className="rounded-md px-2 py-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            Sign in
          </Link>
        ) : null}
      </AppBar>

      {!clipId && (
        <ToolIntro icon={Video} title="Video Notes" line="Every recording gets a transcript, a title, a summary, chapters and takeaways" />
      )}
      {!clipId && (
        <div className="mx-auto w-[960px] max-w-[92vw]">
        </div>
      )}

      {phone && !clipId ? (
        <div className="mb-5 w-[720px] max-w-[92vw]">
          <DesktopHint>
            Full Video Notes is on your desktop. You can still watch recordings here.
          </DesktopHint>
        </div>
      ) : null}

      <div
        className={current || clipId ? "w-full" : "w-[720px] max-w-[92vw]"}
      >
        {clipId && !current && !opening && backTo ? (
          <button
            type="button"
            onClick={() => navigate(backTo)}
            className="mb-3 flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="h-3.5 w-3.5" /> Back to document
          </button>
        ) : null}
        {opening ? (
          // the clip's final frame, empty: the player's own size, so the page doesn't move when it arrives
          <div aria-busy="true" aria-label="Opening clip" className="w-full">
            <div className="aspect-video w-full rounded-xl bg-muted" />
            <div className="mt-4 h-5 w-1/3 rounded bg-muted" />
          </div>
        ) : current ? (
          <>
            <ClipView
              session={current}
              owns={
                !!me &&
                (me.role === "admin" || me.username === current.owner)
              }
              canClean={!!avail?.ai}
              onChange={applyClip}
              onClose={() => {
                navigate(backTo || "/clips");
                refreshList();
              }}
              closeLabel={closeLabel}
              onDeleted={() => {
                setSessions((list) => list.filter((x) => x.id !== current.id));
                navigate(backTo || "/clips");
              }}
              start={range.start}
              end={range.end}
            />
          </>
        ) : rec.phase === "countdown" ? (
          <div className="flex flex-col items-center justify-center rounded-2xl border border-zinc-800 bg-zinc-950 py-24">
            <p className="text-7xl font-semibold tabular-nums text-white">
              {rec.count}
            </p>
            <button
              onClick={rec.discard}
              className="mt-8 text-xs text-zinc-500 hover:text-zinc-200"
            >
              Cancel
            </button>
          </div>
        ) : recording ? (
          <div className="overflow-hidden rounded-2xl border border-zinc-800 bg-black">
            <div className="relative aspect-video">
              <LiveVideo stream={rec.mixStream} />
              <div className="absolute left-3 top-3 flex items-center gap-2 rounded-full bg-black/60 px-2.5 py-1 text-xs">
                <span
                  className={`h-2 w-2 rounded-full ${
                    rec.phase === "paused"
                      ? "bg-amber-400"
                      : "bg-red-500 animate-pulse"
                  }`}
                />
                {fmtMmSs(rec.elapsed)}
                {rec.phase === "paused" && (
                  <span className="text-amber-300">Paused</span>
                )}
              </div>
            </div>
            <div className="flex items-center justify-center gap-3 bg-zinc-950 px-4 py-3">
              {rec.phase === "paused" ? (
                <button
                  onClick={rec.resume}
                  className="flex items-center gap-1.5 rounded-full bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-500"
                >
                  <Play className="h-4 w-4" /> Resume
                </button>
              ) : (
                <button
                  onClick={rec.pause}
                  className="flex items-center gap-1.5 rounded-full border border-zinc-700 px-4 py-2 text-sm text-zinc-200 hover:bg-zinc-800"
                >
                  <Pause className="h-4 w-4" /> Pause
                </button>
              )}
              <button
                onClick={rec.stop}
                className="flex items-center gap-1.5 rounded-full bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-500"
              >
                <Square className="h-3.5 w-3.5 fill-current" /> Stop
              </button>
            </div>
          </div>
        ) : rec.phase === "preview" && rec.preview ? (
          <div>
            <div className="overflow-hidden rounded-2xl border border-zinc-800 bg-black">
              <video
                src={rec.preview.url}
                controls
                className="aspect-video w-full"
              />
            </div>
            <div className="mt-4 flex items-center justify-center gap-2">
              <button
                onClick={rec.discard}
                className="rounded-md border border-zinc-700 px-3.5 py-2 text-sm text-zinc-200 hover:bg-zinc-800"
              >
                Discard
              </button>
              <button
                onClick={() => void savePreview()}
                disabled={uploadPct !== null}
                className="flex items-center gap-1.5 rounded-md bg-violet-600 px-3.5 py-2 text-sm font-medium text-white hover:bg-violet-500 disabled:opacity-50"
              >
                {uploadPct !== null ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    {uploadPct < 100
                      ? `Uploading… ${uploadPct}%`
                      : "Saving…"}
                  </>
                ) : (
                  "Save clip"
                )}
              </button>
            </div>
            {pageError && (
              <p className="mt-2 text-center text-xs text-red-400">
                {pageError}
              </p>
            )}
          </div>
        ) : (
          <>
            <label
              onDragOver={(e) => {
                e.preventDefault();
                if (uploadPct === null) setDrag(true);
              }}
              onDragLeave={() => setDrag(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDrag(false);
                if (uploadPct !== null) return;
                const f = e.dataTransfer.files?.[0];
                if (f) void uploadFile(f);
              }}
              aria-busy={uploadPct !== null}
              className={dropZoneClass(drag, uploadPct !== null ? "cursor-wait border-violet-500/50" : "cursor-pointer")}
            >
              {uploadPct !== null ? (
                <div className="w-full max-w-sm">
                  <p className="mb-2 flex items-center justify-center gap-2 text-sm font-medium text-violet-100">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    {uploadPct < 100
                      ? `Uploading… ${uploadPct}%`
                      : "Saving clip…"}
                  </p>
                  <div className="h-2 overflow-hidden rounded-full bg-zinc-800">
                    <div
                      className="h-full rounded-full bg-violet-500 transition-[width] duration-200"
                      style={{
                        width: `${Math.max(4, uploadPct)}%`,
                      }}
                    />
                  </div>
                </div>
              ) : (
                <DropZoneText title="Drop a video, or click to upload" hint="MP4 · MOV · M4V · MKV · WebM" />
              )}
              <input
                type="file"
                accept="video/*,.mkv,.mov,.mp4,.webm,.m4v"
                className="hidden"
                disabled={uploadPct !== null}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void uploadFile(f);
                  e.target.value = "";
                }}
              />
            </label>
            {canRecordScreen() && (
              <button
                onClick={openRecorder}
                className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl border border-zinc-800 py-3 text-sm text-zinc-200 hover:bg-zinc-900"
              >
                <Circle className="h-3.5 w-3.5 fill-red-500 text-red-500" /> Record your screen
              </button>
            )}
            {rec.error && (
              <p className="mt-2 text-xs text-red-400">{rec.error}</p>
            )}
            {pageError && (
              <p className="mt-2 text-xs text-red-400">{pageError}</p>
            )}

            {showLibrary && sessions.length > 0 && (
              <div className="mt-8">
                <h2 className={label}>Your clips</h2>
                <BrowseBar
                  search={{ value: find, onChange: setFind, placeholder: "Search clips (⌘K)" }}
                  sort={{
                    value: sort,
                    onChange: (v) => {
                      setSort(v);
                      persistSort(NOTES_SORT_KEY, v);
                    },
                    label: "Sort clips",
                    options: [
                      { id: "recent", label: "Recent" },
                      { id: "name", label: "Name" },
                    ],
                  }}
                  view={{ value: view, onChange: setView }}
                />
                {listed.length === 0 && <p className="py-10 text-center text-sm text-zinc-500">No matches.</p>}
                {view === "grid" ? (
                  <FolderGrid ref={clipsBox} size="column">
                    {shownClips.map((s) => (
                      <ItemCard
                        key={s.id}
                        to={`/clips/${s.id}`}
                        picture={s.hasThumb ? thumbClipUrl(s.id) : undefined}
                        icon={Video}
                        name={s.name}
                        meta={<>{timeAgo(s.createdAt)}{s.duration > 0 && <> · {fmtMmSs(s.duration)}</>}</>}
                        badge={
                          isProcessing(s) ? (
                            <span className="flex items-center gap-1 text-[11px] text-violet-300">
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              {Math.round(s.progress * 100)}%
                            </span>
                          ) : null
                        }
                        actions={
                          <>
                            <button type="button" title="Rename" aria-label={`Rename ${s.name}`} className="rounded p-1 hover:bg-white/20" onClick={() => void askRename("Rename clip", s.name).then((name) => name && renameTo(s, name))}>
                              <Pencil className="h-3.5 w-3.5" />
                            </button>
                            <button type="button" title="Delete" aria-label={`Delete ${s.name}`} className="rounded p-1 hover:bg-red-600" onClick={() => void removeClip(s)}>
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </>
                        }
                      />
                    ))}
                  </FolderGrid>
                ) : (
                <div ref={clipsBox} className="flex max-h-80 flex-col gap-1.5 overflow-y-auto pr-1">
                  {shownClips.map((s) => (
                    <div
                      key={s.id}
                      onClick={() => {
                        if (renaming !== s.id) navigate(`/clips/${s.id}`);
                      }}
                      className="group flex cursor-pointer items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-900/50 px-3 py-2.5 transition-colors hover:border-violet-500/50 hover:bg-zinc-900"
                    >
                      {s.hasThumb ? (
                        <div className="h-10 w-16 shrink-0 overflow-hidden rounded bg-muted">
                          <Picture src={thumbClipUrl(s.id)} alt="" className="h-full w-full object-cover" />
                        </div>
                      ) : (
                        <div className="flex h-10 w-16 shrink-0 items-center justify-center rounded bg-zinc-800">
                          <Video className="h-4 w-4 text-zinc-500" />
                        </div>
                      )}
                      <div className="min-w-0 flex-1">
                        {renaming === s.id ? (
                          <input
                            autoFocus
                            value={draft}
                            onChange={(e) => setDraft(e.target.value)}
                            onFocus={(e) => e.currentTarget.select()}
                            onClick={(e) => e.stopPropagation()}
                            onBlur={() => {
                              const name = draft.trim().slice(0, 120);
                              setRenaming(null);
                              if (!name || name === s.name) return;
                              renameTo(s, name);
                            }}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") e.currentTarget.blur();
                              else if (e.key === "Escape") setRenaming(null);
                            }}
                            maxLength={120}
                            className="w-full rounded-md border border-violet-500 bg-zinc-900 px-1.5 py-0.5 text-sm text-zinc-100 outline-none"
                          />
                        ) : (
                          <p className="truncate text-sm text-zinc-200">
                            {s.name}
                          </p>
                        )}
                        <p className="text-[11px] text-zinc-500">
                          {timeAgo(s.createdAt)}
                          {s.duration > 0 && <> · {fmtMmSs(s.duration)}</>}
                        </p>
                      </div>
                      {isProcessing(s) ? (
                        <span className="flex items-center gap-1 text-[11px] text-violet-300">
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          {Math.round(s.progress * 100)}%
                        </span>
                      ) : null}
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setDraft(s.name);
                          setRenaming(s.id);
                        }}
                        title="Rename"
                        className="rounded p-1.5 text-zinc-600 opacity-0 transition-opacity hover:bg-zinc-800 hover:text-zinc-200 group-hover:opacity-100"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          void removeClip(s);
                        }}
                        title="Delete"
                        className="rounded p-1.5 text-zinc-600 opacity-0 transition-opacity hover:bg-zinc-800 hover:text-red-400 group-hover:opacity-100"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
