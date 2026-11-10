import { useEffect, useState } from "react";
import { Heart, Loader2, MessageCircle, RefreshCw } from "lucide-react";
import {
  fmtCount,
  getPostComments,
  QUESTION_MIN,
  rankComments,
  refetchComments,
  type InstagramComment,
  type InstagramPost,
} from "@/lib/instagram";

const KIND_LABEL: Partial<Record<NonNullable<InstagramComment["judged"]>["kind"], string>> = {
  question: "question",
  pushback: "pushback",
  story: "story",
  keyword: "keyword reply",
};
import { timeAgo } from "@/lib/exports";

function CommentRow({ c, depth, ctx }: { c: InstagramComment; depth: number; ctx?: string }) {
  return (
    <li className={depth ? "ml-6 border-l border-zinc-800 pl-3" : ""}>
      <div className="flex items-baseline gap-2">
        <span className="text-xs font-medium text-zinc-200">@{c.user.username}</span>
        <span className="text-[11px] text-zinc-600">{timeAgo(c.createdAt)}</span>
        {c.likeCount > 0 && (
          <span className="flex items-center gap-0.5 text-[11px] text-zinc-500">
            <Heart className="h-3 w-3" /> {fmtCount(c.likeCount)}
          </span>
        )}
        {c.judged && KIND_LABEL[c.judged.kind] && !c.lowValue && (
          <span
            title={`Worth reading: ${Math.round(c.judged.worth * 100)}%`}
            className={`rounded px-1 text-[10px] ${
              c.judged.kind === "question"
                ? "bg-violet-500/15 text-violet-300"
                : c.judged.kind === "pushback"
                  ? "bg-amber-500/15 text-amber-300"
                  : "bg-zinc-800 text-zinc-400"
            }`}
          >
            {KIND_LABEL[c.judged.kind]}
          </span>
        )}
        {c.lowValue && (
          <span className="rounded bg-zinc-800 px-1 text-[10px] text-zinc-500">
            {c.judged?.kind === "keyword" ? "keyword reply" : "low value"}
          </span>
        )}
      </div>
      <p data-ctx={ctx} className="whitespace-pre-wrap text-sm text-zinc-300">{c.text}</p>
      {c.replies?.length ? (
        <ul className="mt-1.5 flex flex-col gap-2">
          {c.replies.map((r) => (
            <CommentRow key={r.id} c={r} depth={depth + 1} ctx={ctx} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/**
 * Comments with nested replies, most worth reading first when Jev scored
 * them. Low-value comments are hidden by default; the toggle shows them.
 * "Questions" narrows to the ones worth answering.
 */
export function CommentsList({
  post,
  owns,
  onChange,
  onLoaded,
}: {
  post: InstagramPost;
  owns: boolean;
  onChange: (p: InstagramPost) => void;
  onLoaded?: (comments: InstagramComment[]) => void;
}) {
  /** Provenance for text selection: a comment is audience reaction, the lowest-value field. */
  const ctx = JSON.stringify({ postId: post.id, handle: post.creator.username, field: "comments" });
  const [showAll, setShowAll] = useState(false);
  const [onlyQuestions, setOnlyQuestions] = useState(false);
  const [comments, setComments] = useState<InstagramComment[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const summary = post.comments;
  const processing = post.status === "processing";

  useEffect(() => {
    if (!post.hasComments) {
      setComments([]);
      return;
    }
    let cancelled = false;
    getPostComments(post.id, showAll)
      .then((f) => {
        if (cancelled) return;
        setComments(f.comments);
        onLoaded?.(f.comments);
      })
      .catch(() => {
        if (!cancelled) setComments([]);
      });
    return () => {
      cancelled = true;
    };
    // reload when the summary changes (a refetch finished)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [post.id, post.hasComments, showAll, summary.fetchedAt, summary.status]);

  const fetchMore = async (more: boolean) => {
    setBusy(true);
    setError(null);
    try {
      onChange(await refetchComments(post.id, more));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const chip = (() => {
    switch (summary.status) {
      // only what is not plain from the list below: how many are here when that is not all, and a failure
      case "complete":
        return "";
      case "capped":
        return `${summary.count} here`;
      case "failed":
        return "Couldn't get them";
      case "skipped":
        return "";
      default:
        return "pending";
    }
  })();
  const chipColor = summary.status === "failed" ? "text-amber-400" : "text-zinc-400";

  return (
    <div className="mt-6">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h3 className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-zinc-500">
          <MessageCircle className="h-3.5 w-3.5" /> Comments
          {post.counts.comments !== undefined && (
            <span className="text-zinc-600">· {fmtCount(post.counts.comments)} on Instagram</span>
          )}
        </h3>
        {chip ? <span className={`text-[11px] ${chipColor}`}>{chip}</span> : null}
        {summary.questions ? (
          <button
            type="button"
            onClick={() => setOnlyQuestions((v) => !v)}
            className={`rounded-md px-1.5 py-0.5 text-[11px] ${
              onlyQuestions
                ? "bg-violet-500/20 text-violet-200"
                : "text-violet-300 hover:bg-violet-500/10"
            }`}
          >
            {summary.questions} question{summary.questions === 1 ? "" : "s"}
          </button>
        ) : null}
        {summary.keywords ? (
          <span
            className="text-[11px] text-zinc-500"
            title="Replies that are just the call-to-action word"
          >
            {summary.keywords} keyword {summary.keywords === 1 ? "reply" : "replies"}
          </span>
        ) : null}
        {summary.filteredOut ? (
          <button
            type="button"
            onClick={() => setShowAll((v) => !v)}
            className="text-[11px] text-zinc-500 underline-offset-2 hover:text-zinc-300 hover:underline"
          >
            {showAll ? "hide" : "show"} {summary.filteredOut} low-value
          </button>
        ) : null}
        {owns && !processing && (
          <span className="ml-auto flex items-center gap-2">
            {summary.status === "capped" ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => void fetchMore(true)}
                className="flex items-center gap-1 rounded-md border border-zinc-700 px-2 py-1 text-[11px] text-zinc-200 hover:bg-zinc-800 disabled:opacity-50"
              >
                {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : null} Get more
              </button>
            ) : null}
            <button
              type="button"
              disabled={busy}
              onClick={() => void fetchMore(false)}
              className="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 disabled:opacity-50"
            >
              <RefreshCw className="h-3 w-3" />
              {summary.status === "skipped" || summary.status === "pending" ? "Get the comments" : "Get them again"}
            </button>
          </span>
        )}
      </div>
      {error && <p className="mb-2 text-xs text-red-400">{error}</p>}
      {comments === null || comments.length === 0 ? null : (
        <ul className="flex flex-col gap-3">
          {rankComments(comments)
            .filter((c) => !onlyQuestions || (c.judged?.needsAnswer ?? 0) >= QUESTION_MIN)
            .map((c) => (
              <CommentRow key={c.id} c={c} depth={0} ctx={ctx} />
            ))}
        </ul>
      )}
    </div>
  );
}
