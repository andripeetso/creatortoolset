import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  ExternalLink,
  Eye,
  Heart,
  Instagram,
  ScanSearch,
  Loader2,
  MessageCircle,
  MoreHorizontal,
  RefreshCw,
  RotateCcw,
  Search,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";
import { canUse, useAuth, useViewedMe } from "@/lib/auth";
import { isAdminForeignView } from "@/lib/admin-view";
import {
  AdminViewBanner,
  AdminViewBorder,
} from "@/components/AdminViewBanner";
import { fmtBytes, timeAgo } from "@/lib/exports";
import { toolsetHomePath } from "@/lib/mobile";
import {
  JOB_GROUPS,
  KIND_FILTERS,
  accountPathFor,
  isReferenceAccount,
  openPostLabel,
  postBadgeClass,
  postBadgeLabel,
  analyzerHome,
  deletePost,
  fmtAge,
  fmtAgeSince,
  fmtCount,
  fmtDate,
  fmtDelta,
  getInstagramAvailability,
  getPost,
  getPostSnapshots,
  getSlideTranscript,
  ingestPosts,
  addAccount,
  instagramUrlFromText,
  isProcessing,
  listAccounts,
  runAccountJobs,
  listPosts,
  listStacks,
  listSimilar,
  findPosts,
  accountCatalogReady,
  generateIdeaBoard,
  getIdeaBoard,
  type FindHit,
  type IdeaBoard,
  patchPostResearch,
  patchPostsResearch,
  patchStack,
  createStack,
  postToMarkdown,
  refreshCounts,
  retryPost,
  runPostJobs,
  groupError,
  groupStatus,
  savePostTags,
  thumbUrl,
  IDEA_STATUSES,
  KNOWHOW,
  SAVED_FOR,
  ideaStatusOf,
  postMatchesText,
  type IdeaStatus,
  type ListPostsQuery,
  type PostKind,
  type InstagramAccount,
  type InstagramAvailability,
  type InstagramComment,
  type InstagramPost,
  type InstagramStack,
  type Recipe,
  type RunWhen,
  type SavedFor,
  type SimilarHit,
  type Snapshot,
  type SnapshotDiff,
  type Tag,
  type TranscriptWord,
  type PostIdea,
  INSTAGRAM_CONNECTION_EVENT,
} from "@/lib/instagram";
import { AppBar } from "@/components/AppBar";
import { ProjectSwitcher } from "@/components/workspace/ProjectSwitcher";
import { useWorkspace } from "@/lib/workspace";
import { IngestBox } from "@/components/instagram/IngestBox";
import { RunJobsDialog } from "@/components/instagram/RunJobsDialog";
import { TagsEditor } from "@/components/instagram/TagsEditor";
import { IdeaStatusSelect, RankStars, SavedForToggle } from "@/components/instagram/IdeaMark";
import { IdeaCard } from "@/components/instagram/IdeaCard";
import { AccountCard, MyAccountSlot, Stat } from "@/components/instagram/AccountCard";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { PostCard, workshopUsesByPost } from "@/components/instagram/PostCard";
import { QueueMenu } from "@/components/instagram/QueueMenu";
import { ConfirmButton } from "@/components/instagram/ConfirmButton";
import { JobsDock } from "@/components/instagram/JobsDock";
import { SlidePanel } from "@/components/instagram/SlidePanel";
import { SlideViewer, type SeekRequest } from "@/components/instagram/SlideViewer";
import { CommentsList } from "@/components/instagram/CommentsList";
import { createSession, listSessions, patchProject, sessionPath, type SessionRow } from "@/lib/workshop";
import { ideaMatchesQuery, needsIdeaDistill } from "@/lib/instagram-ideas";
import { decayHeightLock, shrinkWouldClamp } from "@/lib/library-scroll";

const label =
  "mb-2 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-zinc-500";
const libraryEmptyClass =
  "sticky top-[var(--library-chrome-h,0px)] z-10 bg-[#0b0b10] py-6 text-center text-sm text-zinc-600";

type LibrarySort = "pulled" | "posted" | "plays" | "account" | "age" | "rank" | "virality";
type LibraryView = "feed" | "ideas" | "knowhow";

/** The library's top tabs: the same three "kept for" choices as sharing a post from the phone. */
const LIBRARY_TABS: { id: SavedFor | "knowhow"; label: string; hint: string }[] = [...SAVED_FOR, { id: "knowhow", ...KNOWHOW }];

const LIBRARY_SORTS: { id: LibrarySort; label: string }[] = [
  { id: "pulled", label: "recently added" },
  { id: "rank", label: "rating" },
  { id: "virality", label: "virality" },
  { id: "posted", label: "posted" },
  { id: "plays", label: "plays" },
  { id: "account", label: "account" },
  { id: "age", label: "age at pull" },
];

const chip = "rounded-md border px-2 py-1";
const chipIdle = `${chip} border-zinc-800 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200`;
const chipOn = `${chip} border-violet-500/50 bg-violet-600/20 text-violet-100`;
const STATUS_FILTERS: { id: IdeaStatus | ""; label: string }[] = [
  ...IDEA_STATUSES,
  { id: "", label: "All" },
];

function isInProject(
  post: { id: string; ideaStatus?: IdeaStatus },
  workshopByPost: Map<string, unknown>,
) {
  return workshopByPost.has(post.id) || ideaStatusOf(post.ideaStatus) === "idea";
}

function libraryEmptyCopy(opts: {
  q: string;
  tagFilter: string;
  accountFilter: string;
  savedForFilter: string;
  kindFilter: string;
  ideaFilter: IdeaStatus | "";
  knowhow: boolean;
}) {
  if (opts.knowhow) {
    return opts.q || opts.tagFilter || opts.accountFilter || opts.kindFilter
      ? "Nothing matches that search."
      : "Nothing in Know-how yet. Pick Know-how when you paste a link or share one from your phone.";
  }
  if (
    opts.q ||
    opts.tagFilter ||
    opts.accountFilter ||
    (opts.savedForFilter && opts.savedForFilter !== "content") ||
    opts.kindFilter
  ) {
    return "Nothing matches that search.";
  }
  if (opts.ideaFilter === "inbox") return "Inbox is empty.";
  if (opts.ideaFilter === "idea") return "Nothing in a project yet.";
  if (opts.ideaFilter === "done") return "Nothing marked done.";
  if (opts.ideaFilter === "skip") return "Nothing skipped.";
  return "No posts yet — paste links above.";
}

function PostView({
  post,
  owns,
  stacks,
  accountHref,
  siblings,
  onOpenPost,
  onChange,
  onClose,
  onDeleted,
  onFilterTag,
  inSession,
}: {
  post: InstagramPost;
  owns: boolean;
  /** A Workshop session uses it (In Project in the library). */
  inSession?: boolean;
  stacks: InstagramStack[];
  accountHref?: string;
  /** Ids of the list this post was opened from, for prev/next. */
  siblings?: string[];
  onOpenPost?: (id: string) => void;
  onChange: (p: InstagramPost) => void;
  onClose: () => void;
  onDeleted: () => void;
  onFilterTag?: (label: string) => void;
}) {
  const [index, setIndex] = useState(0);
  const [seek, setSeek] = useState<SeekRequest | null>(null);
  const [transcripts, setTranscripts] = useState<Record<number, TranscriptWord[]>>({});
  const [comments, setComments] = useState<InstagramComment[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState<"retry" | "refresh" | "jobs" | null>(null);
  const [pick, setPick] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [snap, setSnap] = useState<{
    snapshots: Snapshot[];
    vsFirst: SnapshotDiff | null;
    vsPrevious: SnapshotDiff | null;
  } | null>(null);
  const [lastDiff, setLastDiff] = useState<SnapshotDiff | null>(null);
  const [runOpen, setRunOpen] = useState(false);
  const [similar, setSimilar] = useState<SimilarHit[]>([]);
  const processing = isProcessing(post);
  const base = analyzerHome();
  const at = siblings ? siblings.indexOf(post.id) : -1;
  const prevId = siblings && at > 0 ? siblings[at - 1] : undefined;
  const nextId = siblings && at >= 0 && at < siblings.length - 1 ? siblings[at + 1] : undefined;

  useEffect(() => {
    setIndex(0);
    setSeek(null);
    setTranscripts({});
    setComments([]);
    setExpanded(false);
    setError(null);
    setSimilar([]);
    setPick(new Set());
  }, [post.id]);

  // Shift+arrows step through the list you came from; plain arrows do the
  // same when there is only one slide (otherwise they page the slides).
  const singleSlide = post.slides.length < 2;
  useEffect(() => {
    if (!onOpenPost || (!prevId && !nextId)) return;
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.metaKey || e.altKey || e.ctrlKey) return;
      if (!e.shiftKey && !singleSlide) return;
      if (e.key === "ArrowLeft" && prevId) {
        e.preventDefault();
        onOpenPost(prevId);
      } else if (e.key === "ArrowRight" && nextId) {
        e.preventDefault();
        onOpenPost(nextId);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onOpenPost, prevId, nextId, singleSlide]);

  useEffect(() => {
    let cancelled = false;
    getPostSnapshots(post.id)
      .then((d) => {
        if (!cancelled) setSnap(d);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [post.id, post.counts.fetchedAt]);

  useEffect(() => {
    let cancelled = false;
    listSimilar(post.id)
      .then((hits) => {
        if (!cancelled) setSimilar(hits);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [post.id]);

  useEffect(() => {
    if (!processing) return;
    const t = setInterval(async () => {
      const next = await getPost(post.id).catch(() => null);
      if (next) onChange(next);
    }, 400);
    return () => clearInterval(t);
  }, [post.id, processing, onChange]);

  const wanted = post.slides
    .filter((s) => s.transcript.status === "done")
    .map((s) => s.index)
    .join(",");
  useEffect(() => {
    if (!wanted) return;
    let cancelled = false;
    for (const raw of wanted.split(",")) {
      const i = Number(raw);
      if (Number.isNaN(i)) continue;
      setTranscripts((cur) => {
        if (cur[i]) return cur;
        getSlideTranscript(post.id, i)
          .then((d) => {
            if (!cancelled) setTranscripts((c) => ({ ...c, [i]: d.words }));
          })
          .catch(() => {});
        return cur;
      });
    }
    return () => {
      cancelled = true;
    };
  }, [post.id, wanted]);

  const retry = async (force: boolean) => {
    if (
      force &&
      !window.confirm(
        "Re-download the media and redo every transcript and slide text?",
      )
    ) {
      return;
    }
    setBusy("retry");
    setError(null);
    try {
      onChange(await retryPost(post.id, force));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const refresh = async () => {
    setBusy("refresh");
    setError(null);
    try {
      const next = await refreshCounts(post.id);
      setLastDiff(next.diff ?? null);
      onChange(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const runJobs = async (recipe: Recipe, opts: { force: boolean }) => {
    onChange(await runPostJobs(post.id, { recipe, force: opts.force }));
    setRunOpen(false);
  };

  const runGroups = async (ids: string[]) => {
    const types = JOB_GROUPS.filter((g) => ids.includes(g.id)).flatMap((g) => g.types);
    if (!types.length) return;
    setBusy("jobs");
    setError(null);
    try {
      onChange(await runPostJobs(post.id, { types, ignoreDuplicate: Boolean(post.duplicateOf) }));
      setPick(new Set());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const saveTags = async (tags: Tag[]) => {
    try {
      onChange(await savePostTags(post.id, tags));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const mark = async (patch: {
    ideaStatus?: IdeaStatus;
    rank?: number | null;
    stackId?: string | null;
    savedFor?: SavedFor[];
    knowhow?: boolean;
    idea?: PostIdea | null;
  }) => {
    setError(null);
    try {
      onChange(await patchPostResearch(post.id, patch));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(postToMarkdown(post, transcripts, comments));
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* ignore */
    }
  };

  const remove = async () => {
    await deletePost(post.id).catch(() => {});
    onDeleted();
  };

  const seekTo = (slideIndex: number, t: number) => {
    setIndex(slideIndex);
    setSeek({ index: slideIndex, t, key: Date.now() });
  };

  const caption = post.caption.trim();
  const captionLong = caption.length > 320 || caption.split("\n").length > 6;
  const shownCaption = expanded || !captionLong ? caption : `${caption.slice(0, 320).trimEnd()}…`;
  const onScreen = post.slides
    .map((s) => ({ index: s.index, text: s.vision.onScreenText?.trim() ?? "" }))
    .filter((s) => s.text);
  const onScreenCtx = (at: number) =>
    JSON.stringify({ postId: post.id, handle: post.creator.username, slide: at, field: "slides" });

  return (
    <div className="mx-auto w-[1160px] max-w-[96vw]">
      <button
        onClick={onClose}
        className="mb-3 flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-200"
      >
        <ArrowLeft className="h-3.5 w-3.5" /> All posts
      </button>

      <JobsDock post={post} />

      {post.status === "error" && (
        <div className="mb-5 flex flex-wrap items-center gap-3 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          <TriangleAlert className="h-4 w-4 shrink-0" />
          <span className="min-w-0 flex-1">{post.error || "Ingest failed"}</span>
          {post.duplicateOf ? (
            <Link
              to={`/instagram/${post.duplicateOf}`}
              className="rounded-md border border-red-400/40 px-2.5 py-1 text-xs hover:bg-red-500/20"
            >
              Open the existing post
            </Link>
          ) : owns ? (
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => void retry(false)}
              className="flex items-center gap-1 rounded-md border border-red-400/40 px-2.5 py-1 text-xs hover:bg-red-500/20 disabled:opacity-50"
            >
              <RotateCcw className="h-3 w-3" /> Retry
            </button>
          ) : null}
        </div>
      )}

      {post.duplicateOf && post.status !== "error" && (
        <div className="mb-5 flex flex-wrap items-center gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
          <Copy className="h-4 w-4 shrink-0" />
          <span className="min-w-0 flex-1">
            Same media as a post already in your library — transcript, slide text, comments and tags were skipped.
          </span>
          <Link
            to={`/instagram/${post.duplicateOf}`}
            className="rounded-md border border-amber-400/40 px-2.5 py-1 text-xs hover:bg-amber-500/20"
          >
            Open the original
          </Link>
          {owns && !isProcessing(post) ? (
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => void runGroups(JOB_GROUPS.map((g) => g.id))}
              className="rounded-md border border-amber-400/40 px-2.5 py-1 text-xs hover:bg-amber-500/20 disabled:opacity-50"
            >
              Run anyway
            </button>
          ) : null}
        </div>
      )}

      <div className="flex flex-col gap-6 lg:flex-row">
        <div className="w-full shrink-0 lg:w-[400px]">
          <SlideViewer post={post} index={index} onIndex={setIndex} seek={seek} />
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h2 className="text-lg font-semibold text-zinc-100">
              {post.creator.username ? (
                accountHref ? (
                  <Link to={accountHref} className="hover:text-violet-200">
                    @{post.creator.username}
                  </Link>
                ) : (
                  `@${post.creator.username}`
                )
              ) : (
                "Instagram post"
              )}
            </h2>
            {post.creator.fullName && (
              <span className="text-sm text-zinc-400">{post.creator.fullName}</span>
            )}
            <span className={`rounded-md px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider ${postBadgeClass(post)}`}>
              {postBadgeLabel(post)}
            </span>
            {post.takenAt ? (
              <span className="text-xs text-zinc-500">{fmtDate(post.takenAt)}</span>
            ) : null}
            <a
              href={post.url}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1 text-xs text-violet-300 hover:text-violet-200"
            >
              {openPostLabel(post)} <ExternalLink className="h-3 w-3" />
            </a>
            {siblings && at >= 0 && siblings.length > 1 && onOpenPost && (
              <span
                className="ml-auto flex items-center gap-1 text-[11px] text-zinc-500"
                title="Shift + ← / → also steps through the list"
              >
                <button
                  type="button"
                  aria-label="Previous post"
                  disabled={!prevId}
                  onClick={() => prevId && onOpenPost(prevId)}
                  className="rounded p-1 hover:bg-zinc-800 hover:text-zinc-100 disabled:opacity-30"
                >
                  <ChevronLeft className="h-4 w-4" />
                </button>
                <span className="tabular-nums">
                  {at + 1} / {siblings.length}
                </span>
                <button
                  type="button"
                  aria-label="Next post"
                  disabled={!nextId}
                  onClick={() => nextId && onOpenPost(nextId)}
                  className="rounded p-1 hover:bg-zinc-800 hover:text-zinc-100 disabled:opacity-30"
                >
                  <ChevronRight className="h-4 w-4" />
                </button>
              </span>
            )}
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-4 text-sm text-zinc-300">
            {post.counts.plays !== undefined && (
              <span className="flex items-center gap-1.5" title="Plays">
                <Eye className="h-4 w-4 text-zinc-500" /> {fmtCount(post.counts.plays)}
              </span>
            )}
            <span className="flex items-center gap-1.5" title="Likes">
              <Heart className="h-4 w-4 text-zinc-500" /> {fmtCount(post.counts.likes)}
            </span>
            <span className="flex items-center gap-1.5" title="Comments">
              <MessageCircle className="h-4 w-4 text-zinc-500" /> {fmtCount(post.counts.comments)}
            </span>
            {post.counts.fetchedAt ? (
              <span className="text-[11px] text-zinc-600">
                numbers from {timeAgo(post.counts.fetchedAt)}
              </span>
            ) : null}
            {post.bytes > 0 && (
              <span className="text-[11px] text-zinc-600">{fmtBytes(post.bytes)} stored</span>
            )}
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <IdeaStatusSelect
              value={post.ideaStatus}
              inSession={inSession}
              disabled={!owns}
              onChange={(ideaStatus) => void mark({ ideaStatus })}
            />
            <SavedForToggle
              value={post.savedFor}
              disabled={!owns}
              onChange={(savedFor) => void mark({ savedFor })}
              knowhow={post.knowhow}
              onKnowhow={(knowhow) => void mark({ knowhow })}
            />
            <RankStars
              value={post.rank}
              disabled={!owns}
              onChange={(rank) => void mark({ rank })}
            />
            {owns && (
              <select
                value={post.stackId ?? ""}
                onChange={(e) => void mark({ stackId: e.target.value || null })}
                className="rounded-md border border-zinc-800 bg-zinc-950 px-1.5 py-1 text-[11px] text-zinc-300"
              >
                <option value="">Solo — not stacked</option>
                {stacks.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.title}
                  </option>
                ))}
              </select>
            )}
          </div>

          {(post.takenAt || post.pulledAt) && (
            <p className="mt-2 text-[11px] text-zinc-500">
              {post.takenAt ? `Posted ${fmtDate(post.takenAt)} · ${fmtAgeSince(post.takenAt)} old now` : ""}
              {post.ageAtPullMs !== undefined ? ` · ${fmtAge(post.ageAtPullMs)} old when pulled` : ""}
              {post.pulledAt ? ` · pulled ${timeAgo(post.pulledAt)}` : ""}
            </p>
          )}
          {lastDiff && (
            <p className="mt-1 text-[11px] text-zinc-500">
              Since last refresh: plays {fmtDelta(lastDiff.plays)} · likes {fmtDelta(lastDiff.likes)} ·
              comments {fmtDelta(lastDiff.comments)}
            </p>
          )}

          {onScreen.length > 0 && (
            <div className="mt-4">
              <p className={label}>On-screen text</p>
              {onScreen.length === 1 ? (
                <p
                  data-ctx={onScreenCtx(onScreen[0]!.index)}
                  className="whitespace-pre-wrap text-sm leading-relaxed text-zinc-200"
                >
                  {onScreen[0]!.text}
                </p>
              ) : (
                <ol className="flex flex-col gap-2">
                  {onScreen.map((s) => (
                    <li key={s.index}>
                      <button
                        type="button"
                        onClick={() => setIndex(s.index)}
                        className={`flex w-full gap-2 rounded-md px-1 py-0.5 text-left hover:bg-zinc-800/50 ${
                          s.index === index ? "bg-zinc-800/40" : ""
                        }`}
                      >
                        <span className="mt-0.5 w-4 shrink-0 font-mono text-[10px] text-zinc-500">{s.index + 1}</span>
                        <span
                          data-ctx={onScreenCtx(s.index)}
                          className="min-w-0 flex-1 whitespace-pre-wrap text-sm leading-snug text-zinc-200"
                        >
                          {s.text}
                        </span>
                      </button>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          )}

          {post.slides.length > 0 && (
            <div className="mt-4">
              <SlidePanel
                post={post}
                index={index}
                onIndex={setIndex}
                transcripts={transcripts}
                onSeek={seekTo}
                onRead={() => void runGroups(["read"])}
              />
            </div>
          )}

          <div className="mt-4">
            <p className={label}>Idea</p>
            {owns ? (
              <IdeaFields
                key={`${post.id}:${post.idea?.title ?? ""}:${post.idea?.takeaway ?? ""}`}
                idea={post.idea}
                onSave={(idea) => void mark({ idea })}
              />
            ) : post.idea ? (
              <>
                <p className="text-sm font-medium text-zinc-100">{post.idea.title}</p>
                <p className="mt-1 text-[13px] leading-snug text-zinc-400">{post.idea.takeaway}</p>
              </>
            ) : (
              <p className="text-sm text-zinc-600">Not distilled yet — run Idea on this post.</p>
            )}
          </div>

          <div className="mt-4">
            <p className={label}>Caption</p>
            {caption ? (
              <p className="whitespace-pre-wrap text-sm leading-relaxed text-zinc-300">
                {shownCaption}
                {captionLong && (
                  <button
                    type="button"
                    onClick={() => setExpanded((v) => !v)}
                    className="ml-2 text-xs text-violet-300 hover:text-violet-200"
                  >
                    {expanded ? "less" : "more"}
                  </button>
                )}
              </p>
            ) : (
              <p className="text-sm text-zinc-600">No caption.</p>
            )}
          </div>

          <div className="mt-4">
            <p className={label}>Jobs</p>
            <div className="flex flex-wrap items-center gap-1.5">
              {JOB_GROUPS.map((g) => {
                const st = groupStatus(post.jobs, g.types);
                const err = groupError(post.jobs, g.types);
                const on = pick.has(g.id);
                const tone =
                  st === "done"
                    ? "border-emerald-500/30 text-emerald-300"
                    : st === "error"
                      ? "border-red-500/30 text-red-300"
                      : st === "running" || st === "pending"
                        ? "border-violet-500/40 text-violet-200"
                        : st === "skipped"
                          ? "border-zinc-800 text-zinc-500"
                          : "border-zinc-700 text-zinc-300";
                return (
                  <button
                    key={g.id}
                    type="button"
                    disabled={!owns}
                    aria-pressed={on}
                    title={err || g.hint}
                    onClick={() =>
                      setPick((cur) => {
                        const next = new Set(cur);
                        if (next.has(g.id)) next.delete(g.id);
                        else next.add(g.id);
                        return next;
                      })
                    }
                    className={`rounded-md border px-1.5 py-0.5 text-[10px] ${tone} ${
                      on ? "ring-1 ring-violet-400" : ""
                    } disabled:opacity-60`}
                  >
                    {g.label}
                    {st !== "idle" ? ` · ${st}` : ""}
                  </button>
                );
              })}
              {owns && !processing && (
                <span className="ml-auto flex items-center gap-1.5">
                  <button
                    type="button"
                    disabled={busy !== null || pick.size === 0}
                    onClick={() => void runGroups([...pick])}
                    className="flex items-center gap-1 rounded-md bg-violet-600 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-violet-500 disabled:opacity-50"
                  >
                    {busy === "jobs" ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                    Run {pick.size ? `${pick.size} selected` : "selected"}
                  </button>
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => void runGroups(JOB_GROUPS.map((g) => g.id))}
                    title="Run whatever is not done yet, all in one go"
                    className="rounded-md border border-zinc-700 px-2.5 py-1 text-[11px] text-zinc-200 hover:bg-zinc-800 disabled:opacity-50"
                  >
                    Run everything
                  </button>
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => setRunOpen(true)}
                    className="rounded-md px-2 py-1 text-[11px] text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 disabled:opacity-50"
                  >
                    More…
                  </button>
                </span>
              )}
            </div>
            <p className="mt-1 text-[11px] text-zinc-600">
              Click jobs to pick them, then run them together — one fetch of the post covers every
              job in the same run.
            </p>
          </div>

          <div className="mt-4">
            <p className={label}>Tags</p>
            <TagsEditor
              tags={post.tags}
              onChange={owns ? saveTags : undefined}
              onFilter={onFilterTag}
              disabled={processing}
              defaultKind={
                post.savedFor?.includes("format") && !post.tags?.some((t) => t.kind === "format")
                  ? "format"
                  : "custom"
              }
            />
          </div>

          {similar.length > 0 && (
            <div className="mt-4">
              <p className={label}>Likely the same content</p>
              <div className="flex flex-col gap-1">
                {similar.map(({ post: p, reason, score }) => (
                  <Link
                    key={p.id}
                    to={`${base}/${p.id}`}
                    className="flex min-w-0 items-center gap-2 rounded-md border border-zinc-800/80 px-2 py-1.5 hover:border-zinc-700"
                  >
                    {p.slides[0]?.thumb ? (
                      <img src={thumbUrl(p.id, 0)} alt="" className="h-8 w-6 shrink-0 rounded object-cover" />
                    ) : (
                      <div className="h-8 w-6 shrink-0 rounded bg-zinc-800" />
                    )}
                    <span className="min-w-0 flex-1 truncate text-xs text-zinc-300">
                      {p.creator.username ? `@${p.creator.username}` : "Post"}
                      {p.caption ? ` · ${p.caption.split("\n")[0]}` : ""}
                    </span>
                    <span
                      className={`shrink-0 rounded px-1 text-[10px] ${
                        reason === "media" ? "bg-amber-500/15 text-amber-200" : "bg-violet-500/15 text-violet-200"
                      }`}
                    >
                      {reason === "media" ? "same media" : `${Math.round(score * 100)}% same text`}
                    </span>
                  </Link>
                ))}
              </div>
            </div>
          )}

          {snap && snap.snapshots.length > 0 && (
            <div className="mt-4">
              <p className={label}>Snapshots</p>
              <table className="w-full text-left text-[11px] text-zinc-400">
                <thead>
                  <tr className="text-zinc-600">
                    <th className="py-1 font-medium">When</th>
                    <th className="py-1 font-medium">Plays</th>
                    <th className="py-1 font-medium">Likes</th>
                    <th className="py-1 font-medium">Comments</th>
                  </tr>
                </thead>
                <tbody>
                  {snap.snapshots.map((s) => (
                    <tr key={s.at} className="border-t border-zinc-800/80">
                      <td className="py-1">{fmtDate(s.at)} · {timeAgo(s.at)}</td>
                      <td className="py-1 tabular-nums">{fmtCount(s.plays)}</td>
                      <td className="py-1 tabular-nums">{fmtCount(s.likes)}</td>
                      <td className="py-1 tabular-nums">{fmtCount(s.comments)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {(snap.vsFirst || snap.vsPrevious) && (
                <p className="mt-1 text-[11px] text-zinc-600">
                  {snap.vsPrevious ? `Δ vs previous: plays ${fmtDelta(snap.vsPrevious.plays)}` : ""}
                  {snap.vsFirst ? ` · vs first pull: plays ${fmtDelta(snap.vsFirst.plays)}` : ""}
                </p>
              )}
            </div>
          )}

          {post.warnings?.length ? (
            <ul className="mt-4 flex flex-col gap-1">
              {post.warnings.map((w) => (
                <li key={w} className="flex items-start gap-1.5 text-[11px] text-amber-400/80">
                  <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" /> {w}
                </li>
              ))}
            </ul>
          ) : null}

          <CommentsList post={post} owns={owns} onChange={onChange} onLoaded={setComments} />

          {error && <p className="mt-4 text-xs text-red-400">{error}</p>}

          <div className="mt-6 flex flex-wrap items-center gap-2 border-t border-zinc-800 pt-4">
            <button
              type="button"
              onClick={() => void copy()}
              className="flex items-center gap-1.5 rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-200 hover:bg-zinc-800"
            >
              {copied ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
              {copied ? "Copied" : "Copy as Markdown"}
            </button>
            {owns && !processing && (
              <>
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => setRunOpen(true)}
                  className="flex items-center gap-1.5 rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-200 hover:bg-zinc-800 disabled:opacity-50"
                >
                  Run jobs…
                </button>
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void refresh()}
                  className="flex items-center gap-1.5 rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-200 hover:bg-zinc-800 disabled:opacity-50"
                >
                  {busy === "refresh" ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <RefreshCw className="h-3.5 w-3.5" />
                  )}
                  Refresh numbers
                </button>
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void retry(false)}
                  title="Re-run only the parts that failed or were skipped"
                  className="flex items-center gap-1.5 rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-200 hover:bg-zinc-800 disabled:opacity-50"
                >
                  {busy === "retry" ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <RotateCcw className="h-3.5 w-3.5" />
                  )}
                  Retry missing parts
                </button>
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void retry(true)}
                  className="rounded-md px-3 py-1.5 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 disabled:opacity-50"
                >
                  Redo everything
                </button>
                <ConfirmButton
                  label="Delete"
                  confirmLabel="Click again to delete"
                  icon={<Trash2 className="h-3.5 w-3.5" />}
                  onConfirm={remove}
                  className="ml-auto flex items-center gap-1.5 rounded-md border border-transparent px-3 py-1.5 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-red-400"
                  armedClassName="!border-red-500/50 !bg-red-500/10 !text-red-200"
                />
              </>
            )}
          </div>
        </div>
      </div>
      {runOpen && (
        <RunJobsDialog
          title="Run jobs on this post"
          busy={busy !== null}
          onClose={() => setRunOpen(false)}
          onRun={async (recipe, opts) => {
            await runJobs(recipe, opts);
          }}
        />
      )}
    </div>
  );
}

function shareUrlFromSearch(search: string): string {
  const params = new URLSearchParams(search);
  return (
    instagramUrlFromText(
      [params.get("url"), params.get("text"), params.get("title")]
        .filter((v): v is string => Boolean(v))
        .join("\n"),
    ) ?? ""
  );
}

export default function InstagramPage() {
  const { postId } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const browse = (location.state as { browse?: string[] } | null)?.browse;
  const home = toolsetHomePath();
  const base = analyzerHome();
  const me = useViewedMe();
  const required = useAuth((s) => s.required);
  const allowed = canUse(me, "instagram");
  const currentProjectId = useWorkspace((s) => s.currentProjectId);
  const [posts, setPosts] = useState<InstagramPost[]>([]);
  const [accounts, setAccounts] = useState<InstagramAccount[]>([]);
  const [addingMine, setAddingMine] = useState(false);
  const [showAllAccounts, setShowAllAccounts] = useState(false);
  const [pullingAll, setPullingAll] = useState(false);
  const [pullAllError, setPullAllError] = useState<string | null>(null);
  const [mineError, setMineError] = useState<string | null>(null);
  const [stacks, setStacks] = useState<InstagramStack[]>([]);
  const [current, setCurrent] = useState<InstagramPost | null>(null);
  const [avail, setAvail] = useState<InstagramAvailability | null>(null);
  const [q, setQ] = useState("");
  const [accountFilter, setAccountFilter] = useState("");
  const [tagFilter, setTagFilter] = useState("");
  const [ideaFilter, setIdeaFilter] = useState<IdeaStatus | "">("inbox");
  const [savedForFilter, setSavedForFilter] = useState<SavedFor>("content");
  const [kindFilter, setKindFilter] = useState<PostKind | "">("");
  const [sort, setSort] = useState<LibrarySort>("pulled");
  const [libraryView, setLibraryView] = useState<LibraryView>("feed");
  const [ideaBoard, setIdeaBoard] = useState<IdeaBoard | null>(null);
  const [boardBusy, setBoardBusy] = useState(false);
  const [boardError, setBoardError] = useState("");
  const [makingIdea, setMakingIdea] = useState<string | null>(null);
  const autoBoard = useRef(false);
  const [stackDraft, setStackDraft] = useState("");
  const [stackOpen, setStackOpen] = useState(false);
  const [hits, setHits] = useState<FindHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [workshopSessions, setWorkshopSessions] = useState<SessionRow[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [runOpen, setRunOpen] = useState(false);
  const [runBusy, setRunBusy] = useState(false);
  const distillQueued = useRef(new Set<string>());
  const chromeRef = useRef<HTMLDivElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const pinTop = useRef<number | null>(null);
  const resultsFloor = useRef(0);
  const [pageError, setPageError] = useState<{ id: string; message: string } | null>(null);
  const [sharePrefill] = useState(() => {
    const url = shareUrlFromSearch(window.location.search);
    if (url && window.location.search) {
      window.history.replaceState(null, "", base);
    }
    return url;
  });

  const listQuery = useCallback(
    (): ListPostsQuery =>
      libraryView === "knowhow"
        ? { account: accountFilter, tag: tagFilter, shelf: "knowhow", sort }
        : {
            account: accountFilter,
            tag: tagFilter,
            idea:
              libraryView === "ideas" || ideaFilter === "idea" || ideaFilter === ""
                ? undefined
                : ideaFilter,
            savedFor: libraryView === "ideas" ? undefined : savedForFilter,
            sort,
          },
    [accountFilter, tagFilter, ideaFilter, savedForFilter, sort, libraryView],
  );

  const pinLibraryChrome = useCallback(() => {
    const chrome = chromeRef.current;
    const results = resultsRef.current;
    if (!chrome) return;
    if (
      results &&
      (results.getBoundingClientRect().top < chrome.getBoundingClientRect().bottom ||
        shrinkWouldClamp(
          window.scrollY,
          window.innerHeight,
          document.documentElement.scrollHeight,
          results.offsetHeight,
        ))
    ) {
      pinTop.current = null;
      resultsFloor.current = results.offsetHeight;
      results.style.minHeight = `${resultsFloor.current}px`;
      return;
    }
    resultsFloor.current = 0;
    if (results) results.style.minHeight = "";
    const r = chrome.getBoundingClientRect();
    pinTop.current = r.top >= 0 && r.top < window.innerHeight ? r.top : 0;
  }, []);

  const refreshList = useCallback(() => {
    listPosts(listQuery())
      .then(setPosts)
      .catch(() => {});
  }, [listQuery]);

  const refreshAccounts = useCallback(() => {
    listAccounts()
      .then(setAccounts)
      .catch(() => {});
  }, []);

  const refreshStacks = useCallback(() => {
    listStacks()
      .then(setStacks)
      .catch(() => {});
  }, []);

  const refreshAvailability = useCallback(() => {
    getInstagramAvailability()
      .then(setAvail)
      .catch(() => {});
  }, []);
  // The Apify key lives in Settings → Connectors: re-read it when it changes there.
  useEffect(() => {
    window.addEventListener(INSTAGRAM_CONNECTION_EVENT, refreshAvailability);
    return () => window.removeEventListener(INSTAGRAM_CONNECTION_EVENT, refreshAvailability);
  }, [refreshAvailability]);

  const refreshWorkshop = useCallback(() => {
    listSessions()
      .then(setWorkshopSessions)
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!allowed) return;
    refreshList();
    refreshAccounts();
    refreshStacks();
    refreshAvailability();
    refreshWorkshop();
  }, [allowed, currentProjectId, refreshList, refreshAccounts, refreshStacks, refreshAvailability, refreshWorkshop]);

  useEffect(() => {
    if (!allowed) return;
    const t = window.setTimeout(() => refreshList(), 250);
    return () => window.clearTimeout(t);
  }, [
    accountFilter,
    tagFilter,
    ideaFilter,
    savedForFilter,
    sort,
    libraryView,
    allowed,
    refreshList,
  ]);

  useLayoutEffect(() => {
    const chrome = chromeRef.current;
    const results = resultsRef.current;
    if (chrome) {
      chrome.parentElement?.style.setProperty("--library-chrome-h", `${chrome.offsetHeight}px`);
    }
    if (results && resultsFloor.current) {
      results.style.minHeight = `${resultsFloor.current}px`;
    }
    if (pinTop.current == null || !chrome) return;
    window.scrollBy(0, chrome.getBoundingClientRect().top - pinTop.current);
  }, [ideaFilter, savedForFilter, kindFilter, libraryView, posts, sort]);

  useEffect(() => {
    const onScroll = () => {
      const el = resultsRef.current;
      if (!el || !resultsFloor.current) return;
      const natural = (el.firstElementChild as HTMLElement | null)?.offsetHeight ?? 0;
      resultsFloor.current = decayHeightLock(
        resultsFloor.current,
        el.getBoundingClientRect().top,
        natural,
        window.innerHeight,
      );
      el.style.minHeight = resultsFloor.current ? `${resultsFloor.current}px` : "";
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    if (pinTop.current == null) return;
    const t = window.setTimeout(() => {
      pinTop.current = null;
    }, 400);
    return () => window.clearTimeout(t);
  }, [ideaFilter, savedForFilter, kindFilter, sort, libraryView, posts]);

  useEffect(() => {
    const query = q.trim();
    // Know-how is never indexed: its tab filters its own list instead.
    if (query.length < 2 || libraryView === "knowhow") {
      setHits(null);
      setSearching(false);
      return;
    }
    let stopped = false;
    setSearching(true);
    const t = window.setTimeout(() => {
      findPosts(query, { limit: 200 })
        .then((r) => {
          if (!stopped) setHits(r.hits);
        })
        .catch(() => {
          if (!stopped) setHits([]);
        })
        .finally(() => {
          if (!stopped) setSearching(false);
        });
    }, 280);
    return () => {
      stopped = true;
      window.clearTimeout(t);
    };
  }, [q, libraryView]);

  const anyProcessing = posts.some(isProcessing) || accounts.some((a) => a.status === "processing");
  useEffect(() => {
    if (!allowed || postId || !anyProcessing) return;
    const t = window.setInterval(() => {
      refreshList();
      refreshAccounts();
    }, 800);
    return () => window.clearInterval(t);
  }, [allowed, postId, anyProcessing, refreshList, refreshAccounts]);

  const workshopBusy = workshopSessions.some((s) => s.generating);
  useEffect(() => {
    if (!allowed || !workshopBusy) return;
    const t = window.setInterval(() => refreshWorkshop(), 2500);
    return () => window.clearInterval(t);
  }, [allowed, workshopBusy, refreshWorkshop]);

  useEffect(() => {
    if (!postId) return;
    let cancelled = false;
    getPost(postId)
      .then((p) => {
        if (!cancelled) setCurrent(p);
      })
      .catch((e) => {
        if (!cancelled) {
          setPageError({
            id: postId,
            message: e instanceof Error ? e.message : "Could not open post",
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [postId]);

  const applyPost = useCallback((p: InstagramPost) => {
    setCurrent((prev) => {
      if (!prev || prev.id !== p.id) return p;
      return p.updatedAt >= prev.updatedAt ? p : prev;
    });
    setPosts((list) => {
      const known = list.some((x) => x.id === p.id);
      if (!known) return [p, ...list];
      return list.map((x) => (x.id === p.id && p.updatedAt >= x.updatedAt ? p : x));
    });
  }, []);

  useEffect(() => {
    // "See the demo" reads what's already distilled, never asks the AI
    if (!allowed || !avail?.ai || me?.demo) return;
    const inFlight = [...distillQueued.current].filter((id) => {
      const p = posts.find((x) => x.id === id);
      return Boolean(p && !p.idea);
    }).length;
    const room = 8 - inFlight;
    if (room <= 0) return;
    const ready = posts.filter((p) => needsIdeaDistill(p) && !distillQueued.current.has(p.id)).slice(0, room);
    if (!ready.length) return;
    for (const p of ready) distillQueued.current.add(p.id);
    for (const p of ready) {
      void runPostJobs(p.id, { types: ["idea"] })
        .then(applyPost)
        .catch(() => {
          distillQueued.current.delete(p.id);
        });
    }
  }, [allowed, avail?.ai, me?.demo, posts, applyPost]);

  const refreshBoard = useCallback(() => {
    getIdeaBoard()
      .then(setIdeaBoard)
      .catch(() => setIdeaBoard({ generatedAt: 0, ideas: [] }));
  }, []);

  const runGenerateBoard = useCallback(async () => {
    setBoardBusy(true);
    setBoardError("");
    try {
      setIdeaBoard(await generateIdeaBoard());
    } catch (e) {
      setBoardError(e instanceof Error ? e.message : "Could not find ideas");
    } finally {
      setBoardBusy(false);
    }
  }, []);

  useEffect(() => {
    if (!allowed || libraryView !== "ideas") {
      autoBoard.current = false;
      return;
    }
    refreshBoard();
  }, [allowed, libraryView, refreshBoard]);

  useEffect(() => {
    if (!allowed || !avail?.ai || libraryView !== "ideas" || boardBusy) return;
    if (ideaBoard === null || ideaBoard.ideas.length || autoBoard.current) return;
    if (!posts.length) return;
    autoBoard.current = true;
    void runGenerateBoard();
  }, [allowed, avail?.ai, libraryView, ideaBoard, boardBusy, posts.length, runGenerateBoard]);

  const onIngest = async (payload: {
    urls: string[];
    profiles: string[];
    recipe: Recipe;
    run: RunWhen;
    savedFor?: SavedFor[];
    knowhow?: boolean;
  }) => {
    const notes: string[] = [];
    for (const profile of payload.profiles) {
      try {
        const acc = await addAccount(profile, { run: payload.run });
        setAccounts((list) => [acc, ...list.filter((a) => a.id !== acc.id)]);
      } catch (e) {
        notes.push(e instanceof Error ? e.message : String(e));
      }
    }
    if (!payload.urls.length) {
      const latest = await listAccounts().catch(() => []);
      const match = latest.find(
        (a) => a.username.toLowerCase() === instagramHandle(payload.profiles[0] || ""),
      );
      if (payload.profiles.length === 1 && match && !notes.length) {
        navigate(`${base}/accounts/${match.id}`);
      } else {
        navigate(base);
      }
      if (notes.length && !match) throw new Error(notes[0]);
      return notes.length ? notes[0] : undefined;
    }
    const { posts, errors } = await ingestPosts(payload.urls, {
      recipe: payload.recipe,
      run: payload.run,
      savedFor: payload.savedFor,
      knowhow: payload.knowhow,
    });
    for (const p of posts) applyPost(p);
    refreshAccounts();
    if (posts.length === 1 && errors.length === 0 && !payload.profiles.length) {
      navigate(`${base}/${posts[0].id}`);
    } else {
      navigate(base);
    }
    if (!posts.length) throw new Error(errors[0]?.error || notes[0] || "Ingest failed");
    if (errors.length || notes.length) {
      return `${posts.length} saved. ${errors.length + notes.length} failed: ${errors[0]?.error || notes[0]}`;
    }
  };

  const addMine = async (username: string) => {
    setAddingMine(true);
    setMineError(null);
    try {
      const acc = await addAccount(username, { run: accountCatalogReady(avail, true) ? "now" : "later", mine: true });
      setAccounts((list) => [acc, ...list.filter((a) => a.id !== acc.id)].map((a) => (a.id === acc.id ? acc : { ...a, mine: undefined })));
      if (currentProjectId) await patchProject(currentProjectId, { accountId: acc.id });
      navigate(`${base}/accounts/${acc.id}`);
    } catch (e) {
      setMineError(e instanceof Error ? e.message : String(e));
    } finally {
      setAddingMine(false);
    }
  };

  const runSelected = async (recipe: Recipe, opts: { run: RunWhen; force: boolean }) => {
    setRunBusy(true);
    try {
      for (const id of selected) {
        applyPost(await runPostJobs(id, { recipe, force: opts.force }));
      }
      setSelected(new Set());
      setRunOpen(false);
    } finally {
      setRunBusy(false);
    }
  };

  const markOne = async (
    id: string,
    patch: {
      ideaStatus?: IdeaStatus;
      rank?: number | null;
      stackId?: string | null;
      savedFor?: SavedFor[];
      knowhow?: boolean;
    },
  ) => {
    applyPost(await patchPostResearch(id, patch));
    if (patch.stackId !== undefined) refreshStacks();
    refreshList();
  };

  const bulkMark = async (patch: {
    ideaStatus?: IdeaStatus;
    rank?: number | null;
    stackId?: string | null;
    savedFor?: SavedFor[];
    knowhow?: boolean;
  }) => {
    const { posts: next } = await patchPostsResearch([...selected], patch);
    for (const p of next) applyPost(p);
    if (patch.stackId !== undefined) refreshStacks();
    refreshList();
  };

  const stackSelected = async () => {
    const title = stackDraft.trim();
    if (title.length < 2 || selected.size < 2) return;
    await createStack(title, [...selected]);
    setStackOpen(false);
    setStackDraft("");
    setSelected(new Set());
    refreshList();
    refreshStacks();
  };

  const unstackSelected = async () => {
    await bulkMark({ stackId: null });
    setSelected(new Set());
    refreshList();
    refreshStacks();
  };

  const patchTopic = async (
    id: string,
    patch: { title?: string; ideaStatus?: IdeaStatus },
  ) => {
    const next = await patchStack(id, patch);
    if ("dissolved" in next) {
      refreshList();
      refreshStacks();
      return;
    }
    setStacks((list) => list.map((s) => (s.id === id ? { ...s, ...next } : s)));
    if (patch.ideaStatus) refreshList();
  };

  const viewing = postId && current?.id === postId ? current : null;
  const routeError = postId && pageError?.id === postId ? pageError.message : null;
  const opening = Boolean(postId && !viewing && !routeError);
  const ownsCurrent =
    !!me && !!viewing && (me.role === "admin" || me.username === viewing.owner);
  const sessionReason = !avail || avail.available
    ? null
    : avail.apify?.valid === false
      ? "Your Apify key is invalid"
      : "Other creators' posts need your own Apify key";

  const searchingLibrary = q.trim().length >= 2;
  const ideasView = libraryView === "ideas";
  const knowhowView = libraryView === "knowhow";
  const searchPending = searchingLibrary && !knowhowView && (searching || hits === null);
  const workshopByPost = workshopUsesByPost(workshopSessions);
  const bucketed = ideasView || knowhowView
    ? posts
    : ideaFilter === "idea"
      ? posts.filter((p) => isInProject(p, workshopByPost))
      : ideaFilter === "inbox"
        ? posts.filter((p) => !workshopByPost.has(p.id))
        : posts;
  const allowedIds = new Set(bucketed.map((p) => p.id));
  const rankedHits = searchingLibrary && !knowhowView
    ? (hits ?? []).filter((h) => allowedIds.has(h.post.id) && (!kindFilter || h.post.kind === kindFilter))
    : null;
  const visiblePosts = rankedHits
    ? rankedHits.map((h) => h.post)
    : bucketed.filter(
        (p) =>
          (!kindFilter || p.kind === kindFilter) &&
          (!knowhowView || !searchingLibrary || postMatchesText(p, q)),
      );
  const matchByPost = new Map((rankedHits ?? []).map((h) => [h.post.id, h]));
  const byId = new Map(bucketed.map((p) => [p.id, p]));
  const ideaRows = (ideaBoard?.ideas ?? [])
    .map((idea) => ({
      ...idea,
      posts: idea.postIds
        .map((id) => byId.get(id))
        .filter((p): p is InstagramPost => !!p && !workshopByPost.has(p.id)),
    }))
    .map((idea) => ({
      ...idea,
      posts: kindFilter ? idea.posts.filter((p) => p.kind === kindFilter) : idea.posts,
    }))
    .filter((idea) => {
      if (!idea.posts.length) return false;
      if (searchingLibrary) {
        const hitIds = new Set((rankedHits ?? []).map((h) => h.post.id));
        return idea.posts.some((p) => hitIds.has(p.id)) || ideaMatchesQuery({ title: idea.title, takeaway: idea.description }, q);
      }
      return true;
    });
  const myAccount = accounts.find((a) => a.mine);
  const pulledAccounts = accounts.filter((a) => !a.mine && isReferenceAccount(a));
  const savedOnlyAccounts = accounts.filter((a) => !isReferenceAccount(a));
  const otherAccounts = [...pulledAccounts, ...savedOnlyAccounts];
  const unpulledAccounts = savedOnlyAccounts.filter((a) => a.status !== "processing");
  const pullUnpulled = async () => {
    setPullingAll(true);
    setPullAllError(null);
    const errors: string[] = [];
    for (const a of unpulledAccounts) {
      await runAccountJobs(a.id, ["profile", "catalog"]).catch((e) =>
        errors.push(`@${a.username}: ${e instanceof Error ? e.message : String(e)}`),
      );
    }
    refreshAccounts();
    setPullingAll(false);
    if (errors.length) setPullAllError(`${errors.length} not queued. ${errors[0]}`);
  };
  const distillingCount = posts.filter(
    (p) =>
      !p.idea &&
      (p.status === "processing" ||
        p.jobs?.some((j) => j.type === "idea" && (j.status === "pending" || j.status === "running"))),
  ).length;
  const grouped: LibraryGroup[] = ideasView
    ? []
    : [{ key: "", label: "", posts: visiblePosts }];
  const browseIds = ideasView
    ? ideaRows.flatMap((c) => c.posts.map((p) => p.id))
    : grouped.flatMap((g) => g.posts.map((p) => p.id));
  const openPost = (id: string, ids: string[] = browseIds) =>
    navigate(`${base}/${id}`, { state: { browse: ids } });
  const makeIdea = async (idea: (typeof ideaRows)[number]) => {
    setMakingIdea(idea.id);
    setBoardError("");
    try {
      const s = await createSession({
        title: idea.title,
        notes: idea.description,
        sourceIds: idea.posts.map((p) => p.id),
      });
      navigate(sessionPath(s.id));
    } catch (e) {
      setBoardError(e instanceof Error ? e.message : "Could not open workshop");
    } finally {
      setMakingIdea(null);
    }
  };

  return (
    <div className="relative flex min-h-dvh flex-col items-center bg-[#0b0b10] pb-[max(2.5rem,env(safe-area-inset-bottom))] text-zinc-200">
      {isAdminForeignView(me, viewing?.owner) && <AdminViewBorder />}
      <AppBar tool="Content Analyzer" to={postId ? base : undefined} trail={viewing ? `@${viewing.creator.username}` : undefined} account={!!me}>
        {me ? (
          <>
            <QueueMenu
              base={base}
              busyHint={anyProcessing}
              onChange={() => {
                refreshList();
                refreshAccounts();
              }}
            />
            <ProjectSwitcher />
          </>
        ) : required ? (
          <Link to={home} className="rounded-md px-2 py-1.5 text-xs text-zinc-500 hover:text-zinc-200">
            Sign in
          </Link>
        ) : null}
      </AppBar>

      {!postId && (
        <div className="mb-8 mt-10 flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-violet-600">
            <ScanSearch className="h-6 w-6 text-white" />
          </div>
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Content Analyzer</h1>
            <p className="text-sm text-zinc-500">
              Dump interesting posts. Distill the idea. Rank them.
            </p>
          </div>
        </div>
      )}

      <div className={viewing || postId ? "mt-6 w-full" : "w-[760px] max-w-[92vw]"}>
        {opening ? (
          <div className="flex items-center justify-center gap-2 py-16 text-sm text-zinc-500">
            <Loader2 className="h-4 w-4 animate-spin" /> Opening post…
          </div>
        ) : postId && !viewing ? (
          <div className="mx-auto w-[760px] max-w-[92vw]">
            <button
              type="button"
              onClick={() => navigate(base)}
              className="mb-3 flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-200"
            >
              <ArrowLeft className="h-3.5 w-3.5" /> All posts
            </button>
            <p className="text-sm text-red-400">{routeError || "This post could not be opened."}</p>
          </div>
        ) : viewing ? (
          <>
            {isAdminForeignView(me, viewing.owner) && (
              <AdminViewBanner owner={viewing.owner} noun="post" />
            )}
            <PostView
              post={viewing}
              owns={ownsCurrent}
              inSession={workshopByPost.has(viewing.id)}
              stacks={stacks}
              accountHref={accountPathFor(base, viewing, accounts)}
              siblings={browse}
              onOpenPost={(id) => navigate(`${base}/${id}`, { state: location.state })}
              onChange={applyPost}
              onFilterTag={(label) => {
                setTagFilter(label);
                navigate(base);
              }}
              onClose={() => {
                navigate(base);
                refreshList();
                refreshStacks();
                refreshWorkshop();
              }}
              onDeleted={() => {
                setPosts((list) => list.filter((x) => x.id !== viewing.id));
                navigate(base);
              }}
            />
          </>
        ) : (
          <>
            {/* "See the demo" shows what's already read in, never the scraping */}
            {!me?.demo && <IngestBox
              defaultValue={sharePrefill}
              nowDisabledReason={sessionReason}
              onConnect={() => navigate("/settings/connectors")}
              onIngest={onIngest}
            />}
            {avail && !me?.demo && !avail.available && (
              <p className="mt-2 text-[11px] text-zinc-400">
                With only your Instagram login (Settings → Connectors) you get your own posts and their numbers. Other
                creators' posts and full comment threads need an Apify key of your own, added in Settings → Connectors:
                Apify bills you for each read.
              </p>
            )}
            {avail && !me?.demo && (!avail.cloud || !avail.ai) && (
              <p className="mt-2 flex items-center gap-1.5 text-[11px] text-amber-400/80">
                <TriangleAlert className="h-3 w-3 shrink-0" />
                {!avail.cloud && !avail.ai
                  ? `Transcripts and slide text are off: ${avail.cloudWhy ?? "cloud transcription is locked"}, and no AI provider is set up for you (Settings → AI providers).`
                  : !avail.cloud
                    ? `Transcripts are off: ${avail.cloudWhy ?? "cloud transcription is locked for your account"}.`
                    : "Slide text is off: no AI provider is set up for you (Settings → AI providers)."}
              </p>
            )}

            <div className="mt-6 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {myAccount ? (
                <AccountCard account={myAccount} to={`${base}/accounts/${myAccount.id}`} />
              ) : (
                <MyAccountSlot
                  busy={addingMine}
                  error={mineError}
                  disabledReason={sessionReason}
                  onAdd={addMine}
                />
              )}
              {otherAccounts.length ? (
                <div className="relative flex min-w-0 lg:col-span-2">
                <button
                  type="button"
                  aria-expanded={showAllAccounts}
                  onClick={() => setShowAllAccounts((v) => !v)}
                  className={`flex min-w-0 flex-1 items-center gap-4 rounded-xl border px-4 py-2.5 pr-12 text-left ${
                    showAllAccounts
                      ? "border-zinc-700 bg-zinc-900/60"
                      : "border-zinc-800 hover:border-zinc-700 hover:bg-zinc-900/60"
                  }`}
                >
                  <span className="flex shrink-0 -space-x-2">
                    {otherAccounts.slice(0, 5).map((a) => (
                      <span
                        key={a.id}
                        className="flex h-8 w-8 items-center justify-center overflow-hidden rounded-full bg-zinc-800 ring-2 ring-[#0b0b10]"
                      >
                        {a.avatarUrl ? (
                          <img src={`${a.avatarUrl}?t=${a.updatedAt}`} alt="" className="h-full w-full object-cover" />
                        ) : (
                          <Instagram className="h-3.5 w-3.5 text-zinc-500" />
                        )}
                      </span>
                    ))}
                  </span>
                  <span className="grid min-w-0 flex-1 grid-cols-3 gap-2">
                    <Stat value={String(otherAccounts.length)} label="accounts" />
                    <Stat value={String(pulledAccounts.length)} label="pulled" />
                    <Stat value={String(savedOnlyAccounts.length)} label="single posts" />
                  </span>
                  <ChevronDown
                    className={`h-4 w-4 shrink-0 text-zinc-500 transition-transform ${showAllAccounts ? "rotate-180" : ""}`}
                  />
                </button>
                {unpulledAccounts.length && !me?.demo ? (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        disabled={pullingAll}
                        title="More"
                        aria-label="More"
                        className="absolute right-2 top-2 rounded-md p-1.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200 disabled:opacity-50"
                      >
                        {pullingAll ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <MoreHorizontal className="h-3.5 w-3.5" />
                        )}
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-64">
                      <DropdownMenuItem
                        disabled={!!sessionReason}
                        className="items-start py-2 text-xs"
                        onSelect={() => void pullUnpulled()}
                      >
                        <RefreshCw className="mt-0.5 text-muted-foreground" />
                        <span className="min-w-0 flex-1">
                          <span className="block">
                            Pull the {unpulledAccounts.length} missing account
                            {unpulledAccounts.length === 1 ? "" : "s"}
                          </span>
                          <span className="mt-0.5 block text-[10px] text-muted-foreground">
                            {sessionReason || "Profile and recent posts for each, one after another on the queue"}
                          </span>
                        </span>
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                ) : null}
                </div>
              ) : null}
            </div>
            {pullAllError ? <p className="mt-2 text-[11px] text-red-400">{pullAllError}</p> : null}
            {showAllAccounts && otherAccounts.length ? (
              <div className="mt-2 max-h-[min(60vh,34rem)] overflow-y-auto rounded-xl border border-zinc-800 p-2">
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {otherAccounts.map((a) => (
                    <AccountCard
                      key={a.id}
                      account={a}
                      to={`${base}/accounts/${a.id}`}
                      active={accountFilter === a.id}
                    />
                  ))}
                </div>
              </div>
            ) : null}

            <div className={`mt-8 ${selected.size > 0 ? "pb-16" : ""}`}>
              <div
                ref={chromeRef}
                className="sticky top-0 z-20 mb-2 flex flex-col gap-3 bg-[#0b0b10] py-2"
              >
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                  <h2 className={`${label} mb-0`}>Library</h2>
                  {!ideasView && distillingCount > 0 ? (
                    <p className="text-[11px] text-zinc-500 sm:ml-auto">
                      Distilling {distillingCount} {distillingCount === 1 ? "idea" : "ideas"}…
                    </p>
                  ) : searchingLibrary ? (
                    <p className="text-[11px] text-zinc-500 sm:ml-auto">
                      {searchPending && hits === null
                        ? "Searching…"
                        : ideasView
                          ? `${ideaRows.length} idea${ideaRows.length === 1 ? "" : "s"}`
                          : `${visiblePosts.length} match${visiblePosts.length === 1 ? "" : "es"}`}
                    </p>
                  ) : ideasView && ideaBoard?.generatedAt ? (
                    <p className="text-[11px] text-zinc-500 sm:ml-auto">
                      {ideaRows.length} idea{ideaRows.length === 1 ? "" : "s"}
                      {ideaBoard.usage ? (
                        <span title="Made by Claude on your Mac (your subscription): measured tokens, and what the API would have charged">
                          {" "}· Claude (Mac) · {(ideaBoard.usage.tokens / 1000).toFixed(1)}k tokens · ${ideaBoard.usage.costUsd.toFixed(2)} API-equivalent
                        </span>
                      ) : null}
                    </p>
                  ) : null}
                </div>
                <div role="tablist" aria-label="Kept for" className="flex rounded-xl border border-zinc-800 bg-zinc-950 p-1">
                  {LIBRARY_TABS.map((t) => {
                    const on = knowhowView ? t.id === "knowhow" : t.id === savedForFilter;
                    return (
                      <button
                        key={t.id}
                        type="button"
                        role="tab"
                        aria-selected={on}
                        title={t.hint}
                        onClick={() => {
                          pinLibraryChrome();
                          if (t.id === "knowhow") return setLibraryView("knowhow");
                          setSavedForFilter(t.id);
                          setLibraryView("feed");
                        }}
                        className={`min-w-0 flex-1 rounded-lg px-3 py-2.5 text-sm font-medium ${
                          on ? "bg-violet-600/25 text-violet-100" : "text-zinc-400 hover:text-zinc-200"
                        }`}
                      >
                        {t.label}
                      </button>
                    );
                  })}
                </div>
                {!knowhowView && savedForFilter === "content" ? (
                  <div role="radiogroup" aria-label="Content view" className="flex gap-1 self-start rounded-lg border border-zinc-800 bg-zinc-950 p-0.5 text-[12px]">
                    {(
                      [
                        ["feed", "Posts"],
                        ["ideas", "Ideas"],
                      ] as Array<[LibraryView, string]>
                    ).map(([id, text]) => (
                      <button
                        key={id}
                        type="button"
                        role="radio"
                        aria-checked={libraryView === id}
                        onClick={() => {
                          pinLibraryChrome();
                          setLibraryView(id);
                        }}
                        className={`rounded-md px-3 py-1 font-medium ${
                          libraryView === id ? "bg-violet-600/25 text-violet-100" : "text-zinc-400 hover:text-zinc-200"
                        }`}
                      >
                        {text}
                        {id === "ideas" && ideaBoard?.ideas.length ? (
                          <span className="ml-1.5 rounded-full bg-zinc-800 px-1.5 text-[10px] tabular-nums text-zinc-300">{ideaBoard.ideas.length}</span>
                        ) : null}
                      </button>
                    ))}
                  </div>
                ) : null}
                {!ideasView && !knowhowView ? (
                  <div role="radiogroup" aria-label="Status" className="flex rounded-xl border border-zinc-800 bg-zinc-950 p-1">
                    {STATUS_FILTERS.map((s) => (
                      <button
                        key={s.id || "all"}
                        type="button"
                        role="radio"
                        aria-checked={ideaFilter === s.id}
                        onClick={() => {
                          pinLibraryChrome();
                          setIdeaFilter(s.id);
                        }}
                        className={`min-w-0 flex-1 whitespace-nowrap rounded-lg px-2 py-1.5 text-[11px] font-medium ${
                          ideaFilter === s.id
                            ? "bg-violet-600/25 text-violet-100"
                            : "text-zinc-400 hover:text-zinc-200"
                        }`}
                      >
                        {s.label}
                      </button>
                    ))}
                  </div>
                ) : null}
                <div className="flex min-w-0 flex-wrap items-stretch gap-2">
                  <div className="flex min-w-[12rem] flex-1 items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900/50 px-3 py-2.5 focus-within:border-violet-500/50">
                    {searching || searchPending ? (
                      <Loader2 className="h-4 w-4 shrink-0 animate-spin text-violet-400" />
                    ) : (
                      <Search className="h-4 w-4 shrink-0 text-zinc-500" />
                    )}
                    <input
                      value={q}
                      onChange={(e) => setQ(e.target.value)}
                      aria-label="Search library"
                      className="min-w-0 flex-1 bg-transparent text-sm text-zinc-200 outline-none"
                    />
                    {q ? (
                      <button
                        type="button"
                        onClick={() => setQ("")}
                        aria-label="Clear search"
                        className="rounded p-0.5 text-zinc-500 hover:text-zinc-200"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    ) : null}
                  </div>
                  {ideasView ? (
                    <button
                      type="button"
                      disabled={boardBusy || !avail?.ai}
                      onClick={() => void runGenerateBoard()}
                      className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2.5 text-[12px] text-zinc-300 hover:border-zinc-700 hover:text-zinc-100 disabled:opacity-50"
                    >
                      {boardBusy ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <RefreshCw className="h-3.5 w-3.5" />
                      )}
                      {ideaBoard?.ideas.length ? "Regenerate" : "Find ideas"}
                    </button>
                  ) : (
                    <select
                      value={sort}
                      onChange={(e) => {
                        pinLibraryChrome();
                        setSort(e.target.value as LibrarySort);
                      }}
                      aria-label="Sort"
                      className="shrink-0 rounded-lg border border-zinc-800 bg-zinc-950 px-2 py-2.5 text-[11px] text-zinc-300"
                    >
                      {LIBRARY_SORTS.map((s) => (
                        <option key={s.id} value={s.id}>
                          Sort: {s.label}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-y-2 text-[11px]">
                  <div role="group" aria-label="Kind" className="flex flex-wrap items-center gap-1">
                    {KIND_FILTERS.map((k) => (
                      <button
                        key={k.id}
                        type="button"
                        aria-pressed={kindFilter === k.id}
                        onClick={() => {
                          pinLibraryChrome();
                          setKindFilter((cur) => (cur === k.id ? "" : k.id));
                        }}
                        className={kindFilter === k.id ? chipOn : chipIdle}
                      >
                        {k.label}
                      </button>
                    ))}
                  </div>
                  {accountFilter ? (
                    <button
                      type="button"
                      onClick={() => {
                        pinLibraryChrome();
                        setAccountFilter("");
                      }}
                      className="ml-2 rounded-md border border-violet-500/40 px-1.5 py-0.5 text-violet-200"
                    >
                      @{accounts.find((a) => a.id === accountFilter)?.username ?? accountFilter} ×
                    </button>
                  ) : null}
                  {tagFilter ? (
                    <button
                      type="button"
                      onClick={() => {
                        pinLibraryChrome();
                        setTagFilter("");
                      }}
                      className="ml-2 rounded-md border border-violet-500/40 px-1.5 py-0.5 text-violet-200"
                    >
                      tag:{tagFilter} ×
                    </button>
                  ) : null}
                </div>
              </div>
              <div ref={resultsRef} className="[overflow-anchor:none]">
              {searchingLibrary && searchPending && hits === null ? (
                <p className={libraryEmptyClass}>Searching…</p>
              ) : ideasView ? (
                <div className="flex min-h-full flex-col gap-3">
                  {boardError ? <p className="text-sm text-red-400">{boardError}</p> : null}
                  {boardBusy && ideaRows.length === 0 ? (
                    <p className={libraryEmptyClass}>Finding ideas…</p>
                  ) : ideaRows.length === 0 ? (
                    <p className={libraryEmptyClass}>
                      {searchingLibrary || kindFilter
                        ? "Nothing matches that search."
                        : (ideaBoard?.ideas.length ?? 0) > 0
                          ? "These remakes are already in Workshop. Regenerate to look for new ones."
                          : posts.length
                            ? "Find ideas to pull a short list of strong remakes from this library."
                            : "Paste links above, then find ideas."}
                    </p>
                  ) : (
                    ideaRows.map((idea) => (
                      <IdeaCard
                        key={idea.id}
                        title={idea.title}
                        description={idea.description}
                        posts={idea.posts}
                        workshopByPost={workshopByPost}
                        making={makingIdea === idea.id}
                        onOpen={(id) => openPost(id)}
                        onMake={() => void makeIdea(idea)}
                      />
                    ))
                  )}
                </div>
              ) : visiblePosts.length === 0 ? (
                <p className={libraryEmptyClass}>
                  {libraryEmptyCopy({
                    q,
                    tagFilter,
                    accountFilter,
                    savedForFilter,
                    kindFilter,
                    ideaFilter,
                    knowhow: knowhowView,
                  })}
                </p>
              ) : (
                <div className="flex flex-col gap-4">
                  {grouped.map((g) => (
                    <div key={g.key || "all"}>
                      {g.stack ? (
                        <StackChrome
                          stack={g.stack}
                          count={g.posts.length}
                          avgRank={g.avgRank}
                          avgVirality={g.avgVirality ?? 0}
                          done={g.done ?? 0}
                          onPatch={(patch) => void patchTopic(g.stack!.id, patch)}
                        />
                      ) : g.label ? (
                        <button
                          type="button"
                          onClick={() =>
                            g.accountId
                              ? navigate(`${base}/accounts/${g.accountId}`)
                              : setAccountFilter(g.label.replace(/^@/, ""))
                          }
                          className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-zinc-500 hover:text-zinc-300"
                        >
                          {g.label} · {g.posts.length}
                        </button>
                      ) : null}
                      <div
                        className={
                          searchingLibrary
                            ? "grid grid-cols-1 items-start gap-3 sm:grid-cols-2 lg:grid-cols-3 [&>div]:mb-0"
                            : "columns-1 gap-3 sm:columns-2 lg:columns-3"
                        }
                      >
                        {g.posts.map((p) => {
                          const acc = accounts.find(
                            (a) =>
                              a.id === p.accountId ||
                              (!!p.creator.username && a.username.toLowerCase() === p.creator.username.toLowerCase()),
                          );
                          return (
                            <PostCard
                              key={p.id}
                              post={p}
                              selected={selected.has(p.id)}
                              anySelected={selected.size > 0}
                              avatarUrl={acc?.avatarUrl ? `${acc.avatarUrl}?t=${acc.updatedAt}` : undefined}
                              accountHref={accountPathFor(base, p, accounts)}
                              workshop={workshopByPost.get(p.id)}
                              matches={matchByPost.get(p.id)?.matches}
                              onOpenAccount={(href) => navigate(href)}
                              onSelect={() =>
                                setSelected((cur) => {
                                  const next = new Set(cur);
                                  if (next.has(p.id)) next.delete(p.id);
                                  else next.add(p.id);
                                  return next;
                                })
                              }
                              onOpen={() => openPost(p.id)}
                              onMark={(patch) => void markOne(p.id, patch)}
                            />
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              )}
              </div>
            </div>
            {selected.size > 0 && (
              <div className="pointer-events-none fixed inset-x-0 bottom-[max(1rem,env(safe-area-inset-bottom))] z-40 flex justify-center px-4">
                <div className="pointer-events-auto flex max-w-full flex-wrap items-center justify-center gap-1.5 rounded-xl border border-zinc-800 bg-[#12121a]/95 px-2 py-1.5 text-[11px] shadow-xl backdrop-blur">
                  <select
                    defaultValue=""
                    onChange={(e) => {
                      const v = e.target.value as IdeaStatus | "";
                      if (v) void bulkMark({ ideaStatus: v });
                      e.target.value = "";
                    }}
                    className="rounded-md border border-zinc-800 bg-zinc-950 px-1.5 py-1 text-zinc-200"
                  >
                    <option value="">Set status</option>
                    {IDEA_STATUSES.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                  <select
                    defaultValue=""
                    onChange={(e) => {
                      const v = e.target.value;
                      if (v) void bulkMark({ rank: Number(v) });
                      e.target.value = "";
                    }}
                    className="rounded-md border border-zinc-800 bg-zinc-950 px-1.5 py-1 text-zinc-200"
                  >
                    <option value="">Set rating</option>
                    {Array.from({ length: 5 }, (_, i) => i + 1).map((n) => (
                      <option key={n} value={n}>
                        {n} star{n === 1 ? "" : "s"}
                      </option>
                    ))}
                  </select>
                  <select
                    defaultValue=""
                    onChange={(e) => {
                      const v = e.target.value as SavedFor | "both" | "knowhow" | "";
                      if (v === "both") void bulkMark({ savedFor: ["content", "format"] });
                      else if (v === "knowhow") void bulkMark({ knowhow: true });
                      else if (v) void bulkMark({ savedFor: [v] });
                      e.target.value = "";
                    }}
                    className="rounded-md border border-zinc-800 bg-zinc-950 px-1.5 py-1 text-zinc-200"
                  >
                    <option value="">Kept for</option>
                    <option value="content">Content</option>
                    <option value="format">Format</option>
                    <option value="both">Both</option>
                    <option value="knowhow">{KNOWHOW.label}</option>
                  </select>
                  {selected.size >= 2 && (
                    <button
                      type="button"
                      onClick={() => setStackOpen(true)}
                      className="rounded-md border border-zinc-700 px-2 py-1 text-zinc-200 hover:bg-zinc-800"
                    >
                      Stack as topic
                    </button>
                  )}
                  {stacks.length > 0 && (
                    <select
                      defaultValue=""
                      onChange={(e) => {
                        const v = e.target.value;
                        if (v) void bulkMark({ stackId: v });
                        e.target.value = "";
                      }}
                      className="rounded-md border border-zinc-800 bg-zinc-950 px-1.5 py-1 text-zinc-200"
                    >
                      <option value="">Add to topic</option>
                      {stacks.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.title}
                        </option>
                      ))}
                    </select>
                  )}
                  <button
                    type="button"
                    onClick={() => void unstackSelected()}
                    className="rounded-md border border-zinc-700 px-2 py-1 text-zinc-200 hover:bg-zinc-800"
                  >
                    Unstack
                  </button>
                  <button
                    type="button"
                    onClick={() => navigate(`/workshop?add=${[...selected].join(",")}`)}
                    className="rounded-md border border-zinc-700 px-2 py-1 text-zinc-200 hover:bg-zinc-800"
                    title="Open a Content Workshop session with these posts as sources"
                  >
                    Send to Workshop
                  </button>
                  <button
                    type="button"
                    onClick={() => setRunOpen(true)}
                    className="rounded-md bg-violet-600 px-2.5 py-1 font-semibold text-white hover:bg-violet-500"
                  >
                    Run jobs on {selected.size}
                  </button>
                </div>
              </div>
            )}
            {runOpen && (
              <RunJobsDialog
                title={`Run jobs on ${selected.size} ${selected.size === 1 ? "post" : "posts"}`}
                busy={runBusy}
                onClose={() => setRunOpen(false)}
                onRun={runSelected}
              />
            )}
            {stackOpen && (
              <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-4 sm:items-center">
                <div className="w-full max-w-md rounded-xl border border-zinc-800 bg-[#12121a] p-4">
                  <h3 className="text-sm font-medium text-zinc-100">Stack as one topic</h3>
                  <p className="mt-1 text-[11px] text-zinc-500">
                    Same idea from different posts — the stack shows the average rank.
                  </p>
                  <input
                    autoFocus
                    value={stackDraft}
                    onChange={(e) => setStackDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void stackSelected();
                    }}
                    placeholder="Topic name — first 3 seconds hook, talking-head story…"
                    className="mt-3 w-full rounded-md border border-zinc-800 bg-transparent px-2 py-1.5 text-sm text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-violet-500"
                  />
                  <div className="mt-3 flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => setStackOpen(false)}
                      className="rounded-md px-3 py-1.5 text-xs text-zinc-400 hover:bg-zinc-800"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      disabled={stackDraft.trim().length < 2}
                      onClick={() => void stackSelected()}
                      className="rounded-md bg-violet-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-violet-500 disabled:opacity-50"
                    >
                      Stack {selected.size}
                    </button>
                  </div>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function instagramHandle(profileUrl: string): string {
  const m = /instagram\.com\/([A-Za-z0-9._]+)/i.exec(profileUrl);
  return (m?.[1] || "").toLowerCase();
}

type LibraryGroup = {
  key: string;
  label: string;
  accountId?: string;
  stack?: InstagramStack;
  avgRank?: number;
  avgVirality?: number;
  done?: number;
  posts: InstagramPost[];
};

function StackChrome({
  stack,
  count,
  avgRank: stackAvgRank,
  avgVirality,
  done,
  onPatch,
}: {
  stack: InstagramStack;
  count: number;
  avgRank?: number;
  avgVirality: number;
  done: number;
  onPatch: (patch: { title?: string; ideaStatus?: IdeaStatus }) => void;
}) {
  return (
    <div className="mb-1.5 flex flex-wrap items-center gap-2">
      <input
        key={stack.title}
        defaultValue={stack.title}
        onBlur={(e) => {
          const next = e.currentTarget.value.trim().slice(0, 80);
          if (next.length >= 2 && next !== stack.title) onPatch({ title: next });
          else e.currentTarget.value = stack.title;
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
        className="min-w-[8rem] max-w-[16rem] rounded-md border border-transparent bg-transparent px-1 py-0.5 text-[11px] font-medium uppercase tracking-wider text-violet-300 outline-none hover:border-zinc-800 focus:border-violet-500"
        title="Rename this topic"
      />
      <span className="text-[11px] text-zinc-500">{count} stacked</span>
      <IdeaStatusSelect
        value={stack.ideaStatus}
        onChange={(ideaStatus) => onPatch({ ideaStatus })}
      />
      <span className="text-[11px] text-zinc-400">avg rank {stackAvgRank ?? "—"}</span>
      <span className="text-[11px] text-zinc-500">avg virality {fmtCount(avgVirality)}</span>
      <span className="text-[11px] text-zinc-500">
        {done}/{count} made
      </span>
    </div>
  );
}

function IdeaFields({
  idea,
  onSave,
}: {
  idea?: PostIdea;
  onSave: (idea: PostIdea) => void;
}) {
  const [title, setTitle] = useState(idea?.title ?? "");
  const [takeaway, setTakeaway] = useState(idea?.takeaway ?? "");
  const commit = () => {
    const next = { title: title.trim(), takeaway: takeaway.trim() };
    if (next.title.length < 8 || next.takeaway.length < 12) return;
    if (next.title === (idea?.title ?? "") && next.takeaway === (idea?.takeaway ?? "")) return;
    onSave(next);
  };
  return (
    <div className="flex flex-col gap-1.5">
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
        placeholder="Raising tall kids"
        className="w-full rounded-md border border-zinc-800 bg-transparent px-2 py-1 text-sm text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-violet-500"
      />
      <textarea
        value={takeaway}
        onChange={(e) => setTakeaway(e.target.value)}
        onBlur={commit}
        rows={2}
        placeholder="The one-liner takeaway — what the viewer walks away with"
        className="w-full resize-none rounded-md border border-zinc-800 bg-transparent px-2 py-1 text-[13px] leading-snug text-zinc-300 outline-none placeholder:text-zinc-600 focus:border-violet-500"
      />
    </div>
  );
}

