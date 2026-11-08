import { useState } from "react";
import { Check, CircleDashed, ExternalLink, Instagram, Loader2, RotateCw, Search, TriangleAlert, X } from "lucide-react";
import { SlideViewer } from "@/components/instagram/SlideViewer";
import {
  KNOWHOW,
  SHELVES,
  onShelf,
  fmtCount,
  kindLabel,
  needsRun,
  postHealth,
  postMatchesText,
  retryPost,
  thumbUrl,
  type PostHealth,
  type InstagramPost,
  type ShelfFilter,
  openPostLabel,
} from "@/lib/instagram";
import { timeAgo } from "@/lib/exports";

function statusLine(post: InstagramPost, health: PostHealth): string {
  switch (health) {
    case "failed":
      return post.error || "Couldn't crawl this one";
    case "stuck":
      return `Stuck since ${timeAgo(post.updatedAt)}`;
    case "partial": {
      const bad = post.jobs?.find((j) => j.status === "error");
      return `Part failed${bad ? ` (${bad.type})` : ""}${bad?.error ? `: ${bad.error}` : ""}`;
    }
    case "waiting":
      return "Not crawled yet";
    case "working": {
      const pct = Math.round(Math.max(0, Math.min(1, post.progress)) * 100);
      if (post.step === "queued") return "Waiting in the queue";
      return pct ? `Crawling · ${pct}%` : "Crawling";
    }
    default:
      return post.pulledAt ? timeAgo(post.pulledAt) : "Saved";
  }
}

const HEALTH_TEXT: Record<PostHealth, string> = {
  working: "text-violet-300",
  stuck: "text-amber-300",
  failed: "text-red-400",
  partial: "text-amber-300",
  waiting: "text-zinc-400",
  done: "text-zinc-500",
};

function HealthIcon({ health }: { health: PostHealth }) {
  if (health === "working") return <Loader2 className="h-3 w-3 shrink-0 animate-spin" />;
  if (health === "done") return <Check className="h-3 w-3 shrink-0 text-emerald-400" />;
  if (health === "waiting") return <CircleDashed className="h-3 w-3 shrink-0" />;
  return <TriangleAlert className="h-3 w-3 shrink-0" />;
}

const PAGE = 30;

/**
 * Everything in the Analyzer, on a phone: filter by why it was kept, search,
 * tap a post to watch it with its caption, numbers and idea.
 */
export function MobileAnalyzerLibrary({ posts, onChanged }: { posts: InstagramPost[]; onChanged?: () => void }) {
  const [shelf, setShelf] = useState<ShelfFilter | "due">("all");
  const [q, setQ] = useState("");
  const [limit, setLimit] = useState(PAGE);
  const [openId, setOpenId] = useState<string | null>(null);
  const [running, setRunning] = useState<Set<string>>(new Set());
  const [runError, setRunError] = useState("");

  const due = posts.filter((p) => needsRun(postHealth(p)));
  const shown = posts.filter(
    (p) => (shelf === "due" ? needsRun(postHealth(p)) : onShelf(p, shelf)) && (!q.trim() || postMatchesText(p, q)),
  );
  const open = posts.find((p) => p.id === openId) ?? null;

  /** Run the posts again, one request each; the server queues them. */
  const run = async (list: InstagramPost[]) => {
    setRunError("");
    setRunning((cur) => new Set([...cur, ...list.map((p) => p.id)]));
    for (const p of list) {
      try {
        await retryPost(p.id);
      } catch (e) {
        setRunError(e instanceof Error ? e.message : String(e));
        break; // the same reason (no Instagram connection) stops the rest too
      }
    }
    setRunning(new Set());
    onChanged?.();
  };

  return (
    <div>
      <p className="mb-2 text-xs text-zinc-500">In the Analyzer · {posts.length}</p>
      {due.length > 0 && (
        <div className="mb-2 flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[13px] text-amber-200">
          <TriangleAlert className="h-4 w-4 shrink-0" />
          <span className="min-w-0 flex-1">
            {due.length} {due.length === 1 ? "post needs" : "posts need"} a run
          </span>
          <button
            type="button"
            disabled={running.size > 0}
            onClick={() => void run(due)}
            className="flex min-h-8 items-center gap-1 rounded-md bg-amber-500/20 px-2.5 text-[12px] font-medium active:bg-amber-500/30 disabled:opacity-50"
          >
            {running.size > 0 ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCw className="h-3.5 w-3.5" />}
            Run them all
          </button>
        </div>
      )}
      {runError && <p className="mb-2 text-xs text-red-400">{runError}</p>}
      <div className="mb-2 flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900/50 px-2.5 focus-within:border-violet-500">
        <Search className="h-4 w-4 shrink-0 text-zinc-500" />
        <input
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setLimit(PAGE);
          }}
          placeholder="Search captions, creators, tags"
          autoCapitalize="off"
          autoCorrect="off"
          className="min-h-10 min-w-0 flex-1 bg-transparent text-base text-zinc-100 outline-none placeholder:text-zinc-600"
        />
      </div>
      <div className="mb-3 flex gap-1.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {[...SHELVES, ...(due.length ? [{ id: "due" as const, label: `Needs a run · ${due.length}` }] : [])].map((s) => (
          <button
            key={s.id}
            type="button"
            aria-pressed={shelf === s.id}
            onClick={() => {
              setShelf(s.id);
              setLimit(PAGE);
            }}
            className={`min-h-8 shrink-0 rounded-md border px-2.5 text-[12px] ${
              shelf === s.id ? "border-violet-500/50 bg-violet-500/15 text-violet-200" : "border-zinc-800 text-zinc-500"
            }`}
          >
            {s.label}
          </button>
        ))}
      </div>

      {shown.length === 0 ? (
        <p className="py-8 text-center text-sm text-zinc-600">
          {posts.length ? "Nothing matches." : "Nothing saved yet. Share a reel into this app, or paste a link above."}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {shown.slice(0, limit).map((post) => (
            <li key={post.id}>
              <PostRow
                post={post}
                running={running.has(post.id)}
                onOpen={() => setOpenId(post.id)}
                onRun={() => void run([post])}
              />
            </li>
          ))}
        </ul>
      )}
      {shown.length > limit && (
        <button
          type="button"
          onClick={() => setLimit((n) => n + PAGE)}
          className="mt-3 min-h-11 w-full rounded-lg border border-zinc-800 text-sm text-zinc-300 active:bg-zinc-900"
        >
          Show more ({shown.length - limit})
        </button>
      )}
      {open && (
        <PostSheet post={open} running={running.has(open.id)} onRun={() => void run([open])} onClose={() => setOpenId(null)} />
      )}
    </div>
  );
}

function RunButton({ running, onRun, label = "Run again" }: { running: boolean; onRun: () => void; label?: string }) {
  return (
    <button
      type="button"
      disabled={running}
      onClick={onRun}
      className="flex min-h-9 shrink-0 items-center gap-1 rounded-lg border border-zinc-700 px-2.5 text-[12px] text-zinc-200 active:bg-zinc-800 disabled:opacity-50"
    >
      {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCw className="h-3.5 w-3.5" />}
      {label}
    </button>
  );
}

function PostRow({ post, running, onOpen, onRun }: { post: InstagramPost; running: boolean; onOpen: () => void; onRun: () => void }) {
  const thumb = post.slides[0] ? thumbUrl(post.id, 0) : "";
  const handle = post.creator?.username;
  const health = postHealth(post);
  return (
    <div className="flex items-center gap-2 rounded-xl border border-zinc-800 bg-zinc-900/50 p-2.5 pr-2">
    <button type="button" onClick={onOpen} className="flex min-w-0 flex-1 gap-3 text-left">
      {thumb ? (
        <img src={thumb} alt="" loading="lazy" className="h-14 w-14 shrink-0 rounded-lg object-cover" />
      ) : (
        <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-lg bg-zinc-800 text-zinc-600">
          <Instagram className="h-5 w-5" />
        </div>
      )}
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm text-zinc-100">
          {handle ? `@${handle}` : post.input}
          {post.kind ? <span className="ml-1.5 text-[11px] text-zinc-500">{kindLabel(post.kind)}</span> : null}
          {post.knowhow ? <span className="ml-1.5 text-[11px] text-amber-300/80">{KNOWHOW.label}</span> : null}
        </p>
        {post.idea?.title || post.caption ? (
          <p className="mt-0.5 line-clamp-2 text-[12px] leading-4 text-zinc-500">{post.idea?.title || post.caption}</p>
        ) : null}
        <p className={`mt-1 flex items-center gap-1 text-[11px] ${HEALTH_TEXT[health]}`}>
          <HealthIcon health={health} />
          <span className="min-w-0 truncate">{statusLine(post, health)}</span>
          {post.counts.plays && !needsRun(health) ? (
            <span className="ml-auto shrink-0 text-zinc-500">{fmtCount(post.counts.plays)} plays</span>
          ) : null}
        </p>
      </div>
    </button>
    {needsRun(health) && <RunButton running={running} onRun={onRun} label={health === "waiting" ? "Run" : "Retry"} />}
    </div>
  );
}

function PostSheet({ post, running, onRun, onClose }: { post: InstagramPost; running: boolean; onRun: () => void; onClose: () => void }) {
  const [index, setIndex] = useState(0);
  const health = postHealth(post);
  const { plays, likes, comments } = post.counts;
  const numbers = [
    plays ? `${fmtCount(plays)} plays` : "",
    likes ? `${fmtCount(likes)} likes` : "",
    comments ? `${fmtCount(comments)} comments` : "",
  ].filter(Boolean);
  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-zinc-950 px-4 pb-[max(2rem,env(safe-area-inset-bottom))] pt-[max(0.75rem,env(safe-area-inset-top))] text-zinc-200">
      <div className="mx-auto flex w-full max-w-md flex-col gap-3">
        <div className="flex items-center gap-2">
          <p className="min-w-0 flex-1 truncate font-medium">
            {post.creator?.username ? `@${post.creator.username}` : post.input}
            {post.kind ? <span className="ml-1.5 text-xs text-zinc-500">{kindLabel(post.kind)}</span> : null}
          </p>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="rounded-full p-2 text-zinc-400 active:bg-zinc-900"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        {needsRun(health) && (
          <div className={`flex items-center gap-2 rounded-xl border border-zinc-800 px-3 py-2 text-[12px] ${HEALTH_TEXT[health]}`}>
            <HealthIcon health={health} />
            <span className="min-w-0 flex-1">{statusLine(post, health)}</span>
            <RunButton running={running} onRun={onRun} />
          </div>
        )}
        <SlideViewer post={post} index={index} onIndex={setIndex} />
        <p className="text-xs text-zinc-500">
          {[post.takenAt ? new Date(post.takenAt).toLocaleDateString() : "", ...numbers].filter(Boolean).join(" · ")}
        </p>
        {post.idea && (
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-3">
            <p className="text-sm font-medium text-zinc-100">{post.idea.title}</p>
            <p className="mt-1 text-[13px] leading-5 text-zinc-400">{post.idea.takeaway}</p>
          </div>
        )}
        {post.caption && <p className="whitespace-pre-line text-[13px] leading-5 text-zinc-300">{post.caption}</p>}
        {post.url && (
          <a
            href={post.url}
            className="flex min-h-11 items-center justify-center gap-1.5 rounded-lg border border-zinc-800 text-sm text-zinc-300 active:bg-zinc-900"
          >
            <ExternalLink className="h-4 w-4" /> {openPostLabel(post)}
          </a>
        )}
      </div>
    </div>
  );
}
