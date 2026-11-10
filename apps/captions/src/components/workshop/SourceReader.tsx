import { useEffect, useState } from "react";
import { onTopic } from "@/lib/sync";
import { AtSign, BarChart3, Check, ChevronLeft, ChevronRight, ExternalLink, Plus } from "lucide-react";
import { Link } from "react-router";
import {
  fmtCount,
  fmtDate,
  getPost,
  getSlideTranscript,
  isProcessing,
  runPostJobs,
  postBadgeClass,
  postBadgeLabel,
  type InstagramPost,
  type SavedFor,
  type TranscriptWord,
} from "@/lib/instagram";
import { SavedForToggle } from "@/components/instagram/IdeaMark";
import { CommentsList } from "@/components/instagram/CommentsList";
import { SlidePanel } from "@/components/instagram/SlidePanel";
import { SlideViewer, type SeekRequest } from "@/components/instagram/SlideViewer";
import type { AuditDepth } from "@/lib/workshop";
import { AuditButton } from "./AuditButton";

/**
 * Read one source: media, on-screen text and transcript, comments — read-only.
 * Shift+←/→ moves between the session's sources (plain arrows step slides).
 * Mount with key={post.id} so slide position and transcripts reset per source.
 */
export function SourceReader({
  post: given,
  at,
  total,
  onPrev,
  onNext,
  onAdd,
  onSlide,
  onAudit,
  onSavedFor,
  onOpenCreator,
  analyzerHref,
  onTag,
  tagged,
  researchAvailable,
  auditBusy,
}: {
  post: InstagramPost;
  /** Position among the session's sources, or -1 when previewing a search hit. */
  at: number;
  total: number;
  onPrev: () => void;
  onNext: () => void;
  onAdd?: () => void;
  onSlide?: (n: number) => void;
  onAudit?: (depth: AuditDepth) => void;
  onSavedFor?: (next: SavedFor[]) => void;
  /** Open the creator's account in the Analyzer (more of their posts to pull). */
  onOpenCreator?: () => void;
  /** This post in the Content Analyzer: every job and action. */
  analyzerHref?: string;
  /** Tag the whole video in the chat: the next message is about it. */
  onTag?: () => void;
  tagged?: boolean;
  researchAvailable?: boolean;
  auditBusy?: boolean;
}) {
  // a transcript made from here: this copy follows the jobs until they're done (the session's copy catches up on its own)
  const [fresh, setFresh] = useState<InstagramPost | null>(null);
  const post = fresh && fresh.id === given.id ? fresh : given;
  const [readError, setReadError] = useState<string | null>(null);
  const read = () => {
    setReadError(null);
    const failed = post.slides.some((s) => s.transcript.status === "error" || s.vision.status === "error");
    runPostJobs(post.id, { types: ["transcript", "vision"], force: failed })
      .then(setFresh)
      .catch((e: unknown) => setReadError(e instanceof Error ? e.message : String(e)));
  };
  const working = isProcessing(post);
  // Never made: opening a saved post makes its transcript
  // and on-screen text, once. A failed one waits for a click on its chip.
  const missing = post.slides.some(
    (sl) => sl.vision.status === "pending" || (sl.kind === "video" && sl.hasAudio !== false && sl.transcript.status === "pending"),
  );
  useEffect(() => {
    if (!missing || working) return;
    runPostJobs(post.id, { types: ["transcript", "vision"] }).then(setFresh).catch(() => {});
    // once per post: the polling below follows the run
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [post.id]);
  // follows the run from the Analyzer's job notices (each save, at most one a second): no timer
  useEffect(() => {
    if (!fresh || !working) return;
    return onTopic("instagram-jobs", () => void getPost(post.id).then(setFresh).catch(() => {}));
  }, [fresh, working, post.id]);
  const [index, setIndexState] = useState(0);
  const setIndex = (i: number) => {
    setIndexState(i);
    onSlide?.(i);
  };
  const [seek, setSeek] = useState<SeekRequest | null>(null);
  const [transcripts, setTranscripts] = useState<Record<number, TranscriptWord[]>>({});

  const wanted = post.slides
    .filter((s) => s.transcript.status === "done")
    .map((s) => s.index)
    .join(",");

  useEffect(() => {
    if (!wanted) return;
    let stopped = false;
    for (const raw of wanted.split(",")) {
      const i = Number(raw);
      getSlideTranscript(post.id, i)
        .then(({ words }) => {
          if (!stopped) setTranscripts((cur) => (cur[i] ? cur : { ...cur, [i]: words }));
        })
        .catch(() => {});
    }
    return () => {
      stopped = true;
    };
  }, [post.id, wanted]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.shiftKey || e.metaKey || e.altKey || e.ctrlKey) return;
      if (e.key === "ArrowLeft") onPrev();
      else if (e.key === "ArrowRight") onNext();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onPrev, onNext]);

  const seekTo = (slide: number, t: number) => {
    setIndex(slide);
    setSeek({ index: slide, t, key: Date.now() });
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        {at >= 0 ? (
          <>
            <button type="button" onClick={onPrev} disabled={at <= 0} className="rounded-md border border-zinc-800 p-1 text-zinc-300 hover:bg-zinc-800 disabled:opacity-40" title="Previous source (Shift+←)">
              <ChevronLeft className="h-3.5 w-3.5" />
            </button>
            <span className="tabular-nums text-zinc-500">
              {at + 1} / {total}
            </span>
            <button type="button" onClick={onNext} disabled={at >= total - 1} className="rounded-md border border-zinc-800 p-1 text-zinc-300 hover:bg-zinc-800 disabled:opacity-40" title="Next source (Shift+→)">
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </>
        ) : (
          <>
            <span className="rounded-md border border-dashed border-zinc-700 px-1.5 py-0.5 text-[10px] text-zinc-500">Preview · not in session</span>
            {onAdd ? (
              <button type="button" onClick={onAdd} className="flex items-center gap-1 rounded-md bg-violet-600 px-2 py-1 text-[11px] font-medium text-white hover:bg-violet-500">
                <Plus className="h-3 w-3" /> Add to session
              </button>
            ) : null}
          </>
        )}
        <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${postBadgeClass(post)}`}>{postBadgeLabel(post)}</span>
        {onSavedFor ? (
          <SavedForToggle value={post.savedFor} onChange={onSavedFor} />
        ) : post.savedFor?.includes("format") ? (
          <span className="rounded-md border border-violet-500/40 bg-violet-500/10 px-1.5 py-0.5 text-[10px] text-violet-200">Format</span>
        ) : null}
        {onOpenCreator ? (
          <button type="button" onClick={onOpenCreator} className="font-medium text-zinc-200 hover:text-violet-300 hover:underline" title={`Open @${post.creator.username} in the Analyzer: pull more of their posts`}>
            @{post.creator.username}
          </button>
        ) : (
          <span className="font-medium text-zinc-200">@{post.creator.username}</span>
        )}
        {post.takenAt ? <span className="text-zinc-500">{fmtDate(post.takenAt)}</span> : null}
        {post.counts.plays !== undefined ? <span className="text-zinc-500">{fmtCount(post.counts.plays)} plays</span> : null}
        <span className="ml-auto flex items-center gap-2">
          {onTag ? (
            <button
              type="button"
              onClick={onTag}
              disabled={tagged}
              className={`flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-medium ${tagged ? "border-violet-500/40 bg-violet-500/10 text-violet-200" : "border-zinc-700 text-zinc-200 hover:bg-zinc-800"}`}
              title="Add this whole video to your next chat message: the AI reads its transcript and caption"
            >
              {tagged ? <Check className="h-3 w-3" /> : <AtSign className="h-3 w-3" />} {tagged ? "Tagged in chat" : "Tag in chat"}
            </button>
          ) : null}
          {onAudit ? <AuditButton available={researchAvailable ?? false} busy={auditBusy ?? false} onAudit={onAudit} /> : null}
          {analyzerHref ? (
            <Link to={analyzerHref} className="flex items-center gap-1 text-zinc-500 hover:text-zinc-200" title="Open this post in the Content Analyzer: transcript, on-screen text, comments and every other action">
              <BarChart3 className="h-3 w-3" /> Analyzer
            </Link>
          ) : null}
          <a href={post.url} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-zinc-500 hover:text-zinc-200">
            <ExternalLink className="h-3 w-3" /> {post.platform === "youtube" ? "YouTube" : "Instagram"}
          </a>
        </span>
      </div>
      <div className="flex flex-col gap-4 xl:flex-row">
        <div className="w-full shrink-0 xl:w-[320px]">
          <SlideViewer post={post} index={index} onIndex={setIndex} seek={seek} />
        </div>
        <div className="min-w-0 flex-1">
          <SlidePanel post={post} index={index} onIndex={setIndex} transcripts={transcripts} onSeek={seekTo} onRead={read} />
          {readError ? <p className="mt-2 text-[11px] text-red-300">{readError}</p> : null}
          {post.caption.trim() ? (
            <div className="mt-4">
              <p className="mb-1 text-[11px] font-medium uppercase tracking-wider text-zinc-500">Caption</p>
              <p data-ctx={JSON.stringify({ postId: post.id, handle: post.creator.username, field: "caption" })} className="whitespace-pre-wrap text-sm leading-relaxed text-zinc-300">
                {post.caption.trim()}
              </p>
            </div>
          ) : null}
        </div>
      </div>
      <CommentsList post={post} owns={false} onChange={() => {}} />
      {post.platform !== "youtube" && !working && ["skipped", "failed", "pending"].includes(post.comments.status) ? (
        <button
          type="button"
          onClick={() => {
            setReadError(null);
            runPostJobs(post.id, { types: ["comments"], force: true })
              .then(setFresh)
              .catch((e: unknown) => setReadError(e instanceof Error ? e.message : String(e)));
          }}
          className="-mt-2 self-start rounded-md border border-zinc-700 px-2 py-1 text-[11px] text-zinc-200 hover:bg-zinc-800"
        >
          Collect comments
        </button>
      ) : null}
    </div>
  );
}
