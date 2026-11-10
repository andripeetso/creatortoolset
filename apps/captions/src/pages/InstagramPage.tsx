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
  ScanSearch,
  Loader2,
  MessageCircle,
  RefreshCw,
  RotateCcw,
  Search,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";
import { canUse, useAuth, useMe } from "@/lib/auth";
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
import { AppBar, ToolIntro } from "@/components/AppBar";
import { openToolSetup } from "@/lib/setup";
import { segmentItem, segmentList } from "@/components/SegmentedTabs";
import { cn } from "@/lib/utils";
import { ProjectSwitcher } from "@/components/workspace/ProjectSwitcher";
import { useWorkspace } from "@/lib/workspace";
import { useCachedList, useCachedLoad } from "@/lib/local-cache";
import { onTopic, whenVisible } from "@/lib/sync";
import { IngestBox } from "@/components/instagram/IngestBox";
import { RunJobsDialog } from "@/components/instagram/RunJobsDialog";
import { TagsEditor } from "@/components/instagram/TagsEditor";
import { IdeaStatusSelect, RankStars, SavedForToggle } from "@/components/instagram/IdeaMark";
import { IdeaCard } from "@/components/instagram/IdeaCard";
import { AccountAvatar, AccountCard, AddMyAccount } from "@/components/instagram/AccountCard";
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
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

/** What refetches the Analyzer's availability: a connector or a key changing (this window's own Settings included). */
const AVAILABILITY_LIVE = { topic: ["connectors", "my-keys", "service-keys"], own: true };

const label =
  "mb-2 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-zinc-500";
const libraryEmptyClass =
  "sticky top-[var(--library-chrome-h,0px)] z-10 bg-zinc-950 py-6 text-center text-sm text-zinc-600";

type LibrarySort = "pulled" | "posted" | "plays" | "account" | "age" | "rank" | "virality";
type LibraryView = "feed" | "ideas" | "knowhow";

/** What the posts were kept for: the same three choices as sharing a post from the phone. */
const KEPT_FOR: { id: SavedFor | "knowhow"; label: string; hint: string }[] = [...SAVED_FOR, { id: "knowhow", ...KNOWHOW }];

const KINDS: { id: PostKind | "all"; label: string }[] = [{ id: "all", label: "All types" }, ...KIND_FILTERS];

const LIBRARY_SORTS: { id: LibrarySort; label: string }[] = [
  { id: "pulled", label: "Recently added" },
  { id: "rank", label: "Rating" },
  { id: "virality", label: "Virality" },
  { id: "posted", label: "Posted" },
  { id: "plays", label: "Plays" },
  { id: "account", label: "Account" },
  { id: "age", label: "Age when saved" },
];

/** The one height and outline of everything in the filter row; the two buttons beside the paste box share the outline. */
const pick = "flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg border border-zinc-800 outline-none";
const beside =
  "flex h-[50px] shrink-0 items-center gap-2.5 whitespace-nowrap rounded-xl border border-zinc-800 px-3.5 outline-none hover:border-zinc-700 hover:bg-zinc-900/60";

/** A filter with one choice out of a few: the button says the current one, the menu has the rest. */
function PickMenu<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { id: T; label: string; hint?: string }[];
  onChange: (id: T) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={label}
          className={cn(pick, "bg-zinc-950 px-2.5 text-[12px] text-zinc-300 hover:border-zinc-700 data-[state=open]:border-zinc-700")}
        >
          {options.find((o) => o.id === value)?.label}
          <ChevronDown className="h-3 w-3 text-zinc-500" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuRadioGroup value={value} onValueChange={(v) => onChange(v as T)}>
          {options.map((o) => (
            <DropdownMenuRadioItem key={o.id} value={o.id} title={o.hint} className="text-xs">
              {o.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

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
  if (opts.ideaFilter === "idea") return "Nothing to make yet.";
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
  /** A Workshop session uses it (it is filed under To make). */
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

  // while it runs: read again each time its job saves (lib/sync.ts; a hidden window waits until shown)
  useEffect(() => {
    if (!processing) return;
    return onTopic("instagram-jobs", () =>
      whenVisible(`instagram-post:${post.id}`, () => void getPost(post.id).then(onChange, () => {})),
    );
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
          title="Run this post"
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
  const me = useMe();
  const required = useAuth((s) => s.required);
  const allowed = canUse(me, "instagram");
  const currentProjectId = useWorkspace((s) => s.currentProjectId);
  // the saved lists show at once and refresh underneath (lib/local-cache); keys carry the project and the filters
  const { items: accounts, known: accountsKnown, setItems: setAccounts, refresh: loadAccounts } = useCachedList<InstagramAccount>(
    `instagram/accounts?p=${currentProjectId ?? ""}`,
    () => listAccounts(),
  );
  const [addingMine, setAddingMine] = useState(false);
  const [showAllAccounts, setShowAllAccounts] = useState(false);
  const [pullingAll, setPullingAll] = useState(false);
  const [pullAllError, setPullAllError] = useState<string | null>(null);
  const [mineError, setMineError] = useState<string | null>(null);
  const [stacks, setStacks] = useState<InstagramStack[]>([]);
  // the open post: saved copy (or its card in the list) at once, live (lib/local-cache)
  const detail = useCachedLoad<InstagramPost>(postId ? `/api/instagram/${postId}` : null, () => getPost(postId!));
  const current = detail.data;
  const setCurrent = detail.set;
  // what the Analyzer can read with: the saved answer paints at once, refreshed underneath and when a connector or key changes
  const { data: avail, refresh: loadAvail } = useCachedLoad<InstagramAvailability>("instagram/availability", getInstagramAvailability, AVAILABILITY_LIVE);
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
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [runOpen, setRunOpen] = useState(false);
  const [runBusy, setRunBusy] = useState(false);
  const distillQueued = useRef(new Set<string>());
  const chromeRef = useRef<HTMLDivElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const pinTop = useRef<number | null>(null);
  const resultsFloor = useRef(0);
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
  const { items: posts, known: postsKnown, setItems: setPosts, refresh: loadPosts } = useCachedList<InstagramPost>(
    `instagram/posts?${JSON.stringify(listQuery())}|p=${currentProjectId ?? ""}`,
    () => listPosts(listQuery()),
  );

  // The filters come with the first post, and the first-run home (the name, one line, the paste box) is only for a
  // project known to hold nothing. The filters hide posts, so an empty list does not say either: once this project has
  // shown a post the filters stay, and a project whose list is empty is asked once for any post at all. Until it
  // answers the page is the full home (an open project never waits on this).
  const seenPostsIn = useRef<string | null | undefined>(undefined);
  if (posts.length) seenPostsIn.current = currentProjectId;
  const [held, setHeld] = useState<{ project: string | null; any: boolean } | null>(null);
  const answered = held?.project === currentProjectId;
  const hasPosts = seenPostsIn.current === currentProjectId || (answered && !!held?.any);
  const started = accounts.length > 0 || hasPosts;
  const fresh = accountsKnown && postsKnown && !started && answered;
  useEffect(() => {
    if (!allowed || !accountsKnown || !postsKnown || hasPosts || answered) return;
    const project = currentProjectId;
    listPosts({ shelf: "all", projectId: project })
      .then((all) => setHeld({ project, any: all.length > 0 }))
      .catch(() => {});
  }, [allowed, accountsKnown, postsKnown, hasPosts, answered, currentProjectId]);

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
    loadPosts().catch(() => {});
  }, [loadPosts]);

  const refreshAccounts = useCallback(() => {
    loadAccounts().catch(() => {});
  }, [loadAccounts]);

  const refreshStacks = useCallback(() => {
    listStacks()
      .then(setStacks)
      .catch(() => {});
  }, []);

  const refreshAvailability = useCallback(() => void loadAvail().catch(() => {}), [loadAvail]);
  // The Apify key lives in Settings → Connectors: re-read it when it changes there.
  useEffect(() => {
    window.addEventListener(INSTAGRAM_CONNECTION_EVENT, refreshAvailability);
    return () => window.removeEventListener(INSTAGRAM_CONNECTION_EVENT, refreshAvailability);
  }, [refreshAvailability]);

  // the Workshop's own saved list (same key as its page), live on the Workshop's changes: no poll while it writes
  const { items: workshopSessions, refresh: loadWorkshop } = useCachedList<SessionRow>(
    allowed ? `workshop/sessions?p=${currentProjectId ?? ""}` : null,
    listSessions,
  );
  const refreshWorkshop = useCallback(() => void loadWorkshop().catch(() => {}), [loadWorkshop]);

  // the posts and the accounts refresh themselves when their key (the project, the filters) changes: useCachedList.
  // Asking again here, and once more 250 ms after a filter, fetched the whole list three times per change.
  useEffect(() => {
    if (!allowed) return;
    refreshStacks();
    refreshAvailability();
  }, [allowed, currentProjectId, refreshStacks, refreshAvailability]);

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

  const postsBusy = posts.some(isProcessing);
  const accountsBusy = accounts.some((a) => a.status === "processing");
  const anyProcessing = postsBusy || accountsBusy;
  useEffect(() => {
    if (!allowed || postId || !anyProcessing) return;
    // Only the list with something running in it, read again when its job saves (at most about once a second, and one
    // read at a time: lib/local-cache joins a read already going). A new step or the end refetches them by itself.
    return onTopic("instagram-jobs", () =>
      whenVisible("instagram-busy-lists", () => {
        if (postsBusy) void loadPosts().catch(() => {});
        if (accountsBusy) void loadAccounts().catch(() => {});
      }),
    );
  }, [allowed, postId, anyProcessing, postsBusy, accountsBusy, loadPosts, loadAccounts]);



  const applyPost = useCallback((p: InstagramPost) => {
    // only the open post's own copy (a list card's job answers too)
    if (p.id === postId) setCurrent((prev) => (prev && p.updatedAt < prev.updatedAt ? prev : p));
    setPosts((list) => {
      const known = list.some((x) => x.id === p.id);
      if (!known) return [p, ...list];
      return list.map((x) => (x.id === p.id && p.updatedAt >= x.updatedAt ? p : x));
    });
  }, [postId, setCurrent, setPosts]);

  useEffect(() => {
    if (!allowed || !avail?.ai) return;
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
  }, [allowed, avail?.ai, posts, applyPost]);

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

  // the saved board is read with the page (its size is on the Ideas button) and again when Ideas opens
  useEffect(() => {
    if (!allowed) return;
    if (libraryView !== "ideas") autoBoard.current = false;
    refreshBoard();
  }, [allowed, libraryView, currentProjectId, refreshBoard]);

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
    if (posts.length) setHeld({ project: currentProjectId, any: true });
    refreshAccounts();
    if (posts.length === 1 && errors.length === 0 && !payload.profiles.length) {
      navigate(`${base}/${posts[0].id}`);
    } else {
      navigate(base);
    }
    if (!posts.length) throw new Error(errors[0]?.error || notes[0] || "Couldn’t save these posts");
    if (errors.length || notes.length) {
      return `${posts.length} saved. ${errors.length + notes.length} couldn’t be saved: ${errors[0]?.error || notes[0]}`;
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

  const viewing = postId ? (current?.id === postId ? current : (posts.find((p) => p.id === postId) ?? null)) : null;
  const routeError = postId && !viewing ? detail.error || null : null;
  const opening = Boolean(postId && !viewing && !routeError);
  const ownsCurrent =
    !!me && !!viewing && (me.role === "admin" || me.username === viewing.owner);
  // the one thing this tool still needs, in the person's words; Set up holds the how
  const cantRead = !!avail && !avail.available;
  const needs = !avail
    ? null
    : avail.apify?.valid === false
      ? "Your Apify key isn’t working"
      : cantRead
        ? avail.graph?.configured
          ? "Can’t read other creators’ posts yet"
          : "Can’t read Instagram posts yet"
        : !avail.ai
          ? "No AI to work out the ideas yet"
          : null;

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
  // your account is the button beside the paste box, and nowhere else: not in the list, its count or its action
  const myAccount = accounts.find((a) => a.own);
  const others = accounts.filter((a) => a !== myAccount);
  // accounts that are here only because one of their posts was saved: their profile was never read
  const savedOnlyAccounts = others.filter((a) => !isReferenceAccount(a));
  const otherAccounts = [...others.filter(isReferenceAccount), ...savedOnlyAccounts];
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
    if (errors.length) setPullAllError(`${errors.length} not started. ${errors[0]}`);
  };
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
    <div className="relative flex min-h-dvh flex-col items-center bg-zinc-950 pb-[max(2.5rem,env(safe-area-inset-bottom))] text-zinc-200">
      <AppBar tool="Content Analyzer" to={postId ? base : undefined} trail={viewing ? `@${viewing.creator.username}` : undefined} account={!!me}>
        {me ? (
          <>
            <QueueMenu
              base={base}
              onChange={() => {
                refreshList();
                refreshAccounts();
              }}
            />
            {/* an open post belongs to the project being left: the other project opens on its own list */}
            <ProjectSwitcher onSelect={() => (postId ? navigate(base) : undefined)} />
          </>
        ) : required ? (
          <Link to={home} className="rounded-md px-2 py-1.5 text-xs text-zinc-500 hover:text-zinc-200">
            Sign in
          </Link>
        ) : null}
      </AppBar>

      {!postId && fresh && (
        <ToolIntro
          icon={ScanSearch}
          title="Content Analyzer"
          line="Collect posts you like. The AI works out the idea in each one. You rank them."
        />
      )}

      {/* with posts the grid runs across the window; a project with nothing in it is the name, one line and the paste box */}
      <div className={postId ? "mt-6 w-full" : fresh ? "w-[760px] max-w-[92vw]" : "w-full max-w-[1640px] px-4 pt-6 sm:px-8"}>
        {opening ? (
          // the post's frame, empty, so nothing jumps when it arrives
          <div aria-busy="true" aria-label="Opening post" className="mx-auto h-[70vh] w-[760px] max-w-[92vw] rounded-xl bg-zinc-900/40" />
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
            <div className={fresh ? "" : "flex flex-col gap-3 lg:flex-row lg:items-start"}>
              <div className="min-w-0 flex-1">
                <IngestBox defaultValue={sharePrefill} nowDisabled={cantRead} onIngest={onIngest} />
              </div>
              {fresh ? null : (
                <div className="flex min-w-0 gap-3">
                  {myAccount ? (
                    <Link to={`${base}/accounts/${myAccount.id}`} aria-label={`Your account, @${myAccount.username}`} className={beside}>
                      <AccountAvatar account={myAccount} className="h-7 w-7" />
                      <span className="truncate text-sm font-medium text-zinc-100">@{myAccount.username}</span>
                      {myAccount.counts.fetchedAt > 0 ? (
                        <span className="text-xs text-zinc-500">{fmtCount(myAccount.counts.followers)} followers</span>
                      ) : null}
                    </Link>
                  ) : hasPosts ? (
                    <AddMyAccount busy={addingMine} error={mineError} onAdd={addMine} className={cn(beside, "text-sm text-zinc-300")} />
                  ) : null}
                  {otherAccounts.length ? (
                    <button
                      type="button"
                      aria-expanded={showAllAccounts}
                      onClick={() => setShowAllAccounts((v) => !v)}
                      className={cn(beside, showAllAccounts && "border-zinc-700 bg-zinc-900/60")}
                    >
                      <span className="flex shrink-0 -space-x-2">
                        {otherAccounts.slice(0, 5).map((a) => (
                          <AccountAvatar key={a.id} account={a} className="h-6 w-6 ring-2 ring-zinc-950" />
                        ))}
                      </span>
                      <span className="text-sm text-zinc-300">
                        {otherAccounts.length} {otherAccounts.length === 1 ? "account" : "accounts"}
                      </span>
                      <ChevronDown className={cn("h-3.5 w-3.5 text-zinc-500 transition-transform", showAllAccounts && "rotate-180")} />
                    </button>
                  ) : null}
                </div>
              )}
            </div>
            {needs ? (
              <p className="mt-3 flex items-center gap-2 text-xs text-zinc-400">
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" />
                {needs}
                <button
                  type="button"
                  onClick={() => openToolSetup("instagram")}
                  className="font-medium text-zinc-200 underline underline-offset-2"
                >
                  Set up
                </button>
              </p>
            ) : null}
            {showAllAccounts && otherAccounts.length && !fresh ? (
              <div className="mt-3 rounded-xl border border-zinc-800 p-2">
                {unpulledAccounts.length ? (
                  <div className="mb-2 flex flex-wrap items-center gap-2 px-1 pt-1 text-xs">
                    <button
                      type="button"
                      disabled={pullingAll || cantRead}
                      onClick={() => void pullUnpulled()}
                      title="Their profile and latest posts, one account after another"
                      className="flex items-center gap-1.5 rounded-md border border-zinc-700 px-2.5 py-1 text-zinc-200 hover:bg-zinc-800 disabled:opacity-50"
                    >
                      {pullingAll ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                      Read the {unpulledAccounts.length} missing {unpulledAccounts.length === 1 ? "profile" : "profiles"}
                    </button>
                    {pullAllError ? <span className="text-zinc-500">{pullAllError}</span> : null}
                  </div>
                ) : null}
                <div className="grid max-h-[min(60vh,34rem)] gap-2 overflow-y-auto sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                  {otherAccounts.map((a) => (
                    <AccountCard key={a.id} account={a} to={`${base}/accounts/${a.id}`} />
                  ))}
                </div>
              </div>
            ) : null}

            {/* filters appear with the first post */}
            {hasPosts ? (
            <div className={selected.size > 0 ? "pb-16" : ""}>
              <div ref={chromeRef} className="sticky top-0 z-20 flex flex-wrap items-center gap-2 bg-zinc-950 pb-4 pt-5">
                {knowhowView ? null : (
                  <>
                    <div role="radiogroup" aria-label="Status" className={cn(segmentList, "shrink-0")}>
                      {STATUS_FILTERS.map((s) => {
                        const on = !ideasView && ideaFilter === s.id;
                        return (
                          <button
                            key={s.id || "all"}
                            type="button"
                            role="radio"
                            aria-checked={on}
                            onClick={() => {
                              pinLibraryChrome();
                              setIdeaFilter(s.id);
                              setLibraryView("feed");
                            }}
                            className={segmentItem(on)}
                          >
                            {s.label}
                            {on && !searchPending ? <span className="ml-1.5 tabular-nums opacity-70">{visiblePosts.length}</span> : null}
                          </button>
                        );
                      })}
                    </div>
                    <button
                      type="button"
                      aria-pressed={ideasView}
                      onClick={() => {
                        pinLibraryChrome();
                        setSavedForFilter("content");
                        setLibraryView("ideas");
                      }}
                      className={cn(
                        pick,
                        "px-3 text-sm font-medium transition-colors",
                        ideasView ? "border-violet-500/40 bg-violet-600/25 text-violet-100" : "text-zinc-400 hover:text-zinc-200",
                      )}
                    >
                      Ideas
                      {ideaBoard?.ideas.length ? <span className="tabular-nums opacity-70">{ideaBoard.ideas.length}</span> : null}
                    </button>
                  </>
                )}
                {accountFilter ? (
                  <button
                    type="button"
                    onClick={() => {
                      pinLibraryChrome();
                      setAccountFilter("");
                    }}
                    aria-label="Show every account"
                    className={cn(pick, "border-violet-500/40 px-2.5 text-[12px] text-violet-200")}
                  >
                    @{accounts.find((a) => a.id === accountFilter)?.username ?? accountFilter}
                    <X className="h-3 w-3" />
                  </button>
                ) : null}
                {tagFilter ? (
                  <button
                    type="button"
                    onClick={() => {
                      pinLibraryChrome();
                      setTagFilter("");
                    }}
                    aria-label="Show every tag"
                    className={cn(pick, "border-violet-500/40 px-2.5 text-[12px] text-violet-200")}
                  >
                    {tagFilter}
                    <X className="h-3 w-3" />
                  </button>
                ) : null}
                <div className="ml-auto flex min-w-0 flex-wrap items-center gap-2">
                  <div className={cn(pick, "w-[260px] min-w-[120px] flex-[0_1_260px] bg-zinc-900/50 px-3 focus-within:border-violet-500/50")}>
                    {searching || searchPending ? (
                      <Loader2 className="h-4 w-4 shrink-0 animate-spin text-violet-400" />
                    ) : (
                      <Search className="h-4 w-4 shrink-0 text-zinc-500" />
                    )}
                    <input
                      value={q}
                      onChange={(e) => setQ(e.target.value)}
                      placeholder="Search"
                      aria-label="Search posts"
                      className="min-w-0 flex-1 bg-transparent text-sm text-zinc-200 outline-none placeholder:text-zinc-600"
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
                  {ideasView ? null : (
                    <PickMenu
                      label="Kept for"
                      value={knowhowView ? "knowhow" : savedForFilter}
                      options={KEPT_FOR}
                      onChange={(id) => {
                        pinLibraryChrome();
                        if (id === "knowhow") return setLibraryView("knowhow");
                        setSavedForFilter(id);
                        setLibraryView("feed");
                      }}
                    />
                  )}
                  <PickMenu
                    label="Type"
                    value={kindFilter || "all"}
                    options={KINDS}
                    onChange={(id) => {
                      pinLibraryChrome();
                      setKindFilter(id === "all" ? "" : id);
                    }}
                  />
                  {ideasView ? (
                    <button
                      type="button"
                      disabled={boardBusy || !avail?.ai}
                      onClick={() => void runGenerateBoard()}
                      className={cn(pick, "bg-zinc-950 px-2.5 text-[12px] text-zinc-300 hover:border-zinc-700 disabled:opacity-50")}
                    >
                      {boardBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                      {ideaBoard?.ideas.length ? "Regenerate" : "Find ideas"}
                    </button>
                  ) : (
                    <PickMenu
                      label="Sort"
                      value={sort}
                      options={LIBRARY_SORTS}
                      onChange={(id) => {
                        pinLibraryChrome();
                        setSort(id);
                      }}
                    />
                  )}
                </div>
              </div>
              <div ref={resultsRef} className="[overflow-anchor:none]">
              {searchingLibrary && searchPending && hits === null ? (
                <p className={libraryEmptyClass}>Searching…</p>
              ) : ideasView ? (
                <div className="flex min-h-full flex-col gap-3">
                  {boardError ? <p className="text-sm text-red-400">{boardError}</p> : null}
                  {ideaBoard?.generatedAt && ideaBoard.usage ? (
                    <p
                      className="text-[11px] text-zinc-500"
                      title="Made by Claude on your Mac (your subscription): measured tokens, and what the API would have charged"
                    >
                      Claude (Mac) · {(ideaBoard.usage.tokens / 1000).toFixed(1)}k tokens · ${ideaBoard.usage.costUsd.toFixed(2)} API-equivalent
                    </p>
                  ) : null}
                  {boardBusy && ideaRows.length === 0 ? (
                    <p className={libraryEmptyClass}>Finding ideas…</p>
                  ) : ideaRows.length === 0 ? (
                    <p className={libraryEmptyClass}>
                      {searchingLibrary || kindFilter
                        ? "Nothing matches that search."
                        : (ideaBoard?.ideas.length ?? 0) > 0
                          ? "These remakes are already in Workshop. Regenerate to look for new ones."
                          : posts.length
                            ? "Find ideas to get a short list of strong remakes from your saved posts."
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
                          // a search keeps its ranking left to right; the feed flows down the columns
                          searchingLibrary
                            ? "grid grid-cols-[repeat(auto-fill,minmax(min(100%,225px),1fr))] items-start gap-3"
                            : "gap-3 [column-width:225px] [&>div]:break-inside-avoid [&>div]:pb-3"
                        }
                      >
                        {g.posts.map((p) => {
                          const acc = accounts.find(
                            (a) =>
                              a.id === p.accountId ||
                              (!!p.creator.username && a.username.toLowerCase() === p.creator.username.toLowerCase()),
                          );
                          return (
                            <div key={p.id}>
                            <PostCard
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
                              onRetry={cantRead ? undefined : () => retryPost(p.id).then(applyPost)}
                            />
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              )}
              </div>
            </div>
            ) : null}
            {selected.size > 0 && (
              <div className="pointer-events-none fixed inset-x-0 bottom-[max(1rem,env(safe-area-inset-bottom))] z-40 flex justify-center px-4">
                <div className="pointer-events-auto flex max-w-full flex-wrap items-center justify-center gap-1.5 rounded-xl border border-zinc-800 bg-zinc-925/95 px-2 py-1.5 text-[11px] shadow-xl backdrop-blur">
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
                    Run {selected.size}
                  </button>
                </div>
              </div>
            )}
            {runOpen && (
              <RunJobsDialog
                title={`Run ${selected.size} ${selected.size === 1 ? "post" : "posts"}`}
                busy={runBusy}
                onClose={() => setRunOpen(false)}
                onRun={runSelected}
              />
            )}
            {stackOpen && (
              <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-4 sm:items-center">
                <div className="w-full max-w-md rounded-xl border border-zinc-800 bg-zinc-925 p-4">
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
        placeholder="Growing tall sunflowers"
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

